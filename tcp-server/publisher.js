// ============================================================
// REDIS PUBLISHER (Streams-based — scales to 30K+ devices)
// Publishes parsed packets to Redis Streams with MAXLEN cap.
// Tracks latest state in Redis (vehicle:state:{imei}).
// Tracks online status (vehicle:online:{imei}) with TTL.
//
// Why Streams not Pub/Sub:
// - Pub/Sub has no buffering: any subscriber stall = permanent data loss
// - Streams support MAXLEN (~) so we cap memory growth
// - Streams support consumer groups so we can replay on restart and
//   have multiple writer processes share work without losing messages
// - Streams survive subscriber disconnect/reconnect without message loss
// ============================================================

const Redis = require('ioredis');

const REDIS_HOST = process.env.REDIS_HOST || 'localhost';
const REDIS_PORT = process.env.REDIS_PORT || 6379;

// Streams cap: ~1M messages per stream. At 1k pkt/sec that's ~17 min of
// backlog, more than enough to absorb a backend restart. Old entries
// are evicted approximately (the ~ makes MAXLEN an approximate cap
// which is faster and still bounded).
const STREAM_MAXLEN = parseInt(process.env.STREAM_MAXLEN) || 1000000;

// Stream keys. Splitting tracking and alerts keeps alert delivery
// from being starved by high-volume location packets.
const TRACKING_STREAM = 'tracking:stream';
const ALERTS_STREAM   = 'alerts:stream';
const RAW_STREAM      = 'raw:stream';

let publisher = null;

/**
 * Initialize Redis publisher connection.
 * Returns the underlying ioredis client so callers can also use it
 * for ad-hoc operations if needed.
 */
function init() {
  publisher = new Redis({
    host: REDIS_HOST,
    port: REDIS_PORT,
    // Keep retrying forever — connection blips during a deploy are
    // expected and Streams will buffer for us.
    retryStrategy: (times) => {
      const delay = Math.min(times * 100, 3000);
      console.log(`[REDIS] Reconnecting in ${delay}ms... (attempt ${times})`);
      return delay;
    },
    maxRetriesPerRequest: null,
  });

  publisher.on('connect', () => {
    console.log(`[REDIS] Publisher connected to ${REDIS_HOST}:${REDIS_PORT}`);
  });

  publisher.on('error', (err) => {
    console.error('[REDIS] Publisher error:', err.message);
  });

  return publisher;
}

/**
 * Publish a parsed normal packet ($10) to Redis Streams.
 * Pipeline so all three ops (XADD + SET state + SET online) cost
 * one round-trip instead of three.
 *
 * @param {object} parsed Parsed packet from BSTPL/AIS140/Concox
 */
async function publishLocation(parsed) {
  if (!publisher) throw new Error('Redis publisher not initialized');

  const { imei, lat, lng, speed, fuel, ignition, voltage, direction,
          odometer, satellites, gsmSignal, battery, deviceTime, isLive,
          rawPacket, packetType } = parsed;

  const payload = JSON.stringify({
    imei, lat, lng, speed, fuel, ignition, voltage, direction,
    odometer, satellites, gsmSignal, battery, deviceTime, isLive,
    rawHex: rawPacket, packetType,
    serverTime: new Date().toISOString(),
  });

  try {
    // 1. Append to tracking stream (consumed by fueltracks-writer +
    //    fueltracks-api for live Socket.io broadcast).
    // 2. Cache latest state for the dashboard "last known" view.
    // 3. Set online sentinel with jittered TTL (90s ± 10s) to
    //    avoid thundering-herd expiry after mass reconnect.
    const onlineTtl = 80 + Math.floor(Math.random() * 20);
    const pipeline = publisher.pipeline();
    pipeline.xadd(
      TRACKING_STREAM, 'MAXLEN', '~', STREAM_MAXLEN, '*',
      'data', payload
    );
    pipeline.set(`vehicle:state:${imei}`, payload, 'EX', 300);
    pipeline.set(`vehicle:online:${imei}`, '1', 'EX', onlineTtl);
    await pipeline.exec();
  } catch (err) {
    console.error(`[REDIS] Publish error for ${imei}:`, err.message);
  }
}

/**
 * Publish a parsed alert packet ($11, $EPB, Concox alarm) to Redis Streams.
 */
async function publishAlert(parsed) {
  if (!publisher) throw new Error('Redis publisher not initialized');

  const payload = JSON.stringify({
    imei: parsed.imei,
    alertType: parsed.alertType,
    alertText: parsed.alertText,
    lat: parsed.lat,
    lng: parsed.lng,
    deviceTime: parsed.deviceTime,
    rawHex: parsed.rawPacket,
    packetType: parsed.packetType,
    serverTime: new Date().toISOString(),
  });

  try {
    await publisher.xadd(
      ALERTS_STREAM, 'MAXLEN', '~', STREAM_MAXLEN, '*',
      'data', payload
    );
  } catch (err) {
    console.error(`[REDIS] Alert publish error for ${parsed.imei}:`, err.message);
  }
}

// Phase 2.5 of SCALING_ROADMAP.md — sample raw logs.
// At 30k devices × 1 pkt/sec this stream receives 30k XADDs/sec.
// The raw_packets subscriber writes every entry to Postgres,
// which would saturate the pool. Sample to 1 in N by default.
// Set RAW_LOG_SAMPLE_RATE=1 in env to disable sampling for
// short debugging windows.
const RAW_LOG_SAMPLE_RATE = parseInt(process.env.RAW_LOG_SAMPLE_RATE) || 100;

/**
 * Publish raw message to a dedicated raw stream.
 * Sampled at RAW_LOG_SAMPLE_RATE:1 (default 100:1) so 30k pps
 * becomes 300 pps to Postgres. Override with env var for debug.
 */
async function publishRawMessage(parsed) {
  if (!publisher) return;
  if (RAW_LOG_SAMPLE_RATE > 1 && Math.random() > 1 / RAW_LOG_SAMPLE_RATE) {
    return; // dropped by sampling
  }
  const payload = JSON.stringify({
    imei: parsed.imei,
    packetType: parsed.packetType,
    rawHex: parsed.rawPacket || parsed.rawString || null,
    deviceTime: parsed.deviceTime || null,
    odometer: parsed.odometer || null,
    parsedJson: parsed,
  });
  try {
    await publisher.xadd(
      RAW_STREAM, 'MAXLEN', '~', STREAM_MAXLEN, '*',
      'data', payload
    );
  } catch (err) {
    console.error('[REDIS] Raw log publish error:', err.message);
  }
}

/**
 * Close Redis connection.
 */
async function close() {
  if (publisher) {
    await publisher.quit();
    publisher = null;
  }
}

module.exports = {
  init, publishLocation, publishAlert, publishRawMessage, close,
  // Export stream names so subscribers can use the same constants.
  TRACKING_STREAM, ALERTS_STREAM, RAW_STREAM,
};
