const { chromium } = require('playwright');
const { fetchStoreItems } = require('./grubhub');

async function scrapeUberEats({ address, dish, credentials, headless = true, timeout = 45000, lat, lng }) {
  const browser = await chromium.launch({
    headless,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-blink-features=AutomationControlled']
  });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 800 },
    locale: 'en-US',
    extraHTTPHeaders: { 'Accept-Language': 'en-US,en;q=0.9' }
  });
  await context.addInitScript(() => { Object.defineProperty(navigator, 'webdriver', { get: () => undefined }); });

  const page = await context.newPage();
  const results = [];

  try {
    // Use coordinates if provided, otherwise fall back to address UI
    const useLat = lat || 40.32099;
    const useLng = lng || -74.0269;

    if (lat && lng) {
      console.log(`[UberEats] Using provided coordinates: ${lat}, ${lng}`);
    } else {
      console.log(`[UberEats] No coordinates provided, using address fallback`);
    }

    // Encode location into Uber Eats pl param — bypasses address UI entirely
    const plObj = {
      address: address,
      referenceType: 'mapPin',
      latitude: useLat,
      longitude: useLng
    };
    const pl = Buffer.from(JSON.stringify(plObj)).toString('base64url');

    const searchUrl = `https://www.ubereats.com/search?q=${encodeURIComponent(dish)}&pl=${pl}&diningMode=DELIVERY`;
    console.log(`[UberEats] Searching with location: ${useLat}, ${useLng}`);
    await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout });
    await page.waitForTimeout(3500);
    console.log(`[UberEats] Search URL: ${page.url()}`);

    await page.waitForSelector('[data-testid="store-card"], a[href*="/store/"]', { timeout: 10000 }).catch(() => {});

    const rawCards = await page.evaluate(() => {
      const seen = new Set();
      const out = [];
      for (const card of document.querySelectorAll('[data-testid="store-card"]')) {
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
        out.push({ href, name, ratingLine, eta: etaMatch?.[1]?.trim() || null, deliveryFee: null });
        if (out.length >= 8) break;
      }
      return out;
    });

    console.log(`[UberEats] Found ${rawCards.length} store cards`);

    const storeData = rawCards.map(card => ({
      name: card.name, href: card.href,
      rating: card.ratingLine ? parseFloat(card.ratingLine) : null,
      eta: card.eta, deliveryFee: null
    }));

    const CONCURRENCY = 5;
    for (let i = 0; i < storeData.length; i += CONCURRENCY) {
      const batch = storeData.slice(i, i + CONCURRENCY);
      const batchResults = await Promise.all(batch.map(store => fetchStoreItems(context, store, dish, 'UberEats', 'https://www.ubereats.com')));
      batchResults.forEach(({ store, items, deliveryFee }) => {
        if (items.length > 0) {
          items.forEach(item => {
            const fee = deliveryFee ?? 0;
            results.push({ platform: 'Uber Eats', restaurant: store.name, item: item.name, itemPrice: item.price, deliveryFee: fee, totalPrice: parseFloat((item.price + fee).toFixed(2)), rating: store.rating, eta: store.eta, url: `https://www.ubereats.com${store.href}` });
          });
        }
      });
    }

  } catch(e) {
    console.error('[UberEats] Error:', e.message.split('\n')[0]);
  } finally {
    await browser.close();
  }
  console.log(`[UberEats] Done: ${results.length} results`);
  return results;
}

module.exports = { scrapeUberEats };
