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
    const encodedDish = encodeURIComponent(dish);
    console.log(`[UberEats] Navigating to search for "${dish}"...`);
    await page.goto(`https://www.ubereats.com/search?q=${encodedDish}`, { waitUntil: 'domcontentloaded', timeout });
    await page.waitForTimeout(3000);

    const currentUrl = page.url();
    const title = await page.title();
    console.log(`[UberEats] URL: ${currentUrl}`);
    console.log(`[UberEats] Title: ${title}`);

    const bodyText = await page.evaluate(() => document.body.innerText.substring(0, 500));
    console.log(`[UberEats] Body preview: ${bodyText}`);

    // Handle address entry if redirected
    if (!currentUrl.includes('search')) {
      console.log('[UberEats] Redirected away from search, handling address...');
      await page.keyboard.press('Escape');
      await page.waitForTimeout(500);

      const addressInput = await page.waitForSelector(
        'input[placeholder*="address"], input[placeholder*="Address"], [data-testid="address-input"]',
        { timeout: 15000 }
      ).catch(() => null);

      if (addressInput) {
        await addressInput.click({ force: true });
        await addressInput.fill(address);
        await page.waitForTimeout(1500);
        const suggestion = await page.$('li[role="option"]:first-child, [data-testid="autocomplete-result"]:first-child');
        if (suggestion) await suggestion.click({ force: true });
        else { await page.keyboard.press('ArrowDown'); await page.waitForTimeout(300); await page.keyboard.press('Enter'); }
        await page.waitForTimeout(2000);

        const confirmBtn = await page.$('button:has-text("Deliver here"), button:has-text("Confirm")');
        if (confirmBtn) await confirmBtn.click({ force: true });
        await page.waitForTimeout(1500);

        await page.goto(`https://www.ubereats.com/search?q=${encodedDish}`, { waitUntil: 'domcontentloaded', timeout });
        await page.waitForTimeout(3000);
        console.log(`[UberEats] URL after address+search: ${page.url()}`);
      }
    }

    await page.waitForSelector(
      '[data-testid="store-card"], [class*="StoreCard"]',
      { timeout: 15000 }
    ).catch(e => console.log('[UberEats] No store cards found:', e.message.split('\n')[0]));

    const storeResults = await page.$$eval(
      '[data-testid="store-card"], [class*="StoreCard"]',
      (cards) => cards.slice(0, 15).map(card => {
        const name = card.querySelector('[data-testid="store-name"], [class*="store-name"], h3, [class*="heading"]')?.innerText?.trim();
        const rating = card.querySelector('[class*="rating"], [aria-label*="rating"]')?.innerText?.trim();
        const deliveryFee = card.querySelector('[class*="delivery-fee"], [class*="DeliveryFee"]')?.innerText?.trim();
        const eta = card.querySelector('[class*="time"], [class*="eta"]')?.innerText?.trim();
        return { name, rating, deliveryFee, eta };
      }).filter(c => c.name)
    ).catch(() => []);

    console.log(`[UberEats] Found ${storeResults.length} store cards`);

    storeResults.forEach(card => {
      results.push({
        platform: 'Uber Eats',
        restaurant: card.name,
        item: dish,
        itemPrice: null,
        deliveryFee: parseDeliveryFee(card.deliveryFee),
        totalPrice: null,
        rating: parseRating(card.rating),
        eta: card.eta || null,
        url: page.url()
      });
    });

  } catch (err) {
    console.error('[UberEats] Scrape error:', err.message.split('\n')[0]);
  } finally {
    await browser.close();
  }
  return results;
}

function parseDeliveryFee(str) {
  if (!str) return null;
  if (str.toLowerCase().includes('free') || str === '$0.00') return 0;
  const match = str.match(/\$?([\d.]+)/);
  return match ? parseFloat(match[1]) : null;
}
function parseRating(str) {
  if (!str) return null;
  const match = str.match(/([\d.]+)/);
  return match ? parseFloat(match[1]) : null;
}

module.exports = { scrapeUberEats };
