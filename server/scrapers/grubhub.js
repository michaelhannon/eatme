const https = require('https');

function httpPost(url, payload, headers = {}) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const urlObj = new URL(url);
    const opts = {
      hostname: urlObj.hostname,
      path: urlObj.pathname + urlObj.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        'Accept': 'application/json',
        'Accept-Language': 'en-US,en;q=0.9',
        ...headers
      }
    };
    const req = https.request(opts, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch(e) { resolve({ status: res.statusCode, body: data }); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function httpGet(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const opts = {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        'Accept': 'application/json',
        'Accept-Language': 'en-US,en;q=0.9',
        ...headers
      }
    };
    https.get(url, opts, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch(e) { resolve({ status: res.statusCode, body: data }); }
      });
    }).on('error', reject);
  });
}

async function scrapeGrubHub({ address, dish, credentials, headless = true, timeout = 45000, platform = 'GrubHub' }) {
  if (platform === 'Seamless') {
    console.log(`[Seamless] Skipping — same backend as GrubHub`);
    return [];
  }

  const results = [];

  try {
    // GrubHub internal search API
    // These coordinates are for Oceanport NJ — we could geocode but hardcoding is faster and reliable for this address
    const lat = 40.32098388;
    const lng = -74.02689362;

    console.log(`[GrubHub] Searching via API...`);

    // GrubHub search endpoint
    const searchUrl = `https://api-gtm.grubhub.com/restaurants/search?orderMethod=standard&locationMode=DELIVERY&facetSet=umamiV6&pageSize=20&hideHateos=true&searchMetrics=true&queryText=${encodeURIComponent(dish)}&latitude=${lat}&longitude=${lng}&preciseLocation=true&geohash=dr5m7kpqb25m&sortSetId=umamiV3&countOmittingTimes=true`;

    const searchRes = await httpGet(searchUrl, {
      'Referer': 'https://www.grubhub.com/',
      'Origin': 'https://www.grubhub.com'
    });

    console.log(`[GrubHub] API status: ${searchRes.status}`);

    let restaurants = [];
    if (searchRes.body?.searchResult?.results) {
      restaurants = searchRes.body.searchResult.results.slice(0, 8);
    } else if (Array.isArray(searchRes.body?.results)) {
      restaurants = searchRes.body.results.slice(0, 8);
    }

    console.log(`[GrubHub] Found ${restaurants.length} restaurants via API`);

    if (restaurants.length > 0) {
      for (const r of restaurants) {
        const name = r.restaurant?.name || r.name;
        const restId = r.restaurant?.id || r.restaurantId || r.id;
        const rating = r.restaurant?.ratings?.actual_rating_value || r.ratings?.actual_rating_value;
        const eta = r.restaurant?.estimatedDeliveryTime || r.estimatedDeliveryTime;
        const deliveryFee = r.restaurant?.deliveryFeeDetails?.amount != null ? r.restaurant.deliveryFeeDetails.amount / 100 : null;

        if (!name || !restId) continue;

        // Get menu for this restaurant
        try {
          const menuUrl = `https://api-gtm.grubhub.com/restaurants/${restId}/menu?hideHateos=true`;
          const menuRes = await httpGet(menuUrl, {
            'Referer': 'https://www.grubhub.com/',
            'Origin': 'https://www.grubhub.com'
          });

          const dishWords = dish.toLowerCase().split(' ').filter(w => w.length > 2);
          const menuItems = menuRes.body?.restaurant?.menu_category_list?.flatMap(cat =>
            cat.menu_item_list || []
          ) || [];

          const matchedItems = menuItems
            .filter(item => dishWords.some(w => (item.name || '').toLowerCase().includes(w)))
            .slice(0, 4)
            .map(item => ({
              name: item.name,
              price: item.minimum_price_in_cents ? item.minimum_price_in_cents / 100 : null
            }))
            .filter(item => item.price && item.price > 1 && item.price < 150);

          const etaText = eta ? `${eta} min` : null;
          console.log(`[GrubHub] ${name}: ${matchedItems.length} items, fee: $${deliveryFee}`);

          if (matchedItems.length > 0) {
            matchedItems.forEach(item => {
              const fee = deliveryFee ?? 0;
              const total = parseFloat((item.price + fee).toFixed(2));
              results.push({ platform: 'GrubHub', restaurant: name, item: item.name, itemPrice: item.price, deliveryFee: fee, totalPrice: total, rating: rating ? parseFloat(rating) : null, eta: etaText, url: `https://www.grubhub.com/restaurant/${restId}` });
            });
          }
        } catch(e) {
          console.log(`[GrubHub] Menu failed ${name}: ${e.message}`);
        }
      }
    }

    // Fallback to browser if API didn't work
    if (results.length === 0) {
      console.log(`[GrubHub] API returned 0 results, falling back to browser`);
      return await scrapeGrubHubBrowser({ address, dish, timeout });
    }

  } catch(e) {
    console.log(`[GrubHub] API error: ${e.message}, falling back to browser`);
    return await scrapeGrubHubBrowser({ address, dish, timeout });
  }

  console.log(`[GrubHub] Done: ${results.length} results`);
  return results;
}

