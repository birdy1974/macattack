/** Bounded, genre-diverse archive spot checks, independent of live sampling. */
import { probeStream } from "@/lib/stream-probe";
import type { ProxyConfig } from "@/lib/proxy";

export interface ArchiveCandidate {
  id: string | null;
  name: string;
  genreId: string | null;
  days: number | null;
  genreTitle?: string | null;
}

export interface CatchUpAttempt {
  channelKey?: string;
  channelId?: string | null;
  genreTitle?: string;
  channelName: string;
  genreId: string | null;
  minutesAgo: number;
  method: string;
  linkResolved: boolean;
  playable: boolean;
  bytesRead: number;
  error: string | null;
}

export interface CatchUpChannelResult {
  key: string;
  channelId: string | null;
  channelName: string;
  genreId: string | null;
  genreTitle: string;
  advertisedDays: number | null;
  status: "playable" | "failed" | "untested";
  checkedAt: string | null;
  attempts: CatchUpAttempt[];
}

export interface CatchUpGenreResult {
  genreId: string | null;
  genreTitle: string;
  advertisedChannels: number;
  playableChannels: number;
  failedChannels: number;
  untestedChannels: number;
}

export function archiveChannelKey(channel: ArchiveCandidate): string {
  return channel.id !== null ? `id:${channel.id}` : `name:${JSON.stringify([channel.genreId, channel.name])}`;
}

export interface CatchUpVerification {
  status: "verified" | "advertised_but_failed" | "not_advertised" | "not_checked";
  channelName: string | null;
  advertisedDays: number | null;
  /** Tested window ending this many minutes ago, NOT maximum retention. */
  verifiedMinutes: number | null;
  linkResolved: boolean;
  playable: boolean;
  bytesRead: number;
  error: string | null;
  advertisedChannels?: number;
  testedChannels?: number;
  advertisedGenres?: number;
  testedGenres?: number;
  attempts?: CatchUpAttempt[];
  /** Media on an archive-specific URL is not proof of broadcast time/content. */
  evidence?: "archive_url_and_media" | "none";
  limited?: boolean;
  /** All advertised archive channels in the fetched catalogue, including untested. */
  channels?: CatchUpChannelResult[];
  genres?: CatchUpGenreResult[];
  catalogueCheckedAt?: string;
  /** False for inventory-only/live-only runs that must not erase saved checks. */
  enabled?: boolean;
}

export function uncheckedCatchUp(): CatchUpVerification {
  return { status: "not_checked", channelName: null, advertisedDays: null, verifiedMinutes: null,
    linkResolved: false, playable: false, bytesRead: 0, error: null };
}

/** Round-robin genres so a large first category cannot exhaust the budget. */
export function selectArchiveCandidates<T extends ArchiveCandidate>(channels: T[], limit = 3): T[] {
  const groups = new Map<string, T[]>();
  const seen = new Set<string>();
  for (const channel of channels) {
    const key = archiveChannelKey(channel);
    if (seen.has(key)) continue;
    seen.add(key);
    const genre = channel.genreId ?? "unknown";
    const group = groups.get(genre) ?? [];
    group.push(channel);
    groups.set(genre, group);
  }
  const selected: T[] = [];
  while (selected.length < limit) {
    let added = false;
    for (const group of groups.values()) {
      const channel = group.shift();
      if (channel) { selected.push(channel); added = true; }
      if (selected.length >= limit) break;
    }
    if (!added) break;
  }
  return selected;
}

