/**
 * Xtream Codes account quality check.
 *
 * Mirrors the Stalker path (src/lib/mac-quality.ts) but authenticates with
 * username/password: login → live categories → live streams → direct stream
 * URLs → the same media probe, optional ffmpeg picture pass, thumbnails and
 * aggregation. The result reuses the MAC report shape so the UI and exports
 * treat both protocols identically.
 */

import { probeStream, scoreStreamProbe, type StreamScore } from "@/lib/stream-probe";
import type { PictureAnalysis } from "@/lib/ffmpeg-tools";
import { aggregateChannels, type MacQualityChannelResult, type MacStreamQualityReport } from "@/lib/mac-quality";
import { analyzePicture, captureThumbnail, detectFfmpeg } from "@/lib/ffmpeg-tools";
import { saveThumbnail } from "@/lib/thumbnail-store";
import { detectLabelMismatch } from "@/lib/label-mismatch";
import { pMapLimit } from "@/lib/parallel";
import {
  parseXtreamUrl,
  xtreamAccount,
  xtreamCategories,
  xtreamLiveStreams,
  xtreamStreamUrl,
  type XtreamCredentials,
  type XtreamStream,
} from "@/lib/xtream-streams";

export interface XtreamQualityOptions {
  /** Either the full Xtream URL or explicit credentials. */
  url?: string;
  credentials?: XtreamCredentials;
  channelsToProbe?: number;
  sampleMs?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
  pictureChecks?: boolean;
  thumbnails?: boolean;
  concurrency?: number;
}

export interface XtreamAccountSummary {
  username: string;
  status: string | null;
  expiryDate: string | null;
  maxConnections: string | null;
  activeConnections: string | null;
  categories: number;
  liveStreams: number;
}

const DEFAULT_CHANNELS = 3;
const DEFAULT_SAMPLE_MS = 8000;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** Spread the sample across categories so one broken group cannot dominate. */
export function selectXtreamStreams(streams: XtreamStream[], count: number): XtreamStream[] {
  if (count <= 0) return [];
  const byCategory = new Map<string, XtreamStream[]>();
  for (const stream of streams) {
    const key = stream.categoryId ?? "unknown";
    const list = byCategory.get(key) ?? [];
    list.push(stream);
    byCategory.set(key, list);
  }
  const selected: XtreamStream[] = [];
  const used = new Set<string>();
  const add = (stream: XtreamStream) => {
    if (used.has(stream.id)) return;
    used.add(stream.id);
    selected.push(stream);
  };
  for (const list of byCategory.values()) {
    if (selected.length >= count) break;
    add(list[0]);
  }
  for (const stream of streams) {
    if (selected.length >= count) break;
    add(stream);
  }
  return selected.slice(0, count);
}

