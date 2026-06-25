// ============================================================
// GEOCODE ROUTES
// Phase 7.4 of SCALING_ROADMAP.md
// ============================================================

const express = require('express');
const GeocodeController = require('../controllers/geocodeController');
const { authenticate } = require('../middleware/auth');

const router = express.Router();

// Reverse geocoding. Authenticated so the rate limiter covers it.
router.post('/reverse', authenticate, GeocodeController.reverse);

// Optional: bulk reverse (e.g. dashboard warms cache for visible
// vehicles on map load). Up to 100 coords per request.
router.post('/reverse/bulk', authenticate, async (req, res, next) => {
  try {
    const coords = Array.isArray(req.body?.coords) ? req.body.coords : [];
    if (!coords.length) return res.json({ success: true, results: [] });
    if (coords.length > 100) {
      return res.status(400).json({ success: false, error: 'Max 100 coords per request' });
    }
    const results = [];
    for (const c of coords) {
      const lat = parseFloat(c.lat);
      const lng = parseFloat(c.lng);
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
        results.push({ lat, lng, address: null, error: 'invalid' });
        continue;
      }
      // Reuse the single-call path. The rate limiter inside the
      // controller will serialize Nominatim calls at 1/sec, so
      // 100 coords takes ~100s. Fine for background warming.
      try {
        const fakeReq = { body: { lat, lng } };
        const fakeRes = {
          json: (data) => data,
          status: () => fakeRes,
        };
        const result = await GeocodeController.reverse(
          fakeReq, fakeRes, () => {}
        );
        results.push({ lat, lng, ...result });
      } catch (e) {
        results.push({ lat, lng, address: null, error: e.message });
      }
    }
    return res.json({ success: true, results });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
