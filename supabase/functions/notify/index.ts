// Sentinel push notifications.
//
//   kind "ingest"  called by the laptop after each upload of fresh data:
//                  review day -> "Weekly review: sell A, buy B" (once per review)
//                  other days -> a holding slipped past the exit rank (once per stock per week)
//   kind "monday"  pg_cron, Monday 09:05 IST: reminder if the review's orders are not marked placed
//                  (authenticated with a token generated inside the database)
//   kind "test"    from the phone's Settings, to prove delivery works
//
// Auth is custom (verify_jwt off): the laptop presents its ingest token, the
// phone its sync key; only SHA-256 hashes live in the database.
import { createClient } from "npm:@supabase/supabase-js@2";
import webpush from "npm:web-push@3.6.7";
import { makePlan } from "./plan.js";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type, authorization, apikey, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { ...CORS, "Content-Type": "application/json" } });

async function sha(s: string) {
  const h = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s || ""));
  return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const fd = (s: string) => { const [y, m, d] = s.split("-").map(Number); const t = new Date(Date.UTC(y, m - 1, d)); return `${DOW[t.getUTCDay()]} ${d} ${MON[m - 1]}`; };
const list = (a: string[], n = 6) => a.length <= n ? a.join(", ") : a.slice(0, n).join(", ") + ` +${a.length - n} more`;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  let body: any = {};
  try { body = await req.json(); } catch { return json({ error: "bad json" }, 400); }
  const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const { data: rows } = await sb.from("app_secrets").select("k,v");
  const S: Record<string, string> = Object.fromEntries((rows || []).map((r: any) => [r.k, r.v]));
  const kind = String(body.kind || "");
  const viaToken = body.token && (await sha(body.token)) === S.ingest_sha256;
  const viaKey = body.key && (await sha(body.key)) === S.sync_sha256;
  const viaCron = body.cron && S.cron_token && body.cron === S.cron_token;
  if (!(viaToken || viaCron || (viaKey && kind === "test"))) return json({ error: "unauthorised" }, 401);

  webpush.setVapidDetails(S.vapid_subject, S.vapid_public, S.vapid_private);
  const { data: p } = await sb.from("payloads").select("id,payload").order("id", { ascending: false }).limit(1).maybeSingle();
  const { data: st } = await sb.from("app_state").select("*").eq("id", 1).maybeSingle();
  const D: any = p?.payload;
  const state: any = st || { holdings: [], slots: 20 };
  const prefs = state.prefs || {};
  const msgs: { title: string; body: string; tag: string; dedupe: string; url: string }[] = [];

  if (kind === "test") {
    msgs.push({ title: "Sentinel notifications are on", body: "You will hear from Sentinel when the weekly review is in and when a holding slips toward a sell.", tag: "test", dedupe: "test:" + Date.now(), url: "./#settings" });
  } else if (D && D.stale_days <= 4) {
    const L = D.last_rebalance, R = D.rules;
    const plan = makePlan(D, state);
    const own = !plan.example;
    if ((kind === "ingest" || kind === "monday") && D.state === "rebalance") {
      const sells = own ? plan.sells.map((r: any) => r.symbol).concat(plan.trims.map((t: any) => t.symbol + " (part)")) : L.sells.map((s: any) => s.symbol);
      const buys = own ? plan.buys.map((b: any) => b.symbol) : L.buys.map((b: any) => b.symbol);
      const n = sells.length + buys.length;
      const when = D.exec_date === D.run_date ? "today" : fd(D.exec_date);
      if (kind === "ingest") {
        msgs.push({
          title: n ? `Weekly review: ${n} order${n > 1 ? "s" : ""} for ${when}` : "Weekly review: nothing to change",
          body: n ? [sells.length ? "Sell " + list(sells) : "", buys.length ? "Buy " + list(buys) : ""].filter(Boolean).join(". ") + ". Place them mid-session." : "Every holding is still inside rank " + R.sell_rank + ".",
          tag: "review", dedupe: "review:" + L.signal_date, url: "./#today",
        });
      } else if (prefs.remind !== false && state.orders_done_for !== L.signal_date && n) {
        msgs.push({ title: `Reminder: ${n} order${n > 1 ? "s" : ""} to place today`, body: [sells.length ? "Sell " + list(sells) : "", buys.length ? "Buy " + list(buys) : ""].filter(Boolean).join(". ") + ".", tag: "review", dedupe: "remind:" + L.signal_date, url: "./#today" });
      }
    } else if (kind === "ingest" && own && prefs.drift !== false) {
      const week = D.next_signal;
      const slipped = (state.holdings || []).filter((h: any) => h.symbol && h.qty > 0)
        .map((h: any) => ({ s: h.symbol, r: D.all_ranks[h.symbol] ? D.all_ranks[h.symbol][0] : null }))
        .filter((x: any) => x.r == null || x.r > R.sell_rank);
      for (const x of slipped) {
        msgs.push({
          title: `${x.s} slipped ${x.r ? "to rank " + x.r : "out of the ranking"}`,
          body: `Past the ${R.sell_rank} cutoff. If it stays there, the rule sells it at ${fd(D.next_signal)}'s review.`,
          tag: "drift-" + x.s, dedupe: `drift:${week}:${x.s}`, url: "./#today",
        });
      }
    }
  }

  const { data: subs } = await sb.from("push_subs").select("endpoint,sub");
  const sent: any[] = [];
  for (const m of msgs) {
    const { data: seen } = await sb.from("notif_log").select("id").eq("dedupe", m.dedupe).maybeSingle();
    if (seen) continue;
    let ok = 0;
    for (const s of subs || []) {
      try {
        await webpush.sendNotification(s.sub, JSON.stringify({ title: m.title, body: m.body, tag: m.tag, url: m.url }), { TTL: 60 * 60 * 20, urgency: "high" });
        ok++;
        await sb.from("push_subs").update({ last_ok: new Date().toISOString() }).eq("endpoint", s.endpoint);
      } catch (e: any) {
        if (e?.statusCode === 404 || e?.statusCode === 410) await sb.from("push_subs").delete().eq("endpoint", s.endpoint);
      }
    }
    await sb.from("notif_log").insert({ kind: kind === "test" ? "test" : m.tag.split("-")[0], dedupe: m.dedupe, title: m.title, body: m.body, delivered: ok });
    sent.push({ title: m.title, delivered: ok });
  }
  return json({ kind, payload: p?.id ?? null, subs: subs?.length ?? 0, sent });
});
