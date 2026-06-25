# DEPLOY.md — FuelTracks Production Deployment

This is the single source of truth for deploying FuelTracks to
production. Read this top-to-bottom before deploying. Steps are
sequential — do not skip ahead.

The repo includes two complementary guides:
- **DEPLOY.md** (this file) — single-command deployment reference
- **SCALING_DEPLOY.md** — extended runbook with rollback plan,
  monitoring checklist, and detailed rationale

If you only have time to read one: read this file.

---

## 0. Prerequisites

Before you start, confirm these are available:

| Requirement | Why | Check |
|---|---|---|
| EC2 instance, Ubuntu 22.04+ or Amazon Linux 2023+ | Target host | `cat /etc/os-release` |
| 4+ vCPUs, 8+ GB RAM, 100+ GB EBS | Headroom for 10K devices | `nproc`, `free -h`, `df -h` |
| Root or sudo access | OS hardening, extension install | `sudo -n true` |
| Node.js 20.x installed | Backend runtime | `node --version` |
| PostgreSQL 16 + TimescaleDB 2.16 | Hypertables + retention + compression | `sudo -u postgres psql -c "SELECT extname FROM pg_extension WHERE extname='timescaledb';"` |
| Redis 7+ | Streams + Pub/Sub fallback | `redis-cli --version` |
| PM2 installed | Process manager | `pm2 --version` |
| `iptables-persistent` | Survives reboot for MSS clamp | `dpkg -l iptables-persistent` |

If any of those are missing, install them FIRST. Do not proceed.

---

## 1. Clone the repo and install dependencies

```bash
cd /home/ubuntu
git clone https://github.com/achyuth2308/fueltracks1.git
cd fueltracks1

# Backend deps
npm install --legacy-peer-deps

# Frontend deps + build
cd frontend
npm install --legacy-peer-deps
npm run build
cd ..

# Copy env file and edit secrets
cp .env.example .env
nano .env   # set JWT_SECRET, CORS_ORIGIN, DB_PASS, REDIS_HOST
```

The `--legacy-peer-deps` flag is needed because of a peer-dep
mismatch between `react-leaflet-cluster` and React 19. It's safe.

---

## 2. Harden the OS (one-time, idempotent)

```bash
sudo bash deploy/setup-server.sh
```

What this does (in order):

1. Sets `ulimit -n = 65535` (file-descriptor ceiling for 30K sockets)
2. Writes `/etc/sysctl.d/99-fueltracks.conf` with:
   - `net.core.somaxconn = 16384` (SYN backlog)
   - `net.ipv4.tcp_max_syn_backlog = 16384`
   - `net.ipv4.tcp_mtu_probing = 1` (the MSS=8961 fix, kernel-side)
   - TCP keepalive tuning for cellular NAT
3. Installs `iptables-persistent` (Debian) or `iptables-services` (RHEL)
4. Applies the iptables MSS clamp rule (belt-and-braces backup)
5. Saves the iptables rules so they survive reboot
6. Prints a verification summary

**Without this step, Concox devices silently fail to handshake on
the next reboot.** This is the exact bug that took an entire
debugging session in the field test to find. Run it once. Verify:

```bash
ulimit -n           # should be 65535
sysctl net.ipv4.tcp_mtu_probing   # should be 1
sudo iptables -C FORWARD -p tcp --tcp-flags SYN,RST SYN -j TCPMSS --clamp-mss-to-pmtu && echo OK
```

---

## 3. Install TimescaleDB extension (if not already)

```bash
# Ubuntu / Debian
echo "deb https://packagecloud.io/timescale/timescaledb/ubuntu/ $(lsb_release -cs) main" | sudo tee /etc/apt/sources.list.d/timescaledb.list
sudo apt-get update
sudo apt-get install -y timescaledb-2-postgresql-16
sudo timescaledb-tune
sudo systemctl restart postgresql

# Verify
sudo -u postgres psql -d fueltracks -c "CREATE EXTENSION IF NOT EXISTS timescaledb;"
sudo -u postgres psql -d fueltracks -c "SELECT extname FROM pg_extension WHERE extname='timescaledb';"
```

`timescaledb-tune` applies recommended Postgres settings. Re-apply
your own overrides on top:

