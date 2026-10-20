// REQ-875 서비스 워커 — 앱 파일을 미리 받아 두어 현장(인터넷이 약한 곳)에서도 열리게 한다.
// 새 버전을 올리면 VERSION 이 바뀌어 새 워커가 「대기」 → 화면 띠 「새 버전이 있습니다 [새로 고침]」 → SKIP_WAITING → 다시 열림.
// 당첨 자료(data/)와 제미나이는 캐시하지 않는다(늘 네트워크, 자료는 앱이 IndexedDB 에 암호문으로 둔다).
const VERSION = '1.0.0';
const CACHE = `irms-wincheck-${VERSION}`;
const FILES = [
  './', './index.html', './app.css', './manifest.webmanifest',
  './js/app.js', './js/config.js', './js/crypto.js', './js/wins.js', './js/binding.js', './js/gemini.js', './js/db.js', './js/records.js', './js/zip.js',
  './vendor/jsQR.js', './icons/icon-192.png', './icons/icon-512.png', './icons/apple-touch-icon.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILES.map((f) => new Request(f, { cache: 'reload' })))));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k.startsWith('irms-wincheck-') && k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.includes('/data/')) return; // 당첨 자료는 늘 네트워크
  event.respondWith(
    caches.match(req, { ignoreSearch: true }).then((hit) => hit || fetch(req).catch(() => (req.mode === 'navigate' ? caches.match('./index.html') : Response.error()))),
  );
});
