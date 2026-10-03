/**
 * Channel-label sanity check ("4K" channel that delivers 720p).
 *
 * Portals love marketing labels. This compares what the channel *claims*
 * (4K/UHD, FHD, HD, SD or explicit resolutions in its name) with what the
 * measured stream actually offers, so a mismatch can be flagged instead of
 * silently trusted.
 */

export interface MeasuredVideoFacts {
  /** Real variant height in pixels, when the manifest or PMT exposed one. */
  height: number | null;
  /** Measured video bitrate in Mbps, when reported. */
  videoBitrateMbps?: number | null;
}

export interface LabelClaim {
  kind: "4k" | "fhd" | "hd" | "sd" | "resolution";
  /** Claimed height in pixels (e.g. "1080p" → 1080). */
  height: number;
  label: string;
}

const CLAIM_PATTERNS: Array<{ regex: RegExp; claim: (match: RegExpMatchArray) => LabelClaim | null }> = [
  {
    regex: /\b(2160p?|4k|uhd)\b/i,
    claim: () => ({ kind: "4k", height: 2160, label: "4K/UHD" }),
  },
  {
    regex: /\b(1440p)\b/i,
    claim: () => ({ kind: "fhd", height: 1440, label: "1440p" }),
  },
  {
    // FHD before HD so "FHD" is not read as "HD".
    regex: /\b(fhd|1080[pi]?|full\s?hd)\b/i,
    claim: () => ({ kind: "fhd", height: 1080, label: "FHD/1080p" }),
  },
  {
    regex: /\b(720p)\b/i,
    claim: () => ({ kind: "hd", height: 720, label: "720p" }),
  },
  {
    regex: /\bhd\b/i,
    claim: () => ({ kind: "hd", height: 720, label: "HD" }),
  },
  {
    regex: /\b(480p|576p|sd)\b/i,
    claim: () => ({ kind: "sd", height: 576, label: "SD" }),
  },
];

/** Extract the strongest resolution claim from a channel name. */
export function parseLabelClaim(name: string | null | undefined): LabelClaim | null {
  if (!name) return null;
  const normalized = name.replace(/[_|]+/g, " ").trim();
  for (const { regex, claim } of CLAIM_PATTERNS) {
    const match = normalized.match(regex);
    if (match) return claim(match);
  }
  return null;
}

/**
 * Compare a claim with the measured facts.
 * Returns a human-readable description when they disagree, otherwise null.
 *
 * Tolerances: a claim is only flagged when the measured height is clearly
 * below it (allow one tier of slack so "HD" covers 720p and 1080p).
 */
export function detectLabelMismatch(
  channelName: string | null | undefined,
  facts: MeasuredVideoFacts
): string | null {
  const claim = parseLabelClaim(channelName);
  const height = facts.height;
  if (!claim) return null;

  // Without a measurable picture height, bitrate is the only available signal.
  // Thresholds are deliberately generous: this flags a stream that cannot
  // conceivably carry the claimed tier, not one that merely looks soft.
  if (!height || height <= 0) {
    const bitrate = facts.videoBitrateMbps;
    if (bitrate === null || bitrate === undefined || bitrate <= 0) return null;
    const minimumMbps: Record<LabelClaim["kind"], number | null> = {
      "4k": 8,
      fhd: 3,
      hd: 1.2,
      sd: null,
      resolution: null,
    };
    const floor = minimumMbps[claim.kind];
    if (floor !== null && bitrate < floor) {
      return `Label says ${claim.label} but the stream only carries ${bitrate.toFixed(2)} Mbps (expected ≥ ${floor} Mbps)`;
    }
    return null;
  }

  // "HD" is a loose label: it may legitimately mean 720p or 1080p.
  const isClearlyBelow = (() => {
    switch (claim.kind) {
      case "4k":
        return height < 1440;
      case "fhd":
        return height < 720;
      case "hd":
        return height < 576;
      case "sd":
        return false;
      case "resolution":
        return height + 1 < claim.height;
    }
  })();

  if (!isClearlyBelow) return null;
  return `Label says ${claim.label} but the stream delivers ${height}p`;
}

/** Suggested height for a claim (used when the stream exposes no metadata). */
export function claimHeight(name: string | null | undefined): number | null {
  return parseLabelClaim(name)?.height ?? null;
}
