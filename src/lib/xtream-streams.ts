/**
 * ============================================================================
 * Xtream Codes client — dual-protocol portals
 * ============================================================================
 *
 * Many "stalker" portals also answer the Xtream Codes API (`player_api.php`),
 * which authenticates with username/password instead of a MAC. Supporting it
 * widens the set of portals MacAttack can measure, and the measurement itself
 * is identical because the stream probe is protocol-agnostic.
 *
 * Accepted user input (either form):
 *   http://host:8080/player_api.php?username=U&password=P
 *   http://host:8080/get.php?username=U&password=P&type=m3u_plus&output=ts
 *
 * No dependencies: node:http / node:https only.
 * ============================================================================
 */

import http from "node:http";
import https from "node:https";
import { onAbort } from "@/lib/abort";

export interface XtreamCredentials {
  /** Scheme + host + port, no trailing slash (e.g. http://host:8080). */
  base: string;
  username: string;
  password: string;
  /** API endpoint form, for display. */
  endpoint: "player_api" | "get";
}

export interface XtreamAccountInfo {
  status: string | null
  isTrial: boolean | null;
  activeConnections: string | null;
  maxConnections: string | null;
  expiryDate: string | null;
  createdAt: string | null;
  auth: boolean | null;
  raw: Record<string, unknown> | null;
}

export interface XtreamStream {
  id: string;
  name: string;
  categoryId: string | null;
  logo: string | null;
  tvArchive: boolean;
  tvArchiveDays: number | null;
  raw: Record<string, unknown>;
}

export interface XtreamCategory {
  id: string;
  name: string;
}

// ============================================================================
// URL PARSING / BUILDING
// ============================================================================

/** Recognise an Xtream URL and extract credentials. */
export function parseXtreamUrl(value: string): XtreamCredentials | null {
  const trimmed = (value || "").trim();
  if (!/player_api\.php|get\.php|panel_api\.php/i.test(trimmed)) return null;

  let url: URL;
  try {
    const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
    url = new URL(withScheme);
  } catch {
    return null;
  }

  const username = url.searchParams.get("username");
  const password = url.searchParams.get("password");
  if (!username || !password) return null;

  return {
    base: `${url.protocol}//${url.host}`,
    username,
    password,
    endpoint: /get\.php/i.test(url.pathname) ? "get" : "player_api",
  };
}

export function isXtreamUrl(value: string): boolean {
  return parseXtreamUrl(value) !== null;
}

export function xtreamApiUrl(
  credentials: XtreamCredentials,
  params: Record<string, string> = {}
): string {
  const url = new URL(`${credentials.base}/player_api.php`);
  url.searchParams.set("username", credentials.username);
  url.searchParams.set("password", credentials.password);
  for (const [key, val] of Object.entries(params)) url.searchParams.set(key, val);
  return url.toString();
}

/** Direct stream URL for one live stream id. */
export function xtreamStreamUrl(
  credentials: XtreamCredentials,
  streamId: string,
  extension: "ts" | "m3u8" = "ts"
): string {
  return `${credentials.base}/live/${encodeURIComponent(credentials.username)}/${encodeURIComponent(
    credentials.password
  )}/${encodeURIComponent(streamId)}.${extension}`;
}

/** M3U playlist URL suitable for a TV player (token-free, standard Xtream form). */
export function xtreamPlaylistUrl(
  credentials: XtreamCredentials,
  type: "m3u" | "m3u_plus" = "m3u_plus",
  output: "ts" | "m3u8" = "ts"
): string {
  return `${credentials.base}/get.php?username=${encodeURIComponent(credentials.username)}&password=${encodeURIComponent(
    credentials.password
  )}&type=${type}&output=${output}`;
}

// ============================================================================
// REQUESTS
// ============================================================================

async function xtreamRequest(
  url: string,
  options: { timeoutMs?: number; signal?: AbortSignal } = {}
): Promise<{ ok: boolean; statusCode: number | null; payload: unknown; error: string | null }> {
  const timeoutMs = options.timeoutMs ?? 8000;
  const isTls = url.toLowerCase().startsWith("https:");
  const transport = isTls ? https : http;

  return new Promise((resolve) => {
    if (options.signal?.aborted) {
      resolve({ ok: false, statusCode: null, payload: null, error: "Aborted" });
      return;
    }
    let settled = false;
    const finish = (value: { ok: boolean; statusCode: number | null; payload: unknown; error: string | null }) => {
      if (settled) return;
      settled = true;
      // Detach from the shared signal so requests cannot pile up listeners.
      detachAbort?.();
      resolve(value);
    };

    let request: http.ClientRequest;
    let detachAbort: (() => void) | null = null;
    try {
      request = transport.get(
        url,
        {
          headers: {
            "User-Agent": "VLC/3.0.20 LibVLC/3.0.20",
            Accept: "application/json, text/plain, */*",
            "Accept-Encoding": "identity",
          },
        },
        (response) => {
          const chunks: Buffer[] = [];
          response.on("data", (chunk: Buffer) => chunks.push(chunk));
          response.on("end", () => {
            const body = Buffer.concat(chunks).toString("utf8");
            const status = response.statusCode ?? null;
            if (status === null || status >= 400) {
              finish({ ok: false, statusCode: status, payload: null, error: `HTTP ${status}` });
              return;
            }
            try {
              finish({ ok: true, statusCode: status, payload: JSON.parse(body), error: null });
            } catch {
              finish({
                ok: false,
                statusCode: status,
                payload: null,
                error: `Non-JSON response (${body.slice(0, 80).replace(/\s+/g, " ")})`,
              });
            }
          });
          response.on("error", (error: Error) => finish({ ok: false, statusCode: null, payload: null, error: error.message }));
        }
      );
    } catch (error) {
      finish({
        ok: false,
        statusCode: null,
        payload: null,
        error: error instanceof Error ? error.message : "Request failed",
      });
      return;
    }

    request.setTimeout(timeoutMs, () => request.destroy(new Error(`Timeout after ${timeoutMs}ms`)));
    request.on("error", (error: Error) =>
      finish({
        ok: false,
        statusCode: null,
        payload: null,
        error: /Timeout/i.test(error.message) ? `Timeout after ${timeoutMs}ms` : error.message,
      })
    );
    detachAbort = onAbort(options.signal, () => request.destroy(new Error("Aborted")));
  });
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function pickString(record: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number") return String(value);
  }
  return null;
}

