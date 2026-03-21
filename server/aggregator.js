/**
 * Aggregator: takes raw results from all scrapers,
 * normalizes, deduplicates, scores, and ranks them.
 */

function aggregate(allResults, rankBy = 'totalPrice') {
  // Flatten all results
  let results = allResults.flat().filter(Boolean);

  if (results.length === 0) return { ranked: [], summary: null };

  // Normalize and compute total price where missing
  results = results.map(r => {
    const itemPrice = r.itemPrice != null ? r.itemPrice : null;
    const deliveryFee = r.deliveryFee != null ? r.deliveryFee : null;
    const totalPrice = r.totalPrice != null
      ? r.totalPrice
      : (itemPrice != null && deliveryFee != null)
        ? parseFloat((itemPrice + deliveryFee).toFixed(2))
        : null;

    return { ...r, totalPrice };
  });

  // Deduplicate: same restaurant + same item across platforms is kept (it's the comparison point)
  // But exact same restaurant+item+platform duplicates are removed
  const seen = new Set();
  results = results.filter(r => {
    const key = `${r.platform}|${r.restaurant?.toLowerCase()}|${r.item?.toLowerCase()}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  // Score each result
  results = results.map(r => ({
    ...r,
    score: computeScore(r)
  }));

  // Rank
  const rankFn = getRankFn(rankBy);
  const ranked = results.sort(rankFn);

  // Flag the winner
  if (ranked.length > 0) {
    ranked[0].isBestValue = true;
  }

  // Platform summary
  const byPlatform = {};
  results.forEach(r => {
    if (!byPlatform[r.platform]) byPlatform[r.platform] = [];
    byPlatform[r.platform].push(r);
  });

  const platformSummary = Object.entries(byPlatform).map(([platform, items]) => {
    const withTotal = items.filter(i => i.totalPrice != null);
    const cheapest = withTotal.length ? Math.min(...withTotal.map(i => i.totalPrice)) : null;
    const avgRating = items.filter(i => i.rating).length
      ? (items.filter(i => i.rating).reduce((a, b) => a + b.rating, 0) / items.filter(i => i.rating).length).toFixed(1)
      : null;
    return { platform, resultCount: items.length, cheapest, avgRating };
  });

  // Best overall
  const bestByTotal = ranked.find(r => r.totalPrice != null);
  const bestByRating = [...results].sort((a, b) => (b.rating || 0) - (a.rating || 0)).find(r => r.rating != null);
  const bestByPrice = [...results].sort((a, b) => (a.itemPrice || 999) - (b.itemPrice || 999)).find(r => r.itemPrice != null);
  const fastestEta = [...results].sort((a, b) => parseEta(a.eta) - parseEta(b.eta)).find(r => r.eta != null);

  return {
    ranked,
    summary: {
      totalResults: results.length,
      platforms: platformSummary,
      highlights: {
        bestValue: bestByTotal ? {
          platform: bestByTotal.platform,
          restaurant: bestByTotal.restaurant,
          item: bestByTotal.item,
          totalPrice: bestByTotal.totalPrice
        } : null,
        bestRated: bestByRating ? {
          platform: bestByRating.platform,
          restaurant: bestByRating.restaurant,
          rating: bestByRating.rating
        } : null,
        lowestItemPrice: bestByPrice ? {
          platform: bestByPrice.platform,
          restaurant: bestByPrice.restaurant,
          item: bestByPrice.item,
          itemPrice: bestByPrice.itemPrice
        } : null,
        fastestDelivery: fastestEta ? {
          platform: fastestEta.platform,
          restaurant: fastestEta.restaurant,
          eta: fastestEta.eta
        } : null
      }
    }
  };
}

function computeScore(r) {
  // Lower is better for price-based scoring
  let score = 0;
  if (r.totalPrice != null) score += r.totalPrice * 10;
  else if (r.itemPrice != null) score += r.itemPrice * 10 + 50; // penalty for unknown delivery fee
  else score += 999;
  // Subtract bonus for high rating
  if (r.rating) score -= r.rating * 2;
  return score;
}

function getRankFn(rankBy) {
  switch (rankBy) {
    case 'itemPrice':
      return (a, b) => {
        if (a.itemPrice == null && b.itemPrice == null) return 0;
        if (a.itemPrice == null) return 1;
        if (b.itemPrice == null) return -1;
        return a.itemPrice - b.itemPrice;
      };
    case 'rating':
      return (a, b) => (b.rating || 0) - (a.rating || 0);
    case 'eta':
      return (a, b) => parseEta(a.eta) - parseEta(b.eta);
    case 'totalPrice':
    default:
      return (a, b) => {
        if (a.totalPrice == null && b.totalPrice == null) return (a.itemPrice || 999) - (b.itemPrice || 999);
        if (a.totalPrice == null) return 1;
        if (b.totalPrice == null) return -1;
        return a.totalPrice - b.totalPrice;
      };
  }
}

function parseEta(eta) {
  if (!eta) return 999;
  const match = eta.match(/(\d+)/);
  return match ? parseInt(match[1]) : 999;
}

module.exports = { aggregate };
