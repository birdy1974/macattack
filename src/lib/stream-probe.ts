/**
 * ============================================================================
 * Stream Probe — real media-path measurement for a validated MAC address
 * ============================================================================
 *
 * WHY THIS EXISTS
 * ---------------
 * The original portal diagnostics only measured the Stalker *control* path
 * (TCP connect to the portal host + one HTTP request to the handshake
 * endpoint). They explicitly could not say anything about the streams the
 * account can actually watch.
 *
 * Once a MAC is validated (account_info returns real subscription data), we
 * can ask the portal for a playable URL (`create_link`) and then measure that
 * URL directly. This module performs the measurement with Node's built-in
 * `http`/`https` only — no ffmpeg, no native dependencies — so it runs
 * unchanged in the amd64 (Synology) and arm64 (Raspberry Pi) Docker image.
 *
 * WHAT IS MEASURED
 * ----------------
 *  • Control/timing waterfall: DNS → TCP → TLS → TTFB → first byte.
 *  • Container detection: HLS (master/media), MPEG-DASH, raw MPEG-TS, MP4.
 *  • HLS: variant ladder (RESOLUTION/BANDWIDTH/CODECS), the variant the
 *    player would pick, segment download times vs segment durations (i.e.
 *    whether the connection can keep up with real time), continuity tags and
 *    DRM/encryption markers.
 *  • MPEG-TS: PIDs, codec map (H.264/HEVC/MPEG-2/AAC/AC-3…), measured
 *    bitrate, continuity-counter errors and scrambled packets — the same
 *    "discontinuities in the transport stream" evidence broadcast probes use.
 *  • Throughput in both directions: sustained Mbps over the sample window,
 *    per-sample variation (coefficient of variation) and the worst stall.
 *
 * WHAT IS NOT MEASURED (deliberately, and stated in the report)
 * ------------------------------------------------------------
 *  • No video decoding, so no picture checks (freeze/black/blockiness).
 *  • No player, so no buffer health or rebuffer-ratio numbers.
 *  • One vantage point: the scanner host's network, not the viewer's device.
 *
 * INSPIRED BY (see docs/iptv-tool-landscape.md)
 * ---------------------------------------------
 *  • kristofferR/IPTVChecker — byte-threshold liveness (500 KB direct /
 *    128 KB HLS), highest-variant selection, DRM detection, geoblock status
 *    classification, median latency scoring and documented score weighting.
 *  • Flux-Stream — multi-portal MAC checks and Stalker→M3U conversion.
 * ============================================================================
 */

import http from "node:http";
import https from "node:https";
import net from "node:net";
import dns from "node:dns";
import { performance } from "node:perf_hooks";
import { openProxyTunnel, tlsOverTunnel, type ProxyConfig } from "@/lib/proxy";
import { onAbort } from "@/lib/abort";
import { sleep } from "@/lib/parallel";

// ============================================================================
// PUBLIC TYPES
// ============================================================================

export type ProbeContainer = "hls" | "dash" | "mpegts" | "mp4" | "rtsp" | "rtmp" | "udp" | "other" | "unknown";

export type ProbeStatus =
  | "measured"
  | "unplayable"
  | "http_error"
  | "timeout"
  | "network_error"
  /** RTSP/RTMP: TCP reachable and protocol handshake answered, but the media
   *  itself cannot be measured without a full RTSP/RTMP client. Honest label. */
  | "reachable_only"
  /** UDP streams cannot be liveness-checked at all from here. */
  | "unverifiable"
  | "unsupported_scheme";

export interface ProbeTimings {
  /** DNS resolution (0 when the OS/Node cache answered instantly). */
  dnsMs: number | null;
  /** TCP connect completion. */
  tcpMs: number | null;
  /** TLS handshake completion (null for plain HTTP). */
  tlsMs: number | null;
  /** Time to first byte of the HTTP response (headers). */
  ttfbMs: number | null;
  /** Time until the first media byte arrived (headers present, body flowing). */
  firstByteMs: number | null;
}

export interface ThroughputSample {
  atMs: number;
  bytes: number;
  /** Instantaneous Mbps for this sample bucket. */
  mbps: number;
}

export interface HlsVariant {
  url: string;
  bandwidthBps: number | null;
  averageBandwidthBps: number | null;
  width: number | null;
  height: number | null;
  codecs: string | null;
}

export interface HlsSegmentSample {
  url: string;
  durationSec: number | null;
  bytes: number;
  transferMs: number;
  ttfbMs: number | null;
  mbps: number;
  /** transferMs / durationMs — >= 1 means this segment took longer than real time. */
  realtimeRatio: number | null;
  ok: boolean;
  error: string | null;
}

export interface HlsAnalysis {
  isMaster: boolean;
  variantLadder: HlsVariant[];
  selectedVariantUrl: string | null;
  selectedRequiredMbps: number | null;
  selectedRequiredSource: "average-bandwidth" | "bandwidth" | "segment-mean" | null;
  targetDurationSec: number | null;
  mediaSequence: number | null;
  endsWithEndlist: boolean;
  discontinuityCount: number;
  drm: string | null;
  segmentsPlanned: number;
  segments: HlsSegmentSample[];
  segmentsOk: number;
  segmentsFailed: number;
  /** Cumulative deficit where a segment took longer than its own duration. */
  realtimeDeficitMs: number;
  worstRealtimeRatio: number | null;
}

export interface TsPidInfo {
  pid: number;
  packets: number;
  bytes: number;
  kind: "pat" | "pmt" | "video" | "audio" | "data" | "other";
  codec: string | null;
}

export interface TsAnalysis {
  packets: number;
  bytes: number;
  syncLosses: number;
  /** Continuity-counter discontinuities (packet loss / re-mux) per PID. */
  continuityErrors: number;
  scrambledPackets: number;
  pids: TsPidInfo[];
  videoCodecs: string[];
  audioCodecs: string[];
  /** Measured bitrate of the whole transport stream. */
  bitrateMbps: number;
  /** Measured bitrate of the video PID(s) only. */
  videoBitrateMbps: number | null;
  /** Continuity errors per 1000 packets — 0 is clean. */
  continuityErrorsPer1000: number;
}

export interface StreamProbeResult {
  url: string;
  finalUrl: string;
  redirectChain: string[];
  status: ProbeStatus;
  httpStatus: number | null;
  contentType: string | null;
  container: ProbeContainer;
  /** What a player would need to sustain, in Mbps, when it can be derived. */
  requiredMbps: number | null;
  requiredMbpsSource: "average-bandwidth" | "bandwidth" | "segment-mean" | null;
  /** Measured delivered throughput over the sample window. */
  sustainedMbps: number | null;
  peakMbps: number | null;
  /** Lowest sample bucket — exposes throttling/dips. */
  minSampleMbps: number | null;
  throughputCoefficientOfVariation: number | null;
  throughputSamples: ThroughputSample[];
  /** Longest gap between two consecutive data events (stall proxy). */
  maxGapMs: number | null;
  sampleWindowMs: number;
  bytesRead: number;
  timings: ProbeTimings;
  hls: HlsAnalysis | null;
  ts: TsAnalysis | null;
  resolution: { width: number | null; height: number | null; label: string } | null;
  videoCodec: string | null;
  audioCodec: string | null;
  drm: string | null;
  /** Retries performed because of transient HTTP statuses (408/425/429/5xx). */
  retryCount: number;
  /** Transport actually probed: http/hls or rtsp/rtmp/udp. */
  protocol: "http" | "rtsp" | "rtmp" | "udp";
  /** Configured proxy (host:port only) when the probe egressed through one. */
  viaProxy: string | null;
  errors: string[];
  warnings: string[];
  notes: string[];
  measuredAt: string;
}

export interface StreamProbeOptions {
  /** How long to watch the media path. Default 8000 ms, clamped 2000–30000. */
  sampleMs?: number;
  /** Per-request inactivity/connect timeout. Default 8000 ms. */
  timeoutMs?: number;
  /** Hard byte cap per stream probe (safety on metered/VPS links). Default 96 MB. */
  maxBytes?: number;
  /** Extra request headers (some portals require the STB User-Agent). */
  headers?: Record<string, string>;
  /** Abort the probe (e.g. user stopped the scan). */
  signal?: AbortSignal;
  /** Maximum HLS variants to walk down before sampling. Default 3. */
  maxPlaylistDepth?: number;
  /** HTTP CONNECT proxy to egress through (second vantage point / geoblock checks). */
  proxy?: ProxyConfig | null;
  /** Retries for transient HTTP statuses. Default 2, clamped 0–4. */
  maxRetries?: number;
}

// ============================================================================
// DEFAULTS / CONSTANTS
// ============================================================================

export const STB_USER_AGENT =
  process.env.MACATTACK_STB_USER_AGENT ||
  "Mozilla/5.0 (QtEmbedded; U; Linux; C) AppleWebKit/533.3 (KHTML, like Gecko) MAG200 stbapp ver: 2 rev: 250 Safari/533.3";

const DEFAULT_SAMPLE_MS = 8000;
const DEFAULT_TIMEOUT_MS = 8000;
const DEFAULT_MAX_BYTES = 96 * 1024 * 1024;
const MAX_REDIRECTS = 6;
const SNIFF_BYTES = 2048;
/** Bytes of media the probe wants before it trusts a "live" verdict (IPTVChecker uses 500 KB / 128 KB for HLS). */
const MIN_MEDIA_BYTES_DIRECT = 512 * 1024;
const MIN_MEDIA_BYTES_HLS = 128 * 1024;
const SAMPLE_BUCKET_MS = 250;

const RETRYABLE_HTTP_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);
const GEOBLOCK_HTTP_STATUSES = new Set([403, 451, 426, 423]);

// ============================================================================
// SMALL HELPERS
// ============================================================================

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function round(value: number, digits = 2): number {
  const factor = Math.pow(10, digits);
  return Math.round(value * factor) / factor;
}

function safeNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function nowMs(): number {
  return performance.now();
}

function headerValue(
  headers: http.IncomingHttpHeaders,
  name: string
): string | null {
  const raw = headers[name.toLowerCase()];
  if (Array.isArray(raw)) return raw[0] ?? null;
  return raw ?? null;
}

function contentTypeOf(headers: http.IncomingHttpHeaders): string {
  return (headerValue(headers, "content-type") || "").toLowerCase();
}


// ============================================================================
// NON-HTTP STREAM LIVENESS (RTSP / RTMP / UDP)
// ============================================================================

/**
 * Classify a stream URL by transport. RTSP/RTMP get a bounded TCP reachability
 * check (plus an RTSP OPTIONS handshake); UDP is honestly unverifiable from a
 * scanner because every UDP "connection" succeeds.
 */
