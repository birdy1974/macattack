/**
 * ============================================================================
 * MAC Quality Check — "this MAC works, but is it actually any good?"
 * ============================================================================
 *
 * Runs after a MAC has been validated by the scanner AND passed the user's
 * filters. It answers the question the portal-only diagnostics could not:
 *
 *   • SPEED     — does the media path deliver enough bitrate with headroom?
 *   • QUALITY   — what resolution/codec/bitrate does a real channel deliver,
 *                 and does it match the channel's own label?
 *   • STABILITY — does the transport stream stay clean, can the connection
 *                 keep up with real time, and is the picture actually moving?
 *
 * Pipeline: handshake (with UA rotation) → list channels → pick a spread →
 * `create_link` → probe the real media path → optional ffmpeg picture pass
 * (freeze/black/fps/VBR + thumbnail) → optional catch-up verification →
 * aggregate scores.
 *
 * Everything is optional-safe: without ffmpeg, without a proxy, without
 * catch-up support the check still produces a complete, honest report.
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
  stalkerGenreTitles,
  stalkerHandshake,
  stalkerListChannels,
  stalkerResolveArchiveLink,
  stalkerResolveStream,
  selectChannelsForProbe,
  computeSerialNumber,
  redactStreamUrl,
  type StalkerChannel,
} from "@/lib/stalker-streams";
import { buildUserAgentCandidates } from "@/lib/user-agents";
import { detectFfmpeg, analyzePicture, captureThumbnail, type PictureAnalysis } from "@/lib/ffmpeg-tools";
import { saveThumbnail } from "@/lib/thumbnail-store";
import { detectLabelMismatch } from "@/lib/label-mismatch";
import { pMapLimit } from "@/lib/parallel";
import { redactProxy, type ProxyConfig } from "@/lib/proxy";

// ============================================================================
// OPTIONS / TYPES
// ============================================================================

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
  /** Configured UA candidates (settings) — rotation is tried when enabled. */
  userAgents?: string[] | null;
  /** Remembered working UA for this portal host. */
  rememberedUserAgent?: string | null;
  /** Called with the UA that worked, so the caller can persist it per host. */
  onUserAgentResolved?: (userAgent: string) => void | Promise<void>;
  /** Egress through this proxy (second vantage point / geoblock confirmation). */
  proxy?: ProxyConfig | null;
  /** Run the optional ffmpeg picture pass (freeze/black/fps/VBR). */
  pictureChecks?: boolean;
  /** Capture one JPEG per probed channel (requires ffmpeg). */
  thumbnails?: boolean;
  /** Verify catch-up/archive when the portal advertises it. */
  checkCatchUp?: boolean;
  /** Parallel channel probes (default 2, clamped 1–4). */
  concurrency?: number;
}

export interface MacQualityChannelResult {
  name: string;
  genreId: string | null;
  genreTitle: string | null;
  /** Token-redacted URL so stored reports cannot be replayed. */
  url: string | null;
  linkError: string | null;
  probe: StreamProbeResult | null;
  score: StreamScore | null;
  /** "Label says 4K but the stream delivers 720p" (when they disagree). */
  labelMismatch: string | null;
  /** Optional ffmpeg evidence. */
  picture: PictureAnalysis | null;
  /** Thumbnail file name (served through /api/scan/thumbnail). */
  thumbnail: string | null;
}

export interface CatchUpVerification {
  status: "verified" | "advertised_but_failed" | "not_advertised" | "not_checked";
  channelName: string | null;
  advertisedDays: number | null;
  /** Minutes back that were actually requested/verified. */
  verifiedMinutes: number | null;
  linkResolved: boolean;
  playable: boolean;
  bytesRead: number;
  error: string | null;
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
  headroomSummary: string | null;
  frozenChannels: number;
  labelMismatches: number;
}

export interface GenreGroupSummary {
  genreId: string | null;
  genreTitle: string;
  channelsProbed: number;
  channelsPlayable: number;
  averageOverall: number | null;
}

export interface MacStreamQualityReport {
  version: 2;
  mac: string;
  measuredAt: string;
  durationMs: number;
  portal: {
    serverPath: string;
    serialNumber: string;
    userAgent: string | null;
    userAgentAttempts: number;
    channelListSource: "get_all_channels" | "ordered_list" | "none";
    channelsListed: number;
    linksResolved: number;
    linksFailed: number;
    viaProxy: string | null;
  };
  tooling: {
    ffmpeg: { available: boolean; version: string | null; reason: string | null };
  };
  channels: MacQualityChannelResult[];
  genreGroups: GenreGroupSummary[];
  catchUp: CatchUpVerification;
  aggregate: MacQualityAggregate;
  notes: string[];
  limitations: string[];
}

