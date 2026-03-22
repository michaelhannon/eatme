const { chromium } = require('playwright');

async function scrapeGrubHub({ address, dish, credentials, headless = true, timeout = 45000, platform = 'GrubHub', lat, lng }) {
  if (platform === 'Seamless') {
    console.log(`[Seamless] Skipping — same backend as GrubHub`);
    return [];
  }

  const browser = await chromium.launch({
    headless,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-blink-features=AutomationControlled']
  });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 800 },
    extraHTTPHeaders: { 'Accept-Language': 'en-US,en;q=0.9' }
  });
  await context.addInitScript(() => { Object.defineProperty(navigator, 'webdriver', { get: () => undefined }); });

  const page = await context.newPage();
  const results = [];

  try {
    // Go directly to search URL with known Oceanport NJ coordinates
    const useLat = lat || 40.32098388;
    const useLng = lng || -74.02689362;
    console.log(`[GrubHub] Using coordinates: ${useLat}, ${useLng}`);
    const searchUrl = `https://www.grubhub.com/search?orderMethod=delivery&locationMode=DELIVERY&facetSet=umamiV6&pageSize=20&hideHateos=true&searchMetrics=true&queryText=${encodeURIComponent(dish)}&latitude=${useLat}&longitude=${useLng}&preciseLocation=true&sortSetId=umamiV3&countOmittingTimes=true`;
    await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout });
    await page.waitForTimeout(4000);
    console.log(`[GrubHub] Search URL: ${page.url()}`);

    await page.waitForSelector('a[href*="/restaurant/"]', { timeout: 8000 }).catch(() => {});
    const linkCount = await page.evaluate(() => document.querySelectorAll('a[href*="/restaurant/"]').length);
    console.log(`[GrubHub] Link count: ${linkCount}`);

    const rawCards = await page.evaluate(() => {
      const seen = new Set();
      const out = [];
      for (const link of document.querySelectorAll('a[href*="/restaurant/"]')) {
        const href = link.getAttribute('href');
        if (!href || seen.has(href)) continue;
        seen.add(href);
        let container = link;
        for (let i = 0; i < 8; i++) {
          if (!container.parentElement) break;
          container = container.parentElement;
          if ((container.innerText || '').split('\n').filter(l => l.trim()).length >= 3) break;
        }
        const text = container.innerText || link.innerText || '';
        const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
        if (lines[0] && lines[0].length > 2) {
          out.push({ href, name: lines[0], text, lines });
          if (out.length >= 8) break;
        }
      }
      return out;
    });

    console.log(`[GrubHub] Found ${rawCards.length} restaurants`);
    if (rawCards[0]) console.log(`[GrubHub] Sample: ${JSON.stringify(rawCards[0].lines.slice(0,5))}`);

    const storeData = rawCards.map(card => {
      const text = card.text;
      let deliveryFee = null;
      if (/free delivery|\$0\.00/i.test(text)) deliveryFee = 0;
      else { const m = text.match(/\$(\d+\.?\d*)\s*delivery/i); if (m) deliveryFee = parseFloat(m[1]); }
      const ratingM = text.match(/\b([45]\.\d)\s*[\(\d]/);
      const etaM = text.match(/•\s*(\d+[\s–\-]+\d+\s*min|\d+\s*min)/i) || text.match(/(\d+[\s–\-]+\d+\s*min|\d+\s*min)/i);
      return { name: card.name, href: card.href, deliveryFee, rating: ratingM ? parseFloat(ratingM[1]) : null, eta: etaM?.[1]?.trim() || null };
    });

    // 3 parallel store visits per batch
    const CONCURRENCY = 3;
    for (let i = 0; i < storeData.length; i += CONCURRENCY) {
      const batch = storeData.slice(i, i + CONCURRENCY);
      const batchResults = await Promise.all(batch.map(store => fetchStoreItems(context, store, dish, 'GrubHub', 'https://www.grubhub.com')));
      batchResults.forEach(({ store, items, deliveryFee }) => {
        if (items.length > 0) {
          items.forEach(item => {
            const fee = deliveryFee ?? 0;
            results.push({ platform: 'GrubHub', restaurant: store.name, item: item.name, itemPrice: item.price, deliveryFee: fee, totalPrice: parseFloat((item.price + fee).toFixed(2)), rating: store.rating, eta: store.eta, url: page.url() });
          });
        }
      });
    }

  } catch(e) {
    console.error(`[GrubHub] Error:`, e.message.split('\n')[0]);
  } finally {
    await browser.close();
  }
  console.log(`[GrubHub] Done: ${results.length} results`);
  return results;
}

