/**
 * ============================================================================
 * Result Filters — Genre/Content filter & Expire-Date filter
 * ============================================================================
 *
 * Two post-validation filters decide whether a valid MAC gets saved:
 *
 *  1. Genre/content filter: if enabled, the MAC must expose at least one
 *     category (across live-TV genres, VOD categories, or series categories
 *     as selected) whose title fuzzy-matches ANY of the configured keywords.
 *
 *  2. Expire-date filter: if enabled, the account's expiry date must be on
 *     or after the chosen cutoff date. Accounts that Stalker flags as
 *     "unlimited" / "never expires" can be explicitly included or excluded.
 *
 * Matching strategy for genres (tokenized substring, accent-insensitive):
 *   - Category titles and keywords are lower-cased and accent-folded.
 *   - Titles are split into tokens (on spaces / punctuation).
 *   - A keyword of length >= 3 matches if it appears as a substring of any
 *     token or of the full title (e.g. "dutch" matches "dutch films" and
 *     "Nederlandse films" after accent folding — actually for "nederland"
 *     we match against the full title, not just tokens, so "ned" matches
 *     "Nederland 1 HD").
 *   - Short keywords (1-2 chars, e.g. "nl") only match if they equal a
 *     WHOLE token — prevents "nl" firing inside "channel" etc.
 * ============================================================================
 */

export interface GenreFilterConfig {
  enabled: boolean;
  /** Comma-separated raw keywords, e.g. "nl, dutch, nederland, ned" */
  keywords: string;
  matchLive: boolean;
  matchVod: boolean;
  matchSeries: boolean;
}

export interface ExpireFilterConfig {
  enabled: boolean;
  /** ISO date string YYYY-MM-DD; null/"" means no cutoff (only unlimited check applies) */
  minDate: string | null;
  includeUnlimited: boolean;
}

/**
 * Normalize a string for fuzzy matching: lowercase, strip diacritics,
 * collapse whitespace, remove most punctuation.
 */
export function normalize(str: string): string {
  if (!str) return "";
  return str
    .toString()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "") // strip combining diacritics
    .toLowerCase()
    .replace(/[_/\\|+]+/g, " ")
    .replace(/[^\p{L}\p{N}\s-]/gu, " ") // keep letters/numbers/space/hyphen
    .replace(/\s+/g, " ")
    .trim();
}

/** Tokenize a normalized string into words (split on spaces and hyphens). */
export function tokenize(normalized: string): string[] {
  if (!normalized) return [];
  return normalized.split(/[\s-]+/).filter(Boolean);
}

/** Parse a comma-separated keyword string into normalized tokens. */
export function parseKeywords(raw: string): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((k) => normalize(k))
    .filter(Boolean);
}

/**
 * Test whether a single category title matches any of the given keywords.
 * Uses the rules in the module header comment.
 */
export function titleMatches(
  rawTitle: string | null | undefined,
  keywords: string[]
): boolean {
  if (!rawTitle || keywords.length === 0) return false;
  const title = normalize(rawTitle);
  if (!title) return false;
  const tokens = tokenize(title);

  for (const kw of keywords) {
    if (!kw) continue;
    if (kw.length < 3) {
      // Short keyword must equal a whole token.
      if (tokens.includes(kw)) return true;
    } else {
      // Longer keyword: substring match against full title (catches partial
      // matches like "nederland" inside "nederlandse" and "ned" inside "nederland").
      if (title.includes(kw)) return true;
    }
  }
  return false;
}

/**
 * Check whether any category in any of the supplied lists matches the filter.
 * Each list is the raw array returned by fetchGenres / fetchSeries:
 *   Array<{ id: string; title: string }> | null
 */
export function genresPassFilter(
  cfg: GenreFilterConfig,
  liveGenres: Array<{ title: string }> | null,
  vodCategories: Array<{ title: string }> | null,
  seriesCategories: Array<{ title: string }> | null
): { pass: boolean; matchedTitle: string | null } {
  if (!cfg.enabled) return { pass: true, matchedTitle: null };

  const keywords = parseKeywords(cfg.keywords);
  if (keywords.length === 0) return { pass: true, matchedTitle: null };

  const lists: Array<Array<{ title: string }> | null> = [];
  if (cfg.matchLive) lists.push(liveGenres);
  if (cfg.matchVod) lists.push(vodCategories);
  if (cfg.matchSeries) lists.push(seriesCategories);

  for (const list of lists) {
    if (!list) continue;
    for (const entry of list) {
      if (titleMatches(entry?.title, keywords)) {
        return { pass: true, matchedTitle: entry.title || null };
      }
    }
  }
  return { pass: false, matchedTitle: null };
}

