// Broker screenshot -> holdings, entirely on the phone.
//
// Text recognition is tesseract.js (loaded on first use, then cached by the
// service worker). The parser is broker-agnostic: it finds the lines that name
// a stock (a trading symbol as Kite shows it, or a company name as Groww
// shows it), then hands every labelled number (Qty, Avg, LTP, Invested,
// Current) to the stock line nearest to it on screen. Kite puts the Qty/Avg
// line above the symbol and Groww puts it below, so "nearest" handles both.
// Anything it could not read is flagged for the user to fix by hand.

const TESS = "https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/";
const CORE = "https://cdn.jsdelivr.net/npm/tesseract.js-core@5.1.1";
const LANG = "https://cdn.jsdelivr.net/npm/@tesseract.js-data/eng@1.0.0/4.0.0_best_int";

const STOP = new Set(["QTY", "AVG", "LTP", "NSE", "BSE", "EQ", "BE", "INVESTED", "CURRENT", "PNL", "TOTAL", "DAY", "DAYS",
  "RETURNS", "RETURN", "HOLDINGS", "HOLDING", "ALL", "SORT", "FILTER", "BUY", "SELL", "EXIT", "ADD", "GTT", "CMP", "MTF",
  "PLEDGE", "VALUE", "PRICE", "SHARES", "SHARE", "STOCKS", "STOCK", "MARKET", "IPO", "SIP", "INR", "RS", "LTD", "LIMITED",
  "INDIA", "THE", "AND", "OF", "TODAY", "OVERALL", "PROFIT", "LOSS", "GAIN", "CHG", "NET", "POSITIONS", "ORDERS", "FUNDS"]);

let workerPromise = null;

function loadScript(src) {
  return new Promise((resolve, reject) => {
    if (window.Tesseract) return resolve();
    const s = document.createElement("script");
    s.src = src; s.onload = resolve; s.onerror = () => reject(new Error("Could not load the text reader. Check the internet connection once; after that it works offline."));
    document.head.appendChild(s);
  });
}

async function getWorker(onProgress) {
  if (!workerPromise) {
    workerPromise = (async () => {
      await loadScript(TESS + "tesseract.min.js");
      return window.Tesseract.createWorker("eng", 1, {
        workerPath: TESS + "worker.min.js", corePath: CORE, langPath: LANG,
        logger: (m) => onProgress && onProgress(m),
      });
    })();
    workerPromise.catch(() => { workerPromise = null; });
  }
  return workerPromise;
}

// grayscale, invert dark-mode screenshots, upscale narrow ones: tesseract reads
// dark text on a light background at ~30px x-height best
async function prep(file) {
  const bmp = await createImageBitmap(file);
  const scale = bmp.width < 900 ? 900 / bmp.width : 1;
  const c = document.createElement("canvas");
  c.width = Math.round(bmp.width * scale); c.height = Math.round(bmp.height * scale);
  const g = c.getContext("2d");
  g.drawImage(bmp, 0, 0, c.width, c.height);
  const img = g.getImageData(0, 0, c.width, c.height), d = img.data;
  let sum = 0;
  for (let i = 0; i < d.length; i += 4) { const y = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]; d[i] = d[i + 1] = d[i + 2] = y; sum += y; }
  if (sum / (d.length / 4) < 110) for (let i = 0; i < d.length; i += 4) { d[i] = d[i + 1] = d[i + 2] = 255 - d[i]; }
  g.putImageData(img, 0, 0);
  return c;
}

export async function readScreenshots(files, ctx, onStatus) {
  const worker = await getWorker((m) => {
    if (m.status && onStatus) onStatus(m.status === "recognizing text" ? "Reading text" : m.status.replace(/^./, (c) => c.toUpperCase()), m.progress || 0);
  });
  let lines = [], offset = 0;
  for (let i = 0; i < files.length; i++) {
    onStatus && onStatus(`Screenshot ${i + 1} of ${files.length}`, 0);
    const canvas = await prep(files[i]);
    const { data } = await worker.recognize(canvas);
    (data.lines || []).forEach((l) => lines.push({
      text: fixLine(l), raw: l.text.trim(), y: offset + (l.bbox.y0 + l.bbox.y1) / 2, h: l.bbox.y1 - l.bbox.y0, conf: l.confidence,
    }));
    offset += canvas.height + 400; // keep screenshots apart so numbers never cross over
  }
  return parseLines(lines, ctx);
}

