# FuelTracks Scaling — Deployment Runbook

This runbook covers taking the scaling changes from this branch to
production. It assumes a single EC2 instance running all PM2 processes,
Postgres + Redis co-located. Adjust paths and hostnames to match your
infra.

---

## 0. Pre-flight checks

Before deploying, run these on the production EC2 and confirm output:

```bash
# Current EC2 capacity
nproc
free -h
df -h /var/lib/postgresql /var/log
ulimit -n
sysctl net.core.somaxconn net.ipv4.tcp_max_syn_backlog net.ipv4.tcp_mtu_probing

# Postgres configuration
sudo -u postgres psql -c "SHOW max_connections;"
sudo -u postgres psql -c "SHOW shared_buffers;"
sudo -u postgres psql -c "SELECT * FROM pg_available_extensions WHERE name='timescaledb';"

# Redis
redis-cli INFO memory | grep -E "used_memory_human|maxmemory_human"
redis-cli CONFIG GET maxmemory-policy
```

Expected:
- `nproc >= 4` (1 core for tcp, 1 for writer, 1 for api, 1 spare)
- `free -h`: at least 8 GB RAM
- `ulimit -n >= 65535` (will be set by `setup-server.sh`)
- `max_connections >= 100` (raise to 200 in postgresql.conf)
- `timescaledb` extension available

If any of these are short, fix them BEFORE deploying.

---

## 1. Apply server hardening (one-time, idempotent)

```bash
cd /home/ubuntu/fueltracks
sudo bash deploy/setup-server.sh
```

This will:
- raise `ulimit -n` to 65535
- raise `net.core.somaxconn` to 16384
- enable `net.ipv4.tcp_mtu_probing = 1` (the MSS=8961 fix, kernel-side)
- install + persist the iptables MSS clamp rule (belt-and-braces)
- log a verification summary

The script is idempotent — safe to re-run.

---

## 2. Install TimescaleDB extension (one-time, per Postgres install)

If `pg_available_extensions` did NOT list `timescaledb`, install the
extension package first:

### Ubuntu/Debian
```bash
# Add the TimescaleDB repo (follow current instructions at
# https://docs.timescale.com/self-hosted/latest/upgrades/upgrade-pg/)
echo "deb https://packagecloud.io/timescale/timescaledb/ubuntu/ $(lsb_release -cs) main" \
  | sudo tee /etc/apt/sources.list.d/timescaledb.list
sudo apt-get update
sudo apt-get install timescaledb-2-postgresql-16
sudo timescaledb-tune  # apply recommended settings
sudo systemctl restart postgresql
```

### RHEL/Amazon Linux
```bash
sudo yum install -y timescaledb-2-postgresql-16
sudo timescaledb-tune
sudo systemctl restart postgresql
```

After install, verify:
```bash
sudo -u postgres psql -d fueltracks -c "CREATE EXTENSION IF NOT EXISTS timescaledb;"
sudo -u postgres psql -d fueltracks -c "SELECT extname FROM pg_extension WHERE extname='timescaledb';"
```

---

## 3. Apply database migrations

The migration runner is idempotent — safe to re-run.

```bash
cd /home/ubuntu/fueltracks
node scripts/runMigrations.js
```

This runs in order:
1. `devices_migration.sql`
2. `audit_migration.sql`
3. `profile_migration.sql`
4. `geofence_route_migration.sql`
5. `raw_packets_enhancement_migration.sql`
6. `timescaledb_migration.sql` ← new in this release

After the migration, verify the hypertable is active:

```bash
sudo -u postgres psql -d fueltracks -c "
  SELECT hypertable_name, num_chunks
  FROM timescaledb_information.hypertables;

  SELECT view_name
  FROM timescaledb_information.continuous_aggregates;

  SELECT name, config FROM timescaledb_information.jobs
  WHERE application_name LIKE 'Compression%' OR application_name LIKE 'Retention%';
"
```

Expected output: `gps_points` listed as a hypertable, two continuous
aggregates (`gps_points_hourly`, `gps_points_daily`), and active
retention + compression policies.

---

## 4. Tune Postgres (one-time, after TimescaleDB install)

`timescaledb-tune` applies recommended settings. Re-check:

```bash
sudo -u postgres psql -d fueltracks -c "
  ALTER SYSTEM SET max_connections = 200;
  ALTER SYSTEM SET shared_buffers = '2GB';        -- ~25% of RAM
  ALTER SYSTEM SET work_mem = '64MB';
  ALTER SYSTEM SET effective_cache_size = '6GB';  -- ~75% of RAM
  ALTER SYSTEM SET wal_buffers = '64MB';
"
sudo systemctl restart postgresql
```

Verify:
```bash
sudo -u postgres psql -d fueltracks -c "SHOW max_connections;"
```

---

## 5. Restart PM2 with the new ecosystem config

```bash
cd /home/ubuntu/fueltracks

# Stop the old processes (the old config only had 3 apps;
# the new one has 4 — fueltracks-tcp, fueltracks-writer,
# fueltracks-api, fueltracks-frontend)
pm2 delete all

# Start the new config
pm2 start ecosystem.config.js

# Persist the process list
pm2 save

# Verify
pm2 status
```

Expected output: 4 processes online.
- `fueltracks-tcp`     — 3 protocol listeners on 5000/5001/5002
- `fueltracks-writer`  — DB write batcher (own event loop)
- `fueltracks-api`     — REST + Socket.io + alert stream
- `fueltracks-frontend`— serves the built SPA on :3000

---

## 6. Verify health + metrics endpoints

