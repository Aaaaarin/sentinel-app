// Sentinel phone app. Data flow:
//   laptop (NSE data, the rule) -> Supabase payload -> this app (get_bundle)
//   this app (holdings, money, snapshots) -> Supabase app_state / snapshots
// Everything is cached on the phone, so the app opens and works offline; edits
// made offline wait in an outbox and go up on the next connection.
import { makePlan } from "./plan.js";
import { readScreenshots, buildIndex } from "./ocr.js";

// ?demo opens a read-only showcase on sample data: no server, and its own storage,
// so it never touches a paired phone's state on the same site.
const DEMO = new URLSearchParams(location.search).has("demo");
const CFG = DEMO ? {} : (window.SENTINEL || {});
const VERSION = "1.1.1";
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

// ---------- formatting ----------
const MON = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"], DOW = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];
const pd = (s) => { const a = String(s).slice(0, 10).split("-"); return new Date(+a[0], +a[1] - 1, +a[2]); };
const iso = (d) => d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
const fd = (s, dow) => { if (!s) return "-"; const d = pd(s); return (dow ? DOW[d.getDay()] + " " : "") + d.getDate() + " " + MON[d.getMonth()]; };
const fdy = (s) => { if (!s) return "-"; const d = pd(s); return d.getDate() + " " + MON[d.getMonth()] + " " + String(d.getFullYear()).slice(2); };
const px = (x) => x == null || !isFinite(x) ? "-" : Number(x).toLocaleString("en-IN", { minimumFractionDigits: x < 1000 ? 2 : 0, maximumFractionDigits: x < 1000 ? 2 : 1 });
const rs = (x) => x == null || !isFinite(x) ? "-" : (x < 0 ? "-" : "") + "Rs " + Math.round(Math.abs(x)).toLocaleString("en-IN");
const rsS = (x) => (x > 0 ? "+" : "") + rs(x);
const pct = (x, nd) => x == null || !isFinite(x) ? "-" : (x > 0 ? "+" : "") + Number(x).toFixed(nd == null ? 1 : nd) + "%";
const cls = (x) => x == null ? "" : x > 0 ? "up" : x < 0 ? "down" : "";
const addSessions = (d, n) => { d = new Date(d); let k = 0; while (k < n) { d.setDate(d.getDate() + 1); if (d.getDay() % 6) k++; } return d; };
const sessionsBetween = (a, b) => { const d = pd(a), e = pd(b); let n = 0; while (d < e) { d.setDate(d.getDate() + 1); if (d.getDay() % 6) n++; } return n; };
const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
const num = (x) => { const v = parseFloat(x); return isFinite(v) ? v : null; };
const ago = (t) => { if (!t) return "never"; const s = (Date.now() - new Date(t).getTime()) / 1000; return s < 90 ? "just now" : s < 5400 ? Math.round(s / 60) + " min ago" : s < 129600 ? Math.round(s / 3600) + " h ago" : Math.round(s / 86400) + " days ago"; };
function toast(msg) { const t = $("toast"); t.textContent = msg; t.hidden = false; clearTimeout(toast.t); toast.t = setTimeout(() => { t.hidden = true; }, 3200); }

