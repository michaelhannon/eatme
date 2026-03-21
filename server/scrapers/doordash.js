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
    await page.goto('https://www.doordash.com', { waitUntil: 'domcontentloaded', timeout });
    await page.waitForTimeout(2000);

    // Dismiss the login modal if it appears by pressing Escape
    await page.keyboard.press('Escape');
    await page.waitForTimeout(500);

    // Also try clicking outside the modal
    try {
      const overlay = await page.$('[data-testid="LAYER-MANAGER-MODAL"], .OverlayLayer-sc-ek6cb4-1');
      if (overlay) {
        await page.mouse.click(10, 10); // click top-left corner away from modal
        await page.waitForTimeout(500);
      }
    } catch(e) {}

    // Wait for and click address input
    const addressInput = await page.waitForSelector(
      '#HomeAddressAutocomplete, input[placeholder="Enter delivery address"], input[placeholder*="address"]',
      { timeout }
    );
    await addressInput.click({ force: true }); // force bypasses overlay intercept
    await page.waitForTimeout(300);
    await addressInput.fill(address);
    await page.waitForTimeout(1500);

    // Select first autocomplete suggestion
    const suggestion = await page.$('[id*="AddressAutocompleteSuggestion"], [class*="autocomplete"] li:first-child, li[role="option"]:first-child');
    if (suggestion) {
      await suggestion.click({ force: true });
    } else {
      await page.keyboard.press('ArrowDown');
      await page.waitForTimeout(300);
      await page.keyboard.press('Enter');
    }
    await page.waitForTimeout(2500);

    // Search for dish
    const searchInput = await page.waitForSelector(
      'input[placeholder*="Search"], [data-anchor-id="MainSearchInput"]',
      { timeout }
    ).catch(() => null);

    if (searchInput) {
      await searchInput.click({ force: true });
      await searchInput.fill(dish);
      await page.keyboard.press('Enter');
      await page.waitForTimeout(3000);
    }

    // Scrape store cards
    const storeCards = await page.$$eval(
      '[data-anchor-id="StoreCard"], [class*="StoreCard"], [data-testid="store-card"]',
      (cards) => cards.slice(0, 10).map(card => {
        const name = card.querySelector('[data-anchor-id="StoreCardName"], [class*="name"], h3')?.innerText?.trim();
        const rating = card.querySelector('[class*="rating"], [class*="Rating"]')?.innerText?.trim();
        const deliveryFee = card.querySelector('[class*="delivery-fee"], [class*="DeliveryFee"], [class*="fee"]')?.innerText?.trim();
        const deliveryTime = card.querySelector('[class*="delivery-time"], [class*="DeliveryTime"]')?.innerText?.trim();
        return { name, rating, deliveryFee, deliveryTime };
      }).filter(c => c.name)
    ).catch(() => []);

    storeCards.forEach(card => {
      results.push({
        platform: 'DoorDash',
        restaurant: card.name,
        item: dish,
        itemPrice: null,
        deliveryFee: parseDeliveryFee(card.deliveryFee),
        totalPrice: null,
        rating: parseRating(card.rating),
        eta: card.deliveryTime || null,
        url: page.url()
      });
    });

    console.log(`[DoorDash] Found ${results.length} results`);
  } catch (err) {
    console.error('[DoorDash] Scrape error:', err.message.split('\n')[0]);
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
  if (str.toLowerCase().includes('free')) return 0;
  return parsePrice(str);
}
function parseRating(str) {
  if (!str) return null;
  const match = str.match(/([\d.]+)/);
  return match ? parseFloat(match[1]) : null;
}

module.exports = { scrapeDoorDash };
