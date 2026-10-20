/**
 * openpost Gmail add-on - the optional sent-mail linker (docs/09_phase5_spec.md §6.3, §6.5).
 *
 * There is no on-send trigger in Apps Script/Gmail add-ons, so this polls (installLinker() in
 * Setup.gs wires it to run every 5 minutes via a time-driven trigger) rather than reacting to the
 * send. Requires the broader gmail.readonly scope - the README states plainly that this is
 * optional: without it, add-on-tracked messages simply stay unlinked (no reply detection, no
 * thread lookup) and are reaped to 'abandoned' after ADDON_LINK_TIMEOUT_HOURS.
 */

var PENDING_MAX_AGE_MS = 48 * 60 * 60 * 1000;

function linkSentMessages() {
  var props = PropertiesService.getUserProperties();
  var baseUrl = props.getProperty('OPENPOST_BASE_URL');
  var token = props.getProperty('OPENPOST_TOKEN');
  if (!baseUrl || !token) return;

  var all = props.getProperties();
  var now = Date.now();

  for (var key in all) {
    if (key.indexOf('pending.') !== 0) continue;
    var pending;
    try {
      pending = JSON.parse(all[key]);
    } catch (e) {
      props.deleteProperty(key);
      continue;
    }
    if (now - pending.createdAt > PENDING_MAX_AGE_MS) {
      props.deleteProperty(key);
      continue;
    }

    var found = findSentMessageForToken_(pending);
    if (!found) continue;

    var payload = {
      token: pending.token,
      gmailMessageId: found.messageId,
      threadId: found.threadId,
      rfc822MessageId: found.rfc822MessageId,
      sentAt: found.sentAt,
    };
    var options = {
      method: 'post',
      contentType: 'application/json',
      headers: { Authorization: 'Bearer ' + token },
      payload: JSON.stringify(payload),
      muteHttpExceptions: true,
      followRedirects: false,
    };

    var response;
    try {
      // POSTS ONLY to /api/addon/link (and Code.gs's /api/addon/track) - never any other path.
      response = UrlFetchApp.fetch(baseUrl + '/api/addon/link', options);
    } catch (err) {
      continue; // try again next run
    }
    if (response.getResponseCode() >= 200 && response.getResponseCode() < 300) {
      props.deleteProperty(key);
    }
  }
}

/**
 * Finding #6 (phase5.1): the pixel URL embeds the raw recipient token, so a LATER message that
 * merely quotes the original send (a forward, or a reply that includes the quoted HTML) also
 * contains the token. The old newest-first search preferred exactly that later message over the
 * actual send it was quoting, silently binding the tracked message to the wrong Gmail message id,
 * thread and `sentAt`. Fixed two ways: (1) oldest-first, so the chronologically first match - the
 * original send - always wins; (2) the match must be the pixel's OWN `<img src=...>` tag, not
 * merely the token string appearing anywhere in the body.
 */
function findSentMessageForToken_(pending) {
  var earliest = Number(pending.createdAt) || Date.now() - PENDING_MAX_AGE_MS;
  var query = 'in:sent after:' + Math.floor((earliest - 60000) / 1000);
  // The card's optional label is not guaranteed to equal Gmail's actual subject.
  // Match the issued pixel, never narrow candidates using that label.
  // The Advanced Gmail service honors gmail.readonly; GmailApp requires full mailbox access.
  var refs = [];
  var pageToken;
  for (var page = 0; page < 5; page++) {
    var list = Gmail.Users.Messages.list('me', {q: query, maxResults: 50, pageToken: pageToken});
    refs = refs.concat(list.messages || []);
    pageToken = list.nextPageToken;
    if (!pageToken) break;
  }
  // Do not bind a possibly newer quoted copy when the search was truncated.
  if (pageToken) return null;
  var messages = refs.map(function(ref) {
    return Gmail.Users.Messages.get('me', ref.id, {format: 'full'});
  }).sort(function(a, b) { return Number(a.internalDate) - Number(b.internalDate); });
  for (var i = 0; i < messages.length; i++) {
    var msg = messages[i];
    if (bodyHasPixelForToken_(htmlBody_(msg.payload), pending.token)) {
      var headers = (msg.payload && msg.payload.headers) || [];
      var header = headers.filter(function(h) { return h.name.toLowerCase() === 'message-id'; })[0];
      return {messageId: msg.id, threadId: msg.threadId,
        rfc822MessageId: header ? header.value : undefined, sentAt: Number(msg.internalDate)};
    }
  }
  return null;
}

/** True iff `token` appears inside an `<img ...>` tag's own markup (i.e. is part of the pixel
 *  itself) - never merely somewhere else in the body, such as a quoted forward/reply's visible
 *  text. */
function bodyHasPixelForToken_(html, token) {
  if (!html) return false;
  var imgRe = /<img\b[^>]*>/gi;
  var tag;
  while ((tag = imgRe.exec(html)) !== null) {
    if (tag[0].indexOf(token) !== -1) return true;
  }
  return false;
}

// Decode only inline HTML parts; attachments are never fetched.
function htmlBody_(part) {
  if (!part) return '';
  var own = '';
  if (part.mimeType === 'text/html' && part.body && part.body.data) {
    try {
      var data = part.body.data;
      // Apps Script Advanced services may decode Discovery 'byte' fields to byte arrays.
      if (typeof data === 'string') {
        var encoded = data.replace(/\s/g, '').replace(/\+/g, '-').replace(/\//g, '_');
        while (encoded.length % 4) encoded += '=';
        data = Utilities.base64DecodeWebSafe(encoded);
      }
      own = Utilities.newBlob(data).getDataAsString('UTF-8');
    } catch (err) {
      // A malformed unrelated candidate must not stop the remaining matches.
      own = '';
    }
  }
  return own + (part.parts || []).map(htmlBody_).join('');
}
