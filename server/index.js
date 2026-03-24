require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const { scrapeDoorDash } = require('./scrapers/doordash');
const { scrapeGrubHub, scrapeSeamless } = require('./scrapers/grubhub');
const { scrapeUberEats } = require('./scrapers/ubereats');
const { aggregate } = require('./aggregator');
const cache = require('./cache');
const { geocode } = require('./geocode');
const { haversine } = require('./haversine');
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
  // If coords weren't sent (user typed address manually), geocode it now.
  // Every scraper needs coordinates — no hardcoded fallbacks allowed.
  let resolvedLat = parsedLat;
  let resolvedLng = parsedLng;
  if (resolvedLat == null || resolvedLng == null) {
    console.log(`[Geocode] No coords supplied — geocoding "${address}"...`);
    const geo = await geocode(address);
    if (geo) {
      resolvedLat = geo.lat;
      resolvedLng = geo.lng;
    } else {
      console.warn('[Geocode] Failed — scraper results may be inaccurate');
    }
  }

  const geoKey = (resolvedLat != null && resolvedLng != null)
    ? geohash.encode(resolvedLat, resolvedLng, 6)
    : _addressHash(address);

  const creds = {
    doordash: { email: process.env.DOORDASH_EMAIL,  password: process.env.DOORDASH_PASSWORD },
    grubhub:  { email: process.env.GRUBHUB_EMAIL,   password: process.env.GRUBHUB_PASSWORD },
    ubereats: { email: process.env.UBEREATS_EMAIL,   password: process.env.UBEREATS_PASSWORD }
  };

  const scraperConfig = {
    address,
    dish,
    lat: resolvedLat,
    lng: resolvedLng,
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
  const allRawResults = platforms.map(p => (cachedResults[p] || freshResults[p] || []).filter(r => !r._tooFar));

  // Calculate distance for any result that has store coords but no distance yet
  if (resolvedLat && resolvedLng) {
    for (const result of allRawResults.flat()) {
      if (!result) continue;
      if (!result.distance && result.storeLat && result.storeLng) {
        const dist = haversine(resolvedLat, resolvedLng, result.storeLat, result.storeLng);
        if (dist > 15) { result._tooFar = true; continue; }
        result.distance = dist + ' mi';
      }
    }
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  const servedFromCache = bgPlatforms.length > 0;

  console.log(
    `✅ Done in ${elapsed}s` +
    (servedFromCache ? ` (${bgPlatforms.join(', ')} from cache)` : ' (all live)')
  );

  // Filter out off-topic results — restaurants where neither the name
  // nor any item name meaningfully relates to the searched dish
  // Expands cuisine keywords same as scrapers do
  const CUISINE_EXPANSIONS = {
    sushi:    ['sushi','roll','maki','sashimi','nigiri','tempura','ramen','udon','teriyaki'],
    chinese:  ['chinese','fried rice','lo mein','chow mein','dumpling','egg roll','wonton','kung pao','general tso','orange chicken'],
    indian:   ['indian','curry','tikka','masala','biryani','naan','tandoori','korma','paneer'],
    pizza:    ['pizza','pie','pepperoni','margherita','calzone'],
    burger:   ['burger','cheeseburger','hamburger'],
    chicken:  ['chicken','wings','tenders','nuggets'],
    taco:     ['taco','burrito','quesadilla','enchilada','mexican'],
    thai:     ['thai','pad thai','satay','pho'],
    pasta:    ['pasta','spaghetti','penne','fettuccine','lasagna'],
  };
  const dishLower = dish.toLowerCase();
  let relevantWords = dishLower.split(' ').filter(w => w.length > 2);
  for (const [key, words] of Object.entries(CUISINE_EXPANSIONS)) {
    if (relevantWords.some(w => key.includes(w) || w.includes(key))) {
      relevantWords = [...new Set([...relevantWords, ...words])];
      break;
    }
  }
  // Only filter if we have 8+ results (don't filter sparse result sets)
  const flatResults = allRawResults.flat().filter(Boolean);
  if (flatResults.length >= 8) {
    for (const result of flatResults) {
      if (!result) continue;
      const nameMatch = relevantWords.some(w => result.restaurant?.toLowerCase().includes(w));
      const itemLower = result.item?.toLowerCase() || '';
      // Reject verb-form "rolled" matches (sandwich descriptions)
      const verbRoll = /\broll(ed|ing|s up)\b/.test(itemLower) && !/\b(sushi|maki|spring|egg|hand|dragon|rainbow|california|spicy)\b/.test(itemLower);
      const itemMatch = !verbRoll && relevantWords.some(w => {
        const idx = itemLower.indexOf(w);
        if (idx === -1) return false;
        const before = idx === 0 || /[\s\-\/\(,]/.test(itemLower[idx-1]);
        const after  = idx + w.length >= itemLower.length || /[\s\-\/\),:!]/.test(itemLower[idx+w.length]);
        return before && after;
      });
      if (!nameMatch && !itemMatch) result._irrelevant = true;
    }
    const before = flatResults.filter(r => !r._irrelevant).length;
    // Only apply if removing irrelevant still leaves 5+ results
    const relevant = flatResults.filter(r => !r._irrelevant);
    if (relevant.length >= 5) {
      allRawResults.forEach((arr, i) => {
        allRawResults[i] = arr.filter(r => !r?._irrelevant);
      });
      console.log(`[Filter] Removed ${flatResults.length - relevant.length} off-topic results`);
    }
  }

  // Filter out results beyond 15 miles based on distance string
  const filteredResults = allRawResults.map(arr =>
    arr.filter(r => {
      if (!r || !r.distance) return true;
      const miles = parseFloat(r.distance);
      return isNaN(miles) || miles <= 15;
    })
  );
  const { ranked, summary } = aggregate(filteredResults, rankBy);

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
// Streaming search endpoint — Server-Sent Events for live platform status
// ---------------------------------------------------------------------------
app.get('/api/search/stream', async (req, res) => {
  const {
    dish,
    address = process.env.DEFAULT_ADDRESS || '86 Horsneck Point Rd, Oceanport NJ 07757',
    platforms: platformsParam = 'doordash,grubhub,seamless,ubereats',
    rankBy = 'totalPrice',
    lat, lng
  } = req.query;

  if (!dish) { res.status(400).end(); return; }

  const platforms = platformsParam.split(',').filter(Boolean);

  // Set up SSE
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const send = (event, data) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  const startTime = Date.now();

  // Geocode if needed
  let resolvedLat = lat ? parseFloat(lat) : null;
  let resolvedLng = lng ? parseFloat(lng) : null;
  if (resolvedLat == null || resolvedLng == null) {
    const geo = await geocode(address);
    if (geo) { resolvedLat = geo.lat; resolvedLng = geo.lng; }
  }

  const geoKey = (resolvedLat != null && resolvedLng != null)
    ? geohash.encode(resolvedLat, resolvedLng, 6)
    : _addressHash(address);

  const creds = {
    doordash: { email: process.env.DOORDASH_EMAIL, password: process.env.DOORDASH_PASSWORD },
    grubhub:  { email: process.env.GRUBHUB_EMAIL,  password: process.env.GRUBHUB_PASSWORD },
    ubereats: { email: process.env.UBEREATS_EMAIL,  password: process.env.UBEREATS_PASSWORD }
  };

  const scraperConfig = {
    address, dish,
    lat: resolvedLat, lng: resolvedLng,
    headless: true,
    timeout: parseInt(process.env.SCRAPE_TIMEOUT_MS || '45000'),
    credentials: null
  };

  const allRawResults = Array(platforms.length).fill([]);

  // Send initial status for all platforms
  platforms.forEach(p => send('platform_start', { platform: p }));

  // Run each platform and stream results as they complete
  await Promise.all(platforms.map(async (p, idx) => {
    const cacheKey = cache.buildKey(p, geoKey, dish);
    let results = [];

    // Check cache first
    const cached = await cache.get(cacheKey);
    if (cached) {
      results = cached.results;
      send('platform_done', { platform: p, count: results.length, fromCache: true });
    } else {
      const cfg = { ...scraperConfig, credentials: creds[p === 'seamless' ? 'grubhub' : p] || {} };
      results = await runAndCache(p, cfg, cacheKey);
      send('platform_done', { platform: p, count: results.length, fromCache: false });
    }

    allRawResults[idx] = results;
  }));

  // Apply distance calculation
  if (resolvedLat && resolvedLng) {
    for (const result of allRawResults.flat()) {
      if (!result) continue;
      if (!result.distance && result.storeLat && result.storeLng) {
        const dist = haversine(resolvedLat, resolvedLng, result.storeLat, result.storeLng);
        if (dist > 15) { result._tooFar = true; continue; }
        result.distance = dist + ' mi';
      }
    }
  }

  // Apply relevance filter
  const CUISINE_EXPANSIONS = {
    sushi:    ['sushi','roll','maki','sashimi','nigiri','tempura','ramen','udon','teriyaki'],
    chinese:  ['chinese','fried rice','lo mein','chow mein','dumpling','egg roll','wonton','kung pao','general tso','orange chicken'],
    indian:   ['indian','curry','tikka','masala','biryani','naan','tandoori','korma','paneer'],
    pizza:    ['pizza','pie','pepperoni','margherita','calzone'],
    burger:   ['burger','cheeseburger','hamburger'],
    chicken:  ['chicken','wings','tenders','nuggets'],
    taco:     ['taco','burrito','quesadilla','enchilada','mexican'],
    thai:     ['thai','pad thai','satay','pho'],
    pasta:    ['pasta','spaghetti','penne','fettuccine','lasagna'],
  };
  const dishLower = dish.toLowerCase();
  let relevantWords = dishLower.split(' ').filter(w => w.length > 2);
  for (const [key, words] of Object.entries(CUISINE_EXPANSIONS)) {
    if (relevantWords.some(w => key.includes(w) || w.includes(key))) {
      relevantWords = [...new Set([...relevantWords, ...words])]; break;
    }
  }
  const flatResults = allRawResults.flat().filter(Boolean);
  if (flatResults.length >= 8) {
    flatResults.forEach(result => {
      const nameMatch = relevantWords.some(w => result.restaurant?.toLowerCase().includes(w));
      const itemLower = result.item?.toLowerCase() || '';
      const verbRoll = /\broll(ed|ing|s up)\b/.test(itemLower) && !/\b(sushi|maki|spring|egg|hand|dragon|rainbow|california|spicy)\b/.test(itemLower);
      const itemMatch = !verbRoll && relevantWords.some(w => { const idx = itemLower.indexOf(w); if (idx === -1) return false; const before = idx === 0 || /[\s\-\/\(,]/.test(itemLower[idx-1]); const after = idx + w.length >= itemLower.length || /[\s\-\/\),:!]/.test(itemLower[idx+w.length]); return before && after; });
      if (!nameMatch && !itemMatch) result._irrelevant = true;
    });
    const relevant = flatResults.filter(r => !r._irrelevant);
    if (relevant.length >= 5) {
      allRawResults.forEach((arr, i) => { allRawResults[i] = arr.filter(r => !r?._irrelevant); });
    }
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  // Filter out results beyond 15 miles based on distance string
  const filteredResults = allRawResults.map(arr =>
    arr.filter(r => {
      if (!r || !r.distance) return true;
      const miles = parseFloat(r.distance);
      return isNaN(miles) || miles <= 15;
    })
  );
  const { ranked, summary } = aggregate(filteredResults, rankBy);

  send('complete', { dish, address, rankBy, elapsedSeconds: parseFloat(elapsed), summary, results: ranked });
  res.end();
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