```bash
sudo -u postgres psql -d fueltracks <<'EOF'
ALTER SYSTEM SET max_connections = 200;
ALTER SYSTEM SET shared_buffers = '2GB';       -- adjust for your RAM
ALTER SYSTEM SET work_mem = '64MB';
ALTER SYSTEM SET effective_cache_size = '6GB';
ALTER SYSTEM SET wal_buffers = '64MB';
EOF
sudo systemctl restart postgresql
```

---

## 4. Initialize the database (one-time)

```bash
cd /home/ubuntu/fueltracks

# Creates tables, indexes, triggers. Idempotent.
node scripts/dbInit.js

# Runs all migration files in order, including the TimescaleDB
# hypertable conversion + 180-day retention + 14-day compression.
node scripts/runMigrations.js
```

Verify the schema:

```bash
sudo -u postgres psql -d fueltracks -c "\dt"
sudo -u postgres psql -d fueltracks -c "SELECT hypertable_name FROM timescaledb_information.hypertables;"
sudo -u postgres psql -d fueltracks -c "SELECT view_name FROM timescaledb_information.continuous_aggregates;"
```

Expected:
- Tables: organizations, users, groups, vehicles, devices,
  gps_points, alerts, vehicle_latest_state, raw_packets,
  audit_logs, organization_profiles, geofences, routes, etc.
- Hypertable: `gps_points`
- Continuous aggregates: `gps_points_hourly`, `gps_points_daily`

---

## 5. Start all 4 PM2 processes

```bash
cd /home/ubuntu/fueltracks

# Stop any old setup (was 3 processes; new is 4 — added fueltracks-writer)
pm2 delete all 2>/dev/null || true

# Start the new ecosystem
pm2 start ecosystem.config.js

# Persist the process list so it survives reboots
pm2 save

# Set up systemd init so PM2 starts on boot
pm2 startup | sudo bash

# Verify
pm2 status
```

You should see 4 processes:

| Process | Role | Port |
|---|---|---|
| `fueltracks-tcp` | 3 protocol listeners (BSTPL/AIS140/Concox) | 5000/5001/5002 |
| `fueltracks-writer` | DB write batcher (own event loop, own core) | 5060 (metrics only) |
| `fueltracks-api` | REST + Socket.io + alert stream consumer | 3001 |
| `fueltracks-frontend` | Static SPA via `serve` | 3000 |

---

## 6. Verify health + metrics

```bash
# TCP server (5050) — JSON health + Prometheus metrics
curl -s http://localhost:5050/health
curl -s http://localhost:5050/metrics | head -20

# API (3001) — should report DB + Redis connected
curl -s http://localhost:3001/health

# API metrics
curl -s http://localhost:3001/metrics | head -10

# Writer (5060) — should show received/flushed counters
curl -s http://localhost:5060/metrics
```

If any of those return errors, check `pm2 logs <name> --lines 100`.

---

## 7. Smoke test with the simulator

```bash
cd /home/ubuntu/fueltracks

# Pick one protocol to test
npm run sim:bstpl
# or npm run sim:ais140 / npm run sim:concox
```

In another terminal, watch the logs:

```bash
pm2 logs fueltracks-tcp --lines 50
pm2 logs fueltracks-writer --lines 50
```

You should see (within 30 seconds):

- TCP: `Stats: received=N, parsed=N, invalid=0, devices=K`
- Writer: `Flushed batch: 1000 gps_points, uptime=30s, total flushed=N`

Verify the data hit Postgres:

```bash
sudo -u postgres psql -d fueltracks -c "SELECT COUNT(*) FROM gps_points WHERE device_time > NOW() - INTERVAL '5 minutes';"
```

Should be > 0.

---

## 8. Schedule GPS-no-fix detection cron

```bash
crontab -e
# Add this line (runs every 6 hours):
0 */6 * * * cd /home/ubuntu/fueltracks && /usr/bin/node scripts/detectGpsNoFixDevices.js >> /var/log/fueltracks/gps-no-fix.log 2>&1
```

Creates `/var/log/fueltracks/` first:

```bash
sudo mkdir -p /var/log/fueltracks
sudo chown ubuntu:ubuntu /var/log/fueltracks
```

This script surfaces:
- Vehicles online (last_seen < 1h) but zero gps_points in the last hour
- Vehicles that have NEVER produced any gps_points row

For 10K+ devices you cannot read logs manually. This cron replaces
that. Wire its output to Slack/email/PagerDuty for proactive alerts.

---

