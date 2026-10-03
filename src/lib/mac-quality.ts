/**
 * ============================================================================
 * MAC Quality Check — "this MAC works, but is it actually any good?"
 * ============================================================================
 *
 * Runs after a MAC has been validated by the scanner AND passed the user's
 * filters. It answers the question the portal-only diagnostics could not:
 *
 *   • SPEED     — does the media path deliver enough bitrate with headroom?
 *   • QUALITY   — what resolution/codec/bitrate does a real channel deliver?
 *   • STABILITY — does the transport stream stay clean, and can the connection
 *                 keep up with real time (no growing buffer deficit)?
 *
 * Method: handshake → list channels → pick a spread of channels → resolve each
 * one with `create_link` → measure the real media path with the stream probe.
 *
 * Honest limits are attached to every report (see `limitations`), because a
 * short sample from one vantage point is evidence, not a guarantee.
 * ============================================================================
 */

import {
  probeStream,
  scoreStreamProbe,
  resolutionLabel,
  type StreamProbeResult,
  type StreamScore,
  type StreamVerdict,
} from "@/lib/stream-probe";
import {
  stalkerHandshake,
  stalkerListChannels,
  stalkerResolveStream,
  selectChannelsForProbe,
  redactStreamUrl,
  type StalkerChannel,
} from "@/lib/stalker-streams";

export interface MacQualityCheckOptions {
  serverPath: string;
  portalBase: string;
  mac: string;
  timeoutMs?: number;
  /** How many channels to probe (default 3, clamped 1–8). */
  channelsToProbe?: number;
  /** Media sample window per channel (default 8000 ms). */
  sampleMs?: number;
  maxBytesPerProbe?: number;
  signal?: AbortSignal;
}

export interface MacQualityChannelResult {
  name: string;
  genreId: string | null;
  /** Token-redacted URL so stored reports cannot be replayed. */
  url: string | null;
  linkError: string | null;
  probe: StreamProbeResult | null;
  score: StreamScore | null;
}

export interface MacQualityAggregate {
  channelsProbed: number;
  channelsPlayable: number;
  linksFailed: number;
  speedScore: number | null;
  qualityScore: number | null;
  stabilityScore: number | null;
  overallScore: number | null;
  verdict: StreamVerdict;
  label: string;
  /** Simple headroom statement when several channels declared a requirement. */
  headroomSummary: string | null;
}

export interface MacStreamQualityReport {
  version: 1;
  mac: string;
  measuredAt: string;
  durationMs: number;
  portal: {
    serverPath: string;
    channelListSource: "get_all_channels" | "ordered_list" | "none";
    channelsListed: number;
    linksResolved: number;
    linksFailed: number;
  };
  channels: MacQualityChannelResult[];
  aggregate: MacQualityAggregate;
  notes: string[];
  limitations: string[];
}

const DEFAULT_CHANNELS = 3;
const DEFAULT_SAMPLE_MS = 8000;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function average(values: Array<number | null>): number | null {
  const usable = values.filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  if (usable.length === 0) return null;
  return Math.round((usable.reduce((sum, value) => sum + value, 0) / usable.length) * 10) / 10;
}

function verdictFor(score: number | null): StreamVerdict {
  if (score === null) return "unknown";
  if (score >= 8.5) return "excellent";
  if (score >= 7) return "good";
  if (score >= 5) return "fair";
  if (score >= 3) return "poor";
  return "unusable";
}

const VERDICT_LABELS: Record<StreamVerdict, string> = {
  excellent: "Excellent — plays smoothly with large headroom",
  good: "Good — should play smoothly",
  fair: "Fair — playable, with some risk at peak times",
  poor: "Poor — expect stalls or reduced quality",
  unusable: "Unusable — no channel could be watched as measured",
  unknown: "Unknown — not enough data to judge",
};

/**
 * Strip anything that could act as a credential (session tokens in stream
 * URLs) before a report is stored or returned through the API.
 */
export function sanitizeProbeForStorage(probe: StreamProbeResult): StreamProbeResult {
  return {
    ...probe,
    url: redactStreamUrl(probe.url) || probe.url,
    finalUrl: redactStreamUrl(probe.finalUrl) || probe.finalUrl,
    redirectChain: probe.redirectChain.map((entry) => redactStreamUrl(entry) || entry),
    hls: probe.hls
      ? {
          ...probe.hls,
          selectedVariantUrl: redactStreamUrl(probe.hls.selectedVariantUrl),
          variantLadder: probe.hls.variantLadder.map((variant) => ({
            ...variant,
            url: redactStreamUrl(variant.url) || variant.url,
          })),
          segments: probe.hls.segments.map((segment) => ({
            ...segment,
            url: redactStreamUrl(segment.url) || segment.url,
          })),
        }
      : null,
  };
}

