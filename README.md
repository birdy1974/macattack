# 🎯 MacAttack – IPTV Stalker Portal Scanner

A web-based IPTV Stalker middleware portal scanner for **Synology NAS DS918+**
and **Raspberry Pi 4**.

**The application is compiled by GitHub (GitHub Actions) and distributed as a
ready-made Docker image via GitHub Container Registry — neither the NAS nor the
Pi ever builds anything.** One published image serves both hosts, because it is
a **multi-platform image**:

| Architecture | Device |
|---|---|
| `linux/amd64` | Synology DS918+ (Intel Celeron J3455) |
| `linux/arm64` (aarch64) | Raspberry Pi 4 with 64-bit Raspberry Pi OS |

```
┌────────────┐  push to main  ┌─────────────────┐  docker push  ┌────────────────────────┐
│  this repo │ ─────────────▶ │ GitHub Actions  │ ────────────▶ │ ghcr.io/birdy1974/     │
│            │                │ (compiles app)  │               │ macattack              │
└────────────┘                └─────────────────┘               │ amd64 + arm64 manifest│
                                                                  └───────────┬───────────┘
                                                                              │ docker pull
                                                            ┌─────────────────┴─────────────────┐
                                                  ┌─────────▼─────────┐                 ┌─────────▼─────────┐
                                                  │ Synology NAS      │                 │ Raspberry Pi 4    │
                                                  │ x86_64            │                 │ aarch64           │
                                                  │ docker compose    │                 │ docker compose    │
                                                  │ up -d             │                 │ up -d             │
                                                  └───────────────────┘                 └───────────────────┘
```

### What it does beyond finding MACs

* **Measures the streams it finds** — lists the portal's channels, resolves real
  URLs with `create_link`, and probes a genre-spread sample: sustained throughput
  vs. required bitrate, resolution/codec/DRM, HLS segment pacing (can the link
  keep up with real time?), MPEG-TS continuity errors, and a
  speed / picture / stability score with a verdict.
* **Picture checks with bundled FFmpeg** — freeze/black detection, decoded
  FPS/bitrate profiling, and thumbnails work out of the box on both architectures.
  On the DS918+, optional Intel VAAPI decoding is attempted when `/dev/dri` is
  mapped; unsupported hardware/codecs fall back to software automatically.
* **Trust over time** — every measurement is stored as a probe run; results show
  an EWMA score, an improving/stable/degrading trend, a sparkline and alerts.
* **Paste work, not click work** — bulk MAC lists, extra portals for a
  second-chance re-check, capped parallel checks with per-host rate limiting.
* **Hard evidence flags** — frozen picture, label-vs-reality mismatches ("4K"
  that delivers 720p), transient retries, catch-up (archive) verification,
  quality per genre, and where each measurement is limited.
* **Optional egress proxy** with a validator, **user-agent rotation** with a
  per-portal memory, **monitoring + alerts**, **stable revocable M3U
  subscription URLs**, and **Xtream Codes** accounts alongside Stalker.

The published NAS/Pi image includes FFmpeg; optional hardware acceleration is
runtime-detected and never required. See
[`docs/wave-implementation.md`](docs/wave-implementation.md) for the shipped
feature list, tests and remaining limits.

---

## 🚀 Installation on Synology NAS (no compilation!)

For a standard install, copy **docker-compose.yml** (and optionally
**update.sh**). To enable optional Intel VAAPI decoding, also copy
**docker-compose.vaapi.yml**. No source code, Node.js or build tools are needed.

### Step 1: Copy the compose file to the NAS

```bash
# From your computer (adjust path/IP):
scp docker-compose.yml update.sh admin@<NAS-IP>:/volume1/docker/mac-attack/
# Optional, only for VAAPI: also copy docker-compose.vaapi.yml to the same directory
```

Or upload the base files with **Synology File Station** to
`/volume1/docker/mac-attack/` (plus `docker-compose.vaapi.yml` if enabling VAAPI).

### Step 2: Start the stack

