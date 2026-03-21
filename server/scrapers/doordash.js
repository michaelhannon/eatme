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
    // Step 1: Land on homepage and set address FIRST
    console.log(`[DoorDash] Loading homepage to set address...`);
    await page.goto('https://www.doordash.com', { waitUntil: 'domcontentloaded', timeout });
    await page.waitForTimeout(2500);

    // Dismiss login modal with Escape
    await page.keyboard.press('Escape');
    await page.waitForTimeout(800);
    await page.mouse.click(10, 10);
    await page.waitForTimeout(400);

    // Find address input
    const addressInput = await page.waitForSelector(
      '#HomeAddressAutocomplete, input[placeholder="Enter delivery address"], input[placeholder*="delivery address"]',
      { timeout: 15000 }
    ).catch(() => null);

    if (addressInput) {
      await addressInput.click({ force: true });
      await addressInput.fill('');
      await addressInput.type(address, { delay: 50 });
      await page.waitForTimeout(1800);

      const suggestion = await page.$('li[role="option"]:first-child, [id*="Suggestion"]:first-child, [class*="autocomplete"] li:first-child');
      if (suggestion) {
        await suggestion.click({ force: true });
        console.log('[DoorDash] Address suggestion selected');
      } else {
        await page.keyboard.press('ArrowDown');
        await page.waitForTimeout(300);
        await page.keyboard.press('Enter');
      }
      await page.waitForTimeout(2500);
      console.log(`[DoorDash] URL after address: ${page.url()}`);
    } else {
      console.log('[DoorDash] WARNING: No address input found');
    }

    // Step 2: Search for dish
    const encodedDish = encodeURIComponent(dish);
    await page.goto(`https://www.doordash.com/search/store/${encodedDish}/`, { waitUntil: 'domcontentloaded', timeout });
    await page.waitForTimeout(3000);

    console.log(`[DoorDash] Search URL: ${page.url()}`);
    const bodyText = await page.evaluate(() => document.body.innerText.substring(0, 300));
    console.log(`[DoorDash] Page preview: ${bodyText}`);

    // Wait for store cards
    await page.waitForSelector('[data-anchor-id="StoreCard"], [class*="StoreCard"]', { timeout: 15000 })
      .catch(e => console.log('[DoorDash] No store cards:', e.message.split('\n')[0]));

    // Step 3: Scrape store cards
    const storeCards = await page.$$eval(
      '[data-anchor-id="StoreCard"], [class*="StoreCard"]',
      (cards) => cards.slice(0, 12).map(card => {
        const name = card.querySelector('[data-anchor-id="StoreCardName"], [class*="name"], h3')?.innerText?.trim();
        const rating = card.querySelector('[class*="rating"], [class*="Rating"]')?.innerText?.trim();
        const deliveryFee = card.querySelector('[class*="delivery-fee"], [class*="DeliveryFee"], [class*="fee"]')?.innerText?.trim();
        const deliveryTime = card.querySelector('[class*="delivery-time"], [class*="DeliveryTime"], [class*="eta"]')?.innerText?.trim();
        const href = card.querySelector('a')?.getAttribute('href');
        return { name, rating, deliveryFee, deliveryTime, href };
      }).filter(c => c.name)
    ).catch(() => []);

    console.log(`[DoorDash] Found ${storeCards.length} stores`);

    // Step 4: Drill into each store to get item price
    for (const card of storeCards) {
      const deliveryFee = parseDeliveryFee(card.deliveryFee);
      let itemPrice = null;

      if (card.href) {
        try {
          const storeUrl = card.href.startsWith('http') ? card.href : `https://www.doordash.com${card.href}`;
          const storePage = await context.newPage();
          await storePage.goto(storeUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
          await storePage.waitForTimeout(2000);

          const menuItems = await storePage.$$eval(
            '[data-anchor-id="MenuItem"], [class*="MenuItem"]',
            (items, searchDish) => {
              const lowerDish = searchDish.toLowerCase();
              return items.map(item => {
                const name = item.querySelector('[data-anchor-id="MenuItemName"], [class*="name"]')?.innerText?.trim();
                const price = item.querySelector('[data-anchor-id="MenuItemPrice"], [class*="price"]')?.innerText?.trim();
                return { name, price };
              }).filter(i => i.name && i.price && i.name.toLowerCase().includes(lowerDish.split(' ')[0]));
            },
            dish
          ).catch(() => []);

          if (menuItems.length > 0) {
            itemPrice = parsePrice(menuItems[0].price);
            console.log(`[DoorDash] ${card.name}: ${menuItems[0].name} = ${menuItems[0].price}`);
          }
          await storePage.close();
        } catch(e) {
          console.log(`[DoorDash] Price fetch failed for ${card.name}: ${e.message.split('\n')[0]}`);
        }
      }

      const total = (itemPrice != null && deliveryFee != null) ? parseFloat((itemPrice + deliveryFee).toFixed(2)) : null;

      results.push({
        platform: 'DoorDash',
        restaurant: card.name,
        item: dish,
        itemPrice,
        deliveryFee,
        totalPrice: total,
        rating: parseRating(card.rating),
        eta: card.deliveryTime || null,
        url: page.url()
      });
    }

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
  const match = str.match(/\$?([\d.]+)/);
  return match ? parseFloat(match[1]) : null;
}
function parseRating(str) {
  if (!str) return null;
  const match = str.match(/([\d.]+)/);
  return match ? parseFloat(match[1]) : null;
}

module.exports = { scrapeDoorDash };
