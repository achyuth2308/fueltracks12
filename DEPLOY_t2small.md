# DEPLOY_t2small.md — FuelTracks on AWS Free Tier (t2.small / t2.micro)

This is the deployment reference for AWS free-tier instances
(t2.micro 1 GB / t2.small 2 GB / t3.micro 1 GB). For
production-grade 10K+ device deployments, follow `DEPLOY.md`
on a `t3.large` or larger instance instead.

**Realistic ceiling on t2.small:**

| Device count | Status on t2.small |
|---|---|
| 0–300 | ✅ Runs cleanly |
| 300–500 | ⚠️ Tight but works; watch CPU saturation |
| 500–1000 | ❌ Single core becomes the bottleneck; expect packet loss |
| 1000+ | ❌ Not viable. Move to `t3.large` (8 GB RAM, 2 vCPU) at minimum, `t3.xlarge` for headroom. |

The 1-vCPU constraint is fundamental: with fork-mode PM2, tcp-server,
writer, and api each want a dedicated core. They time-share on
1 vCPU and the slowest task (usually Postgres) blocks everything.

---

## Step 0 — Instance size verification

```bash
nproc          # MUST be 1 or 2
free -h        # MUST show ~1 GB or ~2 GB total
df -h /        # MUST show ~30 GB or more
```

If you have `t3.small` (2 vCPU, 2 GB), the ceiling roughly doubles.
If you have `t2.medium` (2 vCPU, 4 GB), you can comfortably hit 1K
devices.

---

## Step 1 — OS hardening (same as DEPLOY.md, one-time)

```bash
cd /home/ubuntu/fueltracks
sudo bash deploy/setup-server.sh
```

On t2.small, this raises `ulimit -n` to 65535 and persists the MSS
clamp. The iptables MSS clamp is critical for Concox device
handshakes.

---

## Step 2 — Install TimescaleDB extension

Same as DEPLOY.md step 2. TimescaleDB runs on t2.small but uses
~300 MB of RAM just for the extension + background workers.

```bash
# Ubuntu
echo "deb https://packagecloud.io/timescale/timescaledb/ubuntu/ $(lsb_release -cs) main" | sudo tee /etc/apt/sources.list.d/timescaledb.list
sudo apt-get update
sudo apt-get install -y timescaledb-2-postgresql-16
sudo timescaledb-tune   # Auto-applies; we override below.
```

---

## Step 3 — Postgres tuning for t2.small

**This is critical.** The defaults from `timescaledb-tune` are tuned
for instances with much more RAM. On t2.small they will OOM-kill
Postgres or cause excessive swap thrashing.

```bash
sudo bash scripts/tune-postgres-t2small.sh
```

This sets:
- `shared_buffers = 256MB` (vs. `timescaledb-tune`'s ~512MB default)
- `max_connections = 50` (vs. default 100)
- `work_mem = 8MB`
- `max_worker_processes = 4` (the OS ceiling on t2.small)
- `timescaledb.max_background_workers = 2`

Expected RAM usage after this:
- Postgres: ~400-500 MB
- Node.js (4 processes): ~600-800 MB
- Redis: ~50-100 MB
- OS + buffers: ~300 MB
- **Total: ~1.5 GB. Fits in t2.small's 2 GB with ~500 MB headroom.**

---

## Step 4 — Use the t2.small .env

The default `.env.example` is tuned for 4+ vCPU. Copy the
t2.small-specific overrides instead:

```bash
cd /home/ubuntu/fueltracks
cp .env.t2small.example .env
nano .env   # change JWT_SECRET, CORS_ORIGIN, DB_PASS at minimum
```

Key differences from `.env.example`:

| Setting | Default | t2.small | Why |
|---|---|---|---|
| `PG_POOL_MAX` | 50 | **10** | Can't actually serve 50 with 2 GB RAM |
| `TCP_PORT_CAP_*` | 12000/10000/8000 | **400/300/300** | Realistic single-core ceiling |
| `TCP_HIGH_WATER` | 50 | **20** | Pause sooner (less buffer pressure) |
| `WRITER_BATCH_ROWS` | 1000 | **200** | Smaller batches → smaller RAM spikes |
| `STREAM_MAXLEN` | 1000000 | **200000** | Less Redis memory pressure |

---

## Step 5 — Initialize database

Same as DEPLOY.md step 4:

```bash
node scripts/dbInit.js
node scripts/runMigrations.js
```

---

## Step 6 — Start PM2 with the standard 4-process config

The default `ecosystem.config.js` works. The env vars in `.env`
override the defaults.

```bash
pm2 delete all 2>/dev/null || true
pm2 start ecosystem.config.js
pm2 save
pm2 startup | sudo bash
pm2 status
```

You'll see all 4 processes, but they'll be CPU-starved. That's
expected on t2.small.

---

## Step 7 — Verify health

Same as DEPLOY.md step 6.

---

## Step 8 — Stress test AT YOUR SCALE

DO NOT run the default 10K-device stress test on t2.small. Use:

```bash
# Phase 1 — quick smoke (100 devices, 5 minutes)
node scripts/stress-test.js \
  --devices 100 --packet-rate 0.5 --duration-sec 300

# Phase 2 — find your real ceiling (ramp to 1000, watch what breaks)
node scripts/stress-test.js \
  --devices 1000 --ramp-step 25 --ramp-interval-ms 500 \
  --packet-rate 0.033 --duration-sec 600
```

Watch the metrics. The first sign of trouble on t2.small:
- `fueltracks_tcp_active_sockets` plateaus below target (CPU bottleneck)
- `fueltracks_writer_buffer_size` grows unbounded (writer can't keep up)
- `top` shows `load average: 1.5, 0.8, 0.4` sustained (load > nproc = trouble)

When you see any of these, that's your ceiling. Stop the test,
record the device count, and that's your sustainable load.

---

## Step 9 — When to upgrade

You need to upgrade from t2.small when:
- You've onboarded 300+ real devices and want headroom
- The dashboard feels laggy (frontend requests taking >2s)
- PM2 keeps restarting processes (out-of-memory killer)

Recommended upgrade path (cheapest viable per device count):

| Target devices | Recommended instance | Monthly cost (us-east-1) |
|---|---|---|
| 300-1,000 | t3.medium (2 vCPU, 4 GB) | ~$30/mo |
| 1,000-3,000 | t3.large (2 vCPU, 8 GB) | ~$60/mo |
| 3,000-10,000 | t3.xlarge (4 vCPU, 16 GB) | ~$120/mo |
| 10,000-30,000 | t3.xlarge + RDS + ElastiCache | ~$400+/mo |

At each step, re-run `scripts/tune-postgres-t2small.sh` (or the
equivalent tuning script for the larger instance) with appropriate
values.

---

## What you cannot do on free tier

| Feature | Free-tier viable? |
|---|---|
| Run system + smoke test | ✅ Yes |
| Develop React Native mobile app against backend | ✅ Yes |
| Demo to investors / partners | ✅ Yes |
| Run 10K device stress test | ❌ No |
| Onboard 1000+ real devices | ❌ No |
| 24h soak at 10K | ❌ No |
| Production traffic | ❌ No |

The free tier is for **learning + development + demo**. Real
deployment needs the upgrade path above.

---

## Files specific to t2.small

- `.env.t2small.example` — env overrides
- `scripts/tune-postgres-t2small.sh` — Postgres tuning
- `DEPLOY_t2small.md` — this file