// The rupee sign is the reader's weak spot: it comes back as a stray "3", "2",
// "%" or "¥" glued to the amount ("₹250.00" -> "3250.00"), always with low word
// confidence. Clean amounts read at 90+. So a low-confidence amount loses that
// first character.
export function fixWord(text, conf) {
  const m = String(text).match(/^([+\-−]?)(.)([0-9][0-9,]*(?:\.[0-9]+)?)(.*)$/);
  if (!m || conf >= 60) return text;
  if (/[23%¥₹?€F7]/.test(m[2])) return m[1] + m[3] + m[4];
  return text;
}
export function fixLine(l) {
  if (!l.words || !l.words.length) return String(l.text || "").trim();
  return l.words.map((w) => fixWord(w.text, w.confidence)).join(" ").trim();
}

// ---------------------------------------------------------------- parser --
const NUM = "([0-9][0-9,]*(?:\\.[0-9]+)?)";
const SEP = "\\s*[.:]?\\s*(?:₹|rs\\.?|inr)?\\s*";
const RX = {
  qty: [new RegExp("\\b(?:qty|quantity|qnty|shares?)" + SEP + "([0-9][0-9,]*)", "i"), /\b([0-9][0-9,]*)\s*(?:shares?|qty)\b/i],
  avg: [new RegExp("\\bavg\\.?\\s*(?:price|cost|buy\\s*price)?" + SEP + NUM, "i"), new RegExp("\\b(?:buy\\s*price|average)" + SEP + NUM, "i")],
  ltp: [new RegExp("\\b(?:ltp|cmp|last\\s*price|mkt\\.?\\s*price|market\\s*price|current\\s*price)" + SEP + NUM, "i")],
  invested: [new RegExp("\\b(?:invested|investment|inv\\.?\\s*amt)" + SEP + NUM, "i")],
  current: [new RegExp("\\b(?:current\\s*value|cur\\.?\\s*val(?:ue)?|present\\s*value|market\\s*value|current)" + SEP + NUM, "i")],
};

export function num(s) {
  if (s == null) return null;
  const v = parseFloat(String(s).replace(/,/g, ""));
  return isFinite(v) ? v : null;
}

export function nameKey(s) {
  return String(s).toLowerCase()
    .replace(/[^a-z0-9& ]+/g, " ")
    .replace(/\b(limited|ltd|pvt|private|the|co|company|corporation|corp|inc)\b/g, " ")
    .replace(/\s+/g, " ").trim();
}

export function buildIndex(names, ranks) {
  const symbols = new Set([...Object.keys(names || {}), ...Object.keys(ranks || {})]);
  const keys = Object.entries(names || {}).map(([sym, n]) => ({ sym, key: nameKey(n) })).filter((x) => x.key.length >= 3);
  return { symbols, keys };
}

function matchLine(text, index) {
  const clean = text.replace(/[₹]/g, " ");
  // 1) a trading symbol as its own word (Kite, Upstox, Angel)
  const toks = clean.split(/[\s•·|,()]+/).filter(Boolean);
  for (const t of toks) {
    const u = t.toUpperCase().replace(/[^A-Z0-9&-]/g, "");
    if (u.length >= 2 && u === t.replace(/[^A-Za-z0-9&-]/g, "") && /[A-Z]/.test(u) && !STOP.has(u) && index.symbols.has(u) && t === t.toUpperCase()) {
      return { sym: u, how: "symbol" };
    }
  }
  // 2) a company name (Groww, Paytm Money, INDmoney); names get cut with "..."
  const letters = clean.replace(/[0-9.,%+\-₹]+/g, " ").replace(/\.\.\.|…/g, " ");
  const k = nameKey(letters);
  if (k.length < 5) return null;
  let best = null;
  for (const x of index.keys) {
    if (x.key === k || (k.length >= 8 && x.key.startsWith(k)) || (x.key.length >= 6 && k.startsWith(x.key + " ")) || (x.key.length >= 6 && k === x.key)) {
      if (!best || x.key.length > best.key.length) best = x;
    }
  }
  return best ? { sym: best.sym, how: "name" } : null;
}

