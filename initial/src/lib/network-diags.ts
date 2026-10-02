/**
 * ============================================================================
 * Network Diagnostics — TCP ping & HTTP timing waterfall
 * ============================================================================
 *
 * Provides two measurements for a Stalker portal URL:
 *
 *  1. tcpPing(host, port, options)
 *     Measures raw TCP-handshake round-trip time by opening and immediately
 *     destroying a TCP socket. This is the closest thing to ICMP ping that
 *     works without raw-socket privileges (i.e. works inside containers).
 *     Returns { min, avg, max, stdev, loss, probes, results } in milliseconds.
 *
 *  2. measureHttpRequest(url, options)
 *     Issues one HTTP(S) request to the given URL and produces a fine-grained
 *     timing breakdown using Node's socket events:
 *       - dnsMs     : DNS resolve time
 *       - tcpMs     : TCP connect time
 *       - tlsMs     : TLS handshake time (undefined for plain HTTP)
 *       - ttfbMs    : Time-to-first-byte (server processing + RTT)
 *       - totalMs   : Total wall-clock time for the request
 *       - statusCode: HTTP status code
 *
 * Uses Node's built-in http/https/net modules — zero external dependencies.
 * ============================================================================
 */

import http from "node:http";
import https from "node:https";
import net from "node:net";
import { lookup } from "node:dns/promises";

export interface TcpPingOptions {
  /** number of probes (default 5) */
  probes?: number;
  /** delay between probes in ms (default 200) */
  intervalMs?: number;
  /** per-probe connect timeout in ms (default 5000) */
  timeoutMs?: number;
}

export interface TcpPingResult {
  host: string;
  port: number;
  probes: number;
  successful: number;
  failed: number;
  lossPct: number;
  minMs: number | null;
  avgMs: number | null;
  maxMs: number | null;
  stdevMs: number | null;
  rtts: Array<number | null>;
}

export interface HttpTimingResult {
  url: string;
  dnsMs: number | null;
  tcpMs: number | null;
  tlsMs: number | null;
  ttfbMs: number | null;
  totalMs: number;
  statusCode: number | null;
  error?: string;
}

/**
 * Convert a high-resolution hrtime tuple into milliseconds.
 */
function hrTimeMs(start: [number, number]): number {
  const [sec, nsec] = process.hrtime(start);
  return sec * 1000 + nsec / 1_000_000;
}

/**
 * Perform a single TCP-connect probe and return the connect time in ms
 * (or null if it failed/timed out).
 */
function tcpProbe(host: string, port: number, timeoutMs: number): Promise<number | null> {
  return new Promise((resolve) => {
    const start = process.hrtime();
    const socket = new net.Socket();

    let settled = false;
    const finish = (value: number | null) => {
      if (settled) return;
      settled = true;
      try { socket.destroy(); } catch {
        // ignore
      }
      resolve(value);
    };

    socket.setTimeout(timeoutMs);
    socket.on("connect", () => {
      finish(hrTimeMs(start));
    });
    socket.on("timeout", () => finish(null));
    socket.on("error", () => finish(null));
    socket.connect(port, host);
  });
}

/**
 * TCP-ping a host:port. Returns aggregate statistics.
 */
export async function tcpPing(
  host: string,
  port: number,
  opts: TcpPingOptions = {}
): Promise<TcpPingResult> {
  const probes = Math.max(1, opts.probes ?? 5);
  const intervalMs = Math.max(0, opts.intervalMs ?? 200);
  const timeoutMs = Math.max(100, opts.timeoutMs ?? 5000);

  const rtts: Array<number | null> = [];
  for (let i = 0; i < probes; i++) {
    const rtt = await tcpProbe(host, port, timeoutMs);
    rtts.push(rtt);
    if (i < probes - 1 && intervalMs > 0) {
      await new Promise((r) => setTimeout(r, intervalMs));
    }
  }

  const successes = rtts.filter((r): r is number => r !== null);
  const failed = rtts.length - successes.length;
  const lossPct = (failed / rtts.length) * 100;

  let min: number | null = null;
  let max: number | null = null;
  let avg: number | null = null;
  let stdev: number | null = null;

  if (successes.length > 0) {
    min = Math.min(...successes);
    max = Math.max(...successes);
    const avgVal = successes.reduce((s, v) => s + v, 0) / successes.length;
    avg = avgVal;
    const variance =
      successes.reduce((s, v) => s + (v - avgVal) ** 2, 0) / successes.length;
    stdev = Math.sqrt(variance);
  }

  return {
    host,
    port,
    probes,
    successful: successes.length,
    failed,
    lossPct,
    minMs: min === null ? null : Number(min.toFixed(2)),
    avgMs: avg === null ? null : Number(avg.toFixed(2)),
    maxMs: max === null ? null : Number(max.toFixed(2)),
    stdevMs: stdev === null ? null : Number(stdev.toFixed(2)),
    rtts,
  };
}