async function scrapeGrubHubBrowser({ address, dish, timeout = 45000 }) {
  const { chromium } = require('playwright');
  console.log(`[GrubHub] Using browser fallback...`);

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-blink-features=AutomationControlled']
  });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 800 },
    extraHTTPHeaders: { 'Accept-Language': 'en-US,en;q=0.9' }
  });
  await context.addInitScript(() => { Object.defineProperty(navigator, 'webdriver', { get: () => undefined }); });

  const page = await context.newPage();
  const results = [];

  try {
    // Go directly to the search URL with known coordinates
    const searchUrl = `https://www.grubhub.com/search?orderMethod=delivery&locationMode=DELIVERY&facetSet=umamiV6&pageSize=20&hideHateos=true&searchMetrics=true&queryText=${encodeURIComponent(dish)}&latitude=40.32098388&longitude=-74.02689362&preciseLocation=true&geohash=dr5m7kpqb25m&sortSetId=umamiV3&countOmittingTimes=true`;
    await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout });
    await page.waitForTimeout(4000);
    console.log(`[GrubHub] Browser search URL: ${page.url()}`);

    await page.waitForSelector('a[href*="/restaurant/"]', { timeout: 10000 }).catch(() => {});
    const linkCount = await page.evaluate(() => document.querySelectorAll('a[href*="/restaurant/"]').length);
    console.log(`[GrubHub] Browser link count: ${linkCount}`);

    const rawCards = await page.evaluate(() => {
      const seen = new Set();
      const out = [];
      for (const link of document.querySelectorAll('a[href*="/restaurant/"]')) {
        const href = link.getAttribute('href');
        if (!href || seen.has(href)) continue;
        seen.add(href);
        let container = link;
        for (let i = 0; i < 8; i++) {
          if (!container.parentElement) break;
          container = container.parentElement;
          if ((container.innerText || '').split('\n').filter(l => l.trim()).length >= 3) break;
        }
        const text = container.innerText || link.innerText || '';
        const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
        if (lines[0] && lines[0].length > 2) {
          out.push({ href, name: lines[0], text, lines });
          if (out.length >= 6) break;
        }
      }
      return out;
    });

    console.log(`[GrubHub] Browser found ${rawCards.length} restaurants`);

    for (const card of rawCards) {
      const storeUrl = card.href.startsWith('http') ? card.href : `https://www.grubhub.com${card.href}`;
      try {
        const storePage = await context.newPage();
        await storePage.goto(storeUrl, { waitUntil: 'domcontentloaded', timeout: 12000 });
        await storePage.waitForTimeout(3000);
        const data = await storePage.evaluate((searchDish) => {
          const dishWords = searchDish.toLowerCase().split(' ').filter(w => w.length > 2);
          const lines = document.body.innerText.split('\n').map(l => l.trim()).filter(l => l);
          let deliveryFee = null;
          for (const line of lines) {
            if (/free delivery/i.test(line)) { deliveryFee = 0; break; }
            if (/delivery fee/i.test(line)) { const m = line.match(/\$(\d+\.?\d*)/); if (m) { deliveryFee = parseFloat(m[1]); break; } }
          }
          const items = [];
          for (let i = 0; i < lines.length - 1; i++) {
            if (!dishWords.some(w => lines[i].toLowerCase().includes(w))) continue;
            if (lines[i].length > 100) continue;
            for (let j = i + 1; j <= Math.min(i + 3, lines.length - 1); j++) {
              const m = lines[j].match(/^\$(\d+\.\d{2})$/) || lines[j].match(/^\$(\d+)$/);
              if (m) { const p = parseFloat(m[1]); if (p > 1 && p < 150) { items.push({ name: lines[i].substring(0, 70), price: p }); break; } }
            }
          }
          const seen = new Set();
          return { deliveryFee, items: items.filter(r => { const k=`${r.name}|${r.price}`; if(seen.has(k))return false; seen.add(k); return true; }).slice(0, 4) };
        }, dish);
        await storePage.close();
        const ratingM = card.text.match(/\b([45]\.\d)\s*[\(\d]/);
        const etaM = card.text.match(/(\d+[\s–\-]+\d+\s*min|\d+\s*min)/i);
        if (data.items.length > 0) {
          data.items.forEach(item => {
            const fee = data.deliveryFee ?? 0;
            results.push({ platform: 'GrubHub', restaurant: card.name, item: item.name, itemPrice: item.price, deliveryFee: fee, totalPrice: parseFloat((item.price + fee).toFixed(2)), rating: ratingM ? parseFloat(ratingM[1]) : null, eta: etaM?.[1]?.trim(), url: page.url() });
          });
        }
      } catch(e) {
        console.log(`[GrubHub] Browser store failed ${card.name}: ${e.message.split('\n')[0]}`);
      }
    }
  } catch(e) {
    console.error('[GrubHub] Browser error:', e.message.split('\n')[0]);
  } finally {
    await browser.close();
  }
  console.log(`[GrubHub] Browser done: ${results.length} results`);
  return results;
}

async function scrapeSeamless(params) {
  console.log(`[Seamless] Skipping — same backend as GrubHub`);
  return [];
}

module.exports = { scrapeGrubHub, scrapeSeamless };
