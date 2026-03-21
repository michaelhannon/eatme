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
  const baseUrl = platform === 'Seamless' ? 'https://www.seamless.com' : 'https://www.grubhub.com';

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
    }

    await page.goto(`${baseUrl}/food-delivery/search?queryText=${encodeURIComponent(dish)}`, { waitUntil: 'domcontentloaded', timeout });
    await page.waitForTimeout(3500);
    console.log(`[${platform}] Search URL: ${page.url()}`);
    const preview = await page.evaluate(() => document.body.innerText.substring(0, 300));
    console.log(`[${platform}] Preview: ${preview}`);

    await page.waitForSelector('a[href*="/restaurant/"], [class*="restaurant-card"]', { timeout: 12000 }).catch(() => {});

    const rawCards = await page.evaluate(() => {
      const seen = new Set();
      const out = [];
      const cards = document.querySelectorAll('a[href*="/restaurant/"], [class*="restaurant-card"], [class*="RestaurantCard"]');
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
      return out;
    });

    console.log(`[${platform}] Found ${rawCards.length} restaurants`);

    const storeData = rawCards.map(card => {
      const text = card.text;
      let deliveryFee = /free/i.test(text) ? 0 : null;
      if (deliveryFee === null) {
        const m = text.match(/\$(\d+\.?\d*)\s*(?:delivery fee|delivery)/i);
        if (m) deliveryFee = parseFloat(m[1]);
      }
      const ratingM = text.match(/\b([45]\.\d)\b/);
      const etaM = text.match(/(\d+[\s–\-]+\d+\s*min|\d+\s*min)/i);
      return { ...card, deliveryFee, rating: ratingM ? parseFloat(ratingM[1]) : null, eta: etaM ? etaM[1] : null };
    });

    const itemPromises = storeData.map(async (store) => {
      if (!store.href) return [];
      try {
        const storeUrl = store.href.startsWith('http') ? store.href : `${baseUrl}${store.href}`;
        const storePage = await context.newPage();
        await storePage.goto(storeUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
        await storePage.waitForTimeout(2500);

        const items = await storePage.evaluate((searchDish) => {
          const dishWords = searchDish.toLowerCase().split(' ').filter(w => w.length > 2);
          const results = [];

          const menuEls = document.querySelectorAll('[class*="menuItem"], [class*="MenuItem"], [data-testid="menu-item"]');
          menuEls.forEach(el => {
            const text = el.innerText || '';
            const hasMatch = dishWords.some(w => text.toLowerCase().includes(w));
            if (!hasMatch) return;
            const lines = text.split('\n').map(l => l.trim()).filter(l => l);
            const name = lines.find(l => l.length > 2 && !l.match(/^\$/));
            const priceLine = lines.find(l => l.match(/^\$\d+\.\d{2}$/) || l.match(/^\$\d+$/));
            const price = priceLine ? parseFloat(priceLine.replace('$', '')) : null;
            if (name && price && price > 1 && price < 100) results.push({ name, price });
          });

          if (results.length === 0) {
            const lines = document.body.innerText.split('\n').map(l => l.trim()).filter(l => l);
            for (let i = 0; i < lines.length - 1; i++) {
              const hasMatch = dishWords.some(w => lines[i].toLowerCase().includes(w));
              if (!hasMatch) continue;
              for (let j = i + 1; j <= Math.min(i + 3, lines.length - 1); j++) {
                const m = lines[j].match(/^\$(\d+\.\d{2})$/) || lines[j].match(/^\$(\d+)$/);
                if (m) {
                  const price = parseFloat(m[1]);
                  if (price > 1 && price < 100) { results.push({ name: lines[i], price }); break; }
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

        await storePage.close();
        console.log(`[${platform}] ${store.name}: ${items.length} items`);
        return items;
      } catch(e) {
        console.log(`[${platform}] Item fetch failed for ${store.name}: ${e.message.split('\n')[0]}`);
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
