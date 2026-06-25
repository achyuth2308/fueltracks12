// ============================================================
// LOCATION SUBSCRIBER (Stream-based)
// Reads from Redis Stream 'tracking:stream' via XREADGROUP.
// - Resolves IMEI → vehicleId + orgId via a Redis-cached hash
//   (updated on vehicle create/update; falls back to DB if cold).
// - Writes GPS points to `gps_points` (TimescaleDB hypertable).
// - Writes denormalized latest state to `vehicle_latest_state`.
// - Performs in-process alert checks (ignition, idle, geofence).
// - Emits real-time events over Socket.io.
//
// In Phase 4, DB writes move to a dedicated `fueltracks-writer`
// process. This file then becomes the Socket.io broadcast handler
// only.
// ============================================================

const { redis } = require('../config/redis');
const VehicleModel = require('../models/vehicleModel');
const GpsModel = require('../models/gpsModel');
const GeofenceModel = require('../models/geofenceModel');
const { runConsumerLoop } = require('../streams/redisStreams');
const { TRACKING_STREAM } = require('../../tcp-server/publisher');

// Each backend process gets a unique consumer name so multiple
// instances don't double-process (consumer groups handle that),
// but logs are distinguishable.
const CONSUMER_GROUP  = process.env.STREAM_GROUP || 'fueltracks_writer';
const CONSUMER_NAME   = process.env.HOSTNAME ||
                        process.env.CONSUMER_NAME ||
                        `consumer_${process.pid}`;

// ---- in-process caches (warm at startup, refresh periodically) ----
// IMEI → { id, org_id, name, plate }
const imeiCache = new Map();
// vehicleId → geofences[]
const geofenceCache = new Map();
const CACHE_TTL_MS = 5 * 60 * 1000;
const CACHE_TS = new Map(); // key → timestamp

let ioRef = null;
let consumerRunning = false;

// Haversine formula to compute distance in meters
function getHaversineDistance(lat1, lon1, lat2, lon2) {
  const R = 6371e3;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat/2) * Math.sin(dLat/2) +
            Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
            Math.sin(dLon/2) * Math.sin(dLon/2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
  return R * c;
}

function isPointInPolygon(lat, lng, polygon) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const xi = polygon[i].lat, yi = polygon[i].lng;
    const xj = polygon[j].lat, yj = polygon[j].lng;
    const intersect = ((yi > lng) !== (yj > lng))
        && (lat < (xj - xi) * (lng - yi) / (yj - yi) + xi);
    if (intersect) inside = !inside;
  }
  return inside;
}

/**
 * Look up vehicle by IMEI. Reads from in-process cache first,
 * falls back to DB on miss, and re-caches the result.
 */
async function resolveVehicle(imei) {
  const now = Date.now();
  const cached = imeiCache.get(imei);
  if (cached && (now - (CACHE_TS.get(imei) || 0)) < CACHE_TTL_MS) {
    return cached;
  }
  // Try Redis hash first (faster than DB and shared across processes).
  const fromRedis = await redis.hgetall(`vehicle:imei:${imei}`).catch(() => ({}));
  if (fromRedis && fromRedis.id && fromRedis.org_id) {
    const v = {
      id: fromRedis.id, org_id: fromRedis.org_id,
      name: fromRedis.name || null, plate: fromRedis.plate || null,
    };
    imeiCache.set(imei, v);
    CACHE_TS.set(imei, now);
    return v;
  }
  // Cold cache — hit DB once.
  const v = await VehicleModel.findByImei(imei);
  if (v) {
    const slim = { id: v.id, org_id: v.org_id, name: v.name, plate: v.plate };
    imeiCache.set(imei, slim);
    CACHE_TS.set(imei, now);
    // Warm the shared Redis hash too.
    await redis.hset(`vehicle:imei:${imei}`, slim).catch(() => {});
  }
  return v;
}

