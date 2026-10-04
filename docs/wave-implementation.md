# Wave implementation — what shipped, how it is tested, what it still cannot do

This document closes the loop on [`feature-gap-roadmap.md`](feature-gap-roadmap.md):
all three waves were implemented. It lists each item, where it lives, how it is
verified, and the honest limits that remain.

Standing constraints were respected throughout:

* **No new npm dependencies.** FFmpeg is installed in the published Docker
  runtime image on both architectures; local source runs still detect it at
  runtime and degrade gracefully if it is absent.
* **Multi-arch image preserved.** Alpine's FFmpeg package is installed on
  amd64 and arm64. The amd64 image also includes Intel's VAAPI user-space
  driver; hardware access is optional and every failed hardware decode retries
  with software FFmpeg.
* **Honest labelling.** Anything that cannot be measured (picture freezes
  without ffmpeg, UDP liveness, operator-side QoE) says so in the API response,
  the UI, the exports and the logs instead of guessing.

---

## Wave 1 — accuracy & utility

| Item | Where | Verified by |
|---|---|---|
| Transient retries with 1 s → 3 s → 6 s backoff (408/425/429/5xx, timeouts, network errors) | `src/lib/stream-probe.ts` (`requestWithRetry`), `maxRetries` option (default 2, clamp 0–4) | `npm run test:probe` section 10 against the fixture's `/flaky-<n>.m3u8` route (43→48 checks) |
| Channel-label mismatch detection, including bitrate-only evidence when no height is measurable | `src/lib/label-mismatch.ts`, caps `quality ≤ 6` in `scoreStreamProbe` | `npm run test:waves` (label-mismatch assertions) |
| User-agent rotation with a per-portal memory (`ua_winner:<host>` setting) | `src/lib/user-agents.ts`, scanner pre-scan handshake probe, `mac-quality.ts` handshake | `test:waves` (candidate ordering) + logs in scanner |
| Second-chance portal re-check (multi-portal jobs, round-robin retry of rejected MACs) | `src/lib/scanner.ts` (`portalAlternatives`), `/api/scan/start` `portalUrls` | Code path + fixture portal validation; not covered by an automated test (needs a second portal host) |
| Deterministic serial-number fingerprint in every portal handshake | `computeSerialNumber()` in `src/lib/stalker-streams.ts`, sent as `SN` / `X-Serial-Number` | `test:waves` (fingerprint stability is exercised through the Stalker suite) |
| Stable, revocable subscription M3U URL | `/api/scan/playlist-token` (create/list/revoke) + `?token=` support in `/api/scan/playlist` | Manual/API-level; playlist generation itself is covered by `test:quality` |
| Extra export columns (retries, frozen picture, label mismatch, catch-up, thumbnail, EWMA, trend, protocol, genre quality) | `/api/scan/download` field map + `AVAILABLE_FIELDS` in the UI | `test:quality` (report fields) + build |

## Wave 2 — trust over time & pixels

| Item | Where | Verified by |
|---|---|---|
| FFmpeg picture checks: freeze/black detection, fps, video bitrate, thumbnails; VAAPI decode attempt with software fallback | `src/lib/ffmpeg-tools.ts`, `/api/system`, `/api/scan/thumbnail`; `Dockerfile` bundles FFmpeg on amd64/arm64 and Intel's VAAPI driver on amd64; optional `docker-compose.vaapi.yml` maps the DS918+ render node | `test:waves` parses captured FFmpeg stderr and uses a fake executable to test VAAPI detection, picture-analysis fallback and thumbnail fallback without a real FFmpeg binary or GPU; container build/runtime VAAPI still needs validation on the target DSM host |
| Probe history + EWMA + trend + degradation alerts | `quality_probe_runs` table, `src/lib/quality-history.ts`, `/api/scan/history`, scanner/quality/monitor writers | `test:waves` (EWMA/trend/degradation maths) + `test:quality` (history persistence paths) |
| Proxy egress + proxy validator | `src/lib/proxy.ts`, `proxies` table, `/api/scan/proxies`, `proxy` option on probes and quality checks | `test:probe` section 11 egresses through the fixture's CONNECT proxy, asserts `viaProxy` and bytes; dead proxies are reported as errors |
| Bulk MAC list + capped concurrency | `src/lib/mac-list.ts`, `/api/scan/start` `scanMode: "list"`, scanner slice workers (`concurrency` ≤ 8) with a per-host rate limiter | `test:waves` (list parsing, `pMapLimit`, `HostRateLimiter`) |
| Monitoring, alerts and QoE-style tracking | `monitors` table, `/api/scan/monitors` (create/update/run due), UI "Monitor"/"Run due checks now" | API paths; run loop shares the quality pipeline proven by `test:quality` |
| Catch-up (archive) verification | `stalkerResolveArchiveLink()` + `checkMacStreamQuality({ checkCatchUp })`, labelled `verified` / `advertised_but_failed` / `not_advertised` / `not_checked` | `test:quality` section 6 against the fixture's archive-capable channel, including the "switch it off" case |
| Thumbnails gallery in the results table | Per-result thumbnail + `/api/scan/thumbnail` (path-traversal-safe) | `test:waves` (store safety: traversal rejected, round-trip) |