const DEFAULT_CHANNELS = 3;
const DEFAULT_SAMPLE_MS = 8000;
const DEFAULT_CONCURRENCY = 2;

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

// ============================================================================
// SANITISATION
// ============================================================================

/** Strip anything that could act as a credential (session tokens in URLs). */
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

// ============================================================================
// AGGREGATION (shared by the Stalker and Xtream paths)
// ============================================================================

export interface AggregatableChannel {
  name: string;
  linkError: string | null;
  probe: StreamProbeResult | null;
  score: StreamScore | null;
}

export function aggregateChannels(channels: AggregatableChannel[]): MacQualityAggregate & {
  frozenChannels: number;
  labelMismatches: number;
} {
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
    overallScore = Math.max(0, Math.round((overallScore - 3 * (1 - playableRatio)) * 10) / 10);
  }

  const margins = probes
    .filter((probe) => probe.sustainedMbps !== null && probe.requiredMbps !== null && probe.requiredMbps > 0)
    .map((probe) => (probe.sustainedMbps as number) / (probe.requiredMbps as number));

  const frozenChannels = scores.filter((score) => score.frozen).length;
  const verdict = verdictFor(overallScore);

  return {
    channelsProbed: scores.length,
    channelsPlayable: playable,
    linksFailed: channels.filter((entry) => !entry.probe).length,
    speedScore,
    qualityScore,
    stabilityScore,
    overallScore,
    verdict,
    label: VERDICT_LABELS[verdict],
    headroomSummary:
      margins.length === 0
        ? null
        : `Headroom across ${margins.length} measured channel(s): worst ${Math.min(...margins).toFixed(2)}×, best ${Math.max(
            ...margins
          ).toFixed(2)}× of the required bitrate`,
    frozenChannels,
    labelMismatches: 0,
  };
}

// ============================================================================
// MAIN
// ============================================================================

