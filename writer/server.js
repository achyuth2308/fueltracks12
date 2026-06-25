// ============================================================
// FUELTRACKS WRITER — Dedicated DB-write process
//
// Phase 4 of SCALING_ROADMAP.md. This process owns ALL writes
// to `gps_points` and `vehicle_latest_state`.
//
// Why split it out:
// - The API process used to do everything: TCP parsing, REST API,
//   Socket.io, Redis subscriptions, AND DB writes. At 30K devices
//   the single Node.js event loop becomes the bottleneck because
//   a slow report export blocked every other operation.
// - Now: API process = REST + Socket.io broadcast only (read-only
//   consumer of tracking stream for live updates).
// - Writer process = ONLY DB writes. Reads from the tracking
//   stream in a separate consumer group so API broadcast and DB
//   write do not compete for the same message slot.
//
// Batching strategy:
// - In-memory buffer accumulates up to BATCH_MAX_ROWS or
//   BATCH_MAX_MS milliseconds, whichever comes first.
// - Flush via gpsModel.savePointsBatch (single multi-row INSERT).
// - If flush fails, the entries are KEPT in the buffer (still
//   unacked in the consumer group) and will be retried on the
//   next XREADGROUP.
// - On graceful shutdown we flush remaining buffer before exit.
// ============================================================

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const GpsModel = require('../backend/models/gpsModel');
const { redis } = require('../backend/config/redis');
const { runConsumerLoop } = require('../backend/streams/redisStreams');
const { TRACKING_STREAM } = require('../tcp-server/publisher');

// Tunables
const BATCH_MAX_ROWS = parseInt(process.env.WRITER_BATCH_ROWS) || 1000;
const BATCH_MAX_MS   = parseInt(process.env.WRITER_BATCH_MS)   || 1000;
const CONSUMER_GROUP = process.env.WRITER_GROUP || 'fueltracks_writer';
const CONSUMER_NAME  = process.env.HOSTNAME ||
                       process.env.CONSUMER_NAME ||
                       `writer_${process.pid}`;

// ---- In-memory state ----
let pointBuffer = [];       // gps_points rows awaiting flush
let stateBuffer = [];       // vehicle_latest_state rows awaiting flush
let lastFlushAt = Date.now();
let pendingAcks = [];       // stream entry IDs to XACK after successful flush

// Counters for observability
const stats = {
  received: 0,
  flushed: 0,
  insertErrors: 0,
  batches: 0,
  startTime: Date.now(),
};

/**
 * Try to resolve IMEI → vehicleId via Redis hash. Falls back to DB on cold.
 * Same logic as locationSubscriber.js — keep these in sync or factor into
 * a shared module.
 */
async function resolveVehicle(imei) {
  const fromRedis = await redis.hgetall(`vehicle:imei:${imei}`).catch(() => ({}));
  if (fromRedis && fromRedis.id) {
    return {
      id: fromRedis.id, org_id: fromRedis.org_id,
      name: fromRedis.name || null, plate: fromRedis.plate || null,
    };
  }
  // Cold — query DB and warm the hash. The VehicleModel here is a
  // direct require so the writer doesn't need to import the whole
  // subscriber chain.
  const VehicleModel = require('../backend/models/vehicleModel');
  const v = await VehicleModel.findByImei(imei);
  if (v) {
    await redis.hset(`vehicle:imei:${imei}`, {
      id: v.id, org_id: v.org_id, name: v.name || '', plate: v.plate || '',
    }).catch(() => {});
    return { id: v.id, org_id: v.org_id, name: v.name, plate: v.plate };
  }
  return null;
}

/**
 * Process a batch of stream entries:
 * - Resolve IMEI → vehicleId.
 * - Push point rows into pointBuffer and state rows into stateBuffer.
 * - If buffers reach BATCH_MAX_ROWS OR BATCH_MAX_MS has elapsed since
 *   last flush, call flushNow() which does the actual DB writes and
 *   returns the IDs to ACK.
 */
