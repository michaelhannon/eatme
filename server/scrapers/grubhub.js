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

  // Parse city/state from address for URL format
  // "86 Horsneck Point Rd, Oceanport NJ 07757" -> "nj-oceanport"
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
      if (suggestion) {
        await suggestion.click({ force: true });
      } else {
        await page.keyboard.press('ArrowDown');
        await page.waitForTimeout(300);
        await page.keyboard.press('Enter');
      }
      await page.waitForTimeout(2500);
      console.log(`[${platform}] After address URL: ${page.url()}`);
    }

    // Step 2: Try the correct GrubHub search URL format: /delivery/[state-city]/[dish]
    const locationSlug = parseLocationSlug(address);
    const dishSlug = encodeURIComponent(dish.toLowerCase().replace(/\s+/g, '-'));
    const encodedDish = encodeURIComponent(dish);

    const searchUrls = locationSlug ? [
      `${baseUrl}/delivery/${locationSlug}/${dishSlug}`,
      `${baseUrl}/delivery/${locationSlug}/${encodedDish}`,
      `${baseUrl}/delivery/cuisine/${dishSlug}`,
    ] : [
      `${baseUrl}/delivery/cuisine/${dishSlug}`,
    ];

    let landed = false;
    for (const url of searchUrls) {
      console.log(`[${platform}] Trying URL: ${url}`);
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
      await page.waitForTimeout(3000);
      const preview = await page.evaluate(() => document.body.innerText.substring(0, 150));
      console.log(`[${platform}] Preview: ${preview}`);
      if (!preview.includes("missing") && !preview.includes("hamburger") && !preview.includes("doesn't exist") && !preview.includes("secret")) {
        landed = true;
        console.log(`[${platform}] Found working URL: ${url}`);
        break;
      }
    }

    // Step 3: If URL approach failed, use search bar on lets-eat page
    if (!landed) {
      console.log(`[${platform}] URL approach failed, using search bar...`);
      await page.goto(`${baseUrl}/lets-eat`, { waitUntil: 'domcontentloaded', timeout });
      await page.waitForTimeout(2000);

      const searchInput = await page.waitForSelector(
        'input[placeholder*="Search"], input[placeholder*="search"], input[name="search"], [data-testid="search-input"], input[type="search"]',
        { timeout: 10000 }
      ).catch(() => null);

      if (searchInput) {
        console.log(`[${platform}] Found search bar, typing dish...`);
        await searchInput.click({ force: true });
        await searchInput.fill(dish);
        await page.keyboard.press('Enter');
        await page.waitForTimeout(4000);
        console.log(`[${platform}] After search URL: ${page.url()}`);
      } else {
        // Last resort: GrubHub has a /find-restaurants endpoint
        await page.goto(`${baseUrl}/find-restaurants?searchText=${encodedDish}`, { waitUntil: 'domcontentloaded', timeout });
        await page.waitForTimeout(3000);
        console.log(`[${platform}] find-restaurants URL: ${page.url()}`);
      }
    }

    const finalPreview = await page.evaluate(() => document.body.innerText.substring(0, 300));
    console.log(`[${platform}] Final page preview: ${finalPreview}`);

    // Step 4: Scrape restaurant cards
    await page.waitForSelector(
      'a[href*="/restaurant/"], [class*="restaurant-card"], [class*="RestaurantCard"], [class*="restaurantCard"]',
      { timeout: 12000 }
    ).catch(() => console.log(`[${platform}] No restaurant cards found`));

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
          if (name && name.length > 2 && !name.startsWith('$')) {
            out.push({ href, name, text, lines });
            if (out.length >= 8) break;
          }
        }
        if (out.length > 0) break;
      }
      return out;
    });

    console.log(`[${platform}] Found ${rawCards.length} restaurants`);
    if (rawCards[0]) console.log(`[${platform}] Sample: ${JSON.stringify(rawCards[0].lines.slice(0,6))}`);

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

    // Step 5: Parallel item price fetching
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
