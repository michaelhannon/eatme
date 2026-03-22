/**
 * DoorDash scraper — direct API approach (no browser).
 *
 * Uses DoorDash's internal consumer REST API via the residential proxy.
 * No Playwright, no Cloudflare fight. Hits the same endpoints the mobile
 * app uses, which are far less aggressively rate-limited than the web UI.
 *
 * Flow:
 *   1. GET /v2/store/search/?lat=&lng=&q= → list of stores with metadata
 *   2. For each store: GET /v2/store/{id}/menu/ → menu items
 *
 * Requires: PROXY_HOST / PROXY_PORT / PROXY_USER / PROXY_PASS
 * Requires: lat + lng (geocoded upstream)
 */

const https = require('https');
const http  = require('http');

function getProxyConfig() {
  const host = process.env.PROXY_HOST;
  const port = process.env.PROXY_PORT;
  const user = process.env.PROXY_USER;
  const pass = process.env.PROXY_PASS;
  if (!host || !port) return null;
  return { host, port: parseInt(port), user, pass };
}

// ---------------------------------------------------------------------------
// HTTP helper — tunnels HTTPS through an HTTP CONNECT proxy
// ---------------------------------------------------------------------------
function proxyFetch(url, proxy, extraHeaders = {}) {
  return new Promise((resolve) => {
    const parsed = new URL(url);
    const auth = proxy.user && proxy.pass
      ? 'Basic ' + Buffer.from(`${proxy.user}:${proxy.pass}`).toString('base64')
      : undefined;

    // Open CONNECT tunnel to target host
    const connectReq = http.request({
      host: proxy.host,
      port: proxy.port,
      method: 'CONNECT',
      path: `${parsed.hostname}:443`,
      headers: {
        'Host': `${parsed.hostname}:443`,
        ...(auth ? { 'Proxy-Authorization': auth } : {})
      }
    });

    connectReq.setTimeout(12000, () => { connectReq.destroy(); resolve(null); });
    connectReq.on('error', () => resolve(null));

    connectReq.on('connect', (res, socket) => {
      if (res.statusCode !== 200) { socket.destroy(); resolve(null); return; }

      const tlsSocket = require('tls').connect({
        host: parsed.hostname,
        socket,
        rejectUnauthorized: false,
      });

      const path = parsed.pathname + (parsed.search || '');
      const headers = {
        'Host': parsed.hostname,
        'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148',
        'Accept': 'application/json, text/plain, */*',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept-Encoding': 'gzip, deflate',
        'Connection': 'keep-alive',
        'Referer': 'https://www.doordash.com/',
        'Origin': 'https://www.doordash.com',
        'x-channel-id': 'doordash',
        ...extraHeaders
      };

      const reqStr = `GET ${path} HTTP/1.1\r\n` +
        Object.entries(headers).map(([k,v]) => `${k}: ${v}`).join('\r\n') +
        '\r\n\r\n';

      tlsSocket.write(reqStr);

      let rawData = Buffer.alloc(0);
      tlsSocket.on('data', chunk => { rawData = Buffer.concat([rawData, chunk]); });
      tlsSocket.on('end', () => {
        try {
          const raw = rawData.toString('utf8');
          const bodyStart = raw.indexOf('\r\n\r\n');
          if (bodyStart === -1) { resolve(null); return; }
          const body = raw.slice(bodyStart + 4);
          // Strip chunked encoding markers if present
          const clean = body.replace(/^[0-9a-f]+\r\n/gim, '').replace(/\r\n/g, '');
          resolve(clean);
        } catch (e) { resolve(null); }
      });
      tlsSocket.on('error', () => resolve(null));
      tlsSocket.setTimeout(12000, () => { tlsSocket.destroy(); resolve(null); });
    });

    connectReq.end();
  });
}

// ---------------------------------------------------------------------------
// Fallback: direct fetch without proxy (for testing / proxy-less deploys)
// ---------------------------------------------------------------------------
function directFetch(url) {
  return new Promise((resolve) => {
    const parsed = new URL(url);
    const options = {
      hostname: parsed.hostname,
      path: parsed.pathname + (parsed.search || ''),
      method: 'GET',
      headers: {
        'User-Agent': 'DoordashConsumer/3.0 (iPhone; iOS 17.0)',
        'Accept': 'application/json',
        'Accept-Language': 'en-US',
        'x-channel-id': 'doordash',
      },
      rejectUnauthorized: false,
    };
    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => resolve(body));
    });
    req.on('error', () => resolve(null));
    req.setTimeout(10000, () => { req.destroy(); resolve(null); });
    req.end();
  });
}

