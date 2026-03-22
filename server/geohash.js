/**
 * Minimal geohash encoder — no external deps.
 * Precision 6 ≈ 1.2 km × 0.6 km cell, suitable for delivery search caching.
 */

const BASE32 = '0123456789bcdefghjkmnpqrstuvwxyz';

/**
 * @param {number} lat
 * @param {number} lng
 * @param {number} [precision=6]
 * @returns {string}
 */
function encode(lat, lng, precision = 6) {
  let idx = 0;       // index into BASE32
  let bit = 0;       // current bit position (0–4)
  let evenBit = true;
  let geohash = '';

  let latMin = -90,  latMax = 90;
  let lngMin = -180, lngMax = 180;

  while (geohash.length < precision) {
    if (evenBit) {
      const mid = (lngMin + lngMax) / 2;
      if (lng >= mid) { idx = (idx << 1) | 1; lngMin = mid; }
      else            { idx = idx << 1;        lngMax = mid; }
    } else {
      const mid = (latMin + latMax) / 2;
      if (lat >= mid) { idx = (idx << 1) | 1; latMin = mid; }
      else            { idx = idx << 1;        latMax = mid; }
    }
    evenBit = !evenBit;

    if (++bit === 5) {
      geohash += BASE32[idx];
      bit = 0;
      idx = 0;
    }
  }

  return geohash;
}

module.exports = { encode };