/**
 * Run the full quality check for one validated MAC. Never throws: every
 * failure is reported in the result so the scanner can keep going.
 */
export async function checkMacStreamQuality(
  options: MacQualityCheckOptions
): Promise<MacStreamQualityReport> {
  const startedAt = Date.now();
  const channelsToProbe = clamp(options.channelsToProbe ?? DEFAULT_CHANNELS, 1, 8);
  const sampleMs = clamp(options.sampleMs ?? DEFAULT_SAMPLE_MS, 3000, 30000);
  const notes: string[] = [];
  const channels: MacQualityChannelResult[] = [];

  const limitations = [
    "Measured from the scanner host's network, not the viewer's device, Wi-Fi or ISP route.",
    `Only ${channelsToProbe} channel(s) were sampled for a few seconds each — peak-hour congestion and future outages are not covered.`,
    "No video decoding: picture freezes/black frames cannot be detected, only transport-stream and delivery health.",
    "Stream URLs are stored with session tokens removed; re-checking requires a fresh create_link.",
  ];

  const clientOptions = {
    serverPath: options.serverPath,
    portalBase: options.portalBase,
    mac: options.mac,
    timeoutMs: options.timeoutMs,
    signal: options.signal,
  };

  const handshake = await stalkerHandshake(clientOptions);
  if (!handshake.token) {
    return {
      version: 1,
      mac: options.mac,
      measuredAt: new Date().toISOString(),
      durationMs: Date.now() - startedAt,
      portal: {
        serverPath: options.serverPath,
        channelListSource: "none",
        channelsListed: 0,
        linksResolved: 0,
        linksFailed: 0,
      },
      channels: [],
      aggregate: {
        channelsProbed: 0,
        channelsPlayable: 0,
        linksFailed: 0,
        speedScore: null,
        qualityScore: null,
        stabilityScore: null,
        overallScore: null,
        verdict: "unknown",
        label: "Not measurable — handshake failed",
        headroomSummary: null,
      },
      notes: [handshake.error || "Handshake failed"],
      limitations,
    };
  }

  const list = await stalkerListChannels(clientOptions, handshake.token, { maxChannels: 400, maxGenres: 8 });
  notes.push(
    list.source === "get_all_channels"
      ? `Channel list from get_all_channels (${list.channels.length} channels)`
      : list.source === "ordered_list"
        ? `Channel list from per-genre get_ordered_list (${list.channels.length} channels)`
        : `No channel list available: ${list.error ?? "unknown reason"}`
  );

  const selection = selectChannelsForProbe(list.channels, channelsToProbe);
  let linksResolved = 0;
  let linksFailed = 0;

  for (const channel of selection) {
    if (options.signal?.aborted) {
      notes.push("Quality check aborted by the scanner before all channels were probed");
      break;
    }

    const link = await stalkerResolveStream(clientOptions, handshake.token, channel);
    if (!link.url) {
      linksFailed += 1;
      channels.push({
        name: channel.name,
        genreId: channel.genreId,
        url: null,
        linkError: link.error || "No playable URL",
        probe: null,
        score: null,
      });
      continue;
    }
    linksResolved += 1;

    const probe = await probeStream(link.url, {
      sampleMs,
      timeoutMs: Math.max(options.timeoutMs ?? 8000, 8000),
      maxBytes: options.maxBytesPerProbe,
      signal: options.signal,
      headers: { "X-User-Agent": "Model: MAG250; Link: WiFi" },
    });
    const score = scoreStreamProbe(probe);

    channels.push({
      name: channel.name,
      genreId: channel.genreId,
      url: redactStreamUrl(link.url),
      linkError: null,
      probe: sanitizeProbeForStorage(probe),
      score,
    });
  }

  const probes = channels.map((entry) => entry.probe).filter((probe): probe is StreamProbeResult => !!probe);
  const scores = channels.map((entry) => entry.score).filter((score): score is StreamScore => !!score);
  const playable = probes.filter((probe) => probe.status === "measured" && probe.bytesRead > 0).length;

  const speedScore = average(scores.map((score) => score.speed));
  const qualityScore = average(scores.map((score) => score.quality));
  const stabilityScore = average(scores.map((score) => score.stability));

  let overallScore = average(scores.map((score) => score.overall));
  if (overallScore !== null && scores.length > 0) {
    // Playability is a gate, not a footnote: scale the aggregate down when some
    // sampled channels could not be watched at all (up to -3 points).
    const playableRatio = playable / Math.max(scores.length, 1);
    overallScore = Math.round((overallScore - 3 * (1 - playableRatio)) * 10) / 10;
    if (overallScore < 0) overallScore = 0;
  }

  const verdict = verdictFor(overallScore);

  // Headroom summary: compare sustained vs required across probed channels.
  const margins = probes
    .filter((probe) => probe.sustainedMbps !== null && probe.requiredMbps !== null && probe.requiredMbps > 0)
    .map((probe) => (probe.sustainedMbps as number) / (probe.requiredMbps as number));
  const headroomSummary =
    margins.length === 0
      ? null
      : `Headroom across ${margins.length} measured channel(s): worst ${Math.min(...margins).toFixed(2)}×, best ${Math.max(
          ...margins
        ).toFixed(2)}× of the required bitrate`;

  const best = channels
    .filter((entry) => entry.score?.overall != null)
    .sort((a, b) => (b.score?.overall ?? 0) - (a.score?.overall ?? 0))[0];
  const worst = channels
    .filter((entry) => entry.score?.overall != null)
    .sort((a, b) => (a.score?.overall ?? 0) - (b.score?.overall ?? 0))[0];

  if (best && worst && best !== worst) {
    notes.push(`Best sampled channel: ${best.name} (${best.score?.overall}/10)`);
    notes.push(`Weakest sampled channel: ${worst.name} (${worst.score?.overall}/10)`);
  }

  const resolutions = probes
    .map((probe) => probe.resolution?.label ?? null)
    .filter((label): label is string => !!label);
  if (resolutions.length > 0) {
    notes.push(`Resolutions observed: ${Array.from(new Set(resolutions)).join(", ")}`);
  }

  const codecs = probes.map((probe) => probe.videoCodec).filter((codec): codec is string => !!codec);
  if (codecs.length > 0) {
    notes.push(`Video codecs observed: ${Array.from(new Set(codecs)).join(", ")}`);
  }

  const drm = probes.find((probe) => probe.drm)?.drm ?? null;
  if (drm) notes.push(`DRM/encryption detected: ${drm}`);

  return {
    version: 1,
    mac: options.mac,
    measuredAt: new Date().toISOString(),
    durationMs: Date.now() - startedAt,
    portal: {
      serverPath: options.serverPath,
      channelListSource: list.source,
      channelsListed: list.channels.length,
      linksResolved,
      linksFailed,
    },
    channels,
    aggregate: {
      channelsProbed: scores.length,
      channelsPlayable: playable,
      linksFailed,
      speedScore,
      qualityScore,
      stabilityScore,
      overallScore,
      verdict,
      label: VERDICT_LABELS[verdict],
      headroomSummary,
    },
    notes,
    limitations,
  };
}

