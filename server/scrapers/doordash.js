/**
 * DoorDash scraper — network interception approach.
 *
 * Instead of parsing the DOM (which breaks constantly and fights Cloudflare),
 * we intercept DoorDash's own internal API responses as they load.
 * The browser navigates normally; we just eavesdrop on the JSON it receives.
 *
 * Requires: PROXY_HOST / PROXY_PORT / PROXY_USER / PROXY_PASS env vars.
 * Requires: lat + lng for the delivery address (geocoded upstream in index.js).
 */

const { chromium } = require('playwright');

function getProxyConfig() {
  const host = process.env.PROXY_HOST;
  const port = process.env.PROXY_PORT;
  const user = process.env.PROXY_USER;
  const pass = process.env.PROXY_PASS;
  if (!host || !port) return null;
  return { server: `http://${host}:${port}`, username: user, password: pass };
}

async function scrapeDoorDash({ address, dish, lat, lng, headless = true, timeout = 45000 }) {
  const proxy = getProxyConfig();
  if (!proxy) {
    console.log('[DoorDash] No proxy configured — skipping');
    return [];
  }

  if (!lat || !lng) {
    console.log('[DoorDash] No coordinates — skipping (geocode failed upstream)');
    return [];
  }

  console.log(`[DoorDash] Searching "${dish}" at ${lat}, ${lng} via proxy ${proxy.server}`);

  const browser = await chromium.launch({
    headless,
    proxy,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-blink-features=AutomationControlled',
      '--disable-features=IsolateOrigins,site-per-process',
    ]
  });

  const context = await browser.newContext({
    proxy,
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 900 },
    extraHTTPHeaders: {
      'Accept-Language': 'en-US,en;q=0.9',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
      'sec-ch-ua': '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
      'sec-ch-ua-mobile': '?0',
      'sec-ch-ua-platform': '"macOS"',
    },
    timezoneId: 'America/New_York',
    locale: 'en-US',
  });

  // Suppress webdriver fingerprint
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
    Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
    window.chrome = { runtime: {} };
  });

  const page = await context.newPage();
  const results = [];

  // -------------------------------------------------------------------------
  // Network interception — capture DoorDash API JSON responses
  // -------------------------------------------------------------------------
  const capturedStores = [];   // from search results page
  const capturedMenus  = {};   // storeid -> items[], keyed by store id

  page.on('response', async (response) => {
    const url = response.url();
    const status = response.status();
    if (status !== 200) return;

    try {
      // Store search results — matches the feed/listing API
      if (
        (url.includes('/v2/search') || url.includes('/v1/search') || url.includes('cheetah') || url.includes('feed/') || url.includes('store_feed')) &&
        url.includes('doordash.com')
      ) {
        const text = await response.text().catch(() => '');
        if (!text.startsWith('{') && !text.startsWith('[')) return;
        const json = JSON.parse(text);
        const stores = extractStoresFromSearchResponse(json, dish);
        if (stores.length > 0) {
          console.log(`[DoorDash] Intercepted search API — ${stores.length} stores`);
          capturedStores.push(...stores);
        }
      }

      // Individual store menu — matches store/menu API
      if (
        url.includes('doordash.com') &&
        (url.includes('/v2/store/') || url.includes('/store/') || url.includes('menu')) &&
        !url.includes('search')
      ) {
        const text = await response.text().catch(() => '');
        if (!text.startsWith('{') && !text.startsWith('[')) return;
        const json = JSON.parse(text);
        const items = extractItemsFromMenuResponse(json, dish);
        if (items.length > 0) {
          // Use URL as key to associate with store later
          const storeIdMatch = url.match(/store[s]?[\/=](\d+)/i);
          const key = storeIdMatch ? storeIdMatch[1] : url;
          console.log(`[DoorDash] Intercepted menu API — ${items.length} items for store ${key}`);
          capturedMenus[key] = items;
        }
      }
    } catch (e) {
      // Ignore parse errors for non-JSON responses
    }
  });

  try {
    // -----------------------------------------------------------------------
    // Step 1: Hit the homepage first to get cookies / pass Cloudflare
    // -----------------------------------------------------------------------
    console.log('[DoorDash] Loading homepage...');
    await page.goto('https://www.doordash.com', {
      waitUntil: 'domcontentloaded',
      timeout
    }).catch(() => {});

    // Wait for Cloudflare to clear
    let cleared = false;
    for (let i = 0; i < 15; i++) {
      const title = await page.title().catch(() => '');
      console.log(`[DoorDash] Title (${i + 1}): "${title}"`);
      if (title && !title.toLowerCase().includes('moment') && !title.toLowerCase().includes('cloudflare') && title.length > 3) {
        cleared = true;
        console.log('[DoorDash] ✅ Cloudflare cleared');
        break;
      }
      await page.waitForTimeout(2000);
    }

    if (!cleared) {
      console.log('[DoorDash] ❌ Cloudflare not cleared — check proxy sticky session');
      await browser.close();
      return [];
    }

    await page.waitForTimeout(1000);

    // -----------------------------------------------------------------------
    // Step 2: Navigate directly to the search URL with coordinates
    // Coords in the URL mean DoorDash knows location without address input
    // -----------------------------------------------------------------------
    const searchUrl = `https://www.doordash.com/search/store/${encodeURIComponent(dish)}/?lat=${lat}&lng=${lng}`;
    console.log(`[DoorDash] Navigating to: ${searchUrl}`);

    await page.goto(searchUrl, {
      waitUntil: 'domcontentloaded',
      timeout
    }).catch(() => {});

    // Give the page time to fire its API calls
    await page.waitForTimeout(6000);
    console.log(`[DoorDash] Page URL: ${page.url()}`);
    console.log(`[DoorDash] Captured ${capturedStores.length} stores from API interception`);

    // -----------------------------------------------------------------------
    // Step 3: If network interception got stores, visit each for menu data
    // -----------------------------------------------------------------------
    if (capturedStores.length > 0) {
      const stores = capturedStores.slice(0, 8);
      const CONCURRENCY = 3;
      for (let i = 0; i < stores.length; i += CONCURRENCY) {
        const batch = stores.slice(i, i + CONCURRENCY);
        await Promise.all(batch.map(async (store) => {
          try {
            // Check if we already captured menu data from interception
            const existingMenuKey = Object.keys(capturedMenus).find(k =>
              store.id && k.includes(store.id)
            );
            let items = existingMenuKey ? capturedMenus[existingMenuKey] : [];

            if (items.length === 0 && store.url) {
              // Visit store page to trigger menu API calls
              const storePage = await context.newPage();
              storePage.on('response', async (response) => {
                const sUrl = response.url();
                if (response.status() !== 200) return;
                try {
                  if (sUrl.includes('doordash.com') && (sUrl.includes('/v2/store/') || sUrl.includes('menu'))) {
                    const text = await response.text().catch(() => '');
                    if (!text.startsWith('{') && !text.startsWith('[')) return;
                    const json = JSON.parse(text);
                    const found = extractItemsFromMenuResponse(json, dish);
                    if (found.length > 0) items.push(...found);
                  }
                } catch (e) {}
              });

              const storeUrl = store.url.startsWith('http') ? store.url : `https://www.doordash.com${store.url}`;
              await storePage.goto(storeUrl, { waitUntil: 'domcontentloaded', timeout: 12000 }).catch(() => {});
              await storePage.waitForTimeout(3000);

              // Fallback: scrape the rendered DOM if API interception got nothing
              if (items.length === 0) {
                items = await storePage.evaluate((searchDish) => {
                  const dishWords = searchDish.toLowerCase().split(' ').filter(w => w.length > 2);
                  const expansions = {
                    pizza: ['pizza','pie','pepperoni','margherita','calzone'],
                    burger: ['burger','cheeseburger','hamburger'],
                    pasta: ['pasta','spaghetti','penne','fettuccine','lasagna'],
                    chicken: ['chicken','wings','tenders','nuggets'],
                    sandwich: ['sandwich','sub','hoagie','wrap'],
                    taco: ['taco','burrito','quesadilla'],
                    sushi: ['sushi','roll','maki','sashimi'],
                  };
                  let searchWords = [...dishWords];
                  for (const [key, words] of Object.entries(expansions)) {
                    if (dishWords.some(w => key.includes(w) || w.includes(key))) {
                      searchWords = [...new Set([...dishWords, ...words])];
                      break;
                    }
                  }
                  const lines = document.body.innerText.split('\n').map(l => l.trim()).filter(Boolean);
                  const found = [];
                  for (let i = 0; i < lines.length - 1; i++) {
                    if (!searchWords.some(w => lines[i].toLowerCase().includes(w))) continue;
                    if (lines[i].length > 100) continue;
                    for (let j = i + 1; j <= Math.min(i + 3, lines.length - 1); j++) {
                      const m = lines[j].match(/^\$(\d+\.\d{2})$/) || lines[j].match(/^\$(\d+)$/);
                      if (m) { const p = parseFloat(m[1]); if (p > 1 && p < 150) { found.push({ name: lines[i].substring(0, 70), price: p }); break; } }
                    }
                    if (found.length >= 4) break;
                  }
                  return found;
                }, dish).catch(() => []);
              }

              await storePage.close().catch(() => {});
            }

            if (items.length > 0) {
              const fee = store.deliveryFee ?? 0;
              items.slice(0, 4).forEach(item => {
                results.push({
                  platform: 'DoorDash',
                  restaurant: store.name,
                  item: item.name,
                  itemPrice: item.price,
                  deliveryFee: fee,
                  totalPrice: parseFloat((item.price + fee).toFixed(2)),
                  rating: store.rating,
                  eta: store.eta,
                  url: store.url ? `https://www.doordash.com${store.url}` : `https://www.doordash.com`
                });
              });
              console.log(`[DoorDash] ${store.name}: ${items.length} items, fee $${fee}`);
            }
          } catch (e) {
            console.log(`[DoorDash] Store error (${store.name}): ${e.message.split('\n')[0]}`);
          }
        }));
      }
    } else {
      // -----------------------------------------------------------------------
      // Fallback: API interception got nothing — parse DOM directly
      // -----------------------------------------------------------------------
      console.log('[DoorDash] No API data intercepted — falling back to DOM scrape');
      await page.waitForSelector('a[href*="/store/"]', { timeout: 8000 }).catch(() => {});

      const domStores = await page.evaluate(() => {
        const seen = new Set();
        const out = [];
        for (const card of document.querySelectorAll('a[href*="/store/"]')) {
          const href = card.getAttribute('href');
          if (!href || seen.has(href)) continue;
          seen.add(href);
          const lines = (card.innerText || '').split('\n').map(l => l.trim()).filter(Boolean);
          const name = lines[0];
          if (name && name.length > 2 && !name.startsWith('$')) {
            const text = card.innerText;
            const fee = /free/i.test(text) ? 0 : (() => { const m = text.match(/\$(\d+\.?\d*)\s*delivery/i); return m ? parseFloat(m[1]) : null; })();
            const rating = (() => { const m = text.match(/\b([45]\.\d)\b/); return m ? parseFloat(m[1]) : null; })();
            const eta = (() => { const m = text.match(/(\d+[\s–\-]+\d+\s*min|\d+\s*min)/i); return m ? m[1].trim() : null; })();
            out.push({ name, href, deliveryFee: fee, rating, eta });
            if (out.length >= 6) break;
          }
        }
        return out;
      });

      console.log(`[DoorDash] DOM fallback: ${domStores.length} stores`);
      for (const store of domStores) {
        if (results.length >= 30) break;
        try {
          const storePage = await context.newPage();
          const storeUrl = store.href.startsWith('http') ? store.href : `https://www.doordash.com${store.href}`;
          await storePage.goto(storeUrl, { waitUntil: 'domcontentloaded', timeout: 12000 }).catch(() => {});
          await storePage.waitForTimeout(2500);
          const items = await storePage.evaluate((searchDish) => {
            const words = searchDish.toLowerCase().split(' ').filter(w => w.length > 2);
            const lines = document.body.innerText.split('\n').map(l => l.trim()).filter(Boolean);
            const found = [];
            for (let i = 0; i < lines.length - 1; i++) {
              if (!words.some(w => lines[i].toLowerCase().includes(w))) continue;
              if (lines[i].length > 100) continue;
              for (let j = i + 1; j <= Math.min(i + 3, lines.length - 1); j++) {
                const m = lines[j].match(/^\$(\d+\.\d{2})$/) || lines[j].match(/^\$(\d+)$/);
                if (m) { const p = parseFloat(m[1]); if (p > 1 && p < 150) { found.push({ name: lines[i].substring(0, 70), price: p }); break; } }
              }
              if (found.length >= 4) break;
            }
            return found;
          }, dish).catch(() => []);
          await storePage.close().catch(() => {});
          if (items.length > 0) {
            const fee = store.deliveryFee ?? 0;
            items.forEach(item => {
              results.push({ platform: 'DoorDash', restaurant: store.name, item: item.name, itemPrice: item.price, deliveryFee: fee, totalPrice: parseFloat((item.price + fee).toFixed(2)), rating: store.rating, eta: store.eta, url: storeUrl });
            });
          }
        } catch (e) {
          console.log(`[DoorDash] DOM store error: ${e.message.split('\n')[0]}`);
        }
      }
    }

    console.log(`[DoorDash] ✅ Done: ${results.length} results`);
  } catch (err) {
    console.error('[DoorDash] Fatal error:', err.message.split('\n')[0]);
  } finally {
    await browser.close().catch(() => {});
  }

  return results;
}

