# GO_LIVE.md — From Download to Live, Step by Step

This is your single end-to-end guide. Follow steps in order. Don't skip.
Every command is copy-pasteable. Every "CHECK" line tells you what
the expected output looks like so you know if you got it right.

If a step fails, STOP. Read the failure carefully. Most failures are
one of: typo'd env var, port already in use, missing dependency,
DB not running. The CHECK lines below tell you the success state.

---

## STEP 1 — Download the bundle

**Where:** `/home/user/fueltracks1-scaling.tar.gz` (438 KB)

**On your laptop:**

```bash
# 1a. Create the project folder
mkdir -p ~/projects/fueltracks
cd ~/projects/fueltracks

# 1b. Download the tarball from wherever this sandbox serves it
#     (or scp from the sandbox host, or whatever transfer you use)
#     After download, the file should be here:
ls -lh fueltracks1-scaling.tar.gz
# CHECK: shows ~440K

# 1c. Extract
tar xzf fueltracks1-scaling.tar.gz
ls -la fueltracks1/
# CHECK: see folders tcp-server/, backend/, frontend/, writer/,
#        database/, scripts/, deploy/, docs/, shared/
#        AND files DEPLOY.md, SCALING_DEPLOY.md, DEPLOY_t2small.md,
#        RESIZE.md, GO_LIVE.md (this file), FUELTRACKS_SCALE_AUDIT.md,
#        SCALING_ROADMAP.md, README.md
```

---

## STEP 2 — Local test (no EC2 yet)

**Goal:** verify the system actually works end-to-end on your laptop
before touching any cloud infrastructure. If this fails, do NOT
proceed — fix local first.

### 2a. Prerequisites (one-time on laptop)

```bash
# macOS
brew install node@20 postgresql@16 redis docker docker-compose

# Ubuntu/Debian
sudo apt install -y nodejs npm postgresql-16 redis-server docker.io docker-compose-v2

# Verify
node --version      # should be v20.x
psql --version      # should be 16+
redis-cli --version # should be 7+
docker --version    # any v20+

# Clone the official TimescaleDB image (one-time)
docker pull timescale/timescaledb:2.16.1-pg16
```

### 2b. Start local Postgres + Redis via Docker

```bash
cd ~/projects/fueltracks/fueltracks1

# Start TimescaleDB + Redis (background)
docker compose -f docker-compose.local.yml up -d

# Wait for healthy
docker compose -f docker-compose.local.yml ps
# CHECK: both services show "healthy" status. If not, wait 30s and retry.

# Verify Postgres is up
docker exec -it $(docker ps -q -f name=fueltracks-timescale) psql -U postgres -d fueltracks -c "SELECT version();"
# CHECK: shows "PostgreSQL 16.x ... TimescaleDB ..."
```

### 2c. Initialize the database

```bash
cd ~/projects/fueltracks/fueltracks1

# Install backend deps (one-time)
npm install --legacy-peer-deps

# Create tables + seed
node scripts/dbInit.js
# CHECK: ends with "DATABASE INITIALIZATION COMPLETE!"

# Run migrations (creates hypertable, retention, compression)
node scripts/runMigrations.js
# CHECK: ends with "ALL MIGRATIONS COMPLETED SUCCESSFULLY!"

# Verify hypertable
docker exec -it $(docker ps -q -f name=fueltracks-timescale) psql -U postgres -d fueltracks -c "
  SELECT hypertable_name FROM timescaledb_information.hypertables;
  SELECT view_name FROM timescaledb_information.continuous_aggregates;
"
# CHECK: gps_points hypertable listed; gps_points_hourly + gps_points_daily views listed
```

### 2d. Build the frontend

```bash
cd frontend
npm install --legacy-peer-deps
npm run build
cd ..
# CHECK: ends with "✓ built in 2-3s" and creates dist/ folder
ls frontend/dist/ | head -5
# CHECK: index.html + assets/ folder
```

### 2e. Create your local `.env`

```bash
cd ~/projects/fueltracks/fueltracks1
cp .env.example .env

# Edit secrets — at minimum change JWT_SECRET
nano .env
```