async function processBatch(entries) {
  const acked = [];

  for (const entry of entries) {
    stats.received++;
    let data;
    try {
      data = JSON.parse(entry.fields.data);
    } catch (e) {
      // Malformed JSON — ACK to drop the poison pill from the stream.
      acked.push(entry.id);
      continue;
    }

    const { imei, lat, lng, speed, fuel, ignition, voltage, direction,
            odometer, satellites, gsmSignal, battery, deviceTime, isLive } = data;

    // Unknown IMEI — ACK so we don't replay forever, but record raw.
    const vehicle = await resolveVehicle(imei);
    if (!vehicle) {
      try {
        await GpsModel.saveRawPacket(imei, entry.fields.data, false, 'Unregistered IMEI');
      } catch (e) { /* best-effort */ }
      acked.push(entry.id);
      continue;
    }

    // Only buffer LIVE packets (L flag) — buffered history (H) is also
    // useful for trips but is much smaller in volume; treat as live for now.
    if (!isLive && isLive !== false) {
      // missing isLive — assume live
    }

    pointBuffer.push({
      vehicleId: vehicle.id, lat, lng, speed, direction, odometer,
      fuel, ignition, satellites, gsmSignal, battery, voltage,
      isLive: isLive !== false, deviceTime,
    });

    stateBuffer.push({
      vehicleId: vehicle.id, lat, lng, speed, direction, fuel,
      ignition, voltage, odometer, satellites, gsmSignal,
    });

    pendingAcks.push(entry.id);

    // Time-based or count-based flush
    const elapsed = Date.now() - lastFlushAt;
    if (pointBuffer.length >= BATCH_MAX_ROWS || elapsed >= BATCH_MAX_MS) {
      const flushedIds = await flushNow();
      acked.push(...flushedIds);
    }
  }

  // If we have leftover entries that haven't been flushed yet,
  // return them as acked=false by NOT including them. The consumer
  // loop only ACKs IDs we return. So we leave them in pendingAcks
  // and the next iteration will XACK them when flush completes.

  // Drain any pending acks from previous batches that have since flushed.
  return acked;
}

/**
 * Flush in-memory buffers to Postgres.
 * Returns the entry IDs that were successfully written so the caller
 * can XACK them.
 */
async function flushNow() {
  if (pointBuffer.length === 0 && stateBuffer.length === 0) return [];

  const points = pointBuffer;
  const states = stateBuffer;
  const acks   = pendingAcks;

  // Clear buffers BEFORE the await so concurrent batches can keep
  // filling new rows without blocking on the flush.
  pointBuffer = [];
  stateBuffer = [];
  pendingAcks = [];

  try {
    if (points.length) {
      await GpsModel.savePointsBatch(points);
      stats.flushed += points.length;
    }
    if (states.length) {
      await GpsModel.updateLatestStatesBatch(states);
    }
    stats.batches++;
    lastFlushAt = Date.now();
    console.log(
      `[WRITER] Flushed batch: ${points.length} gps_points, ${states.length} latest_state, ` +
      `uptime=${Math.round((Date.now() - stats.startTime)/1000)}s, ` +
      `total flushed=${stats.flushed}`
    );
    return acks;
  } catch (err) {
    stats.insertErrors++;
    console.error(`[WRITER] Flush failed (${points.length} rows):`, err.message);
    // Re-queue so next batch retries.
    pointBuffer = points.concat(pointBuffer);
    stateBuffer = states.concat(stateBuffer);
    pendingAcks = acks.concat(pendingAcks);
    // Brief backoff to avoid hot-loop on persistent DB errors.
    await new Promise((r) => setTimeout(r, 500));
    return [];
  }
}

