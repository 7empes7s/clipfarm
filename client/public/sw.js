// clipfarm's service worker: keeps the app shell so the installed app opens without a network.
// API answers are never cached (they must be current); built assets are cached as they load.
const CACHE = "clipfarm-shell-v1";
const SHELL = ["/", "/manifest.webmanifest", "/icons/icon-192.png", "/icons/apple-touch-icon.png"];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method !== "GET" || url.origin !== self.location.origin || url.pathname.startsWith("/api/")) return;

  if (req.mode === "navigate") {
    // Network first, so a new version shows at once; the cached shell when offline.
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          void caches.open(CACHE).then((c) => c.put("/", copy));
          return res;
        })
        .catch(() => caches.match("/")),
    );
    return;
  }

  // Hashed build files and icons never change: cache first.
  event.respondWith(
    caches.match(req).then(
      (hit) =>
        hit ??
        fetch(req).then((res) => {
          if (res.ok) {
            const copy = res.clone();
            void caches.open(CACHE).then((c) => c.put(req, copy));
          }
          return res;
        }),
    ),
  );
});

// The daily digest: the server sends a sealed message, shown here as a notification.
self.addEventListener("push", (event) => {
  let message = { title: "clipfarm", body: "", url: "/#campaigns" };
  try {
    message = { ...message, ...event.data.json() };
  } catch {
    // An empty or unreadable push still shows something, as browsers require.
  }
  event.waitUntil(self.registration.showNotification(message.title, { body: message.body, icon: "/icons/icon-192.png", data: { url: message.url } }));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = event.notification.data?.url ?? "/#campaigns";
  event.waitUntil(
    self.clients.matchAll({ type: "window" }).then((open) => {
      const tab = open[0];
      return tab ? tab.navigate(url).then((c) => (c ?? tab).focus()) : self.clients.openWindow(url);
    }),
  );
});
