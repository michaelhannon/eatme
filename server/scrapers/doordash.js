const { chromium } = require('playwright');

async function scrapeDoorDash({ address, dish, credentials, headless = true, timeout = 30000 }) {
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
    // --- Step 1: Go to DoorDash and set delivery address ---
    await page.goto('https://www.doordash.com', { waitUntil: 'domcontentloaded', timeout });

    // Handle address entry
    await page.waitForSelector('[data-anchor-id="AddressAutocomplete"], input[placeholder*="address"], input[placeholder*="Address"]', { timeout });
    await page.click('[data-anchor-id="AddressAutocomplete"], input[placeholder*="address"], input[placeholder*="Address"]');
    await page.type('[data-anchor-id="AddressAutocomplete"], input[placeholder*="address"], input[placeholder*="Address"]', address, { delay: 80 });
    await page.waitForTimeout(1500);

    // Select first suggestion
    const suggestion = await page.$('[data-anchor-id="AddressAutocompleteSuggestion"]:first-child, [class*="suggestion"]:first-child');
    if (suggestion) {
      await suggestion.click();
    } else {
      await page.keyboard.press('Enter');
    }

    await page.waitForTimeout(2000);

    // --- Step 2: Login if credentials provided ---
    if (credentials?.email) {
      try {
        const signInBtn = await page.$('[data-anchor-id="SignInLink"], a[href*="login"], button:has-text("Sign in")');
        if (signInBtn) {
          await signInBtn.click();
          await page.waitForSelector('input[name="email"], input[type="email"]', { timeout: 8000 });
          await page.fill('input[name="email"], input[type="email"]', credentials.email);
          await page.fill('input[name="password"], input[type="password"]', credentials.password);
          await page.click('button[type="submit"]');
          await page.waitForTimeout(3000);
        }
      } catch (e) {
        console.log('[DoorDash] Login skipped:', e.message);
      }
    }

    // --- Step 3: Search for dish ---
    await page.waitForSelector('[data-anchor-id="MainSearchInput"], input[placeholder*="Search"]', { timeout });
    await page.click('[data-anchor-id="MainSearchInput"], input[placeholder*="Search"]');
    await page.type('[data-anchor-id="MainSearchInput"], input[placeholder*="Search"]', dish, { delay: 80 });
    await page.keyboard.press('Enter');
    await page.waitForTimeout(3000);

    // --- Step 4: Scrape results ---
    await page.waitForSelector('[data-anchor-id="MenuItem"], [class*="MenuItem"], [class*="StoreCard"]', { timeout }).catch(() => {});

    // Try to get item-level results first
    const menuItems = await page.$$eval(
      '[data-anchor-id="MenuItem"], [class*="menu-item"], [class*="MenuItem"]',
      (items) => items.slice(0, 10).map(item => {
        const name = item.querySelector('[data-anchor-id="MenuItemName"], [class*="name"], h3, h4')?.innerText?.trim();
        const price = item.querySelector('[data-anchor-id="MenuItemPrice"], [class*="price"]')?.innerText?.trim();
        const restaurant = item.querySelector('[class*="store"], [class*="restaurant"]')?.innerText?.trim();
        return { name, price, restaurant };
      }).filter(i => i.name && i.price)
    ).catch(() => []);

    // Fall back to store card results
    if (menuItems.length === 0) {
      const storeCards = await page.$$eval(
        '[data-anchor-id="StoreCard"], [class*="StoreCard"]',
        (cards) => cards.slice(0, 10).map(card => {
          const name = card.querySelector('[data-anchor-id="StoreCardName"], [class*="name"]')?.innerText?.trim();
          const rating = card.querySelector('[class*="rating"], [class*="Rating"]')?.innerText?.trim();
          const deliveryFee = card.querySelector('[class*="delivery-fee"], [class*="DeliveryFee"]')?.innerText?.trim();
          const deliveryTime = card.querySelector('[class*="delivery-time"], [class*="DeliveryTime"]')?.innerText?.trim();
          return { restaurant: name, rating, deliveryFee, deliveryTime };
        }).filter(c => c.restaurant)
      ).catch(() => []);

      storeCards.forEach(card => {
        results.push({
          platform: 'DoorDash',
          restaurant: card.restaurant,
          item: dish,
          itemPrice: null,
          deliveryFee: parseDeliveryFee(card.deliveryFee),
          totalPrice: null,
          rating: parseRating(card.rating),
          eta: card.deliveryTime || null,
          url: page.url()
        });
      });
    } else {
      menuItems.forEach(item => {
        const itemPrice = parsePrice(item.price);
        results.push({
          platform: 'DoorDash',
          restaurant: item.restaurant || 'Unknown',
          item: item.name,
          itemPrice,
          deliveryFee: null,
          totalPrice: null,
          rating: null,
          eta: null,
          url: page.url()
        });
      });
    }

    console.log(`[DoorDash] Found ${results.length} results`);
  } catch (err) {
    console.error('[DoorDash] Scrape error:', err.message);
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
