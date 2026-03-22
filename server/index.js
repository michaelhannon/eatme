require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const { scrapeDoorDash } = require('./scrapers/doordash');
const { scrapeGrubHub, scrapeSeamless } = require('./scrapers/grubhub');
const { scrapeUberEats } = require('./scrapers/ubereats');
const { aggregate } = require('./aggregator');
const cache = require('./cache');
const geohash = require('./geohash');

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '../client')));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Map platform name → scraper function */
function getScraper(platform) {
  switch (platform) {
    case 'doordash': return scrapeDoorDash;
    case 'grubhub':  return scrapeGrubHub;
    case 'seamless': return scrapeSeamless;
    case 'ubereats': return scrapeUberEats;
    default: return null;
  }
}

/**
 * Run a single platform scraper and cache the results.
 * Returns the raw results array (may be empty on failure).
 */
async function runAndCache(platform, scraperConfig, cacheKey) {
  const scraper = getScraper(platform);
  if (!scraper) return [];
  try {
    const results = await scraper(scraperConfig);
    // Fire-and-forget cache write — don't let a Redis hiccup delay the response
    cache.set(cacheKey, results).catch(() => {});
    return results;
  } catch (err) {
    console.error(`[${platform}] scraper error:`, err.message);
    return [];
  }
}

// ---------------------------------------------------------------------------
// Health check
// ---------------------------------------------------------------------------
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ---------------------------------------------------------------------------
// Main search endpoint — stale-while-revalidate per platform
// ---------------------------------------------------------------------------
app.post('/api/search', async (req, res) => {
  const {
    dish,
    address = process.env.DEFAULT_ADDRESS || '86 Horsneck Point Rd, Oceanport NJ 07757',
    platforms = ['doordash', 'grubhub', 'seamless', 'ubereats'],
    rankBy = 'totalPrice',
    lat,
    lng
  } = req.body;

  if (!dish) {
    return res.status(400).json({ error: 'dish is required' });
  }

  console.log(`\n🔍 Searching for "${dish}" at "${address}"`);
  console.log(`📦 Platforms: ${platforms.join(', ')}`);

  const startTime = Date.now();

  // Geohash the delivery location for the cache key.
  // Fall back to a hash of the address string when coords are missing.
  const parsedLat = lat ? parseFloat(lat) : null;
  const parsedLng = lng ? parseFloat(lng) : null;
  const geoKey = (parsedLat != null && parsedLng != null)
    ? geohash.encode(parsedLat, parsedLng, 6)
    : _addressHash(address);

  const creds = {
    doordash: { email: process.env.DOORDASH_EMAIL,  password: process.env.DOORDASH_PASSWORD },
    grubhub:  { email: process.env.GRUBHUB_EMAIL,   password: process.env.GRUBHUB_PASSWORD },
    ubereats: { email: process.env.UBEREATS_EMAIL,   password: process.env.UBEREATS_PASSWORD }
  };

  const scraperConfig = {
    address,
    dish,
    lat: parsedLat,
    lng: parsedLng,
    headless: true,
    timeout: parseInt(process.env.SCRAPE_TIMEOUT_MS || '45000'),
    credentials: null // set per-platform below
  };

  // -------------------------------------------------------------------------
  // Phase 1: check cache for every requested platform in parallel
  // -------------------------------------------------------------------------
  const cacheKeys = {};
  for (const p of platforms) {
    cacheKeys[p] = cache.buildKey(p, geoKey, dish);
  }

  const cacheChecks = await Promise.all(
    platforms.map(async (p) => ({ platform: p, entry: await cache.get(cacheKeys[p]) }))
  );

  const cachedResults  = {};   // platform -> results[] (served immediately)
  const stalePlatforms = [];   // platforms that need a live scrape now
  const bgPlatforms    = [];   // platforms that are cached but will be refreshed in background

  for (const { platform, entry } of cacheChecks) {
    if (entry) {
      // Cache hit — use it now, refresh silently in background
      cachedResults[platform] = entry.results;
      bgPlatforms.push(platform);
      console.log(`[Cache] Using cached results for ${platform}`);
    } else {
      // Cache miss — must scrape synchronously before responding
      stalePlatforms.push(platform);
    }
  }

  // -------------------------------------------------------------------------
  // Phase 2: live-scrape cache-miss platforms (still parallel)
  // -------------------------------------------------------------------------
  const freshResults = {};

  if (stalePlatforms.length > 0) {
    console.log(`🔄 Live-scraping: ${stalePlatforms.join(', ')}`);
    const scrapeJobs = stalePlatforms.map(async (p) => {
      const cfg = {
        ...scraperConfig,
        credentials: creds[p === 'seamless' ? 'grubhub' : p] || {}
      };
      const results = await runAndCache(p, cfg, cacheKeys[p]);
      freshResults[p] = results;
    });
    await Promise.all(scrapeJobs);
  }

  // -------------------------------------------------------------------------
  // Phase 3: assemble response from cached + fresh results
  // -------------------------------------------------------------------------
  const allRawResults = platforms.map(p => cachedResults[p] || freshResults[p] || []);

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  const servedFromCache = bgPlatforms.length > 0;

  console.log(
    `✅ Done in ${elapsed}s` +
    (servedFromCache ? ` (${bgPlatforms.join(', ')} from cache)` : ' (all live)')
  );

  const { ranked, summary } = aggregate(allRawResults, rankBy);

  res.json({
    dish,
    address,
    rankBy,
    elapsedSeconds: parseFloat(elapsed),
    servedFromCache,
    cachedPlatforms: bgPlatforms,
    summary,
    results: ranked
  });

  // -------------------------------------------------------------------------
  // Phase 4: background re-scrape for cached platforms (fires AFTER response)
  // -------------------------------------------------------------------------
  if (bgPlatforms.length > 0) {
    console.log(`🔄 Background re-scrape queued for: ${bgPlatforms.join(', ')}`);
    setImmediate(() => {
      bgPlatforms.forEach((p) => {
        const cfg = {
          ...scraperConfig,
          credentials: creds[p === 'seamless' ? 'grubhub' : p] || {}
        };
        runAndCache(p, cfg, cacheKeys[p]).catch((err) =>
          console.error(`[bg-scrape][${p}] error:`, err.message)
        );
      });
    });
  }
});