## 9. Smoke-test the full request path

```bash
# Login as superadmin (seed user)
TOKEN=$(curl -s -X POST http://localhost:3001/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"admin@fueltracks.in","password":"password123"}' \
  | python3 -c "import json,sys; print(json.load(sys.stdin)['token'])")

# List vehicles (should return 5 from the seed)
curl -s -H "Authorization: Bearer $TOKEN" http://localhost:3001/api/vehicles | python3 -m json.tool | head -30

# Dashboard stats
curl -s -H "Authorization: Bearer $TOKEN" http://localhost:3001/api/admin/dashboard | python3 -m json.tool

# Open the frontend in a browser
# http://<EC2-public-IP>:3000
```

---

## 10. What to monitor in the first 24 hours

```bash
# Make these Prometheus scrape targets (or just curl them):
# - http://<host>:5050/metrics   (tcp-server)
# - http://<host>:3001/metrics   (api)
# - http://<host>:5060/metrics   (writer)
```

Key metrics to watch:

| Metric | Healthy value | Action if wrong |
|---|---|---|
| `fueltracks_tcp_packets_received_total` rate | matches expected device count × packet rate | Investigate if flat |
| `fueltracks_tcp_packets_invalid_total` rate | <1% of received | Investigate parsing |
| `fueltracks_tcp_backpressure_pauses_total` rate | 0 or near-0 | Means downstream too slow — check writer + DB |
| `fueltracks_tcp_rejected_by_cap_total` rate | 0 | Means caps too low, or a misbehaving device |
| `fueltracks_writer_flush_rate` | matches packet rate | If lower, DB is bottleneck |
| `fueltracks_writer_insert_errors` | 0 | DB failing — check connection pool |
| `fueltracks_api_http_request_duration_ms` p95 | <500ms | Investigate slow queries |
| `fueltracks_api_socketio_connections` | matches dashboard users | Sanity check |

For a real fleet rollout, set up Prometheus + Grafana and alert on:
- `rate(fueltracks_writer_insert_errors[5m]) > 0`
- `rate(fueltracks_tcp_backpressure_pauses_total[5m]) > 10`
- `fueltracks_writer_buffer_size > 5000` (sustained)

---

## 11. Open the EC2 ports to the internet

Devices connect FROM the internet TO your EC2 on ports 5000/5001/5002.
Browsers connect on 3000/3001.

**Security Group inbound rules:**

| Type | Protocol | Port | Source | Purpose |
|---|---|---|---|---|
| Custom TCP | TCP | 5000 | 0.0.0.0/0 | BSTPL devices |
| Custom TCP | TCP | 5001 | 0.0.0.0/0 | AIS140 devices |
| Custom TCP | TCP | 5002 | 0.0.0.0/0 | Concox devices |
| Custom TCP | TCP | 3000 | 0.0.0.0/0 | Frontend (or restrict to your VPN) |
| Custom TCP | TCP | 3001 | 0.0.0.0/0 | REST API (or restrict to your CDN) |
| Custom TCP | TCP | 5050 | 10.0.0.0/8 | TCP metrics (internal only) |
| Custom TCP | TCP | 5060 | 10.0.0.0/8 | Writer metrics (internal only) |
| SSH | TCP | 22 | your IP | Admin |

You can also restrict 5000/5001/5002 to known carrier CIDR ranges
once you know which cellular operators your devices use.

---

## 12. Seed users (development only)

After `dbInit.js` you have these accounts (all password
`password123`):

| Email | Role |
|---|---|
| `admin@fueltracks.in` | superadmin |
| `dealer@abclogistics.com` | dealer |
| `dealer@xyztransport.com` | dealer |
| `customer@abcfleet.com` | customer |

**Change all passwords before going live.**

---

## 13. Rollback

If something goes wrong:

```bash
# Stop the new PM2 setup
pm2 stop fueltracks-writer fueltracks-api fueltracks-tcp fueltracks-frontend

# Revert code
cd /home/ubuntu/fueltracks
git checkout <last-known-good-sha>
npm install --legacy-peer-deps
cd frontend && npm run build && cd ..

# Restart on the OLD 3-process setup (pre-scaling)
pm2 delete all
pm2 start fueltracks-tcp   --cwd tcp-server  -- server.js
pm2 start fueltracks-api   --cwd backend     -- server.js
pm2 start fueltracks-frontend --cwd frontend -- serve -s dist -l 3000
pm2 save
```

