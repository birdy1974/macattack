/**
 * Wave 1–3 unit suite: pure logic that does not need a network or a database.
 *
 *   npm run test:waves
 *
 * Covers: MAC list parsing, proxy parsing/redaction, label-mismatch detection,
 * user-agent rotation candidates, parallel helpers (pMapLimit/HostRateLimiter),
 * history maths (EWMA/trend/degradation), ffmpeg stderr parsers, thumbnail-store
 * name safety, Xtream URL parsing, and the score caps (freeze/black/mismatch).
 *
 * ffmpeg itself is absent in CI/sandboxes and never bundled, so the picture
 * path is exercised through captured stderr samples.
 */

import { parseMacList, normalizeMac } from "../src/lib/mac-list";
import { parseProxy, parseProxyList, redactProxy } from "../src/lib/proxy";
import { detectLabelMismatch, parseLabelClaim } from "../src/lib/label-mismatch";
import { buildUserAgentCandidates, DEFAULT_USER_AGENTS } from "../src/lib/user-agents";
import { HostRateLimiter, hostOf, pMapLimit } from "../src/lib/parallel";
import { computeEwma, computeTrend, detectDegradation, summariseHistory, type ProbeRun } from "../src/lib/quality-history";
import { parseBlackIntervals, parseFreezeIntervals, parseFfmpegStats } from "../src/lib/ffmpeg-tools";
import { deleteThumbnail, readThumbnail, saveThumbnail } from "../src/lib/thumbnail-store";
import { parseXtreamUrl, xtreamStreamUrl } from "../src/lib/xtream-streams";
import { detectStreamProtocol, probeStream, scoreStreamProbe, type StreamProbeResult } from "../src/lib/stream-probe";
import {
  extractPortalExpiry,
  extractPortalFields,
  isMeaningfulExpiryValue,
  parsePortalDate,
} from "../src/lib/portal-result-fields";
import { expiryPassesFilter, isUnlimitedDate, parseStalkerDate } from "../src/lib/filters";

let passed = 0;
let failed = 0;

