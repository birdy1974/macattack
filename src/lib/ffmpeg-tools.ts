/**
 * ============================================================================
 * FFmpeg picture pack — freeze/black checks, thumbnails, FPS and bitrate
 * ============================================================================
 *
 * The published Docker image includes FFmpeg so picture checks work without
 * installing anything on the NAS/Pi. Local source runs still detect FFmpeg at
 * runtime. Detection tries FFMPEG_PATH first (when set) and then falls back to
 * `ffmpeg` on PATH plus the usual absolute locations, so a stale override
 * cannot mask a working binary. If a Linux Intel VAAPI device is passed into
 * the container, decode is attempted in hardware and transparently retried in
 * software if the device or codec cannot be used.
 *
 * Freeze/black filters and JPEG conversion remain CPU-side. Parsers are pure
 * functions and can be tested without an FFmpeg binary.
 * ============================================================================
 */

import { execFile, spawn } from "node:child_process";
import { Buffer } from "node:buffer";
import { existsSync } from "node:fs";
import { onAbort } from "@/lib/abort";

export interface FfmpegAvailability {
  available: boolean;
  path: string | null;
  version: string | null;
  reason: string | null;
  /** VAAPI candidate only; each decode can still fall back to software. */
  hardwareAcceleration: "vaapi" | null;
  hardwareDevice: string | null;
  checkedAt: string;
  /** Every binary location that was tried, in order (first = FFMPEG_PATH when set). */
  triedPaths: string[];
}

export interface DetectionAttemptFailure {
  binary: string;
  code?: string | number | null;
  message: string;
}

const availabilityCache = { value: null as FfmpegAvailability | null };

/**
 * Ordered FFmpeg locations to try. An explicit FFMPEG_PATH wins when it works,
 * but a stale/wrong override no longer masks a working FFmpeg on PATH: the
 * bundled Docker image ships `ffmpeg` on PATH, so detection falls through to
 * it (plus the usual absolute locations) before giving up.
 */
export function ffmpegCandidates(): string[] {
  const list: string[] = [];
  const configured = process.env.FFMPEG_PATH?.trim();
  if (configured) list.push(configured);
  for (const fallback of ["ffmpeg", "/usr/bin/ffmpeg", "/usr/local/bin/ffmpeg"]) {
    if (!list.includes(fallback)) list.push(fallback);
  }
  return list;
}

function ffmpegCandidate(): string {
  return ffmpegCandidates()[0];
}

function accessibleVaapiDevice(): Promise<string | null> {
  if (process.platform !== "linux") return Promise.resolve(null);
  const configured = process.env.MACATTACK_FFMPEG_DRI_DEVICE?.trim();
  const candidates = configured?.startsWith("/")
    ? [configured]
    : ["/dev/dri/renderD128", "/dev/dri/card0"];

  return new Promise((resolve) => {
    const checkNext = (index: number) => {
      const device = candidates[index];
      if (!device) {
        resolve(null);
        return;
      }
      // The shell's `test -r/-w` built-in uses the same credentials as FFmpeg
      // without inspecting or opening the DRI device node in the Next bundle.
      execFile(
        "/bin/sh",
        ["-c", '[ -r "$1" ] && [ -w "$1" ]', "sh", device],
        { timeout: 1000 },
        (error) => {
          if (error) checkNext(index + 1);
          else resolve(device);
        }
      );
    };
    checkNext(0);
  });
}

export function parseHardwareAccelerators(output: string): string[] {
  return [...new Set(
    output
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => /^[a-z0-9_]+$/i.test(line))
  )];
}

/** True when running inside a container (Docker/Podman/k8s). */
export function runningInContainer(): boolean {
  return (
    existsSync("/.dockerenv") ||
    existsSync("/run/.containerenv") ||
    Boolean(process.env.KUBERNETES_SERVICE_HOST)
  );
}

