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
  const encodedDish = encodeURIComponent(dish);

  try {
    // Step 1: Set address first
    console.log(`[${platform}] Setting address: ${address}`);
    await page.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout });
    await page.waitForTimeout(2500);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(600);

    const addressInput = await page.$('input[placeholder*="Enter delivery address"], input[placeholder*="delivery address"]');
    if (addressInput) {
      await addressInput.click({ force: true });
      await addressInput.fill('');
      await addressInput.type(address, { delay: 40 });
      await page.waitForTimeout(1800);
      const suggestion = await page.$('li[role="option"]:first-child, [data-testid="suggestion-item"]:first-child');
      if (suggestion) { await suggestion.click({ force: true }); }
      else { await page.keyboard.press('ArrowDown'); await page.waitForTimeout(300); await page.keyboard.press('Enter'); }
      await page.waitForTimeout(2500);
      console.log(`[${platform}] URL after address: ${page.url()}`);
    }

    // Step 2: Search
    await page.goto(`${baseUrl}/food-delivery/search?queryText=${encodedDish}`, { waitUntil: 'domcontentloaded', timeout });
    await page.waitForTimeout(4000);
    console.log(`[${platform}] Search URL: ${page.url()}`);

    // Step 3: Parse restaurant cards via text content
    await page.waitForSelector('a[href*="/restaurant/"]', { timeout: 15000 })
      .catch(() => console.log(`[${platform}] No restaurant links found`));

    const rawCards = await page.evaluate(() => {
      const cards = document.querySelectorAll('a[href*="/restaurant/"], [class*="restaurant-card"], [class*="RestaurantCard"]');
      return Array.from(cards).slice(0, 12).map(card => {
        const text = card.innerText || '';
        const href = card.tagName === 'A' ? card.getAttribute('href') : card.querySelector('a')?.getAttribute('href');
        const name = (card.querySelector('h3, h4, [class*="name"]')?.innerText?.trim()) || text.split('\n')[0]?.trim();
        return { text, href, name };
      }).filter(c => c.name && c.name.length > 2 && !c.name.includes('$'));
    });

    console.log(`[${platform}] Raw cards: ${rawCards.length}`);
    if (rawCards.length > 0) console.log(`[${platform}] Sample: ${rawCards[0].text.substring(0, 200)}`);

    for (const card of rawCards) {
      const text = card.text;

      let deliveryFee = null;
      if (/free/i.test(text)) deliveryFee = 0;
      else {
        const feeMatch = text.match(/\$(\d+\.?\d*)\s*(?:delivery|fee)/i) || text.match(/(?:delivery|fee)[:\s]+\$(\d+\.?\d*)/i);
        if (feeMatch) deliveryFee = parseFloat(feeMatch[1]);
      }

      let rating = null;
      const ratingMatch = text.match(/\b(4\.\d|5\.0|3\.\d)\b/);
      if (ratingMatch) rating = parseFloat(ratingMatch[1]);

      let eta = null;
      const etaMatch = text.match(/(\d+[\s–\-]+\d+\s*min|\d+\s*min)/i);
      if (etaMatch) eta = etaMatch[1];

      console.log(`[${platform}] ${card.name} | fee: ${deliveryFee} | rating: ${rating} | eta: ${eta}`);

      // Step 4: Get item price from restaurant page
      let itemPrice = null;
      if (card.href) {
        try {
          const storeUrl = card.href.startsWith('http') ? card.href : `${baseUrl}${card.href}`;
          const storePage = await context.newPage();
          await storePage.goto(storeUrl, { waitUntil: 'domcontentloaded', timeout: 25000 });
          await storePage.waitForTimeout(3000);

          const priceData = await storePage.evaluate((searchDish) => {
            const dishLower = searchDish.toLowerCase();
            const lines = document.body.innerText.split('\n').map(l => l.trim()).filter(l => l);
            const matches = [];
            for (let i = 0; i < lines.length; i++) {
              if (lines[i].toLowerCase().includes(dishLower)) {
                const window = lines.slice(Math.max(0, i-1), i+4).join(' ');
                const priceMatch = window.match(/\$(\d+\.\d{2})/);
                if (priceMatch) matches.push({ context: window.substring(0, 80), price: priceMatch[1] });
              }
            }
            return matches.slice(0, 3);
          }, dish);

          if (priceData.length > 0) {
            itemPrice = parseFloat(priceData[0].price);
            console.log(`[${platform}] ${card.name} price: $${itemPrice}`);
          }
          await storePage.close();
        } catch(e) {
          console.log(`[${platform}] Price fetch failed for ${card.name}: ${e.message.split('\n')[0]}`);
        }
      }

      const total = (itemPrice != null && deliveryFee != null) ? parseFloat((itemPrice + deliveryFee).toFixed(2)) : null;
      results.push({ platform, restaurant: card.name, item: dish, itemPrice, deliveryFee, totalPrice: total, rating, eta, url: page.url() });
    }

    console.log(`[${platform}] Final results: ${results.length}`);
  } catch (err) {
    console.error(`[${platform}] Scrape error:`, err.message.split('\n')[0]);
  } finally {
    await browser.close();
  }
  return results;
}

async function scrapeSeamless(params) {
  return scrapeGrubHub({ ...params, platform: 'Seamless' });
}

module.exports = { scrapeGrubHub, scrapeSeamless };