/** Human-readable log lines for the scanner log panel. */
export function formatMacQualityLog(report: MacStreamQualityReport): Array<{ level: string; message: string }> {
  const lines: Array<{ level: string; message: string }> = [];
  const { aggregate } = report;

  if (aggregate.channelsProbed === 0) {
    lines.push({
      level: "warning",
      message: `Stream quality check: no channel could be measured (${report.notes[0] ?? "unknown reason"})`,
    });
    return lines;
  }

  lines.push({
    level: aggregate.verdict === "excellent" || aggregate.verdict === "good" ? "success" : aggregate.verdict === "fair" ? "info" : "warning",
    message:
      `Stream quality: ${aggregate.label} — overall ${aggregate.overallScore ?? "?"}/10 ` +
      `(speed ${aggregate.speedScore ?? "?"} · quality ${aggregate.qualityScore ?? "?"} · stability ${aggregate.stabilityScore ?? "?"})`,
  });
  lines.push({
    level: "info",
    message: `Channels probed: ${aggregate.channelsPlayable}/${aggregate.channelsProbed} playable` +
      (aggregate.linksFailed > 0 ? `, ${aggregate.linksFailed} channel link(s) failed to resolve` : ""),
  });

  if (aggregate.headroomSummary) lines.push({ level: "info", message: aggregate.headroomSummary });

  for (const channel of report.channels) {
    if (!channel.probe || !channel.score) {
      lines.push({
        level: "warning",
        message: `  • ${channel.name}: ${channel.linkError || "not measured"}`,
      });
      continue;
    }
    const probe = channel.probe;
    const resolution = probe.resolution?.label ?? "unknown resolution";
    const speed = probe.sustainedMbps !== null ? `${probe.sustainedMbps.toFixed(2)} Mbps` : "no throughput figure";
    const required = probe.requiredMbps !== null ? ` of ${probe.requiredMbps.toFixed(2)} required` : "";
    lines.push({
      level: channel.score.verdict === "excellent" || channel.score.verdict === "good" ? "success" : "info",
      message:
        `  • ${channel.name}: ${channel.score.verdict} (${channel.score.overall ?? "?"}/10) — ${resolution}, ` +
        `${probe.videoCodec ?? "codec unknown"}, ${speed}${required}, stability ${channel.score.stability ?? "?"}/10`,
    });
  }

  for (const limitation of report.limitations.slice(0, 2)) {
    lines.push({ level: "info", message: `  ⓘ ${limitation}` });
  }
  return lines;
}

export { resolutionLabel };
