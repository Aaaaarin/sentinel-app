// The rule applied to real holdings. Shared, unchanged, by the app (browser)
// and the notification sender (Supabase edge function), so a notification can
// never disagree with the screen.
//
//   keep   holdings ranked inside sell_rank (35)
//   sell   everything else (rank past 35, unranked, illiquid, ETFs)
//   trim   a kept holding worth more than twice its equal share, back to one share
//   buy    the best-ranked names (1..top) not held, equal money each
//   fill   rounding leftovers buy extra shares of the most underweight names,
//          so the money stays invested

export function makePlan(D, state) {
  const R = D.rules;
  const RANKS = D.all_ranks || {};
  const ORDERED = Object.keys(RANKS).sort((a, b) => RANKS[a][0] - RANKS[b][0]);
  const rankOf = (s) => (RANKS[s] ? RANKS[s][0] : null);
  const lastPx = (s) => (RANKS[s] ? RANKS[s][1] : null);
  const N = state.slots || R.top;

  const rows = (state.holdings || [])
    .filter((h) => h.symbol && h.qty > 0)
    .map((h) => {
      const known = h.ltp > 0 ? h.ltp : lastPx(h.symbol);
      const p = known || h.avg || 0;
      const q = Math.floor(h.qty);
      return { symbol: h.symbol, qty: q, price: p, known: !!known, value: q * p, rank: rankOf(h.symbol), avg: h.avg };
    });
  const held = rows.reduce((a, r) => a + r.value, 0);
  let capital = state.capital, example = false, warn = null;
  if (!(capital > 0)) { if (held > 0) capital = held; else { capital = 500000; example = true; } }
  if (capital < held) { warn = { held, entered: capital }; capital = held; }

  let keep = rows.filter((r) => r.rank && r.rank <= R.sell_rank).sort((a, b) => a.rank - b.rank);
  const sells = rows.filter((r) => !(r.rank && r.rank <= R.sell_rank)).map((r) => ({
    ...r, why: r.rank ? `#${r.rank}, past ${R.sell_rank}` : "unranked",
  }));
  if (keep.length > N) {
    keep.slice(N).forEach((r) => sells.push({ ...r, why: `#${r.rank}, over ${N} slots` }));
    keep = keep.slice(0, N);
  }
  const target = capital / N;
  const trims = [];
  keep = keep.map((k) => ({ ...k }));
  keep.forEach((k) => {
    if (k.value <= 2 * target) return;
    const q = Math.floor((k.value - target) / k.price);
    if (q < 1) return;
    trims.push({ symbol: k.symbol, rank: k.rank, qty: q, price: k.price, value: q * k.price, was: k.value });
    k.qty -= q; k.value -= q * k.price;
  });
  const keepVal = keep.reduce((a, r) => a + r.value, 0);
  const pool = capital - keepVal;
  const have = new Set(rows.map((r) => r.symbol));
  const nBuy = N - keep.length;
  const buys = [], skipped = [];
  const per = nBuy > 0 ? pool / nBuy : 0;
  for (let i = 0; i < ORDERED.length && buys.length < nBuy; i++) {
    const s = ORDERED[i], rk = RANKS[s][0], p = RANKS[s][1];
    if (rk > R.top) break;
    if (have.has(s) || !(p > 0)) continue;
    const q = Math.floor(per / p);
    if (q < 1) { skipped.push(s); continue; }
    buys.push({ symbol: s, rank: rk, price: p, qty: q, value: q * p });
  }
  let left = pool - buys.reduce((a, b) => a + b.value, 0);
  const pos = keep.map((k) => ({ symbol: k.symbol, price: k.price, value: k.value, add: 0, k }))
    .concat(buys.map((b) => ({ symbol: b.symbol, price: b.price, value: b.value, b })));
  const trimmed = new Set(trims.map((t) => t.symbol));
  let guard = 0;
  while (left > 0 && guard++ < 20000) {
    const cand = pos.filter((x) => x.price > 0 && x.price <= left && !trimmed.has(x.symbol));
    if (!cand.length) break;
    cand.sort((a, b) => a.value - b.value);
    const c = cand[0];
    c.value += c.price; left -= c.price;
    if (c.b) { c.b.qty += 1; c.b.value += c.price; } else c.add += 1;
  }
  const topups = pos.filter((x) => x.k && x.add > 0 && !trimmed.has(x.symbol))
    .map((x) => ({ symbol: x.symbol, rank: x.k.rank, qty: x.add, price: x.price, value: x.add * x.price }));
  const positions = pos.map((x) => ({ symbol: x.symbol, value: x.value, rank: x.k ? x.k.rank : x.b.rank, kept: !!x.k }));
  const invested = positions.reduce((a, x) => a + x.value, 0);
  return {
    N, capital, example, warn, held, keep, sells, trims, buys, topups, skipped, target,
    cash: Math.max(capital - invested, 0), invested, positions,
    count: sells.length + trims.length + buys.length + topups.length,
  };
}
