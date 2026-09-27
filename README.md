# 🎯 MacAttack – IPTV Stalker Portal Scanner

A web-based IPTV Stalker middleware portal scanner for **Synology NAS DS918+**.

**The application is compiled by GitHub (GitHub Actions) and distributed as a
ready-made Docker image via GitHub Container Registry — the NAS itself never
builds anything.**

```
┌────────────┐  push to main  ┌─────────────────┐  docker push  ┌──────────────────────┐
│  this repo │ ─────────────▶ │ GitHub Actions  │ ────────────▶ │ ghcr.io/birdy1974/   │
│            │                │ (compiles app)  │               │ macattack            │
└────────────┘                └─────────────────┘               └──────────┬───────────┘
                                                                           │ docker pull
                                                              ┌────────────▼───────────┐
                                                              │ Synology NAS           │
                                                              │ docker compose up -d   │
                                                              └────────────────────────┘
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

## 🔄 Updating to the latest version

Every push to the `main` branch of this repository triggers a GitHub Actions
build and publishes a new image tagged `latest`. To update the NAS:

```bash
ssh admin@<NAS-IP>
cd /volume1/docker/mac-attack
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

- Workflow: [`.github/workflows/docker-image.yml`](.github/workflows/docker-image.yml)
  - Triggers: push to `main`, version tags (`v*`), manual run (`workflow_dispatch`)
  - Builds `linux/amd64` (the DS918+ is x86_64) using the multi-stage [`Dockerfile`](Dockerfile)
  - Pushes to `ghcr.io/birdy1974/macattack` with tags: `latest`, branch name,
    semver (for `vX.Y.Z` tags) and `sha-<commit>`
  - Uses the built-in `GITHUB_TOKEN`; no extra secrets needed

Watch runs under the repo's **Actions** tab, and published images under
**Packages**.

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
│   └── docker-image.yml   # CI: build image on GitHub, push to ghcr.io
├── Dockerfile             # Multi-stage image (built by GitHub Actions)
├── docker-compose.yml     # NAS deployment: pulls image from GHCR
├── update.sh              # One-command update on the NAS
├── docker-entrypoint.sh   # Waits for DB, applies schema, starts server
├── init-schema.js         # Database schema bootstrap
├── wait-for-db.js         # DB connection check
├── package.json           # Node.js dependencies
├── next.config.ts         # Next.js config (standalone output)
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
