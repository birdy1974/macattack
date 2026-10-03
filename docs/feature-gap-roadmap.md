# Feature-gap roadmap — what we can still implement, why, and what it buys us

**Companion to:** [`iptv-tool-landscape.md`](iptv-tool-landscape.md) (the ecosystem deep dive)
**Date:** 2026-10-03 · **Status:** ✅ **all three waves implemented** — see
[`wave-implementation.md`](wave-implementation.md) for the shipped item list, the tests that
cover each one, and the honest limits that remain. Only the “Not recommended” section was
left unimplemented, by design. The tables below are kept unchanged as the decision record
(what the gap was, why it mattered, what it bought us).

## How to read the tables

| Column | Meaning |
|---|---|
| **Gap** | The feature we do not have today (numbering follows the landscape doc). |
| **Seen in** | Where the idea comes from, so the original can be consulted. |
| **Added value** | What the user of MacAttack gets once it exists. |
| **Recommendation** | Concrete implementation path for this codebase (Next.js + Drizzle, Docker amd64+arm64, no build on the NAS/Pi). |
| **Effort** | XS ≤ ½ day · S ≈ 1 day · M ≈ 2–4 days · L ≈ 1–2 weeks. |
| **Deps** | New requirements: `ffmpeg` (optional sidecar) · `DB` (columns/table) · `UI` · `ext` (external service). |

Impact is judged **for this product**: finding accounts that are genuinely watchable, on a NAS/Pi,
still honest about what was and was not measured.

---

## 1. Quick wins (do first — high value, XS–S effort)

These need no new services and no image growth.

| # | Gap | Seen in | Added value | Recommendation | Effort | Deps |
|---|---|---|---|---|---|---|
| 3 | **Bounded retries with backoff** for retryable HTTP statuses (408/425/429/5xx) | IPTVChecker (`RetryBackoff::{None,Linear,Exponential}`), Check-Online-IPTV (3-try re-queue) | Kills the most common false negative: a transient CDN 503 currently scores a channel “unusable”, which then drags the whole MAC verdict down | Wrap the manifest + segment requests in `stream-probe.ts` with max 2 retries, exponential backoff (1 s → 3 s), only for `RETRYABLE_HTTP_STATUSES`; record `retryCount` per channel in the report so the verdict stays explainable | S | — |
| 6 | **Mislabel detection** (“4K”/“HD” in the channel name vs. the real variant resolution) | NewsGuyTor/IPTVChecker (`label_mismatches`), IPTVChecker table flag | Immediately useful and easy to trust: exposes channels that advertise 4K but deliver 720p — the ladders are already parsed | Compare `hls.variantLadder` height (or TS bitrate tier) with tokens in `channel.name`; store `qualityLabelMismatch` text and add it to the per-channel table + CSV | S | DB, UI |
| 14a | **User-agent rotation** per portal (plus “which UA works best”) | zinzied/Stalker-Portal-Gen-Checker (`agents.txt`) | Portals that block the MAG UA currently look dead; trying a small UA list converts “unscannable” into “works” | Add a settings-held UA list (default: current MAG UA + browser UA + VLC UA); on handshake failure, retry each UA once and remember the winner per portal host in the settings table | XS | DB |
| 14b | **“Second-chance” portal re-check with alternate parameters** | kiddac/Stalker-Portal-Checker | Recovers portals whose `server status = 1` hides `account_info` — KiddaC’s stated reason for adding it; fewer false “invalid portal” failures | Extend `validateStalkerPortal()` to retry the found endpoint with the alternate parameter set (different `stb_type`/`JsHttpRequest`/headers) before giving up | S | — |
| 14c | **Serial-number fingerprint per portal** | kiddac/Stalker-Portal-Checker | Tells you when two portal URLs are the same middleware (shared S/N) — avoids double work and explains shared passwords/expiry | Send a stable S/N (derived from MAC + portal host, stored once), keep it in `rawData`, surface it in the job log | S | DB |
| — | **Stable subscription M3U URL** (not just a one-off download) | Flux-Stream (playlist download), TiviMate/VLC user habit | Turns the existing export into something a TV app can subscribe to: a fixed URL that re-runs `create_link` on every fetch, protected by a revocable token | New `playlist_tokens` table (result + random token), `GET /api/playlist/<token>.m3u` regenerates links on demand; UI button “Copy subscription URL” | S | DB, UI |
| — | **CSV/JSON columns for everything we already measure** (retries, mislabel, TS CC errors, DRM, realtime deficit) | NewsGuyTor CSV reports | No new measurement — just stops hiding evidence the probe already collected, which is what makes reports usable in a spreadsheet | Add the fields to `AVAILABLE_FIELDS` + `download/route.ts` (the pattern already exists for the new quality fields) | XS | UI |

