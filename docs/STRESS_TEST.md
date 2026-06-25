# Stress Test Runbook

How to validate the FuelTracks scaling changes under load BEFORE
onboarding real fleet devices. Run this on a dedicated staging EC2
(NOT on the production box).

## Pre-flight

Before running any stress test:

1. ✅ Deployed to the staging EC2 via DEPLOY.md
2. ✅ All 4 PM2 processes online: `pm2 status`
3. ✅ Smoke test passes: `node scripts/smoke-test.js`
4. ✅ `/health` returns OK on tcp:5050 and api:3001
5. ✅ `/metrics` returns Prometheus output

If any of those fail, fix the deploy first.

## Phase 0 — Single-device soak (24 hours, do this FIRST)

This catches memory leaks, log file growth, and TimescaleDB chunk
boundary issues that only show up over time.

```bash
# One device per protocol, send 1 packet every 15 seconds, run for 24h.
node scripts/stress-test.js \
  --devices 3 \
  --ramp-step 3 --ramp-interval-ms 100 \
  --packet-rate 0.067 \
  --duration-sec 86400 \
  --protocols all \
  > /var/log/fueltracks/soak.log 2>&1
```

Watch for:
- Memory growth in PM2: `pm2 monit` — heap should be flat after 1h
- Log file size: `du -sh /var/log/fueltracks/` — should grow linearly and slowly
- TimescaleDB chunk creation: first chunk creates at the next 7-day boundary

If memory grows linearly, stop and find the leak. If it stays flat
within ±10%, you're safe to proceed.

## Phase 1 — Quick smoke (5 minutes, ~100 devices)

Validates the stress test harness itself works against your actual
server.

```bash
node scripts/stress-test.js \
  --devices 100 \
  --ramp-step 10 --ramp-interval-ms 500 \
  --packet-rate 0.5 \
  --duration-sec 300
```

Expected output (in another terminal):
```bash
pm2 logs fueltracks-tcp --lines 30
pm2 logs fueltracks-writer --lines 30
```

You should see `Stats: received=N, parsed=N` growing on the TCP
server and `Flushed batch: ...` on the writer.

## Phase 2 — 1,000 device ramp (15 minutes)

Validates the system under moderate load. This is the first real
test that exercises the scaling changes meaningfully.

```bash
node scripts/stress-test.js \
  --devices 1000 \
  --ramp-step 50 --ramp-interval-ms 200 \
  --packet-rate 0.033 \
  --duration-sec 900
```

While running, capture server-side metrics:

```bash
# TCP server metrics (open in another terminal, refresh every 5s)
watch -n 5 'curl -s http://localhost:5050/metrics | grep -E "fueltracks_tcp_packets|active_sockets|backpressure"'

# API metrics
watch -n 5 'curl -s http://localhost:3001/metrics | grep -E "fueltracks_api_http"'

# Writer metrics
watch -n 5 'curl -s http://localhost:5060/metrics | grep -E "fueltracks_writer"'

# Postgres activity
watch -n 5 "sudo -u postgres psql -d fueltracks -c 'SELECT state, count(*) FROM pg_stat_activity GROUP BY state;'"
```

**Healthy:**
- TCP: received counter grows ~33/sec, invalid <1%, active_sockets = 1000
- Writer: flush_rate matches packet rate, insert_errors = 0
- API: p95 request duration <500ms
- Postgres: connections < 50, no long-running queries

**Unhealthy (investigate):**
- TCP: invalid >5% → parser bug
- TCP: backpressure_pauses > 0 → writer or DB too slow
- Writer: insert_errors growing → DB issues
- Writer: buffer_size growing unbounded → flush rate below input rate
- API: p95 > 2s → report query or slow endpoint
- Postgres: connections saturating pool → raise pool max

## Phase 3 — 5,000 device ramp (30 minutes)

Where the writer process split + backpressure + IMEI cache
become load-bearing.

```bash
node scripts/stress-test.js \
  --devices 5000 \
  --ramp-step 100 --ramp-interval-ms 200 \
  --packet-rate 0.033 \
  --duration-sec 1800
```

Same monitoring as Phase 2. Watch specifically for:
- `fueltracks_tcp_backpressure_pauses_total` — should stay near 0
  (some pauses are OK; sustained growth means trouble)
- `fueltracks_writer_buffer_size` — should stay <5000 (it's 1000
  batch + headroom)
- CPU on the EC2: `top` — should see 4 cores busy but not pegged
- RAM: `free -h` — heap should stay under 4 GB total across all PM2

## Phase 4 — 10,000 device ramp (60 minutes)

Full target scale. The full audit's worst-case load.

```bash
node scripts/stress-test.js \
  --devices 10000 \
  --ramp-step 200 --ramp-interval-ms 250 \
  --packet-rate 0.033 \
  --duration-sec 3600
```

Expected total packet rate: 10,000 × 1/30 = ~330 packets/sec.

Monitoring: same as Phase 3. Plus:
- `fueltracks_tcp_active_sockets` should be 10000 (across 3 ports)
- Per-port caps (12000/10000/8000) should NOT be hit
- `fueltracks_tcp_rejected_by_cap_total` should be 0

