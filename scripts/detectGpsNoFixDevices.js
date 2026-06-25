// ============================================================
// GPS-NO-FIX DETECTION
// Phase 7.3 of SCALING_ROADMAP.md
//
// Finds vehicles that have been CONNECTED to the TCP server
// (have entries in vehicle_latest_state with is_online = TRUE
// and recent last_seen) but have NOT produced any gps_points
// rows in the last N hours.
//
// At 10K+ real devices in the field, this catches:
//   - Devices with bad GPS antenna placement (especially EVs
//     with metal battery shielding as noted in the field test)
//   - Devices stuck on "GPS not fixed" indefinitely
//   - Devices that lost GPS module but kept cellular connection
//
// Run on a cron (every 6h) and emit alerts.
// ============================================================

const path = require('path');
const { Pool } = require('pg');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const pool = new Pool({
  host: process.env.DB_HOST,
  port: parseInt(process.env.DB_PORT) || 5432,
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASS,
});

const NO_FIX_HOURS = parseInt(process.env.NO_FIX_HOURS) || 1;

async function detectGpsNoFixDevices() {
  let client;
  try {
    client = await pool.connect();

    // A vehicle is "connected but never produced GPS" when:
    //   - vehicle_latest_state.is_online = TRUE
    //   - last_seen within the last 1 hour
    //   - no gps_points row for that vehicle in the last NO_FIX_HOURS hours
    //
    // On TimescaleDB the gps_points filter is chunk-pruned so this
    // scans only the recent chunk(s), not the full history.
    const result = await client.query(`
      SELECT
        v.id           AS vehicle_id,
        v.imei,
        v.name,
        v.plate,
        o.name         AS org_name,
        vls.last_seen,
        vls.is_online,
        EXTRACT(EPOCH FROM (NOW() - vls.last_seen))::int AS seconds_since_seen
      FROM vehicles v
      JOIN organizations o ON v.org_id = o.id
      JOIN vehicle_latest_state vls ON v.id = vls.vehicle_id
      WHERE v.is_active = TRUE
        AND vls.is_online = TRUE
        AND vls.last_seen > NOW() - INTERVAL '1 hour'
        AND NOT EXISTS (
          SELECT 1 FROM gps_points gp
          WHERE gp.vehicle_id = v.id
            AND gp.device_time > NOW() - ($1 || ' hours')::interval
        )
      ORDER BY seconds_since_seen ASC
    `, [String(NO_FIX_HOURS)]);

    console.log(`[GPS-NO-FIX] Found ${result.rows.length} devices connected but with no GPS rows in last ${NO_FIX_HOURS}h`);
    for (const row of result.rows) {
      console.log(
        `  IMEI=${row.imei} name=${row.name} plate=${row.plate} org=${row.org_name} ` +
        `last_seen=${row.last_seen.toISOString()} (${row.seconds_since_seen}s ago)`
      );
    }

    // Also surface the inverse: devices that have NEVER sent a single
    // GPS row in their entire history. Even worse — completely silent.
    const neverResult = await client.query(`
      SELECT v.id, v.imei, v.name, v.plate, v.created_at
      FROM vehicles v
      JOIN vehicle_latest_state vls ON v.id = vls.vehicle_id
      WHERE v.is_active = TRUE
        AND vls.last_seen IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM gps_points gp WHERE gp.vehicle_id = v.id)
      ORDER BY v.created_at DESC
    `);
    console.log(`[GPS-NO-FIX-NEVER] ${neverResult.rows.length} devices have NEVER produced a GPS row`);
    for (const row of neverResult.rows) {
      console.log(
        `  IMEI=${row.imei} name=${row.name} plate=${row.plate} created=${row.created_at.toISOString()}`
      );
    }

    return {
      connected_no_recent_gps: result.rows,
      never_sent_gps: neverResult.rows,
    };
  } catch (err) {
    console.error('[GPS-NO-FIX] Query failed:', err.message);
    throw err;
  } finally {
    if (client) client.release();
    await pool.end();
  }
}

if (require.main === module) {
  detectGpsNoFixDevices().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = { detectGpsNoFixDevices };
