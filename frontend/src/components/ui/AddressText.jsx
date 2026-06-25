import React, { useState, useEffect } from 'react';
import { getAddressFromCoordinates } from '../../utils/geocodeUtils';

const AddressText = ({ lat, lng }) => {
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

  return <span style={{ fontSize: '11px', color: '#475569', fontWeight: 600, whiteSpace: 'normal', lineHeight: '1.3' }}>{address}</span>;
};

export default AddressText;
