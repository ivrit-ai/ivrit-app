// The page, its code and styles, kept for when there is no network. Nothing
// else: no push (notifications come through the phone app), no share target
// (the site is not installed as an app).
const SHELL = "shell-v5";
const SHELL_FILES = [
  "/",
  "/app.js",
  "/i18n.js",
  "/config.js",
  "/client/store.js",
  "/client/communicator.js",
  "/styles.css",
  "/theme.css",
  "/theme.js",
  "/fonts/fonts.css",
  "/fonts/frank-ruhl-libre-hebrew.woff2",
  "/fonts/frank-ruhl-libre-latin.woff2",
  "/fonts/ibm-plex-sans-hebrew-hebrew-400.woff2",
  "/fonts/ibm-plex-sans-hebrew-latin-400.woff2",
  "/fonts/ibm-plex-sans-hebrew-hebrew-500.woff2",
  "/fonts/ibm-plex-sans-hebrew-latin-500.woff2",
  "/fonts/ibm-plex-sans-hebrew-hebrew-600.woff2",
  "/fonts/ibm-plex-sans-hebrew-latin-600.woff2",
  "/fonts/ibm-plex-mono-latin-500.woff2",
  "/icons/mark.svg",
  "/icons/icon-192.png",
  "/icons/badge-72.png",
];

// Take over immediately rather than waiting for every tab to close.
self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(SHELL).then((cache) => cache.addAll(SHELL_FILES)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      // Never dropped here: the lab's model weights (whisper-gpu-weights, 1.6 GB) and
      // the on-device transcription model (zipformer2-he-<revision>, 72 MB).
      const keep = (n) => n === SHELL || n === "whisper-gpu-weights" || n.startsWith("zipformer2-he-");
      await Promise.all(names.filter((n) => !keep(n)).map((n) => caches.delete(n)));
      // A browser push subscription left from before: notifications no longer come
      // this way (the page also removes the device at Communicator).
      await (await self.registration.pushManager?.getSubscription())?.unsubscribe().catch(() => {});
      await self.clients.claim();
    })()
  );
});

// The shell only. API calls go to Communicator's origin and are never cached:
// the device's copy of messages lives in IndexedDB.
self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;
  if (event.request.method !== "GET") return;
  // Caching the worker itself is how a bad deploy becomes permanent.
  if (url.pathname === "/sw.js" || url.pathname.startsWith("/.well-known/") || url.pathname.startsWith("/lab")) return;

  // Fonts and images never change in place (a new one gets a new name): from
  // the cache when there. Everything else - the page, its code and styles - from
  // the network whenever there is one, so a fix reaches the app on the next
  // open, not the one after; the stored copy is only for when offline.
  const lasting = /\.(woff2|png|svg)$/.test(url.pathname);
  event.respondWith(
    (async () => {
      const cache = await caches.open(SHELL);
      const cached = await cache.match(event.request, { ignoreSearch: true });
      if (lasting && cached) return cached;
      try {
        const res = await fetch(event.request);
        if (res.ok) cache.put(event.request, res.clone());
        return res;
      } catch (err) {
        if (cached) return cached;
        throw err;
      }
    })()
  );
});