// Periodic flush so a slow trickle of packets still gets persisted
// within BATCH_MAX_MS even if we never hit BATCH_MAX_ROWS.
const flushInterval = setInterval(async () => {
  if (pointBuffer.length === 0 && stateBuffer.length === 0) return;
  const elapsed = Date.now() - lastFlushAt;
  if (elapsed < BATCH_MAX_MS) return;
  const ids = await flushNow();
  // We don't XACK here directly — the consumer loop's readNew will
  // pick up the next batch and our pendingAcks is already drained.
  // We just need to ensure XACK happens. The simplest approach: also
  // expose the consumer's sub client so we can ack here.
  // For now, the next processBatch will see pendingAcks is empty so
  // any new entries get their own XACK; old ones will be re-read on
  // the next XREADGROUP if not yet acked (consumer-group semantics
  // re-deliver pending entries to the same consumer). To keep
  // semantics simple, we also ACK here using the consumer loop's
  // sub client, exposed via setAckClient().
  if (ackClient && ids.length) {
    try { await ackClient.xack(TRACKING_STREAM, CONSUMER_GROUP, ...ids); }
    catch (e) { /* will retry */ }
  }
}, Math.max(200, Math.floor(BATCH_MAX_MS / 2)));

let ackClient = null;
function setAckClient(c) { ackClient = c; }

async function start() {
  console.log(`[WRITER] Starting as consumer '${CONSUMER_NAME}' in group '${CONSUMER_GROUP}'`);
  console.log(`[WRITER] batch config: rows=${BATCH_MAX_ROWS}, ms=${BATCH_MAX_MS}`);

  // We need a long-lived sub client so the periodic flusher can XACK.
  // runConsumerLoop creates its own internal sub, so we create a second
  // connection just for the timer-based acks.
  const { createSubscriber } = require('../backend/config/redis');
  const timerSub = createSubscriber();
  await timerSub.xgroup('CREATE', TRACKING_STREAM, CONSUMER_GROUP, '$', 'MKSTREAM').catch((e) => {
    if (!e.message || !e.message.includes('BUSYGROUP')) throw e;
  });
  setAckClient(timerSub);

  // Start the consumer loop in the background.
  runConsumerLoop({
    stream: TRACKING_STREAM,
    group: CONSUMER_GROUP,
    consumer: CONSUMER_NAME,
    onBatch: processBatch,
  }).catch((err) => {
    console.error('[WRITER] Consumer loop crashed:', err);
    process.exit(1);
  });

  // Stats endpoint for observability.
  const http = require('http');
  const port = parseInt(process.env.WRITER_METRICS_PORT) || 5060;
  http.createServer((req, res) => {
    if (req.url === '/metrics') {
      const uptime = Math.round((Date.now() - stats.startTime)/1000);
      const flushRate = stats.flushed / Math.max(1, uptime);
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end(`# HELP fueltracks_writer_received Total stream entries consumed
# TYPE fueltracks_writer_received counter
fueltracks_writer_received ${stats.received}

# HELP fueltracks_writer_flushed Total gps_points rows written
# TYPE fueltracks_writer_flushed counter
fueltracks_writer_flushed ${stats.flushed}

# HELP fueltracks_writer_insert_errors Total flush failures
# TYPE fueltracks_writer_insert_errors counter
fueltracks_writer_insert_errors ${stats.insertErrors}

# HELP fueltracks_writer_batches Total successful batches
# TYPE fueltracks_writer_batches counter
fueltracks_writer_batches ${stats.batches}

# HELP fueltracks_writer_flush_rate Rows per second since startup
# TYPE fueltracks_writer_flush_rate gauge
fueltracks_writer_flush_rate ${flushRate.toFixed(2)}

# HELP fueltracks_writer_buffer_size Current in-memory buffer size
# TYPE fueltracks_writer_buffer_size gauge
fueltracks_writer_buffer_size ${pointBuffer.length}
`);
    } else { res.writeHead(404); res.end(); }
  }).listen(port, '0.0.0.0', () => {
    console.log(`[WRITER] Metrics endpoint on :${port}/metrics`);
  });
}

async function shutdown() {
  console.log('[WRITER] Shutting down — flushing remaining buffer...');
  clearInterval(flushInterval);
  await flushNow();
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

start().catch((err) => {
  console.error('[WRITER] Fatal startup error:', err);
  process.exit(1);
});