export async function checkMacStreamQuality(
  options: MacQualityCheckOptions
): Promise<MacStreamQualityReport> {
  const startedAt = Date.now();
  const channelsToProbe = clamp(options.channelsToProbe ?? DEFAULT_CHANNELS, 1, 8);
  const sampleMs = clamp(options.sampleMs ?? DEFAULT_SAMPLE_MS, 3000, 30000);
  const concurrency = clamp(options.concurrency ?? DEFAULT_CONCURRENCY, 1, 4);
  const notes: string[] = [];

  const limitations = [
    "Measured from the scanner host's network (or the configured proxy), not the viewer's device, Wi-Fi or ISP route.",
    `Only ${channelsToProbe} channel(s) were sampled for a few seconds each — peak-hour congestion and future outages are not covered.`,
    "Stream URLs are stored with session tokens removed; re-checking requires a fresh create_link.",
  ];

  const serialNumber = computeSerialNumber(options.mac, options.serverPath);
  const clientOptions: import("@/lib/stalker-streams").StalkerClientOptions = {
    serverPath: options.serverPath,
    portalBase: options.portalBase,
    mac: options.mac,
    timeoutMs: options.timeoutMs,
    signal: options.signal,
    proxy: options.proxy ?? null,
    serialNumber,
    userAgent: null,
    userAgentCandidates: null,
  };

  const ffmpeg = await detectFfmpeg();
  if (!ffmpeg.available && (options.pictureChecks ?? true)) {
    notes.push(`Picture checks skipped: ${ffmpeg.reason}`);
  }
  if (!ffmpeg.available) {
    limitations.push(
      "No ffmpeg on this host, so freezes/black frames (a still image with audio) cannot be detected and no thumbnails are produced."
    );
  }
  if (options.proxy) {
    notes.push(`Egressing through proxy ${redactProxy(options.proxy)} — DNS/timing figures describe the proxy's path`);
    limitations.push(
      "Measurements taken through a proxy describe the proxy's route to the stream, not this host's direct performance."
    );
  }

  // ── handshake with user-agent rotation ────────────────────────────────────
  const handshake = await stalkerHandshake({
    ...clientOptions,
    userAgent: options.rememberedUserAgent ?? null,
    userAgentCandidates: buildUserAgentCandidates(options.rememberedUserAgent, options.userAgents),
  });

  if (!handshake.token) {
    notes.push(handshake.error || "Handshake failed");
    return emptyReport(options, startedAt, serialNumber, handshake.attempts, null, ffmpeg, notes, limitations, "none", 0);
  }

  if (handshake.userAgent && handshake.userAgent !== options.rememberedUserAgent) {
    notes.push(
      handshake.attempts > 1
        ? `User-agent rotation: candidate ${handshake.attempts} worked (${handshake.userAgent.slice(0, 48)}…)`
        : "Handshake succeeded with the preferred user agent"
    );
    await options.onUserAgentResolved?.(handshake.userAgent);
  }
  clientOptions.userAgent = handshake.userAgent ?? undefined;

  // ── channel list ──────────────────────────────────────────────────────────
  const list = await stalkerListChannels(clientOptions, handshake.token, { maxChannels: 400, maxGenres: 8 });
  notes.push(
    list.source === "get_all_channels"
      ? `Channel list from get_all_channels (${list.channels.length} channels)`
      : list.source === "ordered_list"
        ? `Channel list from per-genre get_ordered_list (${list.channels.length} channels)`
        : `No channel list available: ${list.error ?? "unknown reason"}`
  );

  const selection = selectChannelsForProbe(list.channels, channelsToProbe);
  const genreTitles = list.genreTitles;

  // ── resolve links (small parallel pool; cheap API calls) ──────────────────
  const linkResults = await pMapLimit(
    selection,
    Math.min(concurrency, selection.length),
    async (channel) => {
      const link = await stalkerResolveStream(clientOptions, handshake.token as string, channel, channel.raw);
      return { channel, url: link.url, error: link.error, link };
    },
    { shouldStop: () => !!options.signal?.aborted }
  );

  let linksResolved = 0;
  let linksFailed = 0;

  // ── probe media (bounded parallel) ────────────────────────────────────────
  const probed = await pMapLimit(
    linkResults.filter((entry): entry is NonNullable<typeof entry> => !!entry),
    concurrency,
    async (entry) => {
      const { channel, url, error } = entry;
      if (!url) {
        linksFailed += 1;
        return {
          name: channel.name,
          genreId: channel.genreId,
          genreTitle: channel.genreId ? genreTitles[channel.genreId] ?? null : null,
          url: null,
          linkError: error || "No playable URL",
          probe: null,
          score: null,
          labelMismatch: null,
          picture: null,
          thumbnail: null,
          archiveDays: channel.tvArchiveDays ?? null,
          archive: channel.tvArchive,
        };
      }
      linksResolved += 1;

      const probe = await probeStream(url, {
        sampleMs,
        timeoutMs: Math.max(options.timeoutMs ?? 8000, 8000),
        maxBytes: options.maxBytesPerProbe,
        signal: options.signal,
        proxy: options.proxy ?? null,
        headers: { "X-User-Agent": "Model: MAG250; Link: WiFi" },
      });

      const measuredHeight = probe.resolution?.height ?? null;
      const labelMismatch = detectLabelMismatch(channel.name, {
        height: measuredHeight,
        videoBitrateMbps: probe.ts?.videoBitrateMbps ?? probe.requiredMbps ?? null,
      });
      const score = scoreStreamProbe(probe, { labelMismatch });

      return {
        name: channel.name,
        genreId: channel.genreId,
        genreTitle: channel.genreId ? genreTitles[channel.genreId] ?? null : null,
        url: redactStreamUrl(url),
        linkError: null,
        probe: sanitizeProbeForStorage(probe),
        score,
        labelMismatch,
        picture: null as PictureAnalysis | null,
        thumbnail: null as string | null,
        archiveDays: channel.tvArchiveDays ?? null,
        archive: channel.tvArchive,
      };
    },
    { shouldStop: () => !!options.signal?.aborted }
  );

  const channels: MacQualityChannelResult[] = probed
    .filter((entry): entry is NonNullable<typeof entry> => !!entry)
    .map((entry) => ({
      name: entry.name,
      genreId: entry.genreId,
      genreTitle: entry.genreTitle,
      url: entry.url,
      linkError: entry.linkError,
      probe: entry.probe,
      score: entry.score,
      labelMismatch: entry.labelMismatch,
      picture: entry.picture,
      thumbnail: entry.thumbnail,
    }));

  // ── optional ffmpeg pass: picture evidence + thumbnail (sequential) ───────
  const resolvePlayableUrl = (index: number): string | null => {
    const entry = probed[index];
    return entry?.url ? entry.url : null;
  };

  if (ffmpeg.available && (options.pictureChecks ?? true)) {
    for (let index = 0; index < channels.length; index += 1) {
      if (options.signal?.aborted) break;
      const channel = channels[index];
      if (!channel.probe || channel.probe.status === "unsupported_scheme") continue;

      // Thumbnails need the *live* URL; the stored one is redacted, so resolve
      // again from the portal (cheap: create_link, no media transfer).
      const liveUrl = await resolveLiveUrlAgain(clientOptions, handshake.token, selection[index], index);
      if (!liveUrl) continue;

      const picture = await analyzePicture(liveUrl, {
        seconds: Math.max(5, Math.min(Math.round(sampleMs / 1000), 12)),
        timeoutMs: (Math.max(5, Math.round(sampleMs / 1000)) + 20) * 1000,
        userAgent: handshake.userAgent || undefined,
        signal: options.signal,
      });
      channel.picture = picture;
      if (picture.analyzed) {
        // Re-score with the picture evidence (freeze/black caps stability).
        channel.score = scoreStreamProbe(channel.probe, {
          picture: {
            analyzed: true,
            frozenDetected: picture.frozenDetected,
            blackDetected: picture.blackDetected,
            frozenDurationSec: picture.frozenDurationSec,
            blackDurationSec: picture.blackDurationSec,
            fps: picture.fps,
            videoBitrateMbps: picture.videoBitrateMbps,
          },
          labelMismatch: channel.labelMismatch,
        });
      }

      if (options.thumbnails ?? true) {
        const capture = await captureThumbnail(liveUrl, {
          userAgent: handshake.userAgent || undefined,
          signal: options.signal,
          timeoutMs: 20000,
        });
        if (capture.ok && capture.jpeg) {
          const name = await saveThumbnail(`${options.mac.replace(/[:.]/g, "")}-${index}-${Date.now()}`, capture.jpeg);
          channel.thumbnail = name;
        }
      }
    }
  }

  // ── optional catch-up verification ────────────────────────────────────────
  const catchUp = options.checkCatchUp === false
    ? ({ status: "not_checked", channelName: null, advertisedDays: null, verifiedMinutes: null, linkResolved: false, playable: false, bytesRead: 0, error: null } as CatchUpVerification)
    : await verifyCatchUp(clientOptions, handshake.token, selection, { sampleMs, signal: options.signal, proxy: options.proxy ?? null });

  if (catchUp.status === "verified") {
    notes.push(`Catch-up verified: ${catchUp.channelName} served an archive link ${catchUp.verifiedMinutes} minute(s) back (${catchUp.bytesRead} bytes)`);
  } else if (catchUp.status === "advertised_but_failed") {
    notes.push(
      `Catch-up advertised but not working: ${catchUp.channelName} (${catchUp.error ?? "no archive data"})`
    );
  } else if (catchUp.status === "not_advertised") {
    notes.push("No channel advertised catch-up/archive support on this portal");
  }

  // ── aggregate ─────────────────────────────────────────────────────────────
  const aggregate = aggregateChannels(channels);
  aggregate.labelMismatches = channels.filter((channel) => channel.labelMismatch).length;
  if (aggregate.frozenChannels > 0) {
    notes.push(`${aggregate.frozenChannels} channel(s) look like a frozen/still picture — see the penalties per channel`);
  }
  if (aggregate.labelMismatches > 0) {
    notes.push(`${aggregate.labelMismatches} channel(s) are mislabeled (claim a higher quality than they deliver)`);
  }

  const genreGroups = buildGenreGroups(channels);

  if (channels.length === 0) {
    notes.push("No channel could be probed (no playable link was returned by the portal)");
  }

  return {
    version: 2,
    mac: options.mac,
    measuredAt: new Date().toISOString(),
    durationMs: Date.now() - startedAt,
    portal: {
      serverPath: options.serverPath,
      serialNumber,
      userAgent: handshake.userAgent,
      userAgentAttempts: handshake.attempts,
      channelListSource: list.source,
      channelsListed: list.channels.length,
      linksResolved,
      linksFailed,
      viaProxy: options.proxy ? redactProxy(options.proxy) : null,
    },
    tooling: {
      ffmpeg: { available: ffmpeg.available, version: ffmpeg.version, reason: ffmpeg.reason },
    },
    channels,
    genreGroups,
    catchUp,
    aggregate,
    notes,
    limitations,
  };
}

