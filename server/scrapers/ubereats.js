const { chromium } = require('playwright');
const { getDishWords } = require('../dishWords');

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
    console.log(`[UberEats] Setting address...`);
    await page.goto('https://www.ubereats.com', { waitUntil: 'domcontentloaded', timeout });
    await page.waitForTimeout(2500);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(500);

    // Wait for any visible text input
    await page.waitForFunction(() => {
      return Array.from(document.querySelectorAll('input[type="text"], input:not([type])'))
        .some(i => i.offsetWidth > 0 && i.offsetHeight > 0);
    }, { timeout: 10000 }).catch(() => {});

    const inputHandle = await page.evaluateHandle(() =>
      Array.from(document.querySelectorAll('input[type="text"], input:not([type])'))
        .find(i => i.offsetWidth > 0 && i.offsetHeight > 0) || null
    );
    const addressInput = inputHandle.asElement();

    if (addressInput) {
      const placeholder = await addressInput.evaluate(el => el.placeholder);
      console.log(`[UberEats] Found input: "${placeholder}"`);
      await addressInput.click({ force: true });
      await addressInput.fill('');
      await addressInput.type(address, { delay: 50 });
      await page.waitForTimeout(2000);

      // Wait for suggestions to appear
      await page.waitForSelector('li[role="option"]', { timeout: 5000 }).catch(() => {});
      const suggestions = await page.evaluate(() =>
        Array.from(document.querySelectorAll('li[role="option"]')).slice(0,3).map(s => s.innerText?.substring(0,60))
      );
      console.log(`[UberEats] Suggestions: ${JSON.stringify(suggestions)}`);

      const suggestion = await page.$('li[role="option"]:first-child');
      if (suggestion) {
        await suggestion.click({ force: true });
        console.log('[UberEats] Clicked address suggestion');
      } else {
        await page.keyboard.press('ArrowDown');
        await page.waitForTimeout(300);
        await page.keyboard.press('Enter');
      }
      await page.waitForTimeout(2000);
      const confirmBtn = await page.$('button:has-text("Deliver here"), button:has-text("Confirm")');
      if (confirmBtn) { await confirmBtn.click({ force: true }); await page.waitForTimeout(800); }
      console.log(`[UberEats] URL after address: ${page.url()}`);
    } else {
      console.log('[UberEats] No address input found');
    }

    await page.goto(`https://www.ubereats.com/search?q=${encodeURIComponent(dish)}`, { waitUntil: 'domcontentloaded', timeout });
    await page.waitForTimeout(3500);

    await page.waitForSelector('[data-testid="store-card"], a[href*="/store/"]', { timeout: 12000 }).catch(() => {});

    const rawCards = await page.evaluate(() => {
      const seen = new Set();
      const out = [];
      const cards = document.querySelectorAll('[data-testid="store-card"]');
      for (const card of cards) {
        const link = card.querySelector('a[href*="/store/"]');
        const href = link?.getAttribute('href');
        if (!href || seen.has(href)) continue;
        seen.add(href);
        const fullText = card.innerText || '';
        const lines = fullText.split('\n').map(l => l.trim()).filter(l => l.length > 0);
        const name = lines[0];
        if (!name || name.length < 2) continue;
        const ratingLine = lines.find(l => /^[45]\.\d$/.test(l));
        // Find ETA anywhere in card text
        const etaMatch = fullText.match(/(\d+[\s\u2013\-]+\d+\s*min|\d+\s*min)/i);
        out.push({ href, name, ratingLine, eta: etaMatch ? etaMatch[1].trim() : null });
        if (out.length >= 6) break;
      }
      return out;
    });

    console.log(`[UberEats] Found ${rawCards.length} store cards`);

    const storeData = rawCards.map(card => ({
      name: card.name,
      href: card.href,
      rating: card.ratingLine ? parseFloat(card.ratingLine) : null,
      eta: card.eta || null
    }));

    for (const store of storeData) {
      if (!store.href) {
        results.push({ platform: 'Uber Eats', restaurant: store.name, item: dish, itemPrice: null, deliveryFee: null, totalPrice: null, rating: store.rating, eta: store.eta, url: page.url() });
        continue;
      }
      try {
        const storeUrl = store.href.startsWith('http') ? store.href : `https://www.ubereats.com${store.href}`;
        const storePage = await context.newPage();
        await storePage.goto(storeUrl, { waitUntil: 'domcontentloaded', timeout: 12000 });
        await storePage.waitForTimeout(2500);

        const data = await storePage.evaluate((searchDish) => {
          const dishWords = searchDish.toLowerCase().split(' ').filter(w => w.length > 2);
          const allText = document.body.innerText;
          const lines = allText.split('\n').map(l => l.trim()).filter(l => l);

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
          if (items.length === 0) {
            const allDishWords = getDishWords(searchDish);
            for (let i = 0; i < lines.length - 1; i++) {
              if (!allDishWords.some(w => lines[i].toLowerCase().includes(w))) continue;
              if (lines[i].length > 100) continue;
              for (let j = i + 1; j <= Math.min(i + 3, lines.length - 1); j++) {
                const m = lines[j].match(/^\$(\d+\.\d{2})$/) || lines[j].match(/^\$(\d+)$/);
                if (m) { const p = parseFloat(m[1]); if (p > 1 && p < 150) { items.push({ name: lines[i].substring(0, 70), price: p }); break; } }
              }
              if (items.length >= 4) break;
            }
          }
          const seen = new Set();
          return { deliveryFee, items: items.filter(r => { const k=`${r.name}|${r.price}`; if(seen.has(k))return false; seen.add(k); return true; }).slice(0, 4) };
        }, dish);

        await storePage.close();
        console.log(`[UberEats] ${store.name}: ${data.items.length} items, fee: $${data.deliveryFee}, eta: ${store.eta}`);

        if (data.items.length > 0) {
          data.items.forEach(item => {
            const total = data.deliveryFee != null ? parseFloat((item.price + data.deliveryFee).toFixed(2)) : null;
            results.push({ platform: 'Uber Eats', restaurant: store.name, item: item.name, itemPrice: item.price, deliveryFee: data.deliveryFee, totalPrice: total, rating: store.rating, eta: store.eta, url: `https://www.ubereats.com${store.href}` });
          });
        } else {
          // Only show if restaurant name suggests it serves the dish
          const dishWords = dish.toLowerCase().split(' ').filter(w => w.length > 2);
          const nameMatchesDish = dishWords.some(w => store.name.toLowerCase().includes(w));
          if (nameMatchesDish) {
            results.push({ platform: 'Uber Eats', restaurant: store.name, item: dish, itemPrice: null, deliveryFee: data.deliveryFee, totalPrice: null, rating: store.rating, eta: store.eta, url: `https://www.ubereats.com${store.href}` });
          } else {
            console.log(`[UberEats] Skipping ${store.name} — no items and name doesn't match dish`);
          }
        }
      } catch(e) {
        console.log(`[UberEats] Store failed ${store.name}: ${e.message.split('\n')[0]}`);
        results.push({ platform: 'Uber Eats', restaurant: store.name, item: dish, itemPrice: null, deliveryFee: null, totalPrice: null, rating: store.rating, eta: store.eta, url: `https://www.ubereats.com${store.href}` });
      }
    }

    console.log(`[UberEats] Done: ${results.length} results`);
  } catch (err) {
    console.error('[UberEats] Error:', err.message.split('\n')[0]);
  } finally {
    await browser.close();
  }
  return results;
}

module.exports = { scrapeUberEats };