```bash
ssh admin@<NAS-IP>
cd /volume1/docker/mac-attack

docker compose up -d          # on older DSM: docker-compose up -d
```

Docker now pulls the ready-made image `ghcr.io/birdy1974/macattack:latest`
from GitHub Container Registry and starts it together with PostgreSQL.
This takes seconds to a couple of minutes — instead of the old 10–15 minute
local build.

### Step 3: Access the web interface

```
http://<YOUR-NAS-IP>:3099
```

### Optional: enable Intel VAAPI decoding on the DS918+

The default compose file needs no GPU device and uses software decode. If DSM
exposes the Intel render node, map it with the optional override so FFmpeg can
try hardware decoding (the app automatically retries in software on failure):

```bash
# Check the device and its group on the NAS first:
ls -l /dev/dri/renderD128
stat -c '%g' /dev/dri/renderD128

# Copy docker-compose.vaapi.yml to this directory, then use the numeric group ID:
export RENDER_GID="$(stat -c '%g' /dev/dri/renderD128)"
docker compose -f docker-compose.yml -f docker-compose.vaapi.yml up -d
```

This is optional and only applies to the amd64 DS918+ image. If DSM does not
expose `/dev/dri/renderD128`, keep using the base compose file; software FFmpeg
continues to provide picture analysis.

> The repository is public, so the image can be pulled anonymously.
> If the repository (or GHCR package) is ever made private, log in first:
> ```bash
> echo "<PERSONAL-ACCESS-TOKEN>" | docker login ghcr.io -u <GITHUB-USERNAME> --password-stdin
> ```

---

## 🍓 Installation on Raspberry Pi 4 (aarch64, no compilation!)

The **exact same `docker-compose.yml`** works on the Pi — the image is
published for `linux/arm64` as well, so Docker pulls the right variant
automatically. There is no separate compose file and no local build.

Requirements: a 64-bit Raspberry Pi OS (Bookworm or newer) with Docker
installed (e.g. `sudo apt install docker.io docker-compose-v2`).

### Step 1: Copy the compose file to the Pi

```bash
# From your computer (adjust path/IP):
scp docker-compose.yml update.sh pi@<PI-IP>:~/mac-attack/
```

### Step 2: Start the stack

```bash
ssh pi@<PI-IP>
cd ~/mac-attack

docker compose up -d          # or: docker-compose up -d
```

Docker detects the Pi's `aarch64` CPU and pulls the `linux/arm64` variant of
`ghcr.io/birdy1974/macattack:latest`. PostgreSQL runs from `postgres:16-alpine`,
which also has an arm64 build.

### Step 3: Access the web interface

```
http://<YOUR-PI-IP>:3099
```

The Pi is shared with other workloads, so if you ever hit memory limits, cap
the containers in the compose file:

```yaml
    mem_limit: 512m        # app
    mem_limit: 256m        # db
```

### Verify the architecture

```bash
docker image inspect ghcr.io/birdy1974/macattack:latest \
  --format '{{.Architecture}}'          # -> arm64 on the Pi
docker exec mac-attack uname -m          # -> aarch64
```

### ⚠️ 32-bit Raspberry Pi OS is not supported

If `uname -m` on your Pi reports `armv7l`, the host runs a 32-bit OS and there
is no `linux/arm/v7` manifest. Either reinstall with the **64-bit** Raspberry
Pi OS (recommended), or trigger a one-off build with the extra platform:

```bash
gh workflow run docker-image.yml -f platforms=linux/amd64,linux/arm64,linux/arm/v7
```

Then pull the `sha-…` tag that run produced.

---

## 🔄 Updating to the latest version

Every push to the `main` branch of this repository triggers a GitHub Actions
build and publishes a new image tagged `latest`. To update the NAS **or** the Pi:

```bash
ssh admin@<NAS-IP>            # or: ssh pi@<PI-IP>
cd /volume1/docker/mac-attack # or: cd ~/mac-attack
./update.sh
```

…or manually:

