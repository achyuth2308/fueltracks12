// ============================================================
// LAZY ADDRESS TEXT
// Phase 7.5 of SCALING_ROADMAP.md
//
// Same as AddressText but defers the geocode fetch until the
// row scrolls into view (IntersectionObserver). Without this,
// a 100-row table renders 100 useEffects simultaneously and
// floods the geocode proxy with 100 fetches on mount, all
// showing 'Fetching...' for 1+ seconds.
//
// With LazyAddressText:
//   - Each row renders a placeholder ('—' or coords) until visible
//   - IntersectionObserver fires when the row enters the viewport
//   - The geocoder mounts, fetches once, displays the result
//   - At any time only ~10-20 addresses are in-flight (the
//     visible ones), regardless of table size
//
// Falls back gracefully if IntersectionObserver is unavailable
// (e.g. some old browsers): just fetches immediately.
// ============================================================

import React, { useState, useEffect, useRef } from 'react';
import AddressText from './AddressText';

const LazyAddressText = ({ lat, lng, placeholder = '—', rootMargin = '200px' }) => {
  const [shouldFetch, setShouldFetch] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    if (!lat || !lng) return;
    // SSR / no IntersectionObserver: fetch immediately.
    if (typeof IntersectionObserver === 'undefined') {
      setShouldFetch(true);
      return;
    }
    const obs = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            setShouldFetch(true);
            obs.disconnect();
            break;
          }
        }
      },
      { rootMargin }
    );
    if (ref.current) obs.observe(ref.current);
    return () => obs.disconnect();
  }, [lat, lng, rootMargin]);

  return (
    <span ref={ref} style={{ display: 'inline-block', minWidth: '60px' }}>
      {shouldFetch && lat && lng
        ? <AddressText lat={lat} lng={lng} />
        : <span style={{ color: '#94a3b8', fontSize: '11px', fontStyle: 'italic' }}>{placeholder}</span>}
    </span>
  );
};

export default LazyAddressText;
