/**
 * End-to-end test for the Stalker → stream-quality pipeline, against the local
 * mock portal in scripts/probe-fixtures.mjs.
 *
 *   node scripts/probe-fixtures.mjs 4599 &
 *   npx tsx scripts/mac-quality-tests.ts [port]
 *
 * Exercises: handshake → channel listing → create_link per channel →
 * real media probe → aggregation/scoring → M3U export.
 */

// The mock portal serves streams from 127.0.0.1, which the production client
// deliberately rejects as a placeholder; allow it for this offline test only.
process.env.MACATTACK_ALLOW_LOCAL_STREAMS = "1";

import { getEventListeners } from "node:events";
import { abortSubscriberCount } from "../src/lib/abort";
import { checkMacStreamQuality, formatMacQualityLog } from "../src/lib/mac-quality";
import { timeToFirstByteMs } from "../src/lib/stream-probe";
import {
  stalkerHandshake,
  stalkerListChannels,
  selectChannelsForProbe,
  stalkerResolveStream,
  stalkerResolveArchiveLink,
  buildM3U,
} from "../src/lib/stalker-streams";

const PORT = Number(process.argv[2] || process.env.PROBE_FIXTURE_PORT || 4599);
const SERVER_PATH = `http://127.0.0.1:${PORT}/portal.php`;
const PORTAL_BASE = `http://127.0.0.1:${PORT}/c/`;
const MAC = "00:1A:79:11:22:33";

let failures = 0;
let checks = 0;