/** Suite body: an async main so the file works under the repo's CJS tsx target. */
async function main() {

function check(name: string, condition: boolean, detail?: string) {
  if (condition) {
    passed += 1;
    console.log(`  ✓ ${name}`);
  } else {
    failed += 1;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function section(title: string) {
  console.log(`\n${title}`);
}

// ============================================================================
// 1. BULK MAC LIST (Wave 2)
// ============================================================================
section("Bulk MAC list parsing");
{
  const parsed = parseMacList(
    [
      "# shop boxes",
      "00:1a:79:12:34:56",
      "00-1A-79-AA-BB-CC  # living room",
      "00:1A:79:12:34:56", // duplicate
      "00:11:22:33:44:55,00:11:22:33:44:66",
      "http://other.example.com/c/|00:1A:79:DE:AD:BE",
      "not-a-mac",
    ].join("\n")
  );
  check("normalises upper-case colon form", parsed.macs.includes("00:1A:79:12:34:56"));
  check("accepts dash separators", parsed.macs.includes("00:1A:79:AA:BB:CC"));
  check("de-duplicates", parsed.macs.filter((mac) => mac === "00:1A:79:12:34:56").length === 1);
  check("splits comma-separated entries", parsed.macs.length === 4, parsed.macs.join(","));
  check("routes portal|mac pairs to foreignPortalEntries", parsed.foreignPortalEntries.length === 1);
  check("reports invalid entries", parsed.invalid.length === 1);
  check("normalizeMac rejects nonsense", normalizeMac("hello") === null);
  const capped = parseMacList(Array.from({ length: 20 }, (_, index) => `00:1A:79:00:00:${index.toString(16).padStart(2, "0")}`).join("\n"), 5);
  check("honours the entry cap", capped.macs.length === 5);
}

// ============================================================================
// 2. PROXY POOL (Wave 2)
// ============================================================================
section("Proxy parsing");
{
  const plain = parseProxy("127.0.0.1:8888");
  check("parses host:port", plain?.host === "127.0.0.1" && plain?.port === 8888);
  check("plain proxy has no credentials", plain?.username === null && plain?.password === null);
  const auth = parseProxy("user:secret@proxy.example.com:8080");
  check("parses credentials", auth?.username === "user" && auth?.password === "secret");
  check("redaction hides the password", !!auth && !redactProxy(auth).includes("secret") && redactProxy(auth).includes("(auth)"));
  check("defaults the port when omitted", parseProxy("proxy.example.com")?.port === 8080);
  check("rejects garbage", parseProxy("!! not a proxy !!") === null);
  const list = parseProxyList("a.example.com:1\nb.example.com:2\na.example.com:1\n");
  check("de-duplicates a pool", list.length === 2);
  const big = parseProxyList(Array.from({ length: 80 }, (_, index) => `h${index}.example.com:8080`).join("\n"));
  check("caps the pool at 50", big.length === 50);
}

// ============================================================================
// 3. LABEL MISMATCH (Wave 1)
// ============================================================================
section("Label vs. measured mismatch");
{
  check("parses a 4K claim", parseLabelClaim("SKY SPORTS 4K UHD")?.height === 2160);
  check("parses FHD", parseLabelClaim("CNN FHD")?.height === 1080);
  check("ignores channels without a claim", parseLabelClaim("BBC One") === null);
  check("flags 4K label at 720p", !!detectLabelMismatch("SKY SPORTS 4K", { height: 720, videoBitrateMbps: 4 }));
  check("accepts an honest 1080p FHD label", detectLabelMismatch("CNN FHD", { height: 1080, videoBitrateMbps: 6 }) === null);
  check("flags a 4K label at 4 Mbps when height is unknown", !!detectLabelMismatch("Movie 4K", { height: null, videoBitrateMbps: 4 }));
  check("flags an FHD label at 1.5 Mbps when height is unknown", !!detectLabelMismatch("Movie FHD", { height: null, videoBitrateMbps: 1.5 }));
  check("honest HD bitrate is not flagged", detectLabelMismatch("Movie HD", { height: null, videoBitrateMbps: 2 }) === null);
  check("says nothing without a measurement", detectLabelMismatch("Movie 4K", { height: null, videoBitrateMbps: null }) === null);
}

// ============================================================================
// 4. USER AGENTS (Wave 1)
// ============================================================================
section("User-agent rotation");
{
  check("has sensible defaults", DEFAULT_USER_AGENTS.length >= 4);
  const candidates = buildUserAgentCandidates("Custom/1.0", ["Extra/2.0"]);
  check("remembered UA is tried first", candidates[0] === "Custom/1.0");
  check("custom entries come next", candidates[1] === "Extra/2.0");
  // A configured list replaces (not extends) the defaults…
  check("configured list replaces the defaults", !candidates.includes(DEFAULT_USER_AGENTS[1]));
  // …while an empty configuration keeps the built-ins available.
  check("built-ins are used when nothing is configured", buildUserAgentCandidates(null, []).includes(DEFAULT_USER_AGENTS[0]));
  check(
    "no duplicates when remembered is built-in",
    buildUserAgentCandidates(DEFAULT_USER_AGENTS[0], []).filter((ua) => ua === DEFAULT_USER_AGENTS[0]).length === 1
  );
}

// ============================================================================
// 5. PARALLEL HELPERS (Wave 2)
// ============================================================================
section("Capped concurrency");
{
  let active = 0;
  let peak = 0;
  const items = Array.from({ length: 12 }, (_, index) => index);
  const results = await pMapLimit(items, 3, async (item) => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 10));
    active -= 1;
    return item * 2;
  });
  check("returns all results in order", results.join(",") === items.map((item) => item * 2).join(","));
  check("never exceeds the limit", peak <= 3, `peak ${peak}`);

  check("hostOf extracts the hostname", hostOf("http://portal.example.com:8080/c/") === "portal.example.com");
  const limiter = new HostRateLimiter(50);
  const started = Date.now();
  await Promise.all([limiter.wait("a.example.com"), limiter.wait("a.example.com"), limiter.wait("b.example.com")]);
  const elapsed = Date.now() - started;
  check("rate limiter spaces same-host requests", elapsed >= 40, `${elapsed} ms`);
}

