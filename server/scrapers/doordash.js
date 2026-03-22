/**
 * DoorDash scraper — direct API via https-proxy-agent.
 * No browser, no Playwright, no Cloudflare fight.
 */

const https = require('https');
const { HttpsProxyAgent } = require('https-proxy-agent');

function getProxyAgent() {
  const host = process.env.PROXY_HOST;
  const port = process.env.PROXY_PORT;
  const user = process.env.PROXY_USER;
  const pass = process.env.PROXY_PASS;
  if (!host || !port) return null;
  const auth = user && pass ? `${user}:${pass}@` : '';
  const url  = `http://${auth}${host}:${port}`;
  console.log(`[DoorDash] Using proxy: ${host}:${port}`);
  return new HttpsProxyAgent(url);
}

function fetchJson(url, agent) {
  return new Promise((resolve) => {
    const options = {
      headers: {
        'User-Agent':        'DoordashConsumer/3.0 CFNetwork/1474 Darwin/23.0.0',
        'Accept':            'application/json, text/plain, */*',
        'Accept-Language':   'en-US,en;q=0.9',
        'x-channel-id':      'doordash',
        'x-experience-id':   'doordash',
        'Referer':           'https://www.doordash.com/',
      },
      timeout: 12000,
      ...(agent ? { agent } : {})
    };

    const req = https.get(url, options, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        try {
          const body = Buffer.concat(chunks).toString('utf8');
          console.log(`[DoorDash] ${url.slice(0,80)} → HTTP ${res.statusCode}, ${body.length} bytes`);
          if (res.statusCode !== 200) { resolve(null); return; }
          resolve(JSON.parse(body));
        } catch (e) { resolve(null); }
      });
    });
    req.on('error', (e) => { console.log(`[DoorDash] fetch error: ${e.message}`); resolve(null); });
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

