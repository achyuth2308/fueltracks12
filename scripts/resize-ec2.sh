#!/bin/bash
# ============================================================
# Vertical resize guide — FuelTracks EC2
# ============================================================
# Resizes the running EC2 to a larger instance type without
# losing data, code, or env vars. Then re-tunes Postgres and
# updates the .env to match the new hardware.
#
# USE THIS WHEN:
#   - You've outgrown t2.small (>300-500 devices)
#   - You want to scale up temporarily for a load test
#   - You want to scale down to save money overnight
#
# WHAT IT DOES NOT DO:
#   - It does NOT stop your services. You stop them manually.
#   - It does NOT change the instance type (you do that in AWS
#     console / CLI; this script just re-tunes after the resize).
#
# TWO-PHASE PROCESS:
#   Phase 1: Stop services, resize instance in AWS (manual)
#   Phase 2: Run this script to retune + restart
# ============================================================

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR/.."

echo "[RESIZE] ============================================"
echo "[RESIZE] FuelTracks EC2 vertical resize"
echo "[RESIZE] ============================================"
echo ""

# Step 1: Detect current hardware
echo "[RESIZE] Step 1: Detect current hardware"
NCPU=$(nproc)
TOTAL_RAM_MB=$(free -m | awk '/^Mem:/ {print $2}')
echo "[RESIZE]   vCPU: $NCPU"
echo "[RESIZE]   RAM:  ${TOTAL_RAM_MB} MB"
echo ""

# Step 2: Recommend target instance based on current
echo "[RESIZE] Step 2: Recommended target instances"
if [ "$NCPU" -le 1 ] && [ "$TOTAL_RAM_MB" -le 2048 ]; then
  echo "[RESIZE]   Current: t2.micro / t2.small / t3.micro"
  echo "[RESIZE]   Recommended: t3.medium (2 vCPU, 4 GB) for 1K devices"
  echo "[RESIZE]   Or:           t3.large (2 vCPU, 8 GB) for 3K devices"
  TARGET_TIER="low"
elif [ "$NCPU" -le 2 ] && [ "$TOTAL_RAM_MB" -le 4096 ]; then
  echo "[RESIZE]   Current: t2.medium / t3.small / t3.medium"
  echo "[RESIZE]   Recommended: t3.large (2 vCPU, 8 GB) for 3K-5K devices"
  echo "[RESIZE]   Or:           t3.xlarge (4 vCPU, 16 GB) for 10K devices"
  TARGET_TIER="medium"
elif [ "$NCPU" -le 4 ] && [ "$TOTAL_RAM_MB" -le 16384 ]; then
  echo "[RESIZE]   Current: t3.large / t3.xlarge"
  echo "[RESIZE]   Recommended: t3.2xlarge (8 vCPU, 32 GB) for 25K-30K devices"
  TARGET_TIER="high"
else
  echo "[RESIZE]   Current: t3.2xlarge or larger"
  echo "[RESIZE]   For 30K+, you also need RDS + ElastiCache split"
  TARGET_TIER="veryhigh"
fi
echo ""

# Step 3: Generate target .env
echo "[RESIZE] Step 3: Generate tuned .env for $TARGET_TIER tier"
case "$TARGET_TIER" in
  low)
    PG_POOL=15
    BSTPL_CAP=600; AIS140_CAP=500; CONCOX_CAP=400
    HIGH_WATER=30; LOW_WATER=8
    BATCH_ROWS=300; BATCH_MS=750
    STREAM_MAX=300000
    PG_BUF=384MB; PG_MAX_CONN=80
    ;;
  medium)
    PG_POOL=30
    BSTPL_CAP=2500; AIS140_CAP=2000; CONCOX_CAP=1500
    HIGH_WATER=40; LOW_WATER=10
    BATCH_ROWS=500; BATCH_MS=1000
    STREAM_MAX=500000
    PG_BUF=1GB; PG_MAX_CONN=120
    ;;
  high)
    PG_POOL=50
    BSTPL_CAP=12000; AIS140_CAP=10000; CONCOX_CAP=8000
    HIGH_WATER=50; LOW_WATER=10
    BATCH_ROWS=1000; BATCH_MS=1000
    STREAM_MAX=1000000
    PG_BUF=2GB; PG_MAX_CONN=200
    ;;
  veryhigh)
    PG_POOL=80
    BSTPL_CAP=15000; AIS140_CAP=12000; CONCOX_CAP=10000
    HIGH_WATER=80; LOW_WATER=15
    BATCH_ROWS=2000; BATCH_MS=1000
    STREAM_MAX=2000000
    PG_BUF=4GB; PG_MAX_CONN=300
    ;;
esac

