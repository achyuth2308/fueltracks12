#!/bin/bash
# ============================================================
# Postgres tuning for t2.small (2 GB RAM)
# ============================================================
# Aggressive — assumes NO other workload runs on this Postgres.
# Run ONCE per Postgres instance.
# If you ever resize to t2.medium/large or move to RDS, RE-RUN
# with appropriate values for the new instance.
# ============================================================

set -e

echo "[TUNE] Applying t2.small Postgres settings (2 GB RAM, 1 vCPU)..."

sudo -u postgres psql -d fueltracks <<SQL
-- Postgres itself uses ~256 MB. shared_buffers capped low to
-- leave room for Node.js processes + OS.
ALTER SYSTEM SET shared_buffers = '256MB';
ALTER SYSTEM SET work_mem = '8MB';           -- small because few concurrent queries
ALTER SYSTEM SET effective_cache_size = '1GB';
ALTER SYSTEM SET wal_buffers = '16MB';
ALTER SYSTEM SET max_connections = 50;       -- drop from default 100 (saves backend RAM)
ALTER SYSTEM SET maintenance_work_mem = '64MB';

-- TimescaleDB-friendly: more frequent checkpoints because we
-- can't afford huge dirty page buffers on 2 GB RAM.
ALTER SYSTEM SET checkpoint_completion_target = 0.9;
ALTER SYSTEM SET max_wal_size = '512MB';
ALTER SYSTEM SET min_wal_size = '64MB';

-- TimescaleDB compression background worker
ALTER SYSTEM SET max_worker_processes = 4;   -- t2.small has 1 vCPU, this is the OS ceiling
ALTER SYSTEM SET timescaledb.max_background_workers = 2;
SQL

sudo systemctl restart postgresql

echo "[TUNE] Restarting Postgres with new settings..."
sleep 3

echo "[TUNE] Verifying..."
sudo -u postgres psql -d fueltracks -c "SHOW shared_buffers; SHOW max_connections; SHOW work_mem;"

echo ""
echo "[TUNE] Memory check (post-tuning):"
free -h

echo ""
echo "[TUNE] Done. Expected Postgres RAM usage: ~400-500 MB."
echo "[TUNE] Remaining RAM for Node.js (tcp-server + writer + api + frontend): ~1.2 GB."
