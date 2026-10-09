// Sentinel service worker: offline app shell, cached text-reader files, push.
const VERSION = "sentinel-1.1.2";
const SHELL = ["./", "index.html", "styles.css", "app.js", "plan.js", "ocr.js", "config.js", "manifest.webmanifest", "icons/icon-192.png", "icons/icon-512.png", "icons/badge-96.png"];
const RUNTIME = "sentinel-runtime";

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== VERSION && k !== RUNTIME).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  // database and notification calls always go to the network; the app keeps its own copy
  if (url.hostname.endsWith("supabase.co")) return;
  // app files: network first so updates land, cache when offline
  if (url.origin === self.location.origin) {
    e.respondWith(fetch(req.url, { cache: "no-cache", credentials: "same-origin" }).then((res) => {
      if (res.ok) { const copy = res.clone(); caches.open(VERSION).then((c) => c.put(req, copy)); }
      return res;
    }).catch(() => caches.match(req).then((m) => m || caches.match("index.html"))));
    return;
  }
  // fonts and the text reader (about 7 MB): cache first, they never change
  if (/(fonts\.googleapis\.com|fonts\.gstatic\.com|cdn\.jsdelivr\.net)$/.test(url.hostname)) {
    e.respondWith(caches.open(RUNTIME).then((c) => c.match(req).then((m) => m || fetch(req).then((res) => {
      if (res.ok || res.type === "opaque") c.put(req, res.clone());
      return res;
    }))));
  }
});

self.addEventListener("push", (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (err) { d = { title: "Sentinel", body: e.data ? e.data.text() : "" }; }
  e.waitUntil(self.registration.showNotification(d.title || "Sentinel", {
    body: d.body || "", tag: d.tag || "sentinel", renotify: true,
    icon: "icons/icon-192.png", badge: "icons/badge-96.png",
    data: { url: d.url || "./#today" }, vibrate: [80, 40, 80],
  }));
});

self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const target = new URL(e.notification.data && e.notification.data.url || "./#today", self.registration.scope).href;
  e.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
    for (const c of list) { if (c.url.startsWith(self.registration.scope)) { c.navigate(target); return c.focus(); } }
    return self.clients.openWindow(target);
  }));
});
