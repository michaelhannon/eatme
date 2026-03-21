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
    // Step 1: Set address first
    console.log(`[DoorDash] Setting address: ${address}`);
    await page.goto('https://www.doordash.com', { waitUntil: 'domcontentloaded', timeout });
    await page.waitForTimeout(2500);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(800);

    const addressInput = await page.$('#HomeAddressAutocomplete, input[placeholder*="delivery address"], input[placeholder*="Enter delivery"]');
    if (addressInput) {
      await addressInput.click({ force: true });
      await addressInput.fill('');
      await addressInput.type(address, { delay: 40 });
      await page.waitForTimeout(1800);
      const suggestion = await page.$('li[role="option"]:first-child, [id*="Suggestion"]:first-child');
      if (suggestion) { await suggestion.click({ force: true }); }
      else { await page.keyboard.press('ArrowDown'); await page.waitForTimeout(300); await page.keyboard.press('Enter'); }
      await page.waitForTimeout(2500);
      console.log(`[DoorDash] URL after address: ${page.url()}`);
    }

    // Step 2: Search
    const encodedDish = encodeURIComponent(dish);
    await page.goto(`https://www.doordash.com/search/store/${encodedDish}/`, { waitUntil: 'domcontentloaded', timeout });
    await page.waitForTimeout(4000);
    console.log(`[DoorDash] Search URL: ${page.url()}`);

    // Step 3: Parse store cards using text content — CSS classes change too often
    await page.waitForSelector('a[href*="/store/"]', { timeout: 15000 })
      .catch(() => console.log('[DoorDash] No store links found'));

    const rawCards = await page.evaluate(() => {
      const cards = document.querySelectorAll('a[href*="/store/"]');
      return Array.from(cards).slice(0, 12).map(card => {
        const text = card.innerText || '';
        const href = card.getAttribute('href');
        const nameEl = card.querySelector('h3, h4, span[data-anchor-id*="Name"]');
        const name = nameEl?.innerText?.trim() || text.split('\n')[0]?.trim();
        return { text, href, name };
      }).filter(c => c.name && c.name.length > 2 && !c.name.includes('$'));
    });

    console.log(`[DoorDash] Raw cards: ${rawCards.length}`);
    if (rawCards.length > 0) console.log(`[DoorDash] Sample: ${rawCards[0].text.substring(0, 200)}`);

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

      console.log(`[DoorDash] ${card.name} | fee: ${deliveryFee} | rating: ${rating} | eta: ${eta}`);

      // Step 4: Get item price from store page
      let itemPrice = null;
      if (card.href) {
        try {
          const storeUrl = `https://www.doordash.com${card.href}`;
          const storePage = await context.newPage();
          await storePage.goto(storeUrl, { waitUntil: 'domcontentloaded', timeout: 25000 });
          await storePage.waitForTimeout(3000);

          const priceData = await storePage.evaluate((searchDish) => {
            const dishLower = searchDish.toLowerCase();
            const allText = document.body.innerText;
            const lines = allText.split('\n').map(l => l.trim()).filter(l => l);
            const matches = [];
            for (let i = 0; i < lines.length; i++) {
              if (lines[i].toLowerCase().includes(dishLower)) {
                // Look at surrounding lines for a price
                const window = lines.slice(Math.max(0, i-1), i+4).join(' ');
                const priceMatch = window.match(/\$(\d+\.\d{2})/);
                if (priceMatch) matches.push({ context: window.substring(0, 80), price: priceMatch[1] });
              }
            }
            return matches.slice(0, 3);
          }, dish);

          if (priceData.length > 0) {
            itemPrice = parseFloat(priceData[0].price);
            console.log(`[DoorDash] ${card.name} price: $${itemPrice} | ctx: ${priceData[0].context}`);
          }
          await storePage.close();
        } catch(e) {
          console.log(`[DoorDash] Price fetch failed for ${card.name}: ${e.message.split('\n')[0]}`);
        }
      }

      const total = (itemPrice != null && deliveryFee != null) ? parseFloat((itemPrice + deliveryFee).toFixed(2)) : null;
      results.push({ platform: 'DoorDash', restaurant: card.name, item: dish, itemPrice, deliveryFee, totalPrice: total, rating, eta, url: page.url() });
    }

    console.log(`[DoorDash] Final results: ${results.length}`);
  } catch (err) {
    console.error('[DoorDash] Scrape error:', err.message.split('\n')[0]);
  } finally {
    await browser.close();
  }
  return results;
}

module.exports = { scrapeDoorDash };
