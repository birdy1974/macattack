import type { CatchUpVerification } from "@/lib/catchup-verification";

/** Compact result fields only: safe to derive on every status refresh. */
export interface DashboardResult {
  id: number;
  macAddress: string;
  qualityCheckedAt?: string | null;
  qualityVerdict?: string | null;
  qualityScore?: number | null;
  qualitySpeedScore?: number | null;
  qualityQualityScore?: number | null;
  qualityStabilityScore?: number | null;
  qualityChannelsPlayable?: number | null;
  qualityChannelsProbed?: number | null;
  qualityFrozen?: number | null;
  qualityLabelMismatch?: string | null;
  qualityCatchUpStatus?: string | null;
  qualityCatchUpSummary?: CatchUpVerification | null;
  qualityResolution?: string | null;
  qualityFirstByteMs?: number | null;
  qualityGenreSummary?: Array<{ genreId: string | null; genreTitle: string; channelsProbed: number; channelsPlayable: number; averageOverall: number | null }> | null;
}

export const QUALITY_BANDS = ["excellent", "good", "fair", "poor", "unusable"] as const;

export function summariseQualityDashboard<T extends DashboardResult>(results: T[]) {
  const completed = results.filter((r) => !!r.qualityCheckedAt);
  const scored = completed.filter((r) => typeof r.qualityScore === "number" && Number.isFinite(r.qualityScore));
  const average = (values: Array<number | null | undefined>) => {
    const numbers = values.filter((v): v is number => typeof v === "number" && Number.isFinite(v));
    return numbers.length ? Math.round(numbers.reduce((sum, n) => sum + n, 0) / numbers.length * 10) / 10 : null;
  };
  const median = (values: number[]) => {
    if (!values.length) return null;
    const sorted = [...values].sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    return Math.round(sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2);
  };
  const bands = QUALITY_BANDS.map((verdict) => ({ verdict, count: completed.filter((r) => r.qualityVerdict === verdict).length }));
  const playable = completed.reduce((n, r) => n + (r.qualityChannelsPlayable ?? 0), 0);
  const probed = completed.reduce((n, r) => n + (r.qualityChannelsProbed ?? 0), 0);
  const genres = new Map<string, { title: string; samples: number; playable: number; probed: number; scores: Array<number | null> }>();
  for (const r of completed) {
    for (const group of r.qualityGenreSummary ?? []) {
      // Genre IDs are portal-local; don't merge unrelated categories by ID.
      const key = group.genreTitle;
      const genre = genres.get(key) ?? { title: key, samples: 0, playable: 0, probed: 0, scores: [] };
      genre.samples += 1;
      genre.playable += group.channelsPlayable;
      genre.probed += group.channelsProbed;
      genre.scores.push(group.averageOverall);
      genres.set(key, genre);
    }
  }
  return {
    found: results.length, completed: completed.length, scored: scored.length,
    pending: results.length - completed.length,
    unscored: completed.length - scored.length,
    overall: average(scored.map((r) => r.qualityScore)),
    speed: average(completed.map((r) => r.qualitySpeedScore)),
    picture: average(completed.map((r) => r.qualityQualityScore)),
    stability: average(completed.map((r) => r.qualityStabilityScore)),
    firstByteMs: median(completed.flatMap((r) => typeof r.qualityFirstByteMs === "number" ? [r.qualityFirstByteMs] : [])),
    playable, probed, playablePercent: probed ? Math.round(playable / probed * 100) : null,
    frozen: completed.filter((r) => (r.qualityFrozen ?? 0) > 0).length,
    mislabeled: completed.filter((r) => !!r.qualityLabelMismatch).length,
    archivePlayable: results.filter((r) => r.qualityCatchUpStatus === "verified").length,
    archiveFailed: results.filter((r) => r.qualityCatchUpStatus === "advertised_but_failed").length,
    archiveNotAdvertised: results.filter((r) => r.qualityCatchUpStatus === "not_advertised").length,
    archiveAdvertisedChannels: results.reduce((n, r) => n + (r.qualityCatchUpSummary?.advertisedChannels ?? 0), 0),
    archivePlayableChannels: results.reduce((n, r) => n + (r.qualityCatchUpSummary?.channels?.filter((c) => c.status === "playable").length ?? 0), 0),
    archiveUnchecked: results.filter((r) => !r.qualityCatchUpStatus || r.qualityCatchUpStatus === "not_checked").length,
    bands,
    top: [...scored].sort((a, b) => b.qualityScore! - a.qualityScore! || a.id - b.id).slice(0, 5),
    genres: [...genres.values()].map((g) => ({ ...g, score: average(g.scores) })).sort((a, b) => b.samples - a.samples).slice(0, 8),
    lastMeasuredAt: completed.map((r) => r.qualityCheckedAt!).sort().at(-1) ?? null,
  };
}
