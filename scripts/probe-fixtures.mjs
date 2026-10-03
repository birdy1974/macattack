#!/usr/bin/env node
/**
 * Deterministic IPTV fixture server for the stream-probe test suite.
 *
 *   node scripts/probe-fixtures.mjs [port]
 *
 * Serves synthetic HLS playlists, MPEG-TS segments and a live TS stream so the
 * probe engine can be verified without touching the internet. Everything here
 * is generated locally; it never contacts a third party.
 */

import http from "node:http";

const PORT = Number(process.argv[2] || process.env.PROBE_FIXTURE_PORT || 4599);

// ---------------------------------------------------------------------------
// MPEG-TS generation
// ---------------------------------------------------------------------------

const VIDEO_PID = 0x0101;
const AUDIO_PID = 0x0102;
const PMT_PID = 0x1000;

function tsPacket(pid, payload, cc, { pusi = false, scrambled = false } = {}) {
  const packet = Buffer.alloc(188, 0xff);
  packet[0] = 0x47;
  packet[1] = (pusi ? 0x40 : 0x00) | ((pid >> 8) & 0x1f);
  packet[2] = pid & 0xff;
  packet[3] = (scrambled ? 0x80 : 0x00) | 0x10 | (cc & 0x0f); // payload-only, CC
  payload.copy(packet, 4, 0, Math.min(payload.length, 184));
  return packet;
}

function patPackets(cc = 0) {
  const section = Buffer.from([
    0x00, 0x00, 0x0d, // table_id, section_length = 13
    0x00, 0x01, // transport_stream_id
    0xc1, 0x00, 0x00, // version/current, section_number, last_section_number
    0x00, 0x01, // program_number
    0xe0 | ((PMT_PID >> 8) & 0x1f), PMT_PID & 0xff, // PMT PID
    0x00, 0x00, 0x00, 0x00, // CRC (unused by the parser)
  ]);
  // PSI sections start with a pointer_field (0x00) when PUSI is set.
  return tsPacket(0x0000, Buffer.concat([Buffer.from([0x00]), section]), cc, { pusi: true });
}

function pmtPackets(cc = 0) {
  const section = Buffer.from([
    0x02, 0x00, 0x17, // table_id, section_length = 23
    0x00, 0x01, // program_number
    0xc1, 0x00, 0x00, // version, section_number, last_section_number
    0xe0 | ((VIDEO_PID >> 8) & 0x1f), VIDEO_PID & 0xff, // PCR PID
    0xf0, 0x00, // program_info_length = 0
    0x1b, 0xe0 | ((VIDEO_PID >> 8) & 0x1f), VIDEO_PID & 0xff, 0xf0, 0x00, // H.264
    0x0f, 0xe0 | ((AUDIO_PID >> 8) & 0x1f), AUDIO_PID & 0xff, 0xf0, 0x00, // AAC
    0x00, 0x00, 0x00, 0x00, // CRC
  ]);
  return tsPacket(PMT_PID, Buffer.concat([Buffer.from([0x00]), section]), cc, { pusi: true });
}

/**
 * Build a transport stream.
 * @param {object} options
 * @param {number} options.seconds
 * @param {number} options.mbps
 * @param {number} options.continuityErrors  deliberate CC jumps
 * @param {boolean} options.scrambled
 */
