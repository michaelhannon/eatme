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
    // Step 1: Set address
    console.log(`[DoorDash] Setting address...`);
    await page.goto('https://www.doordash.com', { waitUntil: 'domcontentloaded', timeout });
    await page.waitForTimeout(2000);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(600);

    const addressInput = await page.$('#HomeAddressAutocomplete, input[placeholder*="delivery address"], input[placeholder*="Enter delivery"]');
    if (addressInput) {
      await addressInput.click({ force: true });
      await addressInput.fill('');
      await addressInput.type(address, { delay: 40 });
      await page.waitForTimeout(1800);
      const suggestion = await page.$('li[role="option"]:first-child, [id*="Suggestion"]:first-child');
      if (suggestion) await suggestion.click({ force: true });
      else { await page.keyboard.press('ArrowDown'); await page.waitForTimeout(200); await page.keyboard.press('Enter'); }
      await page.waitForTimeout(2000);
      console.log(`[DoorDash] URL after address: ${page.url()}`);
    } else {
      console.log('[DoorDash] No address input found — trying to proceed anyway');
    }

    // Step 2: Search
    await page.goto(`https://www.doordash.com/search/store/${encodeURIComponent(dish)}/`, { waitUntil: 'domcontentloaded', timeout });
    await page.waitForTimeout(3500);
    console.log(`[DoorDash] Search URL: ${page.url()}`);
    const preview = await page.evaluate(() => document.body.innerText.substring(0, 200));
    console.log(`[DoorDash] Preview: ${preview}`);

    // Step 3: Get top 5 stores
    await page.waitForSelector('a[href*="/store/"]', { timeout: 12000 }).catch(() => {});

    const rawCards = await page.evaluate(() => {
      const seen = new Set();
      const cards = document.querySelectorAll('a[href*="/store/"]');
      const results = [];
      for (const card of cards) {
        const href = card.getAttribute('href');
        if (seen.has(href)) continue;
        seen.add(href);
        const text = card.innerText || '';
        const nameEl = card.querySelector('h3, h4, [data-anchor-id*="Name"]');
        const name = nameEl?.innerText?.trim() || text.split('\n')[0]?.trim();
        if (name && name.length > 2 && !name.includes('$')) {
          results.push({ text, href, name });
          if (results.length >= 5) break;
        }
      }
      return results;
    });

    console.log(`[DoorDash] Found ${rawCards.length} stores`);

    const storeData = rawCards.map(card => {
      const text = card.text;
      let deliveryFee = /free/i.test(text) ? 0 : null;
      if (deliveryFee === null) {
        const m = text.match(/\$(\d+\.?\d*)\s*(?:delivery|fee)/i) || text.match(/(?:delivery|fee)[:\s]+\$(\d+\.?\d*)/i);
        if (m) deliveryFee = parseFloat(m[1]);
      }
      const ratingM = text.match(/\b([45]\.\d)\b/);
      const etaM = text.match(/(\d+[\s–\-]+\d+\s*min|\d+\s*min)/i);
      return { ...card, deliveryFee, rating: ratingM ? parseFloat(ratingM[1]) : null, eta: etaM ? etaM[1] : null };
    });

    // Step 4: Fetch prices IN PARALLEL
    const pricePromises = storeData.map(async (store) => {
      if (!store.href) return null;
      try {
        const storeUrl = `https://www.doordash.com${store.href}`;
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
        console.log(`[DoorDash] ${store.name}: $${price}`);
        return price;
      } catch(e) {
        console.log(`[DoorDash] Price failed for ${store.name}: ${e.message.split('\n')[0]}`);
        return null;
      }
    });

    const prices = await Promise.all(pricePromises);

    storeData.forEach((store, i) => {
      const itemPrice = prices[i];
      const total = itemPrice != null && store.deliveryFee != null ? parseFloat((itemPrice + store.deliveryFee).toFixed(2)) : null;
      results.push({ platform: 'DoorDash', restaurant: store.name, item: dish, itemPrice, deliveryFee: store.deliveryFee, totalPrice: total, rating: store.rating, eta: store.eta, url: page.url() });
    });

    console.log(`[DoorDash] Done: ${results.length} results`);
  } catch (err) {
    console.error('[DoorDash] Error:', err.message.split('\n')[0]);
  } finally {
    await browser.close();
  }
  return results;
}

module.exports = { scrapeDoorDash };