// ---------------------------------------------------------------------------
// Static / fallback
// ---------------------------------------------------------------------------
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../client/index.html'));
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n🚀 EatMe running on port ${PORT}`);
  console.log(`   Default address: ${process.env.DEFAULT_ADDRESS || '86 Horsneck Point Rd, Oceanport NJ 07757'}`);
});

// ---------------------------------------------------------------------------
// Diagnostic endpoint
// ---------------------------------------------------------------------------
app.get('/api/test', async (req, res) => {
  const { runLoginTests } = require('./loginTest');
  const creds = {
    doordash: { email: process.env.DOORDASH_EMAIL, password: process.env.DOORDASH_PASSWORD },
    grubhub:  { email: process.env.GRUBHUB_EMAIL,  password: process.env.GRUBHUB_PASSWORD },
    ubereats: { email: process.env.UBEREATS_EMAIL,  password: process.env.UBEREATS_PASSWORD }
  };
  const credStatus = {
    doordash: { email: creds.doordash.email || 'NOT SET', passwordSet: !!creds.doordash.password },
    grubhub:  { email: creds.grubhub.email  || 'NOT SET', passwordSet: !!creds.grubhub.password },
    ubereats: { email: creds.ubereats.email || 'NOT SET', passwordSet: !!creds.ubereats.password }
  };
  console.log('Running login diagnostics...');
  try {
    const results = await runLoginTests(creds);
    res.json({ credStatus, browserTests: results });
  } catch (e) {
    res.json({ credStatus, error: e.message });
  }
});

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Fallback geo-key when lat/lng are not available.
 * Produces a short stable string from the address.
 */
function _addressHash(address) {
  let h = 0;
  for (let i = 0; i < address.length; i++) {
    h = ((h << 5) - h) + address.charCodeAt(i);
    h |= 0;
  }
  return 'addr_' + Math.abs(h).toString(36);
}
