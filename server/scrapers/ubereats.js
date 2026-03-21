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

    // Step 3: Get store cards from HTML — delivery fee is rendered in the card text
    await page.waitForSelector('[data-testid="store-card"], a[href*="/store/"]', { timeout: 12000 }).catch(() => {});

    const rawCards = await page.evaluate(() => {
      const seen = new Set();
      const out = [];
      // Use data-testid cards first as they have the most complete info
      const cards = document.querySelectorAll('[data-testid="store-card"]');
      for (const card of cards) {
        const link = card.querySelector('a[href*="/store/"]');
        const href = link?.getAttribute('href');
        if (!href || seen.has(href)) continue;
        seen.add(href);

        // Get full text content
        const text = card.innerText || '';
        const lines = text.split('\n').map(l => l.trim()).filter(l => l.length > 0);

        // Name is usually the first substantial line
        const name = lines[0];

        // Find delivery fee - look for patterns like "$0.99 Delivery Fee", "Free Delivery"
        let deliveryFeeText = null;
        for (const line of lines) {
          if (/delivery fee/i.test(line) || /free delivery/i.test(line)) {
            deliveryFeeText = line;
            break;
          }
        }

        // Find ETA - look for patterns like "20–30 min", "25 min"  
        let etaText = null;
        for (const line of lines) {
          if (/\d+\s*(?:–|-)\s*\d+\s*min|\d+\s*min/i.test(line)) {
            etaText = line;
            break;
          }
        }

        // Find rating - look for patterns like "4.6 (500+)"
        let ratingText = null;
        for (const line of lines) {
          if (/^[45]\.\d/.test(line)) {
            ratingText = line;
            break;
          }
        }

        console.log(`Card: ${name} | fee: ${deliveryFeeText} | eta: ${etaText} | rating: ${ratingText}`);
        out.push({ text, href, name, deliveryFeeText, etaText, ratingText, lines: lines.slice(0, 10) });
        if (out.length >= 8) break;
      }
      return out;
    });

    console.log(`[UberEats] Found ${rawCards.length} store cards`);
    if (rawCards.length > 0) {
      console.log(`[UberEats] Sample card lines: ${JSON.stringify(rawCards[0].lines)}`);
    }

    // Parse delivery fee, eta, rating from card text
    const storeData = rawCards.map(card => {
      // Delivery fee
      let deliveryFee = null;
      if (card.deliveryFeeText) {
        if (/free/i.test(card.deliveryFeeText)) {
          deliveryFee = 0;
        } else {
          const m = card.deliveryFeeText.match(/\$(\d+\.?\d*)/);
          if (m) deliveryFee = parseFloat(m[1]);
        }
      }

      // ETA
      let eta = null;
      if (card.etaText) {
        const m = card.etaText.match(/(\d+[\s–\-]+\d+\s*min|\d+\s*min)/i);
        if (m) eta = m[1].trim();
      }

      // Rating
      let rating = null;
      if (card.ratingText) {
        const m = card.ratingText.match(/([45]\.\d)/);
        if (m) rating = parseFloat(m[1]);
      }

      // Also try to extract from full text as fallback
      if (deliveryFee === null) {
        if (/free delivery/i.test(card.text)) deliveryFee = 0;
        else {
          const m = card.text.match(/\$(\d+\.?\d*)\s*delivery fee/i);
          if (m) deliveryFee = parseFloat(m[1]);
        }
      }
      if (eta === null) {
        const m = card.text.match(/(\d+[\s–\-]+\d+\s*min|\d+\s*min)/i);
        if (m) eta = m[1].trim();
      }
      if (rating === null) {
        const m = card.text.match(/\b([45]\.\d)\b/);
        if (m) rating = parseFloat(m[1]);
      }

      return { name: card.name, href: card.href, deliveryFee, eta, rating };
    });

    // Step 4: Get item prices in parallel
    const itemPromises = storeData.map(async (store) => {
      if (!store.href) return [];
      try {
        const storeUrl = store.href.startsWith('http') ? store.href : `https://www.ubereats.com${store.href}`;
        const storePage = await context.newPage();
        await storePage.goto(storeUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
        await storePage.waitForTimeout(2500);

        const items = await storePage.evaluate((searchDish) => {
          const dishWords = searchDish.toLowerCase().split(' ').filter(w => w.length > 2);
          const results = [];
          const lines = document.body.innerText.split('\n').map(l => l.trim()).filter(l => l);

          for (let i = 0; i < lines.length - 1; i++) {
            if (!dishWords.some(w => lines[i].toLowerCase().includes(w))) continue;
            // Skip lines that are clearly descriptions/promo text (too long)
            if (lines[i].length > 80) continue;
            // Look for price on next 1-3 lines
            for (let j = i + 1; j <= Math.min(i + 3, lines.length - 1); j++) {
              // Price must be standalone like "$12.99" not embedded in text
              const m = lines[j].match(/^\$(\d+\.\d{2})$/) || lines[j].match(/^\$(\d+)$/);
              if (m) {
                const price = parseFloat(m[1]);
                if (price > 1 && price < 150) {
                  results.push({ name: lines[i].substring(0, 70), price });
                  break;
                }
              }
            }
          }

          // Dedup
          const seen = new Set();
          return results.filter(r => {
            const key = `${r.name}|${r.price}`;
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
          }).slice(0, 4);
        }, dish);

        await storePage.close();
        console.log(`[UberEats] ${store.name}: ${items.length} items, fee: ${store.deliveryFee}, eta: ${store.eta}`);
        return items;
      } catch(e) {
        console.log(`[UberEats] Store failed ${store.name}: ${e.message.split('\n')[0]}`);
        return [];
      }
    });

    const allItems = await Promise.all(itemPromises);

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
        // Always include restaurant even without item price
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
