# IPTV stream-checking tools — deep dive, reuse and feature gaps

**Date:** 2026-10-04
**Scope:** what MacAttack can reuse from the wider IPTV/stalker tooling ecosystem, and — explicitly —
**which nice features those tools have that MacAttack does not.**

Legend: 🟢 we have it · 🟡 partial / different · 🔴 **we do not have it** (the interesting list).

---

## 1. Method

* Cloned and read the two repos named by the user:
  * [`kristofferR/IPTVChecker`](https://github.com/kristofferR/IPTVChecker) — Rust/Tauri desktop playlist checker (v2.2.0, ~21 k lines of Rust engine).
  * [`walterwhite-69/Flux-Stream`](https://github.com/walterwhite-69/Flux-Stream) — Flask web toolkit for MAC/portal work.
* Cloned and read three more Stalker-specific tools: `kiddac/Stalker-Portal-Checker`, `dougy147/mcbash`,
  `zinzied/Stalker-Portal-Gen-Checker`.
* Followed the trail with searches across GitHub topics (`iptv-checker`, `iptv`, `portal`,
  `mac-address-generator`), the LinuxSat-Support IPTV forum, free-codecs, and streaming-QoE literature
  (see [Sources](#8-sources)).
* Every claim about “what we have” was checked against this repository’s source before being written down.

---

## 2. What MacAttack already had (before this change)

A Stalker-portal MAC scanner with a **portal/control-path** quality report that was deliberately honest:
it measured TCP connect to the portal and one HTTP waterfall, and stated plainly that stream playback
was *not tested*. Concretely, before this work: MAC-prefix enumeration with block-shuffle, handshake +
`account_info` validation, profile/genre/VOD/series fetch, genre and expiry filters, Home Assistant
updates, scheduling, CSV/JSON export, and a portal-quality report.

The gap the user identified is real: **“the MAC is valid” ≠ “the account is watchable”.**

---

## 3. `kristofferR/IPTVChecker` — what it does and what we took

### 3.1 Mechanics worth knowing

| Mechanism | Detail (from source) | Reused in MacAttack |
|---|---|---|
| Liveness by bytes, not by status code | Direct streams must deliver **500 KB**; HLS media segments **128 KB**; nested playlists followed to depth 4; redirects to depth 10 | 🟢 same thresholds in `src/lib/stream-probe.ts` (`MIN_MEDIA_BYTES_DIRECT`, `MIN_MEDIA_BYTES_HLS`) |
| Variant choice | `#EXT-X-STREAM-INF` scored by `RESOLUTION` pixels → `AVERAGE-BANDWIDTH` → `BANDWIDTH` | 🟢 `pickBestVariant()` (pixels×10¹² + bandwidth) |
| DRM detection | Widevine `EDEF8BA9-79D6-4ACE-A3C8-27DCD51D21ED`, FairPlay `skd://`/`com.apple.streamingkeydelivery`, PlayReady `9a04f079-…`; **AES-128 is explicitly not DRM** | 🟢 same UUIDs/tags in `parseHlsPlaylist()` |
| Geoblock vs. dead vs. retry | `403/451/426` (+ secondary `423`) = geoblocked; `408/425/429/5xx` = retry; everything else = dead | 🟢 same status sets; we warn instead of blocking |
| Placeholder filtering | `localhost` hosts and `/ch/..._` paths are not playable channels | 🟢 in `extractStreamUrl()` |
| Stalker flow | handshake → `get_all_channels` → per-channel `create_link` **only when** the cmd is not already playable or the portal sets `use_http_tmp_link`/`use_load_balancing`/`force_ch_link_check` | 🟢 `src/lib/stalker-streams.ts` mirrors this flow |
| Health score | `0.25 × ping + 0.40 × content + 0.35 × quality`, each 0–10; ping from **median** latency (1200 ms ≈ 0, 100 ms ≈ 10); quality = HD ratio 0.5 + codec tier 0.3 + ≥25 fps ratio 0.2 | 🟡 adapted as **stability 0.40 + speed 0.35 + quality 0.25** for a single stream, with the weighting documented in code |
| Codec tiers | HEVC/AV1 = 1.0, H.264 = 0.8, MPEG/VP9 = 0.6, unknown = 0.4 (lower = worse) | 🟢 mirrored (we use 0.85 for H.264) |
| Retry/backoff | `RetryBackoff::{None, Linear, Exponential}` with capped delays | 🔴 see gap #6 |
| Playback sanity flags | `frozen_video` (FFmpeg `freezedetect`/still-image detection), `low_bitrate`, `low_framerate`, `label_mismatches` (e.g. “4K” channel that is 720p) | 🟢 FFmpeg analysis on sampled streams; bundled in Docker, with optional VAAPI decode |
| Thumbnails | FFmpeg grabs the first frame (no `-ss` on live) for a screenshot/lightbox | 🟢 bundled FFmpeg + thumbnail gallery |

### 3.2 What we deliberately did **not** copy

* IPTVChecker's separate static ffmpeg/ffprobe sidecars. MacAttack uses Alpine's packaged FFmpeg only for
  sampled picture checks and thumbnails; the same application image remains multi-arch, while the optional
  Intel VAAPI driver is added only to amd64. The normal transport probe remains Node-based.
* Its scoring uses one latency number (ping) for “speed”. Our probe measures **real media throughput vs.
  required bitrate**, which is the stronger signal for “will this play”.

---

## 4. `walterwhite-69/Flux-Stream` — what it does and what we took

Flask + vanilla JS, single `app.py` (850 lines) + `static/script.js` (762 lines). Feature summary:

| Flux-Stream feature | MacAttack status |
|---|---|
| Single MAC check against a portal (`/check_mac`, multi-endpoint probing in a `ThreadPoolExecutor`, 3 s timeout) | 🟢 (deeper: we validate via `account_info` and reject handshake-only “success”) |
| **Bulk MAC validation with 1–100 threads** | 🟡 our scan is sequential per portal with a block-shuffle; concurrency is a possible future option (gap #7) |
| **Multi-URL (multi-portal) MAC checks in one run** | 🔴 gap #12 |
| **Proxy rotation support for validation requests; proxy list checker with response times** | 🔴 gap #5 (useful for geoblock confirmation, see IPTVChecker too) |
| **Random MAC generator for the `00:1A:79` prefix + auto-check** | 🟢/🟡 we enumerate a chosen prefix exhaustively with block shuffling; we do not have a “random pick” mode |
| **Stalker → M3U conversion (portal + MAC → .m3u8)** | 🟢 **added now**: `GET /api/scan/playlist?resultId=…` (UI: “Download M3U”) |
| **Xtream Codes → M3U conversion** | 🔴 gap #10 |
| M3U parser/cleaner with channel & category counts | 🔴 (out of scope for a scanner, but useful for exports) |
| **7 neon themes, glitch effects, obfuscated text** | 🔴 cosmetic; explicitly out of scope |
| Real-time “currently checking” display | 🟢 we stream logs + progress over the polling API |

**Reuse verdict:** Flux-Stream’s code quality is low (broad `except: pass`, no tests, credentials in URLs,
threads without rate limiting), so we did **not** copy code. We adopted its *feature* — Stalker→M3U export —
implemented server-side with concurrency caps and token-redacted storage.

---

## 5. The rest of the ecosystem (deep search)

| Project | Type | Standout features |
|---|---|---|
| [`kiddac/Stalker-Portal-Checker`](https://github.com/kiddac/Stalker-Portal-Checker) (LinuxSat) | .NET/WPF Windows app | **Play streams directly inside the checker**; **second-chance portal check with different parameters** (helps “server status 1” `/stalker_portal/c/` portals); serial-number (S/N) fingerprinting; **converts messy scanner output into clean portal+MAC lines**; favourites; EPG for channels that carry it; multi-language; dark/light |
| [`NewsGuyTor/IPTVChecker`](https://github.com/NewsGuyTor/IPTVChecker) + [`sudo-ronmexico/IPTVChecker-BitRate`](https://github.com/sudo-ronmexico/IPTVChecker-BitRate) | Python CLI | **10-second ffmpeg VBR bitrate profiling**, **mislabel detection** (“1080p” tag on a 480p stream), screenshot capture, geoblock confirmation **through proxies**, retry backoff modes, CSV reports, directory scanning |
| [`dearbulut/iptv` (IPTV Nexus)](https://github.com/dearbulut/iptv) | GitHub-Actions pipeline | **Rolling 0–100 health score with history (EWMA)** so one unlucky probe cannot condemn a stream; uptime history; per-channel JSON API; `best.m3u` |
| [`LCMApps/video-quality-tools`](https://github.com/LCMApps/video-quality-tools) | Node lib | Real-time monitoring of **fps and bitrate drops, GOP structure changes** via ffprobe on a live stream |
| [`kamalsoft/m3u-editor`](https://github.com/kamalsoft/m3u-editor) | PyQt6 | **Live-stream monitor dashboard**, SSL/redirect security audit, **integrated network speed test**, resolution distribution charts, smart dedupe |
| [`ShouNLAK/Check-Online-IPTV`](https://github.com/ShouNLAK/Check-Online-IPTV) | C/C# | **Robust 3-try re-queue loop** to fight false negatives; latency + HTTP code + codec grid; auto-VLC launch with the cleaned playlist |
| [`ponwork/multicast-checker`](https://github.com/ponwork/multicast-checker) | Python | UDP/multicast stream checking, IP-range scanning, **records MP4 samples** of unnamed channels |
| [`Evilvir-us/MacAttack`](https://github.com/Evilvir-us/MacAttack) | Python GUI | This repository’s namesake/ancestor: proxy tab + built-in player tab (fork of IPTV-MAC-STALKER-PLAYER) |
| [`Cyogenus/IPTV-MAC-STALKER-PLAYER`](https://github.com/Cyogenus/IPTV-MAC-STALKER-PLAYER) | Python/VLC | Poster tooltips, category browse, favourites, EPG, external-player handoff |
| [`dougy147/mcbash`](https://github.com/dougy147/mcbash) | Bash | Whole tool built from shell functions into **one portable script**; Docker + compose + man page; config in `~/.config/mcbash` |
| [`zinzied/Stalker-Portal-Gen-Checker`](https://github.com/zinzied/Stalker-Portal-Gen-Checker) | PyQt5 | **`agents.txt` user-agent rotation**; channel-count + expiry extraction; timestamped result files |
| [`tejjasdev/Wisp`](https://github.com/tejjasdev/Wisp) | Browser player | Live **speed-vs-bitrate graph**, “try the next source of the same channel automatically” |
| [`rendiffdev/rendiff-probe`](https://github.com/rendiffdev/rendiff-probe) | API/CLI | 121 QC parameters incl. **freeze/black/blockiness/blur** (`freezedetect`, `blackdetect`, `signalstats`) |
| [OpenQoE](https://openqoe.dev/) + QoE literature | Research/OSS | Player-side QoE: **startup time, rebuffering ratio, rebuffer events/min, quality-switch stability** |
| freeiptvcheck.com tools | Web | Bitrate + speed-test views for a pasted stream URL |

---

## 6. 🚩 **Nice features we did not have** (priority-ordered)

> **Status update (2026-10-04):** the roadmap items below were implemented or given an
> explicit measurement limit in the three waves planned in
> [`feature-gap-roadmap.md`](feature-gap-roadmap.md) — see [`wave-implementation.md`](wave-implementation.md)
> for implementation and tests. FFmpeg is included in both Docker architectures; optional
> VAAPI decoding uses the DS918+ render-device overlay and falls back to software. RTSP/RTMP
> receive liveness checks; UDP remains unverifiable. The descriptions below preserve the
> original gap analysis.

> These are the answers to “highlight if there are any nice features in these other applications that we do not have”.

### 🟢 Gap 1 — Freeze/blank/hard-artefact detection (picture, not just delivery) — **implemented**
*Seen in:* IPTVChecker (`frozen_video`, `freezedetect`), rendiff-probe (`blackdetect`, `blockdetect`, `blurdetect`).
MacAttack runs `freezedetect` and `blackdetect` over sampled streams. The published image bundles FFmpeg;
missing binaries in local source runs remain a graceful “not available” case. The optional DS918+ VAAPI
path is opportunistic and software FFmpeg is retried if hardware decode fails. Keep picture flags as evidence,
not a hard verdict.

### 🔴 Gap 2 — Result history / rolling health (one bad sample shouldn’t condemn a stream) — **high value**
*Seen in:* IPTV Nexus (EWMA 0–100 + uptime history), IPTVChecker (scan history compare).
Our score is a single snapshot. Storing each probe run and showing a trend (and “this account degraded
during peak hours”) is a small schema change with a big honesty gain.

### 🔴 Gap 3 — Retry with backoff and false-negative suppression — **high value**
*Seen in:* IPTVChecker (`RetryBackoff::{None,Linear,Exponential}`, `MAX_RETRIES`), Check-Online-IPTV (3-try re-queue).
A transient CDN 503 currently scores a channel as broken. Adding bounded retries with backoff for
*retryable* statuses (408/425/429/5xx) would materially reduce false negatives.

### 🔴 Gap 4 — Playback/EDGE verification from a second vantage point — **high value**
*Seen in:* IPTVChecker (proxy support), NewsGuyTor checker (proxy-based geoblock confirmation).
We measure from one host (the NAS/Pi). Optional proxy egress (per-probe HTTP CONNECT proxy, e.g. the
viewer’s country) would separate “portal is fine, our route is bad” from real problems.

### 🔴 Gap 5 — Proxy list checker + proxy rotation for scans — **medium value**
*Seen in:* Flux-Stream (validator with response times, rotation on validation requests).
Useful both for anonymising bulk portal traffic and for gap 4.

### 🔴 Gap 6 — Mislabel detection (“4K” channel that is actually 720p) — **medium value**
*Seen in:* NewsGuyTor/IPTVChecker, IPTVChecker (`label_mismatches`).
We already parse the ladder: comparing the channel *name* (`HD`, `FHD`, `4K`) and the streaming variant’s real
resolution is nearly free and users love it.

### 🔴 Gap 7 — Bulk/MAC-list checking and higher scan parallelism — **medium value**
*Seen in:* Flux-Stream (1–100 threads), mcbash (drops a MAC list in and runs it), KiddaC (paste many lines).
MacAttack scans one prefix per job; there is no “paste 200 MACs and check them all”, and no user-set worker
count. The portal already rate-limits us, so a *cautious* configurable concurrency cap plus a MAC-list input
would be the wins.

### 🔴 Gap 8 — Catch-up/archive verification — **medium value (differentiator)**
*Seen in:* IPTVChecker (“verify catch-up actually works”; fakes return empty archive or serve live).
For Stalker accounts this maps to `tv_archive`/`tv_archive_duration` — asking for a programme from 1 h and
from N days ago and checking for real bytes. Nobody else in the Stalker space does this well.

### 🟢 Gap 9 — Channel thumbnails / screenshots in the UI — **implemented**
*Seen in:* IPTVChecker (screenshot lightbox), NewsGuyTor (screenshots), m3u-editor (diagnostics).
The FFmpeg-backed quality flow captures a JPEG for each sampled channel and displays the thumbnail gallery.

### 🔴 Gap 10 — Xtream Codes support — **medium value**
*Seen in:* Flux-Stream (Xtream→M3U), IPTVChecker (Xtream login as a playlist source).
Many “stalker” portals are dual-protocol; supporting `player_api.php` would widen the addressable portals.

### 🔴 Gap 11 — Live monitor / scheduled re-checks with alerts — **medium value**
*Seen in:* m3u-editor (live stream monitor), IPTV Nexus (scheduled probes), OpenQoE (alerts).
MacAttack has scheduling for scans; per-result monitoring with “tell me when this account degrades” does not exist.

### 🔴 Gap 12 — Multi-portal runs — **medium value**
*Seen in:* Flux-Stream (“use multiple URLs” for bulk checks).
One job = one portal today.

### 🔴 Gap 13 — Player-side QoE metrics (startup time, rebuffer ratio) — **low/roadmap**
*Seen in:* OpenQoE, QoE papers, Wisp.
Only measurable with an actual player; note our report already names these as untested, so there is no
dishonest claim to fix — it is a future integration, not a bug.

### 🟡 Gap 14 — UDP/multicast and RTSP/RTMP ingestion — **partial**
*Seen in:* multicast-checker, Wisp. RTSP/RTMP TCP handshake liveness is implemented; UDP is honestly labelled unverifiable because the scanner cannot validate multicast payload delivery.

### 📋 Decision table
A prioritized, tabular version of these gaps — with added value, implementation path, effort and a
suggested sequence — lives in [`feature-gap-roadmap.md`](feature-gap-roadmap.md).

### 🟡 Smaller niceties we still lack
* **User-agent rotation** (`agents.txt`) — zinzied. One-line support; helps when a portal blocks the MAG UA.
* **“Second-chance” portal re-check with alternate parameters** — KiddaC. Cheap and improves validation accuracy.
* **Serial-number fingerprint per portal** (KiddaC) — helps distinguishing portals behind shared hosts.
* **Auto-VLC / external-player handoff** for a found MAC — Check-Online-IPTV, Cyogenus.
* **CSV field “Frozen video / low framerate / mislabeled”** columns — NewsGuyTor.
* **Neon themes / glitch UI** — Flux-Stream (cosmetic, deliberately skipped).

---

## 7. What this change implemented (and what it explicitly does not claim)

**New in this branch**

| Piece | File | What it does |
|---|---|---|
| Stream probe engine | `src/lib/stream-probe.ts` | Real media-path measurement with Node built-ins: DNS/TCP/TLS/TTFB waterfall, HLS master→best variant→segment sampling, segment-vs-realtime analysis (deficit + worst ratio), throughput buckets (sustained/peak/min/CV), MPEG-TS PAT/PMT parsing (PID→codec map, measured bitrate), **continuity-counter errors**, scrambled-packet detection, DRM detection, geoblock/retry classification, 500 KB/128 KB liveness thresholds |
| Stalker stream client | `src/lib/stalker-streams.ts` | handshake → `get_all_channels` (fallback per-genre `get_ordered_list`) → `create_link` (only when needed) → M3U builder → **URL redaction** for storage |
| Per-MAC quality check | `src/lib/mac-quality.ts` | Picks a genre-spread of channels, probes each, aggregates **speed / quality / stability / overall** with a verdict, playability gate, headroom summary, and explicit limitations |
| Scanner integration | `src/lib/scanner.ts`, `src/db/schema.ts`, `init-schema.js` | Runs automatically for every MAC that passes the user's filters; stores flat columns + full JSON report; abort-aware; never fails the scan |
| APIs | `api/scan/quality`, `api/scan/playlist` | Re-measure on demand; download a Stalker→M3U playlist for a valid MAC (Flux-Stream feature) |
| UI | `src/app/page.tsx` | Scan-form toggle + channels/sample controls, measured verdict column, per-channel detail table, “Re-check streams”, “Download M3U” |
| Tests | `scripts/probe-fixtures.mjs`, `scripts/probe-tests.ts`, `scripts/mac-quality-tests.ts` | Deterministic offline fixtures: HLS ladder, broken/slow/DRM/VOD playlists, synthetic MPEG-TS with and without CC errors, mock Stalker portal — **39 + 20 checks, all passing** |

**Scoring model (documented so it can be argued with):**

```
overall = 0.40 × stability + 0.35 × speed + 0.25 × quality        (each 0–10)
stability = f(throughput CV, HLS segment failures, real-time deficit,
              TS continuity errors/1000, scrambled ratio)
speed     = f(sustained Mbps ÷ required Mbps)      [HLS: declared bandwidth,
                                                    else segment size ÷ duration]
quality   = f(height tier, codec tier, bitrate adequacy for that tier)
verdict   = ≥8.5 excellent · ≥7 good · ≥5 fair · ≥3 poor · else unusable
aggregate = mean of probed channels, minus up to 3 points for unplayable channels
```

**Honest limits carried in every report:** one vantage point (scanner host), short sample window, N channels
out of M, **no video decoding (no freeze/black detection)**, token-redacted URLs (re-check needs a fresh
`create_link`). These are printed in the API/JSON and listed in the UI panel.

---

## 8. Sources

* https://github.com/kristofferR/IPTVChecker (README, `engine/checker.rs`, `engine/ffmpeg.rs`, `engine/playlist_score.rs`, `engine/stalker.rs`, issues #255)
* https://github.com/kristofferR/IPTVChecker-Python (NewsGuyTor) and https://github.com/sudo-ronmexico/IPTVChecker-BitRate
* https://github.com/walterwhite-69/Flux-Stream (`app.py`, `static/script.js`, README)
* https://github.com/kiddac/Stalker-Portal-Checker (README, LinuxSat-Support release thread)
* https://github.com/dougy147/mcbash · https://github.com/zinzied/Stalker-Portal-Gen-Checker · https://github.com/Evilvir-us/MacAttack · https://github.com/steinex/macstalker
* https://github.com/dearbulut/iptv (IPTV Nexus health scoring) · https://github.com/LCMApps/video-quality-tools · https://github.com/kamalsoft/m3u-editor · https://github.com/ShouNLAK/Check-Online-IPTV · https://github.com/ponwork/multicast-checker · https://github.com/rendiffdev/rendiff-probe · https://github.com/tejjasdev/Wisp · https://github.com/Cyogenus/IPTV-MAC-STALKER-PLAYER
* FFmpeg filters `freezedetect`, `blackdetect`, `blockdetect`, `blurdetect` (ffmpeg-filters docs)
* QoE metric references: OpenQoE (https://openqoe.dev/), “Measuring the Quality of Experience of HTTP Video Streaming”, QoE-for-streaming surveys (arxiv 1912.11318)
* LinuxSat-Support IPTV forum (Stalker Portal Checker by KiddaC thread; IPTV Tools threads)