/** Explain *why* one FFmpeg binary could not be started, with an actionable fix. */
export function describeDetectionFailure(
  binary: string,
  error: { code?: string | number | null; message: string },
  inContainer: boolean = runningInContainer()
): string {
  const configured = process.env.FFMPEG_PATH?.trim();
  if (error.code === "ENOENT") {
    if (configured && binary === configured) {
      return `FFMPEG_PATH is set to "${binary}" but no such executable exists.`;
    }
    return inContainer
      ? "ffmpeg is not installed in this container. The current MacAttack image bundles it, so this container is running an older image: run ./update.sh (or `docker compose pull app && docker compose up -d`) to get the latest image."
      : "ffmpeg is not on PATH. Install it (e.g. `apt install ffmpeg` / `brew install ffmpeg`) or set FFMPEG_PATH to the binary.";
  }
  if (error.code === "EACCES") {
    return `"${binary}" exists but is not executable by this user (EACCES).`;
  }
  return `"${binary}" was found but failed to run: ${error.message}`;
}

/**
 * Explain why *all* FFmpeg candidates failed. Always names what was tried so a
 * wrong FFMPEG_PATH override is visible instead of a bare "not found".
 */
export function describeAllFailures(
  failures: DetectionAttemptFailure[],
  inContainer: boolean = runningInContainer()
): string {
  const tried = failures.map((failure) => `"${failure.binary}"`).join(", ") || '"ffmpeg"';
  const configured = process.env.FFMPEG_PATH?.trim();
  const overrideFailed = Boolean(configured) && failures[0]?.binary === configured;
  const permissionFailure = failures.find((failure) => failure.code === "EACCES");
  const otherFailure = failures.find(
    (failure) => failure.code !== "ENOENT" && failure.code !== "EACCES"
  );

  let headline: string;
  if (overrideFailed && failures.length > 1) {
    const rest = failures
      .slice(1)
      .map((failure) => `"${failure.binary}"`)
      .join(", ");
    headline =
      `FFMPEG_PATH is set to "${configured}" but no executable was found there; ` +
      `the PATH fallbacks (${rest}) did not respond either (tried ${tried}).`;
  } else if (overrideFailed) {
    headline = `FFMPEG_PATH is set to "${configured}" but no executable was found there (tried ${tried}).`;
  } else {
    headline = `ffmpeg was not found (tried ${tried}).`;
  }

  if (permissionFailure) {
    headline += ` "${permissionFailure.binary}" exists but is not executable by this user (EACCES).`;
  } else if (otherFailure) {
    headline += ` Last error: ${otherFailure.message}`;
  }

  if (inContainer) {
    headline +=
      " The current MacAttack image bundles FFmpeg, so this container is almost certainly running an older image: run ./update.sh " +
      "(or `docker compose pull app && docker compose up -d`) to get the latest image.";
    if (overrideFailed) {
      headline +=
        " Also check the FFMPEG_PATH override — remove it unless that exact path exists inside the container — then press Re-check.";
    }
  } else if (overrideFailed) {
    headline +=
      " Fix or remove the FFMPEG_PATH override (the Docker image needs none — ffmpeg is on PATH), or install ffmpeg, then press Re-check.";
  } else {
    headline +=
      " Install it (e.g. `apt install ffmpeg` / `brew install ffmpeg`) or set FFMPEG_PATH to the binary, then press Re-check.";
  }
  return headline;
}

function execFileAsync(
  binary: string,
  args: string[],
  timeout: number
): Promise<
  | { ok: true; stdout: string; stderr: string }
  | { ok: false; stdout: string; stderr: string; error: { code?: string | number | null; message: string } }
