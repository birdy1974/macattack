/**
 * ============================================================================
 * Stalker Stream Client — turn a validated MAC into playable stream URLs
 * ============================================================================
 *
 * The scanner already proves a MAC can read `account_info`. To judge what the
 * account can actually *watch*, we need the portal's channel list and a
 * resolved stream URL per channel:
 *
 *   1. handshake                     → session token
 *   2. get_all_channels               → full channel items (with `cmd`)
 *      fallback: get_genres + get_ordered_list per genre
 *   3. create_link (per channel)      → the real http(s) stream URL
 *
 * This mirrors kristofferR/IPTVChecker's Stalker support (handshake → channel
 * fetch → create_link, preferring an already-playable `cmd` and only calling
 * create_link when the portal marks the link as temporary/load-balanced) and
 * Flux-Stream's Stalker→M3U conversion.
 *
 * Everything is dependency-free (node:http / node:https) and honours the
 * scanner's AbortSignal so a stopped scan stops probing immediately.
 * ============================================================================
 */

import http from "node:http";
import https from "node:https";
import { STB_USER_AGENT } from "@/lib/stream-probe";

export interface StalkerClientOptions {
  /** e.g. http://host:port/server/load.php (or .../portal.php) */
  serverPath: string;
  /** e.g. http://host:port/c/ */
  portalBase: string;
  mac: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface StalkerChannel {
  id: string | null;
  name: string;
  genreId: string | null;
  logo: string | null;
  /** Raw `cmd` value as returned by the portal (may be a URL or a portal path). */
  cmd: string | null;
}

export interface StalkerStreamLink {
  channel: StalkerChannel;
  url: string | null;
  error: string | null;
}

const DEFAULT_TIMEOUT_MS = 8000;
const STB_REQUEST_TIMEZONE = process.env.STALKER_TIMEZONE || "Europe/Amsterdam";

// ============================================================================
// LOW-LEVEL REQUEST
// ============================================================================

function isHttpUrl(value: string): boolean {
  return /^https?:\/\//i.test(value.trim());
}

function buildUrl(serverPath: string, params: Record<string, string>): string {
  const url = new URL(serverPath);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  return url.toString();
}

interface StalkerResponse {
  ok: boolean;
  statusCode: number | null;
  payload: unknown;
  error: string | null;
}

/**
 * One portal API call. The response envelope is either `{ js: … }` or the bare
 * object; both are unwrapped.
 */
async function stalkerRequest(
  options: StalkerClientOptions,
  params: Record<string, string>
): Promise<StalkerResponse> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const url = buildUrl(options.serverPath, { ...params, JsHttpRequest: "1-xml" });
  const transport = url.toLowerCase().startsWith("https:") ? https : http;

  return new Promise((resolve) => {
    if (options.signal?.aborted) {
      resolve({ ok: false, statusCode: null, payload: null, error: "Aborted" });
      return;
    }

    let settled = false;
    const finish = (response: StalkerResponse) => {
      if (settled) return;
      settled = true;
      resolve(response);
    };

    let request: http.ClientRequest;
    try {
      request = transport.get(
        url,
        {
          headers: {
            "User-Agent": STB_USER_AGENT,
            "X-User-Agent": "Model: MAG250; Link: WiFi",
            Accept: "*/*",
            "Accept-Encoding": "identity",
            Cookie: `mac=${options.mac}; stb_lang=en; timezone=${STB_REQUEST_TIMEZONE}`,
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
            let parsed: unknown = null;
            try {
              parsed = JSON.parse(body);
            } catch {
              finish({
                ok: false,
                statusCode: status,
                payload: null,
                error: `Non-JSON response (${body.slice(0, 80).replace(/\s+/g, " ")})`,
              });
              return;
            }
            const envelope = parsed as { js?: unknown };
            finish({ ok: true, statusCode: status, payload: envelope.js ?? parsed, error: null });
          });
          response.on("error", (error: Error) =>
            finish({ ok: false, statusCode: null, payload: null, error: error.message })
          );
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

    request.setTimeout(timeoutMs, () => {
      request.destroy(new Error(`Timeout after ${timeoutMs}ms`));
    });
    request.on("error", (error: Error) =>
      finish({
        ok: false,
        statusCode: null,
        payload: null,
        error: error.message === "Timeout" ? `Timeout after ${timeoutMs}ms` : error.message,
      })
    );
    options.signal?.addEventListener("abort", () => request.destroy(new Error("Aborted")), { once: true });
  });
}

// ============================================================================
// HANDSHAKE
// ============================================================================

export interface HandshakeResult {
  token: string | null;
  error: string | null;
}

export async function stalkerHandshake(options: StalkerClientOptions): Promise<HandshakeResult> {
  const response = await stalkerRequest(options, { type: "stb", action: "handshake" });
  if (!response.ok) return { token: null, error: response.error };

  const payload = response.payload as { token?: string } | null;
  const token = payload?.token;
  if (!token) return { token: null, error: "Handshake returned no token" };
  return { token, error: null };
}

// ============================================================================
// CHANNEL LISTING
// ============================================================================

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function pickString(record: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number") return String(value);
  }
  return null;
}

/** Some portals wrap channel lists in `data`, others return the array directly. */
function extractChannelItems(payload: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(payload)) return payload.filter((item): item is Record<string, unknown> => !!asRecord(item));
  const record = asRecord(payload);
  if (!record) return [];
  for (const key of ["data", "results", "items", "channels"]) {
    const value = record[key];
    if (Array.isArray(value)) {
      return value.filter((item): item is Record<string, unknown> => !!asRecord(item));
    }
  }
  return [];
}

