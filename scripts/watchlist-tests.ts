/**
 * Offline tests for the channel watch list (fuzzy name matching).
 *
 *   npx tsx scripts/watchlist-tests.ts
 */
import assert from "node:assert/strict";
import { matchWatchQuery, parseWatchlist, selectWatchlistChannels, normalizeChannelName } from "../src/lib/channel-watchlist";

type Ch = { name: string; id: string; genreId: string };
let n = 0;
const ch = (name: string, id: string): Ch => ({ name, id, genreId: "1" });
const names = (c: Ch[]) => c.map((x) => x.name);
function t(label: string, fn: () => void) {
  fn();
  n += 1;
  console.log(`  ✓ ${label}`);
}

const portal: Ch[] = [
  ch("NL: NPO 1 HD", "a"),
  ch("NPO 2", "b"),
  ch("RTL4 FHD", "c"),
  ch("RTL 5", "d"),
  ch("ZIGGO", "e"),
  ch("ZIGGO", "f"), // same name twice: both must be kept
  ch("ZIGGO SPORT 1", "g"),
  ch("Ziggo Sport 2", "h"),
  ch("BBC One", "i"),
  ch("NPO 3", "j"),
];

console.log("channel watch list");

t("parseWatchlist splits comma/semicolon/newline, trims, dedupes case-insensitively", () => {
  assert.deepEqual(parseWatchlist(" NPO 1, rtl 4;ZIGGO\nnpo 1 ,, "), ["NPO 1", "rtl 4", "ZIGGO"]);
  assert.deepEqual(parseWatchlist(null), []);
  assert.deepEqual(parseWatchlist(""), []);
});

t("normalisation strips country prefix, quality tags and punctuation", () => {
  assert.equal(normalizeChannelName("NL: NPO 1 HD"), "npo 1");
  assert.equal(normalizeChannelName("RTL 4 (Backup) FHD"), "rtl 4");
  assert.equal(normalizeChannelName("NPO1"), "npo1");
});

t("'NPO 1' matches 'NL: NPO 1 HD' exactly and not 'NPO 2' / 'NPO 3'", () => {
  const m = matchWatchQuery("NPO 1", portal);
  assert.equal(m.tier, "exact");
  assert.deepEqual(names(m.channels), ["NL: NPO 1 HD"]);
});

t("'NPO1' (no space) still finds 'NPO 1'", () => {
  assert.equal(matchWatchQuery("NPO1", portal).tier, "exact");
});

t("'RTL 4' finds 'RTL4 FHD' (space/quality tag insensitive)", () => {
  const m = matchWatchQuery("RTL 4", portal);
  assert.equal(m.tier, "exact");
  assert.deepEqual(names(m.channels), ["RTL4 FHD"]);
});

t("'ZIGGO' returns every channel with that name (duplicates are kept)", () => {
  const m = matchWatchQuery("ziggo", portal);
  assert.equal(m.tier, "exact");
  assert.deepEqual(m.channels.map((c) => c.id), ["e", "f"]);
});

t("exact match wins over word match (ZIGGO does not pull in ZIGGO SPORT)", () => {
  assert.ok(!matchWatchQuery("ZIGGO", portal).channels.some((c) => c.id === "g"));
});

t("word match is used only when no exact name exists", () => {
  const m = matchWatchQuery("ziggo sport", portal);
  assert.equal(m.tier, "word");
  assert.deepEqual(m.channels.map((c) => c.id), ["g", "h"]);
});

t("fuzzy match tolerates a small typo ('Zigo' → ZIGGO) but not a different number", () => {
  const typo = matchWatchQuery("Zigo", portal);
  assert.equal(typo.tier, "fuzzy");
  assert.deepEqual(typo.channels.map((c) => c.id), ["e", "f"]);
  assert.equal(matchWatchQuery("NPO 9", portal).tier, "none");
  assert.equal(matchWatchQuery("RTL 9", portal).tier, "none");
});

t("unknown channel reports tier 'none' with no channels", () => {
  const m = matchWatchQuery("Eurosport 99", portal);
  assert.equal(m.tier, "none");
  assert.deepEqual(m.channels, []);
});

t("selectWatchlistChannels tags each channel with its query and never probes a channel twice", () => {
  const { selected, matches } = selectWatchlistChannels(portal, ["NPO 1", "RTL 4", "ZIGGO", "NPO 1"]);
  assert.equal(matches.length, 4);
  // NPO 1 is listed twice, but selection must never probe the same channel object twice.
  const ids = selected.map((s) => s.channel.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.deepEqual(ids, ["a", "c", "e", "f"]);
  assert.equal(selected.find((s) => s.channel.id === "e")?.query, "ZIGGO");
});

t("channels with identical names and no ids are still both selected", () => {
  const noId = [
    { name: "ZIGGO", id: "", genreId: "" },
    { name: "ZIGGO", id: "", genreId: "" },
  ];
  const { selected } = selectWatchlistChannels(noId, ["ZIGGO"]);
  assert.equal(selected.length, 2);
});

console.log(`\n${n} checks passed`);