> {
  return new Promise((resolve) => {
    execFile(binary, args, { timeout }, (error, stdout, stderr) => {
      if (error) {
        resolve({
          ok: false,
          stdout: String(stdout ?? ""),
          stderr: String(stderr ?? ""),
          error: {
            code: (error as NodeJS.ErrnoException | null)?.code ?? null,
            message: error.message,
          },
        });
        return;
      }
      resolve({ ok: true, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
    });
  });
}

/**
 * Detect FFmpeg and a usable VAAPI candidate once per process.
 *
 * Every location from ffmpegCandidates() is tried in order: an explicit
 * FFMPEG_PATH first, then the PATH/absolute fallbacks. Pass `force=true` (via
 * `GET /api/system?refresh=1`) to re-run detection after installing FFmpeg or
 * fixing the override, without restarting the container.
 */
export async function detectFfmpeg(force = false): Promise<FfmpegAvailability> {
  if (availabilityCache.value && !force) return availabilityCache.value;

  const candidates = ffmpegCandidates();
  const failures: DetectionAttemptFailure[] = [];

  for (const binary of candidates) {
    const versionProbe = await execFileAsync(binary, ["-hide_banner", "-version"], 5000);
    if (!versionProbe.ok) {
      failures.push({ binary, code: versionProbe.error.code, message: versionProbe.error.message });
      continue;
    }

    const version = /ffmpeg version (\S+)/.exec(versionProbe.stdout)?.[1] ?? null;
    const hwProbe = await execFileAsync(binary, ["-hide_banner", "-hwaccels"], 5000);
    const accelerators = parseHardwareAccelerators(
      `${hwProbe.stdout}\n${hwProbe.stderr}`
    );
    const mode = (process.env.MACATTACK_FFMPEG_HWACCEL || "auto").trim().toLowerCase();
    const wantsVaapi = mode === "auto" || mode === "vaapi";
    const hardwareDevice =
      wantsVaapi && accelerators.includes("vaapi") ? await accessibleVaapiDevice() : null;
    const result: FfmpegAvailability = {
      available: true,
      path: binary,
      version,
      reason: null,
      hardwareAcceleration: hardwareDevice ? "vaapi" : null,
      hardwareDevice,
      checkedAt: new Date().toISOString(),
      triedPaths: candidates,
    };
    availabilityCache.value = result;
    return result;
  }

  const result: FfmpegAvailability = {
    available: false,
    path: null,
    version: null,
    reason: describeAllFailures(failures),
    hardwareAcceleration: null,
    hardwareDevice: null,
    checkedAt: new Date().toISOString(),
    triedPaths: candidates,
  };
  availabilityCache.value = result;
  return result;
}

/** Reset the cached detection result (used by tests and by "re-detect" UI actions). */
export function resetFfmpegDetection(): void {
  availabilityCache.value = null;
}

// ============================================================================
// PARSERS (pure)
// ============================================================================

export interface FreezeInterval {
  startSec: number;
  endSec: number | null;
  durationSec: number | null;
}

export interface BlackInterval {
  startSec: number;
  endSec: number | null;
  durationSec: number | null;
}

/** Parse `lavfi.freezedetect.freeze_start/…_end/…_duration` values from stderr. */
export function parseFreezeIntervals(stderr: string): FreezeInterval[] {
  const intervals: FreezeInterval[] = [];
  const startRe = /freeze_start:\s*([\d.]+)/g;
  const endRe = /freeze_end:\s*([\d.]+)/g;
  const durationRe = /freeze_duration:\s*([\d.]+)/g;

  const starts = [...stderr.matchAll(startRe)].map((match) => Number(match[1]));
  const ends = [...stderr.matchAll(endRe)].map((match) => Number(match[1]));
  const durations = [...stderr.matchAll(durationRe)].map((match) => Number(match[1]));

  for (let index = 0; index < starts.length; index += 1) {
    const startSec = starts[index];
    const endSec = ends[index] ?? null;
    const durationSec = durations[index] ?? (endSec !== null ? Math.max(0, endSec - startSec) : null);
    intervals.push({ startSec, endSec, durationSec });
  }
  return intervals;
}

/** Parse `black_start/black_end/black_duration` values from stderr. */
export function parseBlackIntervals(stderr: string): BlackInterval[] {
  const intervals: BlackInterval[] = [];
  const lineRe = /black_start:\s*([\d.]+)\s+black_end:\s*([\d.]+)\s+black_duration:\s*([\d.]+)/g;
  for (const match of stderr.matchAll(lineRe)) {
    intervals.push({ startSec: Number(match[1]), endSec: Number(match[2]), durationSec: Number(match[3]) });
  }
  return intervals;
}

export interface FfmpegProgress {
  frames: number | null;
  fps: number | null;
  durationSec: number | null;
  videoKb: number | null;
  audioKb: number | null;
}

/** Parse the last progress and the final stats line of an ffmpeg run. */
export function parseFfmpegStats(stderr: string): FfmpegProgress {
  const frameMatches = [...stderr.matchAll(/frame=\s*(\d+)/g)].map((match) => Number(match[1]));
  const fpsMatches = [...stderr.matchAll(/fps=\s*([\d.]+)/g)].map((match) => Number(match[1]));
  const timeMatches = [...stderr.matchAll(/time=(\d+):(\d+):([\d.]+)/g)].map((match) =>
    Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3])
  );
  const videoKb = [...stderr.matchAll(/video:\s*(\d+)\s*kB/g)].map((match) => Number(match[1])).pop() ?? null;
  const audioKb = [...stderr.matchAll(/audio:\s*(\d+)\s*kB/g)].map((match) => Number(match[1])).pop() ?? null;

  return {
    frames: frameMatches.length > 0 ? frameMatches[frameMatches.length - 1] : null,
    fps: fpsMatches.length > 0 ? fpsMatches[fpsMatches.length - 1] : null,
    durationSec: timeMatches.length > 0 ? timeMatches[timeMatches.length - 1] : null,
    videoKb,
    audioKb,
  };
}