// ---------------------------------------------------------------------------
// JSON response parsers — handle DoorDash's various API shapes
// ---------------------------------------------------------------------------

function extractStoresFromSearchResponse(json, dish) {
  const stores = [];
  try {
    // Try multiple known response shapes
    const candidates = [
      json?.data?.searchFeed?.results,
      json?.results,
      json?.data?.results,
      json?.stores,
      json?.data?.stores,
      json?.storeFeeds,
    ].filter(Array.isArray);

    for (const list of candidates) {
      for (const item of list) {
        const name = item?.name || item?.store?.name || item?.storeHeader?.name;
        const id   = item?.id   || item?.store?.id   || item?.storeId;
        const url  = item?.url  || item?.store?.url  || (id ? `/store/${id}/` : null);
        const deliveryFee = parseDeliveryFee(item?.deliveryFee || item?.store?.deliveryFee || item?.fees);
        const rating = parseFloat(item?.averageRating || item?.store?.averageRating || 0) || null;
        const eta = item?.deliveryTime || item?.store?.deliveryTime || item?.displayDeliveryTime || null;

        if (name && name.length > 2) {
          stores.push({ id: String(id || ''), name, url, deliveryFee, rating: rating && rating > 0 ? rating : null, eta: eta ? `${eta} min` : null });
          if (stores.length >= 10) break;
        }
      }
      if (stores.length > 0) break;
    }
  } catch (e) {
    // ignore
  }
  return stores;
}

