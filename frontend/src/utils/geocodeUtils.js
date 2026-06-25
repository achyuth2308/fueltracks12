// ============================================================
// REVERSE GEOCODING — server-proxy version (Phase 7.4 of
// SCALING_ROADMAP.md).
//
// Why this changed:
// The previous client-side version had serious scaling problems:
// - `addressCache` was unbounded (memory leak on long sessions)
// - 5000 vehicle markers = 5000 simultaneous fetches, all
//   throttled to 1 req/sec by a module-level flag = 83 minutes
//   to resolve the fleet
// - Every live GPS update triggered a re-fetch (deps `[lat, lng]`
//   change every packet)
// - Direct browser-to-Nominatim calls hit per-IP rate limits
//   that affect the customer's NAT, not just this tab
//
// Fix: move all Nominatim traffic through a backend proxy at
// POST /api/geocode/reverse. The backend:
//   1. Has a server-side LRU cache (Redis-backed, persistent)
//   2. Globally rate-limits to 1 req/sec (one server = one rate
//      budget, not 50 browser tabs each with their own budget)
//   3. Has a 5-second fetch timeout
//   4. Returns null on failure so UI can show graceful fallback
// ============================================================

import axios from 'axios';

const API_BASE = import.meta.env.VITE_API_URL || '';

// Frontend LRU cache: bounded so it can't leak. 2000 entries
// covers ~2 sq km of typical vehicle positions (4 decimal places
// = ~11m resolution).
const CACHE_MAX = parseInt(import.meta.env.VITE_GEOCODE_CACHE_MAX) || 2000;
const addressCache = new Map();

function cacheGet(key) {
  return addressCache.get(key);
}
function cacheSet(key, value) {
  if (addressCache.size >= CACHE_MAX) {
    // Drop oldest entry (Map preserves insertion order).
    const first = addressCache.keys().next().value;
    addressCache.delete(first);
  }
  addressCache.set(key, value);
}

// In-flight request deduplication. If 50 markers ask for the
// same coords at once, only ONE network request goes out;
// all 50 promises resolve with the same answer.
const inflight = new Map();

function cacheKey(lat, lng) {
  // 4 decimal places = ~11m resolution. Vehicles parked at the
  // same spot will hit cache even if lat/lng wobble by 0.0001.
  return `${parseFloat(lat).toFixed(4)},${parseFloat(lng).toFixed(4)}`;
}

export const getAddressFromCoordinates = async (lat, lng) => {
  if (!lat || !lng) return 'Unknown Location';
  const key = cacheKey(lat, lng);

  // 1. Frontend cache hit — instant return.
  const cached = cacheGet(key);
  if (cached !== undefined) return cached;

  // 2. In-flight dedup — wait for the existing request.
  if (inflight.has(key)) return inflight.get(key);

  // 3. Issue the proxy request.
  const promise = (async () => {
    try {
      const res = await axios.post(
        `${API_BASE}/api/geocode/reverse`,
        { lat: parseFloat(lat), lng: parseFloat(lng) },
        { timeout: 6000 }
      );
      const address = res.data?.address || 'Unknown Location';
      // Only cache successful resolutions, not nulls.
      if (address && address !== 'Location unavailable') {
        cacheSet(key, address);
      }
      return address;
    } catch (err) {
      console.error('[GEOCODE] proxy error:', err.message);
      return 'Location unavailable';
    } finally {
      inflight.delete(key);
    }
  })();

  inflight.set(key, promise);
  return promise;
};


/**
 * Pre-warm the backend Redis geocode cache for a batch of coords.
 * Used by RouteMap on mount so that clicking markers on the route
 * shows the address instantly rather than 'Fetching...'.
 *
 * The backend bulk endpoint serialises Nominatim calls at 1/sec.
 * For a route with 200 unique coords, full warm takes ~200s. We
 * chunk the request to stay under the backend's 100-coord-per-
 * request limit.
 *
 * @param {Array<{lat:number, lng:number}>} coords
 * @returns {Promise<{warmed:number, errors:number}>}
 */
export const warmGeocodeCache = async (coords) => {
  if (!coords || !coords.length) return { warmed: 0, errors: 0 };
  let warmed = 0;
  let errors = 0;
  // Backend limit is 100 per request.
  for (let i = 0; i < coords.length; i += 100) {
    const chunk = coords.slice(i, i + 100);
    try {
      const res = await axios.post(
        `${API_BASE}/api/geocode/reverse/bulk`,
        { coords: chunk },
        { timeout: 60000 }   // bulk may take a while
      );
      const results = res.data?.results || [];
      // Pre-populate the frontend LRU so when the user clicks a
      // marker, getAddressFromCoordinates returns synchronously
      // and AddressText shows the address immediately (no
      // 'Fetching...' flicker).
      for (const r of results) {
        if (r.address && r.lat != null && r.lng != null) {
          const k = cacheKey(r.lat, r.lng);
          cacheSet(k, r.address);
          warmed++;
        }
      }
    } catch (err) {
      errors++;
      console.warn(`[GEOCODE] warm chunk ${i}-${i+100} failed: ${err.message}`);
    }
  }
  return { warmed, errors };
};