// ============================================================================
// 6. HISTORY MATHS (Wave 2)
// ============================================================================
section("Probe history (EWMA / trend / degradation)");
{
  check("EWMA ignores nulls", computeEwma([null, 5, null, 5]) === 5);
  check("EWMA weights recent runs", (computeEwma([10, 0]) ?? 0) === 7);
  check("EWMA returns null with no data", computeEwma([null, null]) === null);
  check("trend needs four runs", computeTrend([8, 8, 8]) === "insufficient_data");
  check("detects improvement", computeTrend([4, 4, 8, 8]) === "improving");
  check("detects degradation", computeTrend([8, 8, 4, 4]) === "degrading");
  check("small wobble is stable", computeTrend([7, 7.2, 7.1, 7.3]) === "stable");

  const makeRun = (overall: number | null): ProbeRun => ({
    id: 1,
    resultId: 1,
    measuredAt: new Date().toISOString(),
    overall,
    speed: null,
    quality: null,
    stability: null,
    verdict: null,
    throughputMbps: null,
    requiredMbps: null,
    channelsPlayable: null,
    channelsProbed: null,
  });
  const summary = summariseHistory([makeRun(4), makeRun(6), makeRun(8)]);
  check("summary reports best/worst", summary.bestOverall === 8 && summary.worstOverall === 4);
  const healthy = detectDegradation([makeRun(8), makeRun(8.2), makeRun(7.9)]);
  check("stable history is not a degradation", healthy.degraded === false);
  const dropped = detectDegradation([makeRun(8), makeRun(8), makeRun(4)]);
  check("large drop triggers degradation", dropped.degraded === true && (dropped.drop ?? 0) >= 1.5);
  check("single run cannot degrade", detectDegradation([makeRun(1)]).degraded === false);
}

// ============================================================================
// 7. FFMPEG STDERR PARSERS (Wave 2) — no ffmpeg binary required
// ============================================================================
section("ffmpeg output parsers");
{
  const stderr = [
    "[freezedetect @ 0x55] lavfi.freezedetect.freeze_start: 3.2",
    "[freezedetect @ 0x55] lavfi.freezedetect.freeze_duration: 6.4",
    "[freezedetect @ 0x55] lavfi.freezedetect.freeze_end: 9.6",
    "[blackdetect @ 0x55] black_start:0 black_end:2.5 black_duration:2.5",
    "frame=  240 fps= 30 q=-0.0 size=N/A time=00:00:08.00 bitrate= 4096.0kbits/s",
    "frame=  480 fps= 25 q=-0.0 size=N/A time=00:00:16.00 bitrate= 3500.4kbits/s",
  ].join("\n");

  const freezes = parseFreezeIntervals(stderr);
  check("parses a freeze interval", freezes.length === 1 && freezes[0].durationSec === 6.4);
  const blacks = parseBlackIntervals(stderr);
  check("parses a black interval", blacks.length === 1 && blacks[0].durationSec === 2.5);
  const stats = parseFfmpegStats(stderr);
  check("takes the last fps figure", stats.fps === 25);
  check("takes the last duration", stats.durationSec === 16, String(stats.durationSec));
  check("takes the frame count", stats.frames === 480);
  check("parses a partial stream (no freeze lines)", parseFreezeIntervals("frame=1 fps=25").length === 0);
}

// ============================================================================
// 8. SCORE CAPS (Wave 2)
// ============================================================================
section("Score caps for hard evidence");
{
  const baseProbe: StreamProbeResult = {
    url: "http://example.com/live.ts",
    finalUrl: "http://example.com/live.ts",
    redirectChain: [],
    status: "measured",
    httpStatus: 200,
    contentType: "video/mp2t",
    container: "mpegts",
    requiredMbps: 4,
    requiredMbpsSource: "segment-mean",
    sustainedMbps: 12,
    peakMbps: 14,
    minSampleMbps: 10,
    throughputCoefficientOfVariation: 0.05,
    throughputSamples: [],
    maxGapMs: 120,
    sampleWindowMs: 8000,
    bytesRead: 12_000_000,
    timings: { dnsMs: 5, tcpMs: 10, tlsMs: 20, firstByteMs: 120, ttfbMs: 120 },
    hls: null,
    ts: null,
    resolution: { width: 1920, height: 1080, label: "1080p" },
    videoCodec: "h264",
    audioCodec: "aac",
    drm: null,
    retryCount: 0,
    protocol: "http",
    viaProxy: null,
    errors: [],
    warnings: [],
    notes: [],
    measuredAt: new Date().toISOString(),
  } satisfies StreamProbeResult;

  const clean = scoreStreamProbe(baseProbe);
  check("a clean stream scores highly", (clean.overall ?? 0) >= 7, String(clean.overall));

  const frozen = scoreStreamProbe(baseProbe, {
    picture: { analyzed: true, frozenDetected: true, blackDetected: false, frozenDurationSec: 6, blackDurationSec: 0, fps: 25, videoBitrateMbps: 4 },
  });
  check("frozen picture caps stability", (frozen.stability ?? 10) <= 1.5, String(frozen.stability));
  check("frozen picture caps quality", (frozen.quality ?? 10) <= 5, String(frozen.quality));
  check("frozen picture is flagged", frozen.frozen === true);

  const black = scoreStreamProbe(baseProbe, {
    picture: { analyzed: true, frozenDetected: false, blackDetected: true, frozenDurationSec: 0, blackDurationSec: 5, fps: 25, videoBitrateMbps: 4 },
  });
  check("black picture caps stability", (black.stability ?? 10) <= 2.5, String(black.stability));

  const mislabeled = scoreStreamProbe(baseProbe, { labelMismatch: "Label says 4K but the stream delivers 720p" });
  check("label mismatch caps quality", (mislabeled.quality ?? 10) <= 6, String(mislabeled.quality));
  check(
    "label mismatch is surfaced to the user",
    mislabeled.penalties.some((line) => line.toLowerCase().includes("label"))
  );
  check("bitrate-only mismatch is detected when no height is known", !!detectLabelMismatch("Movie HD", { height: null, videoBitrateMbps: 1 }));
}