async function resolveGeofences(vehicleId) {
  const now = Date.now();
  const cached = geofenceCache.get(vehicleId);
  if (cached && (now - (CACHE_TS.get(`geo:${vehicleId}`) || 0)) < CACHE_TTL_MS) {
    return cached;
  }
  const list = await GeofenceModel.findGeofencesForVehicle(vehicleId);
  geofenceCache.set(vehicleId, list);
  CACHE_TS.set(`geo:${vehicleId}`, now);
  return list;
}

/**
 * Process one batch of stream entries.
 * Returns the IDs that were successfully processed so the consumer
 * loop can XACK them.
 */
async function processBatch(entries) {
  const acked = [];
  for (const entry of entries) {
    try {
      const data = JSON.parse(entry.fields.data);
      const { imei, lat, lng, speed, fuel, ignition, voltage, direction,
              odometer, satellites, gsmSignal, battery, deviceTime, isLive } = data;

      // 1. Resolve IMEI → vehicle. If unknown, drop the data but still ACK
      //    so we don't replay the same unknown-IMEI message forever.
      const vehicle = await resolveVehicle(imei);
      if (!vehicle) {
        // Persist a raw_packet row for forensics, then ACK.
        await GpsModel.saveRawPacket(imei, entry.fields.data, false, 'Unregistered IMEI');
        acked.push(entry.id);
        continue;
      }

      const vehicleId = vehicle.id;
      const orgId = vehicle.org_id;

      // 2. Fetch previous state for alert diffing.
      const prevStateRaw = await redis.get(`vehicle:state:${imei}`);
      let prevState = null;
      if (prevStateRaw) {
        try { prevState = JSON.parse(prevStateRaw); } catch(e) {}
      }

      // 3. Persist GPS point.
      await GpsModel.savePoint({
        vehicleId, lat, lng, speed, direction, odometer, fuel, ignition,
        satellites, gsmSignal, battery, voltage, isLive, deviceTime
      });

      // 4. Upsert denormalized latest state.
      await GpsModel.updateLatestState({
        vehicleId, lat, lng, speed, direction, fuel, ignition, voltage,
        odometer, satellites, gsmSignal
      });

      // 5. In-process alert checks (only on live packets).
      if (isLive) {
        const alertsToTrigger = [];

        if (ignition === true && (!prevState || prevState.ignition === false)) {
          alertsToTrigger.push({ type: 'ignition_on',
            text: 'Ignition ON Alert: Vehicle started.' });
        }
        if (ignition === true && speed > 0 &&
            (!prevState || prevState.speed === 0 || prevState.ignition === false)) {
          alertsToTrigger.push({ type: 'trip_started',
            text: 'Trip Started Alert: Vehicle has begun moving.' });
        }
        if (ignition === false && prevState && prevState.ignition === true) {
          alertsToTrigger.push({ type: 'stoppage',
            text: 'Vehicle Stoppage Alert: Vehicle has stopped and ignition turned OFF.' });
        }
        if (ignition === true && speed === 0) {
          const idleKey = `vehicle:idle_start:${vehicleId}`;
          const alertFiredKey = `vehicle:idle_alert_fired:${vehicleId}`;
          let idleStart = await redis.get(idleKey);
          if (!idleStart) {
            // 10-minute TTL prevents orphaned keys from accumulating.
            await redis.set(idleKey, Date.now(), 'EX', 600);
          } else {
            const idleDurationMs = Date.now() - parseInt(idleStart);
            if (idleDurationMs > 30000) {
              const alreadyFired = await redis.get(alertFiredKey);
              if (!alreadyFired) {
                alertsToTrigger.push({ type: 'excessive_idle',
                  text: 'Excessive Idle Alert: Vehicle is idling for more than 30 seconds.' });
                await redis.set(alertFiredKey, '1', 'EX', 300);
              }
            }
          }
        } else {
          await redis.del(`vehicle:idle_start:${vehicleId}`);
          await redis.del(`vehicle:idle_alert_fired:${vehicleId}`);
        }

        // Geofence checks
        try {
          const geofences = await resolveGeofences(vehicleId);
          for (const geofence of geofences) {
            let isInsideNow = false;
            if (geofence.type === 'circle') {
              const dist = getHaversineDistance(
                lat, lng,
                parseFloat(geofence.center_lat),
                parseFloat(geofence.center_lng)
              );
              isInsideNow = dist <= parseFloat(geofence.radius);
            } else if (geofence.type === 'polygon' &&
                       Array.isArray(geofence.coordinates)) {
              isInsideNow = isPointInPolygon(lat, lng, geofence.coordinates);
            }
            const geoStateKey = `vehicle:geofence:${geofence.id}:${vehicleId}`;
            const wasInsideRaw = await redis.get(geoStateKey);
            const wasInside = wasInsideRaw === 'inside';
            if (isInsideNow && !wasInside) {
              alertsToTrigger.push({
                type: 'geofence',
                text: `Geofence In Alert: Entered geofence "${geofence.name}".`
              });
              await redis.set(geoStateKey, 'inside', 'EX', 86400);
            } else if (!isInsideNow && wasInside) {
              alertsToTrigger.push({
                type: 'geofence',
                text: `Geofence Out Alert: Exited geofence "${geofence.name}".`
              });
              await redis.set(geoStateKey, 'outside', 'EX', 86400);
            }
          }
        } catch (geoErr) {
          console.error('[SUBSCRIBER] Geofence calculation error:', geoErr.message);
        }

        // Publish triggered alerts to the alerts stream.
        for (const triggered of alertsToTrigger) {
          const alertPayload = {
            imei,
            alertType: triggered.type,
            alertText: triggered.text,
            lat, lng,
            deviceTime: deviceTime || new Date().toISOString()
          };
          await redis.xadd('alerts:stream', 'MAXLEN', '~', 1000000, '*',
                           'data', JSON.stringify(alertPayload));
        }
      }

      // 6. Broadcast over Socket.io.
      if (isLive && ioRef) {
        const payload = {
          vehicleId, imei, name: vehicle.name, plate: vehicle.plate,
          lat, lng, speed, direction, fuel, ignition, voltage, odometer,
          satellites, gsmSignal, battery, deviceTime, isOnline: true
        };
        ioRef.to(`vehicle:${vehicleId}`).emit('location:update', payload);
        ioRef.to(`org:${orgId}`).emit('fleet:update', payload);
      }

      acked.push(entry.id);
    } catch (err) {
      console.error(`[SUBSCRIBER] Error processing entry ${entry.id}:`, err.message);
      // Do NOT ACK — entry stays in PEL and will be retried.
      // (In production you may want a max-retry counter; for now,
      // unacked entries get retried indefinitely which is safe.)
    }
  }
  return acked;
}

