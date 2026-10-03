/**
 * Xtream Codes integration suite (Wave 3).
 *
 *   npm run fixtures            # terminal 1: mock portal + Xtream API on :4599
 *   npm run test:xtream         # terminal 2
 *
 * The mock Xtream panel serves the same synthetic transport streams as the
 * Stalker fixtures, so this suite proves the Xtream client drives the shared
 * measurement engine end to end (login → categories → streams → probe →
 * aggregate) without touching the internet.
 */

import { checkXtreamAccountQuality, selectXtreamStreams } from "../src/lib/xtream-quality";
import {
  parseXtreamUrl,
  xtreamAccount,
  xtreamCategories,
  xtreamLiveStreams,
} from "../src/lib/xtream-streams";

const BASE = process.env.PROBE_FIXTURE_ORIGIN || "http://127.0.0.1:4599";

let passed = 0;
let failed = 0;

function check(name: string, condition: boolean, detail?: string) {
  if (condition) {
    passed += 1;
    console.log(`  ✓ ${name}`);
  } else {
    failed += 1;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

async function main() {
  console.log(`Xtream integration suite against ${BASE}`);

  const demo = parseXtreamUrl(`${BASE}/player_api.php?username=demo&password=demo-pass`);
  const expired = parseXtreamUrl(`${BASE}/player_api.php?username=expired&password=old-pass`);
  const badPassword = parseXtreamUrl(`${BASE}/player_api.php?username=demo&password=wrong`);
  if (!demo || !expired || !badPassword) {
    console.error("Could not parse the fixture URLs — is the fixture server running?");
    process.exit(1);
  }

  // ── 1. Login ─────────────────────────────────────────────────────────────
  const login = await xtreamAccount(demo, { timeoutMs: 5000 });
  check("valid credentials authenticate", login.auth === true, login.error || "");
  check("account status is reported", login.account?.status === "Active");
  check("expiry date is reported", login.account?.expiryDate === "2030-12-31");

  const wrong = await xtreamAccount(badPassword, { timeoutMs: 5000 });
  check("wrong password fails authentication", wrong.auth === false);

  const expiredLogin = await xtreamAccount(expired, { timeoutMs: 5000 });
  check("expired account still reports its status", expiredLogin.auth === true && expiredLogin.account?.status === "Expired");

  // ── 2. Catalogue ─────────────────────────────────────────────────────────
  const [categories, streams] = await Promise.all([
    xtreamCategories(demo, "live", { timeoutMs: 5000 }),
    xtreamLiveStreams(demo, { timeoutMs: 5000 }),
  ]);
  check("live categories are listed", categories.length === 2, String(categories.length));
  check("category titles are available", categories.some((category) => category.name.includes("News")));
  check("live streams are listed", streams.length === 3, String(streams.length));
  check("archive info is parsed", streams.find((stream) => stream.id === "101")?.tvArchive === true);

  // ── 3. Selection spread across categories ────────────────────────────────
  const selection = selectXtreamStreams(streams, 2);
  check("selection respects the channel budget", selection.length === 2);
  const selectedCategories = new Set(selection.map((stream) => stream.categoryId));
  check("selection spreads across categories", selectedCategories.size === 2, [...selectedCategories].join(","));

  // ── 4. End-to-end measurement through the shared engine ──────────────────
  const { report, account, error } = await checkXtreamAccountQuality({
    credentials: demo,
    channelsToProbe: 2,
    sampleMs: 4000,
    timeoutMs: 5000,
    pictureChecks: false, // ffmpeg is optional and usually absent
    thumbnails: false,
  });

  check("quality check produces a report", !!report, error || "");
  check("account summary is attached", account?.liveStreams === 3 && account?.categories === 2);
  if (report) {
    check("report uses the shared v2 format", report.version === 2);
    check("MAC field carries the username", report.mac === "demo");
    check("channels were probed", report.aggregate.channelsProbed >= 1, String(report.aggregate.channelsProbed));
    check("at least one channel is playable", report.aggregate.channelsPlayable >= 1);
    check("an overall score is produced", report.aggregate.overallScore !== null, String(report.aggregate.overallScore));
    check(
      "an honest verdict is produced",
      ["excellent", "good", "fair", "poor", "unusable"].includes(report.aggregate.verdict),
      report.aggregate.verdict
    );
    check("stream URLs are token-redacted", report.channels.every((channel) => !channel.url?.includes("demo-pass")));
    check(
      "limitations are stated",
      report.limitations.length >= 2 && report.limitations.some((line) => line.includes("sampled"))
    );
    check(
      "catch-up is honestly labelled as not verified",
      report.catchUp.status === "not_checked" && report.limitations.some((line) => line.toLowerCase().includes("catch-up"))
    );
    const measured = report.channels.find((channel) => channel.probe);
    check("throughput was measured", (measured?.probe?.sustainedMbps ?? 0) > 0, String(measured?.probe?.sustainedMbps));
  }

  // ── 5. Failure path: bad credentials do not crash the checker ────────────
  const failing = await checkXtreamAccountQuality({ credentials: badPassword, channelsToProbe: 1, sampleMs: 3000 });
  check("bad credentials return an error, not a report", failing.report === null && !!failing.error);

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

void main();