function toChannel(item: Record<string, unknown>): StalkerChannel {
  return {
    id: pickString(item, ["id", "channel_id", "ch_id"]) ,
    name: pickString(item, ["name", "title", "tv_name"]) || "(unnamed channel)",
    genreId: pickString(item, ["tv_genre_id", "genre_id", "genre"]),
    logo: pickString(item, ["logo", "tv_logo", "icon"]),
    cmd: pickString(item, ["cmd", "stream_url", "url"]),
  };
}

export interface ChannelListResult {
  channels: StalkerChannel[];
  source: "get_all_channels" | "ordered_list" | "none";
  error: string | null;
}

/**
 * Fetch the channel list. `get_all_channels` is one call but many newer
 * portals disable it, so we fall back to one page per genre.
 */
export async function stalkerListChannels(
  options: StalkerClientOptions,
  token: string,
  limits: { maxChannels?: number; maxGenres?: number } = {}
): Promise<ChannelListResult> {
  const maxChannels = limits.maxChannels ?? 600;
  const maxGenres = limits.maxGenres ?? 12;

  const all = await stalkerRequest(options, { type: "itv", action: "get_all_channels", token });
  if (all.ok) {
    const items = extractChannelItems(all.payload);
    if (items.length > 0) {
      return {
        channels: items.slice(0, maxChannels).map(toChannel),
        source: "get_all_channels",
        error: null,
      };
    }
  }

  // Fallback: genre list → one ordered page per genre.
  const genresResponse = await stalkerRequest(options, { type: "itv", action: "get_genres", token });
  if (!genresResponse.ok) {
    return {
      channels: [],
      source: "none",
      error: genresResponse.error || all.error || "No channel list available",
    };
  }

  const genreItems = extractChannelItems(genresResponse.payload);
  const channels: StalkerChannel[] = [];
  const seen = new Set<string>();

  for (const genre of genreItems.slice(0, maxGenres)) {
    if (options.signal?.aborted) break;
    if (channels.length >= maxChannels) break;
    const genreId = pickString(genre, ["id", "genre_id", "tv_genre_id"]);
    if (!genreId) continue;

    const page = await stalkerRequest(options, {
      type: "itv",
      action: "get_ordered_list",
      genre: genreId,
      p: "1",
      sortby: "number",
      token,
    });
    if (!page.ok) continue;

    for (const item of extractChannelItems(page.payload)) {
      const channel = toChannel(item);
      const key = channel.id || `${channel.name}|${channel.genreId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      channels.push(channel);
      if (channels.length >= maxChannels) break;
    }
  }

  return {
    channels,
    source: channels.length > 0 ? "ordered_list" : "none",
    error: channels.length > 0 ? null : "No channels returned by get_all_channels or get_ordered_list",
  };
}

// ============================================================================
// STREAM LINK RESOLUTION (create_link)
// ============================================================================

/** A cmd is directly playable when it already contains an http(s) URL. */
export function extractStreamUrl(cmd: string | null): string | null {
  if (!cmd) return null;
  const match = /(https?:\/\/[^\s"'<>]+)/i.exec(cmd);
  if (!match) return null;
  const url = match[1].trim();
  if (!isHttpUrl(url)) return null;
  try {
    const parsed = new URL(url);
    // Portals sometimes return placeholder "localhost" links for unassigned
    // channels (IPTVChecker filters these too). MACATTACK_ALLOW_LOCAL_STREAMS=1
    // is only for the offline fixture tests.
    const allowLocal = process.env.MACATTACK_ALLOW_LOCAL_STREAMS === "1";
    if (!allowLocal && ["localhost", "127.0.0.1", "0.0.0.0"].includes(parsed.hostname)) return null;
    if (parsed.pathname.replace(/\/+$/, "").endsWith("_")) return null;
    return url;
  } catch {
    return null;
  }
}

function portalRequiresLink(item: Record<string, unknown>): boolean {
  for (const key of ["use_http_tmp_link", "use_load_balancing", "force_ch_link_check"]) {
    const value = item[key];
    if (value === true) return true;
    if (typeof value === "number" && value !== 0) return true;
    if (typeof value === "string" && value !== "" && value !== "0") return true;
  }
  return false;
}

/**
 * Resolve one channel's playable URL. Mirrors IPTVChecker: use the direct
 * `cmd` URL when it is already playable and the portal does not demand a
 * temporary link; otherwise call `create_link`.
 */
export async function stalkerResolveStream(
  options: StalkerClientOptions,
  token: string,
  channel: StalkerChannel,
  rawItem?: Record<string, unknown>
): Promise<StalkerStreamLink> {
  const direct = extractStreamUrl(channel.cmd);
  const requiresLink = rawItem ? portalRequiresLink(rawItem) : false;

  if (direct && !requiresLink) {
    return { channel, url: direct, error: null };
  }
  if (!channel.cmd) {
    return { channel, url: direct, error: "Channel has no cmd/stream field" };
  }

  const response = await stalkerRequest(options, {
    type: "itv",
    action: "create_link",
    cmd: channel.cmd,
    series: "",
    forced_storage: "",
    disable_ad: "",
    download: "",
    token,
  });

  if (!response.ok) {
    return {
      channel,
      url: direct,
      error: response.error || "create_link failed",
    };
  }

  const payload = asRecord(response.payload);
  const resolved =
    pickString(payload ?? {}, ["cmd", "url", "link", "stream_url"]) ||
    null;
  const url = extractStreamUrl(resolved) ?? direct;

  return {
    channel,
    url,
    error: url ? null : "create_link returned no playable URL",
  };
}

// ============================================================================
// CHANNEL SELECTION FOR PROBING
// ============================================================================

/**
 * Pick a deterministic-but-spread selection of channels to probe: one per
 * genre first (so a broken single genre cannot dominate the verdict), then
 * fill up in list order.
 */
export function selectChannelsForProbe(channels: StalkerChannel[], count: number): StalkerChannel[] {
  if (count <= 0 || channels.length === 0) return [];

  const byGenre = new Map<string, StalkerChannel[]>();
  for (const channel of channels) {
    const key = channel.genreId || "unknown";
    const list = byGenre.get(key) ?? [];
    list.push(channel);
    byGenre.set(key, list);
  }

  const selected: StalkerChannel[] = [];
  const used = new Set<string>();
  const add = (channel: StalkerChannel) => {
    const key = channel.id || `${channel.name}|${channel.genreId}`;
    if (used.has(key)) return;
    used.add(key);
    selected.push(channel);
  };

  for (const list of byGenre.values()) {
    if (selected.length >= count) break;
    add(list[0]);
  }
  for (const channel of channels) {
    if (selected.length >= count) break;
    add(channel);
  }
  return selected.slice(0, count);
}

// ============================================================================
// M3U EXPORT (Flux-Stream's Stalker→M3U feature, server side)
// ============================================================================

export function buildM3U(
  links: Array<{ channel: StalkerChannel; url: string }>,
  playlistName: string
): string {
  const lines = ["#EXTM3U"];
  for (const { channel, url } of links) {
    const attributes = [
      channel.logo ? `tvg-logo="${channel.logo.replace(/"/g, "")}"` : null,
      channel.genreId ? `group-title="Genre ${channel.genreId}"` : null,
    ]
      .filter(Boolean)
      .join(" ");
    lines.push(`#EXTINF:-1 ${attributes},${channel.name}`.replace(/\s+$/g, ""));
    lines.push(url);
  }
  lines.push(`# Playlist: ${playlistName} · exported by MacAttack ${new Date().toISOString()}`);
  return `${lines.join("\n")}\n`;
}

/** Hide any session token embedded in a stream URL before it is stored/logged. */
export function redactStreamUrl(url: string | null): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    const path = parsed.pathname.length > 60 ? `${parsed.pathname.slice(0, 60)}…` : parsed.pathname;
    return `${parsed.protocol}//${parsed.host}${path}`;
  } catch {
    return url.length > 80 ? `${url.slice(0, 80)}…` : url;
  }
}

export { STB_USER_AGENT };