```bash
docker compose pull
docker compose up -d
```

---

## 🏗️ How the build works (for maintainers)

| Old way | New way |
|---|---|
| `docker build` on the NAS (10–15 min, frequent timeouts) | GitHub Actions builds on fast runners |
| Source code copied to the NAS | Only `docker-compose.yml` on the NAS |
| `build.sh`, `docker-compose.quick.yml` workarounds | Single `docker compose up -d` + `update.sh` |
| amd64-only image (crashed on a Pi) | One multi-arch image: `linux/amd64` + `linux/arm64` |

- Workflow: [`.github/workflows/docker-image.yml`](.github/workflows/docker-image.yml)
  - Triggers: push to `main`, version tags (`v*`), manual run (`workflow_dispatch`)
  - Builds `linux/amd64,linux/arm64` using the multi-stage [`Dockerfile`](Dockerfile)
  - Pushes to `ghcr.io/birdy1974/macattack` with tags: `latest`, branch name,
    semver (for `vX.Y.Z` tags) and `sha-<commit>`
  - Uses the built-in `GITHUB_TOKEN`; no extra secrets needed

Watch runs under the repo's **Actions** tab, and published images under
**Packages**.

### How one build covers both architectures

The app is pure JavaScript, so the compiled output is identical everywhere.
The [`Dockerfile`](Dockerfile) exploits that to keep multi-arch builds fast:

| Stage | Platform | Runs |
|---|---|---|
| `deps` | `$BUILDPLATFORM` (native x86_64) | `npm install` — **once** |
| `build` | `$BUILDPLATFORM` (native x86_64) | `next build` — **once** |
| `runner` | target (`amd64` **or** `arm64`) | per-arch `node:20-alpine` base + `adduser` |

Only the tiny runtime stage is architecture-specific, so the expensive npm and
Next.js work runs a single time instead of once per platform (usually under
slow QEMU emulation). The workflow still installs QEMU via
`docker/setup-qemu-action`, because that one `addgroup`/`adduser` call in the
runtime stage has to execute for the target CPU.

> **⚠️ The one thing that breaks arm64:** Next.js traces the optional `sharp`
> dependency (the image optimizer) into `.next/standalone`, including the
> **x86_64-only** binaries `@img/sharp-linux-x64` and
> `@img/sharp-libvips-linux-x64` — 33 MB of `.node` files that a Pi cannot
> load (`Cannot find module '@img/sharp-linux-arm64'`). MacAttack never uses
> `next/image`, so the build stage deletes `sharp` and `@img/*` from the
> standalone output, and `next.config.ts` sets `images.unoptimized` so nothing
> can reach the optimizer. This also shrinks the app payload from 52 MB to
> 20 MB — which matters a lot on a Pi's network.
>
> If you ever add a real native module, build that stage for the target
> platform instead of `$BUILDPLATFORM`.

To pin the NAS to a specific release instead of `latest`, change the image
line in `docker-compose.yml`, e.g.:

```yaml
image: ghcr.io/birdy1974/macattack:v1.2.0
```

---

## 📖 Usage

### 1. Enter Portal URL
Enter a Stalker middleware URL (usually ends in `/c/`):
```
http://example.com/c/
http://example.com:8080/stalker_portal/c/
```

### 2. Skip Verification (if needed)
Enable "Skip portal verification" if auto-detection fails.

### 3. Configure Output Fields
Select which data fields to include in results. Among them are three **per-MAC category totals**
recorded for every saved result:

- **ITV Genres Retrieved (count)** — live TV genres the portal returned (`get_genres`, `type=itv`).
- **VOD Categories Retrieved (count)** — movie/VOD categories (`get_categories`, `type=vod`).
- **Series Categories Retrieved (count)** — series/shows categories (`get_categories`, `type=series`).

All three category lists are fetched for every valid MAC so the counts are always available; the
reported number is the number of entries the portal answered with (`0` when the portal answered
but returned nothing, empty when the list could not be retrieved). They appear in the results
table, in CSV/TXT exports and in the JSON export, and can be toggled like any other field.

