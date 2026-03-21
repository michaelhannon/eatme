const { chromium } = require('playwright');

async function scrapeGrubHub({ address, dish, credentials, headless = true, timeout = 45000, platform = 'GrubHub' }) {
  const browser = await chromium.launch({
    headless,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
  });

  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 800 }
  });

  const page = await context.newPage();
  const results = [];
  const baseUrl = platform === 'Seamless' ? 'https://www.seamless.com' : 'https://www.grubhub.com';

  try {
    await page.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout });
    await page.waitForTimeout(2000);

    // Dismiss modal backdrop - the key fix
    // The modal backdrop has data-testid="modal-backdrop" and blocks all clicks
    const backdrop = await page.$('[data-testid="modal-backdrop"], #backdrop, [class*="modal-backdrop"]');
    if (backdrop) {
      // Press Escape to close the modal
      await page.keyboard.press('Escape');
      await page.waitForTimeout(800);
    }

    // Also try clicking the close button if present
    const closeBtn = await page.$('button[aria-label="Close"], button[class*="close"], [data-testid="modal-close"]');
    if (closeBtn) {
      await closeBtn.click({ force: true });
      await page.waitForTimeout(500);
    }

    // Now interact with address input using force: true to bypass any remaining overlays
    const addressInput = await page.waitForSelector(
      'input[placeholder*="Enter delivery address"], input[placeholder*="address"], [data-testid="locationInput"]',
      { timeout }
    );
    await addressInput.click({ force: true });
    await page.waitForTimeout(300);
    await addressInput.fill(address);
    await page.waitForTimeout(1800);

    // Select first suggestion
    const firstSuggestion = await page.$(
      '[data-testid="suggestion-item"]:first-child, [class*="autocomplete"] li:first-child, li[role="option"]:first-child'
    );
    if (firstSuggestion) {
      await firstSuggestion.click({ force: true });
    } else {
      await page.keyboard.press('ArrowDown');
      await page.waitForTimeout(300);
      await page.keyboard.press('Enter');
    }
    await page.waitForTimeout(2500);

    // Search for dish
    const searchInput = await page.waitForSelector(
      'input[placeholder*="Search"], input[name="search"], [data-testid="search-input"]',
      { timeout }
    ).catch(() => null);

    if (searchInput) {
      await searchInput.click({ force: true });
      await searchInput.fill(dish);
      await page.keyboard.press('Enter');
      await page.waitForTimeout(3000);
    }

    // Scrape restaurant cards
    await page.waitForSelector(
      '[class*="restaurant-card"], [class*="RestaurantCard"], [data-testid="restaurant-card"]',
      { timeout: 10000 }
    ).catch(() => {});

    const cards = await page.$$eval(
      '[class*="restaurant-card"], [class*="RestaurantCard"], [data-testid="restaurant-card"]',
      (els) => els.slice(0, 15).map(el => {
        const name = el.querySelector('[class*="restaurant-name"], [class*="RestaurantName"], h3, h4, [class*="name"]')?.innerText?.trim();
        const rating = el.querySelector('[class*="rating"], [class*="Rating"]')?.innerText?.trim();
        const deliveryFee = el.querySelector('[class*="delivery-fee"], [class*="DeliveryFee"], [class*="fee"]')?.innerText?.trim();
        const deliveryTime = el.querySelector('[class*="delivery-time"], [class*="time"], [class*="eta"]')?.innerText?.trim();
        return { name, rating, deliveryFee, deliveryTime };
      }).filter(c => c.name)
    ).catch(() => []);

    cards.forEach(card => {
      const deliveryFee = parseDeliveryFee(card.deliveryFee);
      results.push({
        platform,
        restaurant: card.name,
        item: dish,
        itemPrice: null,
        deliveryFee,
        totalPrice: null,
        rating: parseRating(card.rating),
        eta: card.deliveryTime || null,
        url: page.url()
      });
    });

    console.log(`[${platform}] Found ${results.length} results`);
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

function parsePrice(str) {
  if (!str) return null;
  const match = str.match(/\$?([\d.]+)/);
  return match ? parseFloat(match[1]) : null;
}
function parseDeliveryFee(str) {
  if (!str) return null;
  if (str.toLowerCase().includes('free')) return 0;
  return parsePrice(str);
}
function parseRating(str) {
  if (!str) return null;
  const match = str.match(/([\d.]+)/);
  return match ? parseFloat(match[1]) : null;
}

module.exports = { scrapeGrubHub, scrapeSeamless };
