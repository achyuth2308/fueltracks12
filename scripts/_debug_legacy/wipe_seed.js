// ============================================================
// LEGACY WIPE SCRIPT — DEV ONLY
// Moved from repo root during the scaling audit cleanup.
//
// DESTRUCTIVE: deletes every organization except the super-admin
// org, which cascades to wipe all users, vehicles, devices,
// groups, alerts, audit logs, gps_points, raw_packets.
//
// REFUSES TO RUN if NODE_ENV is 'production'. You can bypass with
// ALLOW_LEGACY_WIPE=1 (you should not need to).
// ============================================================

const path = require('path');
const { Pool } = require('pg');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });

if (process.env.NODE_ENV === 'production' && process.env.ALLOW_LEGACY_WIPE !== '1') {
  console.error('REFUSING TO RUN: NODE_ENV=production. Set ALLOW_LEGACY_WIPE=1 to override (you should not).');
  process.exit(1);
}

const pool = new Pool({
  host: process.env.DB_HOST,
  port: parseInt(process.env.DB_PORT) || 5432,
  database: process.env.DB_NAME,
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASS || 'postgres',
});

async function run() {
  try {
    console.log('Deleting all organizations except the super admin organization...');
    const res = await pool.query("DELETE FROM organizations WHERE id != 'a0000000-0000-0000-0000-000000000001';");
    console.log(`Deleted ${res.rowCount} organizations and all their cascaded data.`);
  } catch(e) {
    console.error('Error:', e);
  } finally {
    pool.end();
  }
}
run();
