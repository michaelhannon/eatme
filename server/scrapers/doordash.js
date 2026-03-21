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
    // Step 1: Go straight to search with address as query param — skip homepage modal entirely
    // DoorDash supports address in URL: /food-delivery/[city-state]/[zip]/
    const encodedDish = encodeURIComponent(dish);

    // First try: load homepage and wait for any input
    console.log(`[DoorDash] Loading homepage...`);
    await page.goto('https://www.doordash.com', { waitUntil: 'domcontentloaded', timeout });
    await page.waitForTimeout(3000);

    // Log what's on the page
    const pageTitle = await page.title();
    console.log(`[DoorDash] Page title: ${pageTitle}`);

    // Try to dismiss modal
    await page.keyboard.press('Escape');
    await page.waitForTimeout(800);

    // Find ANY text input on the page
    const allInputs = await page.evaluate(() => {
      const inputs = document.querySelectorAll('input');
      return Array.from(inputs).map(i => ({
        id: i.id,
        name: i.name,
        placeholder: i.placeholder,
        type: i.type,
        visible: i.offsetWidth > 0
      }));
    });
    console.log(`[DoorDash] All inputs found: ${JSON.stringify(allInputs)}`);

    // Try every possible address input selector
    const addressSelectors = [
      '#HomeAddressAutocomplete',
      'input[placeholder="Enter delivery address"]',
      'input[placeholder*="delivery address"]',
      'input[placeholder*="Enter delivery"]',
      'input[placeholder*="address"]',
      'input[placeholder*="Address"]',
      'input[data-anchor-id="AddressAutocomplete"]',
      '[data-anchor-id="AddressAutocomplete"] input',
      'input[autocomplete="street-address"]',
      'input[type="text"]'  // last resort
    ];

    let addressInput = null;
    let usedSelector = null;
    for (const sel of addressSelectors) {
      const el = await page.$(sel);
      if (el) {
        const visible = await el.evaluate(e => e.offsetWidth > 0);
        if (visible) {
          addressInput = el;
          usedSelector = sel;
          break;
        }
      }
    }

    if (addressInput) {
      console.log(`[DoorDash] Found address input with: ${usedSelector}`);
      await addressInput.click({ force: true });
      await addressInput.fill('');
      await addressInput.type(address, { delay: 40 });
      await page.waitForTimeout(2000);

      // Log suggestions
      const suggestions = await page.evaluate(() => {
        const items = document.querySelectorAll('li[role="option"], [id*="Suggestion"]');
        return Array.from(items).slice(0, 3).map(i => i.innerText?.substring(0, 50));
      });
      console.log(`[DoorDash] Suggestions: ${JSON.stringify(suggestions)}`);

      const suggestion = await page.$('li[role="option"]:first-child, [id*="Suggestion"]:first-child');
      if (suggestion) {
        await suggestion.click({ force: true });
        console.log('[DoorDash] Clicked suggestion');
      } else {
        await page.keyboard.press('ArrowDown');
        await page.waitForTimeout(300);
        await page.keyboard.press('Enter');
        console.log('[DoorDash] Used keyboard for suggestion');
      }
      await page.waitForTimeout(2500);
      console.log(`[DoorDash] URL after address: ${page.url()}`);
    } else {
      console.log('[DoorDash] No address input found on homepage, trying direct search URL');
    }

    // Step 2: Navigate to search
    await page.goto(`https://www.doordash.com/search/store/${encodedDish}/`, { waitUntil: 'domcontentloaded', timeout });
    await page.waitForTimeout(4000);
    console.log(`[DoorDash] Search URL: ${page.url()}`);

    const preview = await page.evaluate(() => document.body.innerText.substring(0, 300));
    console.log(`[DoorDash] Preview: ${preview}`);

    // Check what links exist
    const storeLinks = await page.evaluate(() => {
      const links = document.querySelectorAll('a[href*="/store/"]');
      return Array.from(links).slice(0, 3).map(l => ({ href: l.getAttribute('href'), text: l.innerText?.substring(0, 50) }));
    });
    console.log(`[DoorDash] Store links found: ${JSON.stringify(storeLinks)}`);

    const rawCards = await page.evaluate(() => {
      const seen = new Set();
      const out = [];
      const cards = document.querySelectorAll('a[href*="/store/"]');
      for (const card of cards) {
        const href = card.getAttribute('href');
        if (!href || seen.has(href)) continue;
        seen.add(href);
        const text = card.innerText || '';
        const lines = text.split('\n').map(l => l.trim()).filter(l => l.length > 0);
        const name = lines[0];
        if (name && name.length > 2) {
          out.push({ href, name, text, lines });
          if (out.length >= 8) break;
        }
      }
      return out;
    });

    console.log(`[DoorDash] Found ${rawCards.length} stores`);

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

    const itemPromises = storeData.map(async (store) => {
      if (!store.href) return { items: [], deliveryFee: store.deliveryFee };
      try {
        const storeUrl = store.href.startsWith('http') ? store.href : `https://www.doordash.com${store.href}`;
        const storePage = await context.newPage();
        await storePage.goto(storeUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
        await storePage.waitForTimeout(2500);

        const data = await storePage.evaluate((searchDish) => {
          const dishWords = searchDish.toLowerCase().split(' ').filter(w => w.length > 2);
          const lines = document.body.innerText.split('\n').map(l => l.trim()).filter(l => l);

          let deliveryFee = null;
          for (const line of lines) {
            if (/free delivery/i.test(line)) { deliveryFee = 0; break; }
            if (/delivery fee/i.test(line)) {
              const m = line.match(/\$(\d+\.?\d*)/);
              if (m) { deliveryFee = parseFloat(m[1]); break; }
            }
          }

          const items = [];
          for (let i = 0; i < lines.length - 1; i++) {
            if (!dishWords.some(w => lines[i].toLowerCase().includes(w))) continue;
            if (lines[i].length > 80) continue;
            for (let j = i + 1; j <= Math.min(i + 3, lines.length - 1); j++) {
              const m = lines[j].match(/^\$(\d+\.\d{2})$/) || lines[j].match(/^\$(\d+)$/);
              if (m) {
                const price = parseFloat(m[1]);
                if (price > 1 && price < 150) { items.push({ name: lines[i].substring(0, 70), price }); break; }
              }
            }
          }

          const seen = new Set();
          return {
            deliveryFee,
            items: items.filter(r => { const k = `${r.name}|${r.price}`; if (seen.has(k)) return false; seen.add(k); return true; }).slice(0, 4)
          };
        }, dish);

        await storePage.close();
        console.log(`[DoorDash] ${store.name}: ${data.items.length} items, fee: $${data.deliveryFee}`);
        return data;
      } catch(e) {
        console.log(`[DoorDash] Store failed ${store.name}: ${e.message.split('\n')[0]}`);
        return { items: [], deliveryFee: store.deliveryFee };
      }
    });

    const allData = await Promise.all(itemPromises);

    storeData.forEach((store, i) => {
      const { items, deliveryFee } = allData[i];
      if (items.length > 0) {
        items.forEach(item => {
          const total = deliveryFee != null ? parseFloat((item.price + deliveryFee).toFixed(2)) : null;
          results.push({ platform: 'DoorDash', restaurant: store.name, item: item.name, itemPrice: item.price, deliveryFee, totalPrice: total, rating: store.rating, eta: store.eta, url: page.url() });
        });
      } else {
        results.push({ platform: 'DoorDash', restaurant: store.name, item: dish, itemPrice: null, deliveryFee, totalPrice: null, rating: store.rating, eta: store.eta, url: page.url() });
      }
    });

    console.log(`[DoorDash] Done: ${results.length} results`);
  } catch (err) {
    console.error('[DoorDash] Error:', err.message.split('\n')[0]);
  } finally {
    await browser.close();
  }
  return results;
}

module.exports = { scrapeDoorDash };
