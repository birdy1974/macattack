# 🎯 MacAttack – IPTV Stalker Portal Scanner

A web-based IPTV Stalker middleware portal scanner for **Synology NAS DS918+**.

---

## 🚀 Installation on Synology NAS

### Step 1: Copy Files to NAS

Copy the entire project folder to your NAS:

```bash
# Using SCP from your computer
scp -r ./ admin@<NAS-IP>:/volume1/docker/mac-attack/
```

Or use **Synology File Station** to upload the folder to `/volume1/docker/mac-attack/`

### Step 2: SSH into NAS

```bash
ssh admin@<NAS-IP>
cd /volume1/docker/mac-attack
```

### Step 3: Build with Extended Timeout

The build takes 10-15 minutes. Use the build script:

```bash
chmod +x build.sh
./build.sh
```

**Or manually with extended timeout:**

```bash
# Set extended timeouts (prevents "deadline exceeded" errors)
export DOCKER_CLIENT_TIMEOUT=600
export COMPOSE_HTTP_TIMEOUT=600

# Start database first
docker-compose up -d db
sleep 10

# Build the app (this takes 10-15 minutes)
docker build --network=host -t mac-attack-app .

# Start everything
docker-compose up -d
```

### Step 4: Access the Web Interface

Open your browser:
```
http://<YOUR-NAS-IP>:3099
```

---

## ⚠️ Troubleshooting Build Timeouts

### Error: "DeadlineExceeded: context deadline exceeded"

This happens because the NAS CPU is slow. Try these solutions:

#### Solution 1: Use the Build Script
```bash
chmod +x build.sh
./build.sh
```

#### Solution 2: Build Manually with Timeout
```bash
export DOCKER_CLIENT_TIMEOUT=600
export COMPOSE_HTTP_TIMEOUT=600
docker build --network=host -t mac-attack-app .
docker-compose up -d
```

#### Solution 3: Build in Background
```bash
# Start build and detach
nohup docker build --network=host -t mac-attack-app . > build.log 2>&1 &

# Check progress
tail -f build.log

# When done, start the app
docker-compose up -d
```

#### Solution 4: Increase Docker Daemon Timeout

Edit `/var/packages/Docker/etc/dockerd.json`:
```json
{
  "builder": {
    "gc": {
      "defaultKeepStorage": "20GB"
    }
  }
}
```

Then restart Docker:
```bash
sudo synoservicectl --restart pkgctl-Docker
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
docker-compose logs -f app

# Stop
docker-compose down

# Restart
docker-compose restart

# Rebuild (after updates)
docker build --network=host -t mac-attack-app .
docker-compose up -d

# Reset database
docker-compose down -v
docker-compose up -d
```

---

## 📁 Required Files

```
mac-attack/
├── Dockerfile           # Docker build instructions
├── docker-compose.yml   # Service definitions
├── build.sh            # Build script with timeouts
├── package.json         # Node.js dependencies
├── init-schema.js       # Database schema
├── wait-for-db.js       # DB connection check
├── next.config.ts       # Next.js config
├── tsconfig.json        # TypeScript config
├── drizzle.config.json  # Database ORM config
└── src/                 # Source code
    ├── app/             # Next.js pages & API routes
    ├── db/              # Database schema
    └── lib/             # Scanner logic
```

---

## ⚠️ Legal Disclaimer

Only use MacAttack on portals you own or have explicit permission to test.

---

## 📝 License

MIT License – For educational and authorized testing purposes only.
