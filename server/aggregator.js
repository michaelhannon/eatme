function aggregate(allResults, rankBy = 'totalPrice') {
  let results = allResults.flat().filter(Boolean);
  if (results.length === 0) return { ranked: [], summary: null };

  // Compute total price
  results = results.map(r => {
    const total = r.totalPrice != null ? r.totalPrice
      : (r.itemPrice != null && r.deliveryFee != null)
        ? parseFloat((r.itemPrice + r.deliveryFee).toFixed(2))
        : null;
    return { ...r, totalPrice: total };
  });

  // Deduplicate: same platform + restaurant + item + price = one row
  const seen = new Set();
  results = results.filter(r => {
    const key = `${r.platform}|${r.restaurant?.toLowerCase().trim()}|${r.item?.toLowerCase().trim()}|${r.itemPrice}`;
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

  return {
    ranked,
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

module.exports = { aggregate };
