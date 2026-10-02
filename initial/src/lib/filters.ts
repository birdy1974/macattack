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
 * Parse a Stalker-format date string into a JS Date (end of day, to be
 * inclusive of the cutoff date).  Returns null when the string cannot be
 * parsed as a real date.
 */
export function parseStalkerDate(raw: unknown): Date | null {
  if (raw === null || raw === undefined) return null;
  const s = String(raw).trim();
  if (!s) return null;

  // Stalker "never expires" markers are handled by isUnlimitedDate, not here.
  if (/^0000-00-00/.test(s)) return null;

  // Try numeric (unix seconds or ms).
  if (/^\d{10,13}$/.test(s)) {
    const n = Number(s);
    const d = new Date(s.length === 13 ? n : n * 1000);
    return Number.isFinite(d.getTime()) ? d : null;
  }

  // YYYY-MM-DD or YYYY-MM-DD HH:MM:SS — treat as UTC-ish by replacing space with T.
  const iso = s.replace(" ", "T");
  const d = new Date(iso);
  return Number.isFinite(d.getTime()) ? d : null;
}

/**
 * Treat a Stalker expiry value as "unlimited / never expires" if:
 *   - it's null/empty/whitespace
 *   - it equals "0000-00-00" (with or without time)
 *   - it parses to a year >= 2099 (common operator sentinel)
 */
export function isUnlimitedDate(raw: unknown): boolean {
  if (raw === null || raw === undefined) return true;
  const s = String(raw).trim();
  if (!s) return true;
  if (/^0000-00-00/.test(s)) return true;
  const d = parseStalkerDate(s);
  if (d && d.getFullYear() >= 2099) return true;
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

  const pass = date.getTime() >= new Date(
    cutoff.getFullYear(),
    cutoff.getMonth(),
    cutoff.getDate()
  ).getTime(); // start-of-cutoff-day compare
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
