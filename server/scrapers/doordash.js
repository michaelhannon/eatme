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

  try {
    // DoorDash Strategy: Use their consumer API directly
    // After setting address cookie, search returns JSON we can use
    // First: navigate to homepage, set address, then use their internal search

    console.log(`[DoorDash] Loading with address via URL params...`);

    // DoorDash supports delivery address in URL for some pages
    // Try consumer-facing search that works without login
    const encodedDish = encodeURIComponent(dish);

    // Navigate to homepage first to establish session
    await page.goto('https://www.doordash.com', { waitUntil: 'domcontentloaded', timeout });
    await page.waitForTimeout(3000);

    // Dismiss any modal/overlay aggressively
    for (let i = 0; i < 3; i++) {
      await page.keyboard.press('Escape');
      await page.waitForTimeout(300);
    }

    // Try clicking away from modal
    await page.mouse.click(640, 50);
    await page.waitForTimeout(500);

    // Look for address input with very broad selector
    const inputHandle = await page.evaluateHandle(() => {
      // Find any visible input
      const inputs = Array.from(document.querySelectorAll('input'));
      return inputs.find(i => i.offsetWidth > 0 && i.offsetHeight > 0) || null;
    });

    if (inputHandle && inputHandle.asElement()) {
      const el = inputHandle.asElement();
      const placeholder = await el.evaluate(e => e.placeholder);
      console.log(`[DoorDash] Found input with placeholder: "${placeholder}"`);

      await el.click({ force: true });
      await el.fill('');
      await el.type(address, { delay: 40 });
      await page.waitForTimeout(2000);

      // Log all suggestions
      const suggestions = await page.evaluate(() => {
        const items = document.querySelectorAll('li[role="option"], [id*="Suggestion"], [class*="suggestion"]');
        return Array.from(items).slice(0, 3).map(i => i.innerText?.substring(0, 60));
      });
      console.log(`[DoorDash] Suggestions: ${JSON.stringify(suggestions)}`);

      if (suggestions.length > 0) {
        const firstSuggestion = await page.$('li[role="option"]:first-child, [id*="Suggestion"]:first-child, [class*="suggestion"]:first-child');
        if (firstSuggestion) {
          await firstSuggestion.click({ force: true });
        } else {
          await page.keyboard.press('ArrowDown');
          await page.waitForTimeout(300);
          await page.keyboard.press('Enter');
        }
        await page.waitForTimeout(3000);
        console.log(`[DoorDash] URL after address: ${page.url()}`);
      }
    } else {
      console.log('[DoorDash] No visible input found on homepage');
    }

    // Now search
    console.log(`[DoorDash] Navigating to search...`);
    await page.goto(`https://www.doordash.com/search/store/${encodedDish}/`, { waitUntil: 'domcontentloaded', timeout });
    await page.waitForTimeout(4000);

    const searchUrl = page.url();
    console.log(`[DoorDash] Search URL: ${searchUrl}`);

    const preview = await page.evaluate(() => document.body.innerText.substring(0, 200));
    console.log(`[DoorDash] Preview: ${preview.substring(0, 150)}`);

    // Log ALL links to understand page structure
    const allStoreLinks = await page.evaluate(() => {
      const links = Array.from(document.querySelectorAll('a[href]'));
      return links
        .filter(l => l.href.includes('/store/'))
        .slice(0, 5)
        .map(l => ({ href: l.getAttribute('href'), text: l.innerText?.substring(0,40) }));
    });
    console.log(`[DoorDash] Store links: ${JSON.stringify(allStoreLinks)}`);

    // Also log any restaurant-like links
    const anyRestLinks = await page.evaluate(() => {
      const links = Array.from(document.querySelectorAll('a[href]'));
      return links
        .filter(l => {
          const h = l.getAttribute('href') || '';
          return !h.includes('#') && !h.includes('javascript') && h.length > 5 && l.innerText?.trim().length > 2;
        })
        .slice(0, 10)
        .map(l => ({ href: l.getAttribute('href')?.substring(0,60), text: l.innerText?.substring(0,30) }));
    });
    console.log(`[DoorDash] All notable links: ${JSON.stringify(anyRestLinks)}`);

    await page.waitForSelector('a[href*="/store/"]', { timeout: 12000 }).catch(() => console.log('[DoorDash] No store links found after wait'));

    const rawCards = await page.evaluate(() => {
      const seen = new Set();
      const out = [];

      // Try store links first
      const storeLinks = document.querySelectorAll('a[href*="/store/"]');
      for (const card of storeLinks) {
        const href = card.getAttribute('href');
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

      return out;
    });

    console.log(`[DoorDash] Found ${rawCards.length} stores`);

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

    // Sequential fetching to avoid memory crashes
    for (const store of storeData) {
      if (!store.href) {
        results.push({ platform: 'DoorDash', restaurant: store.name, item: dish, itemPrice: null, deliveryFee: store.deliveryFee, totalPrice: null, rating: store.rating, eta: store.eta, url: page.url() });
        continue;
      }
      try {
        const storeUrl = store.href.startsWith('http') ? store.href : `https://www.doordash.com${store.href}`;
        const storePage = await context.newPage();
        await storePage.goto(storeUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
        await storePage.waitForTimeout(3000);

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
            if (!dishWords.some(w => lines[i].toLowerCase().includes(w))) continue;
            if (lines[i].length > 80) continue;
            for (let j = i + 1; j <= Math.min(i + 3, lines.length - 1); j++) {
              const m = lines[j].match(/^\$(\d+\.\d{2})$/) || lines[j].match(/^\$(\d+)$/);
              if (m) { const price = parseFloat(m[1]); if (price > 1 && price < 150) { items.push({ name: lines[i].substring(0, 70), price }); break; } }
            }
          }
          const seen = new Set();
          return { deliveryFee, items: items.filter(r => { const k=`${r.name}|${r.price}`; if(seen.has(k))return false; seen.add(k); return true; }).slice(0, 4) };
        }, dish);

        await storePage.close();
        const deliveryFee = data.deliveryFee ?? store.deliveryFee;
        console.log(`[DoorDash] ${store.name}: ${data.items.length} items, fee: $${deliveryFee}`);

        if (data.items.length > 0) {
          data.items.forEach(item => {
            const total = deliveryFee != null ? parseFloat((item.price + deliveryFee).toFixed(2)) : null;
            results.push({ platform: 'DoorDash', restaurant: store.name, item: item.name, itemPrice: item.price, deliveryFee, totalPrice: total, rating: store.rating, eta: store.eta, url: page.url() });
          });
        } else {
          results.push({ platform: 'DoorDash', restaurant: store.name, item: dish, itemPrice: null, deliveryFee, totalPrice: null, rating: store.rating, eta: store.eta, url: page.url() });
        }
      } catch(e) {
        console.log(`[DoorDash] Store failed ${store.name}: ${e.message.split('\n')[0]}`);
        results.push({ platform: 'DoorDash', restaurant: store.name, item: dish, itemPrice: null, deliveryFee: store.deliveryFee, totalPrice: null, rating: store.rating, eta: store.eta, url: page.url() });
      }
    }

    console.log(`[DoorDash] Done: ${results.length} results`);
  } catch (err) {
    console.error('[DoorDash] Error:', err.message.split('\n')[0]);
  } finally {
    await browser.close();
  }
  return results;
}

module.exports = { scrapeDoorDash };
