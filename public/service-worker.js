self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

// HeartPet keeps private and frequently changing data out of browser caches.
self.addEventListener("fetch", () => {});
