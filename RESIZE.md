# RESIZE.md — Vertical Resize Without Re-Deploying

How to scale up (or down) your FuelTracks EC2 instance **without
losing data, code, or env vars**. Same codebase, bigger (or
smaller) box.

This is the cheapest, fastest way to scale. You're already paying
for one EC2; bumping its instance type costs a few extra dollars
per month and unlocks a higher device ceiling immediately.

---

## TL;DR

```bash
# 1. In AWS console (or CLI), stop the EC2, change instance type,
#    then start it. 1-2 minutes downtime.
# 2. SSH back in, run:
sudo bash scripts/resize-ec2.sh
# 3. Smoke test + stress test at the new ceiling.
```

---

## Why vertical resize works for FuelTracks

The codebase is **tier-agnostic**. Every scaling knob is an env
var:

| Hardware knob | Env var | Default | t2.small override | t3.large | t3.xlarge |
|---|---|---|---|---|---|
| Postgres pool | `PG_POOL_MAX` | 50 | 10 | 30 | 50 |
| BSTPL socket cap | `TCP_PORT_CAP_BSTPL` | 12000 | 400 | 2500 | 12000 |
| AIS140 socket cap | `TCP_PORT_CAP_AIS140` | 10000 | 300 | 2000 | 10000 |
| Concox socket cap | `TCP_PORT_CAP_CONCOX` | 8000 | 300 | 1500 | 8000 |
| Backpressure high | `TCP_HIGH_WATER` | 50 | 20 | 40 | 50 |
| Writer batch rows | `WRITER_BATCH_ROWS` | 1000 | 200 | 500 | 1000 |
| Stream MAXLEN | `STREAM_MAXLEN` | 1000000 | 200000 | 500000 | 1000000 |
| Postgres shared_buffers | (system-level) | 2GB | 256MB | 1GB | 2GB |
| Postgres max_connections | (system-level) | 200 | 50 | 120 | 200 |

When you resize hardware, you bump these numbers. Same code,
higher ceiling.

---

## AWS console procedure (the actual resize step)

This is the only manual part. Two cases:

### Case A: Same instance family (live resize, no stop)

For `t2.small → t2.medium → t2.large` or `t3.small → t3.medium`
within the same family, you can resize without stopping:

1. AWS console → EC2 → select instance
2. Actions → Instance settings → Change instance type
3. Pick the new type → Apply
4. ~30 seconds, no downtime

### Case B: Cross-family resize (1-2 min downtime)

For `t2.small → t3.large` or any cross-family change:

1. AWS console → EC2 → select instance
2. Instance state → Stop instance (wait until stopped)
3. Actions → Instance settings → Change instance type
4. Pick the new type → Apply
5. Instance state → Start instance
6. Total downtime: 1-2 minutes

### Case C: Using AWS CLI (faster, scriptable)

```bash
# Stop
aws ec2 stop-instances --instance-ids i-xxxxxxxxxxxxxxxxx

# Wait until stopped
aws ec2 wait instance-stopped --instance-ids i-xxxxxxxxxxxxxxxxx

# Modify type
aws ec2 modify-instance-attribute \
  --instance-id i-xxxxxxxxxxxxxxxxx \
  --instance-type "{\"Value\": \"t3.large\"}"

# Start
aws ec2 start-instances --instance-ids i-xxxxxxxxxxxxxxxxx

# Wait
aws ec2 wait instance-status-ok --instance-ids i-xxxxxxxxxxxxxxxxx
```

---

## After resize: run the auto-retune script

```bash
sudo bash scripts/resize-ec2.sh
```

The script:

1. Detects current vCPU + RAM
2. Recommends tier-appropriate env values
3. Applies new Postgres tuning (shared_buffers, max_connections, work_mem)
4. Restarts Postgres
5. Backs up your current `.env`
6. Writes a new `.env` with the right caps/pools/batches for the new tier
7. Restarts PM2 with the new env
8. Verifies health endpoints
9. Runs the smoke test

Total runtime: ~30 seconds.

---

## What if I want to scale DOWN (save money overnight)?

Same script, same logic, but in reverse. The script auto-detects
hardware and applies the matching tier. So:

```bash
# Bump from t3.large -> t3.small overnight
# (after the AWS console resize)
sudo bash scripts/resize-ec2.sh
# -> automatically applies the small-tier .env values
```

Your code, data, and dashboard state all survive.

---

## Tier reference (the table inside the script)

| Tier | vCPU | RAM | Realistic devices | .env source |
|---|---|---|---|---|
| low | 1 | ≤2 GB | 300-500 | `.env.t2small.example` |
| medium | 2 | ≤4 GB | 1K-2K | `.env.example` (low end) |
| high | 2-4 | ≤16 GB | 3K-10K | `.env.example` (default) |
| veryhigh | 4+ | 16+ GB | 15K-30K | `.env.example` (with bumps) |

The script picks the right tier automatically based on `nproc`
and `free -m`.

---

## When you outgrow single EC2 (above 30K)

The vertical resize stops being effective around 30K devices because:

- One machine is a single point of failure
- 8 vCPU is the practical limit of PM2 fork mode on one box
- Postgres on one machine can't sustain 6k+ writes/sec

At that point you need:
- **Horizontal split**: 2+ EC2s behind an ALB for TCP and API
- **RDS Multi-AZ**: separate Postgres with read replicas
- **ElastiCache**: Redis Cluster for Streams scale
- **Socket.io adapter**: `@socket.io/redis-adapter` so multiple API instances share rooms

These are infrastructure changes, not code changes. The codebase
already supports them — you just need to deploy multiple instances.

---

## Common questions

**Q: Will my data survive the resize?**
A: Yes. EBS volumes are preserved across stop/start + type change.
Postgres data, .env files, code, logs — everything stays.

**Q: Will my running services survive?**
A: Same-family resize: yes, ~30s blip. Cross-family: 1-2 min
downtime while the instance restarts. PM2 will auto-restart
processes on boot (since `pm2 startup` was set up).

**Q: Do I need to re-deploy?**
A: No. The codebase is the same. You only need to:
1. Resize in AWS console
2. Run `sudo bash scripts/resize-ec2.sh`

**Q: Can I scale back down if I oversize?**
A: Yes, same procedure in reverse. Cost goes back down too.

**Q: How do I know what tier I need?**
A: Run the stress test at your target device count. If
`fueltracks_writer_buffer_size` grows unbounded or `top` shows
load > nproc, you need the next tier up.

**Q: What about the React Native mobile app?**
A: The mobile app talks to the backend REST API + Socket.io.
Resizing the backend has zero impact on the mobile app code —
just maybe faster response times.

---

## Files

- `scripts/resize-ec2.sh` — the auto-retune script
- `RESIZE.md` — this file
- `DEPLOY.md` — initial deployment reference
- `DEPLOY_t2small.md` — t2.small specific notes
- `SCALING_DEPLOY.md` — extended runbook with rollback
