const { chromium } = require('playwright');

// GrubHub and Seamless share the same backend/infrastructure
// We scrape both URLs and deduplicate
async function scrapeGrubHub({ address, dish, credentials, headless = true, timeout = 30000, platform = 'GrubHub' }) {
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

    // --- Step 1: Set delivery address ---
    const addressInput = await page.waitForSelector(
      'input[placeholder*="Enter delivery address"], input[placeholder*="address"], [data-testid="locationInput"]',
      { timeout }
    );
    await addressInput.click();
    await addressInput.fill(address);
    await page.waitForTimeout(1500);

    const firstSuggestion = await page.$(
      '[data-testid="suggestion-item"]:first-child, [class*="autocomplete"] li:first-child, [class*="suggestion"]:first-child'
    );
    if (firstSuggestion) {
      await firstSuggestion.click();
    } else {
      await page.keyboard.press('Enter');
    }
    await page.waitForTimeout(2000);

    // --- Step 2: Login ---
    if (credentials?.email) {
      try {
        const loginBtn = await page.$('button:has-text("Sign in"), a:has-text("Log in"), [data-testid="login-button"]');
        if (loginBtn) {
          await loginBtn.click();
          await page.waitForSelector('input[name="email"], input[type="email"]', { timeout: 8000 });
          await page.fill('input[name="email"], input[type="email"]', credentials.email);
          const passInput = await page.$('input[name="password"], input[type="password"]');
          if (passInput) {
            await passInput.fill(credentials.password);
            await page.click('button[type="submit"]');
            await page.waitForTimeout(3000);
          }
        }
      } catch (e) {
        console.log(`[${platform}] Login skipped:`, e.message);
      }
    }

    // --- Step 3: Search ---
    const searchInput = await page.waitForSelector(
      'input[placeholder*="Search"], input[name="search"], [data-testid="search-input"]',
      { timeout }
    );
    await searchInput.click();
    await searchInput.fill(dish);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(3000);

    // --- Step 4: Scrape restaurant + menu item results ---
    await page.waitForSelector(
      '[class*="restaurant-card"], [class*="RestaurantCard"], [data-testid="restaurant-card"]',
      { timeout }
    ).catch(() => {});

    const cards = await page.$$eval(
      '[class*="restaurant-card"], [class*="RestaurantCard"], [data-testid="restaurant-card"], [class*="menuItem"]',
      (els) => els.slice(0, 15).map(el => {
        const name = (
          el.querySelector('[class*="restaurant-name"], [class*="RestaurantName"], h3, h4') ||
          el.querySelector('[class*="name"]')
        )?.innerText?.trim();

        const rating = el.querySelector('[class*="rating"], [class*="Rating"], [aria-label*="rating"]')?.innerText?.trim()
          || el.querySelector('[class*="stars"]')?.getAttribute('aria-label');

        const deliveryFee = el.querySelector('[class*="delivery-fee"], [class*="DeliveryFee"], [class*="fee"]')?.innerText?.trim();
        const deliveryTime = el.querySelector('[class*="delivery-time"], [class*="time"], [class*="eta"]')?.innerText?.trim();
        const minOrder = el.querySelector('[class*="minimum"], [class*="min-order"]')?.innerText?.trim();

        // Item-level price if search returned dish results
        const itemName = el.querySelector('[class*="item-name"], [class*="dish-name"]')?.innerText?.trim();
        const itemPrice = el.querySelector('[class*="item-price"], [class*="dish-price"], [class*="price"]')?.innerText?.trim();

        return { name, rating, deliveryFee, deliveryTime, minOrder, itemName, itemPrice };
      }).filter(c => c.name)
    ).catch(() => []);

    cards.forEach(card => {
      const itemPrice = parsePrice(card.itemPrice);
      const deliveryFee = parseDeliveryFee(card.deliveryFee);
      results.push({
        platform,
        restaurant: card.name,
        item: card.itemName || dish,
        itemPrice,
        deliveryFee,
        totalPrice: (itemPrice != null && deliveryFee != null) ? itemPrice + deliveryFee : null,
        rating: parseRating(card.rating),
        eta: card.deliveryTime || null,
        minOrder: card.minOrder || null,
        url: page.url()
      });
    });

    console.log(`[${platform}] Found ${results.length} results`);
  } catch (err) {
    console.error(`[${platform}] Scrape error:`, err.message);
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
