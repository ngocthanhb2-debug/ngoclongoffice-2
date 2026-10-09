/* NL Office — Service Worker with Auto-Update Checking
 * Mục tiêu:
 *  1. Mở được app khi mất sóng (offline-first)
 *  2. Luôn ưu tiên bản mới nhất khi có mạng
 *  3. Tự động kiểm tra cập nhật định kỳ (mỗi 1 giờ hoặc khi reload)
 *  4. Thông báo user khi có bản mới
 *
 * Dữ liệu phiếu (nháp, đã lưu, ảnh, chữ ký) nằm trong IndexedDB, không bị ảnh hưởng.
 * Khi sửa logic, đổi số ở CACHE_NAME để xóa cache cũ.
 */

const CACHE_NAME = 'nl-office-v3';
const CDN_HOSTS = ['cdn.jsdelivr.net', 'cdnjs.cloudflare.com', 'fonts.googleapis.com', 'fonts.gstatic.com'];
const INDEX_URL = new URL('./khao_sat_dmt.html', self.registration.scope).href;
const NAV_TIMEOUT_MS = 4000;   // mạng yếu: quá 4 giây thì mở ngay bản đã lưu
const UPDATE_CHECK_INTERVAL = 3600000; // 1 giờ (ms)

// ============= INSTALL =============
self.addEventListener('install', function (event) {
    event.waitUntil((async function () {
        const cache = await caches.open(CACHE_NAME);
        const res = await fetch(INDEX_URL, { cache: 'reload' });
        if (!res.ok) throw new Error('Không tải được index.html (' + res.status + ')');
        await cache.put(INDEX_URL, res);
        await self.skipWaiting();
    })());
});

// ============= ACTIVATE - Dọn cache cũ =============
self.addEventListener('activate', function (event) {
    event.waitUntil((async function () {
        const names = await caches.keys();
        await Promise.all(
            names
                .filter(n => n.indexOf('nl-office-') === 0 && n !== CACHE_NAME)
                .map(n => caches.delete(n))
        );
        await self.clients.claim();
    })());
});

// ============= UTILITIES =============
function versionOf(res) {
    return res.headers.get('etag') || res.headers.get('last-modified') || res.headers.get('content-length') || '';
}

function delay(ms) {
    return new Promise(r => setTimeout(r, ms));
}

async function notifyClients(message) {
    const list = await self.clients.matchAll({ type: 'window' });
    list.forEach(c => c.postMessage(message));
}

// ============= NAVIGATION HANDLING =============
async function handleNavigation() {
    const cache = await caches.open(CACHE_NAME);
    const cached = await cache.match(INDEX_URL);
    const cachedVersion = cached ? versionOf(cached) : '';

    const net = fetch(INDEX_URL, { cache: 'no-cache' }).then(async res => {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const changed = !cached || versionOf(res) !== cachedVersion;
        await cache.put(INDEX_URL, res.clone());
        return { res, changed };
    });

    if (!cached) {
        try { return (await net).res; }
        catch (e) { return Response.error(); }
    }

    const first = await Promise.race([
        net.then(r => ({ net: r }), () => ({ failed: true })),
        delay(NAV_TIMEOUT_MS).then(() => ({ timeout: true }))
    ]);

    if (first.net) return first.net.res;
    if (first.timeout) {
        net.then(
            r => { if (r.changed) notifyClients({ type: 'NL_UPDATED' }); },
            () => {}
        );
    }
    return cached;
}

// ============= FETCH EVENT =============
self.addEventListener('fetch', event => {
    const req = event.request;
    if (req.method !== 'GET') return;
    const url = new URL(req.url);
    // Thư viện giao diện (Bootstrap, FontAwesome, font): lưu lại để mở được khi mất mạng
    if (CDN_HOSTS.indexOf(url.hostname) !== -1) {
        event.respondWith((async function () {
            const cache = await caches.open(CACHE_NAME);
            const hit = await cache.match(req);
            const net = fetch(req).then(res => { if (res && (res.ok || res.type === 'opaque')) cache.put(req, res.clone()); return res; }).catch(() => null);
            return hit || (await net) || Response.error();
        })());
        return;
    }
    if (req.mode !== 'navigate') return;
    if (url.origin !== self.location.origin) return;
    event.respondWith(handleNavigation());
});

// ============= AUTO-UPDATE CHECKING (Background) =============
async function checkForUpdates() {
    try {
        const cache = await caches.open(CACHE_NAME);
        const cached = await cache.match(INDEX_URL);
        const cachedVersion = cached ? versionOf(cached) : '';

        const res = await fetch(INDEX_URL, { cache: 'no-cache' });
        if (!res.ok) return;

        const newVersion = versionOf(res);
        const hasUpdate = cached && newVersion && newVersion !== cachedVersion;

        if (hasUpdate) {
            // Có cập nhật mới
            await cache.put(INDEX_URL, res.clone());
            await notifyClients({
                type: 'NL_UPDATE_AVAILABLE',
                version: newVersion,
                timestamp: new Date().toISOString()
            });
        }
    } catch (err) {
        // Bỏ qua lỗi kiểm tra (mạng yếu, etc.)
    }
}

// Kiểm tra update khi app khởi động
self.addEventListener('activate', () => {
    checkForUpdates();
});

// Kiểm tra update định kỳ khi app hoạt động (via postMessage từ client)
self.addEventListener('message', event => {
    if (event.data && event.data.type === 'SKIP_WAITING') {
        self.skipWaiting();
    }
    if (event.data && event.data.type === 'CHECK_UPDATE') {
        checkForUpdates();
    }
});
