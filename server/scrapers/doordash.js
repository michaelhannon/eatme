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
    console.log(`[DoorDash] Loading homepage...`);
    await page.goto('https://www.doordash.com', { waitUntil: 'domcontentloaded', timeout });
    await page.waitForTimeout(3000);

    // The login modal has an iframe that intercepts clicks on the address input.
    // Fix: remove the modal from the DOM entirely, then interact with the address input.
    await page.evaluate(() => {
      // Remove login modal and any overlay blocking the address input
      const selectors = [
        '[data-testid="LAYER-MANAGER-MODAL"]',
        '[class*="ModalLayer"]',
        '[class*="overlay"]',
        '[class*="Overlay"]',
        'iframe[title*="Login"]',
        'iframe[title*="Signup"]',
        '[class*="modal"]',
      ];
      selectors.forEach(sel => {
        document.querySelectorAll(sel).forEach(el => el.remove());
      });
    });
    await page.waitForTimeout(500);

    // Now find and fill the address input
    const addressInput = await page.$('#HomeAddressAutocomplete, input[placeholder="Enter delivery address"], input[placeholder*="delivery address"]');
    if (addressInput) {
      console.log('[DoorDash] Found address input, filling...');
      await addressInput.click({ force: true });
      await page.waitForTimeout(300);
      await addressInput.fill('');
      await addressInput.type(address, { delay: 50 });
      await page.waitForTimeout(2000);

      const suggestions = await page.evaluate(() =>
        Array.from(document.querySelectorAll('li[role="option"]')).slice(0, 3).map(i => i.innerText?.substring(0, 60))
      );
      console.log(`[DoorDash] Suggestions: ${JSON.stringify(suggestions)}`);

      const suggestion = await page.$('li[role="option"]:first-child');
      if (suggestion) {
        await suggestion.click({ force: true });
        console.log('[DoorDash] Clicked first suggestion');
      } else {
        await page.keyboard.press('ArrowDown');
        await page.waitForTimeout(300);
        await page.keyboard.press('Enter');
      }
      await page.waitForTimeout(3000);
      console.log(`[DoorDash] URL after address: ${page.url()}`);
    } else {
      console.log('[DoorDash] Address input not found, logging all inputs:');
      const inputs = await page.evaluate(() =>
        Array.from(document.querySelectorAll('input')).map(i => ({ id: i.id, placeholder: i.placeholder, visible: i.offsetWidth > 0 }))
      );
      console.log(JSON.stringify(inputs));
    }

    // Navigate to search
    const encodedDish = encodeURIComponent(dish);
    await page.goto(`https://www.doordash.com/search/store/${encodedDish}/`, { waitUntil: 'domcontentloaded', timeout });
    await page.waitForTimeout(4000);

    const searchUrl = page.url();
    console.log(`[DoorDash] Search URL: ${searchUrl}`);
    const preview = await page.evaluate(() => document.body.innerText.substring(0, 200));
    console.log(`[DoorDash] Preview: ${preview.substring(0, 150)}`);

    await page.waitForSelector('a[href*="/store/"]', { timeout: 10000 }).catch(() => {});

    const rawCards = await page.evaluate(() => {
      const seen = new Set();
      const out = [];
      for (const card of document.querySelectorAll('a[href*="/store/"]')) {
        const href = card.getAttribute('href');
        if (!href || seen.has(href)) continue;
        seen.add(href);
        const text = card.innerText || '';
        const lines = text.split('\n').map(l => l.trim()).filter(l => l.length > 0);
        const name = lines[0];
        if (name && name.length > 2 && !name.startsWith('$')) {
          out.push({ href, name, text, lines });
          if (out.length >= 6) break;
        }
      }
      return out;
    });

    console.log(`[DoorDash] Found ${rawCards.length} stores`);
    if (rawCards[0]) console.log(`[DoorDash] Sample: ${JSON.stringify(rawCards[0].lines.slice(0, 6))}`);

    const storeData = rawCards.map(card => {
      const text = card.text;
      let deliveryFee = /free/i.test(text) ? 0 : null;
      if (deliveryFee === null) {
        const m = text.match(/\$(\d+\.?\d*)\s*(?:delivery fee|delivery)/i);
        if (m) deliveryFee = parseFloat(m[1]);
      }
      const ratingM = text.match(/\b([45]\.\d)\b/);
      const etaM = text.match(/(\d+[\s–\-−]+\d+\s*min|\d+\s*min)/i);
      return { name: card.name, href: card.href, deliveryFee, rating: ratingM ? parseFloat(ratingM[1]) : null, eta: etaM ? etaM[1]?.trim() : null };
    });

    for (const store of storeData) {
      if (!store.href) {
        results.push({ platform: 'DoorDash', restaurant: store.name, item: dish, itemPrice: null, deliveryFee: store.deliveryFee, totalPrice: null, rating: store.rating, eta: store.eta, url: page.url() });
        continue;
      }
      try {
        const storeUrl = store.href.startsWith('http') ? store.href : `https://www.doordash.com${store.href}`;
        const storePage = await context.newPage();
        await storePage.goto(storeUrl, { waitUntil: 'domcontentloaded', timeout: 12000 });
        await storePage.waitForTimeout(2500);

        const data = await storePage.evaluate((searchDish) => {
          const dishWords = searchDish.toLowerCase().split(' ').filter(w => w.length > 2);
          const lines = document.body.innerText.split('\n').map(l => l.trim()).filter(l => l);
          let deliveryFee = null;
          for (const line of lines) {
            if (/free delivery/i.test(line)) { deliveryFee = 0; break; }
            if (/delivery fee/i.test(line)) { const m = line.match(/\$(\d+\.?\d*)/); if (m) { deliveryFee = parseFloat(m[1]); break; } }
          }
          const items = [];
          for (let i = 0; i < lines.length - 1; i++) {
            if (!dishWords.some(w => lines[i].toLowerCase().includes(w))) continue;
            if (lines[i].length > 100) continue;
            for (let j = i + 1; j <= Math.min(i + 3, lines.length - 1); j++) {
              const m = lines[j].match(/^\$(\d+\.\d{2})$/) || lines[j].match(/^\$(\d+)$/);
              if (m) { const p = parseFloat(m[1]); if (p > 1 && p < 150) { items.push({ name: lines[i].substring(0, 70), price: p }); break; } }
            }
          }
          const seen = new Set();
          return { deliveryFee, items: items.filter(r => { const k=`${r.name}|${r.price}`; if(seen.has(k))return false; seen.add(k); return true; }).slice(0, 4) };
        }, dish);

        await storePage.close();
        const deliveryFee = data.deliveryFee ?? store.deliveryFee;
        console.log(`[DoorDash] ${store.name}: ${data.items.length} items, fee: $${deliveryFee}`);

        if (data.items.length > 0) {
          data.items.forEach(item => {
            const total = deliveryFee != null ? parseFloat((item.price + deliveryFee).toFixed(2)) : null;
            results.push({ platform: 'DoorDash', restaurant: store.name, item: item.name, itemPrice: item.price, deliveryFee, totalPrice: total, rating: store.rating, eta: store.eta, url: page.url() });
          });
        } else {
          results.push({ platform: 'DoorDash', restaurant: store.name, item: dish, itemPrice: null, deliveryFee, totalPrice: null, rating: store.rating, eta: store.eta, url: page.url() });
        }
      } catch(e) {
        console.log(`[DoorDash] Store failed ${store.name}: ${e.message.split('\n')[0]}`);
        results.push({ platform: 'DoorDash', restaurant: store.name, item: dish, itemPrice: null, deliveryFee: store.deliveryFee, totalPrice: null, rating: store.rating, eta: store.eta, url: page.url() });
      }
    }

    console.log(`[DoorDash] Done: ${results.length} results`);
  } catch (err) {
    console.error('[DoorDash] Error:', err.message.split('\n')[0]);
  } finally {
    await browser.close();
  }
  return results;
}

module.exports = { scrapeDoorDash };
