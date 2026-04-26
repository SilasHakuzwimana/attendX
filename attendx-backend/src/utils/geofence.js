/**
 * Calculate distance between two coordinates using Haversine formula
 * @param {number} lat1 - Latitude of point 1
 * @param {number} lon1 - Longitude of point 1
 * @param {number} lat2 - Latitude of point 2
 * @param {number} lon2 - Longitude of point 2
 * @returns {number} Distance in meters
 */
const calculateDistance = (lat1, lon1, lat2, lon2) => {
  const R = 6371e3; // Earth's radius in meters
  const φ1 = (lat1 * Math.PI) / 180;
  const φ2 = (lat2 * Math.PI) / 180;
  const Δφ = ((lat2 - lat1) * Math.PI) / 180;
  const Δλ = ((lon2 - lon1) * Math.PI) / 180;

  const a =
    Math.sin(Δφ / 2) * Math.sin(Δφ / 2) +
    Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) * Math.sin(Δλ / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

  return R * c;
};

/**
 * Check if a point is within a geofence
 * @param {number} lat - Latitude of point
 * @param {number} lon - Longitude of point
 * @param {number} centerLat - Center latitude of geofence
 * @param {number} centerLon - Center longitude of geofence
 * @param {number} radiusM - Radius in meters
 * @returns {boolean} True if within geofence
 */
const isWithinGeofence = (lat, lon, centerLat, centerLon, radiusM) => {
  const distance = calculateDistance(lat, lon, centerLat, centerLon);
  return distance <= radiusM;
};

module.exports = {
  calculateDistance,
  isWithinGeofence
};