export function detectStreamProtocol(url: string): "http" | "rtsp" | "rtmp" | "udp" | "unknown" {
  const scheme = /^([a-z0-9+.-]+):/i.exec(url.trim())?.[1]?.toLowerCase();
  switch (scheme) {
    case "http":
    case "https":
      return "http";
    case "rtsp":
    case "rtsps":
      return "rtsp";
    case "rtmp":
    case "rtmps":
    case "rtmpt":
    case "rtmpe":
      return "rtmp";
    case "udp":
    case "rtp":
      return "udp";
    default:
      return "unknown";
  }
}

/** TCP connect (+ RTSP OPTIONS for rtsp) with a hard timeout. */
async function probeSocketLiveness(
  url: string,
  protocol: "rtsp" | "rtmp",
  timeoutMs: number,
  options: StreamProbeOptions
): Promise<StreamProbeResult> {
  const measuredAt = new Date().toISOString();
  const startedAt = nowMs();
  const container: ProbeContainer = protocol;

  const emptyBase = (status: ProbeStatus, errorLines: string[], warningLines: string[], noteLines: string[]): StreamProbeResult => ({
    url,
    finalUrl: url,
    redirectChain: [],
    status,
    httpStatus: null,
    contentType: null,
    container,
    requiredMbps: null,
    requiredMbpsSource: null,
    sustainedMbps: null,
    peakMbps: null,
    minSampleMbps: null,
    throughputCoefficientOfVariation: null,
    throughputSamples: [],
    maxGapMs: null,
    sampleWindowMs: 0,
    bytesRead: 0,
    timings: { dnsMs: null, tcpMs: null, tlsMs: null, ttfbMs: null, firstByteMs: null },
    hls: null,
    ts: null,
    resolution: null,
    videoCodec: null,
    audioCodec: null,
    drm: null,
    retryCount: 0,
    protocol,
    viaProxy: options.proxy ? `${options.proxy.host}:${options.proxy.port}` : null,
    errors: errorLines,
    warnings: warningLines,
    notes: noteLines,
    measuredAt,
  });

  let target: URL;
  try {
    target = new URL(url);
  } catch {
    return emptyBase("unsupported_scheme", [`Not a valid ${protocol.toUpperCase()} URL`], [], []);
  }
  const port = Number(target.port) || (protocol === "rtsp" ? 554 : 1935);
  const host = target.hostname;

  const outcome = await new Promise<{ ok: boolean; tcpMs: number | null; banner: string | null; error: string | null }>(
    (resolve) => {
      const socket = net.connect({ host, port });
      let settled = false;
      let banner = "";
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        socket.destroy();
        resolve({ ok: false, tcpMs: null, banner: null, error: `TCP connect timed out after ${timeoutMs} ms` });
      }, timeoutMs);

      socket.on("connect", () => {
        const tcpMs = Math.round(nowMs() - startedAt);
        if (protocol === "rtsp") {
          // Bounded handshake: ask the server for its options and watch for a
          // response line. No media is requested, so nothing is decoded.
          const request =
            `OPTIONS ${target.href} RTSP/1.0\r\n` +
            `CSeq: 1\r\n` +
            `User-Agent: MacAttack\r\n\r\n`;
          socket.write(request);
          socket.on("data", (chunk) => {
            banner += chunk.toString("latin1").slice(0, 512);
            if (!settled) {
              settled = true;
              clearTimeout(timer);
              const answered = /^RTSP\/\d\.\d\s+\d{3}/i.test(banner.trim());
              socket.destroy();
              resolve({
                ok: answered,
                tcpMs,
                banner: banner.split("\r\n")[0] || null,
                error: answered ? null : "Connected, but the server did not answer RTSP OPTIONS",
              });
            }
          });
          return;
        }
        // RTMP: the server sends its handshake bytes unprompted after connect.
        socket.on("data", (chunk) => {
          const head = chunk.subarray(0, 1).toString("latin1");
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            socket.destroy();
            const looksLikeHandshake = head.length === 1; // RTMP replies with a 1-byte version + 1536 random bytes
            resolve({
              ok: looksLikeHandshake,
              tcpMs,
              banner: `RTMP handshake byte 0x${chunk.subarray(0, 1).toString("hex")}`,
              error: looksLikeHandshake ? null : "Connected, but the server sent no RTMP handshake",
            });
          }
        });
        // Some RTMP servers wait for the client handshake first.
        socket.write(Buffer.from([0x03, 0x00, 0x00, 0x00, 0x00, 0x00, 0x03]));
      });

      socket.on("error", (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.destroy();
        resolve({ ok: false, tcpMs: null, banner: null, error: `${protocol.toUpperCase()} connect failed: ${err.message}` });
      });
      socket.on("close", () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ ok: false, tcpMs: null, banner: null, error: "Connection closed before a handshake completed" });
      });
    }
  );

  const timings = { dnsMs: null, tcpMs: outcome.tcpMs, tlsMs: null, ttfbMs: outcome.tcpMs, firstByteMs: outcome.tcpMs };
  const base = emptyBase(
    outcome.ok ? "reachable_only" : outcome.tcpMs !== null ? "unplayable" : "network_error",
    outcome.ok ? [] : [outcome.error || "Liveness check failed"],
    outcome.ok
      ? [
          `${protocol.toUpperCase()} liveness only: the server answered on ${host}:${port}, but throughput, resolution and stability cannot be measured without a full ${protocol.toUpperCase()} client.`,
          "Picture/speed scores are not derived from this check — only reachability.",
        ]
      : [],
    outcome.ok && outcome.banner ? [`Server greeting: ${outcome.banner}`] : [],
    );
  return { ...base, timings, sampleWindowMs: outcome.tcpMs ?? 0 };
}

function isHttpUrl(value: string): boolean {
  return /^https?:\/\//i.test(value.trim());
}

export function resolutionLabel(width: number | null, height: number | null): string {
  if (width && height) {
    if (width >= 3840 && height >= 2160) return "4K";
    if (width >= 1920 && height >= 1080) return "1080p";
    if (width >= 1280 && height >= 720) return "720p";
    if (width >= 854 && height >= 480) return "480p";
    return "SD";
  }
  return "Unknown";
}

// ============================================================================
// LOW-LEVEL HTTP: one request with DNS/TCP/TLS/TTFB timing + streaming hooks
// ============================================================================

interface RawRequestOptions {
  headers?: Record<string, string>;
  timeoutMs: number;
  maxBytes: number;
  proxy?: ProxyConfig | null;
  collectBody: boolean;
  collectBodyMaxBytes?: number;
  signal?: AbortSignal;
  /** Called for each non-empty chunk (after sniffing) while streaming. */
  onChunk?: (chunk: Buffer, atMs: number) => void;
  /** Return true to stop reading early (the response is destroyed). */
  shouldStop?: () => boolean;
}

interface RawRequestResult {
  status: ProbeStatus;
  statusCode: number | null;
  headers: http.IncomingHttpHeaders;
  finalUrl: string;
  redirectChain: string[];
  timings: ProbeTimings;
  body: string;
  /** Bytes held back for sniffing (not passed to onChunk). */
  sniff: Buffer;
  bytesRead: number;
  contentType: string;
  error: string | null;
  abortedByUser: boolean;
}

/**
 * One request, retried for transient failures (connect errors, timeouts and
 * retryable HTTP statuses). Returns the final attempt plus the retry count.
 */
async function requestWithRetry(
  url: string,
  options: RawRequestOptions,
  maxRetries: number
): Promise<RawRequestResult & { retryCount: number }> {
  let attempt = 0;
  let result = await rawRequest(url, options);

  while (attempt < maxRetries) {
    const retryableStatus =
      result.statusCode !== null && RETRYABLE_HTTP_STATUSES.has(result.statusCode);
    const retryableTransport =
      result.status === "timeout" ||
      // A connect reset/refused often clears on a second attempt (CDN edge).
      (result.status === "network_error" && !/invalid url/i.test(result.error || ""));
    if (result.abortedByUser || (!retryableStatus && !retryableTransport)) break;
    if (!retryableStatus && result.bytesRead > 0) break;

    attempt += 1;
    const delayMs = Math.min(1000 * 3 ** (attempt - 1), 6000);
    await sleep(delayMs);
    result = await rawRequest(url, options);
  }

  return { ...result, retryCount: attempt };
}

async function rawRequest(
  url: string,
  options: RawRequestOptions
): Promise<RawRequestResult> {
  const redirectChain: string[] = [];
  let currentUrl = url;
  let finalResult: RawRequestResult | null = null;

  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const result = await singleRequest(currentUrl, options);
    if (result.statusCode !== null && result.statusCode >= 300 && result.statusCode < 400) {
      const location = headerValue(result.headers, "location");
      if (location) {
        redirectChain.push(currentUrl);
        // Consume the body of the redirect response before moving on.
        try {
          currentUrl = new URL(location, currentUrl).toString();
        } catch {
          finalResult = {
            ...result,
            status: "network_error",
            error: `Invalid redirect location: ${location}`,
            redirectChain,
          };
          break;
        }
        continue;
      }
    }
    finalResult = { ...result, redirectChain };
    break;
  }

  if (!finalResult) {
    return {
      status: "network_error",
      statusCode: null,
      headers: {},
      finalUrl: url,
      redirectChain,
      timings: { dnsMs: null, tcpMs: null, tlsMs: null, ttfbMs: null, firstByteMs: null },
      body: "",
      sniff: Buffer.alloc(0),
      bytesRead: 0,
      contentType: "",
      error: `Exceeded ${MAX_REDIRECTS} redirects`,
      abortedByUser: false,
    };
  }

  return finalResult;
}

