const { chromium } = require('playwright');

async function scrapeDoorDash({ address, dish, credentials, headless = true, timeout = 45000 }) {
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

  try {
    // Go directly to search — skips homepage modal
    const encodedDish = encodeURIComponent(dish);
    const encodedAddress = encodeURIComponent(address);
    await page.goto(`https://www.doordash.com/search/store/${encodedDish}/`, { waitUntil: 'domcontentloaded', timeout });
    await page.waitForTimeout(2000);

    // Dismiss any modal with Escape
    await page.keyboard.press('Escape');
    await page.waitForTimeout(800);

    // If we need to set address first
    const needsAddress = await page.$('#HomeAddressAutocomplete, input[placeholder="Enter delivery address"]');
    if (needsAddress) {
      await needsAddress.click({ force: true });
      await needsAddress.fill(address);
      await page.waitForTimeout(1500);
      const suggestion = await page.$('li[role="option"]:first-child, [id*="Suggestion"]:first-child');
      if (suggestion) await suggestion.click({ force: true });
      else { await page.keyboard.press('ArrowDown'); await page.waitForTimeout(300); await page.keyboard.press('Enter'); }
      await page.waitForTimeout(2500);

      // Re-navigate to search after setting address
      await page.goto(`https://www.doordash.com/search/store/${encodedDish}/`, { waitUntil: 'domcontentloaded', timeout });
      await page.waitForTimeout(3000);
    }

    // Wait for store cards
    await page.waitForSelector(
      '[data-anchor-id="StoreCard"], [class*="StoreCard"], [data-testid="store-card"]',
      { timeout: 15000 }
    ).catch(() => {});

    const storeCards = await page.$$eval(
      '[data-anchor-id="StoreCard"], [class*="StoreCard"]',
      (cards) => cards.slice(0, 15).map(card => {
        const name = card.querySelector('[data-anchor-id="StoreCardName"], [class*="name"], h3')?.innerText?.trim();
        const rating = card.querySelector('[class*="rating"], [class*="Rating"]')?.innerText?.trim();
        const deliveryFee = card.querySelector('[class*="delivery-fee"], [class*="DeliveryFee"], [class*="fee"]')?.innerText?.trim();
        const deliveryTime = card.querySelector('[class*="delivery-time"], [class*="DeliveryTime"], [class*="eta"]')?.innerText?.trim();
        return { name, rating, deliveryFee, deliveryTime };
      }).filter(c => c.name)
    ).catch(() => []);

    storeCards.forEach(card => {
      const deliveryFee = parseDeliveryFee(card.deliveryFee);
      results.push({
        platform: 'DoorDash',
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

    console.log(`[DoorDash] Found ${results.length} results for "${dish}"`);
  } catch (err) {
    console.error('[DoorDash] Scrape error:', err.message.split('\n')[0]);
  } finally {
    await browser.close();
  }
  return results;
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

module.exports = { scrapeDoorDash };