Inside `.env`, set:
```
JWT_SECRET=<paste 64+ random chars from `openssl rand -hex 64`>
CORS_ORIGIN=*
DB_HOST=127.0.0.1
REDIS_HOST=127.0.0.1
```

### 2f. Run smoke test (no processes needed yet)

```bash
cd ~/projects/fueltracks/fueltracks1
node scripts/smoke-test.js
# CHECK: ends with "8 passed, 0 failed."
# If any fail: do NOT proceed. Read the failure message carefully.
```

### 2g. Start the 4 PM2 processes

If you don't have PM2 installed globally:
```bash
npm install -g pm2 serve
```

Then start:
```bash
cd ~/projects/fueltracks/fueltracks1
pm2 delete all 2>/dev/null || true
pm2 start ecosystem.config.js
pm2 save
pm2 status
# CHECK: shows 4 processes online:
#   fueltracks-tcp        (5000/5001/5002 + health 5050)
#   fueltracks-writer     (metrics only 5060)
#   fueltracks-api        (3001)
#   fueltracks-frontend   (3000)
```

### 2h. Verify health + metrics

Open 4 terminals (or background them) and verify each endpoint:

```bash
# TCP server
curl -s http://localhost:5050/health
# CHECK: JSON with bstplConnections, ais140Connections, concoxConnections, portCaps

curl -s http://localhost:5050/metrics | head -10
# CHECK: Prometheus text format with fueltracks_tcp_* counters

# API
curl -s http://localhost:3001/health
# CHECK: {success:true, status:"OK", services:{database:"connected", redis:"connected"}}

curl -s http://localhost:3001/metrics | head -10
# CHECK: fueltracks_api_* metrics

# Writer
curl -s http://localhost:5060/metrics
# CHECK: fueltracks_writer_received, fueltracks_writer_flushed counters
```

If any return error, check `pm2 logs <process-name> --lines 50`.

### 2i. Login + dashboard smoke test

```bash
# Login as the seed superadmin (password is 'password123')
TOKEN=$(curl -s -X POST http://localhost:3001/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"admin@fueltracks.in","password":"password123"}' \
  | python3 -c "import json,sys; print(json.load(sys.stdin)['token'])")

# List vehicles
curl -s -H "Authorization: Bearer $TOKEN" http://localhost:3001/api/vehicles | python3 -m json.tool | head -20
# CHECK: returns 5 seed vehicles (Truck Alpha, Truck Beta, etc.)

# Dashboard
curl -s -H "Authorization: Bearer $TOKEN" http://localhost:3001/api/admin/dashboard | python3 -m json.tool
# CHECK: total_vehicles: 5, online_vehicles: 0, organizations: 4
```

### 2j. Open the frontend in a browser

```bash
# Open in browser
open http://localhost:3000
# (or just navigate there manually)

# CHECK:
#   - Login page loads
#   - Login with admin@fueltracks.in / password123
#   - Dashboard shows 5 vehicles, 4 organizations, etc.
#   - Map renders (you'll see India default view)
#   - Click a vehicle → popup with "Loc: Fetching..." or "Loc: <street>"
```

### 2k. Run the device simulator

In a separate terminal:
```bash
cd ~/projects/fueltracks/fueltracks1
node scripts/deviceSimulator.js bstpl
# CHECK: see "Connected to TCP server" or similar; packets flowing
```

In another terminal:
```bash
pm2 logs fueltracks-tcp --lines 30
# CHECK: "Stats: received=N, parsed=N, invalid=0"

pm2 logs fueltracks-writer --lines 30
# CHECK: "Flushed batch: N gps_points"
```

Verify in DB:
```bash
docker exec -it $(docker ps -q -f name=fueltracks-timescale) psql -U postgres -d fueltracks -c "
  SELECT COUNT(*) FROM gps_points WHERE device_time > NOW() - INTERVAL '1 minute';
"
# CHECK: > 0
```

### 2l. ✅ Local test complete

If everything above works, you're ready to push to Git and deploy.

If something broke, common fixes:

