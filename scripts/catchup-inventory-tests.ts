/** No network/DB required: saved per-MAC archive inventory and cumulative checks. */
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { CatchUpResults } from "../src/components/catchup-results";
import { archiveChannelKey, catchUpFromReport, formatCatchUpInventory, mergeCatchUpVerification,
  verifyArchiveCandidates } from "../src/lib/catchup-verification";
import type { StreamProbeResult } from "../src/lib/stream-probe";

async function main() {
  // Same channel name in two genres must not merge channel identities.
  const candidates = [
    { id: "1", name: "News HD", genreId: "news", genreTitle: "News", days: 7 },
    { id: "2", name: "Sports HD", genreId: "sports", genreTitle: "Sports", days: 2 },
    { id: "3", name: "News HD", genreId: "regional", genreTitle: "Regional", days: 1 },
    { id: "4", name: "Kids", genreId: "news", genreTitle: "News", days: null },
  ];
  const run = (keys?: string[], playableIds = ["1"], enabled = true) => verifyArchiveCandidates({
    candidates, channelKeys: keys, enabled, methods: ["programme", "window"], sampleMs: 3000,
    resolve: async (c) => ({ url: playableIds.includes(c.id) ? "http://fixture/archive.ts" : null,
      linkResolved: playableIds.includes(c.id), error: playableIds.includes(c.id) ? null : "No recording" }),
    probe: async () => ({ status: "measured", bytesRead: 188 } as StreamProbeResult),
  });
  const initial = await run();
  assert.equal(initial.channels?.length, 4);
  assert.equal(initial.channels?.find((c) => c.channelId === "1")?.status, "playable");
  assert.equal(initial.channels?.find((c) => c.channelId === "2")?.status, "failed");
  assert.equal(initial.channels?.find((c) => c.channelId === "3")?.status, "failed");
  assert.equal(initial.channels?.find((c) => c.channelId === "4")?.status, "untested");
  assert.equal(initial.genres?.find((g) => g.genreId === "news")?.playableChannels, 1);
  assert.equal(initial.genres?.find((g) => g.genreId === "news")?.untestedChannels, 1);
  assert.equal(initial.genres?.find((g) => g.genreId === "sports")?.failedChannels, 1);
  assert.ok(initial.channels?.filter((c) => c.status !== "untested").every((c) => !!c.checkedAt));
  assert.ok(initial.attempts?.every((a) => a.channelKey && a.channelId && a.genreTitle));

  const disabled = await run(undefined, [], false);
  assert.equal(disabled.status, "not_checked");
  assert.equal(disabled.channels?.length, 4);
  assert.ok(disabled.channels?.every((c) => c.status === "untested" && c.attempts.length === 0));
  assert.deepEqual(mergeCatchUpVerification(initial, disabled), initial); // live-only monitors preserve evidence

  const targeted = await run([archiveChannelKey(candidates[3])], ["4"]);
  assert.equal(targeted.testedChannels, 1);
  const merged = mergeCatchUpVerification(initial, targeted);
  assert.equal(merged.channels?.find((c) => c.channelId === "1")?.status, "playable");
  assert.equal(merged.channels?.find((c) => c.channelId === "4")?.status, "playable");
  assert.equal(merged.channels?.find((c) => c.channelId === "2")?.status, "failed");
  assert.equal(merged.genres?.find((g) => g.genreId === "news")?.playableChannels, 2);
  assert.equal(merged.testedChannels, 4);
  assert.equal(merged.limited, false);

  // A failed, more recent recheck replaces success for ONLY that channel.
  const failed = await run(["id:1"], []);
  const failedChannel = failed.channels!.find((c) => c.channelId === "1")!;
  failedChannel.checkedAt = "2099-01-01T00:00:00Z";
  const updated = mergeCatchUpVerification(merged, failed);
  assert.equal(updated.channels?.find((c) => c.channelId === "1")?.status, "failed");
  assert.equal(updated.channels?.find((c) => c.channelId === "4")?.status, "playable");
  assert.equal(updated.status, "verified");
  assert.equal(updated.channelName, "Kids");
  // A late network response from an older check must not overwrite the newer failure.
  const stale = await run(["id:1"], ["1"]);
  assert.equal(mergeCatchUpVerification(updated, stale).channels?.find((c) => c.channelId === "1")?.status, "failed");

  const roundTrip = JSON.parse(JSON.stringify(updated));
  assert.deepEqual(catchUpFromReport({ catchUp: roundTrip }), updated);
  assert.match(formatCatchUpInventory(updated), /News \/ Kids \[4\]: archive media playable/);
  assert.match(formatCatchUpInventory(updated), /Regional \/ News HD \[3\]: sampled checks failed/);
  assert.doesNotMatch(JSON.stringify(updated), /http:\/\/fixture/); // no replay URLs/credentials in the inventory

  const html = renderToStaticMarkup(createElement(CatchUpResults, { report: initial, onCheck: () => undefined }));
  assert.match(html, /Saved catch-up availability/);
  assert.match(html, /News/);
  assert.match(html, /Sports/);
  assert.match(html, /Regional/);
  assert.match(html, /Advertised, untested/);
  assert.match(html, /Archive media playable/);
  assert.match(html, /Check next 3 untested channels/);
  assert.match(html, /Check catch-up for News HD \(3\)/);
  console.log("✓ per-channel inventory: stable IDs, genre titles, advertised vs playable/failed/untested");
  console.log("✓ persistence model: JSON round-trip, cumulative batches, live-only preservation, rechecks, stale-response ordering");
  console.log("✓ result display/export: genre groups, statuses, individual/batch controls, no stream URLs");
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