// ---------- local storage ----------
const LSNS = DEMO ? "sentinel-demo-" : "sentinel-";
const LS = {
  get(k, d) { try { const v = localStorage.getItem(LSNS + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem(LSNS + k, JSON.stringify(v)); } catch (e) {} },
  del(k) { try { localStorage.removeItem(LSNS + k); } catch (e) {} },
};

// ---------- data ----------
let D = null, R, F, A, RANKS = {}, ORDERED = [], BOOK = {}, TOPMAP = {}, HOLD = [], OCRINDEX = null;
function setData(p) {
  D = p; R = D.rules; F = D.forecast; A = D.analysis; RANKS = D.all_ranks || {};
  ORDERED = Object.keys(RANKS).sort((a, b) => RANKS[a][0] - RANKS[b][0]);
  BOOK = {}; D.book.forEach((b) => { BOOK[b.symbol] = b; });
  TOPMAP = {}; D.top_now.forEach((b) => { TOPMAP[b.symbol] = b; });
  HOLD = []; (F.hold_hist || []).forEach((n, L) => { for (let i = 0; i < n; i++) HOLD.push(L); });
  OCRINDEX = null;
}
const rankOf = (s) => RANKS[s] ? RANKS[s][0] : null;
const lastPx = (s) => RANKS[s] ? RANKS[s][1] : (BOOK[s] ? BOOK[s].close : null);
const cone = (h) => { const c = F.stock_cone; return c[Math.max(0, Math.min(Math.round(h), c.length - 1))]; };
function remHold(age) {
  const r = HOLD.filter((L) => L > age).map((L) => L - age).sort((a, b) => a - b);
  return r.length >= 10 ? r[Math.floor(r.length / 2)] : 5;
}

let KEY = LS.get("key", null);
let cache = LS.get("cache", {});
const DEFAULT_TWIN = { capital: null, slots: 20, holdings: [], shot: null, orders_done_for: null, prefs: { remind: true, drift: true } };
let twin = Object.assign({}, DEFAULT_TWIN, cache.state || {});
if (DEMO && !(twin.capital > 0)) twin.capital = 500000;
let snaps = cache.snapshots || [];
let outbox = LS.get("outbox", []);
let lastSync = LS.get("lastSync", null), syncing = false, online = navigator.onLine;

function saveCache() { cache.state = twin; cache.snapshots = snaps; LS.set("cache", cache); }

async function rpc(fn, args) {
  const h = { "Content-Type": "application/json", apikey: CFG.key };
  if (/^ey/.test(CFG.key || "")) h.Authorization = "Bearer " + CFG.key;
  const r = await fetch(`${CFG.url}/rest/v1/rpc/${fn}`, { method: "POST", headers: h, body: JSON.stringify(args) });
  if (!r.ok) {
    const t = await r.text();
    const e = new Error(t); e.status = r.status; e.notPaired = /not paired/i.test(t); throw e;
  }
  const txt = await r.text();
  return txt ? JSON.parse(txt) : null;
}

function queue(fn, args) {
  if (fn === "save_state") outbox = outbox.filter((o) => o.fn !== "save_state");
  outbox.push({ fn, args }); LS.set("outbox", outbox);
  flush();
}
async function flush() {
  if (!CFG.url || !KEY) return;
  while (outbox.length) {
    const o = outbox[0];
    try { await rpc(o.fn, Object.assign({ p_key: KEY }, o.args)); outbox.shift(); LS.set("outbox", outbox); }
    catch (e) { if (e.notPaired) showPair("This phone is no longer paired. Scan the pairing code again."); break; }
  }
  renderSyncChip();
}

async function sync(manual) {
  if (syncing) return;
  if (!CFG.url) return;
  if (!KEY) { showPair(); return; }
  syncing = true; renderSyncChip();
  try {
    await flush();
    const b = await rpc("get_bundle", { p_key: KEY, p_have: cache.payload_id ?? null });
    let changed = false;
    if (b.payload) { cache.payload = b.payload; cache.payload_id = b.payload_id; changed = true; }
    cache.payload_at = b.payload_at; cache.notifs = b.notifs || []; cache.subs = b.subs; cache.vapid_public = b.vapid_public;
    // the phone's own edits win while they are still waiting to go up
    if (b.state && !outbox.some((o) => o.fn === "save_state")) {
      const remote = Object.assign({}, DEFAULT_TWIN, b.state);
      if (!twin.updated_at || (remote.updated_at && remote.updated_at >= twin.updated_at)) twin = remote;
    }
    if (Array.isArray(b.snapshots)) {
      const mine = new Map(snaps.map((s) => [s.id, s]));
      b.snapshots.forEach((s) => mine.set(s.id, s));
      snaps = [...mine.values()].sort((a, b2) => a.ts - b2.ts);
    }
    saveCache(); lastSync = new Date().toISOString(); LS.set("lastSync", lastSync);
    if (changed) { setData(cache.payload); renderStatic(); }
    renderAll();
    if (manual) toast("Synced");
  } catch (e) {
    if (e.notPaired) showPair("Pairing code not recognised. Scan the QR code again.");
    else if (manual) toast("Offline. Showing the last saved data.");
  } finally { syncing = false; renderSyncChip(); }
}

function persist() {
  twin.updated_at = new Date().toISOString();
  saveCache();
  clearTimeout(persist.t);
  persist.t = setTimeout(() => queue("save_state", { p_state: stateForServer() }), 700);
}
function stateForServer() {
  return { capital: twin.capital, slots: twin.slots, holdings: twin.holdings, shot: twin.shot, orders_done_for: twin.orders_done_for, prefs: twin.prefs };
}

// ---------- pairing ----------
function showPair(note) { $("pair").hidden = false; $("pairNote").textContent = note || ""; }
$("btnPair").onclick = async () => {
  const k = $("pairCode").value.trim();
  if (k.length < 16) { $("pairNote").textContent = "That code is too short. Copy the whole code."; return; }
  KEY = k; LS.set("key", KEY); $("pairNote").textContent = "Checking...";
  try { await rpc("get_bundle", { p_key: KEY, p_have: -1 }); $("pair").hidden = true; sync(true); }
  catch (e) { $("pairNote").textContent = e.notPaired ? "Code not recognised." : "Could not reach the server. Check the connection."; }
};
(function readPairHash() {
  const m = location.hash.match(/^#pair=([A-Za-z0-9_-]{16,})$/);
  if (m) { KEY = m[1]; LS.set("key", KEY); try { history.replaceState(null, "", location.pathname + "#today"); } catch (e) {} }
})();

// ---------- navigation ----------
const VIEWS = [
  ["today", "Today", "What the rule says to do with your money now."],
  ["portfolio", "Portfolio", "Your real holdings and money. Everything else is computed from here."],
  ["forecast", "Forecast", "Where the rule expects the market and each stock to go, and when it expects to sell."],
  ["analysis", "Analysis", "What we are doing, how the market is running, and how our forecasts have held up."],
  ["ledger", "Ledger", "Every forecast, logged before the outcome and scored after it."],
  ["book", "Model book", "The 20 stocks the rule itself holds right now."],
  ["record", "Track record", "How the rule has done: replay since 2021, live since 5 Oct 26."],
  ["rules", "Rules", "The whole strategy on one page, and the latest ranking."],
  ["settings", "Settings", "Notifications, sync and this phone."],
];
$("navlist").innerHTML = VIEWS.map((v, i) => `<button data-view="${v[0]}"><span class="k">${i + 1}</span>${v[1]}<span class="badge" id="badge-${v[0]}" hidden></span></button>`).join("");
let current = null;
function show(name) {
  if (!VIEWS.some((v) => v[0] === name)) name = "today";
  current = name;
  VIEWS.forEach((v) => {
    $("v-" + v[0]).hidden = v[0] !== name;
    const b = document.querySelector(`[data-view="${v[0]}"]`);
    if (v[0] === name) { b.setAttribute("aria-current", "page"); $("vTitle").textContent = v[1]; $("vSub").textContent = v[2]; b.scrollIntoView({ block: "nearest", inline: "nearest" }); }
    else b.removeAttribute("aria-current");
  });
  LS.set("view", name);
  if (location.hash !== "#" + name) { try { history.replaceState(null, "", "#" + name); } catch (e) {} }
  requestAnimationFrame(redrawAll);
}
$("navlist").addEventListener("click", (e) => { const b = e.target.closest("[data-view]"); if (b) show(b.getAttribute("data-view")); });
document.addEventListener("click", (e) => { const b = e.target.closest("[data-go]"); if (b) show(b.getAttribute("data-go")); });
window.addEventListener("hashchange", () => show(location.hash.slice(1)));
function badge(view, text, hot) { const b = $("badge-" + view); if (!b) return; b.hidden = text == null || text === ""; b.textContent = text; b.className = "badge" + (hot ? " hot" : ""); }

// ---------- today ----------
function renderToday(P) {
  let h = `<div class="eyebrow">Today, ${fd(iso(new Date()), true)}</div>`;
  if (D.state === "rebalance") {
    h += `<div class="verdict go">Review day</div><div>The weekly signal from the close of ${fd(D.last_rebalance.signal_date, true)} is in. Place your orders ${D.exec_date !== D.run_date ? "on " + fd(D.exec_date, true) + ", the next session." : "today."}</div><div class="sub" style="margin-top:6px">The replay filled at the session VWAP: skip the first 15 minutes and place orders mid-session.</div>`;
  } else if (D.state === "stale") {
    h += `<div class="verdict stop">Wait</div><div>The data is out of date, so nothing here is current.</div>`;
  } else {
    h += `<div class="verdict">Hold</div><div>The model book trades once a week. New money can go in any day using your orders.</div><div class="when"><div><b>${fd(D.next_signal, true)}</b><span>next review, at the close</span></div><div><b>${fd(D.next_fill, true)}</b><span>orders go in</span></div></div>`;
  }
  const bw = F.book_week || {}, v = P.invested;
  h += `<div class="expect"><div class="sub">Expected over the next week on ${P.example ? "an example " : "your "}${rs(v)} invested</div><div><b class="${cls(bw.mean)}">${rsS(v * bw.mean / 100)}</b> <span class="sub">(${pct(bw.mean, 2)})</span></div><div class="sub">Middle half of weeks: ${rsS(v * bw.p25 / 100)} to ${rsS(v * bw.p75 / 100)}. One week in ten is worse than ${rsS(v * bw.p10 / 100)}.</div></div>`;
  $("today").innerHTML = h;
}
function renderPulse() {
  const m = A.market, w = A.preds.walk, u = A.us;
  $("pulse").innerHTML = `<div style="font-weight:600">${esc(m.regime)}</div><div class="pulse">` +
    `<div><b class="${cls(m.nifty.m1)}">${pct(m.nifty.m1)}</b><span>Nifty 50, 1 month</span></div>` +
    `<div><b class="${cls(m.universe.m1)}">${pct(m.universe.m1)}</b><span>average liquid stock, 1 month</span></div>` +
    `<div><b>${m.breadth.a200}%</b><span>stocks above 200-day avg</span></div>` +
    `<div><b class="${cls(u.w13.excess)}">${pct(u.w13.excess)}</b><span>book vs universe, 13 weeks</span></div>` +
    `<div><b>${w.in50 == null ? "-" : w.in50 + "%"}</b><span>forecasts in middle half (target 50%)</span></div>` +
    `<div><b>${w.in80 == null ? "-" : w.in80 + "%"}</b><span>in 8-in-10 range (target 80%)</span></div></div>`;
}
const orow = (sym, why, q, amt) => `<div class="orow"><div><span class="sym">${esc(sym)}</span>${why ? `<span class="why">${why}</span>` : ""}</div><div class="q">${q}</div><div class="amt">${amt}</div></div>`;
function renderOrders(P) {
  let h = "";
  $("ordersTitle").textContent = P.example ? "Orders for a fresh Rs 5,00,000" : "Your orders";
  $("ordersSub").textContent = P.example ? "Example only. Add your money and holdings in Portfolio." : `${P.N} stocks, about ${rs(P.target)} each.`;
  if (P.warn) h += `<div class="note">Your holdings are worth ${rs(P.warn.held)}, more than the ${rs(P.warn.entered)} entered, so the orders use ${rs(P.warn.held)}.</div>`;
  if (P.sells.length) h += `<div class="ogrp sell"><h3><span class="dot" style="background:var(--bad)"></span>Sell ${P.sells.length}</h3>` +
    P.sells.map((r) => { const pl = r.avg > 0 && r.known ? (r.price / r.avg - 1) * 100 : null; return orow(r.symbol, esc(r.why), "all " + r.qty, rs(r.value) + (pl != null ? ` <span class="${cls(pl)}">${pct(pl)}</span>` : "")); }).join("") + "</div>";
  if (P.trims.length) h += `<div class="ogrp sell"><h3><span class="dot" style="background:var(--bad)"></span>Trim ${P.trims.length}</h3>` +
    P.trims.map((t) => orow(t.symbol, `rank ${t.rank}, still a hold. Worth ${rs(t.was)}, over twice its equal share, so sell part`, t.qty + " of it", rs(t.value))).join("") + "</div>";
  if (P.buys.length) {
    const rem = remHold(0), c = cone(rem), sellBy = fd(iso(addSessions(pd(D.asof), rem)), true);
    h += `<div class="ogrp buy"><h3><span class="dot" style="background:var(--good)"></span>Buy ${P.buys.length}</h3>` +
      P.buys.map((b) => orow(b.symbol, `rank ${b.rank}. Expected sell around ${sellBy}, ${pct(c.mean)} (middle half ${pct(c.p25, 0)} to ${pct(c.p75, 0)})`, b.qty + " @ " + px(b.price), rs(b.value))).join("") + "</div>";
  }
  if (P.topups.length) h += `<div class="ogrp top"><h3><span class="dot" style="background:var(--muted)"></span>Add to ${P.topups.length}</h3>` +
    P.topups.map((t) => orow(t.symbol, `rank ${t.rank}, tops up toward its equal share`, "+" + t.qty + " @ " + px(t.price), rs(t.value))).join("") + "</div>";
  if (!P.count) h += `<div class="none">Nothing to do. Every holding is inside rank ${R.sell_rank} and your money is invested.</div>`;
  h += `<div class="sub">${P.example ? "" : `Keeping ${P.keep.length} of your holdings. `}After these orders: ${rs(P.invested)} in ${P.positions.length} stocks, ${rs(P.cash)} left over (less than one more share).${P.skipped.length ? " Skipped because one share costs more than a slot: " + P.skipped.map(esc).join(", ") + "." : ""}</div>`;
  $("orders").innerHTML = h;
  const sig = D.last_rebalance.signal_date, box = $("doneBox");
  if (!P.example && D.state === "rebalance" && P.count) {
    box.hidden = false;
    box.innerHTML = twin.orders_done_for === sig
      ? `<div class="note">Marked placed. Add a fresh screenshot in Portfolio so the app tracks what you now hold.</div>`
      : `<button class="primary" id="btnDone" type="button">I placed these orders</button> <span class="sub">Stops the Monday reminder.</span>`;
    const bd = $("btnDone"); if (bd) bd.onclick = () => { twin.orders_done_for = sig; persist(); renderAll(); toast("Marked placed"); };
  } else box.hidden = true;
  badge("today", P.example ? "" : (P.count || ""), D.state === "rebalance" && P.count > 0);
}

// ---------- portfolio ----------
// ---------- photo batch: every photo until "Done" is the same moment in time ----------
let session = LS.get("shotSession", null);   // { started, photos, rows, total_pnl, lines }
const editRows = () => (session ? session.rows : twin.holdings);
function saveSession() { if (session) LS.set("shotSession", session); else LS.del("shotSession"); }
function touchRows() { if (session) { saveSession(); renderAll(); } else { twin.source = "edited"; persist(); renderAll(); } }
function mergeRows(into, rows) {
  // the same stock in two overlapping screenshots is one holding, not two
  const at = new Map(into.map((r, i) => [r.symbol, i]));
  rows.forEach((r) => {
    if (!at.has(r.symbol)) { at.set(r.symbol, into.length); into.push({ ...r, check: { ...(r.check || {}) } }); return; }
    const o = into[at.get(r.symbol)];
    ["qty", "avg", "ltp"].forEach((k) => {
      if (o[k] == null && r[k] != null) { o[k] = r[k]; o.check[k] = !!(r.check && r.check[k]); }
      else if (o[k] != null && r[k] != null && Math.abs(o[k] - r[k]) / Math.max(o[k], 1) > 0.01) o.check[k] = true;
    });
  });
  return into;
}
function renderSession() {
  const on = !!session;
  $("sessBox").hidden = !on; $("btnShot").hidden = on; $("normalBtns").style.display = on ? "none" : "contents";
  if (!on) return;
  const n = session.rows.length, doubt = session.rows.filter((r) => Object.values(r.check || {}).some(Boolean)).length;
  $("sessTitle").textContent = `New portfolio: ${session.photos} photo${session.photos === 1 ? "" : "s"}, ${n} stock${n === 1 ? "" : "s"} so far`;
  $("sessSub").textContent = (doubt ? `${doubt} with a yellow cell to check. ` : "") + "Add the rest of your holdings list, then tap Done. Done replaces your current holdings with this list and saves a snapshot.";
}

function renderEditor() {
  renderSession();
  const rowsNow = editRows();
  let h = '<thead><tr><th>Symbol</th><th class="n">Qty</th><th class="n">Avg price</th><th class="n">Last price</th><th class="n hide-m">P&amp;L</th><th>Rule says</th><th></th></tr></thead><tbody>';
  rowsNow.forEach((r, i) => {
    const rk = rankOf(r.symbol), p = r.ltp > 0 ? r.ltp : lastPx(r.symbol), ck = r.check || {};
    const pl = r.avg > 0 && p && r.qty ? (p - r.avg) * r.qty : null;
    const say = !r.symbol ? "" : rk && rk <= R.sell_rank
      ? `<span class="chip"><span class="dot" style="background:var(${rk > R.watch_rank ? "--warn" : "--good"})"></span>${rk > R.watch_rank ? "Hold, drifting" : "Hold"} (${rk})</span>`
      : `<span class="chip"><span class="dot" style="background:var(--bad)"></span>Sell (${rk ? rk : "unranked"})</span>`;
    const inp = (k, type, val, extra) => `<input type="${type}" id="h-${k}-${i}" data-i="${i}" data-k="${k}" value="${val == null ? "" : esc(val)}" class="${ck[k] ? "chk" : ""}" ${extra || ""}>`;
    h += `<tr><td>${inp("symbol", "text", r.symbol, 'style="text-transform:uppercase" aria-label="Symbol" autocapitalize="characters"')}</td>` +
      `<td class="n">${inp("qty", "number", r.qty, 'inputmode="numeric" aria-label="Quantity"')}</td>` +
      `<td class="n">${inp("avg", "number", r.avg, 'step="0.01" inputmode="decimal" aria-label="Average price"')}</td>` +
      `<td class="n">${inp("ltp", "number", r.ltp, `step="0.01" inputmode="decimal" placeholder="${lastPx(r.symbol) || ""}" aria-label="Last price"`)}</td>` +
      `<td class="n hide-m mono ${cls(pl)}">${pl == null ? "-" : rsS(pl)}</td><td>${say}</td><td><button data-del="${i}" type="button" aria-label="Remove row">Remove</button></td></tr>`;
  });
  if (!rowsNow.length) h += `<tr><td colspan="7" class="sub">${session ? "Nothing recognised yet. Add another photo or type the stocks in." : "No holdings yet. Add screenshots or type them in."}</td></tr>`;
  $("editTbl").innerHTML = h + "</tbody>";
}
$("editTbl").addEventListener("change", (e) => {
  const el = e.target, i = el.getAttribute("data-i"), k = el.getAttribute("data-k");
  if (i == null) return;
  const row = editRows()[+i];
  row[k] = k === "symbol" ? el.value.trim().toUpperCase() : num(el.value);
  if (row.check) row.check[k] = false;
  touchRows();
});
$("editTbl").addEventListener("click", (e) => {
  const d = e.target.getAttribute && e.target.getAttribute("data-del");
  if (d == null) return;
  editRows().splice(+d, 1); touchRows();
});
$("btnAddRow").onclick = () => { editRows().push({ symbol: "", qty: null, avg: null, ltp: null, check: {} }); if (session) saveSession(); renderEditor(); };
$("btnClear").onclick = () => {
  const b = $("btnClear");
  if (b.dataset.armed) { delete b.dataset.armed; twin.holdings = []; b.textContent = "Clear all"; persist(); renderAll(); return; }
  b.dataset.armed = "1"; b.textContent = "Tap again to clear";
  setTimeout(() => { delete b.dataset.armed; b.textContent = "Clear all"; }, 3000);
};
$("capital").addEventListener("input", () => { const v = num($("capital").value); twin.capital = v > 0 ? v : null; persist(); renderAll(); });
function renderSlots() { $("slots").innerHTML = [10, 15, 20].map((n) => `<button data-n="${n}" type="button" aria-pressed="${twin.slots === n}">${n}</button>`).join(""); }
$("slots").onclick = (e) => { const n = e.target.getAttribute && e.target.getAttribute("data-n"); if (!n) return; twin.slots = +n; persist(); renderSlots(); renderAll(); };

$("btnShot").onclick = () => $("shotFile").click();
$("btnMore").onclick = () => $("shotFile").click();
$("btnCancelShots").onclick = () => {
  const b = $("btnCancelShots");
  if (!b.dataset.armed) { b.dataset.armed = "1"; b.textContent = "Tap again to discard"; setTimeout(() => { delete b.dataset.armed; b.textContent = "Cancel"; }, 3000); return; }
  delete b.dataset.armed; b.textContent = "Cancel";
  session = null; saveSession(); $("shotBox").hidden = true; renderAll(); toast("Photos discarded. Your holdings are unchanged.");
};
$("btnDoneShots").onclick = () => {
  const rows = session.rows.filter((r) => r.symbol);
  if (!rows.length) { toast("No stocks in this batch yet."); return; }
  const noQty = rows.filter((r) => !(r.qty > 0)).map((r) => r.symbol);
  if (noQty.length) { toast("Fill in the quantity for " + noQty.slice(0, 4).join(", ") + (noQty.length > 4 ? "..." : "")); return; }
  twin.holdings = rows.map((r) => ({ symbol: r.symbol, qty: r.qty, avg: r.avg, ltp: r.ltp, check: r.check }));
  twin.shot = { at: new Date().toISOString(), total_pnl: session.total_pnl ?? null, photos: session.photos };
  twin.source = "screenshot";
  const photos = session.photos;
  session = null; saveSession(); $("shotBox").hidden = true;
  persist(); saveSnapshot("photos");
  toast(`Portfolio updated: ${rows.length} stocks from ${photos} photo${photos === 1 ? "" : "s"}. Snapshot saved.`);
  show("today");
};
$("shotFile").onchange = async () => {
  const files = Array.from($("shotFile").files || []);
  $("shotFile").value = "";
  if (!files.length) return;
  $("shotBox").hidden = false; $("btnShot").disabled = true; $("btnMore").disabled = true;
  const bar = $("shotBar"), st = $("shotStatus");
  bar.style.width = "3%"; st.textContent = "Starting the text reader (first time downloads about 7 MB, then it works offline)";
  try {
    if (!OCRINDEX) OCRINDEX = buildIndex(D.names || {}, RANKS);
    const r = await readScreenshots(files, { index: OCRINDEX, ranks: RANKS }, (label, p) => { st.textContent = label + (p ? " " + Math.round(p * 100) + "%" : ""); bar.style.width = Math.max(3, Math.round(p * 100)) + "%"; });
    bar.style.width = "100%";
    $("rawBox").hidden = false;
    if (!session) session = { started: new Date().toISOString(), photos: 0, rows: [], total_pnl: null, lines: [] };
    const before = session.rows.length;
    mergeRows(session.rows, r.holdings);
    session.photos += files.length;
    if (session.total_pnl == null && r.total_pnl != null) session.total_pnl = r.total_pnl;
    session.lines = session.lines.concat(r.lines).slice(-400);
    saveSession(); renderAll();
    $("rawText").textContent = session.lines.join("\n");
    const added = session.rows.length - before;
    st.textContent = r.holdings.length
      ? `Found ${r.holdings.length} stock${r.holdings.length === 1 ? "" : "s"} in ${files.length === 1 ? "this photo" : "these photos"} (${added} new to the list). Add more photos, or tap Done.`
      : "No stocks recognised in that photo. Try the holdings list itself, or type them in below.";
  } catch (e) {
    st.textContent = e.message || "Could not read the screenshot.";
  } finally { $("btnShot").disabled = false; $("btnMore").disabled = false; }
};

$("btnSave").onclick = () => saveSnapshot("manual");
function saveSnapshot(source) {
  const P = makePlan(D, twin), bw = F.book_week || {};
  const rows = twin.holdings.filter((h) => h.symbol && h.qty > 0);
  if (!rows.length) { $("saveNote").textContent = "Add at least one holding first."; return; }
  const hs = rows.map((h) => ({ symbol: h.symbol, qty: h.qty, avg: h.avg || null, ltp: h.ltp > 0 ? h.ltp : lastPx(h.symbol) }));
  const snap = {
    id: "s" + Date.now(), ts: Date.now(), date: iso(new Date()), asof: D.asof, capital: P.capital,
    value: hs.reduce((a, h) => a + h.qty * (h.ltp || 0), 0),
    pnl: twin.shot && twin.shot.total_pnl != null ? twin.shot.total_pnl : hs.reduce((a, h) => a + (h.avg > 0 ? ((h.ltp || 0) - h.avg) * h.qty : 0), 0),
    exp_1w: bw.mean, p25_1w: bw.p25, p75_1w: bw.p75, holdings: hs, source,
  };
  twin.holdings.forEach((h) => { h.check = {}; });
  snaps.push(snap); persist(); queue("add_snapshot", { p_snap: snap });
  $("saveNote").textContent = `Saved at ${new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}. The next snapshot is scored against this one.`;
  renderAll();
}
function renderMine() {
  const h = '<thead><tr><th>Snapshot</th><th class="n">Value</th><th class="n">P&amp;L</th><th class="n">Expected</th><th class="n">Actual</th><th class="hide-m">Result</th></tr></thead><tbody>';
  if (!snaps.length) { $("mineTbl").innerHTML = h + '<tr><td colspan="6" class="sub">No snapshots yet. Save one from the holdings panel to start the record.</td></tr></tbody>'; return; }
  const out = [];
  snaps.forEach((s, i) => {
    let exp = null, act = null, band = null;
    if (i > 0) {
      const prev = snaps[i - 1], sess = sessionsBetween(prev.asof, s.asof), now = {};
      s.holdings.forEach((x) => { now[x.symbol] = x; });
      let base = 0, move = 0;
      prev.holdings.forEach((x) => { const n = now[x.symbol]; if (n && x.ltp && n.ltp) { const q = Math.min(x.qty, n.qty); base += q * x.ltp; move += q * (n.ltp - x.ltp); } });
      if (base > 0 && sess > 0) { const f = sess / 5; exp = base * (prev.exp_1w || 0) / 100 * f; act = move; band = [base * prev.p25_1w / 100 * Math.sqrt(f), base * prev.p75_1w / 100 * Math.sqrt(f)]; }
    }
    const res = exp == null ? `<span class="sub">${i ? "same session" : "baseline"}</span>` :
      (act >= band[0] && act <= band[1] ? '<span class="chip"><span class="dot" style="background:var(--good)"></span>inside middle half</span>'
        : `<span class="chip"><span class="dot" style="background:var(--warn)"></span>${act > band[1] ? "better" : "worse"} than middle half</span>`);
    out.push(`<tr><td>${fdy(s.date)} <span class="sub">${new Date(s.ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span></td><td class="n">${rs(s.value)}</td><td class="n ${cls(s.pnl)}">${rsS(s.pnl)}</td><td class="n">${exp == null ? "-" : rsS(exp)}</td><td class="n ${cls(act)}">${act == null ? "-" : rsS(act)}</td><td class="hide-m">${res}</td></tr>`);
  });
  $("mineTbl").innerHTML = h + out.reverse().join("") + "</tbody>";
}

// ---------- charts: sized to their panel, redrawn whenever it changes size ----------
const NS = "http://www.w3.org/2000/svg";
const drawers = [];
function chart(id, fn) {
  const host = $(id); drawers.push({ host, fn });
  if (window.ResizeObserver) new ResizeObserver(() => { if (D && host.clientWidth > 0) fn(host); }).observe(host);
}
function redrawAll() { if (!D) return; drawers.forEach((d) => { if (d.host.clientWidth > 0) d.fn(d.host); }); }
function ticks(lo, hi, n) {
  const span = hi - lo || 1; let step = Math.pow(10, Math.floor(Math.log10(span / n)));
  [1, 2, 2.5, 5, 10].some((m) => { if (span / (step * m) <= n) { step *= m; return true; } return false; });
  const out = []; for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) out.push(+v.toFixed(6)); return out;
}
function pathOf(pts) { let d = "", pen = false; pts.forEach((p) => { if (p == null) { pen = false; return; } d += (pen ? "L" : "M") + p[0].toFixed(1) + "," + p[1].toFixed(1); pen = true; }); return d; }
const areaOf = (top, bot) => top.length ? "M" + top.map((p) => p[0].toFixed(1) + "," + p[1].toFixed(1)).join("L") + "L" + bot.slice().reverse().map((p) => p[0].toFixed(1) + "," + p[1].toFixed(1)).join("L") + "Z" : "";
function txt(x, y, s, o = {}) { return `<text x="${x.toFixed(1)}" y="${y.toFixed(1)}" font-size="${o.size || 11}" fill="${css(o.color || "--muted")}"${o.anchor ? ` text-anchor="${o.anchor}"` : ""}${o.mono ? ` font-family="${css("--mono")}"` : ""}${o.bold ? ' font-weight="600"' : ""}>${s}</text>`; }
const grid = (lo, hi, Y, W, ml, mr, fmt, emph) => ticks(lo, hi, 4).map((t) => `<line x1="${ml}" x2="${W - mr}" y1="${Y(t).toFixed(1)}" y2="${Y(t).toFixed(1)}" stroke="${css(t === emph ? "--axis" : "--line")}"/>` + txt(W - mr + 6, Y(t) + 4, fmt(t), { mono: true })).join("");
const vline = (x, y0, y1, color, dash, label, anchor, ly) => `<line x1="${x.toFixed(1)}" x2="${x.toFixed(1)}" y1="${y0}" y2="${y1}" stroke="${color}" stroke-dasharray="${dash}"/>` + (label ? txt(x + (anchor === "end" ? -4 : 4), ly, label, { anchor: anchor || "start" }) : "");
function mount(host, W, H, g, xs, tipFn) {
  host.innerHTML = "";
  const svg = document.createElementNS(NS, "svg"); svg.setAttribute("viewBox", `0 0 ${W} ${H}`); svg.innerHTML = g; host.appendChild(svg);
  if (!xs) return;
  const tip = document.createElement("div"); tip.className = "tip"; tip.hidden = true; host.appendChild(tip);
  const xh = document.createElementNS(NS, "line"); xh.setAttribute("stroke", css("--axis")); xh.setAttribute("visibility", "hidden"); xh.setAttribute("y1", 6); xh.setAttribute("y2", H - 22); svg.appendChild(xh);
  const move = (ev) => {
    const r = svg.getBoundingClientRect(), x = (ev.clientX - r.left) / r.width * W; let best = 0, bd = 1e9;
    xs.forEach((v, i) => { const dd = Math.abs(v - x); if (dd < bd) { bd = dd; best = i; } });
    if (bd > 40) { leave(); return; }
    xh.setAttribute("x1", xs[best]); xh.setAttribute("x2", xs[best]); xh.setAttribute("visibility", "visible");
    tip.innerHTML = tipFn(best); tip.hidden = false;
    let tx = xs[best] / W * r.width + 12; if (tx + tip.offsetWidth > r.width) tx = xs[best] / W * r.width - tip.offsetWidth - 12;
    tip.style.left = Math.max(0, tx) + "px"; tip.style.top = "6px";
  };
  const leave = () => { tip.hidden = true; xh.setAttribute("visibility", "hidden"); };
  svg.addEventListener("mousemove", move); svg.addEventListener("mouseleave", leave);
  svg.addEventListener("touchmove", (e) => move(e.touches[0]), { passive: true });
  svg.addEventListener("touchstart", (e) => move(e.touches[0]), { passive: true });
}
const trow = (c, n, v) => `<div class="r"><span><span class="dot" style="background:${c};margin-right:6px"></span>${n}</span><b>${v}</b></div>`;
const legend = (id, items) => { $(id).innerHTML = items.map((it) => `<span><i class="${it.cls || ""}" style="background:var(${it.c});color:var(${it.c})"></i>${it.n}</span>`).join(""); };

function lineChart(host, o) {
  const W = host.clientWidth, H = host.clientHeight, ml = 6, mr = o.mr || 58, mt = 10, mb = 22, n = o.d.length;
  if (!n) { host.innerHTML = ""; return; }
  const ts = o.d.map((s) => pd(s).getTime()), t0 = ts[0], t1 = ts[n - 1] === t0 ? t0 + 1 : ts[n - 1];
  const X = (i) => ml + (ts[i] - t0) / (t1 - t0) * (W - ml - mr);
  const all = []; o.series.forEach((s) => s.y.forEach((v) => { if (v != null) all.push(v); })); (o.include || []).forEach((v) => all.push(v));
  let lo = Math.min(...all), hi = Math.max(...all); const pad = (hi - lo) * 0.08 || 1; lo -= pad; hi += pad;
  const Y = (v) => mt + (1 - (v - lo) / (hi - lo)) * (H - mt - mb);
  let g = grid(lo, hi, Y, W, ml, mr, o.yfmt, o.emph);
  if (o.ref != null && o.ref > lo && o.ref < hi) g += `<line x1="${ml}" x2="${W - mr}" y1="${Y(o.ref).toFixed(1)}" y2="${Y(o.ref).toFixed(1)}" stroke="${css("--axis")}" stroke-dasharray="4 3"/>`;
  let lastL = -1e9; const nl = Math.max(2, Math.min(6, Math.floor((W - ml - mr) / 90)));
  for (let k = 0; k < nl; k++) {
    const tt = t0 + k / (nl - 1) * (t1 - t0); let ii = 0, bd = 1e18; ts.forEach((v, j) => { if (Math.abs(v - tt) < bd) { bd = Math.abs(v - tt); ii = j; } });
    const xx = X(ii); if (xx - lastL < 60) continue; lastL = xx;
    g += txt(xx, H - 5, fdy(o.d[ii]), { anchor: k === 0 ? "start" : k === nl - 1 ? "end" : "middle" });
  }
  (o.marks || []).forEach((m) => { const i = o.d.indexOf(m.d); if (i > 0) g += vline(X(i), mt, H - mb, css("--axis"), "3 3", m.label, "end", mt + 10); });
  if (o.area != null) { const s0 = o.series[0]; g += `<path d="${areaOf(s0.y.map((v, i) => [X(i), Y(Math.max(v, o.area))]), s0.y.map((v, i) => [X(i), Y(o.area)]))}" fill="${css("--wash")}"/>`; }
  const labels = [];
  o.series.slice().reverse().forEach((s) => {
    g += `<path d="${pathOf(s.y.map((v, i) => v == null ? null : [X(i), Y(v)]))}" fill="none" stroke="${css(s.c)}" stroke-width="${s.w || 2}"${s.dash ? ' stroke-dasharray="5 4"' : ""} stroke-linejoin="round"/>`;
    let lv = null; for (let j = s.y.length - 1; j >= 0 && lv == null; j--) lv = s.y[j];
    if (lv != null && o.endLabel) labels.push({ y: Y(lv), v: lv, s });
  });
  labels.sort((a, b) => a.y - b.y); for (let m = 1; m < labels.length; m++) if (labels[m].y - labels[m - 1].y < 14) labels[m].y = labels[m - 1].y + 14;
  labels.forEach((l) => { g += `<circle cx="${W - mr + 40}" cy="${l.y.toFixed(1)}" r="3" fill="${css(l.s.c)}"/>` + txt(W - mr + 46, l.y + 4, o.endLabel(l.v), { mono: true, bold: true, color: "--ink" }); });
  mount(host, W, H, g, ts.map((_, i) => X(i)), (i) => `<div class="sub">${fdy(o.d[i])}</div>` + o.series.map((s) => trow(css(s.c), s.n, s.y[i] == null ? "-" : o.tip(s.y[i]))).join(""));
}

chart("mktChart", (host) => {
  const W = host.clientWidth, H = host.clientHeight, ml = 6, mr = 50, mt = 10, mb = 22;
  const C = D.curve, n = C.d.length, back = Math.min(60, n - 1), bNow = C.book[n - 1], uNow = C.universe[n - 1];
  const past = []; for (let i = n - 1 - back; i < n; i++) past.push({ k: i - (n - 1), b: (C.book[i] / bNow - 1) * 100, u: (C.universe[i] / uNow - 1) * 100, d: C.d[i] });
  const mu = F.market_cone.universe, fut = F.market_cone.book.map((q, j) => ({ k: q.h, b: q, u: mu[j] }));
  const ff = [{ k: 0, b: { p10: 0, p25: 0, p75: 0, p90: 0, mean: 0 }, u: { p25: 0, p75: 0, mean: 0 } }].concat(fut);
  const all = []; past.forEach((p) => all.push(p.b, p.u)); fut.forEach((f) => all.push(f.b.p10, f.b.p90, f.u.p25, f.u.p75));
  let lo = Math.min(...all), hi = Math.max(...all); const pad = (hi - lo) * 0.08; lo -= pad; hi += pad;
  const X = (k) => ml + (k + back) / (back + 20) * (W - ml - mr), Y = (v) => mt + (1 - (v - lo) / (hi - lo)) * (H - mt - mb);
  let g = grid(lo, hi, Y, W, ml, mr, (t) => (t > 0 ? "+" : "") + t + "%", 0);
  g += vline(X(0), mt, H - mb, css("--axis"), "3 3", "today", "start", mt + 10);
  g += `<path d="${areaOf(ff.map((f) => [X(f.k), Y(f.b.p90)]), ff.map((f) => [X(f.k), Y(f.b.p10)]))}" fill="${css("--wash")}"/>`;
  g += `<path d="${areaOf(ff.map((f) => [X(f.k), Y(f.u.p75)]), ff.map((f) => [X(f.k), Y(f.u.p25)]))}" fill="${css("--s-uni-wash")}"/>`;
  g += `<path d="${areaOf(ff.map((f) => [X(f.k), Y(f.b.p75)]), ff.map((f) => [X(f.k), Y(f.b.p25)]))}" fill="${css("--wash-2")}"/>`;
  g += `<path d="${pathOf(ff.map((f) => [X(f.k), Y(f.u.mean)]))}" fill="none" stroke="${css("--s-uni")}" stroke-width="2" stroke-dasharray="5 4"/>`;
  g += `<path d="${pathOf(ff.map((f) => [X(f.k), Y(f.b.mean)]))}" fill="none" stroke="${css("--accent")}" stroke-width="2" stroke-dasharray="5 4"/>`;
  g += `<path d="${pathOf(past.map((p) => [X(p.k), Y(p.u)]))}" fill="none" stroke="${css("--s-uni")}" stroke-width="2"/>`;
  g += `<path d="${pathOf(past.map((p) => [X(p.k), Y(p.b)]))}" fill="none" stroke="${css("--accent")}" stroke-width="2"/>`;
  g += txt(ml, H - 5, fdy(past[0].d)) + txt(W - mr, H - 5, "+4 weeks", { anchor: "end" });
  const pts = past.concat(fut);
  mount(host, W, H, g, pts.map((p) => X(p.k)), (i) => {
    const p = pts[i];
    if (p.k <= 0) return `<div class="sub">${fdy(p.d)}, vs today</div>` + trow(css("--accent"), "Model book", pct(p.b)) + trow(css("--s-uni"), "Universe", pct(p.u));
    return `<div class="sub">${p.k} sessions ahead, expected</div>` + trow(css("--accent"), "Model book", `${pct(p.b.mean)} (${pct(p.b.p25, 0)} to ${pct(p.b.p75, 0)})`) + trow(css("--s-uni"), "Universe", `${pct(p.u.mean)} (${pct(p.u.p25, 0)} to ${pct(p.u.p75, 0)})`);
  });
});

let picked = null;
function stockCtx(sym) {
  const b = BOOK[sym] || TOPMAP[sym], path = b && b.path ? b.path : [];
  const preds = D.tracker.rows.filter((r) => r.symbol === sym), pr = preds.length ? preds[0] : null, sess = D.sessions;
  return {
    path, pathDates: path.map((_, i) => sess[sess.length - path.length + i]), pred: pr,
    anchorDate: pr ? pr.base_date : D.asof, anchorPx: pr ? pr.base_px : (b ? b.close : lastPx(sym)),
    exitDate: pr ? pr.exp_exit_date : (BOOK[sym] ? BOOK[sym].exp_exit_date : iso(addSessions(pd(D.asof), remHold(0)))),
  };
}
chart("stkChart", (host) => {
  const sym = picked; if (!sym || !(BOOK[sym] || TOPMAP[sym])) { host.innerHTML = ""; return; }
  const c = stockCtx(sym), sess = D.sessions, todayIdx = sess.length - 1;
  const W = host.clientWidth, H = host.clientHeight, ml = 6, mr = 60, mt = 10, mb = 22;
  const from = Math.max(0, c.path.length - 45);
  const past = c.path.slice(from).map((v, i) => ({ d: c.pathDates[from + i], v, idx: sess.indexOf(c.pathDates[from + i]) })).filter((p) => p.idx >= 0 && p.v != null);
  let aIdx = sess.indexOf(c.anchorDate); if (aIdx < 0) aIdx = todayIdx;
  const hExit = Math.max(sessionsBetween(c.anchorDate, c.exitDate), 5);
  const hEnd = Math.min(Math.max(hExit + 5, todayIdx - aIdx + 10), F.stock_cone.length - 1);
  const xStart = past.length ? past[0].idx : aIdx, span = (aIdx + hEnd) - xStart || 1;
  const X = (idx) => ml + (idx - xStart) / span * (W - ml - mr);
  const fut = []; for (let h = 0; h <= hEnd; h++) { const q = cone(h); fut.push({ idx: aIdx + h, p10: c.anchorPx * (1 + q.p10 / 100), p25: c.anchorPx * (1 + q.p25 / 100), p75: c.anchorPx * (1 + q.p75 / 100), p90: c.anchorPx * (1 + q.p90 / 100), m: c.anchorPx * (1 + q.mean / 100) }); }
  const all = past.map((p) => p.v); fut.forEach((f) => all.push(f.p10, f.p90));
  let lo = Math.min(...all), hi = Math.max(...all); const pad = (hi - lo) * 0.06; lo -= pad; hi += pad;
  const Y = (v) => mt + (1 - (v - lo) / (hi - lo)) * (H - mt - mb);
  let g = grid(lo, hi, Y, W, ml, mr, (t) => t >= 100 ? Math.round(t).toLocaleString("en-IN") : t.toFixed(t >= 10 ? 1 : 2), null);
  g += `<path d="${areaOf(fut.map((f) => [X(f.idx), Y(f.p90)]), fut.map((f) => [X(f.idx), Y(f.p10)]))}" fill="${css("--wash")}"/>`;
  g += `<path d="${areaOf(fut.map((f) => [X(f.idx), Y(f.p75)]), fut.map((f) => [X(f.idx), Y(f.p25)]))}" fill="${css("--wash-2")}"/>`;
  g += `<path d="${pathOf(fut.map((f) => [X(f.idx), Y(f.m)]))}" fill="none" stroke="${css("--accent")}" stroke-width="2" stroke-dasharray="5 4"/>`;
  g += vline(X(aIdx + hExit), mt, H - mb, css("--accent"), "2 3", "expected sell " + fd(c.exitDate), "end", mt + 10);
  g += vline(X(todayIdx), mt, H - mb, css("--axis"), "3 3", "today", "start", H - mb - 4);
  const pp = past.map((p) => [X(p.idx), Y(p.v)]);
  g += `<path d="${pathOf(pp)}" fill="none" stroke="${css("--ink")}" stroke-width="2" stroke-linejoin="round"/>`;
  if (pp.length) { const lp = pp[pp.length - 1]; g += `<circle cx="${lp[0].toFixed(1)}" cy="${lp[1].toFixed(1)}" r="3.5" fill="${css("--ink")}" stroke="${css("--surface")}" stroke-width="2"/>`; }
  if (past.length) g += txt(ml, H - 5, fdy(past[0].d));
  const pts = past.concat(fut.filter((f) => f.idx > todayIdx).map((f) => ({ idx: f.idx, f })));
  mount(host, W, H, g, pts.map((p) => X(p.idx)), (i) => {
    const p = pts[i];
    if (!p.f) { const ff = fut.find((f) => f.idx === p.idx); return `<div class="sub">${fdy(p.d)}</div>` + trow(css("--ink"), "Price", px(p.v)) + (ff ? trow(css("--accent"), "Expected", `${px(ff.m)} (${px(ff.p25)} to ${px(ff.p75)})`) : ""); }
    return `<div class="sub">${fd(iso(addSessions(pd(D.asof), p.idx - todayIdx)), true)}, expected</div>` + trow(css("--accent"), "Middle", px(p.f.m)) + trow(css("--accent"), "Middle half", `${px(p.f.p25)} to ${px(p.f.p75)}`);
  });
  const qx = cone(hExit), rk = rankOf(sym);
  $("stkTitle").textContent = sym + " forecast";
  $("stkNote").innerHTML = `Rank ${rk || "out"}. Forecast from ${fdy(c.anchorDate)} at ${px(c.anchorPx)}: expected sell around <b>${fd(c.exitDate, true)}</b> near ${px(c.anchorPx * (1 + qx.mean / 100))} (${pct(qx.mean)}, middle half ${pct(qx.p25, 0)} to ${pct(qx.p75, 0)}). The rule sells on rank; the date is the typical holding time.${c.pred ? "" : " Enters the ledger when the rule buys it."}`;
});
function renderSlist(P) {
  const groups = [["Your buys", P.buys.map((b) => b.symbol)], ["Your holdings", P.keep.map((k) => k.symbol)], ["Model book", D.book.map((b) => b.symbol)]];
  const seen = {}; let h = "", first = null;
  groups.forEach((g) => {
    const items = g[1].filter((s) => { if (seen[s] || !(BOOK[s] || TOPMAP[s])) return false; seen[s] = 1; return true; });
    if (!items.length) return;
    h += `<div class="g">${g[0]}</div>` + items.map((s) => { first = first || s; const rk = rankOf(s); return `<button data-sym="${esc(s)}" type="button"><span>${esc(s)}</span><span class="sub">${rk ? "#" + rk : "out"}</span></button>`; }).join("");
  });
  $("slist").innerHTML = h;
  if (!picked || !seen[picked]) picked = first;
  markPick();
}
function markPick() { $("slist").querySelectorAll("[data-sym]").forEach((b) => b.setAttribute("aria-current", b.getAttribute("data-sym") === picked)); }
$("slist").addEventListener("click", (e) => { const b = e.target.closest("[data-sym]"); if (!b) return; picked = b.getAttribute("data-sym"); markPick(); redrawAll(); });
function showStock(s) { picked = s; show("forecast"); markPick(); }

chart("rollChart", (host) => { const r = A.us.roll13; lineChart(host, { d: r.map((x) => x[0]), series: [{ n: "Book minus universe", c: "--accent", y: r.map((x) => x[1]) }], yfmt: (t) => (t > 0 ? "+" : "") + t + "%", emph: 0, area: 0, tip: (v) => pct(v) }); });
chart("niftyChart", (host) => {
  const s = A.market.series;
  lineChart(host, { d: s.nifty_d, mr: 64, series: [{ n: "Nifty 50", c: "--s-nifty", y: s.nifty }, { n: "50-day average", c: "--s-uni", y: s.nifty50, dash: true, w: 1.5 }, { n: "200-day average", c: "--muted", y: s.nifty200, dash: true, w: 1.5 }], yfmt: (t) => Math.round(t).toLocaleString("en-IN"), tip: (v) => Math.round(v).toLocaleString("en-IN") });
});
chart("breadthChart", (host) => { const s = A.market.series; lineChart(host, { d: s.d, series: [{ n: "Above 200-day", c: "--accent", y: s.a200 }, { n: "Above 50-day", c: "--s-uni", y: s.a50, w: 1.5 }], include: [0, 100], ref: 50, yfmt: (t) => t + "%", tip: (v) => v.toFixed(0) + "%" }); });
chart("pathChart", (host) => { const p = A.preds.path52; lineChart(host, { d: p.d, series: [{ n: "Actual", c: "--ink", y: p.act }, { n: "Forecast", c: "--accent", y: p.exp, dash: true }], emph: 0, endLabel: (v) => pct(v, 0), yfmt: (t) => (t > 0 ? "+" : "") + t + "%", tip: (v) => pct(v) }); });

const SER = [{ k: "book", n: "Model book", c: "--accent" }, { k: "universe", n: "All liquid stocks", c: "--s-uni" }, { k: "nifty", n: "Nifty 50", c: "--s-nifty" }];
let range = LS.get("range", "1y");
$("ranges").innerHTML = [["3m", "3M"], ["ytd", "YTD"], ["1y", "1Y"], ["all", "All"]].map((r) => `<button data-r="${r[0]}" type="button" aria-pressed="${r[0] === range}">${r[1]}</button>`).join("");
$("ranges").onclick = (e) => {
  const b = e.target.closest("button"); if (!b) return; range = b.getAttribute("data-r"); LS.set("range", range);
  $("ranges").querySelectorAll("button").forEach((x) => x.setAttribute("aria-pressed", x === b)); redrawAll();
};
chart("perfChart", (host) => {
  const C = D.curve, last = pd(C.d[C.d.length - 1]); let cut = "0";
  if (range === "3m") { const x = new Date(last); x.setMonth(x.getMonth() - 3); cut = iso(x); }
  else if (range === "ytd") cut = last.getFullYear() + "-01-01";
  else if (range === "1y") { const y = new Date(last); y.setFullYear(y.getFullYear() - 1); cut = iso(y); }
  let i0 = 0; while (i0 < C.d.length - 1 && C.d[i0] < cut) i0++;
  lineChart(host, {
    d: C.d.slice(i0), mr: 104, emph: 100,
    series: SER.map((s) => { let base = null; for (let j = i0; base == null && j < C.d.length; j++) base = C[s.k][j]; return { n: s.n, c: s.c, y: C[s.k].slice(i0).map((v) => v == null || !base ? null : v / base * 100) }; }),
    marks: R.live_start > C.d[i0] ? [{ d: C.d.find((d) => d >= R.live_start), label: "live" }] : [],
    yfmt: (t) => t, endLabel: (v) => pct(v - 100), tip: (v) => pct(v - 100),
  });
});

// ---------- everything that depends only on the market payload ----------
const STATUS = { hold: ["--good", "Hold"], watch: ["--warn", "Watch"], risk: ["--bad", "At risk"], buy: ["--accent", "Buy"] };
const st = (s) => { const x = STATUS[s] || STATUS.hold; return `<span class="chip"><span class="dot" style="background:var(${x[0]})"></span>${x[1]}</span>`; };
const rankBar = (r) => { const m = R.sell_rank * 1.6, x = Math.min(r || m, m) / m * 100; return `<span class="rankbar"><span class="z" style="width:${R.sell_rank / m * 100}%"></span><i style="left:calc(${x}% - 2px)"></i></span>`; };
function renderStatic() {
  $("fresh").innerHTML = `<span class="dot" style="background:var(${D.stale_days <= 4 ? "--good" : "--bad"})"></span>Data to ${fd(D.asof, true)}`;
  $("stateChip").innerHTML = D.state === "rebalance" ? `<span class="dot" style="background:var(--accent)"></span>Review: orders ${fd(D.exec_date, true)}`
    : D.state === "stale" ? '<span class="dot" style="background:var(--bad)"></span>Data is stale'
    : `<span class="dot" style="background:var(--good)"></span>Hold. Next review ${fd(D.next_signal, true)}`;
  const staleNow = (Date.now() - pd(D.asof).getTime()) / 86400000 > 4.5;
  $("banner").hidden = !(D.state === "stale" || staleNow);
  if (!$("banner").hidden) { $("banner").className = "banner"; $("banner").textContent = `Newest NSE data is from ${fd(D.asof, true)}. Turn on the laptop so the morning update can run.`; }
  renderPulse();
  // analysis
  const m = A.market, u = A.us, w = A.preds.walk;
  const mini = (id, items) => { $(id).innerHTML = items.map((it) => `<div><b class="${it.k || ""}">${it.v}</b><span>${it.l}</span></div>`).join(""); };
  const prose = (id, arr) => { $(id).innerHTML = arr.map((s) => `<p>${esc(s)}</p>`).join(""); };
  mini("aDoingMini", [{ v: pct(u.w13.book), l: `book, 13 weeks (universe ${pct(u.w13.universe)})`, k: cls(u.w13.book) }, { v: `${u.w13.beat} of ${u.w13.weeks}`, l: "weeks ahead of the universe" }, { v: pct(u.w52.book), l: `book, 52 weeks (universe ${pct(u.w52.universe)})`, k: cls(u.w52.book) }, { v: `${u.open_up} of ${u.open_n}`, l: "open positions in profit" }]);
  prose("aDoing", A.text.doing);
  mini("aMktMini", [{ v: pct(m.nifty.m1), l: "Nifty 50, 1 month", k: cls(m.nifty.m1) }, { v: pct(m.universe.m1), l: "average liquid stock, 1 month", k: cls(m.universe.m1) }, { v: m.breadth.a200 + "%", l: `above 200-day average (${m.breadth.a200_1m}% a month ago)` }, { v: pct(m.nifty.vs_dma200), l: "Nifty vs its 200-day average", k: cls(m.nifty.vs_dma200) }]);
  prose("aMkt", A.text.market);
  mini("aPredMini", [{ v: w.in50 == null ? "-" : w.in50 + "%", l: "outcomes in middle half (target 50%)" }, { v: w.in80 == null ? "-" : w.in80 + "%", l: "in 8-in-10 range (target 80%)" }, { v: (w.stock_n || 0).toLocaleString("en-IN"), l: "stock-weeks tested since " + fdy(w.from) }, { v: String(D.tracker.summary.scored_1w || 0), l: "live forecasts scored so far" }]);
  prose("aPred", A.text.preds);
  $("yearTbl").innerHTML = '<thead><tr><th>Year</th><th class="n">Middle half</th><th class="n">8 in 10</th><th class="n">Stock exp / act</th><th class="n">Book exp / act</th></tr></thead><tbody>' +
    A.preds.years.map((y) => `<tr><td>${y.year}</td><td class="n">${y.in50}%</td><td class="n">${y.in80}%</td><td class="n">${pct(y.exp, 2)} / <span class="${cls(y.act - y.exp)}">${pct(y.act, 2)}</span></td><td class="n">${pct(y.b_exp, 2)} / <span class="${cls(y.b_act - y.b_exp)}">${pct(y.b_act, 2)}</span></td></tr>`).join("") + "</tbody>";
  legend("mktLegend", [{ c: "--accent", n: "Model book" }, { c: "--s-uni", n: "All liquid stocks" }, { c: "--wash-2", n: "middle half", cls: "band" }, { c: "--wash", n: "8 in 10", cls: "band" }]);
  const b20 = F.market_cone.book[F.market_cone.book.length - 1], u20 = F.market_cone.universe[F.market_cone.universe.length - 1];
  $("mktNote").textContent = `Next 4 weeks, expected: book ${pct(b20.mean)} (middle half ${pct(b20.p25)} to ${pct(b20.p75)}), all liquid stocks ${pct(u20.mean)}. The replay's typical 4-week move, not a read on news.`;
  legend("stkLegend", [{ c: "--ink", n: "Actual" }, { c: "--accent", n: "Expected" }, { c: "--wash-2", n: "middle half", cls: "band" }, { c: "--wash", n: "8 in 10", cls: "band" }]);
  legend("niftyLegend", [{ c: "--s-nifty", n: "Nifty 50" }, { c: "--s-uni", n: "50-day average", cls: "dash" }, { c: "--muted", n: "200-day average", cls: "dash" }]);
  legend("breadthLegend", [{ c: "--accent", n: "% above 200-day average" }, { c: "--s-uni", n: "% above 50-day average" }]);
  legend("pathLegend", [{ c: "--ink", n: "Actual book" }, { c: "--accent", n: "Forecast, set the week before", cls: "dash" }]);
  legend("perfLegend", SER);
  // ledger
  const S = D.tracker.summary || {}, tb = D.tracker.book || [];
  const done = tb.filter((r) => r.final && r.act != null);
  const expB = done.reduce((a, r) => a * (1 + r.exp / 100), 1), actB = done.reduce((a, r) => a * (1 + r.act / 100), 1);
  const pending = D.tracker.rows.filter((r) => !r.final_1w).length;
  const firstScore = tb.length ? fd(iso(addSessions(pd(tb[tb.length - 1].base_date), 5)), true) : "-";
  const k = (v, l, c, kl) => `<div class="kpi"><div class="l">${l}</div><div class="v ${kl || ""}">${v}</div><div class="c">${c}</div></div>`;
  $("calKpis").innerHTML = k(S.scored_1w || 0, "Live stock forecasts scored", pending + " still inside their first week") +
    k(S.in50_pct == null ? "-" : S.in50_pct + "%", "Landed in the middle half", "about 50% means well calibrated") +
    k(S.in80_pct == null ? "-" : S.in80_pct + "%", "Landed in the 8-in-10 range", "about 80% means well calibrated") +
    k(done.length ? pct((actB - 1) * 100) : "-", "Model book, actual", done.length ? `expected ${pct((expB - 1) * 100)} over ${done.length} weeks` : "first week is scored " + firstScore);
  badge("ledger", S.scored_1w ? S.scored_1w : "");
  $("bookPredTbl").innerHTML = '<thead><tr><th>Week from</th><th class="n">Expected</th><th class="n">Middle half</th><th class="n">Actual</th><th>Result</th></tr></thead><tbody>' +
    tb.map((r) => `<tr><td>${fdy(r.base_date)}</td><td class="n">${pct(r.exp, 2)}</td><td class="n">${pct(r.p25)} to ${pct(r.p75)}</td><td class="n ${cls(r.act)}">${pct(r.act, 2)}</td><td>${!r.final ? '<span class="sub">running</span>' : r.act >= r.p25 && r.act <= r.p75 ? "inside" : r.act > r.p75 ? "better" : "worse"}</td></tr>`).join("") + "</tbody>";
  $("predTbl").innerHTML = '<thead><tr><th>Stock</th><th>Made</th><th class="n">From</th><th class="n">1 week expected</th><th class="n">1 week actual</th><th class="n hide-m">By sell date</th><th class="n">Since forecast</th></tr></thead><tbody>' +
    (D.tracker.rows.length ? D.tracker.rows.map((r) => { const in50 = r.final_1w && r.act_1w >= r.p25_1w && r.act_1w <= r.p75_1w; return `<tr class="click" data-sym="${esc(r.symbol)}"><td class="sym">${esc(r.symbol)}</td><td>${fdy(r.base_date)}</td><td class="n">${px(r.base_px)}</td><td class="n">${pct(r.exp_1w)} <span class="sub">(${pct(r.p25_1w, 0)} to ${pct(r.p75_1w, 0)})</span></td><td class="n ${r.final_1w ? cls(r.act_1w) : ""}">${r.final_1w ? pct(r.act_1w) + (in50 ? " in" : " out") : `<span class="sub">${r.sessions} of 5 days</span>`}</td><td class="n hide-m">${pct(r.exp_exit_ret)} by ${fd(r.exp_exit_date)}</td><td class="n ${cls(r.act_now)}">${pct(r.act_now)}</td></tr>`; }).join("")
      : '<tr><td colspan="7" class="sub">No forecasts logged yet.</td></tr>') + "</tbody>";
  // model book
  const cnt = { hold: 0, watch: 0, risk: 0, buy: 0 }; D.book.forEach((b) => { cnt[b.status]++; });
  $("bookSub").textContent = `${D.book.length} stocks at equal weight: ${cnt.hold} hold, ${cnt.watch} watch (rank ${R.watch_rank + 1} to ${R.sell_rank}), ${cnt.risk} at risk (past ${R.sell_rank}). Tap a row for its forecast.`;
  badge("book", cnt.risk ? cnt.risk + " at risk" : "", cnt.risk > 0);
  $("bookTbl").innerHTML = '<thead><tr><th>Status</th><th>Stock</th><th>Rank</th><th class="n">Bought</th><th class="n">Last</th><th class="n">Return</th><th class="n hide-m">Expect sell</th><th class="n hide-m">Expected from here</th></tr></thead><tbody>' +
    D.book.map((b) => `<tr class="click" data-sym="${esc(b.symbol)}"><td>${st(b.status)}</td><td><span class="sym">${esc(b.symbol)}</span>${b.red_flag ? `<span class="flag">${esc(b.red_flag)}</span>` : ""}</td><td style="white-space:nowrap">${rankBar(b.rank)}<span class="mono">${b.rank || "out"}</span></td><td class="n">${fdy(b.entry_date)} @ ${px(b.entry_px)}</td><td class="n">${px(b.close)}</td><td class="n ${cls(b.ret_pct)}">${pct(b.ret_pct)}</td><td class="n hide-m">${fd(b.exp_exit_date)}</td><td class="n hide-m">${pct(b.exp_exit_ret)} <span class="sub">(${pct(b.exp_exit_p25, 0)} to ${pct(b.exp_exit_p75, 0)})</span></td></tr>`).join("") + "</tbody>";
  const pv = D.preview;
  $("preview").textContent = pv && (pv.sells.length || pv.buys.length)
    ? `If the week ended at the latest close: sell ${pv.sells.map((x) => x.symbol).join(", ") || "nothing"}; buy ${pv.buys.map((x) => x.symbol).join(", ") || "nothing"}. Preview only: the rule acts on Friday's close.`
    : "If the week ended at the latest close, the model book would not change.";
  // track record
  const P0 = D.perf, rp = P0.replay.book, ru = P0.replay.universe, lv = P0.live;
  $("kpis").innerHTML = k(pct(lv.book), "Live since " + fdy(lv.from), `Universe ${pct(lv.universe)}, Nifty ${pct(lv.nifty)}`, cls(lv.book)) +
    k(pct(P0.ytd.book), "This year", `Universe ${pct(P0.ytd.universe)}, Nifty ${pct(P0.ytd.nifty)}`, cls(P0.ytd.book)) +
    k(rp.cagr + "%", "Replay CAGR since " + fdy(P0.replay.from), `Universe ${ru.cagr}%, worst drawdown ${rp.maxdd}%`) +
    k(P0.trades.win_rate + "%", "Trades that made money", `${P0.trades.closed} closed, typical hold ${P0.trades.median_hold} sessions`);
  $("perfNote").textContent = `Rebased to 100 at the start of the range, after ${R.round_trip_pct}% per round trip. Before ${fdy(R.live_start)} it is a replay; after, live paper trading. Prices are split-adjusted.`;
  const rebs = [D.last_rebalance].concat(D.recent_rebalances);
  $("rebTbl").innerHTML = '<thead><tr><th>Signal</th><th>Orders</th><th>Sold</th><th>Bought</th></tr></thead><tbody>' + rebs.map((r) => `<tr><td>${fdy(r.signal_date)}${r.signal_date >= R.live_start ? ' <span class="dot" title="live" style="background:var(--accent)"></span>' : ""}</td><td>${r.fill_date ? fdy(r.fill_date) : "next session"}</td><td>${r.sells.map((x) => `<span class="mono ${cls(x.ret_pct)}">${esc(x.symbol)}${x.ret_pct != null ? " " + pct(x.ret_pct) : ""}</span>`).join(", ") || '<span class="sub">none</span>'}</td><td class="mono">${r.buys.map((x) => esc(x.symbol)).join(", ") || '<span class="sub">none</span>'}</td></tr>`).join("") + "</tbody>";
  $("closedTbl").innerHTML = '<thead><tr><th>Stock</th><th class="n">Bought</th><th class="n">Sold</th><th class="n">Days</th><th class="n">Net</th><th class="hide-m">Why sold</th></tr></thead><tbody>' + D.closed_recent.map((c) => `<tr><td class="sym">${esc(c.symbol)}</td><td class="n">${fdy(c.entry_date)} @ ${px(c.entry_px)}</td><td class="n">${fdy(c.exit_date)} @ ${px(c.exit_px)}</td><td class="n">${c.held_sessions}</td><td class="n ${cls(c.ret_pct)}">${pct(c.ret_pct)}</td><td class="hide-m sub">${esc(c.why)}</td></tr>`).join("") + "</tbody>";
  $("topTbl").innerHTML = '<thead><tr><th class="n">#</th><th>Stock</th><th class="n">Last</th><th class="n">1 week</th><th class="n">1 month</th><th class="n hide-m">12-1 mom</th><th>Book</th></tr></thead><tbody>' + D.top_now.map((r) => `<tr><td class="n">${r.rank}</td><td><span class="sym">${esc(r.symbol)}</span>${r.red_flag ? `<span class="flag">${esc(r.red_flag)}</span>` : ""}</td><td class="n">${px(r.close)}</td><td class="n ${cls(r.w1_pct)}">${pct(r.w1_pct)}</td><td class="n ${cls(r.m1_pct)}">${pct(r.m1_pct)}</td><td class="n hide-m">${pct(r.mom_12_1_pct, 0)}</td><td>${r.in_book ? '<span class="chip"><span class="dot" style="background:var(--accent)"></span>held</span>' : ""}</td></tr>`).join("") + "</tbody>";
  $("rules").innerHTML =
    `<h3>Score</h3><p>Two percentile ranks averaged across the ${D.eligible} eligible NSE stocks (median daily turnover at least Rs ${R.min_turnover_cr} cr, price 20 to 20,000, a year of history, no ETFs): 12-month momentum skipping the last month divided by 6-month volatility, and residual momentum, the part of the move the market does not explain.</p>` +
    `<h3>When</h3><p>Every week. The signal is Friday's close; orders go in the next session near that day's VWAP. New money can go in any day using the current ranks.</p>` +
    `<h3>Buy</h3><p>Only stocks ranked 1 to ${R.top}, to fill free slots. Equal money in each. A holding that grows past twice its share is trimmed back.</p>` +
    `<h3>Sell</h3><p>When a stock's rank falls past ${R.sell_rank}, or it drops out of the eligible universe. Every sell is replaced by a buy the same day, so the money stays invested.</p>` +
    `<h3>Holding time</h3><p>Typically ${P0.trades.median_hold} sessions; a quarter of trades last under ${P0.trades.p25_hold}. Holding for only days was tested and lost to costs.</p>` +
    `<h3>No stop losses, no market timing</h3><p>Every filter tested cut the return more than the drawdown. Expect a 25 to 30% drawdown at some point.</p>` +
    `<h3>Limits</h3><p>The replay covers one Indian bull market (2021 to 2026). In 2024 to 2026 the weekly version made about 26% a year against 34% for the monthly version; weekly was chosen to match a weeks-long holding horizon.</p>` +
    `<p class="sub">Personal research tool. Backtested results describe the past and are not a recommendation to buy or sell any security.</p>`;
}
$("predTbl").addEventListener("click", (e) => { const t = e.target.closest("tr[data-sym]"); if (t) showStock(t.getAttribute("data-sym")); });
$("bookTbl").addEventListener("click", (e) => { const t = e.target.closest("tr[data-sym]"); if (t) showStock(t.getAttribute("data-sym")); });

// ---------- settings: notifications, install, sync ----------
let installEvt = null;
window.addEventListener("beforeinstallprompt", (e) => { e.preventDefault(); installEvt = e; $("btnInstall").hidden = false; });
$("btnInstall").onclick = async () => { if (!installEvt) return; installEvt.prompt(); await installEvt.userChoice; installEvt = null; $("btnInstall").hidden = true; };
function b64ToU8(s) { const p = "=".repeat((4 - s.length % 4) % 4), b = atob((s + p).replace(/-/g, "+").replace(/_/g, "/")); return Uint8Array.from([...b].map((c) => c.charCodeAt(0))); }
async function pushSub() { if (!("serviceWorker" in navigator)) return null; const reg = await navigator.serviceWorker.ready; return reg.pushManager.getSubscription(); }
$("btnNotif").onclick = async () => {
  if (!("serviceWorker" in navigator) || !("PushManager" in window)) { toast("This browser cannot receive notifications. Open the app from Chrome."); return; }
  const perm = await Notification.requestPermission();
  if (perm !== "granted") { renderSettings(); toast("Notifications are blocked. Allow them in Android settings for Chrome or this app."); return; }
  try {
    const reg = await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToU8(cache.vapid_public || CFG.vapid) });
    await rpc("save_push_sub", { p_key: KEY, p_sub: sub.toJSON() });
    toast("Notifications are on"); sync();
  } catch (e) { toast("Could not turn on notifications: " + (e.message || e).toString().slice(0, 80)); }
  renderSettings();
};
$("btnTest").onclick = async () => {
  try {
    const r = await fetch(CFG.notify, { method: "POST", headers: { "Content-Type": "application/json", apikey: CFG.key }, body: JSON.stringify({ key: KEY, kind: "test" }) });
    const j = await r.json();
    toast(j.sent && j.sent.length ? `Sent to ${j.sent[0].delivered} device${j.sent[0].delivered === 1 ? "" : "s"}` : "Nothing sent: turn on notifications first");
    setTimeout(() => sync(), 1500);
  } catch (e) { toast("Could not reach the notification service."); }
};
["prefRemind", "prefDrift"].forEach((id) => { $(id).onchange = () => { twin.prefs = Object.assign({}, twin.prefs, { remind: $("prefRemind").checked, drift: $("prefDrift").checked }); persist(); }; });
$("btnSync").onclick = () => sync(true);
$("btnUnpair").onclick = async () => {
  const b = $("btnUnpair");
  if (!b.dataset.armed) { b.dataset.armed = "1"; b.textContent = "Tap again to unpair"; setTimeout(() => { delete b.dataset.armed; b.textContent = "Unpair this phone"; }, 3000); return; }
  try { const s = await pushSub(); if (s) { await rpc("remove_push_sub", { p_key: KEY, p_endpoint: s.endpoint }).catch(() => {}); await s.unsubscribe(); } } catch (e) {}
  ["key", "cache", "outbox", "lastSync"].forEach((k) => LS.del(k)); location.reload();
};
async function renderSettings() {
  const perm = "Notification" in window ? Notification.permission : "unsupported";
  let sub = null; try { sub = await pushSub(); } catch (e) {}
  $("notifStatus").innerHTML = perm === "granted" && sub ? `<span class="chip"><span class="dot" style="background:var(--good)"></span>On for this phone</span> &middot; ${cache.subs || 1} device${(cache.subs || 1) === 1 ? "" : "s"} registered`
    : perm === "denied" ? '<span class="chip"><span class="dot" style="background:var(--bad)"></span>Blocked. Allow notifications for this app in Android settings.</span>'
    : '<span class="chip"><span class="dot" style="background:var(--muted)"></span>Off</span>';
  $("btnNotif").textContent = perm === "granted" && sub ? "Re-register this phone" : "Turn on notifications";
  $("prefRemind").checked = twin.prefs ? twin.prefs.remind !== false : true;
  $("prefDrift").checked = twin.prefs ? twin.prefs.drift !== false : true;
  const n = cache.notifs || [];
  $("notifTbl").innerHTML = '<thead><tr><th>Sent</th><th>Message</th></tr></thead><tbody>' + (n.length ? n.map((x) => `<tr><td class="sub" style="white-space:nowrap">${fdy(String(x.sent_at).slice(0, 10))}</td><td><b>${esc(x.title)}</b><div class="sub">${esc(x.body)}</div></td></tr>`).join("") : '<tr><td colspan="2" class="sub">None yet.</td></tr>') + "</tbody>";
  const standalone = matchMedia("(display-mode: standalone)").matches;
  $("devKv").innerHTML = [
    ["Paired", KEY ? "yes" : "no"], ["Market data", D ? `close of ${fd(D.asof, true)}` : "none yet"], ["Received", cache.payload_at ? ago(cache.payload_at) : "-"],
    ["Last sync", ago(lastSync)], ["Waiting to upload", outbox.length ? outbox.length + " change" + (outbox.length > 1 ? "s" : "") : "nothing"],
    ["Installed", standalone ? "yes" : "no, open from Chrome menu > Install app"], ["App version", VERSION],
  ].map(([k, v]) => `<dt>${k}</dt><dd>${esc(v)}</dd>`).join("");
}
function renderSyncChip() {
  const c = $("syncChip"); if (!c) return;
  if (DEMO) { c.innerHTML = `<span class="syncdot" style="background:var(--warn)"></span>Demo: sample data`; return; }
  const col = syncing ? "--warn" : outbox.length ? "--warn" : online && lastSync ? "--good" : "--muted";
  c.innerHTML = `<span class="syncdot" style="background:var(${col})"></span>${syncing ? "Syncing" : outbox.length ? outbox.length + " to upload" : online ? "Synced " + ago(lastSync) : "Offline"}`;
}

