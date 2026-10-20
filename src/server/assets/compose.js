// openpost compose-page draft autosave (docs/09_phase5_spec.md §2.9). Loaded only on the compose
// page (layout.ts emits this <script> only when model.page === 'compose'). No framework, no build
// step, no server-side draft storage - a phone draft is unsent, unencrypted content the operator has
// not chosen to store.
(function () {
  'use strict';

  var STORAGE_KEY = 'openpost.compose.draft.v1';
  var MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
  var DEBOUNCE_MS = 500;

  var form = document.querySelector('.compose-form');
  if (!form) return;

  var fields = {
    to: form.querySelector('#c-to'),
    cc: form.querySelector('#c-cc'),
    bcc: form.querySelector('#c-bcc'),
    subject: form.querySelector('#c-subject'),
    body: form.querySelector('#c-body'),
  };

  function readDraft() {
    try {
      var raw = window.localStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      var parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object') return null;
      if (typeof parsed.savedAt !== 'number' || Date.now() - parsed.savedAt > MAX_AGE_MS) return null;
      return parsed;
    } catch (e) {
      return null;
    }
  }

  function clearDraft() {
    try {
      window.localStorage.removeItem(STORAGE_KEY);
    } catch (e) {
      // best-effort only
    }
  }

  function isFormEmpty() {
    return Object.keys(fields).every(function (k) {
      var el = fields[k];
      return !el || el.value.trim().length === 0;
    });
  }

  function showRestoreBanner(draft) {
    var banner = document.createElement('div');
    banner.className = 'draft-restore-banner';
    banner.setAttribute('role', 'status');
    var text = document.createElement('span');
    text.textContent = 'Draft restored';
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = 'Discard';
    btn.addEventListener('click', function () {
      clearDraft();
      Object.keys(fields).forEach(function (k) {
        if (fields[k]) fields[k].value = '';
      });
      banner.remove();
    });
    banner.appendChild(text);
    banner.appendChild(btn);
    form.insertBefore(banner, form.firstChild);
  }

  // Restore on load, only into an otherwise-empty form (never clobbers a share-target prefill or a
  // re-rendered validation-error redisplay).
  if (isFormEmpty()) {
    var draft = readDraft();
    if (draft) {
      Object.keys(fields).forEach(function (k) {
        if (fields[k] && typeof draft[k] === 'string') fields[k].value = draft[k];
      });
      showRestoreBanner(draft);
    }
  }

  var saveTimer = null;
  function scheduleSave() {
    if (saveTimer) window.clearTimeout(saveTimer);
    saveTimer = window.setTimeout(function () {
      var payload = { savedAt: Date.now() };
      Object.keys(fields).forEach(function (k) {
        payload[k] = fields[k] ? fields[k].value : '';
      });
      try {
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
      } catch (e) {
        // best-effort only - a full/blocked localStorage must never break composing.
      }
    }, DEBOUNCE_MS);
  }

  Object.keys(fields).forEach(function (k) {
    if (fields[k]) fields[k].addEventListener('input', scheduleSave);
  });

  // Finding #12 (phase5.1): don't clear here - a native form submit doesn't yet know whether the
  // server will accept it (a 400 re-renders this same compose page with the submitted values, and
  // a cleared draft on that path just threw away 500ms-old autosaved content for nothing, even
  // though the fields themselves survive via server-side redisplay). `app.js` clears the draft
  // instead, keyed off the compose route's own `?flash=sent`/`?flash=sent_partial` redirect - the
  // only page that can actually know the submit succeeded.
})();
