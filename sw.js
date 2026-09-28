/* NL Office — Service Worker
 * Mục tiêu: mở được app khi mất sóng, và luôn ưu tiên bản mới nhất khi có mạng.
 * Chỉ lưu file trang (index.html). Dữ liệu phiếu (nháp, đã lưu, ảnh, chữ ký) nằm trong IndexedDB của app, không đụng tới ở đây.
 * Khi sửa logic trong file này, đổi số ở CACHE_NAME để máy cũ dọn bản lưu cũ. */
const CACHE_NAME = 'nl-office-v1';
const INDEX_URL = new URL('./index.html', self.registration.scope).href;
const NAV_TIMEOUT_MS = 4000;   // mạng yếu: quá 4 giây thì mở ngay bản đã lưu, tải bản mới ở nền

self.addEventListener('install', function (event) {
    event.waitUntil((async function () {
        const cache = await caches.open(CACHE_NAME);
        const res = await fetch(INDEX_URL, { cache: 'reload' });
        if (!res.ok) throw new Error('Không tải được index.html (' + res.status + ')');
        await cache.put(INDEX_URL, res);
        await self.skipWaiting();
    })());
});

self.addEventListener('activate', function (event) {
    event.waitUntil((async function () {
        const names = await caches.keys();
        await Promise.all(names.filter(function (n) { return n.indexOf('nl-office-') === 0 && n !== CACHE_NAME; })
            .map(function (n) { return caches.delete(n); }));
        await self.clients.claim();
    })());
});

function versionOf(res) {
    return res.headers.get('etag') || res.headers.get('last-modified') || res.headers.get('content-length') || '';
}
function delay(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

async function notifyClients() {
    const list = await self.clients.matchAll({ type: 'window' });
    list.forEach(function (c) { c.postMessage({ type: 'NL_UPDATED' }); });
}

async function handleNavigation() {
    const cache = await caches.open(CACHE_NAME);
    const cached = await cache.match(INDEX_URL);
    const cachedVersion = cached ? versionOf(cached) : '';

    const net = fetch(INDEX_URL, { cache: 'no-cache' }).then(async function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const changed = !cached || versionOf(res) !== cachedVersion;
        await cache.put(INDEX_URL, res.clone());
        return { res: res, changed: changed };
    });

    if (!cached) {                       // chưa có bản lưu (hiếm): buộc phải chờ mạng
        try { return (await net).res; } catch (e) { return Response.error(); }
    }
    const first = await Promise.race([
        net.then(function (r) { return { net: r }; }, function () { return { failed: true }; }),
        delay(NAV_TIMEOUT_MS).then(function () { return { timeout: true }; })
    ]);
    if (first.net) return first.net.res;            // có mạng và đủ nhanh: dùng bản mới nhất
    if (first.timeout) {                            // mạng chậm: mở bản đã lưu, báo khi bản mới về tới
        net.then(function (r) { if (r.changed) notifyClients(); }, function () { /* mất mạng: bỏ qua */ });
    }
    return cached;                                  // mất mạng hoặc lỗi máy chủ
}

self.addEventListener('fetch', function (event) {
    const req = event.request;
    if (req.method !== 'GET' || req.mode !== 'navigate') return;
    const url = new URL(req.url);
    if (url.origin !== self.location.origin) return;
    event.respondWith(handleNavigation());
});