/**
 * Start the consumer loop.
 */
async function start(io) {
  ioRef = io;
  if (consumerRunning) return;
  consumerRunning = true;

  console.log(`[SUBSCRIBER] Starting location consumer (${CONSUMER_NAME})`);
  // runConsumerLoop blocks until shutdown — do not await.
  runConsumerLoop({
    stream: TRACKING_STREAM,
    group: CONSUMER_GROUP,
    consumer: CONSUMER_NAME,
    onBatch: processBatch,
  }).catch((err) => {
    console.error('[SUBSCRIBER] Consumer loop crashed:', err);
  });
}

/**
 * Public hooks for invalidating caches when vehicle data changes.
 * Call these from controllers on create/update/delete.
 */
function invalidateImei(imei) {
  imeiCache.delete(imei);
  CACHE_TS.delete(imei);
  redis.del(`vehicle:imei:${imei}`).catch(() => {});
}

function invalidateGeofences(vehicleId) {
  geofenceCache.delete(vehicleId);
  CACHE_TS.delete(`geo:${vehicleId}`);
}

async function stop() {
  // runConsumerLoop handles SIGINT/SIGTERM; we just flip the flag.
  consumerRunning = false;
}

module.exports = {
  start, stop,
  invalidateImei, invalidateGeofences,
  // Exposed for testing.
  resolveVehicle, resolveGeofences,
};