export async function checkXtreamAccountQuality(
  options: XtreamQualityOptions
): Promise<{ report: MacStreamQualityReport | null; account: XtreamAccountSummary | null; error: string | null }> {
  const startedAt = Date.now();
  const credentials = options.credentials ?? parseXtreamUrl(options.url || "");
  if (!credentials) {
    return { report: null, account: null, error: "Not an Xtream URL (expected player_api.php or get.php with username/password)" };
  }

  const channelsToProbe = clamp(options.channelsToProbe ?? DEFAULT_CHANNELS, 1, 8);
  const sampleMs = clamp(options.sampleMs ?? DEFAULT_SAMPLE_MS, 3000, 30000);
  const concurrency = clamp(options.concurrency ?? 2, 1, 4);

  const login = await xtreamAccount(credentials, { timeoutMs: options.timeoutMs, signal: options.signal });
  if (!login.auth || !login.account) {
    return { report: null, account: null, error: login.error || "Xtream login failed" };
  }

  const [categories, streams] = await Promise.all([
    xtreamCategories(credentials, "live", { timeoutMs: options.timeoutMs, signal: options.signal }),
    xtreamLiveStreams(credentials, { timeoutMs: options.timeoutMs, signal: options.signal, limit: 500 }),
  ]);

  const categoryTitles = new Map(categories.map((category) => [category.id, category.name]));
  const selection = selectXtreamStreams(streams, channelsToProbe);
  const ffmpeg = await detectFfmpeg();

  const probed = await pMapLimit(
    selection,
    concurrency,
    async (stream) => {
      const url = xtreamStreamUrl(credentials, stream.id, "ts");
      const probe = await probeStream(url, {
        sampleMs,
        timeoutMs: Math.max(options.timeoutMs ?? 8000, 8000),
        signal: options.signal,
        headers: { "User-Agent": "VLC/3.0.20 LibVLC/3.0.20" },
      });
      const labelMismatch = detectLabelMismatch(stream.name, {
        height: probe.resolution?.height ?? null,
        videoBitrateMbps: probe.ts?.videoBitrateMbps ?? probe.requiredMbps ?? null,
      });
      return { stream, url, probe, labelMismatch, score: scoreStreamProbe(probe, { labelMismatch }) };
    },
    { shouldStop: () => !!options.signal?.aborted }
  );

  const channels: MacQualityChannelResult[] = [];
  const liveUrls: string[] = [];

  for (const entry of probed) {
    if (!entry) continue;
    const { stream, url, probe, labelMismatch, score } = entry;
    channels.push({
      name: stream.name,
      genreId: stream.categoryId,
      genreTitle: stream.categoryId ? categoryTitles.get(stream.categoryId) ?? null : null,
      url: `${credentials.base}/live/${credentials.username}/***/${stream.id}.ts`,
      linkError: null,
      probe,
      score,
      labelMismatch,
      picture: null,
      thumbnail: null,
    });
    liveUrls.push(url);
  }

  // Optional picture pass + thumbnails (sequential: keep load predictable).
  if (ffmpeg.available && (options.pictureChecks ?? true)) {
    for (let index = 0; index < channels.length; index += 1) {
      if (options.signal?.aborted) break;
      const liveUrl = liveUrls[index];
      if (!liveUrl) continue;
      const picture: PictureAnalysis = await analyzePicture(liveUrl, {
        seconds: Math.max(5, Math.min(Math.round(sampleMs / 1000), 12)),
        timeoutMs: (Math.max(5, Math.round(sampleMs / 1000)) + 20) * 1000,
        userAgent: "VLC/3.0.20 LibVLC/3.0.20",
        signal: options.signal,
      });
      channels[index].picture = picture;
      if (picture.analyzed && channels[index].probe) {
        channels[index].score = scoreStreamProbe(channels[index].probe as never, {
          picture: {
            analyzed: true,
            frozenDetected: picture.frozenDetected,
            blackDetected: picture.blackDetected,
            frozenDurationSec: picture.frozenDurationSec,
            blackDurationSec: picture.blackDurationSec,
            fps: picture.fps,
            videoBitrateMbps: picture.videoBitrateMbps,
          },
          labelMismatch: channels[index].labelMismatch,
        });
      }
      if (options.thumbnails ?? true) {
        const capture = await captureThumbnail(liveUrl, {
          userAgent: "VLC/3.0.20 LibVLC/3.0.20",
          signal: options.signal,
        });
        if (capture.ok && capture.jpeg) {
          channels[index].thumbnail = await saveThumbnail(`xtream-${credentials.username}-${index}-${Date.now()}`, capture.jpeg);
        }
      }
    }
  }

  const aggregate = aggregateChannels(channels);
  aggregate.labelMismatches = channels.filter((channel) => channel.labelMismatch).length;

  const notes = [
    `Xtream account ${credentials.username}@${new URL(credentials.base).host}: ${streams.length} live stream(s) in ${categories.length} categories`,
  ];
  if (!ffmpeg.available) notes.push("Picture checks skipped: ffmpeg is not installed on this host");
  if (aggregate.frozenChannels > 0) notes.push(`${aggregate.frozenChannels} stream(s) look frozen`);
  if (aggregate.labelMismatches > 0) notes.push(`${aggregate.labelMismatches} stream(s) are mislabeled`);
  if (selection.some((stream) => stream.tvArchive)) {
    const archive = selection.find((stream) => stream.tvArchive);
    notes.push(`Catch-up advertised on "${archive?.name}" (${archive?.tvArchiveDays ?? "?"} day(s)) — not verified automatically for Xtream`);
  }

  const report: MacStreamQualityReport = {
    version: 2,
    mac: credentials.username,
    measuredAt: new Date().toISOString(),
    durationMs: Date.now() - startedAt,
    portal: {
      serverPath: credentials.base,
      serialNumber: "—",
      userAgent: "VLC/3.0.20 LibVLC/3.0.20",
      userAgentAttempts: 1,
      channelListSource: "get_all_channels",
      channelsListed: streams.length,
      linksResolved: channels.length,
      linksFailed: 0,
      viaProxy: null,
    },
    tooling: { ffmpeg: { available: ffmpeg.available, version: ffmpeg.version, reason: ffmpeg.reason } },
    channels,
    genreGroups: [],
    catchUp: {
      status: "not_checked",
      channelName: null,
      advertisedDays: null,
      verifiedMinutes: null,
      linkResolved: false,
      playable: false,
      bytesRead: 0,
      error: null,
    },
    aggregate,
    notes,
    limitations: [
      "Measured from the scanner host's network, not the viewer's device, Wi-Fi or ISP route.",
      `Only ${channelsToProbe} stream(s) were sampled for a few seconds each — peak-hour congestion is not covered.`,
      "Xtream catch-up/archive is advertised by the panel but not verified automatically here.",
    ],
  };

  return {
    report,
    account: {
      username: credentials.username,
      status: login.account.status,
      expiryDate: login.account.expiryDate,
      maxConnections: login.account.maxConnections,
      activeConnections: login.account.activeConnections,
      categories: categories.length,
      liveStreams: streams.length,
    },
    error: null,
  };
}

export type { StreamScore };
