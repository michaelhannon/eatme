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

    await page.waitForSelector('[data-testid="store-card"]', { timeout: 12000 }).catch(() => {});

    // Step 3: Grab top 5 store cards
    const rawCards = await page.evaluate(() => {
      const cards = document.querySelectorAll('[data-testid="store-card"], a[href*="/store/"]');
      return Array.from(cards).slice(0, 5).map(card => {
        const text = card.innerText || '';
        const href = card.tagName === 'A' ? card.getAttribute('href') : card.querySelector('a')?.getAttribute('href');
        const nameEl = card.querySelector('h3, h4, [data-testid="store-name"]');
        const name = nameEl?.innerText?.trim() || text.split('\n')[0]?.trim();
        return { text, href, name };
      }).filter(c => c.name && c.name.length > 2 && !c.name.includes('$'));
    });

    console.log(`[UberEats] Found ${rawCards.length} stores`);

    // Parse card-level data
    const storeData = rawCards.map(card => {
      const text = card.text;
      let deliveryFee = /free delivery/i.test(text) ? 0 : null;
      if (deliveryFee === null) {
        const m = text.match(/\$(\d+\.?\d*)\s*(?:delivery|fee)/i) || text.match(/(?:delivery|fee)[:\s]+\$(\d+\.?\d*)/i);
        if (m) deliveryFee = parseFloat(m[1]);
      }
      const ratingM = text.match(/\b([45]\.\d)\b/);
      const etaM = text.match(/(\d+[\s–\-]+\d+\s*min|\d+\s*min)/i);
      return { ...card, deliveryFee, rating: ratingM ? parseFloat(ratingM[1]) : null, eta: etaM ? etaM[1] : null };
    });

    // Step 4: Fetch prices IN PARALLEL (max 5 concurrent)
    const pricePromises = storeData.map(async (store) => {
      if (!store.href) return null;
      try {
        const storeUrl = store.href.startsWith('http') ? store.href : `https://www.ubereats.com${store.href}`;
        const storePage = await context.newPage();
        await storePage.goto(storeUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
        await storePage.waitForTimeout(2000);

        const price = await storePage.evaluate((searchDish) => {
          const dishLower = searchDish.toLowerCase().split(' ')[0];
          const lines = document.body.innerText.split('\n').map(l => l.trim()).filter(l => l);
          for (let i = 0; i < lines.length; i++) {
            if (lines[i].toLowerCase().includes(dishLower)) {
              const nearby = lines.slice(Math.max(0,i-1), i+4).join(' ');
              const m = nearby.match(/\$(\d+\.\d{2})/);
              if (m) return parseFloat(m[1]);
            }
          }
          return null;
        }, dish);

        await storePage.close();
        console.log(`[UberEats] ${store.name}: $${price}`);
        return price;
      } catch(e) {
        console.log(`[UberEats] Price failed for ${store.name}: ${e.message.split('\n')[0]}`);
        return null;
      }
    });

    const prices = await Promise.all(pricePromises);

    storeData.forEach((store, i) => {
      const itemPrice = prices[i];
      const total = itemPrice != null && store.deliveryFee != null ? parseFloat((itemPrice + store.deliveryFee).toFixed(2)) : null;
      results.push({ platform: 'Uber Eats', restaurant: store.name, item: dish, itemPrice, deliveryFee: store.deliveryFee, totalPrice: total, rating: store.rating, eta: store.eta, url: page.url() });
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
