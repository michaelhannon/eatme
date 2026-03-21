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

  // Parse city/state/zip for DoorDash URL
  function parseAddressForDD(addr) {
    const m = addr.match(/,\s*([^,]+?)\s+([A-Z]{2})\s+(\d{5})/);
    if (!m) return null;
    const city = m[1].toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
    const state = m[2].toLowerCase();
    const zip = m[3];
    return { city, state, zip, slug: `${city}-${state}` };
  }

  try {
    const loc = parseAddressForDD(address);
    console.log(`[DoorDash] Address parsed: ${JSON.stringify(loc)}`);

    // Strategy: Go directly to search URL with city/state — skip homepage entirely
    // DoorDash URL format: /delivery/[city]-[state]/[dish]/
    const encodedDish = encodeURIComponent(dish);
    const dishSlug = dish.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');

    const searchUrls = loc ? [
      `https://www.doordash.com/delivery/${loc.slug}/${dishSlug}/`,
      `https://www.doordash.com/delivery/${loc.zip}/${dishSlug}/`,
      `https://www.doordash.com/search/store/${encodedDish}/`,
    ] : [
      `https://www.doordash.com/search/store/${encodedDish}/`,
    ];

    let landed = false;
    for (const url of searchUrls) {
      console.log(`[DoorDash] Trying: ${url}`);
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
      await page.waitForTimeout(3000);

      // Dismiss any modal
      await page.keyboard.press('Escape');
      await page.waitForTimeout(500);

      const preview = await page.evaluate(() => document.body.innerText.substring(0, 200));
      console.log(`[DoorDash] Preview: ${preview.substring(0, 100)}`);

      // Check if we got real results (store links present)
      const hasStores = await page.$('a[href*="/store/"]');
      if (hasStores) {
        console.log(`[DoorDash] Found stores at: ${url}`);
        landed = true;
        break;
      }

      // Check if it's asking for address input
      const needsAddress = await page.$('#HomeAddressAutocomplete, input[placeholder*="delivery address"], input[placeholder*="Enter delivery"]');
      if (needsAddress) {
        console.log(`[DoorDash] Address input found, entering address...`);
        await needsAddress.click({ force: true });
        await needsAddress.fill('');
        await needsAddress.type(address, { delay: 40 });
        await page.waitForTimeout(1800);
        const suggestion = await page.$('li[role="option"]:first-child, [id*="Suggestion"]:first-child');
        if (suggestion) await suggestion.click({ force: true });
        else { await page.keyboard.press('ArrowDown'); await page.waitForTimeout(300); await page.keyboard.press('Enter'); }
        await page.waitForTimeout(2500);
        console.log(`[DoorDash] URL after address: ${page.url()}`);
        // Re-navigate to search
        await page.goto(`https://www.doordash.com/search/store/${encodedDish}/`, { waitUntil: 'domcontentloaded', timeout });
        await page.waitForTimeout(3000);
        landed = true;
        break;
      }
    }

    console.log(`[DoorDash] Search URL: ${page.url()}`);
    await page.waitForSelector('a[href*="/store/"]', { timeout: 12000 }).catch(() => console.log('[DoorDash] No store links'));

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
        if (name && name.length > 2 && !name.startsWith('$')) {
          out.push({ href, name, text, lines });
          if (out.length >= 8) break;
        }
      }
      return out;
    });

    console.log(`[DoorDash] Found ${rawCards.length} stores`);
    if (rawCards[0]) console.log(`[DoorDash] Sample: ${JSON.stringify(rawCards[0].lines.slice(0,6))}`);

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
        await storePage.waitForTimeout(3000);

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
            if (lines[i].length > 80) continue;
            for (let j = i + 1; j <= Math.min(i + 3, lines.length - 1); j++) {
              const m = lines[j].match(/^\$(\d+\.\d{2})$/) || lines[j].match(/^\$(\d+)$/);
              if (m) { const price = parseFloat(m[1]); if (price > 1 && price < 150) { items.push({ name: lines[i].substring(0, 70), price }); break; } }
            }
          }
          const seen = new Set();
          return { deliveryFee, items: items.filter(r => { const k=`${r.name}|${r.price}`; if(seen.has(k))return false; seen.add(k); return true; }).slice(0, 4) };
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