/**
 * Parse a Stalker-format date string into a JS Date. Returns null when the
 * string cannot be parsed as a real date.
 *
 * Supports the date formats Stalker/Ministra/Xtream-UI portals return in the
 * `phone` and expiry fields:
 *   - YYYY-MM-DD / YYYY-MM-DD HH:MM[:SS] (also / or . separators)
 *   - DD-MM-YYYY / DD.MM.YYYY / DD/MM/YYYY (and MM/DD/YYYY when day > 12)
 *   - Human-readable English strings (e.g. "March 15, 2027, 2:30 pm", "15 Mar 2027")
 *   - Unix timestamps in seconds (9–10 digits) or milliseconds (12–13 digits)
 */
export function parseStalkerDate(raw: unknown): Date | null {
  if (raw === null || raw === undefined || typeof raw === "boolean") return null;
  if (raw instanceof Date) {
    return Number.isFinite(raw.getTime()) ? raw : null;
  }
  const s = String(raw).trim();
  if (!s || s === "0" || s === "-1") return null;

  // Stalker "never expires" markers are handled by isUnlimitedDate, not here.
  if (
    /^0{2,4}[-./]0{1,2}[-./]0{1,4}(?:[T\s]+0{1,2}:0{1,2}(?::0{1,2}(?:\.\d+)?)?\s*(?:Z|[+-]\d{2}:?\d{2})?)?$/i.test(
      s
    )
  ) {
    return null;
  }

  // Try numeric (unix seconds or ms).
  if (/^\d{9,13}$/.test(s)) {
    const n = Number(s);
    const d = new Date(s.length >= 12 ? n : n * 1000);
    const y = d.getUTCFullYear();
    return Number.isFinite(d.getTime()) && y >= 1970 && y <= 2200 ? d : null;
  }

  // ISO timestamp with explicit timezone offset.
  if (
    /^\d{4}-\d{2}-\d{2}[T\s]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?\s*(?:Z|[+-]\d{2}:?\d{2})$/i.test(
      s
    )
  ) {
    const d = new Date(s.replace(/^(\d{4}-\d{2}-\d{2})\s+/, "$1T"));
    if (Number.isFinite(d.getTime()) && d.getUTCFullYear() >= 1970) return d;
  }

  // YYYY-MM-DD / YYYY/MM/DD / YYYY.MM.DD (optionally with time or surrounding text).
  const ymd =
    /(?:^|\b)(\d{4})[-./](\d{1,2})[-./](\d{1,2})(?:[T\s]+(\d{1,2}):(\d{2})(?::(\d{2}))?)?(?:\b|$)/.exec(
      s
    );
  if (ymd) {
    const year = Number(ymd[1]);
    const month = Number(ymd[2]);
    const day = Number(ymd[3]);
    const hour = ymd[4] ? Number(ymd[4]) : 0;
    const min = ymd[5] ? Number(ymd[5]) : 0;
    const sec = ymd[6] ? Number(ymd[6]) : 0;
    if (year >= 1970 && year <= 2200 && month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      const d = new Date(Date.UTC(year, month - 1, day, hour, min, sec));
      if (Number.isFinite(d.getTime())) return d;
    }
  }

  // DD-MM-YYYY / DD.MM.YYYY / DD/MM/YYYY (or MM/DD/YYYY when second number > 12).
  const dmy =
    /(?:^|\b)(\d{1,2})[-./](\d{1,2})[-./](\d{4})(?:[T\s]+(\d{1,2}):(\d{2})(?::(\d{2}))?)?(?:\b|$)/.exec(
      s
    );
  if (dmy) {
    const first = Number(dmy[1]);
    const second = Number(dmy[2]);
    const year = Number(dmy[3]);
    const hour = dmy[4] ? Number(dmy[4]) : 0;
    const min = dmy[5] ? Number(dmy[5]) : 0;
    const sec = dmy[6] ? Number(dmy[6]) : 0;
    const day = second > 12 && first <= 12 ? second : first;
    const month = second > 12 && first <= 12 ? first : second;
    if (year >= 1970 && year <= 2200 && month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      const d = new Date(Date.UTC(year, month - 1, day, hour, min, sec));
      if (Number.isFinite(d.getTime())) return d;
    }
  }

  const d = new Date(s);
  return Number.isFinite(d.getTime()) && d.getUTCFullYear() >= 1970 ? d : null;
}

