const https = require('https');

// Uber Eats internal API - no browser needed
// These are the same endpoints the Uber Eats website calls

function httpGet(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const opts = {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        'Accept': 'application/json',
        'x-csrf-token': 'x',
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
        'x-csrf-token': 'x',
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

async function scrapeUberEats({ address, dish, credentials, headless = true, timeout = 45000 }) {
  const results = [];
  
  try {
    // Step 1: Geocode the address using Uber Eats location API
    console.log(`[UberEats] Geocoding address...`);
    const geoUrl = `https://www.ubereats.com/api/getLocationAutocompleteV1?localeCode=en-US`;
    const geoRes = await httpPost(geoUrl, {
      query: address,
      supportedTypes: ['place', 'address']
    });
    
    let lat, lng;
    if (geoRes.body?.data?.suggestions?.[0]) {
      const suggestion = geoRes.body.data.suggestions[0];
      // Need to resolve the suggestion to get lat/lng
      const resolveUrl = `https://www.ubereats.com/api/getLocationDetailsV1?localeCode=en-US`;
      const resolveRes = await httpPost(resolveUrl, {
        provider: suggestion.provider,
        providerId: suggestion.providerId
      });
      lat = resolveRes.body?.data?.latitude;
      lng = resolveRes.body?.data?.longitude;
    }
    
    // Fallback to known coordinates for Oceanport NJ
    if (!lat || !lng) {
      console.log(`[UberEats] Using fallback coordinates for Oceanport NJ`);
      lat = 40.32098388;
      lng = -74.02689362;
    }
    
    console.log(`[UberEats] Coordinates: ${lat}, ${lng}`);

    // Step 2: Search for restaurants
    const searchUrl = `https://www.ubereats.com/api/getFeedV1?localeCode=en-US`;
    const searchRes = await httpPost(searchUrl, {
      userQuery: dish,
      location: { latitude: lat, longitude: lng },
      pagination: { pageToken: '' },
      targetLocation: { latitude: lat, longitude: lng, reference: address, referenceType: 'mapPin' }
    });

    const feedItems = searchRes.body?.data?.feedItems || [];
    const stores = feedItems
      .filter(i => i.type === 'regularStore' || i.store)
      .slice(0, 8)
      .map(i => ({
        uuid: i.store?.storeUuid || i.uuid,
        name: i.store?.title?.text || i.title?.text,
        rating: i.store?.rating?.ratingValue,
        eta: i.store?.etaRange?.text || i.store?.eta?.text,
        deliveryFee: i.store?.fareInfo?.serviceFee === 0 ? 0 : i.store?.fareInfo?.serviceFee
      }))
      .filter(s => s.uuid && s.name);

    console.log(`[UberEats] Found ${stores.length} stores via API`);

    // Step 3: For each store, search their menu
    for (const store of stores) {
      try {
        const menuUrl = `https://www.ubereats.com/api/getStoreV1?localeCode=en-US`;
        const menuRes = await httpPost(menuUrl, {
          storeUuid: store.uuid,
          userQuery: dish
        });

        const menuData = menuRes.body?.data;
        const sections = menuData?.sections || menuData?.catalogSectionsMap ? 
          Object.values(menuData.catalogSectionsMap || {}).flat() : [];
        
        const dishWords = dish.toLowerCase().split(' ').filter(w => w.length > 2);
        const items = [];

        // Search through menu items
        const allItems = sections.flatMap(s => s.items || s.catalogItems || []);
        for (const item of allItems) {
          const title = item.title || item.name || '';
          if (dishWords.some(w => title.toLowerCase().includes(w))) {
            const price = item.price ? item.price / 100 : (item.itemPrice?.amount ? item.itemPrice.amount / 100 : null);
            if (price && price > 1 && price < 150) {
              items.push({ name: title, price: parseFloat(price.toFixed(2)) });
            }
          }
          if (items.length >= 4) break;
        }

        const deliveryFee = store.deliveryFee ?? (menuData?.fareInfo?.serviceFee === 0 ? 0 : menuData?.fareInfo?.serviceFee ?? null);
        console.log(`[UberEats] ${store.name}: ${items.length} items, fee: $${deliveryFee}, eta: ${store.eta}`);

        if (items.length > 0) {
          items.forEach(item => {
            const total = deliveryFee != null ? parseFloat((item.price + deliveryFee).toFixed(2)) : null;
            results.push({ platform: 'Uber Eats', restaurant: store.name, item: item.name, itemPrice: item.price, deliveryFee, totalPrice: total, rating: store.rating, eta: store.eta, url: `https://www.ubereats.com/store/${store.uuid}` });
          });
        }
      } catch(e) {
        console.log(`[UberEats] Menu failed ${store.name}: ${e.message}`);
      }
    }

    // If API approach didn't work well, fall back to Playwright
    if (results.length === 0) {
      console.log(`[UberEats] API returned 0 results, falling back to browser scraper`);
      return await scrapeUberEatsBrowser({ address, dish, timeout });
    }

  } catch(e) {
    console.log(`[UberEats] API error: ${e.message}, falling back to browser`);
    return await scrapeUberEatsBrowser({ address, dish, timeout });
  }

  console.log(`[UberEats] Done: ${results.length} results`);
  return results;
}

// Browser fallback (original working approach)
async function scrapeUberEatsBrowser({ address, dish, timeout = 45000 }) {
  const { chromium } = require('playwright');
  console.log(`[UberEats] Using browser fallback...`);

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-blink-features=AutomationControlled']
  });

  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 800 },
    locale: 'en-US',
    extraHTTPHeaders: { 'Accept-Language': 'en-US,en;q=0.9' }
  });

  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });

  const page = await context.newPage();
  const results = [];

  try {
    await page.goto('https://www.ubereats.com', { waitUntil: 'domcontentloaded', timeout });
    await page.waitForTimeout(2500);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(500);

    await page.waitForFunction(() => {
      return Array.from(document.querySelectorAll('input[type="text"], input:not([type])'))
        .some(i => i.offsetWidth > 0 && i.offsetHeight > 0);
    }, { timeout: 10000 }).catch(() => {});

    const inputHandle = await page.evaluateHandle(() =>
      Array.from(document.querySelectorAll('input[type="text"], input:not([type])'))
        .find(i => i.offsetWidth > 0 && i.offsetHeight > 0) || null
    );
    const addressInput = inputHandle.asElement();

    if (addressInput) {
      await addressInput.click({ force: true });
      await addressInput.fill('');
      await addressInput.type(address, { delay: 50 });
      await page.waitForTimeout(2000);
      await page.waitForSelector('li[role="option"]', { timeout: 5000 }).catch(() => {});
      const suggestion = await page.$('li[role="option"]:first-child');
      if (suggestion) await suggestion.click({ force: true });
      else { await page.keyboard.press('ArrowDown'); await page.waitForTimeout(300); await page.keyboard.press('Enter'); }
      await page.waitForTimeout(2000);
      const confirmBtn = await page.$('button:has-text("Deliver here"), button:has-text("Confirm")');
      if (confirmBtn) { await confirmBtn.click({ force: true }); await page.waitForTimeout(800); }
    }

    await page.goto(`https://www.ubereats.com/search?q=${encodeURIComponent(dish)}`, { waitUntil: 'domcontentloaded', timeout });
    await page.waitForTimeout(3500);
    await page.waitForSelector('[data-testid="store-card"], a[href*="/store/"]', { timeout: 12000 }).catch(() => {});

    const rawCards = await page.evaluate(() => {
      const seen = new Set();
      const out = [];
      const cards = document.querySelectorAll('[data-testid="store-card"]');
      for (const card of cards) {
        const link = card.querySelector('a[href*="/store/"]');
        const href = link?.getAttribute('href');
        if (!href || seen.has(href)) continue;
        seen.add(href);
        const fullText = card.innerText || '';
        const lines = fullText.split('\n').map(l => l.trim()).filter(l => l.length > 0);
        const name = lines[0];
        if (!name || name.length < 2) continue;
        const ratingLine = lines.find(l => /^[45]\.\d$/.test(l));
        const etaMatch = fullText.match(/(\d+[\s\u2013\-]+\d+\s*min|\d+\s*min)/i);
        out.push({ href, name, ratingLine, eta: etaMatch ? etaMatch[1].trim() : null });
        if (out.length >= 6) break;
      }
      return out;
    });

    const storeData = rawCards.map(card => ({ name: card.name, href: card.href, rating: card.ratingLine ? parseFloat(card.ratingLine) : null, eta: card.eta }));

    for (const store of storeData) {
      try {
        const storeUrl = store.href.startsWith('http') ? store.href : `https://www.ubereats.com${store.href}`;
        const storePage = await context.newPage();
        await storePage.goto(storeUrl, { waitUntil: 'domcontentloaded', timeout: 12000 });
        await storePage.waitForTimeout(2500);

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
        if (data.items.length > 0) {
          data.items.forEach(item => {
            const total = data.deliveryFee != null ? parseFloat((item.price + data.deliveryFee).toFixed(2)) : null;
            results.push({ platform: 'Uber Eats', restaurant: store.name, item: item.name, itemPrice: item.price, deliveryFee: data.deliveryFee, totalPrice: total, rating: store.rating, eta: store.eta, url: `https://www.ubereats.com${store.href}` });
          });
        }
      } catch(e) {
        console.log(`[UberEats] Store failed ${store.name}: ${e.message.split('\n')[0]}`);
      }
    }
  } catch(e) {
    console.error('[UberEats] Browser error:', e.message.split('\n')[0]);
  } finally {
    await browser.close();
  }

  console.log(`[UberEats] Browser done: ${results.length} results`);
  return results;
}

module.exports = { scrapeUberEats };
