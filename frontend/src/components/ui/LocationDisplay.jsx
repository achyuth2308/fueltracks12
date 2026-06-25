import React, { useState, useEffect } from 'react';
import { MapPin } from 'lucide-react';
import { getAddressFromCoordinates } from '../../utils/geocodeUtils';

const LocationDisplay = ({ lat, lng }) => {
  const [address, setAddress] = useState('Fetching...');
  
  useEffect(() => {
    let mounted = true;
    if (!lat || !lng) {
      setAddress('Unknown Location');
      return () => { mounted = false; };
    }
    // Phase 7.4 of SCALING_ROADMAP.md: round to 4 decimals (~11m)
    // BEFORE using as effect deps so a vehicle moving within the
    // same address block doesn't re-trigger the fetch on every
    // GPS packet. The cache key inside getAddressFromCoordinates
    // is also rounded, so this aligns effect deps with cache hits.
    const roundedLat = parseFloat(parseFloat(lat).toFixed(4));
    const roundedLng = parseFloat(parseFloat(lng).toFixed(4));
    setAddress('Fetching...');
    getAddressFromCoordinates(roundedLat, roundedLng).then(addr => {
      if (mounted) setAddress(addr || 'Unknown Location');
    });
    return () => { mounted = false; };
  }, [lat, lng]);

  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginTop: '6px', paddingTop: '6px', borderTop: '1px solid #F1F5F9' }}>
      <span style={{ color: '#64748B', fontWeight: 600, display: 'flex', alignItems: 'center', gap: '4px' }}>
        <MapPin size={12} /> Loc
      </span>
      <span style={{ fontWeight: 600, color: '#334155', textAlign: 'right', fontSize: '11px', lineHeight: '1.3', maxWidth: '140px' }}>
        {address}
      </span>
    </div>
  );
};

export default LocationDisplay;
