const { chromium } = require('playwright');

async function scrapeUberEats({ address, dish, credentials, headless = true, timeout = 30000 }) {
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
    await page.goto('https://www.ubereats.com', { waitUntil: 'domcontentloaded', timeout });

    // --- Step 1: Set delivery address ---
    // Uber Eats has a prominent address modal on load
    const addressInput = await page.waitForSelector(
      'input[placeholder*="Enter a new address"], input[placeholder*="delivery address"], [data-testid="address-input"], input[type="text"]',
      { timeout }
    );
    await addressInput.click({ clickCount: 3 });
    await addressInput.fill(address);
    await page.waitForTimeout(1800);

    // Select autocomplete suggestion
    const suggestion = await page.$(
      '[data-testid="autocomplete-result"]:first-child, [class*="AutocompleteResults"] li:first-child, li[role="option"]:first-child'
    );
    if (suggestion) {
      await suggestion.click();
    } else {
      await page.keyboard.press('Enter');
    }
    await page.waitForTimeout(2000);

    // Confirm delivery button if shown
    const confirmBtn = await page.$('button:has-text("Deliver here"), button:has-text("Confirm"), button:has-text("Done")');
    if (confirmBtn) await confirmBtn.click();
    await page.waitForTimeout(1500);

    // --- Step 2: Login ---
    if (credentials?.email) {
      try {
        const signInBtn = await page.$('a[href*="login"], button:has-text("Sign in"), [data-testid="signInButton"]');
        if (signInBtn) {
          await signInBtn.click();
          await page.waitForSelector('input[name="email"], input[type="email"]', { timeout: 8000 });
          await page.fill('input[name="email"], input[type="email"]', credentials.email);
          await page.click('button:has-text("Next"), button[type="submit"]');
          await page.waitForTimeout(1000);
          const passInput = await page.$('input[name="password"], input[type="password"]');
          if (passInput) {
            await passInput.fill(credentials.password);
            await page.click('button[type="submit"]');
            await page.waitForTimeout(3000);
          }
        }
      } catch (e) {
        console.log('[UberEats] Login skipped:', e.message);
      }
    }

    // --- Step 3: Search ---
    const searchBtn = await page.$('[data-testid="search-suggestions-input"], input[placeholder*="Search"], a[href*="search"]');
    if (searchBtn) {
      await searchBtn.click();
    }
    await page.waitForTimeout(500);

    const searchInput = await page.waitForSelector(
      'input[placeholder*="Search UberEats"], input[placeholder*="Search restaurants"], input[type="search"], [data-testid*="search"]',
      { timeout }
    );
    await searchInput.fill(dish);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(3500);

    // --- Step 4: Scrape ---
    // Uber Eats returns both restaurant cards and dish items in search
    await page.waitForSelector(
      '[data-testid="store-card"], [class*="StoreCard"], [class*="store-card"]',
      { timeout }
    ).catch(() => {});

    // Try item-level results first
    const dishResults = await page.$$eval(
      '[data-testid="menu-item"], [class*="MenuItem"], [class*="menu-item-wrapper"]',
      (items) => items.slice(0, 15).map(item => {
        const name = item.querySelector('[data-testid="item-name"], [class*="name"], h3')?.innerText?.trim();
        const price = item.querySelector('[data-testid="item-price"], [class*="price"]')?.innerText?.trim();
        const restaurant = item.closest('[data-testid="store-card"]')
          ?.querySelector('[data-testid="store-name"], [class*="store-name"]')?.innerText?.trim();
        const rating = item.closest('[data-testid="store-card"]')
          ?.querySelector('[class*="rating"]')?.innerText?.trim();
        return { name, price, restaurant, rating };
      }).filter(i => i.name)
    ).catch(() => []);

    // Also get store cards
    const storeResults = await page.$$eval(
      '[data-testid="store-card"], [class*="StoreCard"]',
      (cards) => cards.slice(0, 10).map(card => {
        const name = card.querySelector('[data-testid="store-name"], [class*="store-name"], h3')?.innerText?.trim();
        const rating = card.querySelector('[class*="rating"], [aria-label*="rating"]')?.innerText?.trim();
        const deliveryFee = card.querySelector('[class*="delivery-fee"], [class*="DeliveryFee"]')?.innerText?.trim();
        const eta = card.querySelector('[class*="time"], [class*="eta"]')?.innerText?.trim();
        return { name, rating, deliveryFee, eta };
      }).filter(c => c.name)
    ).catch(() => []);

    // Combine: dish items with their store context
    if (dishResults.length > 0) {
      dishResults.forEach(item => {
        const itemPrice = parsePrice(item.price);
        // Find matching store for delivery fee
        const store = storeResults.find(s => s.name && item.restaurant && s.name.includes(item.restaurant.substring(0, 8)));
        const deliveryFee = store ? parseDeliveryFee(store.deliveryFee) : null;
        results.push({
          platform: 'Uber Eats',
          restaurant: item.restaurant || 'See site',
          item: item.name,
          itemPrice,
          deliveryFee,
          totalPrice: (itemPrice != null && deliveryFee != null) ? itemPrice + deliveryFee : null,
          rating: parseRating(item.rating || store?.rating),
          eta: store?.eta || null,
          url: page.url()
        });
      });
    } else {
      // Fall back to store cards
      storeResults.forEach(card => {
        results.push({
          platform: 'Uber Eats',
          restaurant: card.name,
          item: dish,
          itemPrice: null,
          deliveryFee: parseDeliveryFee(card.deliveryFee),
          totalPrice: null,
          rating: parseRating(card.rating),
          eta: card.eta || null,
          url: page.url()
        });
      });
    }

    console.log(`[UberEats] Found ${results.length} results`);
  } catch (err) {
    console.error('[UberEats] Scrape error:', err.message);
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
  return parsePrice(str);
}

function parseRating(str) {
  if (!str) return null;
  const match = str.match(/([\d.]+)/);
  return match ? parseFloat(match[1]) : null;
}

module.exports = { scrapeUberEats };
