/**
 * Geocode a plain-text address → { lat, lng } using Nominatim (OpenStreetMap).
 * Free, no API key required.
 *
 * Retries with progressively simpler queries if the full address fails:
 *   1. Full address as-is
 *   2. street + city + state (drop unit/apt numbers)
 *   3. city + state only
 *   4. zip code only
 */

const https = require('https');

function nominatimFetch(query) {
  return new Promise((resolve) => {
    const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(query)}&format=json&limit=1&countrycodes=us`;
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
          resolve(results && results.length > 0 ? results[0] : null);
        } catch (e) {
          resolve(null);
        }
      });
    });
    req.on('error', () => resolve(null));
    req.setTimeout(6000, () => { req.destroy(); resolve(null); });
  });
}

/**
 * Build fallback query candidates from an address string.
 * e.g. "33 Sagamore Circle, Columbus, MS 39705"
 *   → ["33 Sagamore Circle, Columbus, MS 39705",
 *      "Sagamore Circle Columbus MS",
 *      "Columbus MS",
 *      "39705"]
 */
function buildCandidates(address) {
  const candidates = [address];

  // Extract zip code (5-digit)
  const zipMatch = address.match(/\b(\d{5})\b/);
  const zip = zipMatch ? zipMatch[1] : null;

  // Normalise: strip apt/suite/unit noise, collapse whitespace
  const clean = address
    .replace(/\b(apt|suite|ste|unit|#)\s*[\w-]+/gi, '')
    .replace(/\s+/g, ' ')
    .trim();

  // Split on commas
  const parts = clean.split(',').map(p => p.trim()).filter(Boolean);

  if (parts.length >= 3) {
    // street + city + state  (drop zip if present in state part)
    const street = parts[0];
    const city   = parts[1];
    const state  = parts[2].replace(/\d{5}/, '').trim();
    candidates.push(`${street}, ${city}, ${state}`);
    candidates.push(`${city}, ${state}`);
  } else if (parts.length === 2) {
    candidates.push(parts.join(', '));
    candidates.push(parts[1]); // city/state alone
  }

  // Always try zip as last resort
  if (zip && !candidates.includes(zip)) candidates.push(zip);

  // Deduplicate while preserving order
  return [...new Set(candidates)];
}

async function geocode(address) {
  const candidates = buildCandidates(address);

  for (const query of candidates) {
    // Nominatim rate limit: 1 req/s — add a tiny delay between retries
    if (candidates.indexOf(query) > 0) {
      await new Promise(r => setTimeout(r, 1100));
    }

    console.log(`[Geocode] Trying: "${query}"`);
    const result = await nominatimFetch(query);

    if (result) {
      const parsed = { lat: parseFloat(result.lat), lng: parseFloat(result.lon) };
      console.log(`[Geocode] ✅ "${query}" → ${parsed.lat}, ${parsed.lng} (${result.display_name?.split(',').slice(0,3).join(',')})`);
      return parsed;
    }
  }

  console.warn(`[Geocode] ❌ All candidates failed for "${address}"`);
  return null;
}

module.exports = { geocode };
