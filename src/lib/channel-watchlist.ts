/**
 * ============================================================================
 * Channel watch list — fuzzy name matching for the stream-quality probe
 * ============================================================================
 *
 * Lets the user name the channels that must be measured (e.g. "NPO 1",
 * "RTL 4", "ZIGGO") instead of the automatic genre spread. Portals name the
 * same channel differently ("NL: NPO 1 HD", "NPO1", "RTL4 FHD", "Ziggo"), so
 * matching is done on a normalised form and falls back in tiers:
 *
 *   1. exact    — same name after normalisation ("NPO 1" == "NPO1 HD")
 *   2. word     — every word of the query appears as a whole word in the
 *                 channel name ("ZIGGO" → "ZIGGO SPORT 1", only when no exact
 *                 name exists)
 *   3. fuzzy    — best Levenshtein similarity ≥ 0.8 on the compact form
 *                 ("Zigo" → "ZIGGO")
 *
 * The first tier that yields anything wins, so "ZIGGO" never drags in the
 * sport channels when a plain "ZIGGO" channel exists. Every channel that
 * shares the winning name is returned — duplicates are measured, not dropped.
 * ============================================================================
 */

export const MAX_WATCHLIST_ENTRIES = 20;
const MAX_WATCHLIST_ENTRY_LENGTH = 60;
const FUZZY_THRESHOLD = 0.8;

export type WatchMatchTier = "exact" | "word" | "fuzzy" | "none";

export interface WatchableChannel {
  name: string;
  id?: string | null;
  genreId?: string | null;
}

export interface WatchMatch<T extends WatchableChannel> {
  query: string;
  tier: WatchMatchTier;
  channels: T[];
}

/** Split a free-text watch list (comma, semicolon or newline separated). */
export function parseWatchlist(text: string | string[] | null | undefined): string[] {
  const raw = Array.isArray(text) ? text : (text ?? "").split(/[,;\n]/);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const entry of raw) {
    const cleaned = entry.trim().slice(0, MAX_WATCHLIST_ENTRY_LENGTH);
    if (!cleaned) continue;
    const key = cleaned.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(cleaned);
    if (out.length >= MAX_WATCHLIST_ENTRIES) break;
  }
  return out;
}

/** Lower-case, strip accents, drop country prefixes and quality tags. */
export function normalizeChannelName(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[[(][^\])]*[\])]/g, " ") // [HD], (Backup) …
    .replace(/^\s*[a-z]{2,3}\s*[:|-]\s*/, "") // "NL: ", "BE | ", "DE - "
    .replace(/\b(uhd|fhd|hd|sd|4k|8k|hevc|h265|h264|raw|hq|lq|1080p|720p|576p|480p|50fps|60fps)\b/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function compact(normalized: string): string {
  return normalized.replace(/ /g, "");
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + cost);
    }
    previous = current;
  }
  return previous[b.length];
}

function similarity(a: string, b: string): number {
  const longest = Math.max(a.length, b.length);
  if (longest === 0) return 1;
  return 1 - levenshtein(a, b) / longest;
}

/** Match one watch-list query against the channel list, most specific tier first. */
export function matchWatchQuery<T extends WatchableChannel>(query: string, channels: T[]): WatchMatch<T> {
  const normalizedQuery = normalizeChannelName(query);
  const compactQuery = compact(normalizedQuery);
  const queryWords = normalizedQuery.split(" ").filter(Boolean);
  const entries = channels.map((channel) => {
    const normalized = normalizeChannelName(channel.name);
    return { channel, normalized, compact: compact(normalized), words: new Set(normalized.split(" ")) };
  });

  if (compactQuery.length > 0) {
    const exact = entries.filter((entry) => entry.compact === compactQuery).map((entry) => entry.channel);
    if (exact.length > 0) return { query, tier: "exact", channels: exact };

    const word = entries
      .filter((entry) => queryWords.length > 0 && queryWords.every((word) => entry.words.has(word)))
      .map((entry) => entry.channel);
    if (word.length > 0) return { query, tier: "word", channels: word };

    let best = 0;
    for (const entry of entries) {
      best = Math.max(best, similarity(compactQuery, entry.compact));
    }
    if (best >= FUZZY_THRESHOLD) {
      const fuzzy = entries
        .filter((entry) => similarity(compactQuery, entry.compact) === best)
        .map((entry) => entry.channel);
      return { query, tier: "fuzzy", channels: fuzzy };
    }
  }

  return { query, tier: "none", channels: [] };
}

/**
 * Resolve every watch-list query. Returns the channels to probe (each tagged
 * with the query that selected it, de-duplicated across queries) and the
 * per-query match report used for the scan log and the stored report.
 */
export function selectWatchlistChannels<T extends WatchableChannel>(
  channels: T[],
  queries: string[]
): { selected: Array<{ channel: T; query: string }>; matches: WatchMatch<T>[] } {
  const matches = queries.map((query) => matchWatchQuery(query, channels));
  const selected: Array<{ channel: T; query: string }> = [];
  // De-duplicate by object identity only: two channels that share a name are
  // distinct entries in the portal and both must be measured.
  const used = new Set<T>();
  for (const match of matches) {
    for (const channel of match.channels) {
      if (used.has(channel)) continue;
      used.add(channel);
      selected.push({ channel, query: match.query });
    }
  }
  return { selected, matches };
}
