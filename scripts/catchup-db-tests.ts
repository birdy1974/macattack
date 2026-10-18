/**
 * Real PostgreSQL + local-fixture integration. NEVER use a production database.
 * Initialize a disposable local database named *_test with init-schema.js, run
 * npm run fixtures, then DATABASE_URL=postgresql://.../<name>_test npm run test:catchup-db.
 */
import assert from "node:assert/strict";
import { NextRequest } from "next/server";
import { eq } from "drizzle-orm";
import { verifyArchiveCandidates } from "../src/lib/catchup-verification";
import type { StreamProbeResult } from "../src/lib/stream-probe";

async function main() {
  const url = new URL(process.env.DATABASE_URL || "postgresql://localhost/not_configured");
  assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) && url.pathname.endsWith("_test"),
    "Use a disposable local PostgreSQL database whose name ends in _test");
  process.env.MACATTACK_ALLOW_LOCAL_STREAMS = "1";
  const { db, pool, ensureMigrations } = await import("../src/db");
  const { scanJobs, scanResults } = await import("../src/db/schema");
  const { saveQualityWithCatchUp, saveCatchUpCheck } = await import("../src/lib/catchup-store");
  const { checkMacStreamQuality } = await import("../src/lib/mac-quality");
  const { POST } = await import("../src/app/api/scan/catch-up/route");
  const { GET: status } = await import("../src/app/api/scan/status/route");
  const { GET: quality } = await import("../src/app/api/scan/quality/route");
  const { GET: download } = await import("../src/app/api/scan/download/route");
  const base = process.env.PROBE_FIXTURE_ORIGIN || "http://127.0.0.1:4599";
  let jobId: number | undefined;
  try {
    await ensureMigrations();
    const [job] = await db.insert(scanJobs).values({ portalUrl: base, macPrefix: "00:1A:79",
      status: "completed", selectedFields: ["macAddress", "qualityCatchUpChannels"] }).returning();
    jobId = job.id;
    const [result, untouched, concurrent] = await db.insert(scanResults).values([
      { jobId, macAddress: "00:1A:79:11:22:33", portalUrl: base, stalkerServerPath: `${base}/portal.php` },
      { jobId, macAddress: "00:1A:79:44:55:66", portalUrl: base, stalkerServerPath: `${base}/portal.php` },
      { jobId, macAddress: "00:1A:79:77:88:99", portalUrl: base, stalkerServerPath: `${base}/portal.php` },
    ]).returning();
    const report = await checkMacStreamQuality({ serverPath: `${base}/portal.php`, portalBase: `${base}/c/`,
      mac: result.macAddress, sampleMs: 3000, channelsToProbe: 1, watchlist: ["Sports FHD"],
      pictureChecks: false, thumbnails: false, checkCatchUp: true });
    await saveQualityWithCatchUp(result.id, report, { qualityScore: 8, qualityCheckedAt: new Date(report.measuredAt) });
    const load = async (id = result.id) => (await db.select().from(scanResults).where(eq(scanResults.id, id)))[0];
    assert.equal((await load()).qualityCatchUpSummary?.channels?.find((c) => c.channelId === "1")?.genreTitle, "News");
    assert.equal((await load()).qualityCatchUpSummary?.channels?.find((c) => c.channelId === "1")?.status, "playable");
    assert.equal((await load()).qualityCatchUpSummary?.channels?.find((c) => c.channelId === "2")?.status, "failed");
    const checkedAt = (await load()).qualityCheckedAt?.toISOString();
    const response = await POST(new NextRequest("http://fixture/api/scan/catch-up", { method: "POST",
      body: JSON.stringify({ resultId: result.id, channelKey: "id:1" }), headers: { "Content-Type": "application/json" } }));
    const payload = await response.json();
    assert.equal(response.status, 200, JSON.stringify(payload));
    assert.equal(payload.qualityCatchUpSummary.channels.find((c: { channelId: string }) => c.channelId === "1").status, "playable");
    assert.equal((await load()).qualityScore, 8);
    assert.equal((await load()).qualityCheckedAt?.toISOString(), checkedAt);
    assert.equal((await load(untouched.id)).qualityCatchUpSummary, null);
    assert.equal((await load()).qualityCatchUpSummary?.channels?.find((c) => c.channelId === "2")?.status, "failed");

    const polled = await (await status(new NextRequest(`http://fixture/api/scan/status?jobId=${jobId}`))).json();
    assert.equal(polled.results.find((r: { id: number }) => r.id === result.id).qualityCatchUpSummary.genres[0].genreTitle, "News");
    const detail = await (await quality(new NextRequest(`http://fixture/api/scan/quality?resultId=${result.id}`))).json();
    assert.equal(detail.catchUp.channels.find((c: { channelId: string }) => c.channelId === "1").status, "playable");
    assert.equal(detail.report.catchUp.channels.find((c: { channelId: string }) => c.channelId === "1").status, "playable");
    const exported = await (await download(new NextRequest(`http://fixture/api/scan/download?jobId=${jobId}&format=csv&field=qualityCatchUpChannels`))).text();
    assert.match(exported, /News \/ News HD \[1\]: archive media playable/);
    assert.match(exported, /Sports \/ Sports FHD \[2\]: sampled checks failed/);

    const before = (await load()).qualityCatchUpSummary;
    await saveQualityWithCatchUp(result.id, { ...report, catchUp: { ...report.catchUp, enabled: false,
      status: "not_checked", channels: [] } }, { qualityScore: 7 });
    assert.deepEqual((await load()).qualityCatchUpSummary, before); // monitor cannot erase archive evidence

    const candidates = [ { id: "a", name: "A", genreId: "1", genreTitle: "News", days: 7 },
      { id: "b", name: "B", genreId: "2", genreTitle: "Sports", days: 2 } ];
    const batch = (key: string) => verifyArchiveCandidates({ candidates, channelKeys: [key], methods: ["window"], sampleMs: 3000,
      resolve: async () => ({ url: "http://fixture/archive", linkResolved: true, error: null }),
      probe: async () => ({ status: "measured", bytesRead: 188 } as StreamProbeResult) });
    const [a, b] = await Promise.all([batch("id:a"), batch("id:b")]);
    await Promise.all([saveCatchUpCheck(concurrent.id, a), saveCatchUpCheck(concurrent.id, b)]);
    assert.equal((await load(concurrent.id)).qualityCatchUpSummary?.channels?.filter((c) => c.status === "playable").length, 2);
    assert.equal((await load(concurrent.id)).qualityReport, null); // don't fabricate a live-quality report
    console.log("✓ PostgreSQL: automatic persistence, per-channel API checks, reload/status/detail, CSV export");
    console.log("✓ PostgreSQL: MAC isolation, live-score preservation, monitor preservation, concurrent cumulative batches");
  } finally {
    if (jobId !== undefined) await db.delete(scanJobs).where(eq(scanJobs.id, jobId));
    await pool.end();
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
