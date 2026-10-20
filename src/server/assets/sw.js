// openpost service worker (docs/09_phase5_spec.md §2.5). Assets only - no authenticated HTML is
// ever written to a cache: openpost's entire pitch is that recipient data never leaves the
// operator's control, and a phone is a lost-and-found item. No build step; this file is served
// verbatim from /dashboard/assets/sw.js (the public, CSP-header-free asset scope) with
// Service-Worker-Allowed: /dashboard/.
'use strict';

// Finding #11 (phase5.1): `__OPENPOST_VERSION__` is substituted with the real release version when
// the asset map is built (`src/server/assets/index.ts`, at server-startup time - no bundler, no
// build step) - without a version-derived cache name every previous release's precached entries
// lived forever (the `activate` handler below only ever deletes a cache whose NAME differs; it
// never diffs the keys inside a same-named cache), so an upgrade never evicted a renamed/removed
// asset from a phone that had it installed.
var CACHE_VERSION = 'openpost-static-v__OPENPOST_VERSION__';
var PRECACHE = [
  '/dashboard/assets/app.css',
  '/dashboard/assets/app.js',
  '/dashboard/assets/compose.js',
  '/dashboard/assets/htmx.min.js',
  '/dashboard/assets/favicon.svg',
  '/dashboard/assets/icon-192.png',
  '/dashboard/offline.html',
];

self.addEventListener('install', function (event) {
  event.waitUntil(
    caches.open(CACHE_VERSION).then(function (cache) {
      // A new Cache Storage version alone does not invalidate the browser's HTTP cache.
      // Bare asset URLs have long max-age; force revalidation when installing a release.
      return cache.addAll(PRECACHE.map(function (path) { return new Request(path, { cache: 'reload' }); }));
    }).then(function () {
      return self.skipWaiting();
    }),
  );
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys().then(function (names) {
      return Promise.all(
        names.filter(function (name) { return name !== CACHE_VERSION; }).map(function (name) { return caches.delete(name); }),
      );
    }).then(function () {
      return self.clients.claim();
    }),
  );
});

self.addEventListener('fetch', function (event) {
  var req = event.request;
  if (req.method !== 'GET') return; // browser default for everything else

  var url = new URL(req.url);

  if (url.pathname.indexOf('/dashboard/assets/') === 0) {
    // Finding #11 (phase5.1): `ignoreSearch` so a `?v=<version>` query on the page's own asset
    // links (layout.ts) still hits the precached entry keyed on the bare pathname, and a genuine
    // cache miss is now actually written to the cache (the old code fetched on miss but never
    // called `cache.put`, so the cache could only ever equal exactly what `install` precached).
    event.respondWith(
      caches.open(CACHE_VERSION).then(function (cache) {
        return cache.match(req, { ignoreSearch: true }).then(function (cached) {
          if (cached) return cached;
          return fetch(req).then(function (res) {
            if (res && res.ok) cache.put(req, res.clone());
            return res;
          });
        });
      }),
    );
    return;
  }

  if (req.mode === 'navigate') {
    // Network-only for authenticated HTML: never written to a cache. Falls back to the offline
    // page when the network is unreachable.
    event.respondWith(
      fetch(req).catch(function () {
        return caches.match('/dashboard/offline.html');
      }),
    );
    return;
  }

  // Everything else (API/fragment/export requests): browser default, never intercepted or cached.
});

self.addEventListener('push', function (event) {
  var payload = null;
  if (event.data) {
    try {
      payload = event.data.json();
    } catch (e) {
      payload = null;
    }
  }
  var title = (payload && payload.title) || 'openpost';
  var body = (payload && payload.body) || 'openpost: new activity';
  var url = (payload && typeof payload.url === 'string') ? payload.url : '/dashboard/messages';
  var tag = (payload && payload.tag) || 'openpost';

  event.waitUntil(
    self.registration.showNotification(title, {
      body: body,
      tag: tag,
      data: { url: url },
      icon: '/dashboard/assets/icon-192.png',
      badge: '/dashboard/assets/icon-192.png',
      timestamp: (payload && payload.ts) || Date.now(),
    }),
  );
});

function isSafeNextPath(next) {
  return typeof next === 'string' && next.indexOf('/dashboard') === 0 && next.indexOf('//') !== 0;
}

self.addEventListener('notificationclick', function (event) {
  event.notification.close();
  var url = isSafeNextPath(event.notification.data && event.notification.data.url) ? event.notification.data.url : '/dashboard/messages';

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (clients) {
      for (var i = 0; i < clients.length; i++) {
        var client = clients[i];
        if ('focus' in client) {
          client.focus();
          if ('navigate' in client) client.navigate(url);
          return;
        }
      }
      if (self.clients.openWindow) return self.clients.openWindow(url);
    }),
  );
});

// Finding #3 (phase5.1): the dashboard CSRF preHandler requires `_csrf` in the body or
// `X-Openpost-CSRF` for session auth - this handler used to POST with neither, so every
// browser-initiated re-subscription (a rotated `pushsubscriptionchange`) came back 403 and the
// device silently stopped receiving notifications until a later 404/410 disabled the stale row.
// A service worker has no DOM, so it cannot read `document.body.dataset.csrf` itself - it reads the
// non-HttpOnly `openpost_csrf` cookie directly via the Cookie Store API where available, and falls
// back to asking an open client page for it over a MessageChannel otherwise.
function readCsrfCookie() {
  if (typeof self.cookieStore !== 'undefined' && self.cookieStore && typeof self.cookieStore.get === 'function') {
    return self.cookieStore
      .get('openpost_csrf')
      .then(function (cookie) {
        return cookie && typeof cookie.value === 'string' ? cookie.value : null;
      })
      .catch(function () {
        return null;
      });
  }
  return Promise.resolve(null);
}

function readCsrfFromClient() {
  return self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (list) {
    if (list.length === 0) return null;
    return new Promise(function (resolve) {
      var settled = false;
      var channel = new MessageChannel();
      channel.port1.onmessage = function (event) {
        settled = true;
        resolve(event.data && typeof event.data.csrf === 'string' ? event.data.csrf : null);
      };
      list[0].postMessage({ type: 'openpost-csrf-request' }, [channel.port2]);
      // A page that never responds (e.g. an ancient `app.js` before this handler existed) must
      // never hang the re-subscription indefinitely.
      setTimeout(function () {
        if (!settled) resolve(null);
      }, 2000);
    });
  });
}

function getCsrfToken() {
  return readCsrfCookie().then(function (fromCookie) {
    return fromCookie || readCsrfFromClient();
  });
}

self.addEventListener('pushsubscriptionchange', function (event) {
  event.waitUntil(
    self.registration.pushManager
      .subscribe(event.oldSubscription ? { userVisibleOnly: true, applicationServerKey: event.oldSubscription.options.applicationServerKey } : undefined)
      .then(function (subscription) {
        return getCsrfToken().then(function (csrf) {
          var headers = { 'Content-Type': 'application/json' };
          if (csrf) headers['X-Openpost-CSRF'] = csrf;
          return fetch('/dashboard/actions/push-subscribe', {
            method: 'POST',
            headers: headers,
            body: JSON.stringify(Object.assign(subscription.toJSON(), { oldEndpoint: event.oldSubscription && event.oldSubscription.endpoint })),
          });
        });
      })
      .catch(function () {
        // Best-effort: nothing more we can do from inside the worker if re-subscription fails.
      }),
  );
});