echo "[RESIZE]   Recommended .env values:"
echo "[RESIZE]     PG_POOL_MAX=$PG_POOL"
echo "[RESIZE]     TCP_PORT_CAP_BSTPL=$BSTPL_CAP  AIS140=$AIS140_CAP  CONCOX=$CONCOX_CAP"
echo "[RESIZE]     TCP_HIGH_WATER=$HIGH_WATER  LOW_WATER=$LOW_WATER"
echo "[RESIZE]     WRITER_BATCH_ROWS=$BATCH_ROWS  MS=$BATCH_MS"
echo "[RESIZE]     STREAM_MAXLEN=$STREAM_MAX"
echo "[RESIZE]     shared_buffers=$PG_BUF"
echo "[RESIZE]     max_connections=$PG_MAX_CONN"
echo ""

# Step 4: Apply Postgres tuning
echo "[RESIZE] Step 4: Apply Postgres tuning"
sudo -u postgres psql -d fueltracks <<SQL
ALTER SYSTEM SET shared_buffers = '$PG_BUF';
ALTER SYSTEM SET max_connections = $PG_MAX_CONN;
ALTER SYSTEM SET work_mem = '$(echo $((TOTAL_RAM_MB / 256)))MB';
ALTER SYSTEM SET effective_cache_size = '$(echo $((TOTAL_RAM_MB * 3 / 4)))MB';
SQL
sudo systemctl restart postgresql
sleep 3
echo "[RESIZE]   Postgres restarted with new settings"
echo ""

# Step 5: Update .env
echo "[RESIZE] Step 5: Update .env with new tuning values"
if [ -f .env ]; then
  cp .env .env.backup-$(date +%Y%m%d-%H%M%S)
  echo "[RESIZE]   Backed up current .env"
fi

# Use the appropriate example file as starting point
if [ "$TOTAL_RAM_MB" -le 2048 ]; then
  EXAMPLE=.env.t2small.example
elif [ "$TOTAL_RAM_MB" -le 8192 ]; then
  EXAMPLE=.env.example
else
  EXAMPLE=.env.example
fi

if [ ! -f "$EXAMPLE" ]; then
  EXAMPLE=.env.example
fi

cp "$EXAMPLE" .env
# Apply the tier-specific values
sed -i "s/^PG_POOL_MAX=.*/PG_POOL_MAX=$PG_POOL/" .env
sed -i "s/^TCP_PORT_CAP_BSTPL=.*/TCP_PORT_CAP_BSTPL=$BSTPL_CAP/" .env
sed -i "s/^TCP_PORT_CAP_AIS140=.*/TCP_PORT_CAP_AIS140=$AIS140_CAP/" .env
sed -i "s/^TCP_PORT_CAP_CONCOX=.*/TCP_PORT_CAP_CONCOX=$CONCOX_CAP/" .env
sed -i "s/^TCP_HIGH_WATER=.*/TCP_HIGH_WATER=$HIGH_WATER/" .env
sed -i "s/^TCP_LOW_WATER=.*/TCP_LOW_WATER=$LOW_WATER/" .env
sed -i "s/^WRITER_BATCH_ROWS=.*/WRITER_BATCH_ROWS=$BATCH_ROWS/" .env
sed -i "s/^WRITER_BATCH_MS=.*/WRITER_BATCH_MS=$BATCH_MS/" .env
sed -i "s/^STREAM_MAXLEN=.*/STREAM_MAXLEN=$STREAM_MAX/" .env

echo "[RESIZE]   .env updated. Edit DB_PASS and JWT_SECRET if needed."
echo ""

# Step 6: Restart PM2
echo "[RESIZE] Step 6: Restart PM2 with new env"
pm2 restart all
sleep 3
pm2 status
echo ""

# Step 7: Verify
echo "[RESIZE] Step 7: Verify"
echo "[RESIZE]   TCP server health:"
curl -s http://localhost:5050/health | head -5
echo ""
echo "[RESIZE]   API health:"
curl -s http://localhost:3001/health | head -5
echo ""
echo "[RESIZE]   Writer metrics:"
curl -s http://localhost:5060/metrics | grep -E "received|flushed" | head -5
echo ""

# Step 8: Run smoke test
echo "[RESIZE] Step 8: Run smoke test"
node scripts/smoke-test.js
echo ""

echo "[RESIZE] ============================================"
echo "[RESIZE] Done. Hardware upgrade + retune complete."
echo "[RESIZE]   Realistic device ceiling at this tier: $TARGET_TIER"
echo "[RESIZE] ============================================"
echo ""
echo "[RESIZE] Next steps:"
echo "[RESIZE]   1. Run a 24h single-device soak (Phase 0 of stress test)"
echo "[RESIZE]   2. Then ramp up to your target device count"
echo "[RESIZE]   3. Watch the metrics; iterate if needed"