**Wave 1 value:** fewer false negatives (retries, UA rotation, second-chance check), fewer wasted accounts
(mislabel detection), and a playlist your TV can actually subscribe to.

---

## 2. Strategic features (the real capability jumps, M effort)

| # | Gap | Seen in | Added value | Recommendation | Effort | Deps |
|---|---|---|---|---|---|---|
| 1 + 9 | **Optional ffmpeg pack: freeze/black-frame detection, thumbnails, fps, VBR bitrate, blockiness** | IPTVChecker (`freezedetect`, `frozen_video`, screenshots), rendiff-probe (`blackdetect`/`blockdetect`/`blurdetect`), NewsGuyTor (VBR profiling + low-fps) | The biggest honesty upgrade left: today a stream showing a **still image with audio passes every delivery check we have**. Also gives the UI visual proof (thumbnail per probed channel) and fps/VBR numbers | Detect `ffmpeg`/`ffprobe` at runtime (`which`, `PATH`, env override). If present: one 10 s capture per probed channel with `freezedetect` + `blackdetect` + `signalstats`, plus one frame JPEG for the thumbnail. If absent: the scan behaves exactly as today and the report says “picture checks unavailable”. Do **not** bundle it — Synology users can install SynoCommunity ffmpeg, the Pi can `apt install ffmpeg` | M | ffmpeg, DB, UI |
| 2 | **Probe history + rolling health score (EWMA)** | IPTV Nexus (rolling 0–100 + uptime history), IPTVChecker (scan-history compare) | One unlucky sample stops condemning a stream, and you can see **degradation over time** (evening congestion, provider attrition) instead of a single snapshot. It is also the substrate for monitoring/alerts | New append-only `quality_probe_runs` table (resultId, timestamp, scores, throughput, verdict, channel count). Compute EWMA (α≈0.3) and show “now vs. 7-day trend” in the panel; keep the current snapshot verdict as-is | M | DB, UI |
| 4 + 5 | **Proxy egress (second vantage point) and proxy-list checker** | IPTVChecker (per-scan proxy), NewsGuyTor (geoblock confirmation through proxies), Flux-Stream (proxy validator + rotation) | Separates “this portal is broken” from “this route is broken”, and confirms geoblocks instead of guessing from HTTP 403. Also useful when a provider rate-limits your home IP | Settings-held proxy list; `stream-probe.ts` accepts an `agent`/HTTP-CONNECT proxy per probe; a “confirm geoblock” action re-probes a 403 stream through one proxy. Ship a small validator (parallel HEAD through each proxy, ms + success) reusing the existing probe timing code | M | DB, UI, ext |
| 7 | **Bulk MAC list input + configurable concurrency** | Flux-Stream (1–100 threads), mcbash (MAC list file), KiddaC (paste many lines) | Matches how people actually work: paste a vendor/shared list instead of enumerating a prefix. Plus a *cautious* worker cap to scan faster on the Pi 4 without tripping portal rate limits | New job mode `mode: "list"` (textarea/CSV upload → dedup/normalise → queue). Add `concurrency` (1–8, default 1) applied to the validation step only, with a global per-host rate limiter so we add speed without bans | M | DB, UI |
| 8 | **Catch-up / archive verification** | IPTVChecker (“verify catch-up actually works”, fakes return empty archive/serve live) | Genuine differentiator in the Stalker world: proves whether `tv_archive`/`tv_archive_duration` really serves past programmes, or is just advertised. Directly answers “is this account worth keeping?” | For accounts exposing `tv_archive`, request `create_link` with archive start/end for (a) −1 h and (b) the advertised depth, then measure bytes with the probe. Report per-account: “catch-up verified to 3 days” / “advertised 7 days, empty” | M | DB, UI |
| 11 + 13 | **Live monitoring, trend alerts and player-side QoE** (startup time, rebuffer ratio) | m3u-editor (live monitor), IPTV Nexus (scheduled probes), OpenQoE (startup/stall/P95 metrics) | Scheduled re-checks of saved results with alerts when a previously good account degrades. QoE metrics are the player-side view: startup time and rebuffering, which no delivery probe can see | Reuse the existing schedule/HA plumbing: re-run the quality check for stored results on a schedule, update EWMA (gap 2) and notify through Home Assistant or a webhook on verdict drops. Startup time we can already approximate (TTFB → first segment); rebuffer ratio stays “not measurable without a player” | M | DB, UI, ext |
| — | **Thumbnails gallery in the UI** | IPTVChecker (lightbox), m3u-editor (diagnostics) | Visual proof that the channel exists and shows what the reviewer expects; catches wrong-language/wrong-region channels instantly | Part of the ffmpeg pack (gap 1); store one JPEG per probed channel under a volume path, render a small gallery in the expanded result row | S–M | ffmpeg, DB, UI |
| 12 | **Multi-portal runs** | Flux-Stream (“use multiple URLs” for bulk checks) | One job compares several portals, which is how shared lists arrive; also removes a lot of repetitive clicking | Accept an array of portal URLs on `/api/scan/start`; the scanner loops portals per job and tags results with the portal host (schema already stores `portalUrl` per result) | S–M | UI |

