require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const { scrapeDoorDash } = require('./scrapers/doordash');
const { scrapeGrubHub, scrapeSeamless } = require('./scrapers/grubhub');
const { scrapeUberEats } = require('./scrapers/ubereats');
const { aggregate } = require('./aggregator');

const app = express();
// Railway injects PORT — must use process.env.PORT
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '../client')));

// Health check — Railway uses this to confirm the service is up
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Main search endpoint
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

  const creds = {
    doordash:  { email: process.env.DOORDASH_EMAIL,  password: process.env.DOORDASH_PASSWORD },
    grubhub:   { email: process.env.GRUBHUB_EMAIL,   password: process.env.GRUBHUB_PASSWORD },
    ubereats:  { email: process.env.UBEREATS_EMAIL,   password: process.env.UBEREATS_PASSWORD }
  };

  const scraperConfig = {
    address,
    dish,
    lat: lat ? parseFloat(lat) : null,
    lng: lng ? parseFloat(lng) : null,
    headless: true,
    timeout: parseInt(process.env.SCRAPE_TIMEOUT_MS || '45000')
  };

  const jobs = [];
  if (platforms.includes('doordash'))  jobs.push(scrapeDoorDash({ ...scraperConfig, credentials: creds.doordash }).catch(e => { console.error('[DoorDash]', e.message); return []; }));
  if (platforms.includes('grubhub'))   jobs.push(scrapeGrubHub({ ...scraperConfig, credentials: creds.grubhub }).catch(e => { console.error('[GrubHub]', e.message); return []; }));
  if (platforms.includes('seamless'))  jobs.push(scrapeSeamless({ ...scraperConfig, credentials: creds.grubhub }).catch(e => { console.error('[Seamless]', e.message); return []; }));
  if (platforms.includes('ubereats'))  jobs.push(scrapeUberEats({ ...scraperConfig, credentials: creds.ubereats }).catch(e => { console.error('[UberEats]', e.message); return []; }));

  // All 4 scrapers run in PARALLEL
  const allRawResults = await Promise.all(jobs);
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

  console.log(`✅ Done in ${elapsed}s`);

  const { ranked, summary } = aggregate(allRawResults, rankBy);

  res.json({
    dish,
    address,
    rankBy,
    elapsedSeconds: parseFloat(elapsed),
    summary,
    results: ranked
  });
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../client/index.html'));
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n🚀 EatMe running on port ${PORT}`);
  console.log(`   Default address: ${process.env.DEFAULT_ADDRESS || '86 Horsneck Point Rd, Oceanport NJ 07757'}`);
});

// Diagnostic endpoint - tests platform connectivity + credentials
app.get('/api/test', async (req, res) => {
  const { runLoginTests } = require('./loginTest');
  const creds = {
    doordash: { email: process.env.DOORDASH_EMAIL, password: process.env.DOORDASH_PASSWORD },
    grubhub:  { email: process.env.GRUBHUB_EMAIL,  password: process.env.GRUBHUB_PASSWORD },
    ubereats: { email: process.env.UBEREATS_EMAIL,  password: process.env.UBEREATS_PASSWORD }
  };

  // Report what creds are configured (mask passwords)
  const credStatus = {
    doordash:  { email: creds.doordash.email  || 'NOT SET', passwordSet: !!creds.doordash.password },
    grubhub:   { email: creds.grubhub.email   || 'NOT SET', passwordSet: !!creds.grubhub.password },
    ubereats:  { email: creds.ubereats.email  || 'NOT SET', passwordSet: !!creds.ubereats.password }
  };

  console.log('Running login diagnostics...');
  try {
    const results = await runLoginTests(creds);
    res.json({ credStatus, browserTests: results });
  } catch (e) {
    res.json({ credStatus, error: e.message });
  }
});