function buildTransportStream({ seconds = 6, mbps = 4, continuityErrors = 0, scrambled = false } = {}) {
  const totalBytes = Math.round((mbps * 1_000_000 * seconds) / 8);
  const videoPackets = Math.floor((totalBytes * 0.92) / 188);
  const audioPackets = Math.max(1, Math.floor((totalBytes * 0.05) / 188));
  const chunks = [];

  let patCc = 0;
  let pmtCc = 0;
  let videoCc = 0;
  let audioCc = 0;
  let errorsLeft = continuityErrors;

  const payload = Buffer.alloc(184);
  for (let i = 0; i < payload.length; i += 1) payload[i] = (i * 7 + 11) & 0xff;

  const totalPackets = videoPackets + audioPackets;
  for (let i = 0; i < totalPackets; i += 1) {
    // PSI tables every ~200ms (~50 packets at 4 Mbps)
    if (i % 50 === 0) {
      chunks.push(patPackets(patCc));
      patCc = (patCc + 1) & 0x0f;
      chunks.push(pmtPackets(pmtCc));
      pmtCc = (pmtCc + 1) & 0x0f;
      continue;
    }

    const isVideo = i % 14 !== 13;
    if (isVideo) {
      if (errorsLeft > 0 && i % 97 === 0) {
        videoCc = (videoCc + 3) & 0x0f; // jump -> continuity error
        errorsLeft -= 1;
      }
      chunks.push(tsPacket(VIDEO_PID, payload, videoCc, { scrambled }));
      videoCc = (videoCc + 1) & 0x0f;
    } else {
      chunks.push(tsPacket(AUDIO_PID, payload, audioCc, { scrambled }));
      audioCc = (audioCc + 1) & 0x0f;
    }
  }

  return Buffer.concat(chunks);
}

// ---------------------------------------------------------------------------
// HLS playlists
// ---------------------------------------------------------------------------

const SEGMENT_SECONDS = 4;

function mediaPlaylist(baseUrl, { count = 6, segmentPath = "/seg", broken = false, endlist = false } = {}) {
  const lines = [
    "#EXTM3U",
    "#EXT-X-VERSION:3",
    `#EXT-X-TARGETDURATION:${SEGMENT_SECONDS}`,
    "#EXT-X-MEDIA-SEQUENCE:1000",
  ];
  for (let i = 0; i < count; i += 1) {
    if (i === 3) lines.push("#EXT-X-DISCONTINUITY");
    lines.push(`#EXTINF:${SEGMENT_SECONDS}.000,`);
    lines.push(`${baseUrl}${segmentPath}/seg${i}.ts${broken ? "?status=404" : ""}`);
  }
  if (endlist) lines.push("#EXT-X-ENDLIST");
  return `${lines.join("\n")}\n`;
}

