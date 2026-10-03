/**
 * ============================================================================
 * Optional ffmpeg pack — picture checks, thumbnails, fps and VBR measurement
 * ============================================================================
 *
 * Delivery metrics (our HTTP/HLS/MPEG-TS probe) cannot see everything: a
 * stream showing a **still image with audio** keeps a normal bitrate, clean
 * transport-stream continuity and no failed segments. Catching that needs a
 * decoder, which means ffmpeg — but MacAttack ships as one image for a
 * Synology DS918+ and a Raspberry Pi 4, so ffmpeg is:
 *
 *   • NEVER bundled — detected at runtime (PATH, or FFMPEG_PATH /
 *     FFPROBE_PATH env overrides);
 *   • NEVER required — every function returns `available: false` and the
 *     caller simply skips picture checks and says so in the report.
 *
 * When ffmpeg is present we run one short pass per probed channel:
 *   ffmpeg -i URL -t <n> -an -vf freezedetect,blackdetect -f null -
 * which gives frozen/black frame evidence, real fps, decoded frame count and
 * the average video bitrate from the final stats line — plus one JPEG frame
 * for the UI thumbnail gallery.
 *
 * The parsers are pure functions so they can be tested against captured
 * ffmpeg output without ffmpeg installed (see scripts/ffmpeg-tools-tests.ts).
 * ============================================================================
 */

import { execFile, spawn } from "node:child_process";
import { Buffer } from "node:buffer";

export interface FfmpegAvailability {
  available: boolean;
  path: string | null;
  version: string | null;
  reason: string | null;
  checkedAt: string;
}

const availabilityCache = { value: null as FfmpegAvailability | null };

function ffmpegCandidate(): string {
  return process.env.FFMPEG_PATH || "ffmpeg";
}

/** Detect ffmpeg once per process (a missing binary costs one failed spawn). */
export async function detectFfmpeg(force = false): Promise<FfmpegAvailability> {
  if (availabilityCache.value && !force) return availabilityCache.value;

  const result = await new Promise<FfmpegAvailability>((resolve) => {
    execFile(ffmpegCandidate(), ["-hide_banner", "-version"], { timeout: 5000 }, (error, stdout) => {
      if (error) {
        resolve({
          available: false,
          path: null,
          version: null,
          reason:
            process.env.FFMPEG_PATH
              ? `FFMPEG_PATH is set but not runnable: ${error.message}`
              : "ffmpeg is not installed (optional: enables freeze/black detection, thumbnails, fps and bitrate checks)",
          checkedAt: new Date().toISOString(),
        });
        return;
      }
      const version = /ffmpeg version (\S+)/.exec(stdout)?.[1] ?? null;
      resolve({
        available: true,
        path: ffmpegCandidate(),
        version,
        reason: null,
        checkedAt: new Date().toISOString(),
      });
    });
  });

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

  const args = [
    "-hide_banner",
    "-nostdin",
    "-loglevel",
    "info",
    "-user_agent",
    userAgent,
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

  const ffmpeg = options.ffmpegPath || process.env.FFMPEG_PATH || "ffmpeg";
  const empty: PictureAnalysis = {
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
    error: null,
    tool: `ffmpeg ${args.filter((arg) => arg !== url).join(" ")}`,
  };

  const availability = options.ffmpegPath ? null : await detectFfmpeg();
  if (availability && !availability.available) {
    return { ...empty, error: "ffmpeg unavailable" };
  }

  const { stderr, error } = await runFfmpeg(ffmpeg, args, timeoutMs, options.signal);
  if (error && !/Conversion failed|Invalid data|Server returned/i.test(stderr)) {
    // A stream that never opened is not an analysis result, it is a probe failure.
    if (/No such file|not found|ENOENT/i.test(error)) return { ...empty, error: "ffmpeg unavailable" };
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
    tool: empty.tool,
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
  const args = [
    "-hide_banner",
    "-nostdin",
    "-loglevel",
    "error",
    "-user_agent",
    options.userAgent || "MacAttack",
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

  const availability = await detectFfmpeg();
  if (!availability.available) return { ok: false, jpeg: null, error: "ffmpeg unavailable" };

  const { stdout, error } = await runFfmpegResult(
    process.env.FFMPEG_PATH || "ffmpeg",
    args,
    options.timeoutMs ?? 20000,
    options.signal
  );

  if (stdout.length === 0) return { ok: false, jpeg: null, error: error || "No frame captured" };
  // Guard against a text error page being "captured".
  const isJpeg = stdout[0] === 0xff && stdout[1] === 0xd8;
  if (!isJpeg) return { ok: false, jpeg: null, error: "ffmpeg output was not a JPEG frame" };
  return { ok: true, jpeg: stdout, error: null };
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
    const finish = (error: string | null, exitCode: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ stdout: Buffer.concat(stdoutChunks), stderr, error, exitCode });
    };

    const timer = setTimeout(() => {
      stderr += "\n[macattack] ffmpeg timed out";
      child.kill("SIGKILL");
      finish("ffmpeg timed out", null);
    }, timeoutMs);

    if (signal) {
      signal.addEventListener(
        "abort",
        () => {
          child.kill("SIGKILL");
          finish("aborted", null);
        },
        { once: true }
      );
    }

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

async function runFfmpeg(
  binary: string,
  args: string[],
  timeoutMs: number,
  signal?: AbortSignal
): Promise<{ stderr: string; error: string | null; exitCode: number | null }> {
  const result = await runFfmpegResult(binary, args, timeoutMs, signal);
  return { stderr: result.stderr, error: result.error, exitCode: result.exitCode };
}
