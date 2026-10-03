/**
 * ============================================================================
 * Proxy support — HTTP CONNECT tunnelling + a small proxy validator
 * ============================================================================
 *
 * WHY
 * ---
 * MacAttack measures streams from one vantage point (the NAS / Pi). That is
 * enough to find accounts, but not enough to tell "the provider is broken"
 * apart from "our route to that CDN is broken", and it cannot confirm a
 * geoblock. Probing the same stream through a proxy in another country answers
 * both questions.
 *
 * WHAT
 * ----
 *  • parseProxy()          — "host:port", "user:pass@host:port", with or
 *                            without a scheme.
 *  • openProxyTunnel()     — HTTP CONNECT tunnel (works for http and https
 *                            targets; for https the caller layers TLS on top).
 *  • validateProxies()     — bounded-parallel check of a proxy list against a
 *                            tiny known URL, reporting ms and failures.
 *
 * No dependencies: node:net / node:tls / node:http only.
 * ============================================================================
 */

import http from "node:http";
import net from "node:net";
import tls from "node:tls";
import { performance } from "node:perf_hooks";
import { pMapLimit } from "@/lib/parallel";

export interface ProxyConfig {
  host: string;
  port: number;
  username: string | null;
  password: string | null;
  /** Reconstructed proxy URL (password masked for logs by redactProxy()). */
  raw: string;
}

