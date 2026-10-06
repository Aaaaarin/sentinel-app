# Sentinel

Installable Android web app for a personal, rule-based NSE momentum strategy:
weekly orders computed from your real holdings, forecast ranges, and a ledger
of expected vs actual P&L. Open the site in Chrome on Android, then
**menu > Install app**.

- `index.html`, `styles.css`, `app.js`: the app (no build step)
- `plan.js`: the order engine, shared with the notification function
- `ocr.js`: on-device screenshot reader (tesseract.js) and broker-agnostic parser
- `sw.js`: offline cache, push notifications
- `supabase/`: database schema and the `notify` edge function

All data sits in a private Supabase database. Nothing in this repository is
secret: the database answers only callers holding the pairing key, which never
leaves the owner's devices.

Personal research tool. Backtested results describe the past and are not a
recommendation to buy or sell any security.
