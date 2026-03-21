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
    // Step 1: Set address
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

    // Step 2: Use search bar
    const searchInput = await page.waitForSelector(
      'input[placeholder*="Search"], input[placeholder*="search"], input[name="search"]',
      { timeout: 10000 }
    ).catch(() => null);

    if (searchInput) {
      await searchInput.click({ force: true });
      await searchInput.fill(dish);
      await page.keyboard.press('Enter');
      await page.waitForTimeout(4000);
      console.log(`[${platform}] Search URL: ${page.url()}`);
    }

    await page.waitForTimeout(2000);

    // Step 3: Scrape cards by walking up from restaurant links
    const rawCards = await page.evaluate(() => {
      const seen = new Set();
      const out = [];
      const links = document.querySelectorAll('a[href*="/restaurant/"]');

      for (const link of links) {
        const href = link.getAttribute('href');
        if (!href || seen.has(href)) continue;
        seen.add(href);

        // Walk up DOM to find card container with full info (name + rating + eta)
        let container = link;
        for (let i = 0; i < 8; i++) {
          if (!container.parentElement) break;
          container = container.parentElement;
          const linesCount = (container.innerText || '').split('\n').filter(l => l.trim().length > 0).length;
          if (linesCount >= 3) break;
        }

        const text = container.innerText || link.innerText || '';
        const lines = text.split('\n').map(l => l.trim()).filter(l => l.length > 0);
        const name = lines[0];

        if (name && name.length > 2 && !name.startsWith('$')) {
          out.push({ href, name, text, lines });
          if (out.length >= 12) break;
        }
      }
      return out;
    });

    console.log(`[${platform}] Found ${rawCards.length} restaurants`);
    if (rawCards[0]) console.log(`[${platform}] Sample lines: ${JSON.stringify(rawCards[0].lines.slice(0, 8))}`);

    const storeData = rawCards.map(card => {
      const text = card.text;
      // Delivery fee
      let deliveryFee = null;
      if (/free delivery/i.test(text) || /\$0\.00 delivery/i.test(text)) deliveryFee = 0;
      else {
        const m = text.match(/\$(\d+\.?\d*)\s*(?:delivery fee|delivery)/i)
          || text.match(/delivery[:\s]+\$(\d+\.?\d*)/i);
        if (m) deliveryFee = parseFloat(m[1]);
        // Also check for standalone fee like "$1.99" near "delivery"
        if (deliveryFee === null) {
          const lines = card.lines;
          for (let i = 0; i < lines.length; i++) {
            if (/delivery/i.test(lines[i])) {
              const priceMatch = (lines[i-1]||'').match(/\$(\d+\.?\d*)/) || (lines[i]||'').match(/\$(\d+\.?\d*)/);
              if (priceMatch) { deliveryFee = parseFloat(priceMatch[1]); break; }
            }
          }
        }
      }
      // Rating - look for "4.7 (316)" pattern
      const ratingM = text.match(/\b([45]\.\d)\s*\(/);
      // ETA
      const etaM = text.match(/(\d+[\s–\-−]+\d+\s*min|\d+\s*min)/i);
      return {
        name: card.name,
        href: card.href,
        deliveryFee,
        rating: ratingM ? parseFloat(ratingM[1]) : null,
        eta: etaM ? etaM[1]?.trim() : null
      };
    });

    // Step 4: Sequential store page visits (prevents memory crashes)
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
        await storePage.waitForSelector('[class*="menuItem"], [class*="MenuItem"], [class*="menu-item"]', { timeout: 6000 }).catch(() => {});

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
            const lineL = lines[i].toLowerCase();
            if (!dishWords.some(w => lineL.includes(w))) continue;
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
        const deliveryFee = data.deliveryFee ?? store.deliveryFee;
        console.log(`[${platform}] ${store.name}: ${data.items.length} items, fee: $${deliveryFee}, rating: ${store.rating}, eta: ${store.eta}`);

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