function masterPlaylist(baseUrl, variantPath = "/variant") {
  return [
    "#EXTM3U",
    '#EXT-X-STREAM-INF:BANDWIDTH=800000,AVERAGE-BANDWIDTH=700000,RESOLUTION=854x480,CODECS="avc1.4d401e,mp4a.40.2"',
    `${baseUrl}${variantPath}/480/index.m3u8`,
    '#EXT-X-STREAM-INF:BANDWIDTH=3200000,AVERAGE-BANDWIDTH=2800000,RESOLUTION=1920x1080,CODECS="avc1.640028,mp4a.40.2"',
    `${baseUrl}${variantPath}/1080/index.m3u8`,
    '#EXT-X-STREAM-INF:BANDWIDTH=1800000,AVERAGE-BANDWIDTH=1600000,RESOLUTION=1280x720,CODECS="avc1.4d401f,mp4a.40.2"',
    `${baseUrl}${variantPath}/720/index.m3u8`,
    "",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------


// ---------------------------------------------------------------------------
// Mock Stalker portal (handshake / channels / create_link)
// ---------------------------------------------------------------------------

const CHANNELS = [
  { id: "1", name: "News HD", tv_genre_id: "2", cmd: "ffmpeg http://127.0.0.1:PORT/variant/1080/index.m3u8", logo: "" },
  { id: "2", name: "Sports FHD", tv_genre_id: "3", cmd: "http://127.0.0.1:PORT/live.ts?seconds=30", logo: "" },
  { id: "3", name: "Movies", tv_genre_id: "4", cmd: "ffmpeg /media/broken.m3u8", logo: "" },
  { id: "4", name: "Kids", tv_genre_id: "2", cmd: "ffmpeg http://127.0.0.1:PORT/vod.m3u8", logo: "" },
  { id: "5", name: "Music", tv_genre_id: "5", cmd: "ffmpeg http://127.0.0.1:PORT/drm.m3u8", logo: "" },
].map((channel) => ({ ...channel, cmd: channel.cmd.replace("PORT", String(PORT)) }));

function json(res, payload) {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(payload));
}

function handlePortal(url, res) {
  const action = url.searchParams.get("action") || "";
  const type = url.searchParams.get("type") || "";
  const mac = /mac=([^;]+)/.exec(url.searchParams.get("__cookie") || "")?.[1] || null;
  void mac;

  if (type === "stb" && action === "handshake") {
    json(res, { js: { token: "TOKEN-abc123", random: "1234567890" } });
    return true;
  }
  if (type === "itv" && action === "get_all_channels") {
    json(res, { js: { data: CHANNELS, total_items: CHANNELS.length } });
    return true;
  }
  if (type === "itv" && action === "get_genres") {
    json(res, { js: [{ id: "2", title: "News" }, { id: "3", title: "Sports" }] });
    return true;
  }
  if (type === "itv" && action === "create_link") {
    const cmd = url.searchParams.get("cmd") || "";
    if (/broken\.m3u8/.test(cmd)) {
      json(res, { js: { cmd: "ffmpeg http://127.0.0.1:PORT/does-not-exist.m3u8".replace("PORT", String(PORT)) } });
      return true;
    }
    json(res, { js: { cmd: cmd.startsWith("ffmpeg") ? cmd : `ffmpeg ${cmd}` } });
    return true;
  }
  if (type === "stb" && action === "get_profile") {
    json(res, { js: { id: "1", name: "Tester", status: 0, phone: "2030-01-01" } });
    return true;
  }
  return false;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const server = http.createServer(async (req, res) => {
  const origin = `http://127.0.0.1:${PORT}`;
  const url = new URL(req.url, origin);
  const path = url.pathname;

  try {
    if (path === "/portal.php" || path === "/server/load.php" || path === "/portal.php/") {
      const realUrl = new URL(req.url, origin);
      // Cookies are not parsed into searchParams; read them from the header.
      realUrl.searchParams.set("__cookie", req.headers.cookie || "");
      if (handlePortal(realUrl, res)) return;
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "unknown action" }));
      return;
    }

    if (path === "/master.m3u8") {
      res.writeHead(200, {
        "Content-Type": "application/vnd.apple.mpegurl",
        "Cache-Control": "no-cache",
      });
      res.end(masterPlaylist(origin));
      return;
    }

    if (path === "/live/master.m3u8") {
      res.writeHead(200, { "Content-Type": "application/vnd.apple.mpegurl" });
      res.end(masterPlaylist(origin, "/live/variant"));
      return;
    }

    if (/^\/variant\/\d+\/index\.m3u8$/.test(path) || /^\/live\/variant\/\d+\/index\.m3u8$/.test(path)) {
      const variantBase = path.startsWith("/live")
        ? `${origin}/live/variant${path.replace("/live/variant", "").replace("/index.m3u8", "")}`
        : `${origin}/variant${path.replace("/variant", "").replace("/index.m3u8", "")}`;
      res.writeHead(200, { "Content-Type": "application/vnd.apple.mpegurl" });
      res.end(mediaPlaylist(variantBase, { count: 6 }));
      return;
    }

    if (path === "/live/index.m3u8") {
      res.writeHead(200, { "Content-Type": "application/vnd.apple.mpegurl" });
      res.end(mediaPlaylist(`${origin}/ws`, { count: 5 }));
      return;
    }

    if (path === "/broken.m3u8") {
      res.writeHead(200, { "Content-Type": "application/vnd.apple.mpegurl" });
      res.end(mediaPlaylist(origin, { count: 4, broken: true }));
      return;
    }

    if (path === "/vod.m3u8") {
      res.writeHead(200, { "Content-Type": "application/vnd.apple.mpegurl" });
      res.end(mediaPlaylist(origin, { count: 3, endlist: true }));
      return;
    }

    if (path === "/drm.m3u8") {
      res.writeHead(200, { "Content-Type": "application/vnd.apple.mpegurl" });
      res.end(
        [
          "#EXTM3U",
          "#EXT-X-VERSION:3",
          `#EXT-X-TARGETDURATION:${SEGMENT_SECONDS}`,
          '#EXT-X-KEY:METHOD=SAMPLE-AES,URI="skd://fairplay-key",KEYFORMAT="com.apple.streamingkeydelivery"',
          `#EXTINF:${SEGMENT_SECONDS}.000,`,
          `${origin}/seg/seg0.ts`,
          "",
        ].join("\n")
      );
      return;
    }

    if (path === "/slow.m3u8") {
      res.writeHead(200, { "Content-Type": "application/vnd.apple.mpegurl" });
      res.end(mediaPlaylist(`${origin}/slow-seg`, { count: 2 }));
      return;
    }

    if (/^\/slow-seg\/seg\/seg\d+\.ts$/.test(path)) {
      // 4-second segment delivered over ~9 seconds => cannot keep up.
      const body = buildTransportStream({ seconds: 4, mbps: 2 });
      res.writeHead(200, { "Content-Type": "video/mp2t" });
      const chunkSize = Math.ceil(body.length / 9);
      for (let offset = 0; offset < body.length; offset += chunkSize) {
        res.write(body.subarray(offset, offset + chunkSize));
        await sleep(1000);
      }
      res.end();
      return;
    }

    if (
      /^\/variant\/\d+\/seg\/seg\d+\.ts$/.test(path) ||
      /^\/live\/variant\/\d+\/seg\/seg\d+\.ts$/.test(path) ||
      /^\/seg\/seg\d+\.ts$/.test(path)
    ) {
      if (url.searchParams.get("status") === "404") {
        res.writeHead(404, { "Content-Type": "text/plain" });
        res.end("not found");
        return;
      }
      const mbps = path.includes("/480/") ? 0.8 : path.includes("/720/") ? 1.8 : 3.2;
      const body = buildTransportStream({ seconds: SEGMENT_SECONDS, mbps });
      res.writeHead(200, { "Content-Type": "video/mp2t", "Content-Length": String(body.length) });
      res.end(body);
      return;
    }

    if (path === "/live.ts") {
      // Live-ish TS stream paced at real time, with a sprinkling of CC errors.
      const mbps = 4;
      const bytesPerSecond = (mbps * 1_000_000) / 8;
      const totalSeconds = Number(url.searchParams.get("seconds") || 12);
      const withErrors = url.searchParams.get("cc") === "1";
      res.writeHead(200, { "Content-Type": "video/mp2t", "Cache-Control": "no-cache" });
      const body = buildTransportStream({
        seconds: totalSeconds,
        mbps,
        continuityErrors: withErrors ? 20 : 0,
      });
      const chunkSize = Math.round(bytesPerSecond / 4); // ~250ms per write
      for (let offset = 0; offset < body.length; offset += chunkSize) {
        if (res.writableEnded) return;
        res.write(body.subarray(offset, offset + chunkSize));
        await sleep(250);
      }
      res.end();
      return;
    }

    if (path === "/notmedia") {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end("<html><body>Portal login required</body></html>");
      return;
    }

    if (path === "/forbidden") {
      res.writeHead(403, { "Content-Type": "text/plain" });
      res.end("geoblocked");
      return;
    }

    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("not found");
  } catch (error) {
    res.writeHead(500, { "Content-Type": "text/plain" });
    res.end(String(error));
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`probe fixture server listening on http://127.0.0.1:${PORT}`);
});