/** Re-resolve one channel's live URL (needed for ffmpeg, which needs the real URL). */
async function resolveLiveUrlAgain(
  clientOptions: Parameters<typeof stalkerResolveStream>[0],
  token: string,
  channel: StalkerChannel | undefined,
  index: number
): Promise<string | null> {
  if (!channel) return null;
  void index;
  const link = await stalkerResolveStream(clientOptions, token, channel, channel.raw);
  return link.url;
}

async function verifyCatchUp(
  clientOptions: Parameters<typeof stalkerResolveArchiveLink>[0],
  token: string,
  selection: StalkerChannel[],
  options: { sampleMs: number; signal?: AbortSignal; proxy: ProxyConfig | null }
): Promise<CatchUpVerification> {
  const candidate = selection.find((channel) => channel.tvArchive);
  if (!candidate) {
    return {
      status: "not_advertised",
      channelName: null,
      advertisedDays: null,
      verifiedMinutes: null,
      linkResolved: false,
      playable: false,
      bytesRead: 0,
      error: null,
    };
  }

  for (const minutesAgo of [60, 240]) {
    if (options.signal?.aborted) break;
    const archive = await stalkerResolveArchiveLink(clientOptions, token, candidate, minutesAgo);
    if (!archive.url) {
      return {
        status: "advertised_but_failed",
        channelName: candidate.name,
        advertisedDays: archive.advertisedDays,
        verifiedMinutes: null,
        linkResolved: false,
        playable: false,
        bytesRead: 0,
        error: archive.error,
      };
    }

    const probe = await probeStream(archive.url, {
      sampleMs: Math.min(options.sampleMs, 6000),
      timeoutMs: 10000,
      signal: options.signal,
      proxy: options.proxy,
      headers: { "X-User-Agent": "Model: MAG250; Link: WiFi" },
    });

    if (probe.bytesRead > 0 && probe.status === "measured") {
      return {
        status: "verified",
        channelName: candidate.name,
        advertisedDays: archive.advertisedDays,
        verifiedMinutes: minutesAgo,
        linkResolved: archive.linkResolved,
        playable: true,
        bytesRead: probe.bytesRead,
        error: null,
      };
    }
  }

  return {
    status: "advertised_but_failed",
    channelName: candidate.name,
    advertisedDays: candidate.tvArchiveDays ?? null,
    verifiedMinutes: null,
    linkResolved: false,
    playable: false,
    bytesRead: 0,
    error: "Archive link returned no media data (portal may serve the live stream instead)",
  };
}

