/**
 * Redis cache layer using ioredis.
 *
 * Behaviour when Redis is unavailable:
 *   - All operations are silent no-ops → the app degrades to live-scrape only.
 *   - Errors are logged but never thrown, so the search endpoint always responds.
 *
 * Railway: add the Redis plugin to your service.
 * It automatically injects REDIS_URL into the environment.
 */

const Redis = require('ioredis');

const CACHE_TTL_SECONDS = 30 * 60; // 30 minutes

let _client = null;

function getClient() {
  if (_client) return _client;

  const url = process.env.REDIS_URL;
  if (!url) {
    console.warn('[Cache] REDIS_URL not set — caching disabled, all requests will scrape live');
    return null;
  }

  _client = new Redis(url, {
    // Fail commands immediately when offline instead of queuing indefinitely.
    // This keeps the search endpoint fast even if Redis goes down mid-deploy.
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
    connectTimeout: 4000,
    lazyConnect: false,
  });

  _client.on('connect', () => console.log('[Cache] ✅ Redis connected'));
  _client.on('ready',   () => console.log('[Cache] ✅ Redis ready'));
  _client.on('error',   (err) => console.error('[Cache] ⚠️  Redis error:', err.message));
  _client.on('close',   () => console.warn('[Cache] Redis connection closed'));

  return _client;
}

/**
 * Build a deterministic cache key.
 * @param {string} platform  e.g. 'doordash'
 * @param {string} geohash   6-char geohash of the delivery address
 * @param {string} dish      normalised dish query
 * @returns {string}
 */
function buildKey(platform, geohash, dish) {
  const normDish = dish.toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, '');
  return `search:${platform}:${geohash}:${normDish}`;
}

/**
 * Read a cached platform result.
 * @returns {object|null}  Parsed cache entry or null on miss/error.
 */
async function get(key) {
  const r = getClient();
  if (!r) return null;
  try {
    const raw = await r.get(key);
    if (!raw) return null;
    const entry = JSON.parse(raw);
    console.log(`[Cache] HIT  ${key}  (${entry.results?.length ?? 0} results, cached ${_age(entry.cachedAt)})`);
    return entry;
  } catch (err) {
    console.error('[Cache] get error:', err.message);
    return null;
  }
}

/**
 * Store a platform result.
 * @param {string} key
 * @param {Array}  results    Raw scraper output array for one platform.
 * @param {number} [ttl]      TTL in seconds (default 30 min).
 */
async function set(key, results, ttl = CACHE_TTL_SECONDS) {
  const r = getClient();
  if (!r) return;
  try {
    const entry = { results, cachedAt: Date.now() };
    await r.set(key, JSON.stringify(entry), 'EX', ttl);
    console.log(`[Cache] SET  ${key}  (${results.length} results, TTL ${ttl}s)`);
  } catch (err) {
    console.error('[Cache] set error:', err.message);
  }
}

/**
 * Returns a human-readable age string for log output.
 */
function _age(ts) {
  if (!ts) return 'unknown age';
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return `${s}s ago`;
  return `${Math.round(s / 60)}m ago`;
}

// Initialise the client eagerly so the connection is warm before the first request.
getClient();

module.exports = { buildKey, get, set, CACHE_TTL_SECONDS };