function check(label: string, condition: boolean, detail?: unknown) {
  checks += 1;
  console.log(`  ${condition ? "✓" : "✗"} ${label}${condition || detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
  if (!condition) failures += 1;
}

async function main() {
  const options = { serverPath: SERVER_PATH, portalBase: PORTAL_BASE, mac: MAC, timeoutMs: 5000 };

  // ── 1. Handshake + channel listing ──────────────────────────────────────
  console.log("\n[1] Handshake and channel listing");
  const handshake = await stalkerHandshake(options);
  check("token returned", handshake.token === "TOKEN-abc123", handshake.token);

  const list = await stalkerListChannels(options, handshake.token as string, { maxChannels: 50 });
  check("channels listed via get_all_channels", list.source === "get_all_channels" && list.channels.length === 5, {
    source: list.source,
    count: list.channels.length,
  });
  check("channel names parsed", list.channels[0]?.name === "News HD", list.channels[0]);

  // ── 2. create_link resolution ───────────────────────────────────────────
  console.log("\n[2] create_link resolution");
  const news = list.channels[0];
  const resolvedNews = await stalkerResolveStream(options, handshake.token as string, news);
  check("direct URL kept without a portal call", resolvedNews.url?.includes("/variant/1080/index.m3u8") === true, resolvedNews.url);

  // This channel's cmd is portal-relative, so the client must call create_link;
  // the mock answers with a dead URL — mirroring a broken/expired channel link.
  const movies = list.channels.find((channel) => channel.name === "Movies")!;
  const resolvedMovies = await stalkerResolveStream(options, handshake.token as string, movies);
  check("portal-relative cmd resolved through create_link", resolvedMovies.url?.includes("does-not-exist") === true, resolvedMovies.url);

  const localhost = await stalkerResolveStream(options, handshake.token as string, {
    id: "9",
    name: "Placeholder",
    genreId: null,
    logo: null,
    cmd: "ffmpeg http://localhost:80/ch/1_",
    tvArchive: false,
    tvArchiveDays: null,
  });
  check("localhost placeholder rejected", localhost.url === null, localhost);

  // ── 3. Selection spread ─────────────────────────────────────────────────
  console.log("\n[3] Channel selection spread");
  const selection = selectChannelsForProbe(list.channels, 3);
  check("exactly 3 selected", selection.length === 3, selection.map((channel) => channel.name));
  check(
    "selection spans multiple genres",
    new Set(selection.map((channel) => channel.genreId)).size > 1,
    selection.map((channel) => channel.genreId)
  );

  // ── 4. Full MAC quality check ───────────────────────────────────────────
  console.log("\n[4] Full MAC quality check (3 channels, 5s samples)");
  const report = await checkMacStreamQuality({
    serverPath: SERVER_PATH,
    portalBase: PORTAL_BASE,
    mac: MAC,
    timeoutMs: 5000,
    channelsToProbe: 3,
    sampleMs: 5000,
  });

  check("report version 2", report.version === 2);
  check("3 channels probed", report.aggregate.channelsProbed === 3, report.aggregate);
  check("aggregate overall score present", typeof report.aggregate.overallScore === "number", report.aggregate.overallScore);
  check("aggregate has speed/quality/stability", [report.aggregate.speedScore, report.aggregate.qualityScore, report.aggregate.stabilityScore].every((value) => typeof value === "number"));
  check("verdict is a known band", ["excellent", "good", "fair", "poor", "unusable"].includes(report.aggregate.verdict), report.aggregate.verdict);
  // Time to first byte: recorded per channel and as a median across channels.
  const measuredFirstBytes = report.channels
    .filter((channel) => channel.probe && channel.probe.status === "measured")
    .map((channel) => timeToFirstByteMs(channel.probe!));
  check(
    "first byte recorded for every measured channel (>= 0 ms)",
    measuredFirstBytes.length > 0 && measuredFirstBytes.every((ms) => typeof ms === "number" && ms >= 0),
    measuredFirstBytes
  );
  check(
    "HLS first byte is the first segment (measured HLS channels), not the playlist",
    report.channels.every(
      (channel) =>
        !channel.probe ||
        channel.probe.status !== "measured" ||
        channel.probe.container !== "hls" ||
        typeof channel.probe.timings?.firstMediaByteMs === "number"
    ),
  );
  check(
    "aggregate first-byte median is present",
    typeof report.aggregate.firstByteMsMedian === "number" && report.aggregate.firstByteMsMedian >= 0,
    report.aggregate.firstByteMsMedian
  );
  check("limitations documented", report.limitations.length >= 3, report.limitations.length);

  const tokens = JSON.stringify(report);
  check("no session token stored in URLs", !/TOKEN-abc123/.test(tokens));
  check("limitation about token stripping present", /session tokens removed/.test(tokens));
  check(
    "stored URLs are redacted notices or query-free",
    report.channels.every((channel) => channel.url === null || !channel.url.includes("?"))
  );

  console.log("\nLog lines the scanner would print:");
  for (const line of formatMacQualityLog(report)) {
    console.log(`   [${line.level}] ${line.message}`);
  }

  // ── 5. M3U export ───────────────────────────────────────────────────────
  console.log("\n[5] M3U export");
  const links: Array<{ channel: typeof list.channels[number]; url: string }> = [];
  for (const channel of list.channels) {
    const link = await stalkerResolveStream(options, handshake.token as string, channel);
    if (link.url) links.push({ channel, url: link.url });
  }
  const m3u = buildM3U(links, "test playlist");
  check("playlist header", m3u.startsWith("#EXTM3U\n"), m3u.slice(0, 12));
  check("EXTINF lines for every link", (m3u.match(/#EXTINF/g) || []).length === links.length, links.length);
  check("genre group titles used", /group-title="Genre /.test(m3u));

  // ── 6. Genre aggregation + catch-up verification (Wave 2/3) ─────────────
  console.log("\n[6] Genre aggregation and catch-up verification");
  check("genre groups are reported", report.genreGroups.length >= 2, report.genreGroups.length);
  check(
    "each genre group counts its channels",
    report.genreGroups.every((group) => group.channelsProbed >= 1 && group.genreTitle.length > 0),
    report.genreGroups
  );
  check(
    "genre groups carry an average where measurable",
    report.genreGroups.some((group) => typeof group.averageOverall === "number"),
    report.genreGroups.map((group) => group.averageOverall)
  );

  const archiveChannel = list.channels.find((channel) => channel.tvArchive);
  check("Ministra archive hours are converted to days", archiveChannel?.tvArchiveDays === 7, archiveChannel?.tvArchiveDays);
  check("the mock portal advertises an archive", !!archiveChannel, list.channels.map((c) => [c.name, c.tvArchive]));

  if (archiveChannel) {
    const nativeWithoutLiveCmd = await stalkerResolveArchiveLink(options, handshake.token as string,
      { ...archiveChannel, cmd: null }, 60, "programme");
    check("native archive needs programme ID, not a live command", !!nativeWithoutLiveCmd.url && nativeWithoutLiveCmd.linkResolved, nativeWithoutLiveCmd.error);
  }

  const catchUpReport = await checkMacStreamQuality({
    serverPath: SERVER_PATH,
    portalBase: PORTAL_BASE,
    mac: MAC,
    timeoutMs: 5000,
    channelsToProbe: 1,
    watchlist: ["Sports FHD"], // Archive lives in News, outside the live sample.
    sampleMs: 4000,
    pictureChecks: false,
    thumbnails: false,
    checkCatchUp: true,
  });
  check("catch-up was attempted", catchUpReport.catchUp.status !== "not_checked", catchUpReport.catchUp);
  check(
    "advertised archive resolves and plays",
    catchUpReport.catchUp.status === "verified" && catchUpReport.catchUp.linkResolved && catchUpReport.catchUp.playable,
    catchUpReport.catchUp
  );
  check(
    "catch-up names the channel and the window",
    !!catchUpReport.catchUp.channelName && (catchUpReport.catchUp.verifiedMinutes ?? 0) > 0,
    catchUpReport.catchUp
  );
  check("archive discovery searches beyond the live watchlist", catchUpReport.channels.every((c) => c.name === "Sports FHD") && catchUpReport.catchUp.channelName === "News HD", catchUpReport.catchUp);
  check("native programme archive method works", catchUpReport.catchUp.attempts?.some((a) => a.method === "programme" && a.playable) === true, catchUpReport.catchUp);
  check("saved inventory includes archive channels outside the live sample", catchUpReport.catchUp.channels?.some((c) => c.channelId === "1" && c.genreTitle === "News" && c.status === "playable") === true, catchUpReport.catchUp.channels);
  check("separate genre/channel failures are retained", catchUpReport.catchUp.genres?.some((g) => g.genreTitle === "Sports" && g.failedChannels === 1) === true, catchUpReport.catchUp.genres);
  check("catch-up bytes were read", (catchUpReport.catchUp.bytesRead ?? 0) > 0, catchUpReport.catchUp.bytesRead);

  // Same job without the flag must not spend time on catch-up.
  const noCatchUp = await checkMacStreamQuality({
    serverPath: SERVER_PATH,
    portalBase: PORTAL_BASE,
    mac: MAC,
    timeoutMs: 5000,
    channelsToProbe: 1,
    sampleMs: 3000,
    checkCatchUp: false,
  });
  check("catch-up can be switched off", noCatchUp.catchUp.status === "not_checked", noCatchUp.catchUp);

  // ── Abort listeners on the shared scan signal ────────────────────────────
  // A scan reuses one AbortController for every MAC and every portal request,
  // so each settled request must detach its abort listener (otherwise Node
  // reports MaxListenersExceededWarning after 10 requests).
  {
    const controller = new AbortController();
    const shared = { ...options, signal: controller.signal };
    let channel: Parameters<typeof stalkerResolveStream>[2] | null = null;
    for (let i = 0; i < 12; i += 1) {
      const handshake = await stalkerHandshake(shared);
      if (!handshake.token) {
        check(`handshake ${i + 1} on the shared signal succeeded`, false, handshake.error || "no token");
        break;
      }
      const listed = await stalkerListChannels(shared, handshake.token);
      channel = channel ?? listed.channels[0] ?? null;
      if (channel) await stalkerResolveStream(shared, handshake.token, channel);
    }
    const lingering = abortSubscriberCount(controller.signal);
    check("36 portal requests leave no subscriber behind", lingering === 0, String(lingering));
    check(
      "36 portal requests keep a single native listener",
      getEventListeners(controller.signal, "abort").length === 1,
      String(getEventListeners(controller.signal, "abort").length)
    );

    let notified = 0;
    controller.signal.addEventListener("abort", () => {
      notified += 1;
    });
    controller.abort();
    check("the shared signal still aborts after all requests", notified === 1, notified);
  }

  console.log(`\n${checks - failures}/${checks} checks passed`);
  if (failures > 0) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
