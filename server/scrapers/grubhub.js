const { chromium } = require('playwright');

async function scrapeGrubHub({ address, dish, credentials, headless = true, timeout = 45000, platform = 'GrubHub' }) {
  const browser = await chromium.launch({
    headless,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-blink-features=AutomationControlled']
  });

  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 800 },
    extraHTTPHeaders: { 'Accept-Language': 'en-US,en;q=0.9' }
  });

  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });

  const page = await context.newPage();
  const results = [];
  const interceptedRestaurants = [];
  const baseUrl = platform === 'Seamless' ? 'https://www.seamless.com' : 'https://www.grubhub.com';

  // Intercept GrubHub's REST API
  page.on('response', async (response) => {
    const url = response.url();
    try {
      if (url.includes('api-gtm.grubhub.com/restaurants/search') || url.includes('api-gtm.seamless.com/restaurants/search')) {
        const json = await response.json().catch(() => null);
        if (json?.search_result?.results) {
          json.search_result.results.forEach(r => {
            interceptedRestaurants.push({
              name: r.name,
              id: r.restaurant_id,
              rating: r.ratings?.actual_rating_value,
              deliveryFee: r.delivery_fee,
              eta: r.estimated_delivery_time,
              href: `/restaurant/${r.name?.toLowerCase().replace(/\s+/g, '-')}/${r.restaurant_id}/`
            });
          });
          console.log(`[${platform}] API intercepted: ${interceptedRestaurants.length} restaurants`);
        }
      }
    } catch(e) {}
  });

  try {
    console.log(`[${platform}] Setting address...`);
    await page.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout });
    await page.waitForTimeout(2000);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(500);

    const addressInput = await page.$('input[placeholder*="Enter delivery address"], input[placeholder*="delivery address"]');
    if (addressInput) {
      await addressInput.click({ force: true });
      await addressInput.fill('');
      await addressInput.type(address, { delay: 40 });
      await page.waitForTimeout(1800);
      const suggestion = await page.$('li[role="option"]:first-child, [data-testid="suggestion-item"]:first-child');
      if (suggestion) await suggestion.click({ force: true });
      else { await page.keyboard.press('ArrowDown'); await page.waitForTimeout(200); await page.keyboard.press('Enter'); }
      await page.waitForTimeout(2000);
      console.log(`[${platform}] URL after address: ${page.url()}`);
    } else {
      console.log(`[${platform}] No address input found`);
    }

    await page.goto(`${baseUrl}/food-delivery/search?queryText=${encodeURIComponent(dish)}`, { waitUntil: 'domcontentloaded', timeout });
    await page.waitForTimeout(4000);
    console.log(`[${platform}] Search URL: ${page.url()}`);
    console.log(`[${platform}] Intercepted ${interceptedRestaurants.length} restaurants from API`);

    let storeData = [];

    if (interceptedRestaurants.length > 0) {
      storeData = interceptedRestaurants.slice(0, 8).map(r => ({
        name: r.name,
        href: r.href,
        deliveryFee: r.deliveryFee != null ? r.deliveryFee / 100 : null,
        rating: r.rating ? parseFloat(r.rating) : null,
        eta: r.eta ? `${r.eta} min` : null
      }));
    } else {
      // HTML fallback
      console.log(`[${platform}] Using HTML fallback...`);
      const preview = await page.evaluate(() => document.body.innerText.substring(0, 400));
      console.log(`[${platform}] Page preview: ${preview}`);

      const rawCards = await page.evaluate(() => {
        const seen = new Set();
        const out = [];
        const selectors = ['a[href*="/restaurant/"]', '[class*="restaurant-card"]', '[class*="RestaurantCard"]'];
        for (const sel of selectors) {
          const cards = document.querySelectorAll(sel);
          for (const card of cards) {
            const href = card.tagName === 'A' ? card.getAttribute('href') : card.querySelector('a')?.getAttribute('href');
            if (!href || seen.has(href)) continue;
            seen.add(href);
            const text = card.innerText || '';
            const nameEl = card.querySelector('h3, h4, [class*="name"]');
            const name = nameEl?.innerText?.trim() || text.split('\n').find(l => l.trim().length > 2 && !l.includes('$'));
            if (name && name.trim().length > 2) {
              out.push({ text, href, name: name.trim() });
              if (out.length >= 8) break;
            }
          }
          if (out.length > 0) break;
        }
        return out;
      });

      storeData = rawCards.map(card => {
        const text = card.text;
        let deliveryFee = /free/i.test(text) ? 0 : null;
        if (deliveryFee === null) {
          const m = text.match(/\$(\d+\.?\d*)\s*(?:delivery fee|delivery)/i);
          if (m) deliveryFee = parseFloat(m[1]);
        }
        const ratingM = text.match(/\b([45]\.\d)\b/);
        const etaM = text.match(/(\d+[\s–\-]+\d+\s*min|\d+\s*min)/i);
        return { name: card.name, href: card.href, deliveryFee, rating: ratingM ? parseFloat(ratingM[1]) : null, eta: etaM ? etaM[1] : null };
      });
    }

    console.log(`[${platform}] Processing ${storeData.length} stores...`);

    const itemPromises = storeData.map(async (store) => {
      if (!store.href) return [];
      try {
        const storeUrl = store.href.startsWith('http') ? store.href : `${baseUrl}${store.href}`;
        const storePage = await context.newPage();
        const menuItems = [];

        // Intercept GrubHub menu API
        storePage.on('response', async (response) => {
          const url = response.url();
          if (url.includes('/api/') && (url.includes('menu') || url.includes('restaurant'))) {
            try {
              const json = await response.json().catch(() => null);
              if (json?.restaurant?.menu_category_list) {
                const dishWords = dish.toLowerCase().split(' ').filter(w => w.length > 2);
                json.restaurant.menu_category_list.forEach(cat => {
                  (cat.menu_item_list || []).forEach(item => {
                    const name = item.name;
                    const price = item.price != null ? item.price / 100 : null;
                    if (name && price && dishWords.some(w => name.toLowerCase().includes(w))) {
                      menuItems.push({ name, price });
                    }
                  });
                });
              }
            } catch(e) {}
          }
        });

        await storePage.goto(storeUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
        await storePage.waitForTimeout(3000);

        if (menuItems.length === 0) {
          const items = await storePage.evaluate((searchDish) => {
            const dishWords = searchDish.toLowerCase().split(' ').filter(w => w.length > 2);
            const results = [];
            const lines = document.body.innerText.split('\n').map(l => l.trim()).filter(l => l);
            for (let i = 0; i < lines.length - 1; i++) {
              if (!dishWords.some(w => lines[i].toLowerCase().includes(w))) continue;
              for (let j = i + 1; j <= Math.min(i + 3, lines.length - 1); j++) {
                const m = lines[j].match(/^\$(\d+\.\d{2})$/) || lines[j].match(/^\$(\d+)$/);
                if (m) {
                  const price = parseFloat(m[1]);
                  if (price > 1 && price < 100) { results.push({ name: lines[i].substring(0, 60), price }); break; }
                }
              }
            }
            const seen = new Set();
            return results.filter(r => { const k = `${r.name}|${r.price}`; if (seen.has(k)) return false; seen.add(k); return true; }).slice(0, 5);
          }, dish);
          menuItems.push(...items);
        }

        await storePage.close();
        console.log(`[${platform}] ${store.name}: ${menuItems.length} items`);
        return menuItems;
      } catch(e) {
        console.log(`[${platform}] Store failed ${store.name}: ${e.message.split('\n')[0]}`);
        return [];
      }
    });

    const allItems = await Promise.all(itemPromises);

    storeData.forEach((store, i) => {
      const items = allItems[i];
      if (items.length > 0) {
        items.forEach(item => {
          const total = store.deliveryFee != null ? parseFloat((item.price + store.deliveryFee).toFixed(2)) : null;
          results.push({ platform, restaurant: store.name, item: item.name, itemPrice: item.price, deliveryFee: store.deliveryFee, totalPrice: total, rating: store.rating, eta: store.eta, url: page.url() });
        });
      } else {
        results.push({ platform, restaurant: store.name, item: dish, itemPrice: null, deliveryFee: store.deliveryFee, totalPrice: null, rating: store.rating, eta: store.eta, url: page.url() });
      }
    });

    console.log(`[${platform}] Done: ${results.length} results`);
  } catch (err) {
    console.error(`[${platform}] Error:`, err.message.split('\n')[0]);
  } finally {
    await browser.close();
  }
  return results;
}

async function scrapeSeamless(params) {
  return scrapeGrubHub({ ...params, platform: 'Seamless' });
}

module.exports = { scrapeGrubHub, scrapeSeamless };
