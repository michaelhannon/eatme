/**
 * Geocode a plain-text address → { lat, lng } using Nominatim (OpenStreetMap).
 * Free, no API key required. Rate limit: 1 req/s — fine for our use case.
 */

const https = require('https');

/**
 * @param {string} address
 * @returns {Promise<{lat: number, lng: number}|null>}
 */
function geocode(address) {
  return new Promise((resolve) => {
    const query = encodeURIComponent(address);
    const url = `https://nominatim.openstreetmap.org/search?q=${query}&format=json&limit=1&countrycodes=us`;

    const options = {
      headers: {
        'User-Agent': 'EatMe/1.0 (food delivery price comparator)',
        'Accept': 'application/json'
      }
    };

    const req = https.get(url, options, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try {
          const results = JSON.parse(body);
          if (results && results.length > 0) {
            const { lat, lon } = results[0];
            const parsed = { lat: parseFloat(lat), lng: parseFloat(lon) };
            console.log(`[Geocode] "${address}" → ${parsed.lat}, ${parsed.lng}`);
            resolve(parsed);
          } else {
            console.warn(`[Geocode] No results for "${address}"`);
            resolve(null);
          }
        } catch (e) {
          console.error('[Geocode] Parse error:', e.message);
          resolve(null);
        }
      });
    });

    req.on('error', (e) => {
      console.error('[Geocode] Request error:', e.message);
      resolve(null);
    });

    req.setTimeout(6000, () => {
      console.warn('[Geocode] Timeout');
      req.destroy();
      resolve(null);
    });
  });
}

module.exports = { geocode };
