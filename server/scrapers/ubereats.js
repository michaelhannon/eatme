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
    // Step 1: Set address on homepage
    console.log(`[UberEats] Setting address: ${address}`);
    await page.goto('https://www.ubereats.com', { waitUntil: 'domcontentloaded', timeout });
    await page.waitForTimeout(2500);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(500);

    const addressInput = await page.$('input[type="text"]');
    if (addressInput) {
      await addressInput.click({ force: true });
      await addressInput.fill('');
      await addressInput.type(address, { delay: 40 });
      await page.waitForTimeout(2000);
      const suggestion = await page.$('li[role="option"]:first-child');
      if (suggestion) { await suggestion.click({ force: true }); }
      else { await page.keyboard.press('ArrowDown'); await page.waitForTimeout(300); await page.keyboard.press('Enter'); }
      await page.waitForTimeout(2000);
      const confirmBtn = await page.$('button:has-text("Deliver here"), button:has-text("Confirm")');
      if (confirmBtn) { await confirmBtn.click({ force: true }); await page.waitForTimeout(1000); }
      console.log(`[UberEats] URL after address: ${page.url()}`);
    }

    // Step 2: Search for dish
    const encodedDish = encodeURIComponent(dish);
    await page.goto(`https://www.ubereats.com/search?q=${encodedDish}`, { waitUntil: 'domcontentloaded', timeout });
    await page.waitForTimeout(4000);
    console.log(`[UberEats] Search URL: ${page.url()}`);

    // Step 3: Use data-testid store cards (most stable selector on Uber Eats)
    await page.waitForSelector('[data-testid="store-card"]', { timeout: 15000 })
      .catch(() => console.log('[UberEats] No data-testid store cards, trying fallback...'));

    // Dump full text of each card and parse with regex — works regardless of class names
    const rawCards = await page.evaluate(() => {
      // Try multiple card selectors
      const selectors = ['[data-testid="store-card"]', 'a[href*="/store/"]'];
      let cards = [];
      for (const sel of selectors) {
        const found = document.querySelectorAll(sel);
        if (found.length > 0) { cards = Array.from(found); break; }
      }

      return cards.slice(0, 12).map(card => {
        const text = card.innerText || '';
        const href = card.tagName === 'A' ? card.getAttribute('href') : card.querySelector('a')?.getAttribute('href');
        // Get the heading/restaurant name (usually first strong text or h3)
        const nameEl = card.querySelector('h3, h4, [data-testid="store-name"]') || card.querySelector('span[class]');
        const name = nameEl?.innerText?.trim() || text.split('\n')[0]?.trim();
        return { text, href, name };
      }).filter(c => c.name && c.name.length > 2);
    });

    console.log(`[UberEats] Raw cards found: ${rawCards.length}`);
    if (rawCards.length > 0) console.log(`[UberEats] Sample card text: ${rawCards[0].text.substring(0, 200)}`);

    for (const card of rawCards) {
      const text = card.text;

      // Parse delivery fee from card text
      let deliveryFee = null;
      if (/free delivery/i.test(text)) deliveryFee = 0;
      else {
        const feeMatch = text.match(/\$(\d+\.?\d*)\s*delivery/i) || text.match(/delivery[:\s]+\$(\d+\.?\d*)/i);
        if (feeMatch) deliveryFee = parseFloat(feeMatch[1]);
      }

      // Parse rating from card text (e.g. "4.7", "4.7 (500+)")
      let rating = null;
      const ratingMatch = text.match(/\b(4\.\d|5\.0|3\.\d)\b/);
      if (ratingMatch) rating = parseFloat(ratingMatch[1]);

      // Parse ETA (e.g. "25–35 min", "20 min")
      let eta = null;
      const etaMatch = text.match(/(\d+[\s–-]+\d+\s*min|\d+\s*min)/i);
      if (etaMatch) eta = etaMatch[1];

      console.log(`[UberEats] ${card.name} | fee: ${deliveryFee} | rating: ${rating} | eta: ${eta}`);

      // Step 4: Drill into store page for item price
      let itemPrice = null;
      if (card.href) {
        try {
          const storeUrl = card.href.startsWith('http') ? card.href : `https://www.ubereats.com${card.href}`;
          const storePage = await context.newPage();
          await storePage.goto(storeUrl, { waitUntil: 'domcontentloaded', timeout: 25000 });
          await storePage.waitForTimeout(3000);

          // Dump all menu item text and find dish match
          const menuText = await storePage.evaluate((searchDish) => {
            const dishLower = searchDish.toLowerCase();
            const items = document.querySelectorAll('[data-testid="menu-item"], [class*="item"], li');
            const matches = [];
            items.forEach(item => {
              const text = item.innerText || '';
              if (text.toLowerCase().includes(dishLower)) {
                // Extract price from this element's text
                const priceMatch = text.match(/\$(\d+\.?\d*)/);
                if (priceMatch) {
                  matches.push({ text: text.substring(0, 100), price: priceMatch[1] });
                }
              }
            });
            return matches.slice(0, 3);
          }, dish);

          if (menuText.length > 0) {
            itemPrice = parseFloat(menuText[0].price);
            console.log(`[UberEats] ${card.name} item price: $${itemPrice} from "${menuText[0].text.substring(0, 60)}"`);
          } else {
            // Fallback: find any price on the page near the dish keyword
            const anyPrice = await storePage.evaluate((searchDish) => {
              const allText = document.body.innerText;
              const dishIdx = allText.toLowerCase().indexOf(searchDish.toLowerCase());
              if (dishIdx === -1) return null;
              const nearby = allText.substring(dishIdx, dishIdx + 200);
              const match = nearby.match(/\$(\d+\.?\d*)/);
              return match ? match[1] : null;
            }, dish);
            if (anyPrice) {
              itemPrice = parseFloat(anyPrice);
              console.log(`[UberEats] ${card.name} fallback price: $${itemPrice}`);
            }
          }
          await storePage.close();
        } catch(e) {
          console.log(`[UberEats] Could not get price for ${card.name}: ${e.message.split('\n')[0]}`);
        }
      }

      const total = (itemPrice != null && deliveryFee != null) ? parseFloat((itemPrice + deliveryFee).toFixed(2)) : null;

      results.push({
        platform: 'Uber Eats',
        restaurant: card.name,
        item: dish,
        itemPrice,
        deliveryFee,
        totalPrice: total,
        rating,
        eta,
        url: page.url()
      });
    }

    console.log(`[UberEats] Final results: ${results.length}`);
  } catch (err) {
    console.error('[UberEats] Scrape error:', err.message.split('\n')[0]);
  } finally {
    await browser.close();
  }
  return results;
}

module.exports = { scrapeUberEats };