async function singleRequest(url: string, options: RawRequestOptions): Promise<RawRequestResult> {
  const start = nowMs();
  let dnsMs: number | null = null;
  let tcpMs: number | null = null;
  let tlsMs: number | null = null;
  let ttfbMs: number | null = null;
  let firstByteMs: number | null = null;
  let bytesRead = 0;
  let settled = false;
  let abortedByUser = false;
  let errorMessage: string | null = null;
  let responseHeaders: http.IncomingHttpHeaders = {};
  let statusCode: number | null = null;
  let contentType = "";
  let buffered = Buffer.alloc(0);
  let sniff: Buffer = Buffer.alloc(0);
  let body = "";

  const isTls = url.trim().toLowerCase().startsWith("https:") || url.trim().toLowerCase().startsWith("wss:");
  const transport = isTls ? https : http;

  const empty = (status: ProbeStatus, error: string | null): RawRequestResult => ({
    status,
    statusCode,
    headers: responseHeaders,
    finalUrl: url,
    redirectChain: [],
    timings: { dnsMs, tcpMs, tlsMs, ttfbMs, firstByteMs },
    body,
    sniff,
    bytesRead,
    contentType,
    error,
    abortedByUser,
  });

  if (options.signal?.aborted) {
    abortedByUser = true;
    return empty("network_error", "Aborted before the request started");
  }

  let target: URL;
  try {
    target = new URL(url);
  } catch {
    return empty("network_error", "Invalid URL");
  }

  // ── Optional proxy: open the CONNECT tunnel before building the request ──
  let preconnected: import("node:net").Socket | null = null;
  if (options.proxy) {
    try {
      const tunnel = await openProxyTunnel(options.proxy, target.hostname, Number(target.port || (isTls ? 443 : 80)), options.timeoutMs);
      tcpMs = round(nowMs() - start, 1);
      if (isTls) {
        preconnected = await new Promise<import("node:net").Socket>((resolve, reject) => {
          const secure = tlsOverTunnel(tunnel, target.hostname);
          secure.once("secureConnect", () => {
            tlsMs = round(nowMs() - start, 1);
            resolve(secure);
          });
          secure.once("error", (error: Error) => {
            tunnel.close();
            reject(error);
          });
        });
      } else {
        preconnected = tunnel.socket;
      }
    } catch (error) {
      return empty("network_error", error instanceof Error ? error.message : "Proxy tunnel failed");
    }
  }

  return new Promise((resolve) => {
    const finish = (status: ProbeStatus) => {
      if (settled) return;
      settled = true;
      // Detach from the scan-wide signal, otherwise every probe would leave
      // another abort listener (and its captured request) behind.
      detachAbort?.();
      resolve({
        status,
        statusCode,
        headers: responseHeaders,
        finalUrl: url,
        redirectChain: [],
        timings: { dnsMs, tcpMs, tlsMs, ttfbMs, firstByteMs },
        body,
        sniff,
        bytesRead,
        contentType,
        error: errorMessage,
        abortedByUser,
      });
    };

    let request: http.ClientRequest;
    let detachAbort: (() => void) | null = null;
    try {
      const requestOptions: http.RequestOptions & { servername?: string } = {
        protocol: target.protocol,
        hostname: target.hostname,
        host: target.hostname,
        port: Number(target.port || (isTls ? 443 : 80)),
        path: `${target.pathname}${target.search}`,
        method: "GET",
        headers: {
          "User-Agent": STB_USER_AGENT,
          Accept: "*/*",
          Connection: "close",
          Host: target.host,
          ...(options.headers || {}),
        },
      };

      if (preconnected) {
        const socket = preconnected;
        requestOptions.agent = false;
        requestOptions.createConnection = () => socket;
      } else {
        // Track DNS resolution time without changing resolver behaviour.
        // Node may call this with `all: true` (autoSelectFamily), so the
        // callback arguments are forwarded verbatim.
        requestOptions.lookup = ((hostname: string, lookupOptions: dns.LookupOptions, callback: (...args: unknown[]) => void) => {
          const lookupStart = nowMs();
          dns.lookup(hostname, lookupOptions, ((err: NodeJS.ErrnoException | null, address: unknown, family: unknown) => {
            dnsMs = round(nowMs() - lookupStart, 1);
            callback(err, address, family);
          }) as never);
        }) as never;
        requestOptions.servername = target.hostname;
      }

      request = transport.request(
        requestOptions,
        (response) => {
          responseHeaders = response.headers;
          statusCode = response.statusCode ?? null;
          contentType = contentTypeOf(response.headers);
          ttfbMs = round(nowMs() - start, 1);

          response.on("data", (rawChunk: Buffer | string) => {
            const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk);
            if (chunk.length === 0) return;
            const atMs = nowMs() - start;
            if (firstByteMs === null) firstByteMs = round(atMs, 1);
            bytesRead += chunk.length;

            // Keep a copy of the first bytes for signature detection, and let
            // every chunk flow to the caller's streaming hook.
            if (sniff.length < SNIFF_BYTES) {
              buffered = Buffer.concat([buffered, chunk]);
              sniff = Buffer.from(buffered.subarray(0, SNIFF_BYTES));
              if (buffered.length > SNIFF_BYTES) buffered = Buffer.alloc(0);
            }
            options.onChunk?.(chunk, atMs);

            if (options.collectBody) {
              const limit = options.collectBodyMaxBytes ?? 2 * 1024 * 1024;
              if (body.length < limit) {
                body += chunk.toString("utf8", 0, Math.min(chunk.length, limit - body.length));
              }
            }

            if (bytesRead >= options.maxBytes || (options.shouldStop && options.shouldStop())) {
              response.destroy();
              finish("measured");
            }
          });

          response.on("end", () => {
            if (sniff.length === 0 && buffered.length > 0) {
              sniff = buffered;
              buffered = Buffer.alloc(0);
            }
            finish("measured");
          });

          response.on("aborted", () => {
            errorMessage = errorMessage || "Response aborted by the server";
            finish("measured");
          });

          response.on("error", (err: Error) => {
            errorMessage = err.message;
            finish("measured");
          });
        }
      );
    } catch (err) {
      errorMessage = err instanceof Error ? err.message : "Request failed";
      finish("network_error");
      return;
    }

    request.on("socket", (socket) => {
      const typed = socket as unknown as { __macattackHooked?: boolean };
      if (typed.__macattackHooked) return;
      typed.__macattackHooked = true;
      socket.on("connect", () => {
        if (tcpMs === null) tcpMs = round(nowMs() - start, 1);
      });
      socket.on("secureConnect", () => {
        if (tlsMs === null) tlsMs = round(nowMs() - start, 1);
      });
    });

    request.setTimeout(options.timeoutMs, () => {
      errorMessage = `Timeout after ${options.timeoutMs}ms with no activity`;
      request.destroy(new Error("timeout"));
    });

    request.on("error", (err: Error) => {
      if (options.signal?.aborted) abortedByUser = true;
      const message = err.name === "AbortError" ? "Request aborted" : err.message || "Network error";
      errorMessage = errorMessage || message;
      const timedOut = /timeout/i.test(message);
      finish(timedOut ? "timeout" : "network_error");
    });

    detachAbort = onAbort(options.signal, () => {
      abortedByUser = true;
      request.destroy(new Error("AbortError"));
    });

    request.end();

    const watchdog = setInterval(() => {
      if (settled) {
        clearInterval(watchdog);
        return;
      }
      if (options.maxBytes > 0 && bytesRead >= options.maxBytes) {
        request.destroy();
        finish("measured");
      }
    }, 500);
    request.on("close", () => clearInterval(watchdog));
  });
}

// ============================================================================
// HLS PARSING
// ============================================================================

