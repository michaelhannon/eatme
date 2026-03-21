function aggregate(allResults, rankBy = 'totalPrice') {
  let results = allResults.flat().filter(Boolean);
  if (results.length === 0) return { ranked: [], summary: null };

  // Compute total price where possible
  results = results.map(r => {
    const total = r.totalPrice != null ? r.totalPrice
      : (r.itemPrice != null && r.deliveryFee != null) ? parseFloat((r.itemPrice + r.deliveryFee).toFixed(2))
      : null;
    return { ...r, totalPrice: total };
  });

  // Deduplicate: same platform + restaurant + item name
  const seen = new Set();
  results = results.filter(r => {
    const key = `${r.platform}|${r.restaurant?.toLowerCase()}|${r.item?.toLowerCase()}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  // Rank
  const ranked = results.sort(getRankFn(rankBy));

  // Mark best value (first result with a total price)
  const bestIdx = ranked.findIndex(r => r.totalPrice != null);
  if (bestIdx >= 0) ranked[bestIdx].isBestValue = true;

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
      ? parseFloat((items.filter(i => i.rating).reduce((a, b) => a + b.rating, 0) / items.filter(i => i.rating).length).toFixed(1))
      : null;
    return { platform, resultCount: items.length, cheapest, avgRating };
  });

  const withTotal = results.filter(r => r.totalPrice != null);
  const withItem = results.filter(r => r.itemPrice != null);
  const withRating = results.filter(r => r.rating != null);
  const withEta = results.filter(r => r.eta != null);

  const bestByTotal = withTotal.sort((a, b) => a.totalPrice - b.totalPrice)[0];
  const bestByItem = withItem.sort((a, b) => a.itemPrice - b.itemPrice)[0];
  const bestByRating = withRating.sort((a, b) => b.rating - a.rating)[0];
  const fastestEta = withEta.sort((a, b) => parseEta(a.eta) - parseEta(b.eta))[0];

  return {
    ranked,
    summary: {
      totalResults: results.length,
      platforms: platformSummary,
      highlights: {
        bestValue: bestByTotal ? { platform: bestByTotal.platform, restaurant: bestByTotal.restaurant, item: bestByTotal.item, totalPrice: bestByTotal.totalPrice } : null,
        lowestItemPrice: bestByItem ? { platform: bestByItem.platform, restaurant: bestByItem.restaurant, item: bestByItem.item, itemPrice: bestByItem.itemPrice } : null,
        bestRated: bestByRating ? { platform: bestByRating.platform, restaurant: bestByRating.restaurant, rating: bestByRating.rating } : null,
        fastestDelivery: fastestEta ? { platform: fastestEta.platform, restaurant: fastestEta.restaurant, eta: fastestEta.eta } : null
      }
    }
  };
}

function getRankFn(rankBy) {
  switch (rankBy) {
    case 'itemPrice': return (a, b) => { if (a.itemPrice == null && b.itemPrice == null) return 0; if (a.itemPrice == null) return 1; if (b.itemPrice == null) return -1; return a.itemPrice - b.itemPrice; };
    case 'rating': return (a, b) => (b.rating || 0) - (a.rating || 0);
    case 'eta': return (a, b) => parseEta(a.eta) - parseEta(b.eta);
    case 'totalPrice':
    default: return (a, b) => {
      if (a.totalPrice == null && b.totalPrice == null) return (a.itemPrice || 999) - (b.itemPrice || 999);
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

module.exports = { aggregate };
