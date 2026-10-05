importScripts("/config.js", "/client/store.js", "/client/push.js");

const SHELL = "shell-v1";
const SHELL_FILES = [
  "/",
  "/app.js",
  "/i18n.js",
  "/config.js",
  "/client/store.js",
  "/client/communicator.js",
  "/client/push.js",
  "/styles.css",
  "/theme.css",
  "/manifest.webmanifest",
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

// Files shared into the app wait here until the page sends them on; see
// "transcribe" in app.js.
const SHARE_CACHE = "share-inbox";

// The few strings the worker itself shows, when no window is open to ask.
const STRINGS = {
  en: { new: (n) => `${n} new messages`, open: "Open ivrit.ai to read them." },
  he: { new: (n) => `${n} הודעות חדשות`, open: "פתחו את ivrit.ai כדי לקרוא." },
};

// Take over immediately rather than waiting for every tab to close. A stale
// service worker keeps handling pushes with old logic long after a deploy.
self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(SHELL).then((cache) => cache.addAll(SHELL_FILES)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(names.filter((n) => n !== SHELL && n !== SHARE_CACHE).map((n) => caches.delete(n)));
      await self.clients.claim();
    })()
  );
});

// The manifest's share target posts the shared files here. Each is kept, with
// its name, and the app opens on them.
async function receiveShare(request) {
  try {
    const form = await request.formData();
    const cache = await caches.open(SHARE_CACHE);
    const stamp = Date.now();
    const files = form.getAll("media").filter((f) => f instanceof File);
    await Promise.all(
      files.map((file, i) =>
        cache.put(
          `/__shared__/${stamp}-${i}`,
          new Response(file, {
            headers: { "content-type": file.type || "application/octet-stream", "x-name": encodeURIComponent(file.name || "") },
          })
        )
      )
    );
  } catch {
    // Land in the app regardless; the Transcribe tab shows what did arrive.
  }
  return Response.redirect("/#shared", 303);
}

// The shell only. API calls go to Communicator's origin and are never cached:
// the device's copy of messages lives in IndexedDB.
self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;
  if (event.request.method === "POST" && url.pathname === "/share-target") {
    event.respondWith(receiveShare(event.request));
    return;
  }
  if (event.request.method !== "GET") return;
  // Caching the worker itself is how a bad deploy becomes permanent.
  if (url.pathname === "/sw.js" || url.pathname.startsWith("/.well-known/")) return;

  event.respondWith(
    (async () => {
      const cache = await caches.open(SHELL);
      const cached = await cache.match(event.request, { ignoreSearch: true });
      // Stale-while-revalidate: the shell paints instantly offline, and the
      // next open has the new build.
      const fresh = fetch(event.request)
        .then((res) => {
          if (res.ok) cache.put(event.request, res.clone());
          return res;
        })
        .catch(() => cached);
      return cached ?? fresh;
    })()
  );
});

// Showing, storing, acking and opening pushed messages: Communicator's
// client, pointed at Communicator's server.
self.installCommunicatorPush({ apiBase: self.IVRIT_CONFIG.communicator, appName: "ivrit.ai", strings: STRINGS });