// ============================================================================
// PICTURE ANALYSIS
// ============================================================================

export interface PictureAnalysis {
  analyzed: boolean;
  durationSec: number | null;
  frames: number | null;
  fps: number | null;
  frozenIntervals: FreezeInterval[];
  frozenDurationSec: number;
  frozenDetected: boolean;
  blackIntervals: BlackInterval[];
  blackDurationSec: number;
  blackDetected: boolean;
  /** Average video bitrate decoded over the sample, in Mbps. */
  videoBitrateMbps: number | null;
  error: string | null;
  /** ffmpeg invocation with the URL removed (safe to store/log). */
  tool: string;
}

const FREEZE_NOISE = process.env.MACATTACK_FREEZE_NOISE || "-60dB";
const FREEZE_MIN_SEC = Number(process.env.MACATTACK_FREEZE_MIN_SEC || 4);
const BLACK_MIN_SEC = Number(process.env.MACATTACK_BLACK_MIN_SEC || 3);

export interface PictureAnalysisOptions {
  seconds?: number;
  timeoutMs?: number;
  userAgent?: string;
  /** Extra ffmpeg input flags (e.g. proxy). */
  inputArgs?: string[];
  signal?: AbortSignal;
  ffmpegPath?: string;
}

/**
 * Run one short ffmpeg pass over a live stream and report picture-level
 * evidence. Returns `analyzed: false` (never throws) when ffmpeg is missing,
 * times out or cannot open the stream.
 */
export async function analyzePicture(
  url: string,
  options: PictureAnalysisOptions = {}
): Promise<PictureAnalysis> {
  const seconds = Math.max(3, Math.min(options.seconds ?? 10, 60));
  const timeoutMs = options.timeoutMs ?? (seconds + 20) * 1000;
  const userAgent = options.userAgent || "MacAttack";
  const filters = [
    `freezedetect=n=${FREEZE_NOISE}:d=${Math.max(2, FREEZE_MIN_SEC)}`,
    `blackdetect=d=${Math.max(1.5, BLACK_MIN_SEC)}:pic_th=0.97`,
  ].join(",");
  const availability = options.ffmpegPath ? null : await detectFfmpeg();
  if (!options.ffmpegPath && !availability?.available) {
    return emptyPictureAnalysis(url, options, "ffmpeg unavailable");
  }

  const ffmpeg = options.ffmpegPath || availability?.path || ffmpegCandidate();
  const hardwareArgs = vaapiInputArgs(availability);
  const argsFor = (accelerationArgs: string[]) => [
    "-hide_banner",
    "-nostdin",
    "-loglevel",
    "info",
    "-user_agent",
    userAgent,
    ...accelerationArgs,
    ...(options.inputArgs ?? []),
    "-i",
    url,
    "-t",
    String(seconds),
    "-an",
    "-vf",
    filters,
    "-f",
    "null",
    "-",
  ];
  const softwareArgs = argsFor([]);
  const execution = await runFfmpegWithSoftwareFallback(
    ffmpeg,
    argsFor,
    hardwareArgs,
    timeoutMs,
    options.signal,
    (result) => {
      const frames = parseFfmpegStats(result.stderr).frames ?? 0;
      return !result.error && result.exitCode === 0 && frames > 0;
    }
  );
  const { stderr, error } = execution.result;

  if (error && !/Conversion failed|Invalid data|Server returned/i.test(stderr)) {
    // A stream that never opened is not an analysis result, it is a probe failure.
    if (/No such file|not found|ENOENT/i.test(error)) {
      return emptyPictureAnalysis(url, options, "ffmpeg unavailable");
    }
  }

  const stats = parseFfmpegStats(stderr);
  const freeze = parseFreezeIntervals(stderr);
  const black = parseBlackIntervals(stderr);
  const analyzedDuration = stats.durationSec ?? null;
  const frozenDurationSec = freeze.reduce((sum, interval) => {
    if (interval.durationSec !== null) return sum + interval.durationSec;
    if (interval.endSec === null && analyzedDuration !== null) return sum + Math.max(0, analyzedDuration - interval.startSec);
    return sum;
  }, 0);
  const blackDurationSec = black.reduce((sum, interval) => sum + (interval.durationSec ?? 0), 0);

  const videoBitrateMbps =
    stats.videoKb !== null && analyzedDuration && analyzedDuration > 0
      ? Math.round(((stats.videoKb * 8) / analyzedDuration / 1000) * 100) / 100
      : null;

  const analyzed = stats.frames !== null && stats.frames > 0;
  const executionMode = execution.hardwareUsed
    ? "VAAPI decode"
    : execution.softwareFallback
      ? "software fallback"
      : "software decode";
  return {
    analyzed,
    durationSec: analyzedDuration,
    frames: stats.frames,
    fps: stats.fps,
    frozenIntervals: freeze,
    frozenDurationSec: Math.round(frozenDurationSec * 10) / 10,
    // A short freeze at start-up is normal for live TV; require a sustained one.
    frozenDetected: analyzed && frozenDurationSec >= Math.max(2, Math.min(analyzedDuration ?? 0, seconds) * 0.5),
    blackIntervals: black,
    blackDurationSec: Math.round(blackDurationSec * 10) / 10,
    blackDetected: analyzed && blackDurationSec >= Math.max(1.5, seconds * 0.5),
    videoBitrateMbps,
    error: analyzed ? null : error || "ffmpeg did not decode any frames",
    tool: `ffmpeg (${executionMode}) ${softwareArgs.filter((arg) => arg !== url).join(" ")}`,
  };
}