**Wave 2 value:** trustworthy over time (EWMA + history), proven by pixels (ffmpeg pack + thumbnails),
diagnosable per route (proxy egress), and alertable (monitoring).

---

## 3. Coverage bets (useful, but only after waves 1–2)

| # | Gap | Seen in | Added value | Recommendation | Effort | Deps |
|---|---|---|---|---|---|---|
| 10 | **Xtream Codes support** (`player_api.php`) | Flux-Stream, IPTVChecker (Xtream as playlist source) | Many “stalker” portals are dual-protocol; adding Xtream roughly widens the addressable portals and lets one scan cover both | New `xtream-streams.ts` mirroring `stalker-streams.ts`: login → `get_live_streams`/`get_vod_streams` → direct stream URLs → reuse the probe unchanged; UI: protocol auto-detect from URL shape | M–L | DB, UI |
| 14 | **RTSP/RTMP (and optional UDP) ingestion** | multicast-checker (UDP + sample recording), IPTVChecker (ffprobe liveness for rtsp/rtmp) | Some portals hand out RTSP/RTMP links; today those channels are simply “not measurable” | Liveness via the optional ffmpeg pack (`ffprobe -rw_timeout`) for `rtsp://`/`rtmp://`; model it as a *different* result kind (bytes received, codec) rather than pretending HLS metrics apply | M | ffmpeg |
| — | **External-player handoff / per-user playlist** | Cyogenus player, Check-Online-IPTV (auto-VLC) | Some users want to watch, not just score; the subscription URL (quick win) plus an “Open in VLC” deep link covers most of it without bundling a player | Reuse the subscription-URL endpoint; document VLC/TiviMate usage instead of adding a web player | XS | — |
| — | **Per-group / per-genre aggregation of results** | IPTVChecker (per-group health report) | “Which genre groups are broken on this account?” is a natural next question once we have per-channel probes | Aggregate `qualityReport.channels` by genre in the UI panel | S | UI |

---

## 4. Deliberately **not** recommended (with reasons)

