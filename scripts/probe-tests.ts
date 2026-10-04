/**
 * Stream-probe regression tests against the local fixture server.
 *
 *   node scripts/probe-fixtures.mjs 4599 &
 *   npx tsx scripts/probe-tests.ts [port]
 *
 * Asserts the measurement engine's classification, throughput, MPEG-TS
 * analysis, HLS real-time deficit and DRM detection. No internet access needed.
 */

import { getEventListeners } from "node:events";
import { abortSubscriberCount } from "../src/lib/abort";
import { probeStream, scoreStreamProbe } from "../src/lib/stream-probe";

const PORT = Number(process.argv[2] || process.env.PROBE_FIXTURE_PORT || 4599);
const BASE = `http://127.0.0.1:${PORT}`;

let failures = 0;
let checks = 0;

function check(label: string, condition: boolean, detail?: unknown) {
  checks += 1;
  if (condition) {
    console.log(`  ✓ ${label}`);
  } else {
    failures += 1;
    console.log(`  ✗ ${label}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
  }
}

async function main() {
  // ── 1. HLS master playlist with a ladder ─────────────────────────────────
  {
    console.log("\n[1] HLS master + variant selection + segment sampling");
    const result = await probeStream(`${BASE}/master.m3u8`, { sampleMs: 5000, timeoutMs: 5000 });
    check("container is hls", result.container === "hls", result.container);
    check("status measured", result.status === "measured", result.status);
    check("variant ladder parsed (3)", result.hls?.variantLadder.length === 3, result.hls?.variantLadder.length);
    check("picked the 1080p variant", result.resolution?.height === 1080, result.resolution);
    check("required Mbps from AVERAGE-BANDWIDTH", result.requiredMbps === 2.8, result.requiredMbps);
    check("required source is average-bandwidth", result.requiredMbpsSource === "average-bandwidth");
    check("sampled at least 2 segments", (result.hls?.segmentsOk ?? 0) >= 2, result.hls?.segmentsOk);
    check("sustained throughput measured", (result.sustainedMbps ?? 0) > 1, result.sustainedMbps);
    check("no segment failures", result.hls?.segmentsFailed === 0, result.hls?.segmentsFailed);
    check("codec derived from CODECS", result.videoCodec === "H.264", result.videoCodec);
    check("discontinuity counted", (result.hls?.discontinuityCount ?? 0) >= 1, result.hls?.discontinuityCount);
    const score = scoreStreamProbe(result);
    check("score produced", typeof score.overall === "number", score.overall);
    check("verdict is playable-ish", ["excellent", "good", "fair"].includes(score.verdict), score.verdict);
    console.log(`    → overall=${score.overall} speed=${score.speed} quality=${score.quality} stability=${score.stability}`);
  }

  // ── 2. Broken segments ───────────────────────────────────────────────────
  {
    console.log("\n[2] HLS with failing segments");
    const result = await probeStream(`${BASE}/broken.m3u8`, { sampleMs: 4000, timeoutMs: 3000 });
    check("segment failures counted", (result.hls?.segmentsFailed ?? 0) >= 2, result.hls?.segmentsFailed);
    const score = scoreStreamProbe(result);
    check("stability penalised", (score.stability ?? 10) < 7, score.stability);
    check("verdict degraded", ["poor", "unusable", "fair"].includes(score.verdict), score.verdict);
  }

  // ── 3. Slow segments => real-time deficit ───────────────────────────────
  {
    console.log("\n[3] HLS that cannot keep up with real time");
    const result = await probeStream(`${BASE}/slow.m3u8`, { sampleMs: 22000, timeoutMs: 12000 });
    check("deficit recorded", (result.hls?.realtimeDeficitMs ?? 0) > 1000, result.hls?.realtimeDeficitMs);
    check("worst ratio > 1", (result.hls?.worstRealtimeRatio ?? 0) > 1, result.hls?.worstRealtimeRatio);
    const score = scoreStreamProbe(result);
    check("stability low", (score.stability ?? 10) < 6, score.stability);
    console.log(`    → penalty: ${score.penalties[0]}`);
  }

  // ── 4. DRM ───────────────────────────────────────────────────────────────
  {
    console.log("\n[4] DRM detection");
    const result = await probeStream(`${BASE}/drm.m3u8`, { sampleMs: 4000, timeoutMs: 4000 });
    check("FairPlay detected", result.drm === "FairPlay", result.drm);
    const score = scoreStreamProbe(result);
    check("DRM penalty present", score.penalties.some((item) => /FairPlay/.test(item)), score.penalties);
  }

  // ── 5. VOD/event playlist ───────────────────────────────────────────────
  {
    console.log("\n[5] VOD playlist with ENDLIST");
    const result = await probeStream(`${BASE}/vod.m3u8`, { sampleMs: 4000, timeoutMs: 4000 });
    check("endlist noted", result.notes.some((note) => /ENDLIST/.test(note)), result.notes);
  }

  // ── 6. Raw MPEG-TS with clean continuity ────────────────────────────────
  {
    console.log("\n[6] Direct MPEG-TS stream (clean)");
    const result = await probeStream(`${BASE}/live.ts?seconds=8`, { sampleMs: 6000, timeoutMs: 6000 });
    check("container is mpegts", result.container === "mpegts", result.container);
    check("status measured", result.status === "measured", result.status);
    check("packets analysed", (result.ts?.packets ?? 0) > 500, result.ts?.packets);
    check("no continuity errors", (result.ts?.continuityErrors ?? 1) === 0, result.ts?.continuityErrors);
    check("video PID codec H.264", (result.ts?.videoCodecs ?? []).includes("H.264"), result.ts?.videoCodecs);
    check("audio PID codec AAC", (result.ts?.audioCodecs ?? []).includes("AAC (ADTS)"), result.ts?.audioCodecs);
    check("bitrate ≈ 4 Mbps", Math.abs((result.ts?.bitrateMbps ?? 0) - 4) < 0.9, result.ts?.bitrateMbps);
    check("video bitrate measured", (result.ts?.videoBitrateMbps ?? 0) > 3, result.ts?.videoBitrateMbps);
    const score = scoreStreamProbe(result);
    check("score produced", typeof score.overall === "number", score.overall);
    console.log(`    → overall=${score.overall} speed=${score.speed} quality=${score.quality} stability=${score.stability}`);
  }

  // ── 7. Raw MPEG-TS with continuity errors ───────────────────────────────
  {
    console.log("\n[7] Direct MPEG-TS with transport-stream loss");
    const result = await probeStream(`${BASE}/live.ts?seconds=8&cc=1`, { sampleMs: 6000, timeoutMs: 6000 });
    check("continuity errors detected", (result.ts?.continuityErrors ?? 0) > 3, result.ts?.continuityErrors);
    check("cc/1000 reported", (result.ts?.continuityErrorsPer1000 ?? 0) > 0.05, result.ts?.continuityErrorsPer1000);
    const score = scoreStreamProbe(result);
    check("stability penalised", (score.stability ?? 10) < 9, score.stability);
    check("loss penalty explained", score.penalties.some((item) => /continuity/i.test(item)), score.penalties);
  }

  // ── 8. Non-media payload ────────────────────────────────────────────────
  {
    console.log("\n[8] HTML page instead of a stream");
    const result = await probeStream(`${BASE}/notmedia`, { sampleMs: 3000, timeoutMs: 3000 });
    check("not treated as playable media", result.status === "unplayable" || result.container === "unknown", {
      status: result.status,
      container: result.container,
    });
    check("warning explains payload", result.warnings.some((item) => /Unrecognised payload/.test(item)), result.warnings);
  }

  // ── 9. HTTP error classification ────────────────────────────────────────
  {
    console.log("\n[9] HTTP 403 (geoblock) classification");
    const result = await probeStream(`${BASE}/forbidden`, { sampleMs: 3000, timeoutMs: 3000 });
    check("status http_error", result.status === "http_error", result.status);
    check("geoblock warning", result.warnings.some((item) => /geoblock/i.test(item)), result.warnings);
  }

  // ── 10. Retry / backoff on transient statuses (Wave 1) ──────────────────
  {
    console.log("\n[10] Transient 503 retry (backoff)");
    const seed = Date.now() % 100000;
    const result = await probeStream(`${BASE}/flaky-2-${seed}.m3u8`, { sampleMs: 3000, timeoutMs: 3000, maxRetries: 3 });
    check("eventually measured after retries", result.status === "measured", result.status);
    check("retry counter is reported", result.retryCount >= 2, String(result.retryCount));
    check("retry is explained in notes", result.notes.some((item) => /retr/i.test(item)), result.notes);
    const noRetry = await probeStream(`${BASE}/flaky-always.m3u8`, { sampleMs: 3000, timeoutMs: 3000, maxRetries: 0 });
    check("maxRetries=0 gives up immediately", noRetry.retryCount === 0 && noRetry.status !== "measured", {
      status: noRetry.status,
      retries: noRetry.retryCount,
    });
  }

  // ── 11. Proxy egress (Wave 2) ───────────────────────────────────────────
  {
    console.log("\n[11] Proxy egress through the fixture CONNECT proxy");
    const viaProxy = await probeStream(`${BASE}/live.ts?seconds=6`, {
      sampleMs: 3000,
      timeoutMs: 4000,
      proxy: { host: "127.0.0.1", port: PORT, username: null, password: null, raw: `127.0.0.1:${PORT}` },
    });
    check("proxied stream is measured", viaProxy.status === "measured", { status: viaProxy.status, errors: viaProxy.errors });
    check("proxy is recorded on the result", viaProxy.viaProxy === `127.0.0.1:${PORT}`, viaProxy.viaProxy);
    check("proxied bytes flowed", viaProxy.bytesRead > 100000, viaProxy.bytesRead);

    const deadProxy = await probeStream(`${BASE}/live.ts?seconds=4`, {
      sampleMs: 2000,
      timeoutMs: 2000,
      proxy: { host: "127.0.0.1", port: 1, username: null, password: null, raw: "127.0.0.1:1" },
    });
    check("dead proxy is reported honestly", deadProxy.status === "network_error", deadProxy.status);
    check("dead proxy error names the proxy", deadProxy.errors.some((line) => /proxy/i.test(line)), deadProxy.errors);
  }

  // ── 12. Abort listeners on the shared scan signal ────────────────────────
  {
    console.log("\n[12] Abort listeners are detached when probes settle");
    const controller = new AbortController();
    const native = () => getEventListeners(controller.signal, "abort").length;

    for (let i = 0; i < 15; i += 1) {
      await probeStream(`${BASE}/live.ts?seconds=1`, {
        sampleMs: 400,
        timeoutMs: 4000,
        maxBytes: 200_000,
        signal: controller.signal,
      });
    }
    check("15 probes on one signal leave no subscriber behind", abortSubscriberCount(controller.signal) === 0, String(abortSubscriberCount(controller.signal)));
    check("15 probes keep a single native listener", native() === 1, String(native()));

    // Aborting must still reach an in-flight probe (the fix must not detach
    // the listener before the request is actually finished).
    const midFlight = new AbortController();
    const pending = probeStream(`${BASE}/live.ts?seconds=30`, {
      sampleMs: 20_000,
      timeoutMs: 20_000,
      signal: midFlight.signal,
    });
    setTimeout(() => midFlight.abort(), 300);
    const aborted = await pending;
    check(
      "aborting mid-probe stops it",
      aborted.status === "network_error" && aborted.errors.some((line) => /abort/i.test(line)),
      { status: aborted.status, errors: aborted.errors }
    );
    check("an aborted probe leaves no subscriber behind", abortSubscriberCount(midFlight.signal) === 0);
    check("an aborted probe removes its native listener", getEventListeners(midFlight.signal, "abort").length === 0);
  }

  console.log(`\n${checks - failures}/${checks} checks passed`);
  if (failures > 0) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