function emptyPictureAnalysis(
  url: string,
  options: PictureAnalysisOptions,
  error: string
): PictureAnalysis {
  const seconds = Math.max(3, Math.min(options.seconds ?? 10, 60));
  const filters = [
    `freezedetect=n=${FREEZE_NOISE}:d=${Math.max(2, FREEZE_MIN_SEC)}`,
    `blackdetect=d=${Math.max(1.5, BLACK_MIN_SEC)}:pic_th=0.97`,
  ].join(",");
  const args = [
    "-hide_banner",
    "-nostdin",
    "-loglevel",
    "info",
    "-user_agent",
    options.userAgent || "MacAttack",
    ...(options.inputArgs ?? []),
    "-i",
    url,
    "-t",
    String(seconds),
    "-an",
    "-vf",
    filters,
    "-f",
    "null",
    "-",
  ];
  return {
    analyzed: false,
    durationSec: null,
    frames: null,
    fps: null,
    frozenIntervals: [],
    frozenDurationSec: 0,
    frozenDetected: false,
    blackIntervals: [],
    blackDurationSec: 0,
    blackDetected: false,
    videoBitrateMbps: null,
    error,
    tool: `ffmpeg ${args.filter((arg) => arg !== url).join(" ")}`,
  };
}

// ============================================================================
// THUMBNAIL CAPTURE
// ============================================================================

export interface ThumbnailResult {
  ok: boolean;
  jpeg: Buffer | null;
  error: string | null;
}

/** Grab a single frame as JPEG (default: the first decodable frame). */
export async function captureThumbnail(
  url: string,
  options: PictureAnalysisOptions & { seekSeconds?: number } = {}
): Promise<ThumbnailResult> {
  const availability = options.ffmpegPath ? null : await detectFfmpeg();
  if (!options.ffmpegPath && !availability?.available) {
    return { ok: false, jpeg: null, error: "ffmpeg unavailable" };
  }

  const ffmpeg = options.ffmpegPath || availability?.path || ffmpegCandidate();
  const hardwareArgs = vaapiInputArgs(availability);
  const argsFor = (accelerationArgs: string[]) => [
    "-hide_banner",
    "-nostdin",
    "-loglevel",
    "error",
    "-user_agent",
    options.userAgent || "MacAttack",
    ...accelerationArgs,
    ...(options.inputArgs ?? []),
    "-i",
    url,
    ...(options.seekSeconds ? ["-ss", String(options.seekSeconds)] : []),
    "-frames:v",
    "1",
    "-q:v",
    "5",
    "-f",
    "image2",
    "-",
  ];
  const execution = await runFfmpegWithSoftwareFallback(
    ffmpeg,
    argsFor,
    hardwareArgs,
    options.timeoutMs ?? 20000,
    options.signal,
    (result) => !result.error && result.exitCode === 0 && isJpeg(result.stdout)
  );
  const { stdout, error } = execution.result;

  if (stdout.length === 0) return { ok: false, jpeg: null, error: error || "No frame captured" };
  // Guard against a text error page being "captured".
  if (!isJpeg(stdout)) return { ok: false, jpeg: null, error: "ffmpeg output was not a JPEG frame" };
  return { ok: true, jpeg: stdout, error: null };
}