**Column order is remembered.** Drag a field by its ⠿ handle (or focus the handle and press
`Alt` + `↑`/`↓`) and the new order is saved automatically to the `settings` table
(`output_field_order`). It is restored on the next page load and reused for future scans, so the
results table, the download buttons and the server-side CSV/TXT/JSON exports all keep the order
you chose. A stored order is cleaned when it is applied: duplicate keys are dropped, fields that
no longer exist are ignored and fields added by a later release are appended. Saving an empty
order returns the list to the default order.

### 4. Start Scan
Click **🚀 Start Scan** and watch the console log.

### 4a. Scan scope: prefix, bulk list, extra portals (optional)
The **Scan scope** box chooses what gets checked:

* **Enumerate prefix** — the classic behaviour: every MAC in the prefix space.
* **Bulk MAC list** — paste up to 5,000 addresses (one per line, commas/dashes
  fine, `portal|mac` pairs accepted). Duplicates are removed and unusable
  entries are reported after the job is queued.
* **Additional portals** — one per line. Rejected MACs are retried once against
  the next portal (round-robin), so a dead server cannot stall a run.
* **Parallel MAC checks** — 1 (default) up to 8, rate-limited per portal host.
  Higher values also parallelise the quality check (≤ 4 channel probes at once).

### 5. Filter Logs
Use the filter buttons to show/hide:
- ℹ️ Info messages
- ✅ Success messages
- ⚠️ Warning messages
- ❌ Error messages

The **Auto-refresh** switch next to the filters pauses/resumes live console updates while a scan
runs — handy for reading back through earlier output. Progress, results and job status keep
polling while it is off; only the log list is frozen. Use **🔄 Refresh now** to pull the latest
entries once, or flip the switch back on to resume (the newest lines appear immediately). The
preference is stored in your browser and survives reloads.

### 6. Download Results
Export to CSV or TXT when valid MACs are found. JSON exports include the complete portal responses and the detailed quality report; treat these files as sensitive because portal responses can contain credentials.

### 7. Read the quality report
The report separates portal responsiveness from actual stream delivery:

- At scan start, MacAttack records eight TCP connection attempts to the portal, including the individual timings, failures, median, p95, variation, and sample window. It also records one HTTP handshake-endpoint timing breakdown (DNS, TCP, TLS, TTFB, total, and status).
- For each saved result, it records the Stalker handshake and `account_info` request times separately and together. These are control/API timings, not channel startup times.
- **When a MAC passes your filters, MacAttack measures the real media path** (on by default, see step 8):
  it lists the portal's channels, resolves real stream URLs with `create_link`, and probes a genre-spread
  sample of those streams. It measures sustained throughput vs. the bitrate the stream needs, the variant
  ladder (resolution/codec/bandwidth), HLS segment transfer time vs. segment duration (can the connection
  keep up with real time?), MPEG-TS continuity-counter errors and scrambled packets, and DRM.
- The result is a **speed / picture-quality / stability / overall score (0–10) with a verdict**, stored per
  result and exportable (`Stream Quality Verdict`, `Stream Quality Score`, …). Every report lists what it
  does **not** establish: it is a short sample from the scanner host, no video is decoded (so picture
  freezes are not detected), and it cannot see peak-hour congestion.

### 8. Stream quality check (optional, on by default)
The **🎚️ Stream quality check** panel controls the media-path probe:

- **Channels to probe (1–8)** — spread across genres so one broken category cannot dominate the verdict.
- **Sample per channel (3–30 s)** — longer windows catch stalls and bitrate dips.

The UI shows a **Streams** column per result and, in *Quality details*, a per-channel table with verdict and
sub-scores, plus buttons to **Re-check streams** (streams change over time) and **Download M3U** (export the
account's playable channels as a playlist — the same idea as Flux-Stream's Stalker→M3U converter). Stream
URLs are stored with session tokens removed, so a re-check always performs a fresh `create_link`.