/** Parse one proxy line. Returns null when the line cannot be a proxy. */
export function parseProxy(value: string): ProxyConfig | null {
  const raw = value.trim();
  if (!raw) return null;

  let rest = raw.replace(/^[a-z0-9+.-]+:\/\//i, "");
  let username: string | null = null;
  let password: string | null = null;

  const at = rest.lastIndexOf("@");
  if (at > 0) {
    const credentials = rest.slice(0, at);
    rest = rest.slice(at + 1);
    const colon = credentials.indexOf(":");
    if (colon === -1) username = credentials;
    else {
      username = credentials.slice(0, colon);
      password = credentials.slice(colon + 1);
    }
  }

  const [hostPart, portPart] = rest.split(":");
  const host = (hostPart || "").trim();
  const port = Number((portPart || "8080").trim());
  if (!host || !/^[A-Za-z0-9.\-_]+$/.test(host)) return null;
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;

  return { host, port, username, password, raw };
}

export function parseProxyList(raw: string | null | undefined): ProxyConfig[] {
  if (!raw) return [];
  const seen = new Set<string>();
  const out: ProxyConfig[] = [];
  for (const line of raw.split(/\r?\n|,/)) {
    const proxy = parseProxy(line);
    if (!proxy) continue;
    const key = `${proxy.host}:${proxy.port}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(proxy);
  }
  return out.slice(0, 50);
}

export function redactProxy(proxy: ProxyConfig): string {
  return `${proxy.host}:${proxy.port}${proxy.username ? " (auth)" : ""}`;
}

function proxyAuthHeader(proxy: ProxyConfig): Record<string, string> {
  if (!proxy.username) return {};
  const token = Buffer.from(`${proxy.username}:${proxy.password ?? ""}`).toString("base64");
  return { "Proxy-Authorization": `Basic ${token}` };
}

export interface ProxyTunnel {
  socket: net.Socket;
  close: () => void;
}

/**
 * Open an HTTP CONNECT tunnel through the proxy to `targetHost:targetPort`.
 * The returned socket carries raw bytes to the target (TLS is layered by the
 * caller for https targets).
 */
export function openProxyTunnel(
  proxy: ProxyConfig,
  targetHost: string,
  targetPort: number,
  timeoutMs = 8000
): Promise<ProxyTunnel> {
  return new Promise((resolve, reject) => {
    const request = http.request({
      host: proxy.host,
      port: proxy.port,
      method: "CONNECT",
      path: `${targetHost}:${targetPort}`,
      headers: {
        Host: `${targetHost}:${targetPort}`,
        ...proxyAuthHeader(proxy),
      },
      timeout: timeoutMs,
      agent: false,
    });

    let settled = false;
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      request.destroy();
      reject(error);
    };

    request.on("connect", (response, socket) => {
      if (settled) {
        socket.destroy();
        return;
      }
      if (response.statusCode !== 200) {
        socket.destroy();
        fail(new Error(`Proxy CONNECT rejected with HTTP ${response.statusCode}`));
        return;
      }
      settled = true;
      // A late socket error (idle timeout, peer reset) must never crash the
      // process: the request using this tunnel reports its own errors, and a
      // destroyed tunnel simply ends the request. Destroy without an Error so
      // nothing is emitted as unhandled.
      socket.setTimeout(timeoutMs, () => socket.destroy());
      socket.on("error", () => undefined);
      resolve({ socket, close: () => socket.destroy() });
    });

    request.on("timeout", () => fail(new Error(`Proxy ${redactProxy(proxy)} timed out`)));
    request.on("error", (error: Error) => fail(new Error(`Proxy ${redactProxy(proxy)}: ${error.message}`)));
    request.end();
  });
}

/** Layer TLS on a tunnel socket for https targets. */
export function tlsOverTunnel(tunnel: ProxyTunnel, servername: string): tls.TLSSocket {
  return tls.connect({
    socket: tunnel.socket,
    servername,
    ALPNProtocols: ["http/1.1"],
  });
}

// ============================================================================
// PROXY VALIDATION
// ============================================================================

export interface ProxyCheckResult {
  proxy: string;
  ok: boolean;
  latencyMs: number | null;
  statusCode: number | null;
  error: string | null;
}

/**
 * Validate proxies by requesting a tiny, cache-friendly endpoint through each
 * one (default: the Cloudflare trace endpoint, which returns immediately).
 */
export async function validateProxies(
  proxies: ProxyConfig[],
  options: { targetUrl?: string; timeoutMs?: number; concurrency?: number } = {}
): Promise<ProxyCheckResult[]> {
  const targetUrl = options.targetUrl || "http://cp.cloudflare.com/generate_204";
  const timeoutMs = options.timeoutMs ?? 6000;
  const concurrency = options.concurrency ?? Math.min(5, Math.max(1, proxies.length));

  const results = await pMapLimit(proxies, concurrency, async (proxy) => {
    const started = performance.now();
    const result = await requestThroughProxy(proxy, targetUrl, timeoutMs);
    return {
      proxy: redactProxy(proxy),
      ok: result.ok,
      latencyMs: result.ok ? Math.round(performance.now() - started) : null,
      statusCode: result.statusCode,
      error: result.error,
    } satisfies ProxyCheckResult;
  });

  return results.filter((result): result is ProxyCheckResult => !!result);
}

async function requestThroughProxy(
  proxy: ProxyConfig,
  targetUrl: string,
  timeoutMs: number
): Promise<{ ok: boolean; statusCode: number | null; error: string | null }> {
  let target: URL;
  try {
    target = new URL(targetUrl);
  } catch {
    return { ok: false, statusCode: null, error: "Invalid target URL" };
  }

  const isTls = target.protocol === "https:";
  const port = Number(target.port || (isTls ? 443 : 80));

  let tunnel: ProxyTunnel;
  try {
    tunnel = await openProxyTunnel(proxy, target.hostname, port, timeoutMs);
  } catch (error) {
    return { ok: false, statusCode: null, error: error instanceof Error ? error.message : "Proxy failed" };
  }

  try {
    return await new Promise((resolve) => {
      const socket = isTls ? tlsOverTunnel(tunnel, target.hostname) : tunnel.socket;
      let settled = false;
      const finish = (value: { ok: boolean; statusCode: number | null; error: string | null }) => {
        if (settled) return;
        settled = true;
        tunnel.close();
        resolve(value);
      };

      const request = (isTls ? httpsRequest : httpRequest)(socket, target, timeoutMs, finish);
      if (!request) finish({ ok: false, statusCode: null, error: "Could not build the proxied request" });
    });
  } catch (error) {
    tunnel.close();
    return { ok: false, statusCode: null, error: error instanceof Error ? error.message : "Proxy request failed" };
  }
}

type ProxyRequestDone = (value: { ok: boolean; statusCode: number | null; error: string | null }) => void;

function httpRequest(
  socket: net.Socket,
  target: URL,
  timeoutMs: number,
  done: ProxyRequestDone
): boolean {
  const request = http.request(
    {
      createConnection: () => socket,
      host: target.hostname,
      port: Number(target.port || 80),
      path: `${target.pathname}${target.search}`,
      method: "GET",
      headers: { Host: target.host, "User-Agent": "MacAttack-proxy-check", Connection: "close" },
      timeout: timeoutMs,
      agent: false,
    },
    (response) => {
      response.resume();
      response.on("end", () =>
        done({ ok: (response.statusCode ?? 0) > 0, statusCode: response.statusCode ?? null, error: null })
      );
    }
  );
  request.on("timeout", () => {
    request.destroy();
    done({ ok: false, statusCode: null, error: "timeout" });
  });
  request.on("error", (error: Error) => done({ ok: false, statusCode: null, error: error.message }));
  request.end();
  return true;
}

function httpsRequest(
  socket: net.Socket,
  target: URL,
  timeoutMs: number,
  done: ProxyRequestDone
): boolean {
  const request = httpsModuleRequest(
    {
      createConnection: () => socket,
      host: target.hostname,
      port: Number(target.port || 443),
      path: `${target.pathname}${target.search}`,
      method: "GET",
      headers: { Host: target.host, "User-Agent": "MacAttack-proxy-check", Connection: "close" },
      timeout: timeoutMs,
      agent: false,
      servername: target.hostname,
    },
    (response) => {
      response.resume();
      response.on("end", () =>
        done({ ok: (response.statusCode ?? 0) > 0, statusCode: response.statusCode ?? null, error: null })
      );
    }
  );
  request.on("timeout", () => {
    request.destroy();
    done({ ok: false, statusCode: null, error: "timeout" });
  });
  request.on("error", (error: Error) => done({ ok: false, statusCode: null, error: error.message }));
  request.end();
  return true;
}

// Imported lazily to keep the http-only path free of tls side effects.
import https from "node:https";
const httpsModuleRequest = https.request;