```bash
# TCP server health (port 5050)
curl -s http://localhost:5050/health | python3 -m json.tool
# Expected: status:OK, bstplConnections/ais140Connections/concoxConnections,
# portCaps with active vs cap

# TCP server metrics
curl -s http://localhost:5050/metrics | head -30
# Expected: fueltracks_tcp_packets_received_total, etc.

# API health (port 3001)
curl -s http://localhost:3001/health
# Expected: {success:true, status:OK, services:{database:'connected', redis:'connected'}}

# API metrics
curl -s http://localhost:3001/metrics | head -10
# Expected: fueltracks_api_http_requests_total, etc.

# Writer metrics (port 5060)
curl -s http://localhost:5060/metrics
# Expected: fueltracks_writer_received, fueltracks_writer_flushed, etc.
```

---

## 7. Smoke test: send a synthetic packet

If you have the simulator running locally, point it at the production
EC2 and verify a packet ends up in the DB:

```bash
# In tcp-server logs you should see "Total packets received" increase
pm2 logs fueltracks-tcp --lines 50 | grep -E "Stats|received"

# In writer logs you should see "Flushed batch: N gps_points"
pm2 logs fueltracks-writer --lines 50 | grep -E "Flushed|received"

# Verify it landed in TimescaleDB
sudo -u postgres psql -d fueltracks -c "
  SELECT COUNT(*) FROM gps_points WHERE device_time > NOW() - INTERVAL '5 minutes';
"
```

---

## 8. Run the GPS-no-fix detector (one-off + cron)

Manual run:
```bash
node scripts/detectGpsNoFixDevices.js
```

It surfaces:
- Devices online (last_seen < 1h) but no gps_points rows in the last hour
- Devices that have NEVER sent any GPS row

Wire to cron (every 6 hours):
```bash
crontab -e
# Add:
0 */6 * * * cd /home/ubuntu/fueltracks && node scripts/detectGpsNoFixDevices.js >> /var/log/fueltracks/gps-no-fix.log 2>&1
```

For proactive alerting, pipe the output to your notification system
(Slack webhook, email, PagerDuty).

---

## 9. Tunables reference

All of these can be overridden via environment variables in
`ecosystem.config.js` without code changes:

| Variable | Default | Purpose |
|---|---|---|
| `TCP_HIGH_WATER` | 50 | Per-socket in-flight publish count to trigger `socket.pause()` |
| `TCP_LOW_WATER` | 10 | Drain threshold to call `socket.resume()` |
| `TCP_PORT_CAP_BSTPL` | 12000 | Max simultaneous BSTPL connections |
| `TCP_PORT_CAP_AIS140` | 10000 | Max simultaneous AIS140 connections |
| `TCP_PORT_CAP_CONCOX` | 8000 | Max simultaneous Concox connections |
| `TCP_PER_IMEI_CAP` | 3 | Max simultaneous sockets per IMEI |
| `STREAM_MAXLEN` | 1000000 | Approximate cap on each Redis stream |
| `STREAM_BATCH_SIZE` | 200 | XREADGROUP COUNT per iteration |
| `STREAM_BLOCK_MS` | 1000 | XREADGROUP BLOCK duration |
| `WRITER_BATCH_ROWS` | 1000 | Flush trigger (rows) |
| `WRITER_BATCH_MS` | 1000 | Flush trigger (time) |
| `RAW_LOG_SAMPLE_RATE` | 100 | 1-in-N raw packet sampling (set 1 to disable) |
| `PG_POOL_MAX` | 50 | Per-process connection pool |
| `PG_STATEMENT_TIMEOUT_MS` | 30000 | Per-query statement timeout |

---

## 10. Rollback plan

If something goes wrong after deploy:

```bash
# Stop all scaling processes
pm2 stop fueltracks-writer fueltracks-api fueltracks-tcp fueltracks-frontend

# Revert code
git checkout <last-known-good-sha>
npm install --legacy-peer-deps

# Rebuild frontend
cd frontend && npm run build && cd ..

# Restart on old 3-process setup (pre-scaling)
pm2 start fueltracks-tcp   --cwd tcp-server -- server.js
pm2 start fueltracks-api   --cwd backend    -- server.js
pm2 start fueltracks-frontend --cwd frontend -- serve -s dist -l 3000
pm2 save
```

The database migrations are additive (TimescaleDB hypertable, new
columns, new indexes). Reverting code does NOT undo them. To fully
undo the hypertable conversion (only if absolutely necessary):

```bash
sudo -u postgres psql -d fueltracks -c "
  SELECT remove_retention_policy('gps_points');
  SELECT remove_compression_policy('gps_points');
  DROP MATERIALIZED VIEW IF EXISTS gps_points_hourly;
  DROP MATERIALIZED VIEW IF EXISTS gps_points_daily;
  -- (Do NOT drop the hypertable; that requires a full table copy)
"
```

---

## 11. What to monitor in the first 24h

- `fueltracks_tcp_packets_received_total` — should be ~3,000/s at 30k devices
- `fueltracks_tcp_packets_invalid_total` — should be <1% of received
- `fueltracks_tcp_backpressure_pauses_total` — should stay near 0;
  any sustained growth means downstream is too slow
- `fueltracks_tcp_rejected_by_cap_total` — should stay near 0; if
  growing, raise caps or investigate
- `fueltracks_writer_flush_rate` — should match packet rate
- `fueltracks_writer_insert_errors` — should stay 0; non-zero means
  DB is failing (check connection pool + statement_timeout)
- `fueltracks_api_http_request_duration_ms` p95 — should be <500ms
- `fueltracks_api_socketio_connections` — should track dashboard users

If any of these drift, capture a `pm2 logs --lines 500` and the
matching Postgres `pg_stat_activity` snapshot before escalating.