function fields(text, onAnchor) {
  const t = text.replace(/[−–]/g, "-");
  const out = {};
  // a signed amount not followed by "%" is P&L ("+18,030.00 (24.04%)")
  const pm = t.match(/(^|[\s(])([+-])\s*(?:₹|rs\.?)?\s*([0-9][0-9,]*(?:\.[0-9]+)?)(?![0-9.,]*\s*%)/i);
  if (pm) out.pnl = (pm[2] === "-" ? -1 : 1) * num(pm[3]);
  // on the stock's own line, an unsigned amount with paise is its current value (Groww)
  if (onAnchor) {
    const cm = t.match(/(?:^|\s)(?:₹|rs\.?)?\s*([0-9][0-9,]*\.[0-9]{2})(?![0-9.,]*\s*%)/i);
    if (cm && !/[+-]\s*$/.test(t.slice(0, t.indexOf(cm[1])))) out.current = num(cm[1]);
  }
  for (const [f, list] of Object.entries(RX)) {
    for (const rx of list) { const m = t.match(rx); if (m) { out[f] = num(m[1]); break; } }
  }
  // "Current" alone must not swallow "current price"
  if (out.current != null && /current\s*price/i.test(t)) delete out.current;
  return out;
}

export function parseLines(lines, ctx) {
  const index = ctx.index || buildIndex(ctx.names, ctx.ranks);
  const anchors = [];
  lines.forEach((l, i) => {
    const m = matchLine(l.text, index);
    if (m) anchors.push({ ...m, y: l.y, i, conf: l.conf, f: {} });
  });
  // the same stock on two adjacent lines (name + symbol) is one holding
  const dedup = [];
  anchors.forEach((a) => {
    const prev = dedup[dedup.length - 1];
    if (prev && prev.sym === a.sym && Math.abs(prev.y - a.y) < 80) return;
    dedup.push(a);
  });
  const anchorLines = new Set(dedup.map((a) => a.i));
  // a number belongs to a stock only if it sits inside that stock's card:
  // closer than ~2/3 of the usual spacing between cards
  const gaps = dedup.slice(1).map((a, k) => Math.abs(a.y - dedup[k].y)).filter((g) => g > 0).sort((x, y) => x - y);
  const reach = gaps.length ? 0.65 * gaps[Math.floor(gaps.length / 2)] : 160;
  const SUMMARY = /\b(total|overall|portfolio|holdings?\s*\(|day'?s?\s*p|today'?s?\s*p|current\s*value\s*$)/i;
  lines.forEach((l, i) => {
    if (!anchorLines.has(i) && SUMMARY.test(l.text)) return;
    const f = fields(l.text, anchorLines.has(i));
    if (!Object.keys(f).length || !dedup.length) return;
    let best = dedup[0], bd = Infinity;
    dedup.forEach((a) => { const d = Math.abs(a.y - l.y); if (d < bd) { bd = d; best = a; } });
    if (bd > reach) return;
    for (const [k, v] of Object.entries(f)) if (best.f[k] == null && v != null) best.f[k] = v;
  });
  let totalPnl = null;
  lines.forEach((l) => {
    const m = l.text.replace(/[−–]/g, "-").match(/(?:total\s*(?:p\s*&\s*l|returns?|profit|gain)|overall\s*(?:p\s*&\s*l|gain|returns?)|unrealised\s*p\s*&\s*l)\D{0,8}?([+-]?)\s*(?:₹|rs\.?)?\s*([0-9][0-9,]*(?:\.[0-9]+)?)/i);
    if (m && totalPnl == null) totalPnl = (m[1] === "-" ? -1 : 1) * num(m[2]);
  });
  const merged = new Map();
  dedup.forEach((a) => {
    const f = a.f;
    let qty = f.qty, avg = f.avg, ltp = f.ltp, doubt = false;
    if (qty == null && f.invested && avg) qty = Math.round(f.invested / avg);
    if (avg == null && f.invested && qty) avg = +(f.invested / qty).toFixed(2);
    if (ltp == null && f.current && qty) ltp = +(f.current / qty).toFixed(2);
    if (ltp == null && f.invested != null && f.pnl != null && qty) ltp = +((f.invested + f.pnl) / qty).toFixed(2);
    // cross-check: current value minus P&L is what was paid
    const paid = f.current != null && f.pnl != null ? f.current - f.pnl : f.invested;
    if (paid && qty) {
      const implied = +(paid / qty).toFixed(2);
      if (avg == null || Math.abs(avg - implied) / implied > 0.02) { doubt = avg != null; avg = implied; }
    }
    const last = ctx.ranks && ctx.ranks[a.sym] ? ctx.ranks[a.sym][1] : null;
    const ltpOff = ltp != null && last ? Math.abs(ltp / last - 1) > 0.25 : false;
    const row = merged.get(a.sym) || { symbol: a.sym, qty: null, avg: null, ltp: null, check: {} };
    row.qty = row.qty ?? qty ?? null; row.avg = row.avg ?? avg ?? null; row.ltp = row.ltp ?? ltp ?? null;
    row.check = { symbol: a.conf < 70, qty: row.qty == null, avg: row.avg == null || doubt, ltp: ltpOff };
    merged.set(a.sym, row);
  });
  return { holdings: [...merged.values()], total_pnl: totalPnl, lines: lines.map((l) => l.text) };
}
