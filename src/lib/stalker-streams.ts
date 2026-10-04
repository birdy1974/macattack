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
import { buildUserAgentCandidates } from "@/lib/user-agents";
import { type ProxyConfig, openProxyTunnel, tlsOverTunnel } from "@/lib/proxy";
import { onAbort } from "@/lib/abort";

export interface StalkerClientOptions {
  /** e.g. http://host:port/server/load.php (or .../portal.php) */
  serverPath: string;
  /** e.g. http://host:port/c/ */
  portalBase: string;
  mac: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** User agent actually used for every request (set by the handshake rotation). */
  userAgent?: string | null;
  /** Ordered UA candidates tried by the handshake when rotation is enabled. */
  userAgentCandidates?: string[] | null;
  /** Optional HTTP CONNECT proxy for the portal API calls. */
  proxy?: ProxyConfig | null;
  /** Stable per-portal serial number sent with requests (fingerprinting). */
  serialNumber?: string | null;
}

export interface StalkerChannel {
  id: string | null;
  name: string;
  genreId: string | null;
  logo: string | null;
  /** Raw `cmd` value as returned by the portal (may be a URL or a portal path). */
  cmd: string | null;
  /** Portal says catch-up/archive is available for this channel. */
  tvArchive: boolean;
  /** Archive depth in days as advertised by the portal (0 = unknown/none). */
  tvArchiveDays: number | null;
  /** Raw item kept so create_link can consult flags like use_http_tmp_link. */
  raw?: Record<string, unknown>;
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
  const url = buildUrl(options.serverPath, {
    ...params,
    JsHttpRequest: "1-xml",
    ...(options.serialNumber ? { sn: options.serialNumber } : {}),
  });
  const isTls = url.toLowerCase().startsWith("https:");
  const transport = isTls ? https : http;
  const userAgent = options.userAgent || STB_USER_AGENT;

  // Optional proxy: pre-open the CONNECT tunnel (DNS happens at the proxy).
  let tunneledSocket: import("node:net").Socket | null = null;
  if (options.proxy) {
    try {
      const target = new URL(url);
      const tunnel = await openProxyTunnel(
        options.proxy,
        target.hostname,
        Number(target.port || (isTls ? 443 : 80)),
        timeoutMs
      );
      tunneledSocket = isTls ? tlsOverTunnel(tunnel, target.hostname) : tunnel.socket;
      if (isTls) {
        await new Promise<void>((resolve, reject) => {
          const secure = tunneledSocket as import("node:tls").TLSSocket;
          secure.once("secureConnect", () => resolve());
          secure.once("error", (error: Error) => reject(error));
        });
      }
    } catch (error) {
      return {
        ok: false,
        statusCode: null,
        payload: null,
        error: error instanceof Error ? error.message : "Proxy tunnel failed",
      };
    }
  }

