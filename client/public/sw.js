// clipfarm's service worker: keeps the app shell so the installed app opens without a network.
// API answers are never cached (they must be current); built assets are cached as they load.
const CACHE = "clipfarm-shell-v2";
const SHELL = ["/", "/manifest.webmanifest", "/icons/icon.svg", "/icons/icon-192.png", "/icons/apple-touch-icon.png"];

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

// Live mode: the server says when a recording starts and when the first LIVE clip lands.
self.addEventListener("push", (event) => {
  let notice = {};
  try {
    notice = event.data ? event.data.json() : {};
  } catch {
    // Not ours: show the plain fallback below.
  }
  event.waitUntil(
    self.registration.showNotification(notice.title || "clipfarm", {
      body: notice.body || "",
      icon: "/icons/icon-192.png",
      badge: "/icons/icon-192.png",
      data: { url: typeof notice.url === "string" && notice.url.startsWith("/") ? notice.url : "/" },
      // A campaign clip to submit: "I'm busy" right on the notification (phones show the first two).
      actions: notice.snooze
        ? [
            { action: "snooze-1h", title: "Busy 1 h" },
            { action: "snooze-3h", title: "Busy 3 h" },
            { action: "snooze-today", title: "Busy today" },
          ]
        : [],
    }),
  );
});

// A tap opens the app where the notice points (the Inbox for a clip), in the window already open if there is one.
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  // "I'm busy": campaign posts due in that time move to after it. The app is not opened.
  if (event.action && event.action.startsWith("snooze-")) {
    event.waitUntil(
      fetch("/api/posting/snooze", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ for: event.action.slice("snooze-".length) }),
      }).catch(() => undefined),
    );
    return;
  }
  const url = new URL(event.notification.data?.url || "/", self.location.origin).href;
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((windows) => {
      const open = windows.find((w) => new URL(w.url).origin === self.location.origin);
      return open ? open.navigate(url).then((w) => (w ?? open).focus()) : self.clients.openWindow(url);
    }),
  );
});
