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
    // Step 1: Go to homepage and SET ADDRESS FIRST before searching
    // This is critical - without it, Uber Eats uses server IP geolocation
    console.log(`[UberEats] Setting delivery address: ${address}`);
    await page.goto('https://www.ubereats.com', { waitUntil: 'domcontentloaded', timeout });
    await page.waitForTimeout(2500);

    // Dismiss any modal
    await page.keyboard.press('Escape');
    await page.waitForTimeout(500);

    // Find address input - Uber Eats shows it prominently on homepage
    const addressSelectors = [
      'input[placeholder*="Enter a new address"]',
      'input[placeholder*="delivery address"]',
      'input[placeholder*="Enter delivery address"]',
      '[data-testid="address-input"] input',
      'input[type="text"][autocomplete*="address"]',
      'input[id*="location"]',
      'input[id*="address"]'
    ];

    let addressInput = null;
    for (const sel of addressSelectors) {
      addressInput = await page.$(sel);
      if (addressInput) { console.log(`[UberEats] Found address input: ${sel}`); break; }
    }

    if (!addressInput) {
      // Try clicking a "Find Food" or "Get started" button first
      const startBtn = await page.$('button:has-text("Find Food"), button:has-text("Get started"), a:has-text("Sign in")');
      if (startBtn) { await startBtn.click(); await page.waitForTimeout(1000); }
      addressInput = await page.$('input[type="text"]');
    }

    if (addressInput) {
      await addressInput.click({ force: true });
      await page.waitForTimeout(300);
      await addressInput.fill('');
      await addressInput.type(address, { delay: 50 });
      await page.waitForTimeout(2000);

      // Wait for and click first autocomplete result
      const suggestionSelectors = [
        'li[role="option"]:first-child',
        '[data-testid="autocomplete-result"]:first-child',
        '[class*="AutocompleteResult"]:first-child',
        '[class*="suggestion"]:first-child',
        '[class*="Suggestion"]:first-child'
      ];

      let clicked = false;
      for (const sel of suggestionSelectors) {
        const s = await page.$(sel);
        if (s) {
          await s.click({ force: true });
          console.log(`[UberEats] Clicked suggestion: ${sel}`);
          clicked = true;
          break;
        }
      }
      if (!clicked) {
        await page.keyboard.press('ArrowDown');
        await page.waitForTimeout(300);
        await page.keyboard.press('Enter');
        console.log('[UberEats] Used keyboard to select suggestion');
      }
      await page.waitForTimeout(2000);

      // Confirm delivery button if shown
      const confirmBtn = await page.$('button:has-text("Deliver here"), button:has-text("Confirm delivery address"), button:has-text("Done")');
      if (confirmBtn) { await confirmBtn.click({ force: true }); await page.waitForTimeout(1000); }

      console.log(`[UberEats] URL after address set: ${page.url()}`);
    } else {
      console.log('[UberEats] WARNING: Could not find address input');
    }

    // Step 2: Now search for the dish WITH the address set in session
    const encodedDish = encodeURIComponent(dish);
    await page.goto(`https://www.ubereats.com/search?q=${encodedDish}`, { waitUntil: 'domcontentloaded', timeout });
    await page.waitForTimeout(3000);

    console.log(`[UberEats] Search URL: ${page.url()}`);
    const bodyText = await page.evaluate(() => document.body.innerText.substring(0, 300));
    console.log(`[UberEats] Page preview: ${bodyText}`);

    // Wait for store cards
    await page.waitForSelector('[data-testid="store-card"], [class*="StoreCard"]', { timeout: 15000 })
      .catch(e => console.log('[UberEats] No store cards:', e.message.split('\n')[0]));

    // Step 3: Scrape store cards with delivery fee + rating
    const storeResults = await page.$$eval(
      '[data-testid="store-card"], [class*="StoreCard"]',
      (cards) => cards.slice(0, 12).map(card => {
        const name = card.querySelector('[data-testid="store-name"], [class*="store-name"], h3, [class*="heading"]')?.innerText?.trim();
        const ratingEl = card.querySelector('[class*="rating"], [aria-label*="rating"], [class*="Rating"]');
        const rating = ratingEl?.innerText?.trim() || ratingEl?.getAttribute('aria-label');
        const feeEl = card.querySelector('[class*="delivery-fee"], [class*="DeliveryFee"], [class*="fee"]');
        const deliveryFee = feeEl?.innerText?.trim();
        const etaEl = card.querySelector('[class*="time"], [class*="eta"], [class*="ETA"]');
        const eta = etaEl?.innerText?.trim();
        const href = card.querySelector('a')?.getAttribute('href');
        return { name, rating, deliveryFee, eta, href };
      }).filter(c => c.name)
    ).catch(() => []);

    console.log(`[UberEats] Found ${storeResults.length} stores`);

    // Step 4: For each store, try to get the item price
    for (const store of storeResults) {
      const deliveryFee = parseDeliveryFee(store.deliveryFee);
      let itemPrice = null;

      // Visit the restaurant page to find actual item price
      if (store.href) {
        try {
          const storeUrl = store.href.startsWith('http') ? store.href : `https://www.ubereats.com${store.href}`;
          const storePage = await context.newPage();
          await storePage.goto(storeUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
          await storePage.waitForTimeout(2000);

          // Search for the dish in the menu
          const menuItems = await storePage.$$eval(
            '[data-testid="menu-item"], [class*="MenuItem"], [class*="menu-item"]',
            (items, searchDish) => {
              const lowerDish = searchDish.toLowerCase();
              return items.map(item => {
                const name = item.querySelector('[data-testid="item-name"], [class*="name"], h3, h4')?.innerText?.trim();
                const price = item.querySelector('[data-testid="item-price"], [class*="price"]')?.innerText?.trim();
                return { name, price };
              }).filter(i => i.name && i.price && i.name.toLowerCase().includes(lowerDish.split(' ')[0]));
            },
            dish
          ).catch(() => []);

          if (menuItems.length > 0) {
            itemPrice = parsePrice(menuItems[0].price);
            console.log(`[UberEats] ${store.name}: found item "${menuItems[0].name}" at ${menuItems[0].price}`);
          }
          await storePage.close();
        } catch(e) {
          console.log(`[UberEats] Could not get price for ${store.name}: ${e.message.split('\n')[0]}`);
        }
      }

      const total = (itemPrice != null && deliveryFee != null) ? parseFloat((itemPrice + deliveryFee).toFixed(2)) : null;

      results.push({
        platform: 'Uber Eats',
        restaurant: store.name,
        item: dish,
        itemPrice,
        deliveryFee,
        totalPrice: total,
        rating: parseRating(store.rating),
        eta: store.eta || null,
        url: page.url()
      });
    }

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
  const match = str.match(/\$?([\d.]+)/);
  return match ? parseFloat(match[1]) : null;
}
function parseRating(str) {
  if (!str) return null;
  const match = str.match(/([\d.]+)/);
  return match ? parseFloat(match[1]) : null;
}

module.exports = { scrapeUberEats };