function buildGenreGroups(channels: MacQualityChannelResult[]): GenreGroupSummary[] {
  const groups = new Map<string, GenreGroupSummary>();
  for (const channel of channels) {
    const key = channel.genreId ?? "__unknown__";
    const group =
      groups.get(key) ??
      ({
        genreId: channel.genreId,
        genreTitle: channel.genreTitle ?? (channel.genreId ? `Genre ${channel.genreId}` : "Ungrouped"),
        channelsProbed: 0,
        channelsPlayable: 0,
        averageOverall: null,
      } satisfies GenreGroupSummary);
    group.channelsProbed += 1;
    if (channel.probe && channel.probe.status === "measured" && channel.probe.bytesRead > 0) {
      group.channelsPlayable += 1;
    }
    groups.set(key, group);
  }

  for (const [key, group] of groups) {
    const scores = channels
      .filter((channel) => (channel.genreId ?? "__unknown__") === key)
      .map((channel) => channel.score?.overall ?? null);
    group.averageOverall = average(scores);
  }

  return Array.from(groups.values()).sort((a, b) => b.channelsProbed - a.channelsProbed);
}

function emptyReport(
  options: MacQualityCheckOptions,
  startedAt: number,
  serialNumber: string,
  userAgentAttempts: number,
  userAgent: string | null,
  ffmpeg: Awaited<ReturnType<typeof detectFfmpeg>>,
  notes: string[],
  limitations: string[],
  channelListSource: "get_all_channels" | "ordered_list" | "none",
  channelsListed: number
): MacStreamQualityReport {
  return {
    version: 2,
    mac: options.mac,
    measuredAt: new Date().toISOString(),
    durationMs: Date.now() - startedAt,
    portal: {
      serverPath: options.serverPath,
      serialNumber,
      userAgent,
      userAgentAttempts,
      channelListSource,
      channelsListed,
      linksResolved: 0,
      linksFailed: 0,
      viaProxy: options.proxy ? redactProxy(options.proxy) : null,
    },
    tooling: { ffmpeg: { available: ffmpeg.available, version: ffmpeg.version, reason: ffmpeg.reason } },
    channels: [],
    genreGroups: [],
    catchUp: {
      status: "not_checked",
      channelName: null,
      advertisedDays: null,
      verifiedMinutes: null,
      linkResolved: false,
      playable: false,
      bytesRead: 0,
      error: notes[0] ?? null,
    },
    aggregate: {
      channelsProbed: 0,
      channelsPlayable: 0,
      linksFailed: 0,
      speedScore: null,
      qualityScore: null,
      stabilityScore: null,
      overallScore: null,
      verdict: "unknown",
      label: "Not measurable",
      headroomSummary: null,
      frozenChannels: 0,
      labelMismatches: 0,
    },
    notes,
    limitations,
  };
}

