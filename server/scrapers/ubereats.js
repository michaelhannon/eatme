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
    await page.waitForTimeout(3500);

    await page.waitForSelector('[data-testid="store-card"], a[href*="/store/"]', { timeout: 12000 }).catch(() => {});

    // Step 3: Get store cards
    // Log structure: ["Chuck E. Cheese","4.6","(28)","•","49 min"] — no delivery fee shown without login
    const rawCards = await page.evaluate(() => {
      const seen = new Set();
      const out = [];
      const cards = document.querySelectorAll('[data-testid="store-card"]');
      for (const card of cards) {
        const link = card.querySelector('a[href*="/store/"]');
        const href = link?.getAttribute('href');
        if (!href || seen.has(href)) continue;
        seen.add(href);
        const lines = (card.innerText || '').split('\n').map(l => l.trim()).filter(l => l.length > 0);
        const name = lines[0];
        if (!name || name.length < 2) continue;

        // Rating: line that looks like "4.6"
        const ratingLine = lines.find(l => /^[45]\.\d$/.test(l));
        // ETA: line that contains "min"
        const etaLine = lines.find(l => /\d+\s*(?:–|-|−)\s*\d+\s*min|\d+\s*min/i.test(l));

        out.push({ href, name, ratingLine, etaLine, lines });
        if (out.length >= 8) break;
      }
      return out;
    });

    console.log(`[UberEats] Found ${rawCards.length} store cards`);
    if (rawCards[0]) console.log(`[UberEats] Sample lines: ${JSON.stringify(rawCards[0].lines)}`);

    const storeData = rawCards.map(card => {
      const rating = card.ratingLine ? parseFloat(card.ratingLine) : null;
      const eta = card.etaLine ? card.etaLine.trim() : null;
      return { name: card.name, href: card.href, rating, eta };
    });

    // Step 4: Parallel store page visits — get items AND delivery fee from store page
    const itemPromises = storeData.map(async (store) => {
      if (!store.href) return { items: [], deliveryFee: null };
      try {
        const storeUrl = store.href.startsWith('http') ? store.href : `https://www.ubereats.com${store.href}`;
        const storePage = await context.newPage();
        await storePage.goto(storeUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
        await storePage.waitForTimeout(2500);

        const data = await storePage.evaluate((searchDish) => {
          const dishWords = searchDish.toLowerCase().split(' ').filter(w => w.length > 2);
          const allText = document.body.innerText;
          const lines = allText.split('\n').map(l => l.trim()).filter(l => l);

          // Extract delivery fee from store page
          let deliveryFee = null;
          for (const line of lines) {
            if (/free delivery/i.test(line)) { deliveryFee = 0; break; }
            if (/delivery fee/i.test(line)) {
              const m = line.match(/\$(\d+\.?\d*)/);
              if (m) { deliveryFee = parseFloat(m[1]); break; }
            }
          }
          // Also check for pattern like "$0.49 • 28–38 min"  
          if (deliveryFee === null) {
            const feePattern = allText.match(/\$(\d+\.\d{2})\s*(?:delivery|•)/i);
            if (feePattern) deliveryFee = parseFloat(feePattern[1]);
          }

          // Extract matching menu items
          const items = [];
          for (let i = 0; i < lines.length - 1; i++) {
            if (!dishWords.some(w => lines[i].toLowerCase().includes(w))) continue;
            if (lines[i].length > 80) continue; // skip long descriptions
            // Look for standalone price on next 1-3 lines
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

          // Dedup items
          const seen = new Set();
          const dedupedItems = items.filter(r => {
            const key = `${r.name}|${r.price}`;
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
          }).slice(0, 4);

          return { deliveryFee, items: dedupedItems };
        }, dish);

        await storePage.close();
        console.log(`[UberEats] ${store.name}: ${data.items.length} items, fee: $${data.deliveryFee}, eta: ${store.eta}`);
        return data;
      } catch(e) {
        console.log(`[UberEats] Store failed ${store.name}: ${e.message.split('\n')[0]}`);
        return { items: [], deliveryFee: null };
      }
    });

    const allData = await Promise.all(itemPromises);

    storeData.forEach((store, i) => {
      const { items, deliveryFee } = allData[i];
      if (items.length > 0) {
        items.forEach(item => {
          const total = deliveryFee != null ? parseFloat((item.price + deliveryFee).toFixed(2)) : null;
          results.push({ platform: 'Uber Eats', restaurant: store.name, item: item.name, itemPrice: item.price, deliveryFee, totalPrice: total, rating: store.rating, eta: store.eta, url: `https://www.ubereats.com${store.href}` });
        });
      } else {
        results.push({ platform: 'Uber Eats', restaurant: store.name, item: dish, itemPrice: null, deliveryFee, totalPrice: null, rating: store.rating, eta: store.eta, url: `https://www.ubereats.com${store.href}` });
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