function truthy(value: unknown): boolean {
  if (value === true) return true;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") return value !== "" && value !== "0" && value.toLowerCase() !== "false";
  return false;
}

// ============================================================================
// API CALLS
// ============================================================================

/** Login/account check. `auth` false means the credentials were rejected. */
export async function xtreamAccount(
  credentials: XtreamCredentials,
  options: { timeoutMs?: number; signal?: AbortSignal } = {}
): Promise<{ auth: boolean; account: XtreamAccountInfo | null; serverInfo: Record<string, unknown> | null; error: string | null }> {
  const response = await xtreamRequest(xtreamApiUrl(credentials), options);
  if (!response.ok) return { auth: false, account: null, serverInfo: null, error: response.error };

  const payload = asRecord(response.payload);
  if (!payload) return { auth: false, account: null, serverInfo: null, error: "Unexpected API response" };

  const userInfo = asRecord(payload.user_info);
  const serverInfo = asRecord(payload.server_info);
  const authFlag = userInfo?.auth;
  const auth = authFlag === undefined ? true : truthy(authFlag) || String(authFlag) === "1";

  if (!userInfo) {
    return {
      auth: false,
      account: null,
      serverInfo,
      error: "No user_info in the API response — check the URL and credentials",
    };
  }

  return {
    auth,
    serverInfo,
    error: auth ? null : "Credentials rejected by the server",
    account: {
      status: pickString(userInfo, ["status"]),
      isTrial: typeof userInfo.is_trial === "string" || typeof userInfo.is_trial === "boolean" ? truthy(userInfo.is_trial) : null,
      activeConnections: pickString(userInfo, ["active_cons", "active_connections"]),
      maxConnections: pickString(userInfo, ["max_connections"]),
      expiryDate: pickString(userInfo, ["exp_date", "expiry"]),
      createdAt: pickString(userInfo, ["created_at"]),
      auth,
      raw: userInfo,
    },
  };
}

export async function xtreamCategories(
  credentials: XtreamCredentials,
  type: "live" | "vod" | "series" = "live",
  options: { timeoutMs?: number; signal?: AbortSignal } = {}
): Promise<XtreamCategory[]> {
  const response = await xtreamRequest(
    xtreamApiUrl(credentials, { action: `get_${type}_categories` }),
    options
  );
  if (!response.ok || !Array.isArray(response.payload)) return [];
  return (response.payload as unknown[])
    .map(asRecord)
    .filter((record): record is Record<string, unknown> => !!record)
    .map((record) => ({
      id: pickString(record, ["category_id", "id"]) ?? "",
      name: pickString(record, ["category_name", "name"]) ?? "",
    }))
    .filter((category) => category.id !== "");
}

export async function xtreamLiveStreams(
  credentials: XtreamCredentials,
  options: { timeoutMs?: number; signal?: AbortSignal; limit?: number } = {}
): Promise<XtreamStream[]> {
  const response = await xtreamRequest(xtreamApiUrl(credentials, { action: "get_live_streams" }), options);
  if (!response.ok || !Array.isArray(response.payload)) return [];
  const limit = options.limit ?? 500;
  return (response.payload as unknown[])
    .map(asRecord)
    .filter((record): record is Record<string, unknown> => !!record)
    .slice(0, limit)
    .map((record) => ({
      id: pickString(record, ["stream_id", "id"]) ?? "",
      name: pickString(record, ["name"]) ?? "(unnamed channel)",
      categoryId: pickString(record, ["category_id"]),
      logo: pickString(record, ["stream_icon", "logo"]),
      tvArchive: truthy(record.tv_archive),
      tvArchiveDays: (() => {
        const raw = pickString(record, ["tv_archive_duration"]);
        const value = raw === null ? NaN : Number(raw);
        return Number.isFinite(value) ? value : null;
      })(),
      raw: record,
    }))
    .filter((stream) => stream.id !== "");
}