DB migrations are additive. Reverting code does NOT undo them. To
fully undo the hypertable (only if absolutely necessary):

```bash
sudo -u postgres psql -d fueltracks <<'EOF'
SELECT remove_retention_policy('gps_points');
SELECT remove_compression_policy('gps_points');
DROP MATERIALIZED VIEW IF EXISTS gps_points_hourly;
DROP MATERIALIZED VIEW IF EXISTS gps_points_daily;
EOF
```

---

## 14. Local development (alternative to EC2)

For local development without an EC2, use Docker Compose:

```bash
# From repo root
docker compose -f docker-compose.local.yml up -d

# Wait for healthy (TimescaleDB + Redis)
docker compose -f docker-compose.local.yml ps

# Initialize DB (one-time per local env)
node scripts/dbInit.js
node scripts/runMigrations.js

# Run the 3 app processes (in 3 separate terminals)
npm run start:tcp      # :5000 :5001 :5002 :5050
npm run start:api      # :3001
cd frontend && npm run dev   # :5173 (Vite dev server, hot reload)
```

Verify:

```bash
curl -s http://localhost:5050/health
curl -s http://localhost:3001/health
open http://localhost:5173
```

Run smoke test:

```bash
node scripts/smoke-test.js
```

Expected: `8 passed, 0 failed.`

Run simulator against local:

```bash
node scripts/deviceSimulator.js bstpl
```

---

## Files & directories you should know

| Path | What it is |
|---|---|
| `DEPLOY.md` | This file — single-command deployment reference |
| `SCALING_DEPLOY.md` | Extended runbook + rollback plan + monitoring checklist |
| `FUELTRACKS_SCALE_AUDIT.md` | Original scaling audit (P0/P1/P2/P3 findings) |
| `SCALING_ROADMAP.md` | Phase tracker with rationale |
| `ecosystem.config.js` | PM2 config for the 4-process setup |
| `deploy/setup-server.sh` | One-shot OS hardening (ulimit, sysctl, iptables) |
| `database/schema.sql` | Base schema (tables + indexes + triggers) |
| `database/timescaledb_migration.sql` | Hypertable + retention + compression |
| `database/migrations/*.sql` | All other schema migrations |
| `scripts/runMigrations.js` | Runs migrations in order, idempotent |
| `scripts/dbInit.js` | One-time database initializer |
| `scripts/smoke-test.js` | 8-test validation, run after every deploy |
| `scripts/detectGpsNoFixDevices.js` | Cron-friendly GPS diagnostic |
| `scripts/deviceSimulator.js` | Multi-protocol packet simulator for load tests |
| `writer/server.js` | Dedicated DB-write process |
| `tcp-server/server.js` | 3-protocol TCP ingestion |
| `backend/server.js` | REST API + Socket.io |
| `backend/streams/redisStreams.js` | XREADGROUP consumer-group helper |
| `shared/metrics.js` | Lightweight Prometheus registry |
| `backend/middleware/rateLimit.js` | Token-bucket rate limiter |
| `docker-compose.local.yml` | Postgres + Redis for local dev |
| `.env.example` | Reference for all env vars (copy to `.env`) |

---

## Quick reference: command cheat sheet

```bash
# Start
pm2 start ecosystem.config.js && pm2 save

# Stop
pm2 stop all

# Restart (after env change)
pm2 restart all

# Logs
pm2 logs --lines 100
pm2 logs fueltracks-tcp --lines 50
pm2 logs fueltracks-writer --lines 50

# Health
curl -s http://localhost:5050/health
curl -s http://localhost:3001/health
curl -s http://localhost:5060/metrics

# DB
sudo -u postgres psql -d fueltracks -c "SELECT COUNT(*) FROM gps_points;"
sudo -u postgres psql -d fueltracks -c "SELECT hypertable_name FROM timescaledb_information.hypertables;"

# OS
ulimit -n
sysctl net.ipv4.tcp_mtu_probing
sudo iptables -C FORWARD -p tcp --tcp-flags SYN,RST SYN -j TCPMSS --clamp-mss-to-pmtu && echo "MSS clamp OK"

# Smoke test
node scripts/smoke-test.js

# GPS diagnostics
node scripts/detectGpsNoFixDevices.js

# Simulate devices
node scripts/deviceSimulator.js bstpl
```
