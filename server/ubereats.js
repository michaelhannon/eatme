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

    // Step 2: Search
    await page.goto(`https://www.ubereats.com/search?q=${encodeURIComponent(dish)}`, { waitUntil: 'domcontentloaded', timeout });
    await page.waitForTimeout(3000);
    console.log(`[UberEats] Search URL: ${page.url()}`);

    await page.waitForSelector('[data-testid="store-card"], a[href*="/store/"]', { timeout: 12000 }).catch(() => {});

    // Step 3: Grab top 8 store cards (show all even without prices)
    const rawCards = await page.evaluate(() => {
      const seen = new Set();
      const cards = document.querySelectorAll('[data-testid="store-card"], a[href*="/store/"]');
      const out = [];
      for (const card of cards) {
        const href = card.tagName === 'A' ? card.getAttribute('href') : card.querySelector('a[href*="/store/"]')?.getAttribute('href');
        if (!href || seen.has(href)) continue;
        seen.add(href);
        const text = card.innerText || '';
        const nameEl = card.querySelector('h3, h4, [data-testid="store-name"]');
        const name = nameEl?.innerText?.trim() || text.split('\n').find(l => l.trim().length > 2 && !l.includes('$'));
        if (name && name.length > 2) {
          out.push({ text, href, name: name.trim() });
          if (out.length >= 8) break;
        }
      }
      return out;
    });

    console.log(`[UberEats] Found ${rawCards.length} stores`);

    // Parse card-level data
    const storeData = rawCards.map(card => {
      const text = card.text;
      let deliveryFee = /free delivery/i.test(text) ? 0 : null;
      if (deliveryFee === null) {
        const m = text.match(/\$(\d+\.?\d*)\s*(?:delivery fee|delivery)/i);
        if (m) deliveryFee = parseFloat(m[1]);
      }
      const ratingM = text.match(/\b([45]\.\d)\b/);
      const etaM = text.match(/(\d+[\s–\-]+\d+\s*min|\d+\s*min)/i);
      return { ...card, deliveryFee, rating: ratingM ? parseFloat(ratingM[1]) : null, eta: etaM ? etaM[1] : null };
    });

    // Step 4: Fetch ALL matching items from each store IN PARALLEL
    const itemPromises = storeData.map(async (store) => {
      if (!store.href) return [];
      try {
        const storeUrl = store.href.startsWith('http') ? store.href : `https://www.ubereats.com${store.href}`;
        const storePage = await context.newPage();
        await storePage.goto(storeUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
        await storePage.waitForTimeout(2500);

        // Extract ALL menu items that match the dish
        const items = await storePage.evaluate((searchDish) => {
          const dishWords = searchDish.toLowerCase().split(' ').filter(w => w.length > 2);
          const results = [];

          // Strategy: find all elements that look like menu item containers
          // Look for patterns: item name on one line, price nearby
          const allElements = document.querySelectorAll('[data-testid="menu-item"], [class*="MenuItem"], li[class*="item"], [class*="item-card"]');

          allElements.forEach(el => {
            const text = el.innerText || '';
            const lines = text.split('\n').map(l => l.trim()).filter(l => l);
            const hasMatch = dishWords.some(word => text.toLowerCase().includes(word));
            if (!hasMatch) return;

            // Find the item name (first meaningful line)
            const name = lines.find(l => l.length > 2 && !l.match(/^\$/) && !l.match(/^\d+$/));
            // Find the price (line starting with $)
            const priceLine = lines.find(l => l.match(/^\$\d+\.\d{2}$/) || l.match(/^\$\d+$/));
            const price = priceLine ? parseFloat(priceLine.replace('$', '')) : null;

            if (name && price && price > 1 && price < 100) {
              results.push({ name, price });
            }
          });

          // Fallback: text line parsing if no structured elements found
          if (results.length === 0) {
            const allText = document.body.innerText;
            const lines = allText.split('\n').map(l => l.trim()).filter(l => l);
            for (let i = 0; i < lines.length - 1; i++) {
              const hasMatch = dishWords.some(word => lines[i].toLowerCase().includes(word));
              if (!hasMatch) continue;
              // Look at the next few lines for a price
              for (let j = i + 1; j <= Math.min(i + 3, lines.length - 1); j++) {
                const priceMatch = lines[j].match(/^\$(\d+\.\d{2})$/) || lines[j].match(/^\$(\d+)$/);
                if (priceMatch) {
                  const price = parseFloat(priceMatch[1]);
                  if (price > 1 && price < 100) {
                    results.push({ name: lines[i], price });
                    break;
                  }
                }
              }
            }
          }

          // Deduplicate
          const seen = new Set();
          return results.filter(r => {
            const key = `${r.name}|${r.price}`;
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
          }).slice(0, 5); // max 5 items per restaurant
        }, dish);

        await storePage.close();
        console.log(`[UberEats] ${store.name}: ${items.length} items found`);
        return items;
      } catch(e) {
        console.log(`[UberEats] Item fetch failed for ${store.name}: ${e.message.split('\n')[0]}`);
        return [];
      }
    });

    const allItems = await Promise.all(itemPromises);

    // Build results — one row per item, or one row per store if no items found
    storeData.forEach((store, i) => {
      const items = allItems[i];
      if (items.length > 0) {
        items.forEach(item => {
          const total = store.deliveryFee != null ? parseFloat((item.price + store.deliveryFee).toFixed(2)) : null;
          results.push({
            platform: 'Uber Eats',
            restaurant: store.name,
            item: item.name,
            itemPrice: item.price,
            deliveryFee: store.deliveryFee,
            totalPrice: total,
            rating: store.rating,
            eta: store.eta,
            url: `https://www.ubereats.com${store.href}`
          });
        });
      } else {
        // Still show the restaurant even without item prices
        results.push({
          platform: 'Uber Eats',
          restaurant: store.name,
          item: dish,
          itemPrice: null,
          deliveryFee: store.deliveryFee,
          totalPrice: null,
          rating: store.rating,
          eta: store.eta,
          url: `https://www.ubereats.com${store.href}`
        });
      }
    });

    console.log(`[UberEats] Done: ${results.length} results`);
  } catch (err) {
    console.error('[UberEats] Error:', err.message.split('\n')[0]);
  } finally {
    await browser.close();
  }
  return results;
}

module.exports = { scrapeUberEats };