// ---------- render ----------
function renderAll() {
  if (!D) return;
  const P = makePlan(D, twin);
  if (document.activeElement !== $("capital")) $("capital").value = twin.capital > 0 ? Math.round(twin.capital) : "";
  renderToday(P); renderOrders(P); renderEditor(); renderMine(); renderSlist(P); renderSettings(); renderSyncChip();
  badge("portfolio", twin.holdings.filter((h) => h.symbol).length || "");
  redrawAll();
}

async function boot() {
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
  if (cache.payload) setData(cache.payload);
  else if (!CFG.url) {
    try { const r = await fetch("demo-bundle.json"); if (r.ok) { const b = await r.json(); cache = Object.assign(cache, b); setData(b.payload); } } catch (e) {}
  }
  renderSlots();
  show(session ? "portfolio" : ((location.hash || "").slice(1) || LS.get("view", "today")));
  if (D) { renderStatic(); renderAll(); }
  if (CFG.url && !KEY) showPair();
  else sync();
  window.addEventListener("online", () => { online = true; sync(); });
  window.addEventListener("offline", () => { online = false; renderSyncChip(); });
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") sync(); });
  setInterval(() => { if (document.visibilityState === "visible") sync(); }, 10 * 60 * 1000);
  try { matchMedia("(prefers-color-scheme: dark)").addEventListener("change", redrawAll); } catch (e) {}
}
boot();