| Symptom | Fix |
|---|---|
| `connection refused` on Postgres | `docker compose -f docker-compose.local.yml ps` — is timescale healthy? |
| `connection refused` on Redis | `docker ps -q -f name=fueltracks-redis` — is it running? |
| `relation "gps_points" does not exist` | `node scripts/dbInit.js` first, then `node scripts/runMigrations.js` |
| `extension "timescaledb" not found` | Use the docker image, not native postgres |
| `pm2: command not found` | `npm install -g pm2` |
| Port 3000/3001/5000 already in use | `lsof -i :3000` then kill the process |
| `npm install` fails on peer deps | add `--legacy-peer-deps` |

---

## STEP 3 — Push to Git

### 3a. Create a new GitHub repo (browser)

1. Go to https://github.com/new
2. Repository name: `fueltracks1` (or anything you want)
3. **Private** (recommended)
4. DO NOT initialize with README, .gitignore, or license (we have them)
5. Click "Create repository"

### 3b. Push your local copy

```bash
cd ~/projects/fueltracks/fueltracks1

# Initialize git (if not already)
git init

# Set your identity (use real GitHub email so commits show as you)
git config user.email "your-github-email@example.com"
git config user.name "Your Name"

# Add all files
git add -A

# First commit
git commit -m "Initial commit: scaling-ready FuelTracks"

# Add your new repo as origin
git remote add origin git@github.com:YOUR_USERNAME/fueltracks1.git
# (or https://github.com/YOUR_USERNAME/fueltracks1.git if you use HTTPS)

# Push
git push -u origin main
```

**CHECK:** GitHub shows your repo with all files. Visit
https://github.com/YOUR_USERNAME/fueltracks1 and confirm.

### 3c. (Optional) Add GitHub Actions for CI

The repo doesn't ship a workflow yet. If you want CI:

Create `.github/workflows/ci.yml`:
```yaml
name: CI
on: [push, pull_request]
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 20 }
      - run: npm install --legacy-peer-deps
      - run: node scripts/smoke-test.js
      - run: cd frontend && npm install --legacy-peer-deps && npm run build
```

This runs the smoke test on every push. Catches regressions early.

---

## STEP 4 — Provision a fresh EC2

### 4a. Launch the instance (AWS console)

1. AWS console → EC2 → Launch Instance
2. **AMI:** Ubuntu Server 22.04 LTS (or Amazon Linux 2023)
3. **Instance type:** start with **t3.small** (free-tier eligible, 2 GB RAM).
   You can resize later using `RESIZE.md` if you outgrow it.
4. **Storage:** 30 GB gp3 (default is fine for 500 devices; resize
   to 100+ GB if going to 10K)
5. **Security Group** — create new with these inbound rules:

| Type | Protocol | Port | Source | Purpose |
|---|---|---|---|---|
| SSH | TCP | 22 | Your IP | Admin access |
| Custom TCP | TCP | 5000 | 0.0.0.0/0 | BSTPL devices |
| Custom TCP | TCP | 5001 | 0.0.0.0/0 | AIS140 devices |
| Custom TCP | TCP | 5002 | 0.0.0.0/0 | Concox devices |
| Custom TCP | TCP | 3000 | 0.0.0.0/0 | Frontend (later restrict) |
| Custom TCP | TCP | 3001 | 0.0.0.0/0 | REST API (later restrict) |
| Custom TCP | TCP | 5050 | Your IP | TCP metrics |
| Custom TCP | TCP | 5060 | Your IP | Writer metrics |

6. **Key pair:** create new or use existing. Save the .pem file!
7. Click **Launch Instance**

### 4b. Allocate + associate Elastic IP (recommended)

Elastic IPs are free as long as they're attached to a running instance.
Without one, your instance's public IP changes every time you stop/start.

1. EC2 → Elastic IPs → Allocate new address
2. Actions → Associate → select your instance
3. Note the IP — this is your stable public address.

### 4c. SSH in and prepare

```bash
# From your laptop (assuming key is at ~/Downloads/fueltracks-key.pem)
chmod 400 ~/Downloads/fueltracks-key.pem
ssh -i ~/Downloads/fueltracks-key.pem ubuntu@<your-elastic-ip>
```

If you used Amazon Linux, the user is `ec2-user`, not `ubuntu`.

