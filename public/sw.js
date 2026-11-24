/* Service worker: faqat ilova qobig'ini keshlaydi. Savollar (IndexedDB) va rasmlar (Cache Storage) ilova kodida saqlanadi. */
const VERSION = '__BUILD_VERSION__'
const SHELL_CACHE = `pdd-shell-${VERSION}`
const SHELL_FILES = __SHELL_FILES__

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(SHELL_CACHE)
      .then((cache) => cache.addAll(SHELL_FILES))
      .then(() => self.skipWaiting())
  )
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => k.startsWith('pdd-shell-') && k !== SHELL_CACHE).map((k) => caches.delete(k)))
      )
      .then(() => self.clients.claim())
  )
})

self.addEventListener('fetch', (event) => {
  const request = event.request
  if (request.method !== 'GET') return
  const url = new URL(request.url)

  if (url.origin !== self.location.origin) return // Supabase API va boshqalar: tarmoqqa

  // Savol snapshot'i va rasmlar: service worker aralashmaydi.
  // - /data/version.json har safar tarmoqdan olinadi (aks holda yangi nashr hech qachon ko'rinmaydi);
  // - snapshot IndexedDB'da, rasmlar esa ilova ichidagi Cache Storage'da ('pdd-images-v1') saqlanadi.
  if (url.pathname.startsWith('/data/') || url.pathname.startsWith('/basa_img/')) return

  // Sahifa navigatsiyasi: tarmoq birinchi, oflaynda keshdagi index.html
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request).catch(() => caches.match('./index.html').then((r) => r || caches.match('./')))
    )
    return
  }

  // Statik fayllar: kesh birinchi
  event.respondWith(
    caches.match(request).then(
      (hit) =>
        hit ||
        fetch(request).then((response) => {
          if (response.ok) {
            const copy = response.clone()
            caches.open(SHELL_CACHE).then((cache) => cache.put(request, copy))
          }
          return response
        })
    )
  )
})
