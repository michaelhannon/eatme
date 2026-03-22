const { chromium } = require('playwright');
const { fetchStoreItems } = require('./grubhub');

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
  await context.addInitScript(() => { Object.defineProperty(navigator, 'webdriver', { get: () => undefined }); });

  const page = await context.newPage();
  const results = [];

  try {
    // Set address
    await page.goto('https://www.ubereats.com', { waitUntil: 'domcontentloaded', timeout });
    await page.waitForTimeout(2500);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(400);

    await page.waitForFunction(() =>
      Array.from(document.querySelectorAll('input[type="text"], input:not([type])')).some(i => i.offsetWidth > 0 && i.offsetHeight > 0),
      { timeout: 8000 }
    ).catch(() => {});

    const inputHandle = await page.evaluateHandle(() =>
      Array.from(document.querySelectorAll('input[type="text"], input:not([type])')).find(i => i.offsetWidth > 0 && i.offsetHeight > 0) || null
    );
    const addressInput = inputHandle.asElement();
    if (addressInput) {
      await addressInput.click({ force: true });
      await addressInput.fill('');
      await addressInput.type(address, { delay: 50 });
      await page.waitForTimeout(2000);
      await page.waitForSelector('li[role="option"]', { timeout: 5000 }).catch(() => {});

      const suggestions = await page.evaluate(() =>
        Array.from(document.querySelectorAll('li[role="option"]')).slice(0,3).map(s => s.innerText?.substring(0,60))
      );
      console.log(`[UberEats] Suggestions: ${JSON.stringify(suggestions)}`);

      const suggestion = await page.$('li[role="option"]:first-child');
      if (suggestion) { await suggestion.click({ force: true }); console.log('[UberEats] Address set'); }
      else { await page.keyboard.press('ArrowDown'); await page.waitForTimeout(300); await page.keyboard.press('Enter'); }
      await page.waitForTimeout(1500);
      const confirmBtn = await page.$('button:has-text("Deliver here"), button:has-text("Confirm")');
      if (confirmBtn) { await confirmBtn.click({ force: true }); await page.waitForTimeout(500); }
      console.log(`[UberEats] URL after address: ${page.url()}`);
    }

    // Search
    await page.goto(`https://www.ubereats.com/search?q=${encodeURIComponent(dish)}`, { waitUntil: 'domcontentloaded', timeout });
    await page.waitForTimeout(3500);
    await page.waitForSelector('[data-testid="store-card"], a[href*="/store/"]', { timeout: 10000 }).catch(() => {});

    const rawCards = await page.evaluate(() => {
      const seen = new Set();
      const out = [];
      for (const card of document.querySelectorAll('[data-testid="store-card"]')) {
        const link = card.querySelector('a[href*="/store/"]');
        const href = link?.getAttribute('href');
        if (!href || seen.has(href)) continue;
        seen.add(href);
        const fullText = card.innerText || '';
        const lines = fullText.split('\n').map(l => l.trim()).filter(l => l.length > 0);
        const name = lines[0];
        if (!name || name.length < 2) continue;
        const ratingLine = lines.find(l => /^[45]\.\d$/.test(l));
        const etaMatch = fullText.match(/(\d+[\s\u2013\-]+\d+\s*min|\d+\s*min)/i);
        out.push({ href, name, ratingLine, eta: etaMatch?.[1]?.trim() || null, deliveryFee: null });
        if (out.length >= 8) break;
      }
      return out;
    });

    console.log(`[UberEats] Found ${rawCards.length} store cards`);

    const storeData = rawCards.map(card => ({
      name: card.name, href: card.href,
      rating: card.ratingLine ? parseFloat(card.ratingLine) : null,
      eta: card.eta, deliveryFee: null
    }));

    // 3 parallel store visits per batch
    const CONCURRENCY = 3;
    for (let i = 0; i < storeData.length; i += CONCURRENCY) {
      const batch = storeData.slice(i, i + CONCURRENCY);
      const batchResults = await Promise.all(batch.map(store => fetchStoreItems(context, store, dish, 'UberEats', 'https://www.ubereats.com')));
      batchResults.forEach(({ store, items, deliveryFee }) => {
        if (items.length > 0) {
          items.forEach(item => {
            const fee = deliveryFee ?? 0;
            results.push({ platform: 'Uber Eats', restaurant: store.name, item: item.name, itemPrice: item.price, deliveryFee: fee, totalPrice: parseFloat((item.price + fee).toFixed(2)), rating: store.rating, eta: store.eta, url: `https://www.ubereats.com${store.href}` });
          });
        }
      });
    }

  } catch(e) {
    console.error('[UberEats] Error:', e.message.split('\n')[0]);
  } finally {
    await browser.close();
  }
  console.log(`[UberEats] Done: ${results.length} results`);
  return results;
}

module.exports = { scrapeUberEats };
