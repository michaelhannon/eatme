const { chromium } = require('playwright');

function getProxyConfig() {
  const host = process.env.PROXY_HOST;
  const port = process.env.PROXY_PORT;
  const user = process.env.PROXY_USER;
  const pass = process.env.PROXY_PASS;
  if (!host || !port) return null;
  return { server: `http://${host}:${port}`, username: user, password: pass };
}

async function scrapeDoorDash({ address, dish, credentials, headless = true, timeout = 45000 }) {
  const proxy = getProxyConfig();
  if (!proxy) {
    console.log(`[DoorDash] No proxy configured — skipping`);
    return [];
  }

  console.log(`[DoorDash] Using proxy: ${proxy.server}`);

  const browser = await chromium.launch({
    headless,
    proxy,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-blink-features=AutomationControlled',
      '--disable-features=IsolateOrigins,site-per-process',
      '--flag-switches-begin',
      '--disable-site-isolation-trials',
      '--flag-switches-end'
    ]
  });

  const context = await browser.newContext({
    proxy,
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 800 },
    extraHTTPHeaders: {
      'Accept-Language': 'en-US,en;q=0.9',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
      'sec-ch-ua': '"Not A(Brand";v="99", "Google Chrome";v="121", "Chromium";v="121"',
      'sec-ch-ua-mobile': '?0',
      'sec-ch-ua-platform': '"macOS"',
    },
    // Spoof timezone to match NJ
    timezoneId: 'America/New_York',
    locale: 'en-US',
  });

  await context.addInitScript(() => {
    // Full webdriver spoofing
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
    Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
    window.chrome = { runtime: {} };
    Object.defineProperty(navigator, 'permissions', {
      get: () => ({ query: () => Promise.resolve({ state: 'granted' }) })
    });
  });

  const page = await context.newPage();
  const results = [];

  try {
    console.log(`[DoorDash] Loading homepage...`);

    // Use networkidle so Cloudflare JS challenge has time to complete
    await page.goto('https://www.doordash.com', {
      waitUntil: 'networkidle',
      timeout
    }).catch(async () => {
      // networkidle can timeout on CF challenges — that's ok, check title
      console.log(`[DoorDash] networkidle timed out, checking page state...`);
    });

    // Poll until Cloudflare clears — up to 30 seconds
    let cleared = false;
    for (let i = 0; i < 15; i++) {
      const title = await page.title().catch(() => '');
      console.log(`[DoorDash] Title (${i+1}): ${title}`);
      if (title && !title.includes('moment') && !title.includes('Cloudflare') && title.length > 3) {
        cleared = true;
        console.log(`[DoorDash] ✅ Cloudflare cleared!`);
        break;
      }
      await page.waitForTimeout(2000);
    }

    if (!cleared) {
      console.log('[DoorDash] Cloudflare not cleared — proxy sticky session may help. Update PROXY_USER with _session-eatme1_lifetime-30');
      await browser.close();
      return [];
    }

    await page.waitForTimeout(1500);

    // Remove modal
    await page.evaluate(() => {
      ['[data-testid="LAYER-MANAGER-MODAL"]', '[class*="ModalLayer"]', 'iframe[title*="Login"]']
        .forEach(sel => document.querySelectorAll(sel).forEach(el => el.remove()));
    });

    // Wait for visible input
    await page.waitForFunction(() =>
      Array.from(document.querySelectorAll('input')).some(i => i.offsetWidth > 0 && i.offsetHeight > 0),
      { timeout: 10000 }
    ).catch(() => {});

    const inputHandle = await page.evaluateHandle(() =>
      Array.from(document.querySelectorAll('input')).find(i => i.offsetWidth > 0 && i.offsetHeight > 0) || null
    );
    const inputEl = inputHandle.asElement();

    if (inputEl) {
      const placeholder = await inputEl.evaluate(el => el.placeholder);
      console.log(`[DoorDash] Found input: "${placeholder}"`);
      await inputEl.click();
      await inputEl.fill('');
      await inputEl.type(address, { delay: 60 });
      await page.waitForTimeout(2500);

      await page.waitForSelector('li[role="option"]', { timeout: 6000 }).catch(() => {});
      const suggestions = await page.evaluate(() =>
        Array.from(document.querySelectorAll('li[role="option"]')).slice(0,3).map(s => s.innerText?.substring(0,50))
      );
      console.log(`[DoorDash] Suggestions: ${JSON.stringify(suggestions)}`);

      const suggestion = await page.$('li[role="option"]:first-child');
      if (suggestion) {
        await suggestion.click({ force: true });
        console.log('[DoorDash] Address clicked');
      } else {
        await page.keyboard.press('ArrowDown');
        await page.waitForTimeout(300);
        await page.keyboard.press('Enter');
      }
      await page.waitForTimeout(3000);
      console.log(`[DoorDash] URL after address: ${page.url()}`);
    } else {
      console.log('[DoorDash] No input found');
    }

    // Search
    await page.goto(`https://www.doordash.com/search/store/${encodeURIComponent(dish)}/`, {
      waitUntil: 'domcontentloaded',
      timeout
    });
    await page.waitForTimeout(4000);
    console.log(`[DoorDash] Search URL: ${page.url()}`);

    await page.waitForSelector('a[href*="/store/"]', { timeout: 10000 }).catch(() => {});

    const rawCards = await page.evaluate(() => {
      const seen = new Set();
      const out = [];
      for (const card of document.querySelectorAll('a[href*="/store/"]')) {
        const href = card.getAttribute('href');
        if (!href || seen.has(href)) continue;
        seen.add(href);
        const lines = (card.innerText || '').split('\n').map(l => l.trim()).filter(l => l.length > 0);
        const name = lines[0];
        if (name && name.length > 2 && !name.startsWith('$')) {
          out.push({ href, name, text: card.innerText, lines });
          if (out.length >= 8) break;
        }
      }
      return out;
    });

    console.log(`[DoorDash] Found ${rawCards.length} stores`);
    if (rawCards[0]) console.log(`[DoorDash] Sample: ${JSON.stringify(rawCards[0].lines.slice(0,4))}`);

    const storeData = rawCards.map(card => {
      const text = card.text;
      let deliveryFee = /free/i.test(text) ? 0 : null;
      if (deliveryFee === null) {
        const m = text.match(/\$(\d+\.?\d*)\s*(?:delivery fee|delivery)/i);
        if (m) deliveryFee = parseFloat(m[1]);
      }
      const ratingM = text.match(/\b([45]\.\d)\b/);
      const etaM = text.match(/(\d+[\s–\-−]+\d+\s*min|\d+\s*min)/i);
      return { name: card.name, href: card.href, deliveryFee, rating: ratingM ? parseFloat(ratingM[1]) : null, eta: etaM?.[1]?.trim() || null };
    });

    // Parallel store visits, 3 concurrent
    const { fetchStoreItems } = require('./grubhub');
    const CONCURRENCY = 3;
    for (let i = 0; i < storeData.length; i += CONCURRENCY) {
      const batch = storeData.slice(i, i + CONCURRENCY);
      const batchResults = await Promise.all(batch.map(store => fetchStoreItems(context, store, dish, 'DoorDash', 'https://www.doordash.com')));
      batchResults.forEach(({ store, items, deliveryFee }) => {
        if (items.length > 0) {
          items.forEach(item => {
            const fee = deliveryFee ?? 0;
            results.push({ platform: 'DoorDash', restaurant: store.name, item: item.name, itemPrice: item.price, deliveryFee: fee, totalPrice: parseFloat((item.price + fee).toFixed(2)), rating: store.rating, eta: store.eta, url: page.url() });
          });
        }
      });
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