async function scrapeDoorDash({ address, dish, lat, lng }) {
  const agent = getProxyAgent();

  if (!lat || !lng) {
    console.log('[DoorDash] No coordinates — skipping');
    return [];
  }

  console.log(`[DoorDash] Searching "${dish}" at ${lat}, ${lng}`);

  // -------------------------------------------------------------------------
  // Step 1: Store search
  // -------------------------------------------------------------------------
  const searchUrl = `https://www.doordash.com/v2/store/search/?lat=${lat}&lng=${lng}&q=${encodeURIComponent(dish)}&limit=10`;
  const searchData = await fetchJson(searchUrl, agent);

  if (!searchData) {
    console.log('[DoorDash] ❌ No response from store search API');
    return [];
  }

  const storeList =
    searchData?.stores ||
    searchData?.results ||
    searchData?.data?.stores ||
    searchData?.data?.results ||
    (Array.isArray(searchData) ? searchData : []);

  console.log(`[DoorDash] Found ${storeList.length} stores`);

  if (storeList.length === 0) {
    console.log('[DoorDash] Response sample:', JSON.stringify(searchData).slice(0, 400));
    return [];
  }

  // -------------------------------------------------------------------------
  // Step 2: Fetch menu for each store
  // -------------------------------------------------------------------------
  const dishWords   = dish.toLowerCase().split(' ').filter(w => w.length > 2);
  const expansions  = {
    pizza:   ['pizza','pie','pepperoni','margherita','calzone'],
    burger:  ['burger','cheeseburger','hamburger'],
    pasta:   ['pasta','spaghetti','penne','fettuccine','lasagna'],
    chicken: ['chicken','wings','tenders','nuggets'],
    sandwich:['sandwich','sub','hoagie','wrap'],
    taco:    ['taco','burrito','quesadilla'],
    sushi:   ['sushi','roll','maki','sashimi'],
    chinese: ['chinese','fried rice','lo mein','chow mein','dumpling','egg roll','wonton','kung pao','general tso','orange chicken'],
  };
  let searchWords = [...dishWords];
  for (const [key, words] of Object.entries(expansions)) {
    if (dishWords.some(w => key.includes(w) || w.includes(key))) {
      searchWords = [...new Set([...dishWords, ...words])];
      break;
    }
  }

  const results = [];

  for (const store of storeList.slice(0, 6)) {
    const storeId   = store.id ?? store.store_id ?? store.storeId;
    const storeName = store.name ?? store.store?.name ?? 'Unknown';
    const fee       = parseDeliveryFee(store.delivery_fee ?? store.deliveryFee ?? store.fees);
    const rating    = parseFloat(store.average_rating ?? store.averageRating ?? 0) || null;
    const eta       = store.delivery_time ? `${store.delivery_time} min` :
                      store.deliveryTime  ? `${store.deliveryTime} min`  : null;

    if (!storeId) { console.log(`[DoorDash] Skipping store with no ID: ${storeName}`); continue; }

    await new Promise(r => setTimeout(r, 300));

    const menuUrl  = `https://www.doordash.com/v2/store/${storeId}/menu/?query=${encodeURIComponent(dish)}`;
    const menuData = await fetchJson(menuUrl, agent);

    if (!menuData) { console.log(`[DoorDash] ${storeName}: no menu data`); continue; }

    const items = [];
    const walk  = (obj, depth = 0) => {
      if (!obj || typeof obj !== 'object' || depth > 8 || items.length >= 4) return;
      if (obj.name != null && (obj.price != null || obj.display_price != null)) {
        const name  = String(obj.name).trim();
        const price = parsePrice(obj.price ?? obj.display_price ?? obj.unit_price);
        if (name && price && price > 1 && price < 150 && name.length < 100) {
          if (searchWords.some(w => name.toLowerCase().includes(w))) {
            items.push({ name: name.slice(0, 70), price });
          }
        }
      }
      for (const v of Object.values(obj)) {
        if (Array.isArray(v))              v.forEach(i  => walk(i,   depth + 1));
        else if (v && typeof v === 'object') walk(v, depth + 1);
      }
    };
    walk(menuData);

    const seen   = new Set();
    const unique = items.filter(i => { const k = `${i.name}|${i.price}`; if (seen.has(k)) return false; seen.add(k); return true; });
    console.log(`[DoorDash] ${storeName}: ${unique.length} items, fee $${fee ?? 0}`);

    if (unique.length > 0) {
      unique.forEach(item => results.push({
        platform:    'DoorDash',
        restaurant:  storeName,
        item:        item.name,
        itemPrice:   item.price,
        deliveryFee: fee ?? 0,
        totalPrice:  parseFloat((item.price + (fee ?? 0)).toFixed(2)),
        rating:      rating && rating > 0 ? rating : null,
        eta,
        url:         `https://www.doordash.com/store/${storeId}/`
      }));
    }
  }

  console.log(`[DoorDash] ✅ Done: ${results.length} results`);
  return results;
}

function parseDeliveryFee(raw) {
  if (raw == null) return null;
  if (typeof raw === 'number') return raw > 100 ? raw / 100 : raw;
  if (typeof raw === 'string') {
    if (/free/i.test(raw)) return 0;
    const m = raw.match(/(\d+\.?\d*)/);
    return m ? parseFloat(m[1]) : null;
  }
  if (typeof raw === 'object') {
    const v = raw.unit_amount ?? raw.unitAmount ?? raw.value ?? raw.amount;
    return v != null ? parseDeliveryFee(v) : null;
  }
  return null;
}

function parsePrice(raw) {
  if (raw == null) return null;
  if (typeof raw === 'number') return raw > 200 ? raw / 100 : raw;
  if (typeof raw === 'string') {
    const m = raw.replace(/[$,]/g, '').match(/(\d+\.?\d*)/);
    return m ? parseFloat(m[1]) : null;
  }
  return null;
}

module.exports = { scrapeDoorDash };
