// ============================================================
// PM2 ECOSYSTEM CONFIG
// Phase 4 + 5 of SCALING_ROADMAP.md
//
// Run with: pm2 start ecosystem.config.js
//
// What this does:
// - Starts all 4 PM2 processes in fork mode (single instance per
//   process). Fork mode caps each Node.js process at 1 CPU core,
//   which is correct for our architecture:
//     * tcp-server: parsing-heavy, benefit from dedicated core
//     * api:        REST + Socket.io broadcast (in-process)
//     * writer:     batched DB writes (own event loop)
//     * frontend:   static file serving (negligible CPU)
// - Sets sensible memory limits so a process that starts leaking
//   gets recycled by PM2 instead of taking down the whole EC2.
// - Writes logs to /var/log/fueltracks/ (create the dir first).
// ============================================================

const path = require('path');

const COMMON_ENV = {
  NODE_ENV: 'production',
  // Phase 1 — Streams tuning
  STREAM_MAXLEN: '1000000',
  STREAM_BATCH_SIZE: '200',
  STREAM_BLOCK_MS: '1000',
  // Phase 5 — connection caps
  TCP_HIGH_WATER: '50',
  TCP_LOW_WATER: '10',
  TCP_PORT_CAP_BSTPL: '12000',
  TCP_PORT_CAP_AIS140: '10000',
  TCP_PORT_CAP_CONCOX: '8000',
  TCP_PER_IMEI_CAP: '3',
  // Phase 3 — DB pool
  PG_POOL_MAX: '50',
  PG_STATEMENT_TIMEOUT_MS: '30000',
  // Phase 4 — writer batching
  WRITER_BATCH_ROWS: '1000',
  WRITER_BATCH_MS: '1000',
  // Consumer groups (Phase 4)
  STREAM_GROUP: 'fueltracks_broadcaster',     // API process
  WRITER_GROUP: 'fueltracks_writer',          // writer process
  ALERT_STREAM_GROUP: 'fueltracks_alert_writer',
  // Service hosts (override in /home/ubuntu/.env if needed)
  REDIS_HOST: process.env.REDIS_HOST || '127.0.0.1',
  REDIS_PORT: process.env.REDIS_PORT || '6379',
  DB_HOST:    process.env.DB_HOST    || '127.0.0.1',
  DB_PORT:    process.env.DB_PORT    || '5432',
  DB_NAME:    process.env.DB_NAME    || 'fueltracks',
};

module.exports = {
  apps: [
    {
      name: 'fueltracks-tcp',
      cwd: path.join(__dirname, 'tcp-server'),
      script: 'server.js',
      instances: 1,
      exec_mode: 'fork',
      max_memory_restart: '512M',
      env: { ...COMMON_ENV },
      out_file: '/var/log/fueltracks/tcp-out.log',
      error_file: '/var/log/fueltracks/tcp-error.log',
      merge_logs: true,
    },
    {
      name: 'fueltracks-writer',
      cwd: path.join(__dirname, 'writer'),
      script: 'server.js',
      instances: 1,
      exec_mode: 'fork',
      max_memory_restart: '512M',
      env: { ...COMMON_ENV },
      out_file: '/var/log/fueltracks/writer-out.log',
      error_file: '/var/log/fueltracks/writer-error.log',
      merge_logs: true,
    },
    {
      name: 'fueltracks-api',
      cwd: path.join(__dirname, 'backend'),
      script: 'server.js',
      instances: 1,
      exec_mode: 'fork',
      max_memory_restart: '512M',
      env: { ...COMMON_ENV },
      out_file: '/var/log/fueltracks/api-out.log',
      error_file: '/var/log/fueltracks/api-error.log',
      merge_logs: true,
    },
    {
      name: 'fueltracks-frontend',
      cwd: path.join(__dirname, 'frontend'),
      // Serves the built static SPA. After `npm run build`, run:
      //   npm install -g serve
      // and we exec it directly.
      script: 'serve',
      args: '-s dist -l 3000',
      instances: 1,
      exec_mode: 'fork',
      max_memory_restart: '256M',
      env: { ...COMMON_ENV },
      out_file: '/var/log/fueltracks/frontend-out.log',
      error_file: '/var/log/fueltracks/frontend-error.log',
      merge_logs: true,
    },
  ],
};
