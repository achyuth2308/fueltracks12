-- ============================================================
-- TIMESCALEDB HYPERTABLE + RETENTION + COMPRESSION
-- Phase 3 of SCALING_ROADMAP.md
--
-- Apply AFTER schema.sql (which now also creates the
-- timescaledb extension). Idempotent — safe to re-run.
--
-- Why this matters: at 30K devices × 1 pkt/30s, gps_points
-- receives ~2.6 BILLION rows/month. As a plain Postgres
-- table it would:
--   - hit btree bloat after ~500M rows
--   - make vacuum multi-hour
--   - cause sequential-scan plans on dashboards
-- TimescaleDB converts it to a hypertable (auto-chunked by
-- device_time) which gives us:
--   - native chunk pruning: queries with a time filter only
--     scan the relevant chunks (7-day chunks by default)
--   - native compression: 10-20x storage reduction
--   - native retention policy: auto-drop chunks older than N days
-- ============================================================

-- 1. Convert gps_points into a hypertable, chunked by week.
--    create_hypertable is idempotent on re-run IF the table is
--    already a hypertable, but the safety check below avoids
--    noisy errors.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM timescaledb_information.hypertables
    WHERE hypertable_name = 'gps_points'
  ) THEN
    PERFORM create_hypertable(
      'gps_points', 'device_time',
      chunk_time_interval => INTERVAL '7 days',
      if_not_exists => TRUE
    );
  END IF;
END $$;

-- 2. Add an index on (vehicle_id, device_time DESC) on the
--    hypertable — TimescaleDB auto-creates an index on the
--    chunking column, but the per-vehicle query pattern needs
--    this composite.
CREATE INDEX IF NOT EXISTS idx_gps_vehicle_time
  ON gps_points (vehicle_id, device_time DESC);

-- 3. Drop the now-redundant single-column device_time index
--    (the hypertable's internal index already covers it).
--    Safe to leave too if you prefer; only matters for write speed.
-- DROP INDEX IF EXISTS idx_gps_device_time;

-- 4. Retention policy: keep 180 days of gps_points, then auto-drop.
--    Adjustable via the retention_settings table if you want to
--    extend for compliance reasons.
SELECT add_retention_policy('gps_points', INTERVAL '180 days', if_not_exists => TRUE);

-- 5. Compression policy: compress chunks older than 14 days.
--    Compression segmented by vehicle_id so per-vehicle queries
--    remain fast.
ALTER TABLE gps_points SET (
  timescaledb.compress,
  timescaledb.compress_segmentby = 'vehicle_id',
  timescaledb.compress_orderby = 'device_time DESC'
);

SELECT add_compression_policy('gps_points', INTERVAL '14 days', if_not_exists => TRUE);

-- 6. Continuous aggregate: pre-compute hourly averages per vehicle
--    for fast dashboard "last 24h" panels. Refresh every hour.
CREATE MATERIALIZED VIEW IF NOT EXISTS gps_points_hourly
WITH (timescaledb.continuous) AS
SELECT
  vehicle_id,
  time_bucket('1 hour', device_time) AS bucket,
  AVG(speed)::numeric(6,2) AS avg_speed,
  MAX(speed) AS max_speed,
  MIN(speed) AS min_speed,
  AVG(fuel)::numeric(6,2) AS avg_fuel,
  MAX(odometer) - MIN(odometer) AS distance_km,
  COUNT(*) AS point_count
FROM gps_points
GROUP BY vehicle_id, bucket
WITH NO DATA;

SELECT add_continuous_aggregate_policy('gps_points_hourly',
  start_offset => INTERVAL '7 days',
  end_offset   => INTERVAL '1 hour',
  schedule_interval => INTERVAL '1 hour',
  if_not_exists => TRUE);

-- 7. Continuous aggregate: daily rollup (180-day retention).
CREATE MATERIALIZED VIEW IF NOT EXISTS gps_points_daily
WITH (timescaledb.continuous) AS
SELECT
  vehicle_id,
  time_bucket('1 day', device_time) AS bucket,
  AVG(speed)::numeric(6,2) AS avg_speed,
  MAX(speed) AS max_speed,
  AVG(fuel)::numeric(6,2) AS avg_fuel,
  MAX(odometer) - MIN(odometer) AS distance_km,
  COUNT(*) AS point_count,
  SUM(CASE WHEN ignition = TRUE THEN 1 ELSE 0 END) AS ignition_on_count
FROM gps_points
GROUP BY vehicle_id, bucket
WITH NO DATA;

SELECT add_continuous_aggregate_policy('gps_points_daily',
  start_offset => INTERVAL '90 days',
  end_offset   => INTERVAL '1 day',
  schedule_interval => INTERVAL '1 day',
  if_not_exists => TRUE);

-- 8. Update statistics target on hypertable columns so the planner
--    uses histogram stats after compression flips a chunk to columnar.
ALTER TABLE gps_points ALTER COLUMN vehicle_id SET STATISTICS 1000;
ALTER TABLE gps_points ALTER COLUMN device_time SET STATISTICS 1000;

-- 9. Verify
SELECT hypertable_name, num_chunks,
       (SELECT count(*) FROM timescaledb_information.chunks
        WHERE hypertable_name = 'gps_points') AS chunk_count_now
FROM timescaledb_information.hypertables
WHERE hypertable_name = 'gps_points';
