const { chromium } = require('playwright');

async function testPlatform(name, url, loginFn) {
  const result = { platform: name, status: 'unknown', detail: '', credsMissing: false };
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
  });
  try {
    const page = await browser.newPage({
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/121.0.0.0 Safari/537.36'
    });
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 25000 });
    const finalUrl = await loginFn(page);
    result.status = 'reached';
    result.detail = `Loaded OK. URL: ${finalUrl}`;
  } catch (e) {
    result.status = 'error';
    result.detail = e.message.substring(0, 200);
  } finally {
    await browser.close();
  }
  return result;
}

async function runLoginTests(creds) {
  const results = [];

  // Test 1: Can we reach DoorDash?
  results.push(await testPlatform('DoorDash', 'https://www.doordash.com', async (page) => {
    if (!creds.doordash.email) { return 'NO CREDENTIALS SET'; }
    const emailInput = await page.$('input[name="email"], input[type="email"], [placeholder*="email"]');
    if (!emailInput) return `Page loaded but no email input found. URL: ${page.url()}`;
    await emailInput.fill(creds.doordash.email);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(2000);
    return page.url();
  }));

  // Test 2: Can we reach GrubHub?
  results.push(await testPlatform('GrubHub', 'https://www.grubhub.com', async (page) => {
    if (!creds.grubhub.email) return 'NO CREDENTIALS SET';
    const emailInput = await page.$('input[name="email"], input[type="email"]');
    if (!emailInput) return `Page loaded but no email input found. URL: ${page.url()}`;
    await emailInput.fill(creds.grubhub.email);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(2000);
    return page.url();
  }));

  // Test 3: Can we reach Uber Eats?
  results.push(await testPlatform('UberEats', 'https://www.ubereats.com', async (page) => {
    if (!creds.ubereats.email) return 'NO CREDENTIALS SET';
    return page.url();
  }));

  return results;
}

module.exports = { runLoginTests };