/**
 * Perform a single HTTP(S) request and measure a detailed timing waterfall
 * via socket lifecycle events.
 *
 * We send a GET with a short payload-friendly set of headers (similar to
 * the scanner's STB headers) and abort once we receive the first byte of
 * the response headers — we don't care about the body for timing purposes.
 */
export function measureHttpRequest(
  url: string,
  opts: {
    timeoutMs?: number;
    headers?: Record<string, string>;
    method?: string;
  } = {}
): Promise<HttpTimingResult> {
  return new Promise((resolve) => {
    const timeoutMs = opts.timeoutMs ?? 10_000;
    const parsed = new URL(url);
    const isHttps = parsed.protocol === "https:";
    const lib = isHttps ? https : http;

    const timings: HttpTimingResult = {
      url,
      dnsMs: null,
      tcpMs: null,
      tlsMs: null,
      ttfbMs: null,
      totalMs: 0,
      statusCode: null,
    };

    const start = process.hrtime();
    let dnsAt: [number, number] | null = null;
    let tcpAt: [number, number] | null = null;
    let tlsAt: [number, number] | null = null;

    let settled = false;
    const finish = (error?: string) => {
      if (settled) return;
      settled = true;
      timings.totalMs = Number(hrTimeMs(start).toFixed(2));
      if (error) timings.error = error;
      try { req.destroy(); } catch {
        // ignore
      }
      resolve(timings);
    };

    const req = lib.request(
      {
        protocol: parsed.protocol,
        hostname: parsed.hostname,
        port: parsed.port || (isHttps ? 443 : 80),
        path: `${parsed.pathname}${parsed.search}`,
        method: opts.method ?? "GET",
        headers: {
          "User-Agent":
            "Mozilla/5.0 (QtEmbedded; U; Linux; C) AppleWebKit/533.3 (KHTML, like Gecko) MAG200 stbapp ver: 2 rev: 250 Safari/533.3",
          Accept: "*/*",
          Connection: "close",
          ...(opts.headers ?? {}),
        },
        timeout: timeoutMs,
      },
      (res) => {
        // We have response headers — that's our TTFB marker. We don't need
        // to read the body.
        timings.statusCode = res.statusCode ?? null;

        // Order matters for the calculation:
        //   total_start -> dns -> tcp -> (tls) -> ttfb
        const ttfbFrom = tlsAt ?? tcpAt ?? dnsAt ?? start;
        timings.ttfbMs = Number(hrTimeMs(ttfbFrom).toFixed(2));

        // Consume (and discard) a tiny bit of the response to let the
        // socket close cleanly.
        res.resume();
        res.on("end", () => finish());
        res.on("close", () => finish());
        // If we already have headers, close quickly.
        finish();
      }
    );

    req.on("socket", (socket: net.Socket) => {
      socket.on("lookup", () => {
        dnsAt = process.hrtime();
        // Phase duration: from start until DNS resolved.
        timings.dnsMs = Number(hrTimeMs(start).toFixed(2));
      });
      socket.on("connect", () => {
        tcpAt = process.hrtime();
        // Phase duration: from DNS done (or start) until TCP connected.
        const tcpFrom = dnsAt ?? start;
        timings.tcpMs = Number(hrTimeMs(tcpFrom).toFixed(2));
      });
      socket.on("secureConnect", () => {
        tlsAt = process.hrtime();
        // Phase duration: from TCP connect until TLS handshake complete.
        const tlsFrom = tcpAt ?? dnsAt ?? start;
        timings.tlsMs = Number(hrTimeMs(tlsFrom).toFixed(2));
      });
    });

    req.on("timeout", () => finish("Request timed out"));
    req.on("error", (err) => finish(err.message));

    req.end();
  });
}

/**
 * Parse a URL into { host, port }.  Useful for TCP-pinging a portal URL.
 * Respects the protocol (http=80, https=443) and an explicit port in the URL.
 */
export function parseHostPort(portalUrl: string): { host: string; port: number } {
  const parsed = new URL(portalUrl);
  const port = parsed.port
    ? parseInt(parsed.port, 10)
    : parsed.protocol === "https:"
    ? 443
    : 80;
  return { host: parsed.hostname, port };
}

/**
 * Helper: resolve a hostname to its IP address.  Returns null on failure.
 */
export async function resolveIp(host: string): Promise<string | null> {
  try {
    const res = await lookup(host);
    return res.address;
  } catch {
    return null;
  }
}
