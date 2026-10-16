// Service worker of the installable app (PWA): keeps the viewer's own files (pages,
// scripts, styles, icons) so that it starts and works without a network connection.
// Drawings are opened from the user's disk and never pass through here.
//
// The file list and the version are filled in at build time (vite.config.ts). A new
// version is installed next to the old one and waits until the page asks it to take over
// (the 「更新」 button), so a running page never loses the scripts it still needs.

const sw = self as unknown as ServiceWorkerGlobalScope

/** files to keep, relative to this script (replaced at build time) */
const FILES = '__PRECACHE_FILES__' as unknown as string[]
/** hash of the files' contents (replaced at build time) */
const VERSION = '__PRECACHE_VERSION__'
const PREFIX = 't-shirt-viewer-'
const CACHE = PREFIX + VERSION

sw.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILES)))
})

sw.addEventListener('activate', (e) => {
  e.waitUntil(
    (async () => {
      // older versions, also under the app's former cache name (`<name>-viewer-<16 hex>`)
      for (const k of await caches.keys()) if (k !== CACHE && (k.startsWith(PREFIX) || /^t[\w-]*-viewer-[0-9a-f]{16}$/.test(k))) await caches.delete(k)
      await sw.clients.claim()
    })(),
  )
})

sw.addEventListener('message', (e) => {
  if (e.data === 'skip-waiting') void sw.skipWaiting()
})

sw.addEventListener('fetch', (e) => {
  const req = e.request
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return
  e.respondWith(respond(req))
})

async function respond(req: Request): Promise<Response> {
  const cache = await caches.open(CACHE)
  const url = new URL(req.url)
  if (req.mode === 'navigate') {
    // pages: the kept copy, whatever the query (?file=…); the app root is index.html
    const page = url.pathname.endsWith('/') ? new URL('index.html', url) : url
    const hit = (await cache.match(page, { ignoreSearch: true })) ?? (await cache.match(url, { ignoreSearch: true }))
    if (hit) return hit
  } else {
    const hit = await cache.match(req)
    if (hit) return hit
  }
  return fetch(req)
}
