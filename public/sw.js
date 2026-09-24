const CACHE_NAME = "addressscribe-shell-v4";
const SHELL_PATHS = new Set(["/", "/index.html", "/app.js", "/styles.css", "/manifest.webmanifest", "/icon.svg", "/icon-192.png", "/icon-512.png"]);
const OFFLINE_DOCUMENT = "/index.html";

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll([...SHELL_PATHS])).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((key) => key.startsWith("addressscribe-shell-") && key !== CACHE_NAME).map((key) => caches.delete(key)))).then(() => self.clients.claim()));
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin || url.pathname.startsWith("/api/")) return;
  if (!SHELL_PATHS.has(url.pathname)) {
    if (event.request.mode === "navigate") {
      event.respondWith(fetch(event.request).catch(() => caches.match(OFFLINE_DOCUMENT)));
    }
    return;
  }
  event.respondWith(fetch(event.request).then((response) => {
    if (response.ok) {
      const copy = response.clone();
      event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.put(url.pathname, copy)).catch(() => undefined));
    }
    return response;
  }).catch(() => caches.match(url.pathname)));
});