The full reasoning, the scoring model, and a comparison against the wider tool ecosystem (IPTVChecker,
Flux-Stream, Stalker-Portal-Checker, m3u-editor, multicast-checker, …) with the feature gaps we still have
lives in [`docs/iptv-tool-landscape.md`](docs/iptv-tool-landscape.md).

### 8a. Optional add-ons (Advanced panel)
Open **🧰 Advanced** in the header:

* **Host capabilities** — FFmpeg availability (with the exact failure reason and
  every path tried when missing), detected VAAPI device, and the thumbnail
  cache location/age/writability, plus a **↻ Re-check** button that re-runs
  detection without a restart. The published Docker image bundles FFmpeg;
  local source runs can install it or set `FFMPEG_PATH`. On the DS918+, use the
  optional `docker-compose.vaapi.yml` overlay to pass through `/dev/dri`.
* **User-agent candidates** — the rotation list tried when a portal refuses the
  default MAG user agent. The first working one is remembered per portal host.
* **Proxy pool** — `host:port` or `user:pass@host:port`, up to 50 entries, used
  for stream probes and quality checks (a second vantage point for suspected
  geo-blocks). **Validate proxies** connects through each one and records
  latency.
* **Monitoring & alerts** — enable *Monitor* on a found MAC to re-check it on an
  interval; **Run due checks now** executes everything that is due (an external
  cron can `PUT /api/scan/monitors` instead). Alerts appear on the result.
* **Xtream Codes** — paste a URL containing `username`/`password`: *Check login*
  verifies the account, *Check + sample streams* measures live streams with the
  same engine as Stalker results.

### 8b. Per-result extras
Each measured result offers **Trend history** (probe runs, EWMA, sparkline),
**Subscription URL** (a stable, revocable `?token=` M3U URL you can paste into a
player — links are re-resolved on every fetch) and evidence badges (frozen
picture, label mismatch, retries, catch-up state, EWMA/trend).

### 9. Set allowed work hours (optional)
Open **Schedule** and enable the schedule to choose allowed days and start/end
hours in an IANA time zone (for example, `Europe/London`). A running scan pauses
automatically outside those windows and resumes when the next window opens;
overnight windows are supported by setting the end time earlier than the start.
Turn off **Enable work schedule** to allow MacAttack to run at all times.

---

## 🧪 Tests

All suites run offline against the bundled fixture server:

```bash
npm run fixtures        # terminal 1: mock Stalker portal + Xtream API + CONNECT proxy (:4599)
npm run test:probe      # stream-probe engine, retries, proxy egress
npm run test:quality    # Stalker → quality pipeline, catch-up, genre groups
npm run test:xtream     # Xtream Codes login/catalogue/measurement
npm run test:waves      # pure logic (no server needed)
```

---

## ⚙️ Optional environment variables

| Variable | Effect |
|---|---|
| `FFMPEG_PATH` | Path to `ffmpeg` when it is not on `PATH` (local source runs only — leave unset in Docker, where the bundled binary is found on PATH; detection still falls back to PATH if the override is wrong) |
| `MACATTACK_FFMPEG_HWACCEL` | `auto` (default) or `vaapi` to attempt VAAPI when supported/device-accessible; set `none` to force software decoding |
| `MACATTACK_FFMPEG_DRI_DEVICE` | Optional Linux DRI render-device path (default detection tries `/dev/dri/renderD128`, then `/dev/dri/card0`) |
| `MACATTACK_DATA_DIR` | Base directory for the thumbnail cache — files land in `<dir>/thumbnails` (default `./data`, pruned after 14 days; the bundled compose file mounts a volume at `/app/data` so they survive updates) |
| `MACATTACK_STB_USER_AGENT` | Overrides the default MAG user agent |
| `MACATTACK_ALLOW_LOCAL_STREAMS=1` | Test escape hatch: allow loopback stream URLs (used by the fixture suites) |
| `MACATTACK_FREEZE_NOISE`, `MACATTACK_FREEZE_MIN_SEC`, `MACATTACK_BLACK_MIN_SEC` | Tune ffmpeg freeze/black thresholds |