// ============================================================================
// LOG LINES FOR THE SCANNER PANEL
// ============================================================================

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
    level:
      aggregate.verdict === "excellent" || aggregate.verdict === "good"
        ? "success"
        : aggregate.verdict === "fair"
          ? "info"
          : "warning",
    message:
      `Stream quality: ${aggregate.label} — overall ${aggregate.overallScore ?? "?"}/10 ` +
      `(speed ${aggregate.speedScore ?? "?"} · quality ${aggregate.qualityScore ?? "?"} · stability ${aggregate.stabilityScore ?? "?"})`,
  });
  lines.push({
    level: "info",
    message:
      `Channels probed: ${aggregate.channelsPlayable}/${aggregate.channelsProbed} playable` +
      (aggregate.linksFailed > 0 ? `, ${aggregate.linksFailed} channel link(s) failed to resolve` : "") +
      (aggregate.frozenChannels > 0 ? ` · ${aggregate.frozenChannels} frozen` : "") +
      (aggregate.labelMismatches > 0 ? ` · ${aggregate.labelMismatches} mislabeled` : ""),
  });

  if (aggregate.headroomSummary) lines.push({ level: "info", message: aggregate.headroomSummary });
  if (report.tooling.ffmpeg.available) {
    lines.push({ level: "info", message: `ffmpeg picture checks available (${report.tooling.ffmpeg.version ?? "unknown version"})` });
  }
  if (report.catchUp.status === "verified") {
    lines.push({
      level: "success",
      message: `Catch-up verified on "${report.catchUp.channelName}" back to ${report.catchUp.verifiedMinutes} minute(s)`,
    });
  } else if (report.catchUp.status === "advertised_but_failed") {
    lines.push({ level: "warning", message: `Catch-up advertised but not working on "${report.catchUp.channelName}"` });
  }

  for (const channel of report.channels) {
    if (!channel.probe || !channel.score) {
      lines.push({ level: "warning", message: `  • ${channel.name}: ${channel.linkError || "not measured"}` });
      continue;
    }
    const probe = channel.probe;
    const resolution = probe.resolution?.label ?? "unknown resolution";
    const speed = probe.sustainedMbps !== null ? `${probe.sustainedMbps.toFixed(2)} Mbps` : "no throughput figure";
    const required = probe.requiredMbps !== null ? ` of ${probe.requiredMbps.toFixed(2)} required` : "";
    const extras = [
      channel.labelMismatch ? "MISLABELED" : null,
      channel.picture?.frozenDetected ? "FROZEN PICTURE" : null,
      probe.retryCount > 0 ? `${probe.retryCount} retry` : null,
      channel.picture?.fps ? `${channel.picture.fps.toFixed(0)} fps` : null,
    ].filter(Boolean);
    lines.push({
      level: channel.score.verdict === "excellent" || channel.score.verdict === "good" ? "success" : "info",
      message:
        `  • ${channel.name}: ${channel.score.verdict} (${channel.score.overall ?? "?"}/10) — ${resolution}, ` +
        `${probe.videoCodec ?? "codec unknown"}, ${speed}${required}, stability ${channel.score.stability ?? "?"}/10` +
        (extras.length > 0 ? ` [${extras.join(", ")}]` : ""),
    });
    for (const penalty of channel.score.penalties.slice(0, 2)) {
      lines.push({ level: "warning", message: `      ! ${penalty}` });
    }
  }

  for (const limitation of report.limitations.slice(0, 2)) {
    lines.push({ level: "info", message: `  ⓘ ${limitation}` });
  }
  return lines;
}

export { resolutionLabel };