// ============================================================================
// 8b. NON-HTTP TRANSPORT LIVENESS (Wave 3)
// ============================================================================
section("RTSP / RTMP / UDP handling");
{
  check("classifies rtsp", detectStreamProtocol("rtsp://host:554/live/1") === "rtsp");
  check("classifies rtmp", detectStreamProtocol("rtmp://host/app/stream") === "rtmp");
  check("classifies udp", detectStreamProtocol("udp://@239.0.0.1:1234") === "udp");
  check("classifies http", detectStreamProtocol("http://host/live.ts") === "http");

  // A closed port on the loopback interface must be reported as unreachable,
  // and a UDP URL as unverifiable — never as "measured".
  const dead = await probeStream("rtsp://127.0.0.1:1/dead", { timeoutMs: 1500 });
  check("dead RTSP host is not measured", dead.status !== "measured", dead.status);
  check("dead RTSP reports the transport", dead.protocol === "rtsp");
  check("dead RTSP surfaces an error", dead.errors.length > 0);

  const udp = await probeStream("udp://@239.1.2.3:5000", { timeoutMs: 1500 });
  check("UDP is honestly unverifiable", udp.status === "unverifiable", udp.status);
  check("UDP carries no fabricated speeds", udp.sustainedMbps === null && udp.requiredMbps === null);

  const ftp = await probeStream("ftp://host/file.ts", { timeoutMs: 1500 });
  check("unknown schemes stay unsupported", ftp.status === "unsupported_scheme", ftp.status);
}

