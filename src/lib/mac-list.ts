/**
 * Bulk MAC list parsing (Flux-Stream / mcbash style).
 *
 * Accepts what people actually paste: one MAC per line, comma/space separated,
 * with or without the 00:1A:79 prefix, sometimes with a trailing comment or a
 * `portal|mac` pair from scanner output (kiddac's "convert scanner output to
 * clean lines" idea — the portal part is ignored here because the job already
 * has one; pairs for other portals are reported so nothing is silently lost).
 */

export interface ParsedMacList {
  macs: string[];
  /** Entries that encoded a different portal (e.g. "http://host:port/c/|00:11:22:…"). */
  foreignPortalEntries: Array<{ portal: string; mac: string }>;
  invalid: string[];
}

const MAC_PATTERN = /([0-9A-Fa-f]{2}(?:[:-][0-9A-Fa-f]{2}){5})/;

export function normalizeMac(value: string): string | null {
  const match = MAC_PATTERN.exec(value);
  if (!match) return null;
  return match[1].replace(/-/g, ":").toUpperCase();
}

/** Parse a free-form MAC list into unique, normalised addresses. */
export function parseMacList(raw: string | null | undefined, maxEntries = 5000): ParsedMacList {
  const macs: string[] = [];
  const foreignPortalEntries: Array<{ portal: string; mac: string }> = [];
  const invalid: string[] = [];
  const seen = new Set<string>();
  if (!raw) return { macs, foreignPortalEntries, invalid };

  const lines = raw.split(/\r?\n/);
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || line.startsWith("//")) continue;

    // Strip trailing comments ("00:1A:79:11:22:33  # shop box").
    const withoutComment = line.split(/\s+#/)[0];

    // "portal|mac" or "mac|portal" pairs from scanner dumps.
    const parts = withoutComment.split("|").map((part) => part.trim()).filter(Boolean);
    if (parts.length === 2) {
      const macPart = parts.find((part) => MAC_PATTERN.test(part)) || null;
      const portalPart = parts.find((part) => /https?:\/\//i.test(part)) || null;
      if (macPart && portalPart) {
        foreignPortalEntries.push({ portal: portalPart, mac: normalizeMac(macPart) || macPart });
        continue;
      }
    }

    // Multiple MACs on one line (comma or whitespace separated).
    const candidates = withoutComment.split(/[\s,;]+/).filter(Boolean);
    for (const candidate of candidates) {
      const normalized = normalizeMac(candidate);
      if (!normalized) {
        if (candidate.length > 2) invalid.push(candidate.slice(0, 40));
        continue;
      }
      if (seen.has(normalized)) continue;
      seen.add(normalized);
      macs.push(normalized);
      if (macs.length >= maxEntries) {
        return { macs, foreignPortalEntries, invalid };
      }
    }
  }

  return { macs, foreignPortalEntries, invalid };
}
