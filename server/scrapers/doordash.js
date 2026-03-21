const { chromium } = require('playwright');
const path = require('path');

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

  // Hide webdriver flag
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });

  const page = await context.newPage();
  const results = [];

  try {
    const encodedDish = encodeURIComponent(dish);
    console.log(`[DoorDash] Navigating to search for "${dish}"...`);
    await page.goto(`https://www.doordash.com/search/store/${encodedDish}/`, { waitUntil: 'domcontentloaded', timeout });
    await page.waitForTimeout(3000);

    const currentUrl = page.url();
    console.log(`[DoorDash] URL after load: ${currentUrl}`);

    // Take a screenshot to diagnose what we're seeing
    const screenshotPath = '/tmp/doordash-debug.png';
    await page.screenshot({ path: screenshotPath, fullPage: false });
    console.log(`[DoorDash] Screenshot saved to ${screenshotPath}`);

    // Log page title and any blocking indicators
    const title = await page.title();
    console.log(`[DoorDash] Page title: ${title}`);

    // Check if we hit a CAPTCHA or block page
    const bodyText = await page.evaluate(() => document.body.innerText.substring(0, 500));
    console.log(`[DoorDash] Body preview: ${bodyText}`);

    // Dismiss any modal
    await page.keyboard.press('Escape');
    await page.waitForTimeout(800);

    // Check if address input is needed
    const needsAddress = await page.$('#HomeAddressAutocomplete, input[placeholder="Enter delivery address"], input[placeholder*="delivery address"]');
    if (needsAddress) {
      console.log('[DoorDash] Address input found, entering address...');
      await needsAddress.click({ force: true });
      await needsAddress.fill(address);
      await page.waitForTimeout(1500);
      const suggestion = await page.$('li[role="option"]:first-child, [id*="Suggestion"]:first-child');
      if (suggestion) {
        await suggestion.click({ force: true });
      } else {
        await page.keyboard.press('ArrowDown');
        await page.waitForTimeout(300);
        await page.keyboard.press('Enter');
      }
      await page.waitForTimeout(2500);
      console.log(`[DoorDash] URL after address: ${page.url()}`);
    } else {
      console.log('[DoorDash] No address input needed, already on results page');
    }

    // Wait for and scrape store cards
    await page.waitForSelector(
      '[data-anchor-id="StoreCard"], [class*="StoreCard"], [data-testid="store-card"]',
      { timeout: 15000 }
    ).catch(e => console.log('[DoorDash] No store cards found:', e.message.split('\n')[0]));

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

    console.log(`[DoorDash] Found ${storeCards.length} store cards`);

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

  } catch (err) {
    console.error('[DoorDash] Scrape error:', err.message.split('\n')[0]);
    try { await page.screenshot({ path: '/tmp/doordash-error.png' }); } catch(e) {}
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