function extractItemsFromMenuResponse(json, dish) {
  const items = [];
  const dishWords = dish.toLowerCase().split(' ').filter(w => w.length > 2);
  const expansions = {
    pizza: ['pizza','pie','pepperoni','margherita','calzone'],
    burger: ['burger','cheeseburger','hamburger'],
    pasta: ['pasta','spaghetti','penne','fettuccine','lasagna'],
    chicken: ['chicken','wings','tenders','nuggets'],
    sandwich: ['sandwich','sub','hoagie','wrap'],
    taco: ['taco','burrito','quesadilla'],
    sushi: ['sushi','roll','maki','sashimi'],
  };
  let searchWords = [...dishWords];
  for (const [key, words] of Object.entries(expansions)) {
    if (dishWords.some(w => key.includes(w) || w.includes(key))) {
      searchWords = [...new Set([...dishWords, ...words])];
      break;
    }
  }

  try {
    // Flatten all menu items from any known response shape
    const allItems = [];
    const walk = (obj, depth = 0) => {
      if (!obj || typeof obj !== 'object' || depth > 8) return;
      // item-like objects
      if (obj.name && (obj.price !== undefined || obj.displayPrice !== undefined)) {
        allItems.push(obj);
      }
      for (const v of Object.values(obj)) {
        if (Array.isArray(v)) v.forEach(i => walk(i, depth + 1));
        else if (v && typeof v === 'object') walk(v, depth + 1);
      }
    };
    walk(json);

    for (const item of allItems) {
      const name = String(item.name || '').trim();
      if (!name || name.length > 100) continue;
      if (!searchWords.some(w => name.toLowerCase().includes(w))) continue;
      const rawPrice = item.price ?? item.displayPrice ?? item.unitPrice;
      const price = rawPrice != null ? parsePrice(rawPrice) : null;
      if (!price || price < 1 || price > 150) continue;
      items.push({ name: name.substring(0, 70), price });
      if (items.length >= 4) break;
    }
  } catch (e) {
    // ignore
  }
  return items;
}

function parseDeliveryFee(raw) {
  if (raw == null) return null;
  if (typeof raw === 'number') return raw < 100 ? raw : raw / 100; // cents vs dollars
  if (typeof raw === 'string') {
    if (/free/i.test(raw)) return 0;
    const m = raw.match(/(\d+\.?\d*)/);
    return m ? parseFloat(m[1]) : null;
  }
  if (typeof raw === 'object') {
    if (raw.unitAmount != null) return parseDeliveryFee(raw.unitAmount);
    if (raw.value != null) return parseDeliveryFee(raw.value);
  }
  return null;
}

function parsePrice(raw) {
  if (typeof raw === 'number') return raw > 200 ? raw / 100 : raw; // cents
  if (typeof raw === 'string') {
    const m = raw.replace(/[,$]/g, '').match(/(\d+\.?\d*)/);
    return m ? parseFloat(m[1]) : null;
  }
  return null;
}

module.exports = { scrapeDoorDash };
