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
    await page.waitForTimeout(2500);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(500);

    // Log all inputs to see what's available
    const allInputs = await page.evaluate(() => {
      return Array.from(document.querySelectorAll('input')).map(i => ({
        id: i.id, placeholder: i.placeholder, type: i.type, visible: i.offsetWidth > 0
      }));
    });
    console.log(`[${platform}] Inputs: ${JSON.stringify(allInputs)}`);

    const addressInput = await page.$('input[placeholder*="Enter delivery address"], input[placeholder*="delivery address"], input[placeholder*="address"], input[type="text"]');
    if (addressInput) {
      await addressInput.click({ force: true });
      await addressInput.fill('');
      await addressInput.type(address, { delay: 40 });
      await page.waitForTimeout(1800);
      const suggestion = await page.$('li[role="option"]:first-child, [data-testid="suggestion-item"]:first-child, [class*="autocomplete"] li:first-child');
      if (suggestion) {
        await suggestion.click({ force: true });
        console.log(`[${platform}] Clicked suggestion`);
      } else {
        await page.keyboard.press('ArrowDown');
        await page.waitForTimeout(300);
        await page.keyboard.press('Enter');
      }
      await page.waitForTimeout(2500);
      console.log(`[${platform}] URL after address: ${page.url()}`);
    }

    // After address set, GrubHub lands on /lets-eat
    // From there we need to use the SEARCH BAR not a direct URL
    // The direct URL /food-delivery/search returns 404

    const currentUrl = page.url();
    console.log(`[${platform}] Current URL before search: ${currentUrl}`);

    if (currentUrl.includes('lets-eat') || currentUrl.includes(baseUrl)) {
      // Use the search bar on the current page
      const searchInput = await page.waitForSelector(
        'input[placeholder*="Search"], input[placeholder*="search"], [data-testid="search-input"], input[name="search"]',
        { timeout: 10000 }
      ).catch(() => null);

      if (searchInput) {
        console.log(`[${platform}] Using search bar on lets-eat page`);
        await searchInput.click({ force: true });
        await searchInput.fill(dish);
        await page.keyboard.press('Enter');
        await page.waitForTimeout(4000);
        console.log(`[${platform}] Search URL: ${page.url()}`);
      } else {
        // Try clicking a search icon or navigating differently
        console.log(`[${platform}] No search bar found, trying URL navigation`);
        // Try alternative search URLs
        const searchUrls = [
          `${baseUrl}/delivery/search?queryText=${encodeURIComponent(dish)}`,
          `${baseUrl}/search?q=${encodeURIComponent(dish)}`,
          `${baseUrl}/food-delivery/${encodeURIComponent(dish)}/`,
        ];
        for (const url of searchUrls) {
          await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
          await page.waitForTimeout(2000);
          const preview = await page.evaluate(() => document.body.innerText.substring(0, 100));
          console.log(`[${platform}] Tried ${url}: ${preview}`);
          if (!preview.includes("missing") && !preview.includes("hamburger") && !preview.includes("doesn't exist")) {
            break;
          }
        }
      }
    }

    console.log(`[${platform}] Final search URL: ${page.url()}`);
    const preview = await page.evaluate(() => document.body.innerText.substring(0, 400));
    console.log(`[${platform}] Page preview: ${preview}`);

    // Find restaurant cards
    await page.waitForSelector(
      'a[href*="/restaurant/"], [class*="restaurant-card"], [class*="RestaurantCard"], [class*="restaurantCard"]',
      { timeout: 12000 }
    ).catch(() => console.log(`[${platform}] No restaurant card selector matched`));

    const allLinks = await page.evaluate(() => {
      return Array.from(document.querySelectorAll('a')).filter(a => a.href.includes('/restaurant/')).slice(0, 5).map(a => ({ href: a.getAttribute('href'), text: a.innerText?.substring(0, 50) }));
    });
    console.log(`[${platform}] Restaurant links: ${JSON.stringify(allLinks)}`);

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
          const lines = text.split('\n').map(l => l.trim()).filter(l => l.length > 0);
          const name = lines[0];
          if (name && name.length > 2) {
            out.push({ href, name, text, lines });
            if (out.length >= 8) break;
          }
        }
        if (out.length > 0) break;
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
      const etaM = text.match(/(\d+[\s–\-−]+\d+\s*min|\d+\s*min)/i);
      return { name: card.name, href: card.href, deliveryFee, rating: ratingM ? parseFloat(ratingM[1]) : null, eta: etaM ? etaM[1]?.trim() : null };
    });

    const itemPromises = storeData.map(async (store) => {
      if (!store.href) return { items: [], deliveryFee: store.deliveryFee };
      try {
        const storeUrl = store.href.startsWith('http') ? store.href : `${baseUrl}${store.href}`;
        const storePage = await context.newPage();
        await storePage.goto(storeUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
        await storePage.waitForTimeout(2500);

        const data = await storePage.evaluate((searchDish) => {
          const dishWords = searchDish.toLowerCase().split(' ').filter(w => w.length > 2);
          const lines = document.body.innerText.split('\n').map(l => l.trim()).filter(l => l);

          let deliveryFee = null;
          for (const line of lines) {
            if (/free delivery/i.test(line)) { deliveryFee = 0; break; }
            if (/delivery fee/i.test(line)) {
              const m = line.match(/\$(\d+\.?\d*)/);
              if (m) { deliveryFee = parseFloat(m[1]); break; }
            }
          }

          const items = [];
          for (let i = 0; i < lines.length - 1; i++) {
            if (!dishWords.some(w => lines[i].toLowerCase().includes(w))) continue;
            if (lines[i].length > 80) continue;
            for (let j = i + 1; j <= Math.min(i + 3, lines.length - 1); j++) {
              const m = lines[j].match(/^\$(\d+\.\d{2})$/) || lines[j].match(/^\$(\d+)$/);
              if (m) {
                const price = parseFloat(m[1]);
                if (price > 1 && price < 150) { items.push({ name: lines[i].substring(0, 70), price }); break; }
              }
            }
          }

          const seen = new Set();
          return {
            deliveryFee,
            items: items.filter(r => { const k = `${r.name}|${r.price}`; if (seen.has(k)) return false; seen.add(k); return true; }).slice(0, 4)
          };
        }, dish);

        await storePage.close();
        console.log(`[${platform}] ${store.name}: ${data.items.length} items, fee: $${data.deliveryFee}`);
        return data;
      } catch(e) {
        console.log(`[${platform}] Store failed ${store.name}: ${e.message.split('\n')[0]}`);
        return { items: [], deliveryFee: store.deliveryFee };
      }
    });

    const allData = await Promise.all(itemPromises);

    storeData.forEach((store, i) => {
      const { items, deliveryFee } = allData[i];
      if (items.length > 0) {
        items.forEach(item => {
          const total = deliveryFee != null ? parseFloat((item.price + deliveryFee).toFixed(2)) : null;
          results.push({ platform, restaurant: store.name, item: item.name, itemPrice: item.price, deliveryFee, totalPrice: total, rating: store.rating, eta: store.eta, url: page.url() });
        });
      } else {
        results.push({ platform, restaurant: store.name, item: dish, itemPrice: null, deliveryFee, totalPrice: null, rating: store.rating, eta: store.eta, url: page.url() });
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