function isJpeg(buffer: Buffer): boolean {
  return buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xd8;
}

// ============================================================================
// PROCESS RUNNERS
// ============================================================================

interface RunResult {
  stdout: Buffer;
  stderr: string;
  error: string | null;
  exitCode: number | null;
}

interface FfmpegExecution {
  result: RunResult;
  hardwareUsed: boolean;
  softwareFallback: boolean;
}

function vaapiInputArgs(availability: FfmpegAvailability | null): string[] {
  if (availability?.hardwareAcceleration !== "vaapi" || !availability.hardwareDevice) return [];
  return ["-hwaccel", "vaapi", "-hwaccel_device", availability.hardwareDevice];
}

function isStreamInputFailure(result: RunResult): boolean {
  return /HTTP error \d{3}|server returned|connection refused|network is unreachable|name or service not known|temporary failure in name resolution|invalid data found when processing input/i.test(
    `${result.stderr}\n${result.error || ""}`
  );
}

async function runFfmpegWithSoftwareFallback(
  binary: string,
  argsFor: (accelerationArgs: string[]) => string[],
  hardwareArgs: string[],
  timeoutMs: number,
  signal: AbortSignal | undefined,
  isSuccess: (result: RunResult) => boolean
): Promise<FfmpegExecution> {
  const first = await runFfmpegResult(
    binary,
    argsFor(hardwareArgs),
    timeoutMs,
    signal
  );
  const hardwareSucceeded = hardwareArgs.length > 0 && isSuccess(first);
  if (
    hardwareArgs.length === 0 ||
    hardwareSucceeded ||
    signal?.aborted ||
    isStreamInputFailure(first)
  ) {
    return { result: first, hardwareUsed: hardwareSucceeded, softwareFallback: false };
  }

  const fallback = await runFfmpegResult(binary, argsFor([]), timeoutMs, signal);
  return { result: fallback, hardwareUsed: false, softwareFallback: true };
}

function runFfmpegResult(
  binary: string,
  args: string[],
  timeoutMs: number,
  signal?: AbortSignal
): Promise<RunResult> {
  return new Promise((resolve) => {
    let stderr = "";
    const stdoutChunks: Buffer[] = [];
    let settled = false;

    const child = spawn(binary, args, { windowsHide: true });
    let detachAbort: (() => void) | null = null;
    const finish = (error: string | null, exitCode: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // Detach from the scan-wide signal: ffmpeg runs many times per scan and
      // a leftover listener per run trips Node's EventTarget leak warning.
      detachAbort?.();
      resolve({ stdout: Buffer.concat(stdoutChunks), stderr, error, exitCode });
    };

    const timer = setTimeout(() => {
      stderr += "\n[macattack] ffmpeg timed out";
      child.kill("SIGKILL");
      finish("ffmpeg timed out", null);
    }, timeoutMs);

    detachAbort = onAbort(signal, () => {
      child.kill("SIGKILL");
      finish("aborted", null);
    });

    child.stdout?.on("data", (chunk: Buffer) => {
      stdoutChunks.push(chunk);
      // Cap memory: a thumbnail is small, and analysis writes to stdout only
      // when the caller piped null output.
      if (stdoutChunks.reduce((sum, part) => sum + part.length, 0) > 16 * 1024 * 1024) {
        child.kill("SIGKILL");
      }
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
      if (stderr.length > 512 * 1024) stderr = stderr.slice(-256 * 1024);
    });
    child.on("error", (error: Error) => finish(error.message, null));
    child.on("close", (code) => finish(null, code));
  });
}
