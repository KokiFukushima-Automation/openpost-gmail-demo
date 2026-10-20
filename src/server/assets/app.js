// openpost dashboard live-update wiring (Phase 3 sec 2.6). No framework, no build step.
(function () {
  'use strict';

  var statusEl = document.getElementById('live-status');
  var logEl = document.getElementById('live-log');
  var lastAnnounceAt = 0;

  function setStatus(text) {
    if (statusEl) statusEl.textContent = text;
  }

  function announce(text) {
    var now = Date.now();
    if (now - lastAnnounceAt < 1000) return; // at most one announcement per second
    lastAnnounceAt = now;
    if (logEl) logEl.textContent = text;
  }

  // Flash whichever element htmx just swapped in, for 1.2s (suppressed under
  // prefers-reduced-motion via app.css alone - this just toggles the class either way).
  document.body.addEventListener('htmx:afterSwap', function (ev) {
    var el = ev.detail && ev.detail.target;
    if (!el || (!el.hasAttribute('data-recipient-id') && !el.hasAttribute('data-message-id'))) return;
    el.classList.add('flash');
    window.setTimeout(function () {
      el.classList.remove('flash');
    }, 1200);
  });

  function onTracking(ev) {
    var payload;
    try {
      payload = JSON.parse(ev.data);
    } catch (e) {
      return;
    }
    var detail = document.getElementById('message-live-detail');
    if (detail && payload.message && detail.getAttribute('data-live-message-id') === payload.message.id && typeof window.htmx !== 'undefined') {
      window.htmx.ajax('GET', '/dashboard/messages/' + encodeURIComponent(payload.message.id), {
        target: detail,
        select: '#message-live-detail',
        swap: 'outerHTML',
      });
    } else if (payload.recipient && payload.recipient.id) {
      var row = document.querySelector('[data-recipient-id="' + CSS.escape(payload.recipient.id) + '"]');
      if (row && typeof window.htmx !== 'undefined') {
        window.htmx.ajax('GET', '/dashboard/fragments/recipient/' + encodeURIComponent(payload.recipient.id), {
          target: row,
          swap: 'outerHTML',
        });
      }
    }
    if (payload.message && payload.message.id) {
      var mrow = document.querySelector('[data-message-id="' + CSS.escape(payload.message.id) + '"]');
      if (mrow && mrow.tagName === 'TR' && typeof window.htmx !== 'undefined') {
        window.htmx.ajax('GET', '/dashboard/fragments/message-row/' + encodeURIComponent(payload.message.id), {
          target: mrow,
          swap: 'outerHTML',
        });
      }
    }
    var kind = (payload.event && payload.event.kind) || 'event';
    var cls = (payload.event && payload.event.classification) || '';
    var email = (payload.recipient && payload.recipient.email) || 'recipient';
    announce(kind + ' · ' + cls + ' · ' + email);
  }

  if (document.body.getAttribute('data-live') === '1') {
    try {
      // Phase 3.1 (H1): served under /dashboard so the dashboard's own Path=/dashboard session
      // cookie is actually sent with this request - it never reached /api/events/stream.
      var es = new EventSource('/dashboard/events/stream');
      es.addEventListener('tracking', onTracking);
      es.onopen = function () {
        setStatus('live');
      };
      es.onerror = function () {
        setStatus('reconnecting…'); // EventSource retries on its own (server sends retry: 3000)
      };
    } catch (e) {
      setStatus('');
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Phase 5 (docs/09_phase5_spec.md §2.5, §4.5): service worker registration and Web Push
  // subscribe/unsubscribe. `data-csrf` on <body> (set by layout.ts) lets this read the CSRF token
  // without parsing `hx-headers`.
  // ---------------------------------------------------------------------------------------------

  function csrfToken() {
    return document.body.getAttribute('data-csrf') || '';
  }

  // Finding #3 (phase5.1): the service worker has no DOM, so when it needs the CSRF token for its
  // own `pushsubscriptionchange` re-subscribe POST (and the cookie-store fallback isn't available)
  // it asks an open client page over a MessageChannel - answer with exactly what `csrfToken()`
  // above already reads.
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.addEventListener('message', function (event) {
      if (event.data && event.data.type === 'openpost-csrf-request' && event.ports && event.ports[0]) {
        event.ports[0].postMessage({ csrf: csrfToken() });
      }
    });
  }

  if (document.querySelector('link[rel="manifest"]') && 'serviceWorker' in navigator && window.isSecureContext) {
    navigator.serviceWorker.register('/dashboard/assets/sw.js', { scope: '/dashboard/' }).catch(function () {
      // Best-effort: an install that fails (e.g. a browser without SW support behind the flag
      // check above lying) must never break the rest of the page.
    });
  }

  function base64UrlToUint8Array(base64Url) {
    var padding = '='.repeat((4 - (base64Url.length % 4)) % 4);
    var base64 = (base64Url + padding).replace(/-/g, '+').replace(/_/g, '/');
    var raw = window.atob(base64);
    var output = new Uint8Array(raw.length);
    for (var i = 0; i < raw.length; ++i) output[i] = raw.charCodeAt(i);
    return output;
  }

  function setPushStatus(text) {
    var el = document.getElementById('push-status');
    if (el) el.textContent = text;
  }

  function postJson(url, body) {
    return fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Openpost-CSRF': csrfToken() },
      body: JSON.stringify(body),
    });
  }

  var enableBtn = document.getElementById('btn-push-enable');
  if (enableBtn) {
    enableBtn.addEventListener('click', function () {
      var section = document.getElementById('notifications-section');
      var vapidKey = section ? section.getAttribute('data-vapid-public-key') : null;
      if (!window.isSecureContext) {
        setPushStatus('Push requires a secure context (HTTPS, or loopback for local testing).');
        return;
      }
      if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
        var isIos = /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream;
        setPushStatus(
          isIos
            ? 'On iPhone/iPad, add openpost to your Home Screen first (Share → Add to Home Screen), then open it from there.'
            : 'This browser does not support push notifications.',
        );
        return;
      }
      if (!vapidKey) {
        setPushStatus('Web Push is not configured on this server.');
        return;
      }
      Notification.requestPermission()
        .then(function (permission) {
          if (permission !== 'granted') {
            setPushStatus('Notification permission was denied.');
            return null;
          }
          return navigator.serviceWorker.ready;
        })
        .then(function (registration) {
          if (!registration) return null;
          return registration.pushManager.subscribe({
            userVisibleOnly: true,
            applicationServerKey: base64UrlToUint8Array(vapidKey),
          });
        })
        .then(function (subscription) {
          if (!subscription) return;
          return postJson('/dashboard/actions/push-subscribe', subscription.toJSON()).then(function (res) {
            if (res.ok) {
              window.location.search = '?flash=push_enabled';
            } else {
              setPushStatus('Could not register this device (server error).');
            }
          });
        })
        .catch(function (err) {
          setPushStatus('Could not enable push: ' + (err && err.message ? err.message : 'unknown error'));
        });
    });
  }

  document.querySelectorAll('.btn-push-unsubscribe').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var id = btn.getAttribute('data-subscription-id');
      postJson('/dashboard/actions/push-unsubscribe', { id: id }).then(function () {
        window.location.search = '?flash=push_disabled';
      });
    });
  });

  // Finding #12 (phase5.1): the on-device compose draft (src/server/assets/compose.js) is
  // unsent, unencrypted content the operator never chose to store - it must not outlive a logout
  // on a shared/borrowed device. compose.js itself only ever clears it on an explicit Discard; a
  // successful send navigates away to the message detail page entirely (compose.js never runs
  // there), so the ONLY page that can know "this was a successful submit, not a 400 re-render" is
  // whichever page the user actually landed on - the compose route's own `?flash=sent`/
  // `?flash=sent_partial` redirect target. A validation failure re-renders the SAME compose page
  // with no flash param at all, so the draft is correctly left alone in that case.
  var COMPOSE_DRAFT_KEY = 'openpost.compose.draft.v1';
  function clearComposeDraft() {
    try {
      window.localStorage.removeItem(COMPOSE_DRAFT_KEY);
    } catch (e) {
      // best-effort only
    }
  }
  var flashParam = new URLSearchParams(window.location.search).get('flash');
  if (flashParam === 'sent' || flashParam === 'sent_partial') {
    clearComposeDraft();
  }

  var logoutLink = document.getElementById('link-logout');
  if (logoutLink) {
    logoutLink.addEventListener('click', function (ev) {
      ev.preventDefault();
      clearComposeDraft();
      var form = document.getElementById('form-logout');
      if (form) form.submit();
    });
  }
})();
