/**
 * Stream-probe self test / demo.
 *
 *   npx tsx scripts/probe-selftest.ts [url ...]
 *
 * With no arguments it runs a small set of public test streams. Use it to
 * verify the measurement engine works from your own network before trusting a
 * scan's stream-quality verdict.
 */

import { probeStream, scoreStreamProbe } from "../src/lib/stream-probe";

const DEFAULT_URLS = [
  // HLS master playlist with a 1080p variant (Mux test stream).
  "https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8",
  // MPEG-DASH/CMAF (should be classified as dash).
  "https://demo.unified-streaming.com/k8s/features/stable/video/tears-of-steel/tears-of-steel.ism/.m3u8",
  // Direct MPEG-TS stream (bitrate + continuity-counter analysis).
  "https://test-streams.mux.dev/pts_shift/master.m3u8",
];

async function main() {
  const urls = process.argv.slice(2).length > 0 ? process.argv.slice(2) : DEFAULT_URLS;

  for (const url of urls) {
    const started = Date.now();
    const result = await probeStream(url, { sampleMs: 6000, timeoutMs: 8000 });
    const score = scoreStreamProbe(result);

    console.log("=".repeat(78));
    console.log(`URL       ${url}`);
    console.log(`status    ${result.status}  container=${result.container}  http=${result.httpStatus}`);
    console.log(
      `timings   dns=${result.timings.dnsMs} tcp=${result.timings.tcpMs} tls=${result.timings.tlsMs} ttfb=${result.timings.ttfbMs}`
    );
    console.log(
      `throughput sustained=${result.sustainedMbps} Mbps peak=${result.peakMbps} min=${result.minSampleMbps} cv=${result.throughputCoefficientOfVariation}`
    );
    console.log(
      `required  ${result.requiredMbps} Mbps (${result.requiredMbpsSource})  window=${result.sampleWindowMs}ms  bytes=${result.bytesRead}`
    );
    console.log(`media     ${result.resolution?.label ?? "?"} ${result.videoCodec ?? ""} ${result.audioCodec ?? ""}`);
    if (result.hls) {
      console.log(
        `hls       master=${result.hls.isMaster} ladder=${result.hls.variantLadder.length} segments=${result.hls.segmentsOk}/${result.hls.segmentsOk + result.hls.segmentsFailed} ` +
          `deficit=${result.hls.realtimeDeficitMs}ms worstRatio=${result.hls.worstRealtimeRatio} drm=${result.hls.drm ?? "none"}`
      );
    }
    if (result.ts) {
      console.log(
        `ts        packets=${result.ts.packets} bitrate=${result.ts.bitrateMbps} Mbps video=${result.ts.videoBitrateMbps} ` +
          `ccErrors/1000=${result.ts.continuityErrorsPer1000} scrambled=${result.ts.scrambledPackets} pids=${result.ts.pids
            .map((pid) => `${pid.pid}:${pid.kind}${pid.codec ? `(${pid.codec})` : ""}`)
            .join(",")}`
      );
    }
    console.log(`score     overall=${score.overall} speed=${score.speed} quality=${score.quality} stability=${score.stability} → ${score.verdict}`);
    for (const item of score.evidence) console.log(`  · ${item}`);
    for (const item of score.penalties) console.log(`  ! ${item}`);
    for (const item of result.warnings) console.log(`  warn: ${item}`);
    for (const item of result.errors) console.log(`  error: ${item}`);
    console.log(`elapsed   ${Date.now() - started}ms`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