Once in:
```bash
# Update packages
sudo apt update && sudo apt install -y curl git build-essential

# Install Node.js 20.x
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo bash -
sudo apt install -y nodejs

# Install PM2 + serve globally
sudo npm install -g pm2 serve

# Verify
node --version      # v20.x
pm2 --version       # 5.x or 6.x

# Create the project dir
sudo mkdir -p /var/log/fueltracks
sudo chown ubuntu:ubuntu /var/log/fueltracks
```

### 4d. Clone the repo

```bash
cd /home/ubuntu
git clone https://github.com/YOUR_USERNAME/fueltracks1.git
cd fueltracks1
```

If your repo is private, use a personal access token:
```bash
git clone https://YOUR_TOKEN@github.com/YOUR_USERNAME/fueltracks1.git
```

### 4e. Install TimescaleDB extension

```bash
# Add the TimescaleDB repo (Ubuntu)
echo "deb https://packagecloud.io/timescale/timescaledb/ubuntu/ $(lsb_release -cs) main" | sudo tee /etc/apt/sources.list.d/timescaledb.list
sudo apt-get update
sudo apt-get install -y timescaledb-2-postgresql-16
sudo timescaledb-tune   # accepts all defaults
sudo systemctl restart postgresql

# Verify
sudo -u postgres psql -c "CREATE EXTENSION IF NOT EXISTS timescaledb;"
# CHECK: CREATE EXTENSION (no error)
```

### 4f. Install + initialize Postgres + apply migrations

```bash
cd /home/ubuntu/fueltracks1

# Install backend deps
npm install --legacy-peer-deps

# Install Redis (also running on same box)
sudo apt install -y redis-server
sudo systemctl enable redis-server
sudo systemctl start redis-server

# Build frontend
cd frontend
npm install --legacy-peer-deps
npm run build
cd ..

# Create .env (use t2.small config)
cp .env.t2small.example .env
nano .env
# Change JWT_SECRET, CORS_ORIGIN (later set to your domain)

# Initialize DB
node scripts/dbInit.js
node scripts/runMigrations.js
```

### 4g. OS hardening (one-time)

```bash
sudo bash deploy/setup-server.sh
# This raises ulimit, sets sysctl, persists MSS clamp.
```

If you used Amazon Linux instead of Ubuntu, `setup-server.sh` may
need adjustments for iptables-persistent vs iptables-services. The
sysctl + ulimit parts work on any Linux.

### 4h. Tune Postgres for t3.small

```bash
sudo bash scripts/tune-postgres-t2small.sh
# Sets shared_buffers=256MB, max_connections=50, etc.
```

### 4i. Start PM2 with the 4-process setup

```bash
cd /home/ubuntu/fueltracks1

# Stop anything stale
pm2 delete all 2>/dev/null || true

# Start the new ecosystem
pm2 start ecosystem.config.js

# Persist the process list (so it restarts on reboot)
pm2 save

# Auto-start on boot
pm2 startup | sudo bash

# Verify
pm2 status
# CHECK: 4 processes online: fueltracks-tcp, fueltracks-writer,
#        fueltracks-api, fueltracks-frontend
```

### 4j. Verify everything works

```bash
# All health checks
curl -s http://localhost:5050/health
curl -s http://localhost:3001/health
curl -s http://localhost:5060/metrics | head -5

# Smoke test
node scripts/smoke-test.js
# CHECK: 8 passed, 0 failed.
```

### 4k. (Optional) Run the 24h single-device soak

```bash
node scripts/stress-test.js \
  --devices 3 --ramp-step 3 --ramp-interval-ms 100 \
  --packet-rate 0.067 --duration-sec 86400 \
  --protocols all \
  > /var/log/fueltracks/soak.log 2>&1 &
```

Watch for 1h, then come back later to confirm no memory leaks.

---

## STEP 5 — Go live (make it publicly accessible)

### 5a. Open the right ports (already done in 4a, but verify)

EC2 → Security Groups → your instance's SG → Inbound rules:
```
22   SSH         Your IP only
5000 BSTPL       0.0.0.0/0
5001 AIS140      0.0.0.0/0
5002 Concox      0.0.0.0/0
3000 Frontend    0.0.0.0/0  (or your VPN/CDN only)
3001 REST API    0.0.0.0/0  (or your VPN/CDN only)
5050 Metrics     Your IP only
5060 Metrics     Your IP only
```

