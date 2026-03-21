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
  const encodedDish = encodeURIComponent(dish);

  try {
    // Go directly to search URL — avoids homepage modal entirely
    await page.goto(`${baseUrl}/food-delivery/search?queryText=${encodedDish}`, { waitUntil: 'domcontentloaded', timeout });
    await page.waitForTimeout(2000);

    // Dismiss modal if present
    await page.keyboard.press('Escape');
    await page.waitForTimeout(500);

    // If redirected to home and needs address
    if (page.url().includes('home') || page.url() === baseUrl + '/') {
      const addressInput = await page.$('input[placeholder*="Enter delivery address"], input[placeholder*="address"]');
      if (addressInput) {
        await addressInput.click({ force: true });
        await addressInput.fill(address);
        await page.waitForTimeout(1800);
        const suggestion = await page.$('li[role="option"]:first-child, [data-testid="suggestion-item"]:first-child');
        if (suggestion) await suggestion.click({ force: true });
        else { await page.keyboard.press('ArrowDown'); await page.waitForTimeout(300); await page.keyboard.press('Enter'); }
        await page.waitForTimeout(2500);

        // Re-navigate to search
        await page.goto(`${baseUrl}/food-delivery/search?queryText=${encodedDish}`, { waitUntil: 'domcontentloaded', timeout });
        await page.waitForTimeout(3000);
      }
    }

    // Wait for restaurant cards
    await page.waitForSelector(
      '[class*="restaurant-card"], [class*="RestaurantCard"], [data-testid="restaurant-card"], [class*="restaurantCard"]',
      { timeout: 15000 }
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

    console.log(`[${platform}] Found ${results.length} results for "${dish}"`);
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

function parseDeliveryFee(str) {
  if (!str) return null;
  if (str.toLowerCase().includes('free')) return 0;
  const match = str.match(/\$?([\d.]+)/);
  return match ? parseFloat(match[1]) : null;
}
function parseRating(str) {
  if (!str) return null;
  const match = str.match(/([\d.]+)/);
  return match ? parseFloat(match[1]) : null;
}

module.exports = { scrapeGrubHub, scrapeSeamless };
