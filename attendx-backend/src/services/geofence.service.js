function calculateDistance(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const φ1 = (lat1 * Math.PI) / 180;
  const φ2 = (lat2 * Math.PI) / 180;
  const Δφ = ((lat2 - lat1) * Math.PI) / 180;
  const Δλ = ((lon2 - lon1) * Math.PI) / 180;

  const a =
    Math.sin(Δφ / 2) * Math.sin(Δφ / 2) +
    Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) * Math.sin(Δλ / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

  return R * c;
}

function validateGeofence(userLat, userLng, centerLat, centerLng, radiusM) {
  const distance = calculateDistance(userLat, userLng, centerLat, centerLng);
  return {
    isValid: distance <= radiusM,
    distanceM: Math.round(distance),
    radiusM,
  };
}

module.exports = { calculateDistance, validateGeofence };
