// ============================================================
// ALERT SUBSCRIBER (Stream-based)
// Reads from Redis Stream 'alerts:stream' via XREADGROUP.
// - Resolves IMEI → vehicle via the shared cache.
// - Persists alert to `alerts` table.
// - Dispatches external notifications (email / whatsapp) per org profile.
// - Broadcasts over Socket.io.
// ============================================================

const { redis } = require('../config/redis');
const VehicleModel = require('../models/vehicleModel');
const GpsModel = require('../models/gpsModel');
const profileRepository = require('../modules/profile/repositories/profileRepository');
const NotificationService = require('../services/notificationService');
const { runConsumerLoop } = require('../streams/redisStreams');
const { ALERTS_STREAM } = require('../../tcp-server/publisher');

const CONSUMER_GROUP = process.env.ALERT_STREAM_GROUP || 'fueltracks_alert_writer';
const CONSUMER_NAME  = process.env.HOSTNAME ||
                       process.env.CONSUMER_NAME ||
                       `alert_consumer_${process.pid}`;

let ioRef = null;
let consumerRunning = false;

async function resolveVehicle(imei) {
  // Use the shared hash populated by locationSubscriber on cold lookups.
  const fromRedis = await redis.hgetall(`vehicle:imei:${imei}`).catch(() => ({}));
  if (fromRedis && fromRedis.id && fromRedis.org_id) {
    return {
      id: fromRedis.id, org_id: fromRedis.org_id,
      name: fromRedis.name || null, plate: fromRedis.plate || null,
      imei,
    };
  }
  // Fallback: DB lookup and warm the hash.
  const v = await VehicleModel.findByImei(imei);
  if (v) {
    await redis.hset(`vehicle:imei:${imei}`, {
      id: v.id, org_id: v.org_id, name: v.name || '', plate: v.plate || '',
    }).catch(() => {});
    return v;
  }
  return null;
}

async function processBatch(entries) {
  const acked = [];
  for (const entry of entries) {
    try {
      const data = JSON.parse(entry.fields.data);
      const { imei, alertType, alertText, lat, lng, deviceTime } = data;

      const vehicle = await resolveVehicle(imei);
      if (!vehicle) {
        console.warn(`[SUBSCRIBER] Alert for unregistered IMEI: ${imei}`);
        acked.push(entry.id); // ACK to avoid replay storm for unknown IMEIs
        continue;
      }
      const vehicleId = vehicle.id;
      const orgId = vehicle.org_id;

      const alert = await GpsModel.saveAlert({
        vehicleId, alertType, alertText, lat, lng, deviceTime
      });

      // External notification dispatch (best-effort, do not block ACK on failure)
      try {
        const profile = await profileRepository.getProfile(orgId);
        if (profile) {
          await NotificationService.dispatchAlert(profile, alertType, alertText, {
            name: vehicle.name, plate: vehicle.plate, imei: vehicle.imei
          });
        }
      } catch (notifyErr) {
        console.error('[SUBSCRIBER] Notification dispatch error:', notifyErr.message);
      }

      // Broadcast over Socket.io
      if (ioRef) {
        const payload = {
          id: alert.id,
          vehicleId, imei,
          vehicleName: vehicle.name, plate: vehicle.plate,
          alertType, alertText, lat, lng,
          deviceTime, serverTime: alert.server_time
        };
        ioRef.to(`vehicle:${vehicleId}`).emit('alert:new', payload);
        ioRef.to(`org:${orgId}`).emit('alert:new', payload);
      }

      acked.push(entry.id);
    } catch (err) {
      console.error(`[SUBSCRIBER] Error processing alert entry ${entry.id}:`, err.message);
      // Do not ACK — retry next loop.
    }
  }
  return acked;
}

async function start(io) {
  ioRef = io;
  if (consumerRunning) return;
  consumerRunning = true;
  console.log(`[SUBSCRIBER] Starting alert consumer (${CONSUMER_NAME})`);
  runConsumerLoop({
    stream: ALERTS_STREAM,
    group: CONSUMER_GROUP,
    consumer: CONSUMER_NAME,
    onBatch: processBatch,
  }).catch((err) => console.error('[SUBSCRIBER] Alert consumer crashed:', err));
}

async function stop() {
  consumerRunning = false;
}

module.exports = { start, stop };