// ============================================================================
// 9. THUMBNAIL STORE SAFETY (Wave 2)
// ============================================================================
section("Thumbnail store");
{
  const saved = await saveThumbnail("wave-test-frame", Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
  check("saves a valid name", typeof saved === "string" && saved.endsWith(".jpg"));
  if (saved) {
    const roundTrip = await readThumbnail(saved);
    check("reads back the bytes", !!roundTrip && roundTrip.length === 4);
  }
  check("rejects path traversal", (await readThumbnail("../../etc/passwd")) === null);
  check("rejects unknown files", (await readThumbnail("definitely-not-here.jpg")) === null);
  if (saved) await deleteThumbnail(saved);
}

// ============================================================================
// 10. XTREAM URL PARSING (Wave 3)
// ============================================================================
section("Xtream URL parsing");
{
  const player = parseXtreamUrl("http://host.example.com:8080/player_api.php?username=bob&password=pw1");
  check("parses player_api.php", player?.username === "bob" && player?.password === "pw1");
  check("keeps the origin, drops the path", player?.base === "http://host.example.com:8080");
  const get = parseXtreamUrl("http://host.example.com:8080/get.php?username=bob&password=pw1&type=m3u_plus&output=ts");
  check("parses get.php", get?.endpoint === "get" && get?.username === "bob");
  check("requires both credentials", parseXtreamUrl("http://host.example.com:8080/get.php?username=bob") === null);
  check("rejects non-URLs", parseXtreamUrl("not a url") === null);
  check("rejects a URL with no credentials", parseXtreamUrl("http://host.example.com:8080/get.php") === null);

  const url = xtreamStreamUrl(
    { base: "http://host.example.com:8080", username: "bob", password: "pw1", endpoint: "player_api" },
    "4321",
    "ts"
  );
  check("builds a live stream URL", url === "http://host.example.com:8080/live/bob/pw1/4321.ts", url);
  const m3u8 = xtreamStreamUrl(
    { base: "http://host.example.com:8080", username: "bob", password: "pw1", endpoint: "player_api" },
    "4321",
    "m3u8"
  );
  check("builds an HLS variant URL", m3u8.endsWith("/4321.m3u8"), m3u8);
}

// ============================================================================
// 11. STALKER EXPIRY / `phone` FIELD EXTRACTION & PARSING
// ============================================================================
section("Stalker expire date extraction (from `phone` field)");
{
  // Classic Stalker bug: get_profile has expire_billing_date = "0000-00-00 00:00:00"
  // while get_main_info has the actual expiry date in `phone`.
  const profileWithZeroBilling = {
    id: "123",
    mac: "00:1A:79:11:22:33",
    phone: "",
    expire_billing_date: "0000-00-00 00:00:00",
    end_date: "0000-00-00",
  };
  const accountWithPhoneExpiry = {
    mac: "00:1A:79:11:22:33",
    phone: "March 15, 2027, 2:30 pm",
  };
  const fields1 = extractPortalFields(profileWithZeroBilling, accountWithPhoneExpiry);
  check(
    "records account.phone instead of profile.expire_billing_date zero placeholder",
    fields1.expireDate === "March 15, 2027, 2:30 pm",
    fields1.expireDate ?? "null"
  );
  check("records provenance as account.phone", fields1.provenance.expireDate === "account.phone");
  check("leaves phoneNumber empty when only Stalker `phone` is present", fields1.phoneNumber === null);

  // When get_main_info returns empty `phone` and get_profile carries `phone`,
  // profile.phone must not be overwritten by the empty string.
  const profileWithPhoneDate = {
    id: "123",
    phone: "2027-08-19 23:59:59",
    expire_billing_date: "0000-00-00 00:00:00",
  };
  const accountWithEmptyPhone = {
    mac: "00:1A:79:11:22:33",
    phone: "",
  };
  check(
    "falls back to profile.phone when account.phone is empty",
    extractPortalExpiry(profileWithPhoneDate, accountWithEmptyPhone) === "2027-08-19 23:59:59"
  );

  // When `phone` has the real expiry date and `expire_billing_date` has a stale
  // internal timestamp, `phone` (the original "phone number" field) wins.
  check(
    "prioritises `phone` over stale `expire_billing_date`",
    extractPortalExpiry(
      { expire_billing_date: "2021-01-01 00:00:00" },
      { phone: "2027-12-31" }
    ) === "2027-12-31"
  );

  // When `phone` is absent/empty and `end_date` is "0000-00-00", a real
  // `expire_billing_date` is still recovered.
  check(
    "skips zero end_date to find valid expire_billing_date",
    extractPortalExpiry(
      { end_date: "0000-00-00", expire_billing_date: "2027-06-01 00:00:00" },
      { mac: "00:1A:79:11:22:33" }
    ) === "2027-06-01 00:00:00"
  );

  // When only zero-date placeholders exist, returns "" instead of "0000-00-00 00:00:00".
  check(
    "does not record 0000-00-00 00:00:00 as an expire date",
    extractPortalExpiry(profileWithZeroBilling, accountWithEmptyPhone) === ""
  );
  check("rejects zero-date in isMeaningfulExpiryValue", !isMeaningfulExpiryValue("0000-00-00 00:00:00"));

  // Date parsing across Stalker `phone` formats.
  check("parses human-readable Stalker `phone` date", parseStalkerDate("March 15, 2027, 2:30 pm")?.toISOString().startsWith("2027-03-15") === true);
  check("parses DD-MM-YYYY Stalker `phone` date", parseStalkerDate("15-03-2027")?.toISOString().slice(0, 10) === "2027-03-15");
  check("parses DD.MM.YYYY HH:MM Stalker `phone` date", parseStalkerDate("15.03.2027 14:30")?.toISOString().slice(0, 10) === "2027-03-15");
  check("parses 15 Mar 2027", parsePortalDate("15 Mar 2027")?.toISOString().slice(0, 10) === "2027-03-15");
  check("treats 'Unlimited' as unlimited", isUnlimitedDate("Unlimited"));
  check(
    "expire filter accepts human-readable future `phone` date",
    expiryPassesFilter({ enabled: true, minDate: "2027-01-01", includeUnlimited: false }, "March 15, 2027, 2:30 pm").pass
  );
}

// ============================================================================
// SUMMARY
// ============================================================================
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
}

void main();
