const { chromium } = require('playwright');

function getProxyConfig() {
  const host = process.env.PROXY_HOST;
  const port = process.env.PROXY_PORT;
  const user = process.env.PROXY_USER;
  const pass = process.env.PROXY_PASS;
  if (!host || !port) return null;
  return { server: `http://${host}:${port}`, username: user, password: pass };
}

async function scrapeGrubHub({ address, dish, credentials, headless = true, timeout = 45000, platform = 'GrubHub' }) {
  if (platform === 'Seamless') {
    console.log(`[Seamless] Skipping — same backend as GrubHub`);
    return [];
  }

  const proxy = getProxyConfig();
  if (proxy) console.log(`[GrubHub] Using proxy: ${proxy.server}`);

  const browser = await chromium.launch({
    headless,
    ...(proxy && { proxy }),
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-blink-features=AutomationControlled']
  });

  const context = await browser.newContext({
    ...(proxy && { proxy }),
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
    console.log(`[GrubHub] Loading homepage...`);
    await page.goto('https://www.grubhub.com', { waitUntil: 'domcontentloaded', timeout });
    await page.waitForTimeout(2500);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(500);

    // Wait for visible input
    await page.waitForFunction(() => {
      return Array.from(document.querySelectorAll('input')).some(i => i.offsetWidth > 0 && i.offsetHeight > 0);
    }, { timeout: 8000 }).catch(() => {});

    const inputHandle = await page.evaluateHandle(() =>
      Array.from(document.querySelectorAll('input')).find(i => i.offsetWidth > 0 && i.offsetHeight > 0) || null
    );
    const inputEl = inputHandle.asElement();
    if (inputEl) {
      const placeholder = await inputEl.evaluate(el => el.placeholder);
      console.log(`[GrubHub] Found visible input: "${placeholder}"`);
      await inputEl.click();
      await inputEl.fill('');
      await inputEl.type(address, { delay: 40 });
      await page.waitForTimeout(1800);
      const suggestion = await page.$('li[role="option"]:first-child, [data-testid="suggestion-item"]:first-child');
      if (suggestion) await suggestion.click();
      else { await page.keyboard.press('ArrowDown'); await page.waitForTimeout(300); await page.keyboard.press('Enter'); }
      await page.waitForTimeout(2500);
      console.log(`[GrubHub] After address: ${page.url()}`);
    }

    // Search using search bar
    const searchInput = await page.waitForSelector(
      'input[placeholder*="Search"], input[placeholder*="search"], input[name="search"]',
      { timeout: 10000 }
    ).catch(() => null);

    if (searchInput) {
      await searchInput.click();
      await searchInput.fill(dish);
      await page.keyboard.press('Enter');
      await page.waitForTimeout(4000);
      console.log(`[GrubHub] Search URL: ${page.url()}`);
    }

    // Wait longer for search results to render
    await page.waitForTimeout(3000);

    // Log page content to understand structure
    const preview = await page.evaluate(() => document.body.innerText.substring(0, 400));
    console.log(`[GrubHub] Page preview: ${preview.substring(0, 200)}`);

    // Wait for restaurant links to appear
    await page.waitForSelector('a[href*="/restaurant/"]', { timeout: 10000 }).catch(() => {
      console.log('[GrubHub] No restaurant links found after wait');
    });

    // Count links
    const linkCount = await page.evaluate(() => document.querySelectorAll('a[href*="/restaurant/"]').length);
    console.log(`[GrubHub] Restaurant link count: ${linkCount}`);

    const rawCards = await page.evaluate(() => {
      const seen = new Set();
      const out = [];
      const links = document.querySelectorAll('a[href*="/restaurant/"]');
      for (const link of links) {
        const href = link.getAttribute('href');
        if (!href || seen.has(href)) continue;
        seen.add(href);
        // Walk up to find container with full info
        let container = link;
        for (let i = 0; i < 8; i++) {
          if (!container.parentElement) break;
          container = container.parentElement;
          const lines = (container.innerText || '').split('\n').filter(l => l.trim()).length;
          if (lines >= 3) break;
        }
        const text = container.innerText || link.innerText || '';
        const lines = text.split('\n').map(l => l.trim()).filter(l => l.length > 0);
        const name = lines[0];
        if (name && name.length > 2 && !name.startsWith('$')) {
          out.push({ href, name, text, lines });
          if (out.length >= 6) break;
        }
      }
      return out;
    });

    console.log(`[GrubHub] Found ${rawCards.length} restaurants`);
    if (rawCards[0]) console.log(`[GrubHub] Sample: ${JSON.stringify(rawCards[0].lines.slice(0,8))}`);

    const storeData = rawCards.map(card => {
      const text = card.text;
      let deliveryFee = null;
      if (/free delivery|\$0\.00/i.test(text)) deliveryFee = 0;
      else {
        const m = text.match(/\$(\d+\.?\d*)\s*(?:delivery fee|delivery)/i) || text.match(/delivery[:\s]+\$(\d+\.?\d*)/i);
        if (m) deliveryFee = parseFloat(m[1]);
      }
      const ratingM = text.match(/\b([45]\.\d)\s*[\(\d]/);
      const etaM = text.match(/•\s*(\d+[\s–\-]+\d+\s*min|\d+\s*min)/i) || text.match(/(\d+[\s–\-]+\d+\s*min|\d+\s*min)/i);
      return { name: card.name, href: card.href, deliveryFee, rating: ratingM ? parseFloat(ratingM[1]) : null, eta: etaM ? etaM[1]?.trim() : null };
    });

    for (const store of storeData) {
      if (!store.href) {
        results.push({ platform: 'GrubHub', restaurant: store.name, item: dish, itemPrice: null, deliveryFee: store.deliveryFee, totalPrice: null, rating: store.rating, eta: store.eta, url: page.url() });
        continue;
      }
      try {
        const storeUrl = store.href.startsWith('http') ? store.href : `https://www.grubhub.com${store.href}`;
        const storePage = await context.newPage();
        await storePage.goto(storeUrl, { waitUntil: 'domcontentloaded', timeout: 12000 });
        await storePage.waitForTimeout(3000);
        await storePage.waitForSelector('[class*="menuItem"], [class*="MenuItem"]', { timeout: 5000 }).catch(() => {});

        const data = await storePage.evaluate((searchDish) => {
          const dishWords = searchDish.toLowerCase().split(' ').filter(w => w.length > 2);
          const lines = document.body.innerText.split('\n').map(l => l.trim()).filter(l => l);
          let deliveryFee = null;
          for (const line of lines) {
            if (/free delivery/i.test(line)) { deliveryFee = 0; break; }
            if (/delivery fee/i.test(line)) { const m = line.match(/\$(\d+\.?\d*)/); if (m) { deliveryFee = parseFloat(m[1]); break; } }
          }
          const items = [];
          // Strategy 1: exact match
          for (let i = 0; i < lines.length - 1; i++) {
            if (!dishWords.some(w => lines[i].toLowerCase().includes(w))) continue;
            if (lines[i].length > 100) continue;
            for (let j = i + 1; j <= Math.min(i + 3, lines.length - 1); j++) {
              const m = lines[j].match(/^\$(\d+\.\d{2})$/) || lines[j].match(/^\$(\d+)$/);
              if (m) { const p = parseFloat(m[1]); if (p > 1 && p < 150) { items.push({ name: lines[i].substring(0, 70), price: p }); break; } }
            }
          }
          // Strategy 2: related food words
          if (items.length === 0) {
            const foodWords = ['pizza', 'pie', 'pepperoni', 'chicken', 'burger', 'wrap', 'sandwich', 'pasta', 'soup', 'salad', 'calzone', 'stromboli'];
            for (let i = 0; i < lines.length - 1; i++) {
              const lineL = lines[i].toLowerCase();
              if (!foodWords.some(w => lineL.includes(w))) continue;
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
        const deliveryFee = data.deliveryFee ?? store.deliveryFee;
        console.log(`[GrubHub] ${store.name}: ${data.items.length} items, fee: $${deliveryFee}, rating: ${store.rating}, eta: ${store.eta}`);

        if (data.items.length > 0) {
          data.items.forEach(item => {
            const total = deliveryFee != null ? parseFloat((item.price + deliveryFee).toFixed(2)) : null;
            results.push({ platform: 'GrubHub', restaurant: store.name, item: item.name, itemPrice: item.price, deliveryFee, totalPrice: total, rating: store.rating, eta: store.eta, url: page.url() });
          });
        } else {
          results.push({ platform: 'GrubHub', restaurant: store.name, item: dish, itemPrice: null, deliveryFee, totalPrice: null, rating: store.rating, eta: store.eta, url: page.url() });
        }
      } catch(e) {
        console.log(`[GrubHub] Store failed ${store.name}: ${e.message.split('\n')[0]}`);
        results.push({ platform: 'GrubHub', restaurant: store.name, item: dish, itemPrice: null, deliveryFee: store.deliveryFee, totalPrice: null, rating: store.rating, eta: store.eta, url: page.url() });
      }
    }

    console.log(`[GrubHub] Done: ${results.length} results`);
  } catch (err) {
    console.error(`[GrubHub] Error:`, err.message.split('\n')[0]);
  } finally {
    await browser.close();
  }
  return results;
}

async function scrapeSeamless(params) {
  console.log(`[Seamless] Skipping — same backend as GrubHub`);
  return [];
}

module.exports = { scrapeGrubHub, scrapeSeamless };
