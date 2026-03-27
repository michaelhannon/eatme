function aggregate(allResults, rankBy = 'totalPrice') {
  let results = allResults.flat().filter(Boolean);
  if (results.length === 0) return { ranked: [], summary: null };

  // Remove restaurants where no item price was found — they add noise with no value
  const withItems = results.filter(r => r.itemPrice != null);
  // If we got at least some results with items, discard the no-item rows
  if (withItems.length > 0) {
    results = withItems;
    console.log(`[Aggregator] Filtered to ${results.length} results with item prices`);
  }

  // Filter out obvious non-restaurants (retail stores, pharmacies, convenience stores)
  // Use exact/start-of-name matching to avoid blocking "Sushi from Kroger" or "Asian Foods Market"
  const NON_RESTAURANT_EXACT = [
    /^five below\b/i, /^dollar tree\b/i, /^dollar general\b/i,
    /^walgreens\b/i, /^cvs\b/i, /^rite aid\b/i,
    /^walmart\b/i, /^target\b/i, /^costco\b/i,
    /^7-eleven\b/i, /^circle k\b/i, /^wawa\b/i, /^sheetz\b/i,
    /^petco\b/i, /^petsmart\b/i,
    /^office depot\b/i, /^staples\b/i, /^best buy\b/i,
    /^home depot\b/i, /^lowe's?\b/i, /^autozone\b/i,
    /^michaels?\b/i, /^hobby lobby\b/i, /^jo-?ann\b/i,
    /^bed bath\b/i, /^ulta\b/i, /^sephora\b/i,
    /^gap\b/i, /^old navy\b/i, /^forever 21\b/i,
    /^food giant\b/i, /^food lion\b/i,
    /^total wine\b/i, /^bevmo\b/i,
  ];
  const beforeFilter = results.length;
  results = results.filter(r => !NON_RESTAURANT_EXACT.some(re => re.test(r.restaurant)));
  if (results.length < beforeFilter) {
    console.log(`[Aggregator] Filtered out ${beforeFilter - results.length} non-restaurant results`);
  }

  // Filter restaurants where neither the restaurant name nor the best item
  // name has meaningful relevance to the original dish query
  // This catches "Bagel Bar" showing up for sushi, "Spoons Cafe" for sushi etc.
  // Only apply when we have enough results to be selective (5+)
  if (results.length >= 5) {
    const query = results[0]?.item ? null : null; // query not available here, skip name check
    // Instead: filter out results where itemPrice seems implausibly low for the dish
    // (already handled) — leave this as a future improvement
  }

  // Compute total price
  results = results.map(r => {
    const total = r.totalPrice != null ? r.totalPrice
      : (r.itemPrice != null && r.deliveryFee != null)
        ? parseFloat((r.itemPrice + r.deliveryFee).toFixed(2))
        : null;
    return { ...r, totalPrice: total };
  });

  // Deduplicate: same restaurant + item + price across platforms = one row
  // GrubHub and Seamless share the same backend so deduplicate them
  const seen = new Set();
  results = results.filter(r => {
    // Normalize platform: treat Seamless as GrubHub for dedup purposes
    const platformNorm = r.platform === 'Seamless' ? 'GrubHub' : r.platform;
    const key = `${platformNorm}|${r.restaurant?.toLowerCase().trim()}|${r.item?.toLowerCase().trim()}|${r.itemPrice}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  // Sort
  const ranked = [...results].sort(getRankFn(rankBy));

  // Mark best value
  const bestIdx = ranked.findIndex(r => r.totalPrice != null);
  if (bestIdx >= 0) ranked[bestIdx].isBestValue = true;
  else if (ranked.length > 0) ranked[0].isBestValue = true;

  // Build summary
  const byPlatform = {};
  results.forEach(r => {
    if (!byPlatform[r.platform]) byPlatform[r.platform] = [];
    byPlatform[r.platform].push(r);
  });

  const platformSummary = Object.entries(byPlatform).map(([platform, items]) => {
    const withTotal = items.filter(i => i.totalPrice != null);
    const cheapest = withTotal.length ? Math.min(...withTotal.map(i => i.totalPrice)) : null;
    const ratings = items.filter(i => i.rating != null);
    const avgRating = ratings.length ? parseFloat((ratings.reduce((a,b) => a + b.rating, 0) / ratings.length).toFixed(1)) : null;
    return { platform, resultCount: items.length, cheapest, avgRating };
  });

  const withTotal = results.filter(r => r.totalPrice != null).sort((a,b) => a.totalPrice - b.totalPrice);
  const withItem  = results.filter(r => r.itemPrice != null).sort((a,b) => a.itemPrice - b.itemPrice);
  const withRating = results.filter(r => r.rating != null).sort((a,b) => b.rating - a.rating);
  const withEta   = results.filter(r => r.eta != null).sort((a,b) => parseEta(a.eta) - parseEta(b.eta));

  // Find same restaurant across multiple platforms
  const restaurantMatches = findRestaurantMatches(results);
  if (restaurantMatches.length > 0) {
    console.log(`[Aggregator] Found ${restaurantMatches.length} cross-platform restaurant match(es)`);
  }

  return {
    ranked,
    restaurantMatches,
    summary: {
      totalResults: results.length,
      platforms: platformSummary,
      highlights: {
        bestValue:       withTotal[0]  ? { platform: withTotal[0].platform,  restaurant: withTotal[0].restaurant,  item: withTotal[0].item,  totalPrice: withTotal[0].totalPrice } : null,
        lowestItemPrice: withItem[0]   ? { platform: withItem[0].platform,   restaurant: withItem[0].restaurant,   item: withItem[0].item,   itemPrice:  withItem[0].itemPrice }  : null,
        bestRated:       withRating[0] ? { platform: withRating[0].platform, restaurant: withRating[0].restaurant, rating: withRating[0].rating } : null,
        fastestDelivery: withEta[0]    ? { platform: withEta[0].platform,    restaurant: withEta[0].restaurant,    eta: withEta[0].eta }        : null
      }
    }
  };
}

/**
 * Normalize a restaurant name for fuzzy matching across platforms.
 * Strips punctuation, common suffixes, and extra whitespace.
 */
function normalizeRestaurantName(name) {
  if (!name) return '';
  return name
    .toLowerCase()
    // Remove possessives
    .replace(/'s\b/g, 's')
    // Strip punctuation except spaces
    .replace(/[^a-z0-9\s]/g, '')
    // Remove common chain suffixes that vary across platforms
    .replace(/\b(restaurant|grill|kitchen|house|bar|cafe|eatery|express|inc|llc|co)\b/g, '')
    // Collapse whitespace
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Find restaurants that appear on multiple platforms for the same search.
 * Returns an array of match objects, each with per-platform data side by side.
 *
 * A "match" requires:
 *  - Normalized name similarity (exact after normalization, OR one name contains the other)
 *  - At least 2 different platforms
 */
function findRestaurantMatches(results) {
  if (!results || results.length === 0) return [];

  // Group all results by normalized restaurant name
  const groups = new Map();
  for (const r of results) {
    const key = normalizeRestaurantName(r.restaurant);
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }

  // Also do a second-pass fuzzy merge: if one normalized name contains another
  // (e.g. "mcdonalds" vs "mcdonalds burger"), merge them
  const keys = [...groups.keys()];
  const merged = new Set();
  for (let i = 0; i < keys.length; i++) {
    if (merged.has(keys[i])) continue;
    for (let j = i + 1; j < keys.length; j++) {
      if (merged.has(keys[j])) continue;
      const a = keys[i], b = keys[j];
      // Only merge if one wholly contains the other and they're close in length
      if ((a.includes(b) || b.includes(a)) && Math.abs(a.length - b.length) <= 8) {
        // Merge shorter into longer
        const [keep, drop] = a.length >= b.length ? [a, b] : [b, a];
        const existing = groups.get(keep) || [];
        groups.set(keep, [...existing, ...groups.get(drop)]);
        groups.delete(drop);
        merged.add(drop);
      }
    }
  }

  const matches = [];

  for (const [normName, items] of groups.entries()) {
    // Find unique platforms in this group
    const platformSet = new Set(items.map(r => r.platform));
    if (platformSet.size < 2) continue; // Only care about cross-platform matches

    // For each platform, pick the best (cheapest total) item
    const platforms = {};
    for (const platform of platformSet) {
      const platformItems = items.filter(r => r.platform === platform);
      // Sort by totalPrice asc, then itemPrice asc
      platformItems.sort((a, b) => {
        const ta = a.totalPrice ?? (a.itemPrice ?? 999) + (a.deliveryFee ?? 0);
        const tb = b.totalPrice ?? (b.itemPrice ?? 999) + (b.deliveryFee ?? 0);
        return ta - tb;
      });
      const best = platformItems[0];
      platforms[platform] = {
        item:        best.item,
        itemPrice:   best.itemPrice,
        deliveryFee: best.deliveryFee ?? 0,
        totalPrice:  best.totalPrice,
        rating:      best.rating,
        eta:         best.eta,
        distance:    best.distance,
        url:         best.url,
      };
    }

    // Find which platform has the best (lowest) totalPrice
    let bestPlatform = null;
    let bestTotal = Infinity;
    for (const [platform, data] of Object.entries(platforms)) {
      const t = data.totalPrice ?? (data.itemPrice ?? 999);
      if (t < bestTotal) { bestTotal = t; bestPlatform = platform; }
    }
    if (bestPlatform) platforms[bestPlatform].isBestDeal = true;

    // Use the most "display-friendly" version of the restaurant name
    // (prefer the longest original name, which tends to be more complete)
    const displayName = items
      .map(r => r.restaurant)
      .sort((a, b) => b.length - a.length)[0];

    matches.push({
      normalizedName: normName,
      displayName,
      platformCount: platformSet.size,
      platforms,
    });
  }

  // Sort: most platforms first, then by best available total price
  matches.sort((a, b) => {
    if (b.platformCount !== a.platformCount) return b.platformCount - a.platformCount;
    const aMin = Math.min(...Object.values(a.platforms).map(p => p.totalPrice ?? 999));
    const bMin = Math.min(...Object.values(b.platforms).map(p => p.totalPrice ?? 999));
    return aMin - bMin;
  });

  return matches;
}

function getRankFn(rankBy) {
  switch (rankBy) {
    case 'itemPrice':   return (a,b) => (a.itemPrice ?? 999) - (b.itemPrice ?? 999);
    case 'rating':      return (a,b) => (b.rating ?? 0) - (a.rating ?? 0);
    case 'eta':         return (a,b) => parseEta(a.eta) - parseEta(b.eta);
    case 'totalPrice':
    default: return (a,b) => {
      if (a.totalPrice == null && b.totalPrice == null) return (a.itemPrice ?? 999) - (b.itemPrice ?? 999);
      if (a.totalPrice == null) return 1;
      if (b.totalPrice == null) return -1;
      return a.totalPrice - b.totalPrice;
    };
  }
}

function parseEta(eta) {
  if (!eta) return 999;
  const m = eta.match(/(\d+)/);
  return m ? parseInt(m[1]) : 999;
}

module.exports = { aggregate, findRestaurantMatches, normalizeRestaurantName };