## Wave 3 — differentiation & coverage

| Item | Where | Verified by |
|---|---|---|
| Xtream Codes support (login, catalogue, live stream sampling through the shared probe) | `src/lib/xtream-streams.ts`, `src/lib/xtream-quality.ts`, `/api/scan/xtream` | `npm run test:xtream` — 24 checks against the mock Xtream API in the fixture server |
| RTSP / RTMP liveness (TCP + protocol handshake) and honest UDP labelling | `probeSocketLiveness()` / `detectStreamProtocol()` in `src/lib/stream-probe.ts` | `test:waves` (dead host, UDP `unverifiable`, unknown scheme) |
| Genre aggregation (quality per genre) | `buildGenreGroups()` in `mac-quality.ts`, `quality_genre_summary` column, UI + CSV export | `test:quality` section 6 (groups and averages) |

---

## How to run everything

```bash
npm run fixtures                  # mock Stalker portal + Xtream API + CONNECT proxy (:4599)
npm run test:probe                # 48 checks  (probe engine, retries, proxy egress)
npm run test:quality              # 29 checks  (Stalker → quality pipeline, catch-up, genres)
npm run test:xtream               # 24 checks  (Xtream API → measurement engine)
npm run test:waves                # 105 checks (pure logic + mocked VAAPI fallback, no real ffmpeg/GPU)
```

`test:waves` needs no server (only loopback sockets); the other three expect the
fixture server on port 4599. No test touches the public internet.

---

## Remaining honest limits

* **One vantage point.** Measurements come from the scanner host, or from the
  configured proxy when you enable it. A viewer's Wi-Fi and ISP route can differ.
* **Short sample, N-of-M channels.** A handful of channels for a few seconds
  each. Peak-hour congestion, per-channel outages and long-run behaviour are
  only visible through monitoring over time.
* **Picture checks need a runnable FFmpeg.** The published Docker image bundles
  it on amd64 and arm64; local source runs without an FFmpeg binary skip picture
  checks while speed/stability/quality still work. VAAPI additionally requires
  supported hardware, an FFmpeg VAAPI build, the matching Intel driver and an
  accessible `/dev/dri/renderD128` (use `docker-compose.vaapi.yml` on the DS918+).
  Hardware decoding is opportunistic: failed attempts retry in software, while
  filters and JPEG conversion remain CPU-side. Freeze detection also needs a
  sustained interval (≥ 50 % of the sample) before it is reported.
* **UDP streams are unverifiable** from a scanner host: any UDP socket "connects".
  RTSP/RTMP are only liveness-checked (TCP + handshake), never measured for
  throughput or picture, and their verdict is labelled `reachable_only`.
* **No rebuffering/stall claims.** Without a decoder, MacAttack reports
  throughput deficits, segment stalls and continuity errors — not playback
  rebuffering counters.
* **Catch-up verification is a spot check**: one channel, one window a few hours
  back. It proves the archive works at that moment for that channel, not that
  every programme for the advertised depth is available.
* **Monitoring is pull-based.** Checks run when the UI button (or an external
  cron calling `PUT /api/scan/monitors`) asks for them; MacAttack does not run a
  daemon and sends nothing to third parties.
* **Xtream catch-up is not auto-verified** (the panel advertises it; the report
  says so). Xtream results are measured live-only.
