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

  function parseLocationSlug(addr) {
    const m = addr.match(/,\s*([^,]+?)\s+([A-Z]{2})\s+\d{5}/);
    if (!m) return null;
    const city = m[1].toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
    const state = m[2].toLowerCase();
    return `${state}-${city}`;
  }

  try {
    // Step 1: Set address on homepage
    console.log(`[${platform}] Loading homepage...`);
    await page.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout });
    await page.waitForTimeout(2500);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(500);

    const addressInput = await page.$('input[placeholder*="Enter delivery address"], input[placeholder*="delivery address"], input[placeholder*="address"], input[type="text"]');
    if (addressInput) {
      await addressInput.click({ force: true });
      await addressInput.fill('');
      await addressInput.type(address, { delay: 40 });
      await page.waitForTimeout(1800);
      const suggestion = await page.$('li[role="option"]:first-child, [data-testid="suggestion-item"]:first-child, [class*="autocomplete"] li:first-child');
      if (suggestion) await suggestion.click({ force: true });
      else { await page.keyboard.press('ArrowDown'); await page.waitForTimeout(300); await page.keyboard.press('Enter'); }
      await page.waitForTimeout(2500);
      console.log(`[${platform}] After address URL: ${page.url()}`);
    }

    // Step 2: Use search bar (we know this works from logs)
    const searchInput = await page.waitForSelector(
      'input[placeholder*="Search"], input[placeholder*="search"], input[name="search"], [data-testid="search-input"]',
      { timeout: 10000 }
    ).catch(() => null);

    if (searchInput) {
      console.log(`[${platform}] Using search bar...`);
      await searchInput.click({ force: true });
      await searchInput.fill(dish);
      await page.keyboard.press('Enter');
      await page.waitForTimeout(4000);
      console.log(`[${platform}] Search URL: ${page.url()}`);
    }

    // Wait for results
    await page.waitForTimeout(2000);
    const preview = await page.evaluate(() => document.body.innerText.substring(0, 200));
    console.log(`[${platform}] Preview: ${preview.substring(0, 150)}`);

    // Step 3: Scrape restaurant cards
    // GrubHub/Seamless search results use li elements and various card formats
    const rawCards = await page.evaluate(() => {
      const seen = new Set();
      const out = [];

      // Try multiple selector strategies
      const strategies = [
        // Strategy 1: restaurant links
        () => document.querySelectorAll('a[href*="/restaurant/"]'),
        // Strategy 2: list items with restaurant data
        () => document.querySelectorAll('[class*="restaurantCard"], [class*="restaurant-card"], [class*="RestaurantCard"]'),
        // Strategy 3: Any li with a restaurant name
        () => document.querySelectorAll('ul[class*="restaurants"] li, ul[class*="results"] li'),
        // Strategy 4: search result items
        () => document.querySelectorAll('[data-testid*="restaurant"], [data-testid*="store"]'),
      ];

      for (const getElements of strategies) {
        const els = getElements();
        if (els.length === 0) continue;
        console.log('Strategy found', els.length, 'elements');

        for (const el of els) {
          const href = el.tagName === 'A'
            ? el.getAttribute('href')
            : el.querySelector('a')?.getAttribute('href');

          if (!href || seen.has(href)) continue;
          seen.add(href);

          const text = el.innerText || '';
          const lines = text.split('\n').map(l => l.trim()).filter(l => l.length > 0);
          const name = lines[0];

          if (name && name.length > 2 && !name.startsWith('$')) {
            out.push({ href, name, text, lines });
            if (out.length >= 8) break;
          }
        }
        if (out.length > 0) break;
      }

      // Last resort: grab all text blocks that look like restaurant names
      if (out.length === 0) {
        const allLinks = document.querySelectorAll('a[href]');
        for (const link of allLinks) {
          const href = link.getAttribute('href');
          if (!href || seen.has(href)) continue;
          if (!href.includes('/restaurant/') && !href.includes('/store/') && !href.includes('/menu/')) continue;
          seen.add(href);
          const text = link.innerText || '';
          const name = text.split('\n')[0]?.trim();
          if (name && name.length > 2 && !name.startsWith('$')) {
            out.push({ href, name, text, lines: text.split('\n').map(l=>l.trim()).filter(l=>l) });
            if (out.length >= 8) break;
          }
        }
      }

      return out;
    });

    console.log(`[${platform}] Found ${rawCards.length} restaurants`);
    if (rawCards[0]) console.log(`[${platform}] Sample lines: ${JSON.stringify(rawCards[0].lines.slice(0,8))}`);

    const storeData = rawCards.map(card => {
      const text = card.text;
      let deliveryFee = /free/i.test(text) ? 0 : null;
      if (deliveryFee === null) {
        const m = text.match(/\$(\d+\.?\d*)\s*(?:delivery fee|delivery)/i)
          || text.match(/delivery[:\s]+\$(\d+\.?\d*)/i);
        if (m) deliveryFee = parseFloat(m[1]);
      }
      const ratingM = text.match(/\b([45]\.\d)\b/);
      const etaM = text.match(/(\d+[\s–\-−]+\d+\s*min|\d+\s*min)/i);
      return {
        name: card.name,
        href: card.href,
        deliveryFee,
        rating: ratingM ? parseFloat(ratingM[1]) : null,
        eta: etaM ? etaM[1]?.trim() : null
      };
    });

    // Step 4: Fetch item prices SEQUENTIALLY to avoid memory crashes
    // (parallel was crashing Railway - "Target crashed")
    for (const store of storeData) {
      if (!store.href) {
        results.push({ platform, restaurant: store.name, item: dish, itemPrice: null, deliveryFee: store.deliveryFee, totalPrice: null, rating: store.rating, eta: store.eta, url: page.url() });
        continue;
      }

      try {
        const storeUrl = store.href.startsWith('http') ? store.href : `${baseUrl}${store.href}`;
        const storePage = await context.newPage();
        await storePage.goto(storeUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
        await storePage.waitForTimeout(4000);

        // Wait for menu items to render
        await storePage.waitForSelector(
          '[class*="menuItem"], [class*="MenuItem"], [class*="menu-item"], [class*="itemInfo"]',
          { timeout: 8000 }
        ).catch(() => {});

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
                if (price > 1 && price < 150) {
                  items.push({ name: lines[i].substring(0, 70), price });
                  break;
                }
              }
            }
          }
          const seen = new Set();
          return {
            deliveryFee,
            items: items.filter(r => {
              const k = `${r.name}|${r.price}`;
              if (seen.has(k)) return false;
              seen.add(k);
              return true;
            }).slice(0, 4)
          };
        }, dish);

        await storePage.close();
        console.log(`[${platform}] ${store.name}: ${data.items.length} items, fee: $${data.deliveryFee}`);

        const deliveryFee = data.deliveryFee ?? store.deliveryFee;
        if (data.items.length > 0) {
          data.items.forEach(item => {
            const total = deliveryFee != null ? parseFloat((item.price + deliveryFee).toFixed(2)) : null;
            results.push({ platform, restaurant: store.name, item: item.name, itemPrice: item.price, deliveryFee, totalPrice: total, rating: store.rating, eta: store.eta, url: page.url() });
          });
        } else {
          results.push({ platform, restaurant: store.name, item: dish, itemPrice: null, deliveryFee, totalPrice: null, rating: store.rating, eta: store.eta, url: page.url() });
        }
      } catch(e) {
        console.log(`[${platform}] Store failed ${store.name}: ${e.message.split('\n')[0]}`);
        results.push({ platform, restaurant: store.name, item: dish, itemPrice: null, deliveryFee: store.deliveryFee, totalPrice: null, rating: store.rating, eta: store.eta, url: page.url() });
      }
    }

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
