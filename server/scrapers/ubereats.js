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
    // Go directly to search URL with address — bypass homepage modal entirely
    const encodedDish = encodeURIComponent(dish);
    await page.goto(`https://www.ubereats.com/search?q=${encodedDish}`, { waitUntil: 'domcontentloaded', timeout });
    await page.waitForTimeout(2000);

    // If redirected to address entry, handle it
    if (page.url().includes('location') || page.url().includes('home')) {
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
        else await page.keyboard.press('Enter');
        await page.waitForTimeout(2000);

        // Now search for dish
        await page.goto(`https://www.ubereats.com/search?q=${encodedDish}`, { waitUntil: 'domcontentloaded', timeout });
        await page.waitForTimeout(3000);
      }
    }

    // Wait for search results
    await page.waitForSelector(
      '[data-testid="store-card"], [class*="StoreCard"], [class*="store-card"]',
      { timeout: 15000 }
    ).catch(() => {});

    // Scrape store cards from actual search results
    const storeResults = await page.$$eval(
      '[data-testid="store-card"], [class*="StoreCard"]',
      (cards, searchDish) => cards.slice(0, 15).map(card => {
        const name = card.querySelector('[data-testid="store-name"], [class*="store-name"], h3, [class*="heading"]')?.innerText?.trim();
        const rating = card.querySelector('[class*="rating"], [aria-label*="rating"], [class*="Rating"]')?.innerText?.trim();
        const deliveryFee = card.querySelector('[class*="delivery-fee"], [class*="DeliveryFee"], [class*="fee"]')?.innerText?.trim();
        const eta = card.querySelector('[class*="time"], [class*="eta"], [class*="ETA"]')?.innerText?.trim();
        const categories = card.querySelector('[class*="category"], [class*="cuisine"], [class*="tag"]')?.innerText?.trim();
        return { name, rating, deliveryFee, eta, categories };
      }).filter(c => c.name),
      dish
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

    console.log(`[UberEats] Found ${results.length} results for "${dish}"`);
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
