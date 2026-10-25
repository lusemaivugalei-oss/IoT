// The dashboard is no longer an installable app. This worker only removes
// caches left by earlier versions and then unregisters itself.
self.addEventListener("install", () => self.skipWaiting());

self.addEventListener("activate", event => {
    event.waitUntil((async () => {
        const keys = await caches.keys();
        await Promise.all(keys.map(key => caches.delete(key)));
        await self.registration.unregister();
    })());
});