**If rejected_by_cap > 0:** raise `TCP_PORT_CAP_*` env vars in
`ecosystem.config.js`.

## Phase 5 — Burst test (10 minutes)

Simulates a fleet-wide reconnect storm (e.g., after a regional
cellular outage). All devices reconnect within seconds of each
other.

```bash
# Run with all 10K devices and a high packet rate (1 per 5s = 2000 pps).
node scripts/stress-test.js \
  --devices 10000 \
  --ramp-step 10000 --ramp-interval-ms 100 \
  --packet-rate 0.2 \
  --duration-sec 600
```

The `--ramp-step 10000 --ramp-interval-ms 100` makes all devices
come up within 100ms — the worst-case storm.

Watch specifically:
- SYN backlog: `netstat -s | grep -E "SYNs to LISTEN|listen queue"`
- TCP accept errors: `netstat -s | grep -i "listen"`
- TCP server `active_sockets` should reach 10000
- No devices stuck in "connecting" state
- Reconnect events stay near 0 (everyone connects first time)

## Phase 6 — Soak at 10K (24 hours)

Once burst passes, run sustained 24h at 10K to catch long-tail
issues.

```bash
node scripts/stress-test.js \
  --devices 10000 \
  --ramp-step 200 --ramp-interval-ms 250 \
  --packet-rate 0.033 \
  --duration-sec 86400
```

This is the real test. 24h of steady-state load will reveal:
- Memory leaks (heap should stay flat within ±15%)
- Disk fill rate (TimescaleDB retention should keep it bounded)
- Connection pool exhaustion patterns over the day
- TimescaleDB chunk compression behavior at boundaries

## CLI flags reference

```
--devices N              Total device count to ramp to (default: 10000)
--ramp-step N            Devices added per tick (default: 50)
--ramp-interval-ms N     Tick interval in ms (default: 200)
--packet-rate N          Packets per second per device (default: 0.033)
--duration-sec N         Test duration, 0=unlimited (default: 0)
--protocols all|bstpl|ais140|concox  Filter (default: all)
--split 0.5,0.3,0.2      Protocol distribution (default: 50/30/20)
--host HOSTNAME          Target TCP server (default: 127.0.0.1)
```

## Reading the output

The stress test reports every 5 seconds:

```
[STRESS]   BSTPL   active=5000  pps=165  sent=50000  failed=0  reconnects=12
[STRESS]   TOTAL active=10000 pps=330
```

- `active` = currently connected sockets
- `pps` = packets sent in the last 5 seconds
- `sent` = total packets sent since start
- `failed` = `socket.write()` returned false (buffer full)
- `reconnects` = how many times a device dropped + reconnected

Plus percentile latency of the local `socket.write()` call:

```
[STRESS]   local send latency p50=0ms p95=1ms p99=3ms
```

If p99 > 50ms, you're bottlenecked on outbound socket buffer (kernel
side). If it's 0ms across the board, that's healthy.

## When to stop the test and investigate

Stop and investigate if ANY of these hold for >2 minutes:

1. `active` < 90% of expected — devices can't connect
2. `pps` < 80% of expected — packets not flowing
3. `failed` > 0.5% of `sent` — local socket buffer full
4. `reconnects` increasing by >5/sec sustained — server dropping
5. Server-side: `fueltracks_writer_insert_errors` > 0
6. Server-side: `fueltracks_tcp_backpressure_pauses_total` growing
7. Server `top` shows load average > nproc
8. Server `free -h` shows <500 MB available

## After the test

```bash
# Capture final server state
curl -s http://localhost:5050/health > /tmp/stress-final-tcp.json
curl -s http://localhost:5050/metrics > /tmp/stress-final-tcp.txt
curl -s http://localhost:3001/metrics > /tmp/stress-final-api.txt
curl -s http://localhost:5060/metrics > /tmp/stress-final-writer.txt

# Verify data landed in TimescaleDB
sudo -u postgres psql -d fueltracks -c "
SELECT COUNT(*) AS total_rows,
       COUNT(*) FILTER (WHERE device_time > NOW() - INTERVAL '1 hour') AS last_hour
FROM gps_points;
"

# Check chunk creation
sudo -u postgres psql -d fueltracks -c "
SELECT chunk_name, range_start, range_end
FROM timescaledb_information.chunks
WHERE hypertable_name = 'gps_points'
ORDER BY range_start DESC LIMIT 5;
"
```

A healthy 1h soak at 10K devices should produce ~1,200,000 rows
in gps_points (10K devices × 120 packets/h/device). If the actual
count is <80% of that, packets were lost somewhere — investigate.

## Cleanup after stress test

```bash
# Optional: wipe the test data so it doesn't pollute real usage
sudo -u postgres psql -d fueltracks -c "
DELETE FROM gps_points WHERE device_time > NOW() - INTERVAL '24 hours';
DELETE FROM raw_packets WHERE received_at > NOW() - INTERVAL '24 hours';
"
# (Caution: this is destructive. Don't run on production.)
```