### 5b. DNS (recommended)

Get a domain (e.g. `app.fueltracks.in`) and point it at your Elastic IP.

1. Namecheap / Route53 / Cloudflare — buy `app.fueltracks.in`
2. Add an A record: `app.fueltracks.in → <your-elastic-ip>`
3. Add an A record: `api.fueltracks.in → <your-elastic-ip>` (same IP)

Then update `.env`:
```
CORS_ORIGIN=https://app.fueltracks.in
```

And `pm2 restart all`.

### 5c. HTTPS (strongly recommended)

You need HTTPS for production. The simplest setup: Cloudflare in
front of your EC2 (free tier).

1. Sign up at cloudflare.com
2. Add your domain (app.fueltracks.in), point NS to Cloudflare
3. Cloudflare dashboard → SSL/TLS → set to "Full"
4. Cloudflare dashboard → DNS → add A record pointing to Elastic IP
5. Cloudflare proxies traffic, terminates HTTPS, forwards to HTTP on your EC2

Alternatively, use Let's Encrypt + nginx reverse proxy on the EC2:
```bash
sudo apt install -y nginx certbot python3-certbot-nginx
# Create /etc/nginx/sites-available/fueltracks with reverse proxy config
sudo certbot --nginx -d app.fueltracks.in
```

### 5d. Change default passwords

The seed users all have password `password123`. CHANGE these before
exposing the system publicly:

1. Login as superadmin in the browser
2. Go to Users → click each user → Change Password
3. Or do it directly in DB:
   ```sql
   -- Generate bcrypt hash for new password (use a JS one-liner):
   -- node -e "console.log(require('bcryptjs').hashSync('YOUR_NEW_PASSWORD', 10))"
   UPDATE users SET password = '<new_bcrypt_hash>' WHERE email = 'admin@fueltracks.in';
   ```

### 5e. Seed real vehicles (optional)

The seed has 5 demo vehicles with placeholder IMEIs. To add real
devices:

1. Login as dealer/admin
2. Vehicles → Add Vehicle
3. Enter real 15-digit IMEI from your physical devices
4. Configure the device's SMS settings to point to your EC2:
   - BSTPL: `SERVER,0,<your-ip>,5000,0#`
   - AIS140: similar with port 5001
   - Concox: similar with port 5002

When devices connect, they appear as online within 30 seconds.

### 5f. Smoke test from outside

From your laptop (NOT on the EC2):

```bash
# Frontend
curl -s -I https://app.fueltracks.in
# CHECK: 200 OK (or 301 redirect)

# API
curl -s https://api.fueltracks.in/health
# CHECK: {success:true, status:"OK", ...}

# TCP — can't curl-test, but check the port is open
nc -zv app.fueltracks.in 5000
nc -zv app.fueltracks.in 5001
nc -zv app.fueltracks.in 5002
# CHECK: each says "Connection to app.fueltracks.in 500X port [tcp/*] succeeded!"
```

### 5g. ✅ You're live

If the curls above work, you're done. Your system is publicly
accessible.

---

## STEP 6 — Monitor + maintain

### 6a. PM2 daily health check

```bash
ssh ubuntu@<elastic-ip>
pm2 status
pm2 logs --lines 100
```

Look for:
- All 4 processes online
- No restart loops (`↺` column shows restart count)
- Memory under 400 MB per process

### 6b. Metrics dashboard (Prometheus + Grafana, optional)

For real fleet rollout, scrape the 3 metrics endpoints:
- `:5050/metrics` — TCP server
- `:3001/metrics` — API
- `:5060/metrics` — Writer

Set up Prometheus + Grafana on a separate instance or use a managed
service (Grafana Cloud free tier works).

Key alerts to set:
- `rate(fueltracks_writer_insert_errors[5m]) > 0` → DB issue
- `rate(fueltracks_tcp_backpressure_pauses_total[5m]) > 10` → writer slow
- `fueltracks_writer_buffer_size > 5000` for 5+ min → sustained overload
- `fueltracks_tcp_rejected_by_cap_total` increasing → raise caps

