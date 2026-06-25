// ============================================================
// IN-MEMORY TOKEN-BUCKET RATE LIMITER
// P3-3 of SCALING_ROADMAP.md (audit finding).
//
// Why this exists: a single misbehaving admin client or a leaked
// JWT can hammer /api/vehicles and exhaust the Postgres pool.
// Without rate limiting, one user can DoS all other users'
// reads.
//
// Implementation: per-key (userId or IP) token bucket. Each key
// gets `capacity` tokens, refilled at `refillPerSec`. Each
// request consumes 1 token. When bucket is empty, return 429
// with a Retry-After header.
//
// In-memory means:
//   - Per-process limits. If you run multiple api instances
//     (cluster mode), the limit applies per instance, not
//     globally. For global limits, use Redis-backed counters.
//   - Survives process restart (counters reset). Acceptable
//     trade-off — no extra dependency.
//
// Defaults: 100 reads/min per user, 600 reads/min per IP, no
// limit on writes (admins should not be artificially throttled).
// Tunable via env vars.
// ============================================================

class TokenBucket {
  constructor(capacity, refillPerSec) {
    this.capacity = capacity;
    this.refillPerSec = refillPerSec;
    this.tokens = capacity;
    this.lastRefill = Date.now();
  }
  take(n = 1) {
    const now = Date.now();
    const elapsed = (now - this.lastRefill) / 1000;
    this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.refillPerSec);
    this.lastRefill = now;
    if (this.tokens >= n) {
      this.tokens -= n;
      return true;
    }
    return false;
  }
  retryAfterSec() {
    const deficit = 1 - this.tokens;
    return Math.ceil(deficit / this.refillPerSec);
  }
}

const buckets = new Map();
const MAX_KEYS = parseInt(process.env.RATE_LIMIT_MAX_KEYS) || 100000;

// Periodically prune old buckets so the map doesn't grow forever
// (one entry per active client). Without this, idle clients leak.
setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of buckets.entries()) {
    if (now - bucket.lastRefill > 30 * 60 * 1000) {
      buckets.delete(key);
    }
  }
}, 5 * 60 * 1000).unref();

function getBucket(key, capacity, refillPerSec) {
  let b = buckets.get(key);
  if (!b) {
    // Cap the map size to prevent memory blow-up under attack.
    if (buckets.size >= MAX_KEYS) {
      // Drop oldest entry.
      const oldest = buckets.keys().next().value;
      buckets.delete(oldest);
    }
    b = new TokenBucket(capacity, refillPerSec);
    buckets.set(key, b);
  }
  return b;
}

/**
 * Express middleware. Options:
 *   capacity:   max tokens (burst size)
 *   refillPerSec: tokens added per second
 *   keyFn:      (req) => string — defaults to userId then IP
 *   scope:      'read' | 'write' | 'all' — used to compose limits
 */
function rateLimit({ capacity, refillPerSec, keyFn, scope = 'all' }) {
  return (req, res, next) => {
    // Skip rate limiting for health/metrics — they shouldn't be limited.
    if (req.path === '/health' || req.path === '/metrics') return next();

    const key = (keyFn && keyFn(req)) ||
                (req.user && req.user.userId ? `u:${req.user.userId}` : null) ||
                `ip:${req.ip}`;
    const bucketKey = `${scope}:${key}`;
    const bucket = getBucket(bucketKey, capacity, refillPerSec);
    if (!bucket.take(1)) {
      const retryAfter = bucket.retryAfterSec();
      res.set('Retry-After', String(retryAfter));
      return res.status(429).json({
        success: false,
        error: 'Too many requests',
        code: 'RATE_LIMITED',
        retryAfter,
      });
    }
    next();
  };
}

// ---- Pre-built middlewares matching common patterns ----

// 100 reads/min per user (1.67 req/sec sustained, burst 100).
// Default for GET requests.
const userReadLimit = rateLimit({
  capacity: 100,
  refillPerSec: 100 / 60,
  scope: 'read',
});

// 600 reads/min per IP (10 req/sec sustained, burst 600).
// Fallback for unauthenticated traffic (login, etc).
const ipReadLimit = rateLimit({
  capacity: 600,
  refillPerSec: 10,
  scope: 'read',
  keyFn: (req) => `ip:${req.ip}`,
});

// 30 writes/min per user. Admin operations like create-vehicle
// should not be hit at high RPS.
const userWriteLimit = rateLimit({
  capacity: 30,
  refillPerSec: 30 / 60,
  scope: 'write',
});

// Auto-apply to routes by method.
function applyAuto(app) {
  // Auth and login routes get only the IP-based limit (they're
  // unauthenticated or pre-authenticated).
  // Other GET routes get user-read + IP-read (whichever is tighter).
  // Other write routes get user-write.
  app.use((req, res, next) => {
    if (req.method === 'GET' || req.method === 'HEAD') {
      // Run both limits; if either fails, return 429.
      const userKey = (req.user && req.user.userId && `u:${req.user.userId}`) || null;
      const ipKey = `ip:${req.ip}`;
      if (userKey) {
        const b = getBucket(`read:${userKey}`, 100, 100 / 60);
        if (!b.take(1)) {
          res.set('Retry-After', String(b.retryAfterSec()));
          return res.status(429).json({ success: false, error: 'Too many requests', code: 'RATE_LIMITED' });
        }
      }
      const bi = getBucket(`read:${ipKey}`, 600, 10);
      if (!bi.take(1)) {
        res.set('Retry-After', String(bi.retryAfterSec()));
        return res.status(429).json({ success: false, error: 'Too many requests', code: 'RATE_LIMITED' });
      }
      return next();
    }
    // Writes (POST/PUT/DELETE/PATCH)
    const userKey = (req.user && req.user.userId && `u:${req.user.userId}`) || null;
    if (userKey) {
      const b = getBucket(`write:${userKey}`, 30, 30 / 60);
      if (!b.take(1)) {
        res.set('Retry-After', String(b.retryAfterSec()));
        return res.status(429).json({ success: false, error: 'Too many requests', code: 'RATE_LIMITED' });
      }
    }
    return next();
  });
}

module.exports = {
  rateLimit,
  TokenBucket,
  applyAuto,
  userReadLimit,
  ipReadLimit,
  userWriteLimit,
};