/**
 * Treat a Stalker expiry value as "unlimited / never expires" if:
 *   - it's null/empty/whitespace
 *   - it equals "0000-00-00" (with or without time) or other zero-date
 *   - it contains an explicit unlimited marker ("Unlimited", "Never", "Lifetime")
 *   - it parses to a year >= 2099 (common operator sentinel)
 */
export function isUnlimitedDate(raw: unknown): boolean {
  if (raw === null || raw === undefined) return true;
  const s = String(raw).trim();
  if (!s || s === "0") return true;
  if (
    /^0{2,4}[-./]0{1,2}[-./]0{1,4}(?:[T\s]+0{1,2}:0{1,2}(?::0{1,2}(?:\.\d+)?)?\s*(?:Z|[+-]\d{2}:?\d{2})?)?$/i.test(
      s
    )
  ) {
    return true;
  }
  if (/\b(unlimited|never|lifetime|no\s*limit|infinite)\b|∞/i.test(s)) return true;
  const d = parseStalkerDate(s);
  if (d && d.getUTCFullYear() >= 2099) return true;
  return false;
}

/**
 * Convert a YYYY-MM-DD input to a Date representing the END of that day
 * (23:59:59.999 local time) so that an expiry equal to the cutoff still passes.
 */
export function parseCutoffDate(yyyyMmDd: string | null | undefined): Date | null {
  if (!yyyyMmDd) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(yyyyMmDd.trim());
  if (!m) return null;
  const [, y, mo, d] = m;
  const dt = new Date(
    Number(y),
    Number(mo) - 1,
    Number(d),
    23,
    59,
    59,
    999
  );
  return Number.isFinite(dt.getTime()) ? dt : null;
}

/**
 * Decide whether an expiry string passes the expire-date filter.
 *
 * Returns an object with:
 *   pass         : boolean (true means save the MAC)
 *   reason       : short human-readable reason for the decision (for logs)
 *   isUnlimited  : boolean
 *   effectiveDate: Date | null (parsed expiry when applicable)
 */
export function expiryPassesFilter(
  cfg: ExpireFilterConfig,
  rawExpiry: unknown
): { pass: boolean; reason: string; isUnlimited: boolean; effectiveDate: Date | null } {
  if (!cfg.enabled) {
    return { pass: true, reason: "expire filter disabled", isUnlimited: false, effectiveDate: null };
  }

  const unlimited = isUnlimitedDate(rawExpiry);
  if (unlimited) {
    return {
      pass: cfg.includeUnlimited,
      reason: cfg.includeUnlimited
        ? "unlimited subscription accepted"
        : "unlimited subscription rejected by filter",
      isUnlimited: true,
      effectiveDate: null,
    };
  }

  const date = parseStalkerDate(rawExpiry);
  if (!date) {
    // Unparseable date — when in doubt (and unlimited is off and no readable date),
    // reject so the filter doesn't accidentally pass garbage.
    return {
      pass: false,
      reason: `unrecognized expire date (${String(rawExpiry).slice(0, 32)})`,
      isUnlimited: false,
      effectiveDate: null,
    };
  }

  const cutoff = parseCutoffDate(cfg.minDate);
  if (!cutoff) {
    // No cutoff specified but unlimited already handled above → pass.
    return {
      pass: true,
      reason: "no cutoff date set",
      isUnlimited: false,
      effectiveDate: date,
    };
  }

  const cutoffStartMs = Date.UTC(
    cutoff.getFullYear(),
    cutoff.getMonth(),
    cutoff.getDate()
  );
  const pass = date.getTime() >= cutoffStartMs; // start-of-cutoff-day compare (UTC)
  return {
    pass,
    reason: pass
      ? `expires ${date.toISOString().slice(0, 10)} (≥ cutoff)`
      : `expires ${date.toISOString().slice(0, 10)} (before cutoff)`,
    isUnlimited: false,
    effectiveDate: date,
  };
}

/** Default keyword list used to pre-fill the UI when the user enables the filter. */
export const DEFAULT_GENRE_KEYWORDS = "nl, netherlands, dutch, ned, nederland";