### 6c. GPS-no-fix cron

```bash
# One-time
crontab -e
# Add:
0 */6 * * * cd /home/ubuntu/fueltracks1 && /usr/bin/node scripts/detectGpsNoFixDevices.js >> /var/log/fueltracks/gps-no-fix.log 2>&1
```

Check `/var/log/fueltracks/gps-no-fix.log` periodically. Devices
listed there are connected but not producing GPS rows — likely a
GPS antenna problem.

### 6d. Backup

Before going live with real fleets, set up Postgres backups:

```bash
# Automated daily pg_dump
sudo mkdir -p /var/backups/fueltracks
sudo crontab -e
# Add:
0 2 * * * sudo -u postgres pg_dump -Fc fueltracks > /var/backups/fueltracks/db-$(date +\%Y\%m\%d).dump
0 3 * * * find /var/backups/fueltracks -name "db-*" -mtime +7 -delete
```

Test the backup:
```bash
# Restore on a staging box
pg_restore -d fueltracks_test /var/backups/fueltracks/db-20260624.dump
```

### 6e. Resize when you outgrow the instance

Use `RESIZE.md` for the procedure. TL;DR:
1. AWS console: Stop instance → Change type → Start
2. SSH back, run `sudo bash scripts/resize-ec2.sh`
3. Verify with smoke test

Realistic device count by instance:
- t3.small (free): 300-500
- t3.medium ($30): 1K-2K
- t3.large ($60): 3K-6K
- t3.xlarge ($120): 10K-15K
- t3.2xlarge ($240): 25K-30K
- Multi-EC2 + RDS ($400+): 30K+

---

## Common failure modes and fixes

| Symptom | Likely cause | Fix |
|---|---|---|
| `EADDRINUSE :::3001` on pm2 start | Old process still on port | `pm2 delete all && pm2 start ecosystem.config.js` |
| TimescaleDB errors after deploy | Extension not installed | Re-run `sudo apt install -y timescaledb-2-postgresql-16` |
| Devices connect but no data shows | IMEI not registered | Add the vehicle via the admin UI; IMEI must match device's SMS config |
| Concox devices drop after 30s | MSS clamp missing | `sudo bash deploy/setup-server.sh` (idempotent) |
| API returns 429 | Rate limit hit | Reduce stress or raise `userReadLimit`/`userWriteLimit` |
| Frontend shows "Location unavailable" | Nominatim down or rate-limited | Wait 1 minute; cache will populate gradually |
| `node scripts/smoke-test.js` fails | Env vars or DB not set up | Re-run Steps 4e-4i |
| Stress test shows high `reconnects` | TCP server not running or port blocked | `pm2 logs fueltracks-tcp` |

---

## Files you'll reference repeatedly

| File | When |
|---|---|
| `GO_LIVE.md` (this) | First-time deploy |
| `DEPLOY.md` | Initial deployment reference |
| `DEPLOY_t2small.md` | When on free-tier instance |
| `RESIZE.md` | When you outgrow the current instance |
| `SCALING_DEPLOY.md` | Detailed runbook + rollback plan |
| `docs/STRESS_TEST.md` | When you want to validate scaling |
| `scripts/smoke-test.js` | After every deploy |
| `scripts/detectGpsNoFixDevices.js` | Daily cron for GPS diagnostic |
| `FUELTRACKS_SCALE_AUDIT.md` | Background on WHY the code is the way it is |
| `SCALING_ROADMAP.md` | Phase tracker — what's done, what's left |
| `README.md` | Original repo README |

---

## Final checklist

After completing all 6 steps, verify:

```bash
# From your laptop:
curl -sI https://app.fueltracks.in    # 200 OK
curl -s  https://api.fueltracks.in/health  # success: true

# From EC2 via SSH:
pm2 status                              # 4 processes online
node scripts/smoke-test.js              # 8/8 pass
curl -s http://localhost:5050/metrics | head -3   # Prometheus output
curl -s http://localhost:5060/metrics | head -3
```

If all of those work, you're live. Time to build the mobile app.