export async function verifyArchiveCandidates<T extends ArchiveCandidate>(options: {
  candidates: T[];
  enabled?: boolean;
  /** Optional explicit channels to test; others remain in the inventory. */
  channelKeys?: string[];
  skipCheckedKeys?: string[];
  channelLimit?: number;
  methods: string[];
  resolve: (channel: T, minutesAgo: number, method: string) => Promise<{
    url: string | null; linkResolved: boolean; error: string | null;
  }>;
  sampleMs: number;
  signal?: AbortSignal;
  proxy?: ProxyConfig | null;
  userAgent?: string;
  /** Dependency injection keeps verification tests independent of media/network. */
  probe?: typeof probeStream;
}): Promise<CatchUpVerification> {
  const candidates = selectArchiveCandidates(options.candidates, options.candidates.length);
  const eligible = candidates.filter((c) => options.channelKeys
    ? options.channelKeys.includes(archiveChannelKey(c))
    : !options.skipCheckedKeys?.includes(archiveChannelKey(c)));
  const selected = options.enabled === false ? [] : selectArchiveCandidates(eligible,
    Math.max(1, Math.min(10, Math.floor(options.channelLimit ?? 3))));
  const inventory: CatchUpChannelResult[] = candidates.map((c) => ({
    key: archiveChannelKey(c), channelId: c.id, channelName: c.name,
    genreId: c.genreId, genreTitle: c.genreTitle || (c.genreId ? `Genre ${c.genreId}` : "Ungrouped"),
    advertisedDays: c.days, status: "untested", checkedAt: null, attempts: [],
  }));
  const report: CatchUpVerification = {
    ...uncheckedCatchUp(),
    status: options.enabled === false ? "not_checked" : selected.length ? "advertised_but_failed" : "not_advertised",
    advertisedChannels: candidates.length,
    advertisedGenres: new Set(candidates.map((c) => c.genreId)).size,
    testedChannels: 0, testedGenres: 0, attempts: [], evidence: "none",
    limited: candidates.length > selected.length,
    channels: inventory, catalogueCheckedAt: new Date().toISOString(), enabled: options.enabled !== false,
  };
  const attempts = report.attempts!;
  const testedGenres = new Set<string | null>();
  const probe = options.probe ?? probeStream;
  for (const channel of selected) {
    if (options.signal?.aborted) break;
    // Never request beyond the advertised retention; leave 30 min for the clip.
    const windows = [60, 240].filter((minutes) => !channel.days || minutes + 30 < channel.days * 1440);
    // Short archives still deserve an in-retention spot check.
    if (windows.length === 0 && channel.days && channel.days * 1440 > 31) {
      windows.push(Math.min(15, Math.floor(channel.days * 1440 - 31)));
    }
    if (windows.length === 0 || options.methods.length === 0) {
      report.limited = true;
      continue;
    }
    report.testedChannels! += 1;
    testedGenres.add(channel.genreId);
    const entry = inventory.find((c) => c.key === archiveChannelKey(channel))!;
    let playable = false;
    for (const minutesAgo of windows) {
      for (const method of options.methods) {
        if (options.signal?.aborted) break;
        let link: { url: string | null; linkResolved: boolean; error: string | null };
        try {
          link = await options.resolve(channel, minutesAgo, method);
        } catch {
          link = { url: null, linkResolved: false, error: "Archive link resolution failed" };
        }
        const attempt: CatchUpAttempt = { channelKey: entry.key, channelId: entry.channelId,
          genreTitle: entry.genreTitle, channelName: channel.name, genreId: channel.genreId,
          minutesAgo, method, linkResolved: link.linkResolved, playable: false, bytesRead: 0, error: link.error };
        attempts.push(attempt);
        entry.attempts.push(attempt);
        // An unchanged live URL must not become a false archive success.
        if (link.url && link.linkResolved) {
          try {
            const result = await probe(link.url, {
              sampleMs: Math.min(options.sampleMs, 6000), timeoutMs: 10000,
              maxRetries: 0, maxBytes: 4 * 1024 * 1024,
              signal: options.signal, proxy: options.proxy,
              headers: { "X-User-Agent": "Model: MAG250; Link: WiFi", ...(options.userAgent ? { "User-Agent": options.userAgent } : {}) },
            });
            attempt.bytesRead = result.bytesRead;
            attempt.playable = result.status === "measured" && result.bytesRead > 0;
            attempt.error = attempt.playable ? null : `Archive media probe: ${result.status}`;
          } catch {
            attempt.error = "Archive media probe failed";
          }
        } else if (link.url) {
          attempt.error = "Portal returned the live URL without archive evidence";
        }
        if (attempt.playable) {
          playable = true;
          // Preserve the first success; failure on another channel doesn't erase it.
          if (report.status !== "verified") {
            Object.assign(report, { status: "verified", channelName: channel.name,
              advertisedDays: channel.days, verifiedMinutes: minutesAgo,
              linkResolved: true, playable: true, bytesRead: attempt.bytesRead,
              error: null, evidence: "archive_url_and_media" });
          }
          break;
        }
      }
      if (playable || options.signal?.aborted) break;
    }
    entry.status = playable ? "playable" : options.signal?.aborted ? "untested" : "failed";
    entry.checkedAt = entry.status === "untested" ? null : new Date().toISOString();
  }
  report.testedGenres = testedGenres.size;
  report.limited = report.limited || !!options.signal?.aborted;
  if (report.status === "advertised_but_failed") {
    report.channelName = attempts.at(-1)?.channelName ?? null;
    report.error = options.signal?.aborted ? "Archive checks interrupted" : attempts.at(-1)?.error ?? "No archive window could be tested";
    if (attempts.length === 0) report.status = "not_checked";
  }
  return summariseCatchUpInventory(report);
}

