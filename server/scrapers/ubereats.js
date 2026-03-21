const { chromium } = require('playwright');

async function scrapeUberEats({ address, dish, credentials, headless = true, timeout = 45000 }) {
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

  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });

  const page = await context.newPage();
  const results = [];

  // INTERCEPT API responses — faster and more reliable than HTML scraping
  const interceptedStores = [];
  const interceptedMenus = {};

  page.on('response', async (response) => {
    const url = response.url();
    try {
      if (url.includes('getFeedV1') || url.includes('getSearchFeedV1') || url.includes('getFeed')) {
        const json = await response.json().catch(() => null);
        if (json?.data?.feedItems) {
          json.data.feedItems.forEach(item => {
            if (item?.store) {
              interceptedStores.push({
                name: item.store.title?.text || item.store.name,
                uuid: item.store.storeUuid || item.store.uuid,
                rating: item.store.rating?.text,
                deliveryFee: item.store.fareInfo?.deliveryFee?.unitAmount,
                eta: item.store.fareInfo?.deliveryTime || item.store.etaRange?.text,
                href: item.store.actionUrl
              });
            }
          });
          console.log(`[UberEats] Intercepted feed: ${interceptedStores.length} stores`);
        }
      }
      if (url.includes('getStoreV1') || url.includes('menu') && url.includes('uber')) {
        const json = await response.json().catch(() => null);
        if (json?.data?.catalogSectionsMap || json?.data?.sections) {
          const storeId = url.match(/[a-f0-9-]{36}/)?.[0];
          if (storeId) interceptedMenus[storeId] = json;
        }
      }
    } catch(e) {}
  });

  try {
    // Step 1: Set address
    console.log(`[UberEats] Setting address...`);
    await page.goto('https://www.ubereats.com', { waitUntil: 'domcontentloaded', timeout });
    await page.waitForTimeout(2000);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(400);

    const addressInput = await page.$('input[type="text"]');
    if (addressInput) {
      await addressInput.click({ force: true });
      await addressInput.fill('');
      await addressInput.type(address, { delay: 40 });
      await page.waitForTimeout(1800);
      const suggestion = await page.$('li[role="option"]:first-child');
      if (suggestion) await suggestion.click({ force: true });
      else { await page.keyboard.press('ArrowDown'); await page.waitForTimeout(200); await page.keyboard.press('Enter'); }
      await page.waitForTimeout(1500);
      const confirmBtn = await page.$('button:has-text("Deliver here"), button:has-text("Confirm")');
      if (confirmBtn) { await confirmBtn.click({ force: true }); await page.waitForTimeout(800); }
    }

    // Step 2: Search — this triggers the API calls we intercept
    await page.goto(`https://www.ubereats.com/search?q=${encodeURIComponent(dish)}`, { waitUntil: 'domcontentloaded', timeout });
    await page.waitForTimeout(4000);
    console.log(`[UberEats] Search URL: ${page.url()}`);
    console.log(`[UberEats] Intercepted ${interceptedStores.length} stores from API`);

    // Step 3: If API interception worked, use that data
    if (interceptedStores.length > 0) {
      const topStores = interceptedStores.slice(0, 8);

      // Visit each store page in parallel to intercept menu API calls
      const menuPromises = topStores.map(async (store) => {
        if (!store.href && !store.uuid) return [];
        try {
          const storeUrl = store.href
            ? (store.href.startsWith('http') ? store.href : `https://www.ubereats.com${store.href}`)
            : `https://www.ubereats.com/store/${store.uuid}`;

          const storePage = await context.newPage();
          const storeMenuItems = [];

          storePage.on('response', async (response) => {
            const url = response.url();
            if (url.includes('getStoreV1') || (url.includes('/api/') && url.includes('menu'))) {
              try {
                const json = await response.json().catch(() => null);
                if (json?.data) {
                  // Parse catalog sections
                  const sections = json.data.catalogSectionsMap || json.data.sections || {};
                  Object.values(sections).forEach(section => {
                    const items = section.itemsBySubsection?.[0]?.catalogItems || section.items || [];
                    items.forEach(item => {
                      const name = item.title || item.name;
                      const price = item.price ? item.price / 100 : null;
                      const dishWords = dish.toLowerCase().split(' ').filter(w => w.length > 2);
                      if (name && price && dishWords.some(w => name.toLowerCase().includes(w))) {
                        storeMenuItems.push({ name, price });
                      }
                    });
                  });
                }
              } catch(e) {}
            }
          });

          await storePage.goto(storeUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
          await storePage.waitForTimeout(3000);

          // Fallback to text parsing if API didn't give us items
          if (storeMenuItems.length === 0) {
            const items = await storePage.evaluate((searchDish) => {
              const dishWords = searchDish.toLowerCase().split(' ').filter(w => w.length > 2);
              const results = [];
              const lines = document.body.innerText.split('\n').map(l => l.trim()).filter(l => l);
              for (let i = 0; i < lines.length - 1; i++) {
                const hasMatch = dishWords.some(w => lines[i].toLowerCase().includes(w));
                if (!hasMatch) continue;
                // Price must be on its own line immediately after (not embedded in text)
                for (let j = i + 1; j <= Math.min(i + 3, lines.length - 1); j++) {
                  const m = lines[j].match(/^\$(\d+\.\d{2})$/) || lines[j].match(/^\$(\d+)$/);
                  if (m) {
                    const price = parseFloat(m[1]);
                    if (price > 1 && price < 100) {
                      results.push({ name: lines[i].substring(0, 60), price });
                      break;
                    }
                  }
                }
              }
              const seen = new Set();
              return results.filter(r => {
                const key = `${r.name}|${r.price}`;
                if (seen.has(key)) return false;
                seen.add(key); return true;
              }).slice(0, 5);
            }, dish);
            storeMenuItems.push(...items);
          }

          await storePage.close();
          console.log(`[UberEats] ${store.name}: ${storeMenuItems.length} items`);
          return storeMenuItems;
        } catch(e) {
          console.log(`[UberEats] Store page failed for ${store.name}: ${e.message.split('\n')[0]}`);
          return [];
        }
      });

      const allMenuItems = await Promise.all(menuPromises);

      topStores.forEach((store, i) => {
        const items = allMenuItems[i];
        const deliveryFee = store.deliveryFee != null ? store.deliveryFee / 100 : null;
        const rating = store.rating ? parseFloat(store.rating) : null;
        const eta = store.eta;

        if (items.length > 0) {
          items.forEach(item => {
            const total = deliveryFee != null ? parseFloat((item.price + deliveryFee).toFixed(2)) : null;
            results.push({ platform: 'Uber Eats', restaurant: store.name, item: item.name, itemPrice: item.price, deliveryFee, totalPrice: total, rating, eta, url: page.url() });
          });
        } else {
          results.push({ platform: 'Uber Eats', restaurant: store.name, item: dish, itemPrice: null, deliveryFee, totalPrice: null, rating, eta, url: page.url() });
        }
      });

    } else {
      // Fallback: HTML scraping if API interception didn't work
      console.log('[UberEats] API interception failed, falling back to HTML scraping...');
      const rawCards = await page.evaluate(() => {
        const seen = new Set();
        const out = [];
        const cards = document.querySelectorAll('[data-testid="store-card"], a[href*="/store/"]');
        for (const card of cards) {
          const href = card.tagName === 'A' ? card.getAttribute('href') : card.querySelector('a[href*="/store/"]')?.getAttribute('href');
          if (!href || seen.has(href)) continue;
          seen.add(href);
          const text = card.innerText || '';
          const nameEl = card.querySelector('h3, h4, [data-testid="store-name"]');
          const name = nameEl?.innerText?.trim() || text.split('\n').find(l => l.trim().length > 2 && !l.includes('$'));
          if (name && name.trim().length > 2) {
            out.push({ text, href, name: name.trim() });
            if (out.length >= 8) break;
          }
        }
        return out;
      });

      rawCards.forEach(card => {
        const text = card.text;
        let deliveryFee = /free delivery/i.test(text) ? 0 : null;
        if (deliveryFee === null) {
          const m = text.match(/\$(\d+\.?\d*)\s*(?:delivery fee|delivery)/i);
          if (m) deliveryFee = parseFloat(m[1]);
        }
        const ratingM = text.match(/\b([45]\.\d)\b/);
        const etaM = text.match(/(\d+[\s–\-]+\d+\s*min|\d+\s*min)/i);
        results.push({
          platform: 'Uber Eats', restaurant: card.name, item: dish,
          itemPrice: null, deliveryFee, totalPrice: null,
          rating: ratingM ? parseFloat(ratingM[1]) : null,
          eta: etaM ? etaM[1] : null, url: page.url()
        });
      });
    }

    console.log(`[UberEats] Done: ${results.length} results`);
  } catch (err) {
    console.error('[UberEats] Error:', err.message.split('\n')[0]);
  } finally {
    await browser.close();
  }
  return results;
}

module.exports = { scrapeUberEats };