async function fetchStoreItems(context, store, dish, platform, baseUrl) {
  if (!store.href) return { store, items: [], deliveryFee: store.deliveryFee };
  try {
    const storeUrl = store.href.startsWith('http') ? store.href : `${baseUrl}${store.href}`;
    const storePage = await context.newPage();
    await storePage.goto(storeUrl, { waitUntil: 'domcontentloaded', timeout: 10000 });
    await storePage.waitForTimeout(2000);

    const data = await storePage.evaluate((searchDish) => {
      const dishWords = searchDish.toLowerCase().split(' ').filter(w => w.length > 2);
      const expansions = {
        pizza: ['pizza','pie','pepperoni','margherita','sicilian','calzone','stromboli'],
        burger: ['burger','cheeseburger','hamburger'],
        pasta: ['pasta','spaghetti','penne','rigatoni','fettuccine','lasagna'],
        chicken: ['chicken','wings','tenders','nuggets'],
        sandwich: ['sandwich','sub','hoagie','hero','wrap'],
        soup: ['soup','broth','bisque','chowder'],
        sushi: ['sushi','roll','maki','sashimi'],
        taco: ['taco','burrito','quesadilla','enchilada'],
      };
      let searchWords = [...dishWords];
      for (const [key, words] of Object.entries(expansions)) {
        if (dishWords.some(w => key.includes(w) || w.includes(key) || words.includes(w))) {
          searchWords = [...new Set([...dishWords, ...words])];
          break;
        }
      }

      const lines = document.body.innerText.split('\n').map(l => l.trim()).filter(l => l);
      let deliveryFee = null;
      for (const line of lines) {
        if (/free delivery/i.test(line)) { deliveryFee = 0; break; }
        if (/delivery fee/i.test(line)) { const m = line.match(/\$(\d+\.?\d*)/); if (m) { deliveryFee = parseFloat(m[1]); break; } }
      }
      const items = [];
      for (let i = 0; i < lines.length - 1; i++) {
        if (!searchWords.some(w => lines[i].toLowerCase().includes(w))) continue;
        if (lines[i].length > 100) continue;
        for (let j = i + 1; j <= Math.min(i + 3, lines.length - 1); j++) {
          const m = lines[j].match(/^\$(\d+\.\d{2})$/) || lines[j].match(/^\$(\d+)$/);
          if (m) { const p = parseFloat(m[1]); if (p > 1 && p < 150) { items.push({ name: lines[i].substring(0, 70), price: p }); break; } }
        }
        if (items.length >= 4) break;
      }
      const seen = new Set();
      return { deliveryFee, items: items.filter(r => { const k=`${r.name}|${r.price}`; if(seen.has(k))return false; seen.add(k); return true; }) };
    }, dish);

    await storePage.close();
    const deliveryFee = data.deliveryFee ?? store.deliveryFee;
    console.log(`[${platform}] ${store.name}: ${data.items.length} items, fee: $${deliveryFee}`);
    return { store, items: data.items, deliveryFee };
  } catch(e) {
    console.log(`[${platform}] Store failed ${store.name}: ${e.message.split('\n')[0]}`);
    return { store, items: [], deliveryFee: store.deliveryFee };
  }
}

async function scrapeSeamless(params) {
  console.log(`[Seamless] Skipping — same backend as GrubHub`);
  return [];
}

module.exports = { scrapeGrubHub, scrapeSeamless, fetchStoreItems };