async function fetchJson(url, proxy) {
  try {
    let raw = proxy ? await proxyFetch(url, proxy) : await directFetch(url);
    if (!raw) return null;
    // Find first { or [
    const start = Math.min(
      raw.indexOf('{') === -1 ? Infinity : raw.indexOf('{'),
      raw.indexOf('[') === -1 ? Infinity : raw.indexOf('[')
    );
    if (start === Infinity) return null;
    return JSON.parse(raw.slice(start));
  } catch (e) {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Main scraper
// ---------------------------------------------------------------------------
async function scrapeDoorDash({ address, dish, lat, lng, timeout = 45000 }) {
  const proxy = getProxyConfig();

  if (!lat || !lng) {
    console.log('[DoorDash] No coordinates — skipping');
    return [];
  }

  console.log(`[DoorDash] API search "${dish}" at ${lat}, ${lng}${proxy ? ' via proxy' : ' (no proxy)'}`);

  const results = [];

  // -------------------------------------------------------------------------
  // Step 1: Search for stores
  // -------------------------------------------------------------------------
  const searchUrl = `https://www.doordash.com/v2/store/search/?lat=${lat}&lng=${lng}&q=${encodeURIComponent(dish)}&limit=12`;
  console.log(`[DoorDash] Store search: ${searchUrl}`);

  const searchData = await fetchJson(searchUrl, proxy);

  if (!searchData) {
    console.log('[DoorDash] ❌ Store search returned no data — proxy may be blocked');
    return [];
  }

  // Extract stores from various possible response shapes
  const storeList = searchData?.stores ||
                    searchData?.results ||
                    searchData?.data?.stores ||
                    searchData?.data?.results ||
                    (Array.isArray(searchData) ? searchData : []);

  console.log(`[DoorDash] Found ${storeList.length} stores`);
  if (storeList.length === 0) {
    console.log('[DoorDash] Raw response sample:', JSON.stringify(searchData).slice(0, 300));
    return [];
  }

  // -------------------------------------------------------------------------
  // Step 2: Fetch menu for each store (up to 6, with 200ms spacing)
  // -------------------------------------------------------------------------
  const dishWords = dish.toLowerCase().split(' ').filter(w => w.length > 2);
  const expansions = {
    pizza: ['pizza','pie','pepperoni','margherita','calzone'],
    burger: ['burger','cheeseburger','hamburger'],
    pasta: ['pasta','spaghetti','penne','fettuccine','lasagna'],
    chicken: ['chicken','wings','tenders','nuggets'],
    sandwich: ['sandwich','sub','hoagie','wrap'],
    taco: ['taco','burrito','quesadilla'],
    sushi: ['sushi','roll','maki','sashimi'],
    chinese: ['chinese','fried rice','lo mein','chow mein','dumplings','egg roll','wonton','kung pao','general tso','orange chicken','beef broccoli'],
  };
  let searchWords = [...dishWords];
  for (const [key, words] of Object.entries(expansions)) {
    if (dishWords.some(w => key.includes(w) || w.includes(key))) {
      searchWords = [...new Set([...dishWords, ...words])];
      break;
    }
  }

  for (const store of storeList.slice(0, 6)) {
    const storeId   = store.id || store.store_id || store.storeId;
    const storeName = store.name || store.store?.name || 'Unknown';
    const deliveryFee = parseDeliveryFee(store.delivery_fee || store.deliveryFee || store.fees);
    const rating    = parseFloat(store.average_rating || store.averageRating || 0) || null;
    const eta       = store.delivery_time ? `${store.delivery_time} min` :
                      store.deliveryTime  ? `${store.deliveryTime} min`  : null;

    if (!storeId) continue;

    await new Promise(r => setTimeout(r, 200)); // gentle rate limiting

    const menuUrl = `https://www.doordash.com/v2/store/${storeId}/menu/?query=${encodeURIComponent(dish)}`;
    const menuData = await fetchJson(menuUrl, proxy);

    if (!menuData) {
      console.log(`[DoorDash] ${storeName}: no menu data`);
      continue;
    }

    // Walk menu response and collect matching items
    const items = [];
    const walkMenu = (obj, depth = 0) => {
      if (!obj || typeof obj !== 'object' || depth > 8 || items.length >= 4) return;
      if (obj.name && (obj.price !== undefined || obj.display_price !== undefined)) {
        const name = String(obj.name).trim();
        const price = parsePrice(obj.price ?? obj.display_price ?? obj.unit_price);
        if (name && price && price > 1 && price < 150 && name.length < 100) {
          if (searchWords.some(w => name.toLowerCase().includes(w))) {
            items.push({ name: name.substring(0, 70), price });
          }
        }
      }
      for (const v of Object.values(obj)) {
        if (Array.isArray(v)) v.forEach(i => walkMenu(i, depth + 1));
        else if (v && typeof v === 'object') walkMenu(v, depth + 1);
      }
    };
    walkMenu(menuData);

    // Deduplicate
    const seen = new Set();
    const unique = items.filter(i => { const k = `${i.name}|${i.price}`; if (seen.has(k)) return false; seen.add(k); return true; });

    console.log(`[DoorDash] ${storeName}: ${unique.length} items, fee $${deliveryFee ?? 0}`);

    if (unique.length > 0) {
      const fee = deliveryFee ?? 0;
      unique.forEach(item => {
        results.push({
          platform: 'DoorDash',
          restaurant: storeName,
          item: item.name,
          itemPrice: item.price,
          deliveryFee: fee,
          totalPrice: parseFloat((item.price + fee).toFixed(2)),
          rating: rating && rating > 0 ? rating : null,
          eta,
          url: `https://www.doordash.com/store/${storeId}/`
        });
      });
    }
  }

  console.log(`[DoorDash] ✅ Done: ${results.length} results`);
  return results;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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
    if (v != null) return parseDeliveryFee(v);
  }
  return null;
}

function parsePrice(raw) {
  if (raw == null) return null;
  if (typeof raw === 'number') return raw > 200 ? raw / 100 : raw;
  if (typeof raw === 'string') {
    const m = raw.replace(/[,$]/g, '').match(/(\d+\.?\d*)/);
    return m ? parseFloat(m[1]) : null;
  }
  return null;
}

module.exports = { scrapeDoorDash };
