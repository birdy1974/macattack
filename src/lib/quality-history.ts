/**
 * Probe history + EWMA ("trust over time").
 *
 * A single spot check is noisy: one unlucky sample should not condemn a
 * stream, and a slow decline is invisible in a snapshot. Every quality check
 * therefore also appends a probe run; the UI shows the trend and an
 * exponentially weighted score (α = 0.3 by default, i.e. the newest run has
 * 30% weight and history never fully disappears).
 *
 * The maths is pure and unit-tested in scripts/history-tests.ts.
 */

export interface ProbeRun {
  id: number;
  resultId: number;
  measuredAt: string;
  overall: number | null;
  speed: number | null;
  quality: number | null;
  stability: number | null;
  verdict: string | null;
  throughputMbps: number | null;
  requiredMbps: number | null;
  channelsPlayable: number | null;
  channelsProbed: number | null;
}

export type QualityTrend = "improving" | "stable" | "degrading" | "insufficient_data";

export const DEFAULT_EWMA_ALPHA = 0.3;

/**
 * Exponentially weighted mean over runs in chronological order.
 * Ignores null values; returns null when nothing is scoreable.
 */
export function computeEwma(values: Array<number | null | undefined>, alpha = DEFAULT_EWMA_ALPHA): number | null {
  const usable = values.filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  if (usable.length === 0) return null;
  const boundedAlpha = Math.min(1, Math.max(0.05, alpha));
  let weighted = usable[0];
  for (let index = 1; index < usable.length; index += 1) {
    weighted = boundedAlpha * usable[index] + (1 - boundedAlpha) * weighted;
  }
  return Math.round(weighted * 10) / 10;
}

/**
 * Compare the weighted recent half against the older half. Needs at least four
 * runs; smaller differences than `threshold` count as stable.
 */
export function computeTrend(
  values: Array<number | null | undefined>,
  threshold = 0.5
): QualityTrend {
  const usable = values.filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  if (usable.length < 4) return "insufficient_data";

  const half = Math.floor(usable.length / 2);
  const older = usable.slice(0, half);
  const recent = usable.slice(usable.length - half);
  const average = (list: number[]) => list.reduce((sum, value) => sum + value, 0) / list.length;
  const delta = average(recent) - average(older);

  if (delta > threshold) return "improving";
  if (delta < -threshold) return "degrading";
  return "stable";
}

export function summariseHistory(runs: ProbeRun[]): {
  runs: ProbeRun[];
  ewma: number | null;
  trend: QualityTrend;
  bestOverall: number | null;
  worstOverall: number | null;
  firstMeasuredAt: string | null;
  lastMeasuredAt: string | null;
  averageThroughputMbps: number | null;
} {
  const overalls = runs.map((run) => run.overall);
  const throughputs = runs
    .map((run) => run.throughputMbps)
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  const overallValues = overalls.filter((value): value is number => typeof value === "number" && Number.isFinite(value));

  return {
    runs,
    ewma: computeEwma(overalls),
    trend: computeTrend(overalls),
    bestOverall: overallValues.length > 0 ? Math.max(...overallValues) : null,
    worstOverall: overallValues.length > 0 ? Math.min(...overallValues) : null,
    firstMeasuredAt: runs[0]?.measuredAt ?? null,
    lastMeasuredAt: runs[runs.length - 1]?.measuredAt ?? null,
    averageThroughputMbps:
      throughputs.length > 0
        ? Math.round((throughputs.reduce((sum, value) => sum + value, 0) / throughputs.length) * 100) / 100
        : null,
  };
}

/** A run "degrades" when the latest score drops this much below the EWMA. */
export const DEFAULT_DEGRADE_THRESHOLD = 1.5;

export function detectDegradation(
  runs: ProbeRun[],
  threshold = DEFAULT_DEGRADE_THRESHOLD
): { degraded: boolean; ewma: number | null; latest: number | null; drop: number | null } {
  if (runs.length < 2) return { degraded: false, ewma: null, latest: null, drop: null };
  const previous = runs.slice(0, -1).map((run) => run.overall);
  const ewma = computeEwma(previous);
  const latest = runs[runs.length - 1].overall;
  if (ewma === null || latest === null) return { degraded: false, ewma, latest, drop: null };
  const drop = Math.round((ewma - latest) * 10) / 10;
  return { degraded: drop >= threshold, ewma, latest, drop };
}