| Idea | Seen in | Why not |
|---|---|---|
| 7 neon themes, glitch effects, obfuscated text | Flux-Stream | Cosmetic; conflicts with a dense, evidence-first data UI. No functional value. |
| Unbounded parallelism (10–100 threads) | Flux-Stream, Evilvir MacAttack | Provider bans/rate-limits are the main risk to a scan that takes hours; a capped, rate-limited concurrency (gap 7) is the sane version. |
| Storing full, unredacted stream URLs | common in the wild | Session tokens become replayable credentials in the DB and in exports. We already redact; keep it that way. |
| Bundling ffmpeg in the default image | IPTVChecker ships sidecars | Adds ~50–100 MB to an image that must stay small on a Raspberry Pi 4 / DS918+ and be rebuilt on every release. Make it detect-and-use, not bundle (gap 1). |
| ffprobe-based scoring for every channel by default | IPTVChecker, NewsGuyTor | Seconds per channel and CPU-heavy on a Pi; keep the default probe cheap, run ffmpeg only on the sampled channels for a found MAC. |
| Claiming rebuffer ratio / freeze detection without a decoder | — | Would contradict the honesty rule that made the current report trustworthy. Do it properly (gap 1) or label it “not measurable”. |

---

## 5. Suggested sequence

| Wave | Contents | Effort total | What the user gets |
|---|---|---|---|
| **1 — Accuracy & utility** | Gaps 3, 6, 14a/14b/14c, subscription URL, extra export columns | ~4–6 days | Fewer false negatives and false “unusable” verdicts, mislabel flags, playlists your TV can subscribe to, full evidence in CSV/JSON |
| **2 — Trust over time & pixels** | ffmpeg pack (1+9), history + EWMA (2), proxy egress (4+5), bulk MAC list + concurrency (7) | ~2–3 weeks | Freeze/black detection, thumbnails, trends and peak-hour insight, route-vs-provider diagnosis, list-driven scanning |
| **3 — Differentiation & coverage** | Catch-up verification (8), monitoring/alerts (11+13), multi-portal (12), Xtream (10) | ~3–4 weeks | Proven catch-up, “tell me when this account degrades”, multi-portal jobs, dual-protocol portals |

## 6. Value × effort matrix

```
 Impact      XS / S                        M                                 M / L
 ───────────┬────────────────────────────┬─────────────────────────────────┬──────────────────────
 High       │ 3  Retries+backoff         │ 1+9 ffmpeg pack (freeze/thumbs) │
            │ 6  Mislabel detection      │ 2   History + EWMA              │
            │ 14a UA rotation            │ 4+5 Proxy egress + checker      │
            │ 14b Second-chance check    │ 7   Bulk MAC list + concurrency │
            │ 14c Serial fingerprint     │ 8   Catch-up verification       │
 ───────────┼────────────────────────────┼─────────────────────────────────┼──────────────────────
 Medium     │ • Subscription M3U URL     │ 12  Multi-portal runs           │ 10  Xtream support
            │ • Extra export columns     │ 11+13 Monitoring + QoE alerts   │ 14  RTSP/RTMP/UDP
            │ • Genre aggregation (UI)   │     Thumbnails gallery          │
 ───────────┴────────────────────────────┴─────────────────────────────────┴──────────────────────
```

## 7. Cross-cutting notes

* **The ffmpeg pack is one dependency for three gaps** (freeze/black detection, thumbnails, fps/VBR QC).
  It is the single highest-leverage item after the quick wins — but it must be *optional and detected at
  runtime* so the amd64 NAS and arm64 Pi images keep working unchanged.
* **History (gap 2) is the substrate for monitoring and alerts (gaps 11/13).** Implement the append-only
  probe-run table once and both the trend UI and the alerting logic come cheaply.
* **Everything in waves 1–2 works without new hardware**: settings rows, one new table, and (optionally)
  a user-installed ffmpeg. No GPU, no external service, no change to the Docker architecture.

🟢 Already delivered in this branch: dependency-free media probe (HLS + MPEG-TS), per-MAC
speed/quality/stability check with verdict and evidence, Stalker→M3U export, re-check endpoint,
per-channel detail UI — i.e. gaps from the landscape doc that were “missing” are now the foundation
these recommendations build on.