/** Rebuild counts and genre outcomes from saved per-channel evidence. */
export function summariseCatchUpInventory(report: CatchUpVerification): CatchUpVerification {
  if (!report.channels) return report; // Historical v2 reports only have attempts.
  const groups = new Map<string, CatchUpGenreResult>();
  for (const channel of report.channels) {
    const key = channel.genreId ?? "__unknown__";
    const group = groups.get(key) ?? { genreId: channel.genreId, genreTitle: channel.genreTitle,
      advertisedChannels: 0, playableChannels: 0, failedChannels: 0, untestedChannels: 0 };
    group.advertisedChannels += 1;
    if (channel.status === "playable") group.playableChannels += 1;
    else if (channel.status === "failed") group.failedChannels += 1;
    else group.untestedChannels += 1;
    groups.set(key, group);
  }
  const tested = report.channels.filter((c) => c.status !== "untested");
  const firstPlayable = report.channels.find((c) => c.status === "playable");
  const success = firstPlayable?.attempts.find((a) => a.playable);
  const status = firstPlayable ? "verified" : tested.length ? "advertised_but_failed"
    : report.channels.length ? "not_checked" : report.status === "not_checked" ? "not_checked" : "not_advertised";
  return { ...report, status, channels: report.channels, genres: [...groups.values()],
    advertisedChannels: report.channels.length, advertisedGenres: groups.size,
    testedChannels: tested.length, testedGenres: new Set(tested.map((c) => c.genreId)).size,
    limited: report.channels.some((c) => c.status === "untested"),
    attempts: report.channels.flatMap((c) => c.attempts),
    channelName: firstPlayable?.channelName ?? report.channelName,
    advertisedDays: firstPlayable?.advertisedDays ?? report.advertisedDays,
    verifiedMinutes: success?.minutesAgo ?? null,
    linkResolved: !!success, playable: !!success, bytesRead: success?.bytesRead ?? 0,
    evidence: success ? "archive_url_and_media" : "none",
    error: success ? null : report.error,
  };
}

/** A targeted batch updates its channels without losing earlier tested channels.
 * The new catalogue is authoritative: channels no longer advertised are removed.
 */
export function mergeCatchUpVerification(previous: CatchUpVerification | null | undefined,
  incoming: CatchUpVerification): CatchUpVerification {
  if (!incoming.channels || incoming.enabled === false) return previous ?? incoming;
  const old = new Map(previous?.channels?.map((c) => [c.key, c]) ?? []);
  return summariseCatchUpInventory({ ...incoming, channels: incoming.channels.map((channel) => {
    const saved = old.get(channel.key);
    if (!saved || saved.status === "untested" || (channel.checkedAt && (!saved.checkedAt || channel.checkedAt >= saved.checkedAt))) return channel;
    return { ...saved, channelName: channel.channelName, genreId: channel.genreId,
      genreTitle: channel.genreTitle, advertisedDays: channel.advertisedDays };
  }) });
}

/** Read historical reports without assuming the JSON column is a current report. */
export function catchUpFromReport(value: unknown): CatchUpVerification | null {
  if (!value || typeof value !== "object") return null;
  const report = value as { catchUp?: CatchUpVerification };
  return report.catchUp && typeof report.catchUp.status === "string" ? report.catchUp : null;
}

export { formatCatchUpInventory } from "@/lib/catchup-display";
