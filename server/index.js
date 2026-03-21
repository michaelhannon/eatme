require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const { scrapeDoorDash } = require('./scrapers/doordash');
const { scrapeGrubHub, scrapeSeamless } = require('./scrapers/grubhub');
const { scrapeUberEats } = require('./scrapers/ubereats');
const { aggregate } = require('./aggregator');

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '../client')));

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Main search endpoint
app.post('/api/search', async (req, res) => {
  const {
    dish,
    address = process.env.DEFAULT_ADDRESS || '86 Horsneck Point Rd, Oceanport NJ 07757',
    platforms = ['doordash', 'grubhub', 'seamless', 'ubereats'],
    rankBy = 'totalPrice'
  } = req.body;

  if (!dish) {
    return res.status(400).json({ error: 'dish is required' });
  }

  console.log(`\n🔍 Searching for "${dish}" at "${address}"`);
  console.log(`📦 Platforms: ${platforms.join(', ')}`);

  const startTime = Date.now();

  // Credentials from environment
  const creds = {
    doordash: {
      email: process.env.DOORDASH_EMAIL,
      password: process.env.DOORDASH_PASSWORD
    },
    grubhub: {
      email: process.env.GRUBHUB_EMAIL,
      password: process.env.GRUBHUB_PASSWORD
    },
    ubereats: {
      email: process.env.UBEREATS_EMAIL,
      password: process.env.UBEREATS_PASSWORD
    }
  };

  const scraperConfig = {
    address,
    dish,
    headless: process.env.HEADLESS !== 'false',
    timeout: parseInt(process.env.SCRAPE_TIMEOUT_MS || '30000')
  };

  // Build platform jobs
  const jobs = [];

  if (platforms.includes('doordash')) {
    jobs.push(
      scrapeDoorDash({ ...scraperConfig, credentials: creds.doordash })
        .catch(err => { console.error('[DoorDash] Failed:', err.message); return []; })
    );
  }

  if (platforms.includes('grubhub')) {
    jobs.push(
      scrapeGrubHub({ ...scraperConfig, credentials: creds.grubhub })
        .catch(err => { console.error('[GrubHub] Failed:', err.message); return []; })
    );
  }

  if (platforms.includes('seamless')) {
    jobs.push(
      scrapeSeamless({ ...scraperConfig, credentials: creds.grubhub }) // Same creds as GrubHub
        .catch(err => { console.error('[Seamless] Failed:', err.message); return []; })
    );
  }

  if (platforms.includes('ubereats')) {
    jobs.push(
      scrapeUberEats({ ...scraperConfig, credentials: creds.ubereats })
        .catch(err => { console.error('[UberEats] Failed:', err.message); return []; })
    );
  }

  // Run all scrapers IN PARALLEL
  const allRawResults = await Promise.all(jobs);
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

  console.log(`✅ All scrapers done in ${elapsed}s`);

  // Aggregate and rank
  const { ranked, summary } = aggregate(allRawResults, rankBy);

  console.log(`📊 ${ranked.length} total results ranked by ${rankBy}`);

  res.json({
    dish,
    address,
    rankBy,
    elapsedSeconds: parseFloat(elapsed),
    summary,
    results: ranked
  });
});

// Serve frontend
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../client/index.html'));
});

app.listen(PORT, () => {
  console.log(`\n🚀 MenuScraper running on port ${PORT}`);
  console.log(`   http://localhost:${PORT}`);
  console.log(`   Default address: ${process.env.DEFAULT_ADDRESS || '86 Horsneck Point Rd, Oceanport NJ 07757'}`);
});