---

## 🏠 Home Assistant Integration

1. Click **HA Settings** button
2. Enter your Home Assistant URL and access token
3. Specify an entity ID (e.g., `sensor.macattack_found`)
4. The entity updates in real-time as MACs are found

---

## 🔧 Management Commands

```bash
# View logs
docker compose logs -f app

# Stop
docker compose down

# Restart
docker compose restart

# Pull + restart with newest image
docker compose pull && docker compose up -d

# Reset database (deletes all data!)
docker compose down -v && docker compose up -d
```

---

## ⚠️ Troubleshooting

### Image can't be pulled ("unauthorized" / "not found")
- Make sure the GitHub repository is **public** (or the GHCR package
  visibility is public).
- Otherwise log in first:
  `echo "<PAT>" | docker login ghcr.io -u <GITHUB-USER> --password-stdin`
- Check that the workflow has run successfully at least once
  (repo → **Actions** tab) so the `latest` tag exists.
- If you only see the tag but not both platforms, check the workflow's
  **Build image and push to GHCR** step — an arm64 build may have failed.

### `no matching manifest for linux/arm64` / `exec format error`
Your host architecture isn't in the published manifest list:
- **Raspberry Pi**: confirm 64-bit OS with `uname -m`. It must print
  `aarch64`; `armv7l` means a 32-bit OS, which needs `linux/arm/v7`
  (see [32-bit Raspberry Pi OS](#️-32-bit-raspberry-pi-os-is-not-supported)).
- Check what the published tag actually contains:
  `docker buildx imagetools inspect ghcr.io/birdy1974/macattack:latest`

### Container restarts in a loop on the Pi
Most likely the Pi is out of memory. Add `mem_limit` to both services, or
raise the Pi's swap. Check with `docker stats`.

### Old page shown after an update
Do a hard refresh in the browser: **Ctrl+Shift+R** (Windows) or
**Cmd+Shift+R** (Mac).

### App doesn't start
```bash
docker compose logs -f app
```
The container waits for PostgreSQL, applies the schema, then starts the
Next.js server — give it a few seconds on first boot.

### Host capabilities says "ffmpeg: not found"
The panel now shows the exact reason plus every path that was tried. The usual
causes, in order:

1. **Old image.** FFmpeg is bundled in current images — if the container was
   created before that, pull the latest one and recreate it:
   `docker compose pull app && docker compose up -d` (or `./update.sh`).
2. **Wrong `FFMPEG_PATH` override.** Inside Docker the variable must be unset
   (the app finds `/usr/bin/ffmpeg` on PATH by itself). A custom compose file
   that sets `FFMPEG_PATH` to a host path breaks detection — remove the line
   and recreate the container.
3. **Stale reading.** Detection is cached per process. After fixing 1–2, press
   **↻ Re-check** in the Host capabilities panel instead of restarting.

Verify from the host at any time:

```bash
docker exec mac-attack ffmpeg -hide_banner -version | head -n 1
docker exec mac-attack printenv FFMPEG_PATH   # should print nothing in Docker
docker compose logs app | grep -i ffmpeg
```

### Thumbnails are missing / the data directory stays empty
Every quality check now logs what happened to each capture, so start there:

- `📸 Thumbnails saved: N → /app/data/thumbnails` — the files are there (inside
  the container/volume, not necessarily in a host folder).
- `⚠ <dir> is not writable by the app user (uid 1001) — thumbnails are written
  to /tmp/macattack-thumbnails instead …` — the configured data directory cannot
  be written, so MacAttack kept working by using the fallback directory. Those
  files are served by the app but disappear when the container is recreated.
  Fix the mount or its ownership, then press **↻ Re-check** in the Host
  capabilities panel.
- `⚠ No thumbnail for <channel>: <reason>` — ffmpeg could not grab a frame.
  Common reasons on real portals: `no frame decoded within 20s (…)` when the
  stream is offline/DRM-protected or the portal refuses another simultaneous
  connection, or an ffmpeg stderr line such as `Server returned 403 Forbidden`.
  Lower **Channels to probe** / check the portal's connection limit if a MAC
  allows only one at a time.

Where the files live: `<MACATTACK_DATA_DIR>/thumbnails` inside the container
(`/app/data/thumbnails` with the bundled compose file). With the default
Docker-managed volume `mac-attack-data:/app/data` that directory is **not** a
host folder — list it with
`docker exec mac-attack ls -la /app/data/thumbnails`. A host bind mount must be
writable by uid 1001, e.g.
`chown -R 1001:1001 /volume1/docker/mac-attack/data` on the NAS.

The Host capabilities panel reports the directory, the file count, whether it is
writable, and whether writes are falling back to `/tmp`.

---

## 📁 Repository Layout

```
.
├── .github/workflows/
│   └── docker-image.yml   # CI: build amd64+arm64 image on GitHub, push to ghcr.io
├── Dockerfile             # Multi-stage, multi-arch image (built by GitHub Actions)
├── docker-compose.yml     # NAS / Raspberry Pi deployment: pulls image from GHCR
├── update.sh              # One-command update on the NAS or Pi
├── docker-entrypoint.sh   # Waits for DB, applies schema, starts server
├── init-schema.js         # Database schema bootstrap
├── wait-for-db.js         # DB connection check
├── package.json           # Node.js dependencies
├── next.config.ts         # Next.js config (standalone output, unoptimized images)
├── tsconfig.json          # TypeScript config
├── drizzle.config.json    # Database ORM config
├── src/                   # Source code
│   ├── app/               # Next.js pages & API routes
│   ├── db/                # Database schema
│   └── lib/               # Scanner logic
│       ├── scanner.ts         # MAC enumeration + portal validation
│       ├── mac-list.ts        # bulk MAC list parsing
│       ├── proxy.ts           # proxy parsing/validation + CONNECT tunnels
│       ├── user-agents.ts     # UA rotation candidates + per-host memory
│       ├── parallel.ts        # capped concurrency + per-host rate limiter
│       ├── label-mismatch.ts  # "4K" label vs. measured reality
│       ├── ffmpeg-tools.ts    # FFmpeg analysis, VAAPI attempt + software fallback
│       ├── thumbnail-store.ts # on-disk thumbnail cache (self-pruning)
│       ├── quality-history.ts # EWMA / trend / degradation maths
│       ├── xtream-streams.ts  # Xtream Codes API client
│       ├── xtream-quality.ts  # Xtream accounts → shared measurement engine
│       ├── stream-probe.ts    # media-path measurement (HLS/MPEG-TS, no ffmpeg)
│       ├── stalker-streams.ts # handshake → channels → create_link → M3U
│       ├── mac-quality.ts     # per-MAC speed/quality/stability check
│       └── quality-report.ts  # honest, reproducible quality reporting
├── docs/
│   ├── iptv-tool-landscape.md  # ecosystem deep dive + feature gaps
│   ├── feature-gap-roadmap.md  # tabular roadmap (all waves implemented)
│   └── wave-implementation.md  # what shipped, how it is tested, limits
├── scripts/               # offline fixtures, integration and unit suites
│   ├── probe-fixtures.mjs     # mock Stalker portal + Xtream API + CONNECT proxy
│   ├── probe-tests.ts         # probe engine (53 checks)
│   ├── mac-quality-tests.ts   # Stalker quality pipeline (32 checks)
│   ├── xtream-tests.ts        # Xtream API path (27 checks)
│   └── wave-tests.ts          # pure logic + mocked VAAPI picture/thumbnail fallback + abort hygiene (139 checks)
└── initial/               # Reference copy of the original local-build version
```

---

## ⚠️ Legal Disclaimer

Only use MacAttack on portals you own or have explicit permission to test.

---

## 📝 License

MIT License – For educational and authorized testing purposes only.
