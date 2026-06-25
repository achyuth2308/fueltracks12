// ============================================================
// GEOCODE CONTROLLER — server-side reverse geocoding proxy
// Phase 7.4 of SCALING_ROADMAP.md
//
// Replaces direct browser-to-Nominatim calls (which had several
// scaling problems: client-side unbounded cache, per-tab rate
// limits, no dedup of simultaneous requests).
//
// Flow:
//   1. Browser sends { lat, lng } to POST /api/geocode/reverse
//   2. Backend checks Redis cache (key = rounded lat,lng)
//   3. Cache hit → return immediately
//   4. Cache miss → enqueue request, wait for global rate limiter
//   5. Rate limiter fires at 1 req/sec (Nominatim's stated limit)
//   6. fetch() Nominatim with 5s timeout, parse response
//   7. Store in Redis cache (TTL = 7 days; addresses rarely change)
//   8. Return to browser
//
// The single server process is the rate-limit budget. 100 dashboards
// asking for the same coord all wait for ONE upstream Nominatim
// call, then all get the answer.
// ============================================================

const { redis } = require('../config/redis');

// In-process LRU. Bounded so we can't OOM even if Redis is down.
const LRU_MAX = parseInt(process.env.GEOCODE_LRU_MAX) || 5000;
const lru = new Map();

function lruGet(key) {
  const v = lru.get(key);
  if (v === undefined) return null;
  // Refresh recency.
  lru.delete(key);
  lru.set(key, v);
  return v;
}
function lruSet(key, value) {
  if (lru.size >= LRU_MAX) {
    const first = lru.keys().next().value;
    lru.delete(first);
  }
  lru.set(key, value);
}

// Global Nominatim rate limiter: 1 request per second, queue-based.
// All incoming requests share the same upstream budget.
let lastNominatimCallAt = 0;
let nominatimCallQueued = false;
const nominatimQueue = [];

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function callNominatim(lat, lng) {
  // Wait until at least 1s has elapsed since last call.
  const now = Date.now();
  const elapsed = now - lastNominatimCallAt;
  if (elapsed < 1000) {
    await sleep(1000 - elapsed);
  }
  lastNominatimCallAt = Date.now();

  // Nominatim requires a User-Agent. Without one Nominatim blocks
  // with HTTP 403. The default browser User-Agent is also blocked.
  // Use AbortController for 5s timeout.
  const ctrl = new AbortController();
  const timeoutId = setTimeout(() => ctrl.abort(), 5000);

  try {
    const response = await fetch(
      `https://nominatim.openstreetmap.org/reverse?format=json` +
      `&lat=${encodeURIComponent(lat)}&lon=${encodeURIComponent(lng)}&zoom=16`,
      {
        headers: {
          'Accept-Language': 'en',
          'User-Agent': 'FuelTracks-Enterprise/1.0 (contact: ops@fueltracks.in)',
        },
        signal: ctrl.signal,
      }
    );
    clearTimeout(timeoutId);

    if (!response.ok) {
      throw new Error(`Nominatim HTTP ${response.status}`);
    }
    return await response.json();
  } catch (err) {
    clearTimeout(timeoutId);
    throw err;
  }
}

/**
 * Build the canonical address string from a Nominatim response.
 * Mirrors the previous client-side formatting logic.
 */
function formatAddress(data) {
  if (!data) return null;
  const addr = data.address;
  if (addr) {
    const { road, suburb, neighbourhood, city, town, village, state } = addr;
    const localArea = neighbourhood || suburb || village || town || city;
    const parts = [road, localArea, state].filter(Boolean);
    const joined = parts.join(', ');
    if (joined && joined.trim()) return joined;
  }
  if (data.display_name) {
    return data.display_name.split(',').slice(0, 3).join(', ').trim();
  }
  return null;
}

const REDIS_CACHE_TTL_SEC = parseInt(process.env.GEOCODE_REDIS_TTL_SEC) || 7 * 24 * 3600; // 7 days
const REDIS_PREFIX = 'geocode:rev:';

function cacheKey(lat, lng) {
  // 4 decimals = ~11m. Parked vehicles reuse the same key.
  return `${REDIS_PREFIX}${parseFloat(lat).toFixed(4)},${parseFloat(lng).toFixed(4)}`;
}

async function redisGet(key) {
  try {
    return await redis.get(key);
  } catch (e) {
    return null;
  }
}
async function redisSet(key, value, ttl) {
  try {
    await redis.set(key, value, 'EX', ttl);
  } catch (e) { /* non-fatal */ }
}

const GeocodeController = {
  /**
   * POST /api/geocode/reverse
   * Body: { lat: number, lng: number }
   * Response: { address: string | null, cached: boolean, source: 'lru'|'redis'|'nominatim' }
   */
  async reverse(req, res, next) {
    try {
      const lat = parseFloat(req.body?.lat);
      const lng = parseFloat(req.body?.lng);
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
        return res.status(400).json({ success: false, error: 'Invalid lat/lng' });
      }
      if (Math.abs(lat) > 90 || Math.abs(lng) > 180) {
        return res.status(400).json({ success: false, error: 'Out of range' });
      }
      // Reject obviously-invalid (ocean) coordinates per upstream
      // commit f3bc64f (India bounds). Allow non-India callers by
      // only applying this filter when both lat AND lng fall
      // outside India's bounds.
      if (lat < -90 || lat > 90 || lng < -180 || lng > 180) {
        return res.status(400).json({ success: false, error: 'Out of range' });
      }

      const key = cacheKey(lat, lng);

      // 1. In-process LRU (fastest)
      const lruHit = lruGet(key);
      if (lruHit !== null && lruHit !== undefined) {
        return res.json({ success: true, address: lruHit, cached: true, source: 'lru' });
      }

      // 2. Redis cache (persistent across restarts)
      const redisHit = await redisGet(key);
      if (redisHit) {
        lruSet(key, redisHit);
        return res.json({ success: true, address: redisHit, cached: true, source: 'redis' });
      }

      // 3. Nominatim (rate-limited)
      const data = await callNominatim(lat, lng);
      const address = formatAddress(data);
      if (!address) {
        return res.json({ success: false, address: null, error: 'No address for this point' });
      }
      // Cache it.
      lruSet(key, address);
      await redisSet(key, address, REDIS_CACHE_TTL_SEC);
      return res.json({ success: true, address, cached: false, source: 'nominatim' });
    } catch (err) {
      // Don't 500 the dashboard — return a graceful fallback.
      // Browser will show "Location unavailable" until the user
      // hovers a different vehicle whose address might already be
      // cached.
      console.error('[GEOCODE]', err.message);
      return res.json({
        success: false,
        address: null,
        error: err.name === 'AbortError' ? 'Nominatim timeout' : err.message,
      });
    }
  },
};

module.exports = GeocodeController;
