const { chromium } = require('playwright');

async function scrapeGrubHub({ address, dish, credentials, headless = true, timeout = 45000, platform = 'GrubHub' }) {
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
  const baseUrl = platform === 'Seamless' ? 'https://www.seamless.com' : 'https://www.grubhub.com';
  const encodedDish = encodeURIComponent(dish);

  try {
    // Step 1: Load homepage and set address FIRST
    console.log(`[${platform}] Loading homepage to set address...`);
    await page.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout });
    await page.waitForTimeout(2500);

    // Dismiss modal
    await page.keyboard.press('Escape');
    await page.waitForTimeout(600);

    const addressInput = await page.waitForSelector(
      'input[placeholder*="Enter delivery address"], input[placeholder*="delivery address"], input[placeholder*="address"]',
      { timeout: 15000 }
    ).catch(() => null);

    if (addressInput) {
      await addressInput.click({ force: true });
      await addressInput.fill('');
      await addressInput.type(address, { delay: 50 });
      await page.waitForTimeout(1800);

      const suggestion = await page.$('li[role="option"]:first-child, [data-testid="suggestion-item"]:first-child');
      if (suggestion) {
        await suggestion.click({ force: true });
        console.log(`[${platform}] Address suggestion selected`);
      } else {
        await page.keyboard.press('ArrowDown');
        await page.waitForTimeout(300);
        await page.keyboard.press('Enter');
      }
      await page.waitForTimeout(2500);
      console.log(`[${platform}] URL after address: ${page.url()}`);
    } else {
      console.log(`[${platform}] WARNING: No address input found`);
    }

    // Step 2: Navigate to search with dish
    await page.goto(`${baseUrl}/food-delivery/search?queryText=${encodedDish}`, { waitUntil: 'domcontentloaded', timeout });
    await page.waitForTimeout(3000);

    console.log(`[${platform}] Search URL: ${page.url()}`);
    const bodyText = await page.evaluate(() => document.body.innerText.substring(0, 300));
    console.log(`[${platform}] Page preview: ${bodyText}`);

    // Wait for restaurant cards
    await page.waitForSelector(
      '[class*="restaurant-card"], [class*="RestaurantCard"], [data-testid="restaurant-card"]',
      { timeout: 15000 }
    ).catch(e => console.log(`[${platform}] No cards:`, e.message.split('\n')[0]));

    // Step 3: Scrape restaurant cards
    const cards = await page.$$eval(
      '[class*="restaurant-card"], [class*="RestaurantCard"], [data-testid="restaurant-card"]',
      (els) => els.slice(0, 12).map(el => {
        const name = el.querySelector('[class*="restaurant-name"], [class*="RestaurantName"], h3, h4, [class*="name"]')?.innerText?.trim();
        const rating = el.querySelector('[class*="rating"], [class*="Rating"]')?.innerText?.trim();
        const deliveryFee = el.querySelector('[class*="delivery-fee"], [class*="DeliveryFee"], [class*="fee"]')?.innerText?.trim();
        const deliveryTime = el.querySelector('[class*="delivery-time"], [class*="time"], [class*="eta"]')?.innerText?.trim();
        const href = el.querySelector('a')?.getAttribute('href');
        return { name, rating, deliveryFee, deliveryTime, href };
      }).filter(c => c.name)
    ).catch(() => []);

    console.log(`[${platform}] Found ${cards.length} restaurants`);

    // Step 4: Drill into each restaurant for item price
    for (const card of cards) {
      const deliveryFee = parseDeliveryFee(card.deliveryFee);
      let itemPrice = null;

      if (card.href) {
        try {
          const storeUrl = card.href.startsWith('http') ? card.href : `${baseUrl}${card.href}`;
          const storePage = await context.newPage();
          await storePage.goto(storeUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
          await storePage.waitForTimeout(2000);

          const menuItems = await storePage.$$eval(
            '[class*="menuItem"], [class*="MenuItem"], [data-testid="menu-item"]',
            (items, searchDish) => {
              const lowerDish = searchDish.toLowerCase();
              return items.map(item => {
                const name = item.querySelector('[class*="name"], [class*="title"]')?.innerText?.trim();
                const price = item.querySelector('[class*="price"]')?.innerText?.trim();
                return { name, price };
              }).filter(i => i.name && i.price && i.name.toLowerCase().includes(lowerDish.split(' ')[0]));
            },
            dish
          ).catch(() => []);

          if (menuItems.length > 0) {
            itemPrice = parsePrice(menuItems[0].price);
            console.log(`[${platform}] ${card.name}: ${menuItems[0].name} = ${menuItems[0].price}`);
          }
          await storePage.close();
        } catch(e) {
          console.log(`[${platform}] Price fetch failed for ${card.name}: ${e.message.split('\n')[0]}`);
        }
      }

      const total = (itemPrice != null && deliveryFee != null) ? parseFloat((itemPrice + deliveryFee).toFixed(2)) : null;

      results.push({
        platform,
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
  const match = str.match(/\$?([\d.]+)/);
  return match ? parseFloat(match[1]) : null;
}
function parseRating(str) {
  if (!str) return null;
  const match = str.match(/([\d.]+)/);
  return match ? parseFloat(match[1]) : null;
}

module.exports = { scrapeGrubHub, scrapeSeamless };
