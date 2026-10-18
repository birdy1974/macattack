/** Offline regressions for cache lifecycle, archive sampling and dashboard maths. */
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QualityDashboard } from "../src/components/quality-dashboard";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { selectArchiveCandidates, uncheckedCatchUp, verifyArchiveCandidates } from "../src/lib/catchup-verification";
import { summariseQualityDashboard, type DashboardResult } from "../src/lib/quality-dashboard";
import { xtreamArchiveUrl } from "../src/lib/xtream-streams";
import type { StreamProbeResult } from "../src/lib/stream-probe";

async function main() {
  const base: DashboardResult = { id: 1, macAddress: "00:1A:79:11:22:33" };
  assert.equal(summariseQualityDashboard([]).overall, null);
  const pending = summariseQualityDashboard([base]);
  assert.equal(pending.pending, 1);
  assert.equal(pending.overall, null);
  const measured = { ...base, qualityCheckedAt: "2026-10-18T12:00:00Z", qualityScore: 8,
    qualitySpeedScore: 7, qualityStabilityScore: 9, qualityQualityScore: 8,
    qualityVerdict: "good", qualityChannelsPlayable: 2, qualityChannelsProbed: 3,
    qualityCatchUpStatus: "verified", qualityFirstByteMs: 100,
    qualityGenreSummary: [{ genreId: "1", genreTitle: "News", channelsProbed: 3, channelsPlayable: 2, averageOverall: 8 }] };
  const snapshot = summariseQualityDashboard([measured, { ...base, id: 2 },
    { ...base, id: 3, qualityCheckedAt: "2026-10-18T13:00:00Z", qualityScore: null },
    { ...measured, id: 4, qualityScore: 0, qualityVerdict: "unusable", qualityFirstByteMs: 300 }]);
  assert.equal(snapshot.found, 4);
  assert.equal(snapshot.completed, 3);
  assert.equal(snapshot.scored, 2);
  assert.equal(snapshot.pending, 1);
  assert.equal(snapshot.unscored, 1);
  assert.equal(snapshot.overall, 4); // null excluded; legitimate zero included
  assert.equal(snapshot.playablePercent, 67);
  assert.equal(snapshot.firstByteMs, 200);
  assert.equal(snapshot.top[0].id, 1);
  assert.equal(snapshot.bands.find((b) => b.verdict === "unusable")?.count, 1);
  assert.equal(snapshot.genres[0].samples, 2);
  assert.equal(snapshot.archivePlayable, 2);
  assert.equal(snapshot.archiveUnchecked, 2);
  assert.equal(summariseQualityDashboard([base, measured]).overall, 8); // new result refresh
  assert.equal(summariseQualityDashboard([{ ...measured, qualityScore: 3 }]).overall, 3); // recheck refresh
  const renderDashboard = (results: DashboardResult[], running = true) => renderToStaticMarkup(createElement(QualityDashboard, {
    results, running, enabled: true, onSelect: () => undefined,
  }));
  assert.match(renderDashboard([]), /Waiting for the first matching address/);
  assert.match(renderDashboard([base]), /awaiting measurement/);
  assert.match(renderDashboard([measured]), /Highest measured quality/);
  assert.match(renderDashboard([measured]), /8.0\/10/);
  assert.match(renderDashboard([measured], false), /Latest scan snapshot/);
  assert.match(renderDashboard([measured]), /Catch-up spot checks/);
  console.log("✓ dashboard: empty/pending, completed/unscored, zero, bands, channels, latency, ranking, genres and updates");

  const candidates = [
    { id: "1", name: "News broken", genreId: "news", days: 7 },
    { id: "2", name: "News duplicate genre", genreId: "news", days: 7 },
    { id: "3", name: "Sports works", genreId: "sports", days: 2 },
    { id: "4", name: "Kids broken", genreId: "kids", days: 1 },
  ];
  assert.deepEqual(selectArchiveCandidates(candidates).map((c) => c.id), ["1", "3", "4"]);
  assert.equal(selectArchiveCandidates([candidates[0], candidates[0]]).length, 1);
  let probes = 0;
  const archive = await verifyArchiveCandidates({
    candidates, methods: ["programme", "window"], sampleMs: 3000,
    resolve: async (c, minutes, method) => ({ url: c.id === "3" && method === "window" ? "http://fixture/archive.ts" : null,
      linkResolved: c.id === "3" && method === "window", error: "fixture missing programme" }),
    probe: async () => { probes += 1; return { status: "measured", bytesRead: 188 } as StreamProbeResult; },
  });
  assert.equal(archive.status, "verified");
  assert.equal(archive.channelName, "Sports works");
  assert.equal(archive.testedChannels, 3);
  assert.equal(archive.testedGenres, 3);
  assert.equal(archive.advertisedChannels, 4);
  assert.equal(archive.limited, true);
  assert.equal(probes, 1);
  assert.equal(archive.attempts?.some((a) => a.minutesAgo === 240), true); // first failure did not return early
  assert.equal(archive.attempts?.some((a) => a.channelName === "Kids broken"), true); // scope/partial failures retained
  let mediaCalls = 0;
  const retriedMedia = await verifyArchiveCandidates({ candidates: [candidates[0]], methods: ["window"], sampleMs: 3000,
    resolve: async () => ({ url: "http://fixture/archive.ts", linkResolved: true, error: null }),
    probe: async () => { mediaCalls += 1; return { status: mediaCalls === 1 ? "network_error" : "measured", bytesRead: mediaCalls === 1 ? 0 : 188 } as StreamProbeResult; },
  });
  assert.equal(retriedMedia.status, "verified");
  assert.equal(retriedMedia.verifiedMinutes, 240);
  const shortArchive = await verifyArchiveCandidates({ candidates: [{ ...candidates[0], days: 1 / 24 }], methods: ["window"], sampleMs: 3000,
    resolve: async (_c, minutes) => { assert.ok(minutes + 30 < 60); return { url: null, linkResolved: false, error: "not recorded" }; },
  });
  assert.equal(shortArchive.attempts?.[0].minutesAgo, 15);
  const tooShort = await verifyArchiveCandidates({ candidates: [{ ...candidates[0], days: 10 / 1440 }], methods: ["window"], sampleMs: 3000,
    resolve: async () => { throw new Error("Cannot request a 30-minute clip inside 10 minutes of retention"); },
  });
  assert.equal(tooShort.status, "not_checked");
  assert.equal(tooShort.testedChannels, 0);
  const live = await verifyArchiveCandidates({ candidates: [candidates[0]], methods: ["window"], sampleMs: 3000,
    resolve: async () => ({ url: "http://fixture/live.ts", linkResolved: false, error: null }),
    probe: async () => { throw new Error("Must not probe unchanged live URL"); },
  });
  assert.equal(live.status, "advertised_but_failed");
  assert.match(live.error!, /live URL/);
  assert.equal((await verifyArchiveCandidates({ candidates: [], methods: [], sampleMs: 3000,
    resolve: async () => { throw new Error("Must not resolve empty catalogue"); } })).status, "not_advertised");
  const controller = new AbortController(); controller.abort();
  const aborted = await verifyArchiveCandidates({ candidates, methods: ["window"], sampleMs: 3000, signal: controller.signal,
    resolve: async () => { throw new Error("Must honor cancellation"); } });
  assert.equal(aborted.status, "not_checked");
  assert.equal(aborted.testedChannels, 0);
  assert.equal(uncheckedCatchUp().status, "not_checked");
  console.log("✓ archive: genre diversity, bounded sample, retries, partial success, live-URL rejection, empty/cancelled checks");

  const credentials = { base: "http://fixture", username: "user/name", password: "pass/word", endpoint: "player_api" as const };
  const now = Date.parse("2026-10-18T12:00:00Z");
  assert.match(xtreamArchiveUrl(credentials, "101", 60, "Europe/Amsterdam", now), /\/30\/2026-10-18:12-30\/101.ts$/);
  assert.match(xtreamArchiveUrl(credentials, "101", 60, "UTC", now), /\/30\/2026-10-18:10-30\/101.ts$/);
  assert.match(xtreamArchiveUrl(credentials, "101", 60, "UTC", now), /user%2Fname\/pass%2Fword/);
  assert.throws(() => xtreamArchiveUrl(credentials, "101", 60, "invalid-timezone", now));
  console.log("✓ Xtream archive URL: panel timezone, UTC fallback, escaping, invalid timezone");

  // Import store only after isolating BOTH configured and fallback directories.
  const root = await fs.mkdtemp(join(tmpdir(), "macattack-cache-test-"));
  const originalData = process.env.MACATTACK_DATA_DIR;
  const originalTmp = process.env.TMPDIR;
  process.env.MACATTACK_DATA_DIR = join(root, "data");
  process.env.TMPDIR = root;
  try {
    const store = await import("../src/lib/thumbnail-store");
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
    const oldGeneration = store.thumbnailGeneration();
    const name = await store.saveThumbnail("old-search", jpeg);
    assert.ok(name);
    const info = await store.thumbnailStoreInfo();
    await fs.mkdir(info.fallbackDir, { recursive: true });
    await fs.writeFile(join(info.fallbackDir, "fallback.jpg"), jpeg);
    await fs.writeFile(join(info.dir, "keep.txt"), "not temporary thumbnail data");
    await fs.mkdir(join(info.dir, "keep.jpg")); // never recursively remove paths
    assert.equal(await store.clearThumbnails(), 2);
    assert.equal(await store.readThumbnail(name), null);
    assert.equal(await store.readThumbnail("fallback.jpg"), null);
    assert.equal(await fs.readFile(join(info.dir, "keep.txt"), "utf8"), "not temporary thumbnail data");
    assert.equal((await fs.stat(join(info.dir, "keep.jpg"))).isDirectory(), true);
    assert.equal(await store.saveThumbnail("stale-capture", jpeg, oldGeneration), null);
    const fresh = await store.saveThumbnail("new-search", jpeg);
    assert.ok(fresh);
    assert.deepEqual(await store.readThumbnail(fresh), jpeg);
    await store.clearThumbnails();

    // A save already writing when reset begins must finish BEFORE deletion.
    const writeFile = fs.writeFile;
    let release!: () => void;
    let began!: () => void;
    const started = new Promise<void>((resolve) => { began = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    fs.writeFile = async (...args: Parameters<typeof fs.writeFile>) => { began(); await gate; return writeFile(...args); };
    try {
      const writing = store.saveThumbnail("in-flight", jpeg);
      await started;
      const reset = store.clearThumbnails();
      release();
      const file = await writing;
      assert.ok(file);
      assert.equal(await reset, 1);
      assert.equal(await store.readThumbnail(file), null);
    } finally { fs.writeFile = writeFile; }
    console.log("✓ temporary cache: primary/fallback purge, unrelated files preserved, stale capture rejected, in-flight write serialized");
  } finally {
    if (originalData === undefined) delete process.env.MACATTACK_DATA_DIR; else process.env.MACATTACK_DATA_DIR = originalData;
    if (originalTmp === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = originalTmp;
    await fs.rm(root, { recursive: true, force: true });
  }
  console.log("All scan-quality regressions passed");
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