/** Split an HLS attribute list on commas that are outside quoted values. */
export function splitHlsAttributes(line: string): string[] {
  const parts: string[] = [];
  let start = 0;
  let inQuote = false;
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (char === '"') inQuote = !inQuote;
    else if (char === "," && !inQuote) {
      parts.push(line.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(line.slice(start));
  return parts;
}

function parseHlsAttributes(line: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawPart of splitHlsAttributes(line)) {
    const part = rawPart.trim();
    const eq = part.indexOf("=");
    if (eq <= 0) continue;
    const key = part.slice(0, eq).trim().toUpperCase();
    let value = part.slice(eq + 1).trim();
    if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

function parseResolution(value: string | undefined): { width: number | null; height: number | null } {
  if (!value) return { width: null, height: null };
  const match = /(\d{2,5})\s*[xX]\s*(\d{2,5})/.exec(value);
  if (!match) return { width: null, height: null };
  return { width: Number(match[1]), height: Number(match[2]) };
}

export function parseHlsPlaylist(body: string, baseUrl: string): {
  isMaster: boolean;
  variants: HlsVariant[];
  segments: Array<{ url: string; durationSec: number | null; discontinuityBefore: boolean }>;
  targetDurationSec: number | null;
  mediaSequence: number | null;
  hasEndlist: boolean;
  discontinuityCount: number;
  drm: string | null;
  variantCodecs: string | null;
} {
  const lines = body.split(/\r?\n/);
  const variants: HlsVariant[] = [];
  const segments: Array<{ url: string; durationSec: number | null; discontinuityBefore: boolean }> = [];
  let targetDurationSec: number | null = null;
  let mediaSequence: number | null = null;
  let hasEndlist = false;
  let discontinuityCount = 0;
  let drm: string | null = null;
  let pendingVariant: Record<string, string> | null = null;
  let pendingDuration: number | null = null;
  let pendingDiscontinuity = false;
  let variantCodecs: string | null = null;

  const resolve = (uri: string): string | null => {
    try {
      return new URL(uri.trim(), baseUrl).toString();
    } catch {
      return null;
    }
  };

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    if (line.startsWith("#EXT-X-TARGETDURATION:")) {
      const value = Number(line.slice("#EXT-X-TARGETDURATION:".length).trim());
      if (Number.isFinite(value)) targetDurationSec = value;
      continue;
    }
    if (line.startsWith("#EXT-X-MEDIA-SEQUENCE:")) {
      const value = Number(line.slice("#EXT-X-MEDIA-SEQUENCE:".length).trim());
      if (Number.isFinite(value)) mediaSequence = value;
      continue;
    }
    if (line.startsWith("#EXT-X-ENDLIST")) {
      hasEndlist = true;
      continue;
    }
    if (line.startsWith("#EXT-X-DISCONTINUITY") && !line.startsWith("#EXT-X-DISCONTINUITY-SEQUENCE")) {
      discontinuityCount += 1;
      pendingDiscontinuity = true;
      continue;
    }
    if (line.startsWith("#EXTINF:")) {
      const value = Number(line.slice("#EXTINF:".length).split(",")[0]);
      pendingDuration = Number.isFinite(value) ? value : null;
      continue;
    }
    if (line.startsWith("#EXT-X-KEY:") || line.startsWith("#EXT-X-SESSION-KEY:")) {
      const attrs = parseHlsAttributes(line.slice(line.indexOf(":") + 1));
      const method = (attrs.METHOD || "").toUpperCase();
      if (method && method !== "NONE" && method !== "AES-128") {
        const lower = line.toLowerCase();
        if (lower.includes("widevine") || lower.includes("edef8ba9-79d6-4ace-a3c8-27dcd51d21ed")) {
          drm = "Widevine";
        } else if (lower.includes("fairplay") || lower.includes("com.apple.streamingkeydelivery") || lower.includes("skd://")) {
          drm = drm || "FairPlay";
        } else if (lower.includes("playready") || lower.includes("9a04f079-9840-4286-ab92-e65be0885f95")) {
          drm = drm || "PlayReady";
        } else if (method === "SAMPLE-AES" || method === "SAMPLE-AES-CTR") {
          drm = drm || `HLS ${method}`;
        } else {
          drm = drm || `HLS ${method}`;
        }
      }
      if (method === "AES-128") {
        // Standard transport encryption: playable by every HLS client, not DRM.
        drm = drm ?? null;
      }
      continue;
    }
    if (line.startsWith("#EXT-X-STREAM-INF:")) {
      pendingVariant = parseHlsAttributes(line.slice("#EXT-X-STREAM-INF:".length));
      continue;
    }
    if (line.startsWith("#")) continue;

    const resolved = resolve(line);
    if (!resolved) continue;

    if (pendingVariant) {
      const resolution = parseResolution(pendingVariant.RESOLUTION);
      const bandwidth = Number(pendingVariant.BANDWIDTH || "");
      const averageBandwidth = Number(pendingVariant["AVERAGE-BANDWIDTH"] || "");
      variantCodecs = pendingVariant.CODECS || null;
      variants.push({
        url: resolved,
        bandwidthBps: Number.isFinite(bandwidth) && bandwidth > 0 ? bandwidth : null,
        averageBandwidthBps:
          Number.isFinite(averageBandwidth) && averageBandwidth > 0 ? averageBandwidth : null,
        width: resolution.width,
        height: resolution.height,
        codecs: pendingVariant.CODECS || null,
      });
      pendingVariant = null;
      continue;
    }

    segments.push({
      url: resolved,
      durationSec: pendingDuration,
      discontinuityBefore: pendingDiscontinuity,
    });
    pendingDuration = null;
    pendingDiscontinuity = false;
  }

  return {
    isMaster: variants.length > 0 && segments.length === 0,
    variants,
    segments,
    targetDurationSec,
    mediaSequence,
    hasEndlist,
    discontinuityCount,
    drm,
    variantCodecs,
  };
}

/** Pick the variant a quality-seeking player would choose (IPTVChecker order). */
export function pickBestVariant(variants: HlsVariant[]): HlsVariant | null {
  if (variants.length === 0) return null;
  const score = (variant: HlsVariant): number => {
    const pixels = (variant.width ?? 0) * (variant.height ?? 0);
    return pixels * 1e12 + (variant.averageBandwidthBps ?? 0) * 1e3 + (variant.bandwidthBps ?? 0);
  };
  return variants.reduce((best, candidate) => (score(candidate) > score(best) ? candidate : best));
}

// ============================================================================
// MPEG-TS ANALYSIS (PAT/PMT, continuity counters, scrambling, bitrate)
// ============================================================================

const TS_PACKET_SIZE = 188;

const TS_STREAM_TYPES: Record<number, { codec: string; kind: "video" | "audio" | "data" | "other" }> = {
  0x01: { codec: "MPEG-1 Video", kind: "video" },
  0x02: { codec: "MPEG-2 Video", kind: "video" },
  0x03: { codec: "MPEG-1 Audio", kind: "audio" },
  0x04: { codec: "MPEG-2 Audio", kind: "audio" },
  0x06: { codec: "Private PES (AC-3/DVB)", kind: "audio" },
  0x0f: { codec: "AAC (ADTS)", kind: "audio" },
  0x10: { codec: "MPEG-4 Video", kind: "video" },
  0x11: { codec: "AAC (LATM)", kind: "audio" },
  0x15: { codec: "Metadata", kind: "data" },
  0x1b: { codec: "H.264", kind: "video" },
  0x24: { codec: "HEVC", kind: "video" },
  0x42: { codec: "AVS", kind: "video" },
  0x81: { codec: "AC-3", kind: "audio" },
  0x82: { codec: "DTS", kind: "audio" },
  0x86: { codec: "SCTE-35", kind: "data" },
  0x87: { codec: "E-AC-3", kind: "audio" },
};

export class TsAnalyzer {
  private buffer: Buffer = Buffer.alloc(0);
  private aligned = false;
  private packetCount = 0;
  private byteCount = 0;
  private syncLosses = 0;
  private scrambled = 0;
  private continuityErrors = 0;
  private lastCc = new Map<number, number>();
  private pmtPids = new Set<number>();
  private pendingSections = new Map<number, Buffer>();
  private pidStats = new Map<number, TsPidInfo>();
  private sawPat = false;

  push(chunk: Buffer): void {
    this.byteCount += chunk.length;
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);

    if (!this.aligned) {
      const offset = this.findSyncOffset(this.buffer);
      if (offset === -1) {
        // Not enough data to align yet; keep a tail so the next chunk can align.
        if (this.buffer.length > TS_PACKET_SIZE * 4) {
          this.buffer = this.buffer.subarray(this.buffer.length - TS_PACKET_SIZE * 4);
        }
        return;
      }
      if (offset > 0) {
        this.syncLosses += 1;
        this.buffer = this.buffer.subarray(offset);
      }
      this.aligned = true;
    }

    let cursor = 0;
    while (cursor + TS_PACKET_SIZE <= this.buffer.length) {
      if (this.buffer[cursor] !== 0x47) {
        this.aligned = false;
        this.syncLosses += 1;
        this.buffer = this.buffer.subarray(cursor);
        const offset = this.findSyncOffset(this.buffer);
        if (offset === -1) return;
        this.buffer = this.buffer.subarray(offset);
        cursor = 0;
        this.aligned = true;
        continue;
      }
      this.parsePacket(this.buffer, cursor);
      cursor += TS_PACKET_SIZE;
    }
    this.buffer = this.buffer.subarray(cursor);
  }

  private findSyncOffset(buffer: Buffer): number {
    const limit = Math.min(buffer.length - TS_PACKET_SIZE * 2, TS_PACKET_SIZE * 8);
    for (let offset = 0; offset <= limit; offset += 1) {
      if (
        buffer[offset] === 0x47 &&
        buffer[offset + TS_PACKET_SIZE] === 0x47 &&
        buffer[offset + TS_PACKET_SIZE * 2] === 0x47
      ) {
        return offset;
      }
    }
    return -1;
  }

  private parsePacket(buffer: Buffer, offset: number): void {
    const b1 = buffer[offset + 1];
    const b2 = buffer[offset + 2];
    const b3 = buffer[offset + 3];
    const payloadUnitStart = (b1 & 0x40) !== 0;
    const pid = ((b1 & 0x1f) << 8) | b2;
    const scrambling = (b3 & 0xc0) >> 6;
    const adaptationControl = (b3 & 0x30) >> 4;
    const continuityCounter = b3 & 0x0f;

    this.packetCount += 1;

    const stats = this.pidStats.get(pid) ?? {
      pid,
      packets: 0,
      bytes: 0,
      kind: "other" as const,
      codec: null,
    };
    stats.packets += 1;
    stats.bytes += TS_PACKET_SIZE;
    this.pidStats.set(pid, stats);

    if (scrambling !== 0) this.scrambled += 1;

    const hasPayload = adaptationControl === 1 || adaptationControl === 3;
    if (hasPayload) {
      const previous = this.lastCc.get(pid);
      const expected = previous === undefined ? continuityCounter : (previous + 1) & 0x0f;
      // Duplicate packets (same CC) are legal in MPEG-TS; a jump is a discontinuity.
      if (previous !== undefined && continuityCounter !== expected && continuityCounter !== previous) {
        this.continuityErrors += 1;
      }
      this.lastCc.set(pid, continuityCounter);
    }

    if (!payloadUnitStart) return;

    let payloadStart = offset + 4;
    if (adaptationControl === 2) return; // adaptation field only
    if (adaptationControl === 3) {
      const adaptationLength = buffer[offset + 4];
      payloadStart = offset + 5 + adaptationLength;
      if (payloadStart >= offset + TS_PACKET_SIZE) return;
    }

    if (pid === 0) {
      this.sawPat = true;
      stats.kind = "pat";
      const section = this.readSection(buffer, payloadStart, offset + TS_PACKET_SIZE);
      if (section && section.tableId === 0x00) this.parsePat(section.payload, section.offset);
      return;
    }

    if (this.pmtPids.has(pid)) {
      stats.kind = "pmt";
      const section = this.readSection(buffer, payloadStart, offset + TS_PACKET_SIZE);
      if (section && section.tableId === 0x02) this.parsePmt(section.payload, section.offset);
      return;
    }
  }

  /** Read a PSI section starting at pointer_field; returns null when truncated. */
  private readSection(
    buffer: Buffer,
    payloadStart: number,
    packetEnd: number
  ): { tableId: number; payload: Buffer; offset: number } | null {
    if (payloadStart >= packetEnd) return null;
    const pointer = buffer[payloadStart];
    const sectionStart = payloadStart + 1 + pointer;
    if (sectionStart + 3 > packetEnd) return null;
    const tableId = buffer[sectionStart];
    const sectionLength = ((buffer[sectionStart + 1] & 0x0f) << 8) | buffer[sectionStart + 2];
    const available = packetEnd - sectionStart;
    if (available < 3 + sectionLength) return null; // truncated: wait for the next packet
    return {
      tableId,
      payload: buffer.subarray(sectionStart + 3, sectionStart + 3 + sectionLength),
      offset: 0,
    };
  }

  private parsePat(payload: Buffer, _offset: number): void {
    // Section body layout: transport_stream_id(2), version(1), section_number(1),
    // last_section_number(1), then 4-byte program entries, then the CRC.
    if (payload.length < 5 + 4) return;
    const end = payload.length - 4; // CRC32
    for (let i = 5; i + 4 <= end; i += 4) {
      const programNumber = (payload[i] << 8) | payload[i + 1];
      const pid = ((payload[i + 2] & 0x1f) << 8) | payload[i + 3];
      if (programNumber !== 0) this.pmtPids.add(pid);
    }
  }

  private parsePmt(payload: Buffer, _offset: number): void {
    if (payload.length < 9) return;
    const programInfoLength = ((payload[7] & 0x0f) << 8) | payload[8];
    let cursor = 9 + programInfoLength;
    const end = payload.length - 4;
    while (cursor + 5 <= end) {
      const streamType = payload[cursor];
      const elementaryPid = ((payload[cursor + 1] & 0x1f) << 8) | payload[cursor + 2];
      const esInfoLength = ((payload[cursor + 3] & 0x0f) << 8) | payload[cursor + 4];
      const info = TS_STREAM_TYPES[streamType];
      const stats = this.pidStats.get(elementaryPid) ?? {
        pid: elementaryPid,
        packets: 0,
        bytes: 0,
        kind: "other" as const,
        codec: null,
      };
      if (info) {
        stats.kind = info.kind;
        stats.codec = info.codec;
      } else {
        stats.codec = stats.codec || `0x${streamType.toString(16).padStart(2, "0")}`;
      }
      this.pidStats.set(elementaryPid, stats);
      cursor += 5 + esInfoLength;
    }
  }

  summary(durationMs: number): TsAnalysis {
    const pids = Array.from(this.pidStats.values()).sort((a, b) => b.bytes - a.bytes);
    const videoPids = pids.filter((pid) => pid.kind === "video");
    const audioPids = pids.filter((pid) => pid.kind === "audio");
    const seconds = Math.max(durationMs, 1) / 1000;
    const totalBits = this.byteCount * 8;
    const videoBits = videoPids.reduce((sum, pid) => sum + pid.bytes * 8, 0);
    return {
      packets: this.packetCount,
      bytes: this.byteCount,
      syncLosses: this.syncLosses,
      continuityErrors: this.continuityErrors,
      scrambledPackets: this.scrambled,
      pids,
      videoCodecs: Array.from(new Set(videoPids.map((pid) => pid.codec).filter(Boolean) as string[])),
      audioCodecs: Array.from(new Set(audioPids.map((pid) => pid.codec).filter(Boolean) as string[])),
      bitrateMbps: round(totalBits / seconds / 1_000_000, 3),
      videoBitrateMbps: videoPids.length > 0 ? round(videoBits / seconds / 1_000_000, 3) : null,
      continuityErrorsPer1000:
        this.packetCount > 0 ? round((this.continuityErrors / this.packetCount) * 1000, 3) : 0,
    };
  }

  get hasPat(): boolean {
    return this.sawPat;
  }
}

/** Cheap sniff: does this buffer look like an MPEG-TS payload? */
export function looksLikeMpegTs(buffer: Buffer): boolean {
  if (buffer.length < TS_PACKET_SIZE * 3) return false;
  for (let offset = 0; offset < Math.min(buffer.length - TS_PACKET_SIZE * 3, 16); offset += 1) {
    if (
      buffer[offset] === 0x47 &&
      buffer[offset + TS_PACKET_SIZE] === 0x47 &&
      buffer[offset + TS_PACKET_SIZE * 2] === 0x47
    ) {
      return true;
    }
  }
  return false;
}

// ============================================================================
// CONTAINER DETECTION
// ============================================================================

export function detectContainer(
  contentType: string,
  bodyOrSniff: Buffer | string,
  url: string
): ProbeContainer {
  const text =
    typeof bodyOrSniff === "string"
      ? bodyOrSniff
      : bodyOrSniff.toString("utf8", 0, Math.min(bodyOrSniff.length, 1024));
  const lowerText = text.toLowerCase();
  const path = (() => {
    try {
      return new URL(url).pathname.toLowerCase();
    } catch {
      return url.toLowerCase();
    }
  })();

  if (lowerText.includes("#extm3u") || path.endsWith(".m3u8") || contentType.includes("mpegurl")) {
    return "hls";
  }
  if (lowerText.includes("<mpd") || path.endsWith(".mpd") || contentType.includes("dash+xml")) {
    return "dash";
  }
  if (typeof bodyOrSniff !== "string" && looksLikeMpegTs(bodyOrSniff)) return "mpegts";
  if (contentType.includes("mp2t") || path.endsWith(".ts") || path.endsWith(".m2ts")) return "mpegts";
  if (
    contentType.includes("mp4") ||
    path.endsWith(".mp4") ||
    path.endsWith(".m4s") ||
    lowerText.includes("ftyp")
  ) {
    return "mp4";
  }
  if (contentType.startsWith("video/") || contentType.startsWith("audio/")) return "other";
  if (contentType.includes("octet-stream")) return "other";
  return "unknown";
}

// ============================================================================
// MAIN PROBE
// ============================================================================

export async function probeStream(
  url: string,
  options: StreamProbeOptions = {}
): Promise<StreamProbeResult> {
  const sampleMs = clamp(options.sampleMs ?? DEFAULT_SAMPLE_MS, 2000, 30000);
  const timeoutMs = clamp(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, 1500, 30000);
  const maxBytes = clamp(options.maxBytes ?? DEFAULT_MAX_BYTES, 256 * 1024, 512 * 1024 * 1024);
  const maxDepth = clamp(options.maxPlaylistDepth ?? 3, 1, 5);
  const measuredAt = new Date().toISOString();

  const base: StreamProbeResult = {
    url,
    finalUrl: url,
    redirectChain: [],
    status: "unknown" as ProbeStatus,
    httpStatus: null,
    contentType: null,
    container: "unknown",
    requiredMbps: null,
    requiredMbpsSource: null,
    sustainedMbps: null,
    peakMbps: null,
    minSampleMbps: null,
    throughputCoefficientOfVariation: null,
    throughputSamples: [],
    maxGapMs: null,
    sampleWindowMs: 0,
    bytesRead: 0,
    timings: { dnsMs: null, tcpMs: null, tlsMs: null, ttfbMs: null, firstByteMs: null },
    hls: null,
    ts: null,
    resolution: null,
    videoCodec: null,
    audioCodec: null,
    drm: null,
    retryCount: 0,
    protocol: "http",
    viaProxy: options.proxy ? `${options.proxy.host}:${options.proxy.port}` : null,
    errors: [],
    warnings: [],
    notes: [],
    measuredAt,
  };

  const trimmed = (url || "").trim();
  if (!isHttpUrl(trimmed)) {
    // RTSP / RTMP / UDP: bounded TCP reachability check where it is meaningful.
    const streamProtocol = detectStreamProtocol(trimmed);
    if (streamProtocol === "rtsp" || streamProtocol === "rtmp") {
      return probeSocketLiveness(trimmed, streamProtocol, timeoutMs, options);
    }
    if (streamProtocol === "udp") {
      return {
        ...base,
        protocol: "udp",
        container: "udp",
        status: "unverifiable",
        notes: [
          "UDP streams carry no handshake to test: a UDP socket always appears to \"connect\", so liveness cannot be verified from the scanner host.",
          "Open the stream in a player on the target device to confirm it works.",
        ],
        errors: [],
        warnings: ["UDP liveness cannot be verified without an RTCP/RTSP client or a decoder"],
      };
    }
    return {
      ...base,
      status: "unsupported_scheme",
      errors: [`Unsupported stream scheme (got "${trimmed.slice(0, 60)}") — supported: http(s), rtsp, rtmp, udp`],
    };
  }

  const headers = { Referer: trimmed, ...(options.headers || {}) };

  // ---------------------------------------------------------------------------
  // Step 1: fetch the URL, sniffing the first bytes to classify the container.
  // ---------------------------------------------------------------------------
  const startedAt = nowMs();
  let tsAnalyzer: TsAnalyzer | null = null;
  let sniffBuffer: Buffer = Buffer.alloc(0);
  let tsDecisionMade = false;
  const throughputSamples: ThroughputSample[] = [];
  let windowBytes = 0;
  let bucketBytes = 0;
  let lastSampleAt = 0;
  let lastDataAt: number | null = null;
  let maxGapMs = 0;
  let exceededMinBytes = false;

  const shouldStop = (): boolean => {
    const elapsed = nowMs() - startedAt;
    if (elapsed >= sampleMs) return true;
    // For a direct stream, stop once the sample window AND the liveness
    // threshold are both satisfied (IPTVChecker's 500 KB rule).
    if (exceededMinBytes && elapsed >= Math.min(sampleMs, 3000)) return true;
    return false;
  };

  const onChunk = (chunk: Buffer, atMs: number): void => {
    if (atMs > sampleMs * 4) return;
    windowBytes += chunk.length;
    bucketBytes += chunk.length;
    if (lastDataAt !== null) {
      const gap = atMs - lastDataAt;
      if (gap > maxGapMs) maxGapMs = gap;
    }
    lastDataAt = atMs;

    if (atMs - lastSampleAt >= SAMPLE_BUCKET_MS) {
      const bucketMs = atMs - lastSampleAt;
      throughputSamples.push({
        atMs: round(atMs, 0),
        bytes: bucketBytes,
        mbps: bucketMs > 0 ? round((bucketBytes * 8) / bucketMs / 1000, 3) : 0,
      });
      lastSampleAt = atMs;
      bucketBytes = 0;
    }

    // Decide once the first SNIFF_BYTES have arrived whether this is MPEG-TS,
    // and feed the analyzer from that point on (no bytes are lost).
    if (!tsDecisionMade) {
      if (sniffBuffer.length < SNIFF_BYTES) {
        sniffBuffer = Buffer.concat([sniffBuffer, chunk]);
        if (sniffBuffer.length < SNIFF_BYTES) return;
      }
      tsDecisionMade = true;
      if (looksLikeMpegTs(sniffBuffer)) {
        tsAnalyzer = new TsAnalyzer();
        tsAnalyzer.push(sniffBuffer);
      }
      return;
    }
    tsAnalyzer?.push(chunk);
    if (windowBytes >= MIN_MEDIA_BYTES_DIRECT) exceededMinBytes = true;
  };

  const maxRetries = clamp(Math.floor(options.maxRetries ?? 2), 0, 4);
  const first = await requestWithRetry(
    trimmed,
    {
      headers,
      timeoutMs,
      maxBytes,
      proxy: options.proxy ?? null,
      collectBody: true,
      collectBodyMaxBytes: 512 * 1024,
      signal: options.signal,
      onChunk,
      shouldStop,
    },
    maxRetries
  );

  const sniffText = first.sniff.toString("utf8", 0, Math.min(first.sniff.length, 1024));
  const sniffedIsText = /^\s*(#extm3u|<\?xml|<mpd|\{)/i.test(sniffText) || sniffText.startsWith("#EXTM3U");
  const containerFromSniff = detectContainer(
    first.contentType,
    sniffedIsText ? sniffText : first.sniff,
    first.finalUrl
  );

  // Track timing information from the first request.
  const timings: ProbeTimings = { ...first.timings };

  if (first.retryCount > 0) {
    base.retryCount = first.retryCount;
    base.notes.push(`Retried ${first.retryCount}× after a transient response before this measurement`);
  }

  if (first.statusCode !== null && first.statusCode >= 400) {
    const warnings: string[] = [];
    if (GEOBLOCK_HTTP_STATUSES.has(first.statusCode)) {
      warnings.push(
        `HTTP ${first.statusCode} is a common geoblock/account-restriction response for this stream`
      );
    } else if (RETRYABLE_HTTP_STATUSES.has(first.statusCode)) {
      warnings.push(`HTTP ${first.statusCode} is usually transient — retry before judging this source`);
    }
    return {
      ...base,
      status: "http_error",
      httpStatus: first.statusCode,
      contentType: first.contentType || null,
      container: containerFromSniff,
      finalUrl: first.finalUrl,
      redirectChain: first.redirectChain,
      timings,
      bytesRead: first.bytesRead,
      sampleWindowMs: Math.round(nowMs() - startedAt),
      warnings,
      errors: [`Stream returned HTTP ${first.statusCode}`],
    };
  }

  if (first.status === "network_error" || first.status === "timeout") {
    return {
      ...base,
      status: first.abortedByUser ? "network_error" : first.status,
      httpStatus: first.statusCode,
      finalUrl: first.finalUrl,
      redirectChain: first.redirectChain,
      timings,
      bytesRead: first.bytesRead,
      sampleWindowMs: Math.round(nowMs() - startedAt),
      container: containerFromSniff,
      errors: [first.error || "Request failed before any media data arrived"],
    };
  }

  // ---------------------------------------------------------------------------
  // Step 2a: HLS — master playlist → best variant → media playlist → segments
  // ---------------------------------------------------------------------------
  if (containerFromSniff === "hls") {
    return probeHls(
      {
        base,
        headers,
        timeoutMs,
        sampleMs,
        maxBytes,
        signal: options.signal,
        timings,
        redirectChain: first.redirectChain,
        finalUrl: first.finalUrl,
        contentType: first.contentType,
        maxDepth,
        startedAt,
        proxy: options.proxy ?? null,
      },
      first.body || first.sniff.toString("utf8"),
      first.finalUrl,
      0
    );
  }

  // ---------------------------------------------------------------------------
  // Step 2b: MPEG-TS or other direct stream — we are already streaming it.
  // ---------------------------------------------------------------------------
  const elapsedMs = Math.round(nowMs() - startedAt);
  const isTs = containerFromSniff === "mpegts";
  if (isTs && tsAnalyzer === null && first.sniff.length > 0) {
    // Very short streams never reached the in-flight sniff threshold, so the
    // decision happens here instead (first.sniff holds everything received).
    tsAnalyzer = new TsAnalyzer();
    tsAnalyzer.push(first.sniff);
  }

  const samples = finalizeThroughput(
    throughputSamples,
    windowBytes,
    Math.max(elapsedMs, 1),
    bucketBytes
  );
  // Timeouts/network errors returned early above; anything that reached this
  // point produced a response we could measure.
  const status: ProbeStatus = windowBytes === 0 ? "unplayable" : "measured";
  const ts = tsAnalyzer ? tsAnalyzer.summary(Math.max(elapsedMs, 1)) : null;

  const result: StreamProbeResult = {
    ...base,
    status,
    httpStatus: first.statusCode,
    contentType: first.contentType || null,
    container: containerFromSniff,
    finalUrl: first.finalUrl,
    redirectChain: first.redirectChain,
    timings,
    sustainedMbps: samples.sustainedMbps,
    peakMbps: samples.peakMbps,
    minSampleMbps: samples.minSampleMbps,
    throughputCoefficientOfVariation: samples.cv,
    throughputSamples: samples.samples,
    maxGapMs: maxGapMs > 0 ? Math.round(maxGapMs) : null,
    sampleWindowMs: elapsedMs,
    bytesRead: first.bytesRead,
    ts,
    drm: ts && ts.scrambledPackets > ts.packets * 0.5 ? "Scrambled transport stream" : null,
    videoCodec: ts?.videoCodecs[0] ?? null,
    audioCodec: ts?.audioCodecs[0] ?? null,
    // NOTE: for a raw TS (or any server-paced live stream) the delivered rate
    // IS the stream's bitrate — you cannot infer spare capacity from it, so no
    // "required" figure is claimed here. The measured bitrate stays in `ts`.
    requiredMbps: null,
    requiredMbpsSource: null,
    errors: first.error ? [first.error] : [],
    warnings: [],
    notes: [],
  };

  if (ts) {
    result.notes.push(
      "Raw transport stream: the server paces this at real time, so delivered bitrate is reported without a headroom claim."
    );
  }

  if (ts) {
    result.notes.push(
      `MPEG-TS analysed over ${(elapsedMs / 1000).toFixed(1)}s: ${ts.packets} packets, ${ts.pids.length} PIDs, measured ${ts.bitrateMbps} Mbps`
    );
    if (!ts.pids.some((pid) => pid.kind === "video") && ts.packets > 1000) {
      result.warnings.push("No video PID appeared in the transport stream sample (audio-only or data stream?)");
    }
    if (ts.scrambledPackets > 0) {
      result.warnings.push(
        `${ts.scrambledPackets} scrambled packets seen — the stream is encrypted and will not play without the operator's key`
      );
    }
  }

  if (first.bytesRead < MIN_MEDIA_BYTES_DIRECT && status === "measured") {
    result.warnings.push(
      `Only ${Math.round(first.bytesRead / 1024)} KB arrived in ${(elapsedMs / 1000).toFixed(1)}s — below the ${Math.round(
        MIN_MEDIA_BYTES_DIRECT / 1024
      )} KB liveness threshold`
    );
    if (first.bytesRead < 16 * 1024) result.status = "unplayable";
  }

  if (containerFromSniff === "unknown") {
    const preview = sniffText.replace(/\s+/g, " ").slice(0, 120);
    result.warnings.push(
      `Unrecognised payload (content-type "${first.contentType || "none"}"): ${preview || "<binary>"}`
    );
  }

  return result;
}

function finalizeThroughput(
  rawSamples: ThroughputSample[],
  totalBytes: number,
  windowMs: number,
  pendingBucketBytes: number
): {
  samples: ThroughputSample[];
  sustainedMbps: number | null;
  peakMbps: number | null;
  minSampleMbps: number | null;
  cv: number | null;
} {
  const samples = [...rawSamples];
  if (pendingBucketBytes > 0) {
    const lastAt = samples.length > 0 ? samples[samples.length - 1].atMs : 0;
    const bucketMs = Math.max(windowMs - lastAt, 1);
    samples.push({
      atMs: Math.round(windowMs),
      bytes: pendingBucketBytes,
      mbps: round((pendingBucketBytes * 8) / bucketMs / 1000, 3),
    });
  }
  if (totalBytes === 0 || windowMs <= 0) {
    return { samples, sustainedMbps: null, peakMbps: null, minSampleMbps: null, cv: null };
  }
  const sustainedMbps = round((totalBytes * 8) / windowMs / 1000, 3);
  // Ignore the first (warm-up) bucket for peak/min so a burst of playlist bytes
  // does not distort the picture.
  const steady = samples.length > 2 ? samples.slice(1) : samples;
  const values = steady.map((sample) => sample.mbps).filter((value) => value > 0);
  if (values.length === 0) {
    return { samples, sustainedMbps, peakMbps: sustainedMbps, minSampleMbps: sustainedMbps, cv: null };
  }
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;
  const stdev = Math.sqrt(variance);
  return {
    samples,
    sustainedMbps,
    peakMbps: round(Math.max(...values), 3),
    minSampleMbps: round(Math.min(...values), 3),
    cv: mean > 0 ? round(stdev / mean, 3) : null,
  };
}

interface HlsProbeContext {
  base: StreamProbeResult;
  headers: Record<string, string>;
  timeoutMs: number;
  sampleMs: number;
  maxBytes: number;
  signal?: AbortSignal;
  timings: ProbeTimings;
  redirectChain: string[];
  finalUrl: string;
  contentType: string;
  maxDepth: number;
  startedAt: number;
  proxy?: ProxyConfig | null;
}

async function probeHls(
  context: HlsProbeContext,
  playlistBody: string,
  playlistUrl: string,
  depth: number
): Promise<StreamProbeResult> {
  const parsed = parseHlsPlaylist(playlistBody, playlistUrl);
  const hls: HlsAnalysis = {
    isMaster: parsed.isMaster,
    variantLadder: parsed.variants,
    selectedVariantUrl: null,
    selectedRequiredMbps: null,
    selectedRequiredSource: null,
    targetDurationSec: parsed.targetDurationSec,
    mediaSequence: parsed.mediaSequence,
    endsWithEndlist: parsed.hasEndlist,
    discontinuityCount: parsed.discontinuityCount,
    drm: parsed.drm,
    segmentsPlanned: parsed.segments.length,
    segments: [],
    segmentsOk: 0,
    segmentsFailed: 0,
    realtimeDeficitMs: 0,
    worstRealtimeRatio: null,
  };

  // Master playlist: walk down to the best variant.
  if (parsed.isMaster && depth < context.maxDepth) {
    const best = pickBestVariant(parsed.variants);
    if (!best) {
      return {
        ...context.base,
        status: "unplayable",
        container: "hls",
        finalUrl: playlistUrl,
        timings: context.timings,
        redirectChain: context.redirectChain,
        contentType: context.contentType || null,
        hls,
        errors: ["Master playlist contained no playable variants"],
      };
    }
    hls.selectedVariantUrl = best.url;
    hls.selectedRequiredMbps = (best.averageBandwidthBps ?? best.bandwidthBps) != null
      ? round(((best.averageBandwidthBps ?? best.bandwidthBps) as number) / 1_000_000, 3)
      : null;
    hls.selectedRequiredSource = best.averageBandwidthBps != null ? "average-bandwidth" : best.bandwidthBps != null ? "bandwidth" : null;

    const variantResponse = await requestWithRetry(
      best.url,
      {
        headers: context.headers,
        timeoutMs: context.timeoutMs,
        maxBytes: 2 * 1024 * 1024,
        proxy: context.proxy ?? null,
        collectBody: true,
        collectBodyMaxBytes: 2 * 1024 * 1024,
        signal: context.signal,
      },
      1
    );

    if (variantResponse.statusCode !== null && variantResponse.statusCode >= 400) {
      return {
        ...context.base,
        status: "http_error",
        httpStatus: variantResponse.statusCode,
        container: "hls",
        finalUrl: variantResponse.finalUrl,
        timings: context.timings,
        redirectChain: [...context.redirectChain, ...variantResponse.redirectChain],
        contentType: variantResponse.contentType || null,
        hls,
        resolution: best.height ? { width: best.width, height: best.height, label: resolutionLabel(best.width, best.height) } : null,
        errors: [`Best HLS variant returned HTTP ${variantResponse.statusCode}`],
      };
    }

    const variantBody = variantResponse.body || variantResponse.sniff.toString("utf8");
    const nested = parseHlsPlaylist(variantBody, variantResponse.finalUrl);
    if (nested.isMaster) {
      // Nested master (unusual, but some portals chain them).
      return probeHls(context, variantBody, variantResponse.finalUrl, depth + 1);
    }

    // Sample the media playlist's segments, keeping the master-ladder metadata.
    const media = await sampleHlsMedia(
      context,
      nested,
      variantResponse.finalUrl,
      hls.selectedRequiredMbps,
      hls.selectedRequiredSource
    );
    return {
      ...media,
      hls: {
        ...hls,
        ...media.hls!,
        isMaster: true,
        variantLadder: parsed.variants,
        selectedVariantUrl: best.url,
        selectedRequiredMbps: hls.selectedRequiredMbps,
        selectedRequiredSource: hls.selectedRequiredSource,
      },
      resolution: best.height
        ? { width: best.width, height: best.height, label: resolutionLabel(best.width, best.height) }
        : media.resolution,
      videoCodec: media.videoCodec ?? codecFromHlsCodecs(best.codecs),
    };
  }

  // Already a media playlist.
  const media = await sampleHlsMedia(context, parsed, playlistUrl, null, null);
  return media;
}

function codecFromHlsCodecs(codecs: string | null): string | null {
  if (!codecs) return null;
  const lower = codecs.toLowerCase();
  if (lower.includes("hvc1") || lower.includes("hev1")) return "HEVC";
  if (lower.includes("avc1") || lower.includes("avc3")) return "H.264";
  if (lower.includes("av01")) return "AV1";
  if (lower.includes("mp4a")) return "AAC";
  if (lower.includes("ac-3") || lower.includes("ec-3")) return "AC-3";
  return codecs;
}

async function sampleHlsMedia(
  context: HlsProbeContext,
  parsed: ReturnType<typeof parseHlsPlaylist>,
  playlistUrl: string,
  variantRequiredMbps: number | null,
  variantRequiredSource: "average-bandwidth" | "bandwidth" | "segment-mean" | null
): Promise<StreamProbeResult> {
  const hls: HlsAnalysis = {
    isMaster: parsed.isMaster,
    variantLadder: parsed.variants,
    selectedVariantUrl: null,
    selectedRequiredMbps: variantRequiredMbps,
    selectedRequiredSource: variantRequiredSource,
    targetDurationSec: parsed.targetDurationSec,
    mediaSequence: parsed.mediaSequence,
    endsWithEndlist: parsed.hasEndlist,
    discontinuityCount: parsed.discontinuityCount,
    drm: parsed.drm,
    segmentsPlanned: parsed.segments.length,
    segments: [],
    segmentsOk: 0,
    segmentsFailed: 0,
    realtimeDeficitMs: 0,
    worstRealtimeRatio: null,
  };

  const result: StreamProbeResult = {
    ...context.base,
    status: "measured",
    container: "hls",
    finalUrl: playlistUrl,
    redirectChain: context.redirectChain,
    contentType: context.contentType || null,
    hls,
    drm: parsed.drm,
    requiredMbps: variantRequiredMbps,
    requiredMbpsSource: variantRequiredSource,
  };

  if (parsed.segments.length === 0) {
    result.status = "unplayable";
    result.errors.push("HLS playlist contained no media segments");
    return result;
  }

  // Sample whole segments, newest-first ordering is preserved; for live
  // playlists start at the beginning of the window so we see a full segment.
  const sampleStartedAt = nowMs();
  const segmentBudgetMs = context.sampleMs;
  const throughput: ThroughputSample[] = [];
  let totalBytes = 0;
  let totalTransferMs = 0;
  let segmentRetries = 0;

  for (let index = 0; index < parsed.segments.length; index += 1) {
    if (context.signal?.aborted) {
      result.warnings.push("Probe aborted by the scanner before the sample window completed");
      break;
    }
    const elapsed = nowMs() - sampleStartedAt;
    if (elapsed >= segmentBudgetMs) break;
    if (totalBytes >= context.maxBytes) {
      result.warnings.push("Byte cap reached before the sample window completed");
      break;
    }

    const segment = parsed.segments[index];
    const segmentStart = nowMs();
    let segmentBytes = 0;
    let segmentTtfb: number | null = null;
    let transferStartAt: number | null = null;
    let lastAt: number | null = null;

    const response = await requestWithRetry(
      segment.url,
      {
      headers: context.headers,
      timeoutMs: Math.min(context.timeoutMs, 10000),
      maxBytes: Math.min(context.maxBytes - totalBytes, 64 * 1024 * 1024),
      proxy: context.proxy ?? null,
      collectBody: false,
      signal: context.signal,
      shouldStop: () => {
        // Never spend more than 2.5× the segment duration on one segment.
        const durationMs = (segment.durationSec ?? 6) * 1000;
        return nowMs() - segmentStart > Math.max(durationMs * 2.5, 5000);
      },
      onChunk: (chunk, atMs) => {
        segmentBytes += chunk.length;
        if (segmentTtfb === null) segmentTtfb = atMs - segmentStart;
        transferStartAt = transferStartAt ?? atMs;
        lastAt = atMs;
      },
    },
      1
    );
    segmentRetries += response.retryCount;

    const transferMs = Math.max(nowMs() - segmentStart, 1);
    const ok = response.statusCode !== null && response.statusCode < 400 && segmentBytes > 0;
    const mbps = ok ? round((segmentBytes * 8) / transferMs / 1000, 3) : 0;
    const realtimeRatio = ok && segment.durationSec && segment.durationSec > 0
      ? round(transferMs / (segment.durationSec * 1000), 3)
      : null;

    if (ok) {
      totalBytes += segmentBytes;
      totalTransferMs += transferMs;
      hls.segmentsOk += 1;
      if (realtimeRatio !== null && realtimeRatio > 1) {
        hls.realtimeDeficitMs += Math.round(transferMs - segment.durationSec! * 1000);
      }
      if (realtimeRatio !== null) {
        hls.worstRealtimeRatio = Math.max(hls.worstRealtimeRatio ?? 0, realtimeRatio);
      }
    } else {
      hls.segmentsFailed += 1;
    }

    hls.segments.push({
      url: segment.url,
      durationSec: segment.durationSec,
      bytes: segmentBytes,
      transferMs: Math.round(transferMs),
      ttfbMs: segmentTtfb !== null ? Math.round(segmentTtfb) : null,
      mbps,
      realtimeRatio,
      ok,
      error: response.error || (!ok && response.statusCode ? `HTTP ${response.statusCode}` : null),
    });

    // Bucket the completed segment into the throughput timeline.
    if (ok) {
      const bucketStart = Math.round(segmentStart - sampleStartedAt);
      throughput.push({
        atMs: bucketStart,
        bytes: segmentBytes,
        mbps: round((segmentBytes * 8) / transferMs / 1000, 3),
      });
    }
    void transferStartAt;
    void lastAt;

    if (context.signal?.aborted) break;
  }

  const windowMs = Math.max(nowMs() - sampleStartedAt, 1);
  const aggregated = finalizeThroughput(throughput, totalBytes, Math.round(windowMs), 0);

  // Required bitrate: prefer the declared variant bandwidth. When the manifest
  // declares nothing, derive it from the media itself — segment size divided by
  // segment duration is exactly what a player must sustain to keep up in real
  // time (transfer speed says nothing about the stream's own bitrate).
  let requiredMbps = variantRequiredMbps;
  let requiredSource = variantRequiredSource;
  if (requiredMbps === null && totalBytes > 0) {
    const totalDurationSec = hls.segments
      .filter((segment) => segment.ok && segment.durationSec && segment.durationSec > 0)
      .reduce((sum, segment) => sum + (segment.durationSec as number), 0);
    if (totalDurationSec > 0) {
      requiredMbps = round((totalBytes * 8) / totalDurationSec / 1_000_000, 3);
      requiredSource = "segment-mean";
    }
  }

  result.sustainedMbps = aggregated.sustainedMbps;
  result.peakMbps = aggregated.peakMbps;
  result.minSampleMbps = aggregated.minSampleMbps;
  result.throughputCoefficientOfVariation = aggregated.cv;
  result.throughputSamples = aggregated.samples;
  result.bytesRead = totalBytes;
  result.sampleWindowMs = Math.round(windowMs);
  result.requiredMbps = requiredMbps;
  result.requiredMbpsSource = requiredSource;
  result.hls = hls;
  result.retryCount += segmentRetries;
  if (segmentRetries > 0) {
    result.notes.push(`${segmentRetries} segment request(s) needed a retry after a transient failure`);
  }

  // Segment-arrival gap (stall proxy) — the probe fetches back-to-back, so a
  // gap here means the server/CDN stalled, not that playback was paused.
  let maxGap = 0;
  for (let i = 1; i < hls.segments.length; i += 1) {
    const gap = hls.segments[i].ttfbMs ?? 0;
    if (gap > maxGap) maxGap = gap;
  }
  result.maxGapMs = maxGap > 0 ? maxGap : null;

  if (hls.segmentsOk === 0) {
    result.status = "unplayable";
    result.errors.push("Every sampled HLS segment failed to download");
  } else if (totalBytes < MIN_MEDIA_BYTES_HLS) {
    result.warnings.push(
      `Only ${Math.round(totalBytes / 1024)} KB of media downloaded — below the ${Math.round(
        MIN_MEDIA_BYTES_HLS / 1024
      )} KB liveness threshold`
    );
  }

  if (hls.drm) {
    result.warnings.push(`DRM detected (${hls.drm}) — this channel needs a licensed player`);
  }
  if (hls.discontinuityCount > 0) {
    result.notes.push(
      `${hls.discontinuityCount} EXT-X-DISCONTINUITY marker(s) in the current window (ad splicing or re-mux)`
    );
  }
  if (parsed.hasEndlist) {
    result.notes.push("Playlist ends with #EXT-X-ENDLIST — this is a VOD/event item, not a 24/7 live channel");
  }
  if (hls.worstRealtimeRatio !== null && hls.worstRealtimeRatio > 1) {
    result.warnings.push(
      `Slowest segment took ${hls.worstRealtimeRatio.toFixed(2)}× its own duration to download — this connection cannot keep up with real-time playback`
    );
  }

  return result;
}

// ============================================================================
// SCORING — speed, quality, stability and an explainable overall verdict
// ============================================================================
//
// Weighting is documented on purpose (IPTVChecker publishes 0.25/0.40/0.35 for
// ping/content/quality). For a found MAC the question is "will this actually
// play smoothly?", so stability and speed outweigh resolution:
//
//   overall = 0.40 × stability + 0.35 × speed + 0.25 × quality
//
// Sub-scores are 0–10, and every score carries the evidence used to produce it.
// ============================================================================

export type StreamVerdict = "excellent" | "good" | "fair" | "poor" | "unusable" | "unknown";

export interface StreamScore {
  overall: number | null;
  speed: number | null;
  quality: number | null;
  stability: number | null;
  verdict: StreamVerdict;
  label: string;
  evidence: string[];
  penalties: string[];
  /** True when the optional ffmpeg pass saw a sustained frozen/black picture. */
  frozen?: boolean;
}

/** Optional evidence from the ffmpeg picture pack and the label check. */
export interface StreamScoreExtras {
  picture?: {
    analyzed: boolean;
    frozenDetected: boolean;
    blackDetected: boolean;
    frozenDurationSec: number;
    blackDurationSec: number;
    fps: number | null;
    videoBitrateMbps: number | null;
  } | null;
  labelMismatch?: string | null;
}

function scaleScore(value: number, worst: number, best: number): number {
  if (best === worst) return 5;
  const ratio = (value - worst) / (best - worst);
  return clamp(ratio * 10, 0, 10);
}

function roundScore(value: number | null): number | null {
  return value === null ? null : round(value, 1);
}

function codecScore(codec: string | null): number {
  if (!codec) return 0.5;
  const lower = codec.toLowerCase();
  if (lower.includes("hevc") || lower.includes("h.265") || lower.includes("h265")) return 1.0;
  if (lower.includes("av1")) return 1.0;
  if (lower.includes("h.264") || lower.includes("h264") || lower.includes("avc")) return 0.85;
  if (lower.includes("mpeg-4") || lower.includes("vp9")) return 0.7;
  if (lower.includes("mpeg-2") || lower.includes("mpeg-1")) return 0.5;
  return 0.6;
}

function heightOf(result: StreamProbeResult): number | null {
  if (result.resolution?.height) return result.resolution.height;
  if (result.hls?.variantLadder) {
    const best = pickBestVariant(result.hls.variantLadder);
    if (best?.height) return best.height;
  }
  return null;
}

export function scoreStreamProbe(result: StreamProbeResult, extras: StreamScoreExtras = {}): StreamScore {
  const evidence: string[] = [];
  const penalties: string[] = [];

  const hasPlaylistEvidence = (result.hls?.segments.length ?? 0) > 0;
  if (
    result.status === "unsupported_scheme" ||
    result.status === "network_error" ||
    (result.bytesRead === 0 && !hasPlaylistEvidence)
  ) {
    const reason =
      result.errors[0] ||
      (result.status === "unsupported_scheme"
        ? "Non-HTTP stream (RTSP/RTMP/UDP) cannot be measured by this probe"
        : "No media data was measured");
    return {
      overall: null,
      speed: null,
      quality: null,
      stability: null,
      verdict: "unknown",
      label: "Not measurable",
      evidence: [reason],
      penalties: [],
    };
  }

  // ── Speed ─────────────────────────────────────────────────────────────────
  let speed: number | null = null;
  if (result.sustainedMbps !== null && result.requiredMbps !== null && result.requiredMbps > 0) {
    const margin = result.sustainedMbps / result.requiredMbps;
    speed = scaleScore(margin, 0.9, 3.0);
    evidence.push(
      `Sustained ${result.sustainedMbps.toFixed(2)} Mbps vs ${result.requiredMbps.toFixed(2)} Mbps needed ` +
        `(${margin.toFixed(2)}× headroom)` +
        (result.requiredMbpsSource === "segment-mean"
          ? " — required bitrate derived from segment size/duration because the manifest declares no bandwidth"
          : "")
    );
    if (margin < 1.0) {
      penalties.push("Measured throughput is below the stream's own required bitrate");
    } else if (margin < 1.3) {
      penalties.push("Headroom under 1.3× — normal jitter or a busy hour can cause stalls");
    }
  } else if (result.sustainedMbps !== null) {
    // No declared requirement (raw TS): the server paces the stream at real
    // time, so only the delivered rate and its consistency can be judged.
    const height = heightOf(result);
    const expected = height && height >= 2160 ? 12 : height && height >= 1080 ? 5 : height && height >= 720 ? 2.5 : 1.5;
    const ratio = result.sustainedMbps / expected;
    speed = scaleScore(ratio, 0.6, 2.0);
    evidence.push(
      `Delivered ${result.sustainedMbps.toFixed(2)} Mbps end-to-end (server-paced live stream — headroom is not measurable from here; ` +
        `${height ? `${height}p tier` : "unknown resolution"} expects ≈${expected} Mbps)`
    );
  }

  // ── Quality ───────────────────────────────────────────────────────────────
  const height = heightOf(result);
  const videoBitrate = result.ts?.videoBitrateMbps ?? result.requiredMbps;
  let quality: number | null = null;

  if (height !== null) {
    const heightScore =
      height >= 2160 ? 1.0 : height >= 1080 ? 0.95 : height >= 720 ? 0.75 : height >= 480 ? 0.5 : 0.35;
    const codec = codecScore(result.videoCodec);
    let bitrateScore = 0.6;
    if (videoBitrate !== null) {
      const adequate = height >= 2160 ? 12 : height >= 1080 ? 4 : height >= 720 ? 2 : 1;
      bitrateScore = clamp(videoBitrate / (adequate * 1.25), 0.1, 1);
      evidence.push(
        `Video ≈${videoBitrate.toFixed(2)} Mbps at ${result.resolution?.label ?? `${height}p`} ` +
          `(${result.videoCodec ?? "codec unknown"})`
      );
    }
    quality = round((heightScore * 0.5 + codec * 0.3 + bitrateScore * 0.2) * 10, 1);
    if (!result.videoCodec) penalties.push("Codec not declared in the manifest/PMT, so compatibility is unverified");
  } else if (result.videoCodec || videoBitrate !== null) {
    // Raw TS: no manifest, so resolution is unknown without decoding. Score
    // what is known — codec and delivered video bitrate — and say so.
    const codec = codecScore(result.videoCodec);
    const bitrateScore = videoBitrate !== null ? scaleScore(videoBitrate, 0.4, 6) / 10 : 0.5;
    quality = round((bitrateScore * 0.7 + codec * 0.3) * 10, 1);
    evidence.push(
      `No manifest metadata: codec ${result.videoCodec ?? "unknown"} with ≈${
        videoBitrate !== null ? `${videoBitrate.toFixed(2)} Mbps` : "unknown"
      } video bitrate (resolution requires decoding and is not claimed)`
    );
  } else {
    evidence.push("No resolution/codec/bitrate metadata was exposed by the stream");
  }

  // ── Stability ─────────────────────────────────────────────────────────────
  const stabilityParts: number[] = [];
  const stabilityWeights: number[] = [];

  if (result.throughputCoefficientOfVariation !== null) {
    const cv = result.throughputCoefficientOfVariation;
    stabilityParts.push(scaleScore(cv, 1.2, 0.05));
    stabilityWeights.push(0.45);
    evidence.push(`Throughput variation (CV) ${cv.toFixed(3)}`);
    if (cv > 0.5) penalties.push("Throughput swings widely between samples — expect buffering during congestion");
  }

  if (result.hls) {
    const { segmentsOk, segmentsFailed, realtimeDeficitMs, worstRealtimeRatio, segments } = result.hls;
    if (segmentsOk + segmentsFailed > 0) {
      const failureRatio = segmentsFailed / (segmentsOk + segmentsFailed);
      stabilityParts.push(scaleScore(1 - failureRatio, 0.5, 0));
      stabilityWeights.push(0.25);
      evidence.push(`HLS segments sampled ${segmentsOk} ok / ${segmentsFailed} failed`);
      if (segmentsFailed > 0) penalties.push(`${segmentsFailed} HLS segment(s) failed to download`);
    }
    if (realtimeDeficitMs > 0) {
      stabilityParts.push(scaleScore(realtimeDeficitMs, 6000, 0));
      stabilityWeights.push(0.3);
      if (worstRealtimeRatio !== null && worstRealtimeRatio > 1) {
        penalties.push(
          `Cumulative real-time deficit ${realtimeDeficitMs} ms — the buffer would drain during this window`
        );
      }
    } else if (segments.length > 0) {
      stabilityParts.push(10);
      stabilityWeights.push(0.3);
    }
    if (result.hls.drm) {
      penalties.push(`Encrypted with ${result.hls.drm} — will not play in a standard player`);
    }
  }

  if (result.ts) {
    const { continuityErrorsPer1000, scrambledPackets, packets, syncLosses, pids } = result.ts;
    stabilityParts.push(scaleScore(continuityErrorsPer1000, 8, 0));
    stabilityWeights.push(0.35);
    evidence.push(
      `MPEG-TS continuity errors ${continuityErrorsPer1000.toFixed(2)}/1000 packets ` +
        `(${pids.length} PIDs, ${packets} packets)`
    );
    if (continuityErrorsPer1000 > 1) {
      penalties.push("Transport-stream continuity errors indicate packet loss or a broken re-mux path");
    }
    if (syncLosses > 3) penalties.push(`${syncLosses} transport-stream sync losses observed`);
    if (scrambledPackets > 0) {
      const ratio = packets > 0 ? scrambledPackets / packets : 0;
      stabilityParts.push(scaleScore(ratio, 0.5, 0));
      stabilityWeights.push(0.2);
    }
  }

  if (result.hls === null && result.ts === null && result.throughputSamples.length > 0) {
    // Generic direct stream: judge sample spread only.
    const values = result.throughputSamples.map((sample) => sample.mbps).filter((value) => value > 0);
    if (values.length > 2) {
      const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
      const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;
      stabilityParts.push(scaleScore(Math.sqrt(variance) / (mean || 1), 1.0, 0.1));
      stabilityWeights.push(0.6);
    }
  }

  let stability: number | null =
    stabilityWeights.length > 0
      ? round(
          stabilityParts.reduce((sum, part, index) => sum + part * stabilityWeights[index], 0) /
            stabilityWeights.reduce((sum, weight) => sum + weight, 0),
          1
        )
      : null;

  if (result.status === "timeout") {
    stability = 0;
    penalties.push("The probe timed out — the stream did not deliver data reliably");
  }
  if (result.status === "unplayable" || result.status === "http_error") {
    stability = stability === null ? 0 : Math.min(stability, 1);
  }

  // ── ffmpeg picture evidence (optional pack) ──────────────────────────────
  let frozen = false;
  if (extras.picture?.analyzed) {
    const picture = extras.picture;
    if (picture.fps !== null) evidence.push(`Decoded ${picture.fps.toFixed(1)} fps over ${picture.frozenDurationSec >= 0 ? "" : ""}the sample`);
    if (picture.videoBitrateMbps !== null) {
      evidence.push(`ffmpeg decoded ≈${picture.videoBitrateMbps.toFixed(2)} Mbps average video bitrate`);
    }
    if (picture.frozenDetected) {
      frozen = true;
      stability = stability === null ? 1 : Math.min(stability, 1.5);
      quality = quality === null ? 4 : Math.min(quality, 5);
      penalties.push(
        `Freeze detected: the picture did not change for ${picture.frozenDurationSec.toFixed(1)}s of the sample — looks like a still image with audio`
      );
    }
    if (picture.blackDetected) {
      stability = stability === null ? 2 : Math.min(stability, 2.5);
      penalties.push(`Black frames for ${picture.blackDurationSec.toFixed(1)}s of the sample`);
    }
  }

  // ── Channel-label sanity ─────────────────────────────────────────────────
  if (extras.labelMismatch) {
    quality = quality === null ? 5 : Math.min(quality, 6);
    penalties.push(extras.labelMismatch);
  }

  const scored = [
    { value: stability, weight: 0.4 },
    { value: speed, weight: 0.35 },
    { value: quality, weight: 0.25 },
  ].filter((entry) => entry.value !== null) as Array<{ value: number; weight: number }>;

  const overall =
    scored.length > 0
      ? round(scored.reduce((sum, entry) => sum + entry.value * entry.weight, 0) / scored.reduce((sum, entry) => sum + entry.weight, 0), 1)
      : null;

  const verdict: StreamVerdict =
    result.status === "unplayable" || result.status === "http_error"
      ? "unusable"
      : overall === null
        ? "unknown"
        : overall >= 8.5
          ? "excellent"
          : overall >= 7
            ? "good"
            : overall >= 5
              ? "fair"
              : overall >= 3
                ? "poor"
                : "unusable";

  const labels: Record<StreamVerdict, string> = {
    excellent: "Excellent — high bitrate with large headroom",
    good: "Good — should play smoothly",
    fair: "Fair — playable, with some risk under load",
    poor: "Poor — expect stalls or low quality",
    unusable: "Unusable — cannot be watched as measured",
    unknown: "Not measurable",
  };

  return {
    overall: roundScore(overall),
    speed: roundScore(speed),
    quality: roundScore(quality),
    stability: roundScore(stability),
    verdict,
    label: labels[verdict],
    evidence,
    penalties,
    frozen,
  };
}
