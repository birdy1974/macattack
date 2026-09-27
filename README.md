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

---

## 🚀 Installation on Synology NAS (no compilation!)

All you need on the NAS is the **docker-compose.yml** file (and optionally
**update.sh**). No source code, no Node.js, no build tools.

### Step 1: Copy the compose file to the NAS

```bash
# From your computer (adjust path/IP):
scp docker-compose.yml update.sh admin@<NAS-IP>:/volume1/docker/mac-attack/
```

Or upload the two files with **Synology File Station** to
`/volume1/docker/mac-attack/`.

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
Select which data fields to include in results.

### 4. Start Scan
Click **🚀 Start Scan** and watch the console log.

### 5. Filter Logs
Use the filter buttons to show/hide:
- ℹ️ Info messages
- ✅ Success messages
- ⚠️ Warning messages
- ❌ Error messages

### 6. Download Results
Export to CSV or TXT when valid MACs are found.

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
└── initial/               # Reference copy of the original local-build version
```

---

## ⚠️ Legal Disclaimer

Only use MacAttack on portals you own or have explicit permission to test.

---

## 📝 License

MIT License – For educational and authorized testing purposes only.
