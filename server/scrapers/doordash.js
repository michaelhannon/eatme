const { chromium } = require('playwright');

async function scrapeDoorDash({ address, dish, credentials, headless = true, timeout = 45000 }) {
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
  const interceptedStores = [];

  // Intercept DoorDash's internal API calls
  page.on('response', async (response) => {
    const url = response.url();
    try {
      // DoorDash search API
      if (url.includes('search/store') && url.includes('doordash.com/graphql')) {
        const json = await response.json().catch(() => null);
        if (json?.data?.searchStore?.stores) {
          json.data.searchStore.stores.forEach(store => {
            interceptedStores.push({
              name: store.name,
              id: store.id,
              slug: store.url,
              rating: store.averageRating,
              deliveryFee: store.deliveryFee,
              eta: store.displayDeliveryTime,
              href: `/store/${store.url}--${store.id}/`
            });
          });
          console.log(`[DoorDash] API intercepted: ${interceptedStores.length} stores`);
        }
      }
    } catch(e) {}
  });

  try {
    // Step 1: Set address
    console.log(`[DoorDash] Setting address...`);
    await page.goto('https://www.doordash.com', { waitUntil: 'domcontentloaded', timeout });
    await page.waitForTimeout(2000);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(600);

    const addressInput = await page.$('#HomeAddressAutocomplete, input[placeholder*="delivery address"], input[placeholder*="Enter delivery"]');
    if (addressInput) {
      await addressInput.click({ force: true });
      await addressInput.fill('');
      await addressInput.type(address, { delay: 40 });
      await page.waitForTimeout(1800);
      const suggestion = await page.$('li[role="option"]:first-child, [id*="Suggestion"]:first-child');
      if (suggestion) await suggestion.click({ force: true });
      else { await page.keyboard.press('ArrowDown'); await page.waitForTimeout(200); await page.keyboard.press('Enter'); }
      await page.waitForTimeout(2000);
      console.log(`[DoorDash] URL after address: ${page.url()}`);
    } else {
      console.log('[DoorDash] No address input found');
    }

    // Step 2: Search (triggers API calls)
    await page.goto(`https://www.doordash.com/search/store/${encodeURIComponent(dish)}/`, { waitUntil: 'domcontentloaded', timeout });
    await page.waitForTimeout(4000);
    console.log(`[DoorDash] Search URL: ${page.url()}`);
    console.log(`[DoorDash] Intercepted ${interceptedStores.length} stores from API`);

    // Step 3: Get store cards (from API interception or HTML fallback)
    let storeData = [];

    if (interceptedStores.length > 0) {
      storeData = interceptedStores.slice(0, 8).map(s => ({
        name: s.name,
        href: s.href,
        deliveryFee: s.deliveryFee != null ? s.deliveryFee / 100 : null,
        rating: s.rating ? parseFloat(s.rating) : null,
        eta: s.eta ? `${s.eta} min` : null
      }));
    } else {
      // HTML fallback
      console.log('[DoorDash] Using HTML fallback...');
      const rawCards = await page.evaluate(() => {
        const seen = new Set();
        const out = [];
        const cards = document.querySelectorAll('a[href*="/store/"]');
        for (const card of cards) {
          const href = card.getAttribute('href');
          if (!href || seen.has(href)) continue;
          seen.add(href);
          const text = card.innerText || '';
          const nameEl = card.querySelector('h3, h4, [data-anchor-id*="Name"]');
          const name = nameEl?.innerText?.trim() || text.split('\n').find(l => l.trim().length > 2 && !l.includes('$'));
          if (name && name.trim().length > 2) {
            out.push({ text, href, name: name.trim() });
            if (out.length >= 8) break;
          }
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

    console.log(`[DoorDash] Processing ${storeData.length} stores for item prices...`);

    // Step 4: Parallel item price fetching
    const itemPromises = storeData.map(async (store) => {
      if (!store.href) return [];
      try {
        const storeUrl = store.href.startsWith('http') ? store.href : `https://www.doordash.com${store.href}`;
        const storePage = await context.newPage();
        const menuItems = [];

        // Intercept menu API on store page
        storePage.on('response', async (response) => {
          const url = response.url();
          if (url.includes('getMenu') || url.includes('storeMenu') || (url.includes('doordash.com/graphql') && !url.includes('search'))) {
            try {
              const json = await response.json().catch(() => null);
              if (json?.data?.store?.menus || json?.data?.menus) {
                const menus = json.data.store?.menus || json.data.menus || [];
                const dishWords = dish.toLowerCase().split(' ').filter(w => w.length > 2);
                menus.forEach(menu => {
                  (menu.menuCategories || []).forEach(cat => {
                    (cat.items || []).forEach(item => {
                      const name = item.name || item.itemName;
                      const price = item.price != null ? item.price / 100 : null;
                      if (name && price && dishWords.some(w => name.toLowerCase().includes(w))) {
                        menuItems.push({ name, price });
                      }
                    });
                  });
                });
              }
            } catch(e) {}
          }
        });

        await storePage.goto(storeUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
        await storePage.waitForTimeout(3000);

        // Text fallback if API interception didn't work
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
        console.log(`[DoorDash] ${store.name}: ${menuItems.length} items`);
        return menuItems;
      } catch(e) {
        console.log(`[DoorDash] Store failed ${store.name}: ${e.message.split('\n')[0]}`);
        return [];
      }
    });

    const allItems = await Promise.all(itemPromises);

    storeData.forEach((store, i) => {
      const items = allItems[i];
      if (items.length > 0) {
        items.forEach(item => {
          const total = store.deliveryFee != null ? parseFloat((item.price + store.deliveryFee).toFixed(2)) : null;
          results.push({ platform: 'DoorDash', restaurant: store.name, item: item.name, itemPrice: item.price, deliveryFee: store.deliveryFee, totalPrice: total, rating: store.rating, eta: store.eta, url: page.url() });
        });
      } else {
        results.push({ platform: 'DoorDash', restaurant: store.name, item: dish, itemPrice: null, deliveryFee: store.deliveryFee, totalPrice: null, rating: store.rating, eta: store.eta, url: page.url() });
      }
    });

    console.log(`[DoorDash] Done: ${results.length} results`);
  } catch (err) {
    console.error('[DoorDash] Error:', err.message.split('\n')[0]);
  } finally {
    await browser.close();
  }
  return results;
}

module.exports = { scrapeDoorDash };
