const { chromium } = require('playwright');

async function scrapeUberEats({ address, dish, credentials, headless = true, timeout = 45000 }) {
  const browser = await chromium.launch({
    headless,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
  });

  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 800 },
    locale: 'en-US'
  });

  const page = await context.newPage();
  const results = [];

  try {
    await page.goto('https://www.ubereats.com', { waitUntil: 'domcontentloaded', timeout });
    await page.waitForTimeout(2000);

    // Dismiss any modal/popup with Escape
    await page.keyboard.press('Escape');
    await page.waitForTimeout(500);

    // Find address input and use force click to bypass overlays
    const addressInput = await page.waitForSelector(
      'input[placeholder*="Enter a new address"], input[placeholder*="delivery address"], input[placeholder*="Address"], [data-testid="address-input"]',
      { timeout }
    );
    await addressInput.click({ force: true });
    await page.waitForTimeout(300);
    await addressInput.fill(address);
    await page.waitForTimeout(1800);

    // Select autocomplete suggestion
    const suggestion = await page.$(
      '[data-testid="autocomplete-result"]:first-child, li[role="option"]:first-child, [class*="AutocompleteResults"] li:first-child'
    );
    if (suggestion) {
      await suggestion.click({ force: true });
    } else {
      await page.keyboard.press('ArrowDown');
      await page.waitForTimeout(300);
      await page.keyboard.press('Enter');
    }
    await page.waitForTimeout(1500);

    // Confirm delivery if button appears
    const confirmBtn = await page.$('button:has-text("Deliver here"), button:has-text("Confirm"), button:has-text("Done")');
    if (confirmBtn) {
      await confirmBtn.click({ force: true });
      await page.waitForTimeout(1500);
    }

    // Search for dish
    const searchBtn = await page.$('[data-testid="search-suggestions-input"], input[placeholder*="Search UberEats"], input[placeholder*="Search restaurants"]');
    if (searchBtn) {
      await searchBtn.click({ force: true });
      await page.waitForTimeout(300);
      await searchBtn.fill(dish);
      await page.keyboard.press('Enter');
      await page.waitForTimeout(3500);
    }

    // Scrape store cards
    await page.waitForSelector(
      '[data-testid="store-card"], [class*="StoreCard"]',
      { timeout: 10000 }
    ).catch(() => {});

    const storeResults = await page.$$eval(
      '[data-testid="store-card"], [class*="StoreCard"]',
      (cards) => cards.slice(0, 10).map(card => {
        const name = card.querySelector('[data-testid="store-name"], [class*="store-name"], h3')?.innerText?.trim();
        const rating = card.querySelector('[class*="rating"], [aria-label*="rating"]')?.innerText?.trim();
        const deliveryFee = card.querySelector('[class*="delivery-fee"], [class*="DeliveryFee"]')?.innerText?.trim();
        const eta = card.querySelector('[class*="time"], [class*="eta"]')?.innerText?.trim();
        return { name, rating, deliveryFee, eta };
      }).filter(c => c.name)
    ).catch(() => []);

    storeResults.forEach(card => {
      const deliveryFee = parseDeliveryFee(card.deliveryFee);
      results.push({
        platform: 'Uber Eats',
        restaurant: card.name,
        item: dish,
        itemPrice: null,
        deliveryFee,
        totalPrice: null,
        rating: parseRating(card.rating),
        eta: card.eta || null,
        url: page.url()
      });
    });

    console.log(`[UberEats] Found ${results.length} results`);
  } catch (err) {
    console.error('[UberEats] Scrape error:', err.message.split('\n')[0]);
  } finally {
    await browser.close();
  }
  return results;
}

function parsePrice(str) {
  if (!str) return null;
  const match = str.match(/\$?([\d.]+)/);
  return match ? parseFloat(match[1]) : null;
}
function parseDeliveryFee(str) {
  if (!str) return null;
  if (str.toLowerCase().includes('free') || str === '$0.00') return 0;
  return parsePrice(str);
}
function parseRating(str) {
  if (!str) return null;
  const match = str.match(/([\d.]+)/);
  return match ? parseFloat(match[1]) : null;
}

module.exports = { scrapeUberEats };
