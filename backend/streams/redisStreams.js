// ============================================================
// SHARED REDIS STREAMS SUBSCRIBER
// XREADGROUP-based consumer-group reader with auto-recovery.
// Used by locationSubscriber.js and alertSubscriber.js (and
// future fueltracks-writer process in Phase 4).
//
// Why consumer groups:
// - On restart, the consumer replays its "pending" entries (the
//   entries it had read but not yet XACKed) so we never lose data.
// - Multiple consumers in the same group share work without
//   duplicate processing (Redis tracks the per-consumer position).
// - If a consumer crashes mid-batch, its entries return to the
//   PEL (pending entries list) and another consumer picks them up.
// ============================================================

const { createSubscriber } = require('../config/redis');

// Tunables
const BATCH_SIZE       = parseInt(process.env.STREAM_BATCH_SIZE) || 200;
const BLOCK_MS         = parseInt(process.env.STREAM_BLOCK_MS)   || 1000;

/**
 * Create the consumer group for a given stream. Idempotent —
 * BUSYGROUP error from a pre-existing group is treated as success.
 *
 * @param {Redis} sub  ioredis client
 * @param {string} stream  stream name (e.g. 'tracking:stream')
 * @param {string} group   group name (e.g. 'fueltracks_writer')
 */
async function ensureGroup(sub, stream, group) {
  try {
    // $ = "only new entries from now"; use '0' to also consume
    // historical entries (we use '$' so a fresh group doesn't
    // replay the entire backlog on first start).
    await sub.xgroup('CREATE', stream, group, '$', 'MKSTREAM');
    console.log(`[STREAMS] Created consumer group '${group}' on ${stream}`);
  } catch (err) {
    if (err.message && err.message.includes('BUSYGROUP')) {
      // Group already exists — fine.
      return;
    }
    throw err;
  }
}

/**
 * Block-read a batch of new entries from a stream for a consumer group.
 *
 * @param {Redis} sub
 * @param {string} stream
 * @param {string} group
 * @param {string} consumer  consumer name (unique per process)
 * @returns {Array<{id, fields}>} entries; empty array if BLOCK timed out.
 */
async function readNew(sub, stream, group, consumer) {
  const result = await sub.xreadgroup(
    'GROUP', group, consumer,
    'COUNT', BATCH_SIZE,
    'BLOCK', BLOCK_MS,
    'STREAMS', stream, '>'
  );
  // Result shape: [[streamName, [[id, [k,v,k,v,...]]]]]
  if (!result) return [];
  const entry = result.find(([s]) => s === stream);
  if (!entry) return [];
  const [, rawEntries] = entry;
  return rawEntries.map(([id, kvs]) => ({
    id,
    fields: kvArrayToObject(kvs),
  }));
}

/**
 * Re-read pending entries for THIS consumer that were never XACKed.
 * Called on startup to recover from a crash.
 */
async function readPending(sub, stream, group, consumer) {
  const pending = await sub.xpending(stream, group, '0', '+', 1000, consumer);
  if (!pending || !pending.length) return [];
  const ids = pending.map((p) => p[0]);
  if (!ids.length) return [];
  const result = await sub.xrange(stream, ids[0], ids[ids.length - 1]);
  const idSet = new Set(ids);
  return (result || [])
    .filter(([id]) => idSet.has(id))
    .map(([id, kvs]) => ({ id, fields: kvArrayToObject(kvs) }));
}

/**
 * XACK a batch of entries.
 */
async function ack(sub, stream, group, ids) {
  if (!ids || !ids.length) return 0;
  return sub.xack(stream, group, ...ids);
}

/**
 * Run a long-lived consumer loop.
 *
 * Lifecycle per iteration:
 *   1. Read pending entries from PEL (recovery on restart/crash)
 *   2. Read new entries via blocking XREADGROUP
 *   3. Hand each entry to `onBatch`
 *   4. XACK successful entries
 *
 * `onBatch(entries)` should return an array of entry IDs that were
 * processed successfully. Entries NOT in that array stay pending and
 * will be retried on next iteration / next consumer.
 */
async function runConsumerLoop({ stream, group, consumer, onBatch, onShutdown }) {
  const sub = createSubscriber();

  sub.on('error', (err) => {
    console.error(`[STREAMS] Subscriber error on ${stream}:`, err.message);
  });

  await ensureGroup(sub, stream, group);

  // Drain pending entries first (recovery from a crash).
  try {
    const pending = await readPending(sub, stream, group, consumer);
    if (pending.length) {
      console.log(`[STREAMS] Recovering ${pending.length} pending entries from ${stream}`);
      const acked = await onBatch(pending);
      if (acked.length) await ack(sub, stream, group, acked);
    }
  } catch (err) {
    console.error(`[STREAMS] Recovery failed on ${stream}:`, err.message);
  }

  let stopped = false;
  const stop = async () => {
    stopped = true;
    try { await sub.quit(); } catch (e) {}
    if (onShutdown) onShutdown();
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);

  while (!stopped) {
    try {
      const entries = await readNew(sub, stream, group, consumer);
      if (entries.length) {
        const acked = await onBatch(entries);
        if (acked.length) await ack(sub, stream, group, acked);
      }
    } catch (err) {
      console.error(`[STREAMS] Read loop error on ${stream}:`, err.message);
      await new Promise((r) => setTimeout(r, 500));
    }
  }
}

function kvArrayToObject(arr) {
  const out = {};
  for (let i = 0; i < arr.length; i += 2) {
    out[arr[i]] = arr[i + 1];
  }
  return out;
}

module.exports = {
  ensureGroup,
  readNew,
  readPending,
  ack,
  runConsumerLoop,
};