  return new Promise((resolve) => {
    if (options.signal?.aborted) {
      resolve({ ok: false, statusCode: null, payload: null, error: "Aborted" });
      return;
    }

    let settled = false;
    const finish = (response: StalkerResponse) => {
      if (settled) return;
      settled = true;
      // Detach from the (long-lived, per-scan) signal: one listener per request
      // would otherwise pile up for the whole scan.
      detachAbort?.();
      resolve(response);
    };

    let request: http.ClientRequest;
    let detachAbort: (() => void) | null = null;
    try {
      request = transport.get(
        url,
        {
          ...(tunneledSocket
            ? { agent: false, createConnection: () => tunneledSocket as import("node:net").Socket }
            : {}),
          headers: {
            "User-Agent": userAgent,
            "X-User-Agent": options.userAgent?.includes("MAG")
              ? "Model: MAG250; Link: WiFi"
              : "Model: MAG254; Link: Ethernet",
            Accept: "*/*",
            "Accept-Encoding": "identity",
            ...(options.serialNumber ? { SN: options.serialNumber, "X-Serial-Number": options.serialNumber } : {}),
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
    detachAbort = onAbort(options.signal, () => request.destroy(new Error("Aborted")));
  });
}

// ============================================================================
// HANDSHAKE
// ============================================================================

export interface HandshakeResult {
  token: string | null;
  error: string | null;
  /** User agent that worked (persist it per portal host — UA rotation). */
  userAgent: string | null;
  /** How many UA candidates were tried before one worked. */
  attempts: number;
}

export async function stalkerHandshake(options: StalkerClientOptions): Promise<HandshakeResult> {
  const candidates = options.userAgentCandidates?.length
    ? options.userAgentCandidates
    : buildUserAgentCandidates(options.userAgent ?? null, null);

  const errors: string[] = [];
  for (let index = 0; index < candidates.length; index += 1) {
    const candidate = candidates[index];
    const response = await stalkerRequest({ ...options, userAgent: candidate }, { type: "stb", action: "handshake" });
    if (response.ok) {
      const payload = response.payload as { token?: string } | null;
      if (payload?.token) {
        return { token: payload.token, error: null, userAgent: candidate, attempts: index + 1 };
      }
      errors.push(`UA ${index + 1}: handshake returned no token`);
      continue;
    }
    errors.push(`UA ${index + 1}: ${response.error}`);
    // An explicit "aborted" must not trigger more attempts.
    if (options.signal?.aborted) break;
  }

  return {
    token: null,
    error: errors.length > 0 ? errors.join(" · ") : "Handshake failed",
    userAgent: null,
    attempts: candidates.length,
  };
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

function pickBoolean(record: Record<string, unknown>, keys: string[]): boolean {
  for (const key of keys) {
    const value = record[key];
    if (value === true) return true;
    if (typeof value === "number") return value !== 0;
    if (typeof value === "string") return value !== "" && value !== "0" && value.toLowerCase() !== "false";
  }
  return false;
}

function toChannel(item: Record<string, unknown>): StalkerChannel {
  const archiveDaysRaw = pickString(item, ["tv_archive_duration", "archive_duration"]);
  const archiveDays = archiveDaysRaw !== null && Number.isFinite(Number(archiveDaysRaw)) ? Number(archiveDaysRaw) : null;
  return {
    id: pickString(item, ["id", "channel_id", "ch_id"]),
    name: pickString(item, ["name", "title", "tv_name"]) || "(unnamed channel)",
    genreId: pickString(item, ["tv_genre_id", "genre_id", "genre"]),
    logo: pickString(item, ["logo", "tv_logo", "icon"]),
    cmd: pickString(item, ["cmd", "stream_url", "url"]),
    tvArchive: pickBoolean(item, ["tv_archive", "tv_archive_available"]),
    tvArchiveDays: archiveDays,
    raw: item,
  };
}

export interface ChannelListResult {
  channels: StalkerChannel[];
  source: "get_all_channels" | "ordered_list" | "none";
  error: string | null;
  /** genreId → title, when the portal exposes genre names. */
  genreTitles: Record<string, string>;
}

/** Fetch genre titles (used for grouping and for the genre filter UI). */
export async function stalkerGenreTitles(
  options: StalkerClientOptions,
  token: string,
  type: "itv" | "vod" | "series" = "itv"
): Promise<Record<string, string>> {
  const response = await stalkerRequest(options, { type, action: "get_genres", token });
  if (!response.ok) return {};
  const titles: Record<string, string> = {};
  for (const item of extractChannelItems(response.payload)) {
    const id = pickString(item, ["id", "genre_id", "tv_genre_id"]);
    const title = pickString(item, ["title", "name"]);
    if (id && title) titles[id] = title;
  }
  return titles;
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
        genreTitles: await stalkerGenreTitles(options, token, "itv"),
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
      genreTitles: {},
    };
  }

  const genreItems = extractChannelItems(genresResponse.payload);
  const genreTitles: Record<string, string> = {};
  for (const genre of genreItems) {
    const id = pickString(genre, ["id", "genre_id", "tv_genre_id"]);
    const title = pickString(genre, ["title", "name"]);
    if (id && title) genreTitles[id] = title;
  }
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
    genreTitles,
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
// SERIAL NUMBER FINGERPRINT
// ============================================================================

/**
 * Stable per-(MAC, portal host) serial number. Portals that share middleware
 * behind several hostnames report the same device signature, which is how two
 * "different" portals can be recognised as one system (kiddac's S/N idea).
 */
export function computeSerialNumber(mac: string, serverPath: string): string {
  const host = (() => {
    try {
      return new URL(serverPath).hostname.toLowerCase();
    } catch {
      return serverPath.toLowerCase();
    }
  })();
  let hash = 0x811c9dc5;
  const input = `${mac.toUpperCase()}|${host}`;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  const base = hash.toString(16).toUpperCase().padStart(8, "0");
  const macPart = mac.replace(/[^0-9A-Fa-f]/g, "").toUpperCase().slice(-6).padStart(6, "0");
  return `${base}${macPart}0`.slice(0, 13);
}

// ============================================================================
// CATCH-UP / ARCHIVE (IPTVChecker's "verify catch-up actually works")
// ============================================================================

export interface CatchUpProbe {
  channel: StalkerChannel;
  advertisedDays: number | null;
  /** URL for the requested archive window (may be identical to the live URL). */
  url: string | null;
  /** True when the portal returned a link that is clearly different from live. */
  linkResolved: boolean;
  error: string | null;
}

function formatArchiveTime(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return (
    `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ` +
    `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}`
  );
}

/**
 * Ask the portal for an archive (catch-up) link for a channel.
 * `minutesAgo` selects the window: 60 = the last hour, larger values probe how
 * far back the archive really goes.
 */
export async function stalkerResolveArchiveLink(
  options: StalkerClientOptions,
  token: string,
  channel: StalkerChannel,
  minutesAgo: number
): Promise<CatchUpProbe> {
  const advertisedDays = channel.tvArchiveDays ?? null;
  if (!channel.cmd) {
    return { channel, advertisedDays, url: null, linkResolved: false, error: "Channel has no cmd" };
  }

  const end = new Date(Date.now() - Math.max(1, minutesAgo) * 60 * 1000);
  const start = new Date(end.getTime() - 30 * 60 * 1000);

  const response = await stalkerRequest(options, {
    type: "itv",
    action: "create_link",
    cmd: channel.cmd,
    series: "",
    forced_storage: "",
    disable_ad: "1",
    download: "0",
    start: formatArchiveTime(start),
    end: formatArchiveTime(end),
    token,
  });

  if (!response.ok) {
    return { channel, advertisedDays, url: null, linkResolved: false, error: response.error || "create_link failed" };
  }

  const payload = asRecord(response.payload);
  const resolved = pickString(payload ?? {}, ["cmd", "url", "link", "stream_url"]) || null;
  const url = extractStreamUrl(resolved);
  const liveUrl = extractStreamUrl(channel.cmd);

  return {
    channel,
    advertisedDays,
    url,
    // A portal that "supports" catch-up but hands back the live URL is faking it.
    linkResolved: !!url && (!liveUrl || url !== liveUrl || /start=|utc=|archive/i.test(resolved ?? "")),
    error: url ? null : "No archive URL returned",
  };
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
