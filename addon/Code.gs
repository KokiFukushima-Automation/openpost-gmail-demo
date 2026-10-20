/**
 * openpost Gmail add-on - compose trigger (docs/09_phase5_spec.md §6.3-§6.4).
 *
 * IMPORTANT (§6.1): whether the Gmail *mobile* apps show this compose card at all is unverified -
 * the balance of evidence in the spec's research note says probably not. Step 2 of
 * addon/README.md's install checklist exists to answer that in one minute for your own client.
 * §2's mobile compose page (openpost's own dashboard) is the supported path either way.
 *
 * §6.2: this can only INSERT content into the draft body (CardService's UpdateDraftBodyAction has
 * no "replace" operation) - so there is no click tracking from the add-on, and tracking is
 * message-level only (the draft's current To/Cc/Bcc at the moment the card runs; addresses added
 * afterwards are invisible to it, since there is no on-send trigger either).
 */

function onHomepage(e) {
  var configured = !!PropertiesService.getUserProperties().getProperty('OPENPOST_BASE_URL');
  var text = configured
    ? 'openpost is configured. Compose a message and tap "Track with openpost".'
    : 'Run setup(baseUrl, token) from the Apps Script editor first (see addon/README.md).';
  var card = CardService.newCardBuilder()
    .setHeader(CardService.newCardHeader().setTitle('openpost'))
    .addSection(CardService.newCardSection().addWidget(CardService.newTextParagraph().setText(text)))
    .build();
  return [card];
}

function onComposeTrack() {
  var action = CardService.newAction().setFunctionName('applyComposeTrack')
    .setParameters({draftId: 'r-' + Utilities.getUuid()});
  return [CardService.newCardBuilder()
    .setHeader(CardService.newCardHeader().setTitle('openpost'))
    .addSection(CardService.newCardSection()
      .addWidget(CardService.newTextParagraph().setText('宛先を確定してから追跡画像を挿入してください。挿入後は宛先を変更せず送信してください。画像の取得は読了を保証しません。'))
      .addWidget(CardService.newTextInput().setFieldName('trackingSubject').setTitle('管理画面用の件名（任意）'))
      .addWidget(CardService.newTextButton().setText('追跡画像を挿入').setOnClickAction(action)))
    .build()];
}

function applyComposeTrack(e) {
  var props = PropertiesService.getUserProperties();
  var baseUrl = props.getProperty('OPENPOST_BASE_URL');
  var token = props.getProperty('OPENPOST_TOKEN');
  if (!baseUrl || !token) {
    return errorCard_('openpost is not configured. Run setup(baseUrl, token) from the Apps Script editor first.');
  }

  var meta = (e && (e.gmail || e.draftMetadata)) || {};
  var toRecipients = meta.toRecipients || [];
  var ccRecipients = meta.ccRecipients || [];
  var bccRecipients = meta.bccRecipients || [];
  var subjectInput = e && e.commonEventObject && e.commonEventObject.formInputs && e.commonEventObject.formInputs.trackingSubject;
  var subject = (subjectInput && subjectInput.stringInputs && subjectInput.stringInputs.value[0]) || meta.subject || 'Gmailから送信した追跡メール';

  if (toRecipients.length + ccRecipients.length + bccRecipients.length === 0) {
    return errorCard_('Add at least one recipient before tracking.');
  }

  var draftId = (e && e.parameters && e.parameters.draftId) || 'r-' + Utilities.getUuid();

  var payload = { subject: subject, to: toRecipients, cc: ccRecipients, bcc: bccRecipients, draftId: draftId };
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
    // POSTS ONLY to /api/addon/track (this call) and /api/addon/link (Linker.gs) - never any
    // other path. The token/pixel URL is never written to the execution log, and no script in
    // this project ever submits the draft on the user's behalf (test 425 checks the source for
    // both).
    response = UrlFetchApp.fetch(baseUrl + '/api/addon/track', options);
  } catch (err) {
    return errorCard_('Could not reach openpost: ' + err);
  }

  if (response.getResponseCode() < 200 || response.getResponseCode() >= 300) {
    // A half-tracked draft is worse than an untracked one - insert nothing on any non-2xx.
    return errorCard_('openpost returned an error (' + response.getResponseCode() + ')' );
  }

  var result = JSON.parse(response.getContentText());
  if (result.suppressed) {
    return errorCard_('One or more recipients are suppressed/opted out - sent untracked (no pixel inserted), per openpost\'s all-or-nothing tracking rule.');
  }

  props.setProperty('pending.' + result.token, JSON.stringify({ token: result.token, subject: subject, createdAt: Date.now() }));

  var action = CardService.newUpdateDraftBodyAction()
    .addUpdateContent(result.pixelHtml, CardService.ContentType.IMMUTABLE_HTML)
    .setUpdateType(CardService.UpdateDraftBodyType.IN_PLACE_INSERT);

  return CardService.newUpdateDraftActionResponseBuilder().setUpdateDraftBodyAction(action).build();
}

function errorCard_(text) {
  var card = CardService.newCardBuilder()
    .addSection(CardService.newCardSection().addWidget(CardService.newTextParagraph().setText(text)))
    .build();
  return CardService.newActionResponseBuilder()
    .setNotification(CardService.newNotification().setText(text))
    .build();
}
