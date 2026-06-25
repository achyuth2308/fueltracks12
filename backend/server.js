// ============================================================
// BACKEND API SERVER - FuelTracks
// Express.js REST API + Socket.io Real-time server
// Port 3001
// ============================================================

const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');

const env = require('./config/env');
const db = require('./config/db');
const redisConfig = require('./config/redis');

// Import routes
const authRoutes = require('./routes/authRoutes');
const vehicleRoutes = require('./routes/vehicleRoutes');
const adminRoutes = require('./routes/adminRoutes');
const auditRoutes = require('./routes/auditRoutes');
const reportRoutes = require('./modules/reports/routes/reportRoutes');
const profileRoutes = require('./modules/profile/routes/profileRoutes');
const billingRoutes = require('./routes/billingRoutes');
const geocodeRoutes = require('./routes/geocodeRoutes');
const path = require('path');

// Import middleware
const { errorHandler, notFoundHandler } = require('./middleware/error');

// Import subscribers & socket manager
const locationSubscriber = require('./subscribers/locationSubscriber');
const alertSubscriber = require('./subscribers/alertSubscriber');
const trackingSocket = require('./sockets/trackingSocket');

const app = express();
const server = http.createServer(app);

// Phase 7.1 — Prometheus metrics for the API process
const { registry } = require('../shared/metrics');
const metric_http_requests = registry.counter(
  'fueltracks_api_http_requests_total',
  'Total HTTP requests handled by the API');
const metric_http_request_duration = registry.histogram(
  'fueltracks_api_http_request_duration_ms',
  'HTTP request handler duration in ms');
const metric_socketio_connections = registry.gauge(
  'fueltracks_api_socketio_connections',
  'Currently connected Socket.io clients');

// Attach Socket.io
const io = socketIo(server, {
  cors: {
    origin: env.CORS_ORIGIN,
    methods: ['GET', 'POST', 'PUT', 'DELETE'],
    credentials: true,
  },
});

io.on('connection', (socket) => {
  metric_socketio_connections.inc();
  socket.on('disconnect', () => metric_socketio_connections.dec());
});

// Middleware-level request counter + latency observation.
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    metric_http_requests.inc();
    metric_http_request_duration.observe(Date.now() - start);
  });
  next();
});

// Middleware
app.use(helmet()); // Secure HTTP headers
// P3-7 of SCALING_ROADMAP.md — tighten CORS.
// Earlier version allowed any origin (`callback(null, true)`).
// For an authenticated SPA, we should allow only the frontend's
// own origin. If CORS_ORIGIN is '*' we keep the wildcard for dev
// but log a warning; in production it should be the frontend URL.
const allowedOrigin = env.CORS_ORIGIN;
if (allowedOrigin === '*') {
  console.warn('[CORS] CORS_ORIGIN is "*" — wildcard allowed. Set a specific origin in production.');
}
app.use(cors({
  origin: function (origin, callback) {
    if (allowedOrigin === '*') return callback(null, true);
    if (!origin || origin === allowedOrigin) return callback(null, true);
    return callback(new Error('CORS: origin not allowed: ' + origin));
  },
  credentials: true
}));

// P3-3 — apply rate limiting after CORS so preflight doesn't count.
// Skip /health and /metrics so external monitors aren't throttled.
const { applyAuto } = require('./middleware/rateLimit');
applyAuto(app);
app.use(express.json()); // JSON parser
app.use(morgan(env.NODE_ENV === 'production' ? 'combined' : 'dev')); // HTTP Logging

// Mount REST routes
app.use('/api/auth', authRoutes);
app.use('/api/vehicles', vehicleRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/audit', auditRoutes);
app.use('/api/reports', reportRoutes);
app.use('/api/profile', profileRoutes);
app.use('/api/billing', billingRoutes);
app.use('/api/geocode', geocodeRoutes);

// Mount Static File Serving for Uploads
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// Prometheus metrics endpoint (Phase 7.1)
app.get('/metrics', (req, res) => {
  res.set('Content-Type', 'text/plain; version=0.0.4');
  res.end(registry.render());
});

// Health Check
app.get('/health', async (req, res) => {
  try {
    // Check DB status
    await db.query('SELECT 1');
    // Check Redis status
    await redisConfig.redis.ping();

    res.status(200).json({
      success: true,
      status: 'OK',
      services: {
        database: 'connected',
        redis: 'connected',
      },
    });
  } catch (err) {
    res.status(500).json({
      success: false,
      status: 'DEGRADED',
      error: err.message,
    });
  }
});

// 404 Route handler
app.use(notFoundHandler);

// Global Error Handler
app.use(errorHandler);

// Initialize Subscribers and Sockets
async function bootstrap() {
  try {
    // 1. Initialize Socket.io room handlers
    trackingSocket.init(io);
    console.log('[BOOT] Socket.io event handlers configured');

    // 2. Start Redis subscribers for background processing
    await locationSubscriber.start(io);
    await alertSubscriber.start(io);
    console.log('[BOOT] Redis subscribers started');

    // 3. Start Express server
    server.listen(env.API_PORT, '0.0.0.0', () => {
      console.log('============================================================');
      console.log(`  FUELTRACKS BACKEND API`);
      console.log(`  Listening on port ${env.API_PORT}`);
      console.log(`  Environment: ${env.NODE_ENV}`);
      console.log(`  PostgreSQL: ${env.DB_HOST}:${env.DB_PORT}`);
      console.log(`  Redis Cache: ${env.REDIS_HOST}:${env.REDIS_PORT}`);
      console.log('============================================================');
    });

  } catch (err) {
    console.error('[BOOT] Bootstrap failed:', err);
    process.exit(1);
  }
}

bootstrap();

// Graceful Shutdown
async function shutdown() {
  console.log('\n[SERVER] Shutting down gracefully...');
  server.close(async () => {
    try {
      await locationSubscriber.stop();
      await alertSubscriber.stop();
      await redisConfig.redis.quit();
      await db.pool.end();
      console.log('[SERVER] Connections closed. Exit complete.');
      process.exit(0);
    } catch (err) {
      console.error('[SERVER] Error during shutdown:', err);
      process.exit(1);
    }
  });
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

module.exports = { app, server, io };
