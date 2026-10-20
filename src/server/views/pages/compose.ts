import { attr, html, join, raw, type SafeHtml } from '../html.js';
import type { TransportName } from '../../../types.js';

export interface ComposeAccountOption {
  ref: string;
  label: string;
  email: string;
  isDefault: boolean;
}

export interface ComposePageModel {
  to: string;
  cc: string;
  bcc: string;
  subject: string;
  body: string;
  accounts: ComposeAccountOption[];
  selectedAccount: string | null;
  transport: TransportName;
  trackClicks: boolean;
  dryRunForced: boolean;
  error: string | null;
  csrf: string;
  maxBodyBytes: number;
  maxRecipients: number;
}

/**
 * docs/09_phase5_spec.md §2.2: the mobile compose form. Plain text body, generated HTML (§2.4) - no
 * WYSIWYG editor, no inline script/style. `<details>` hides Cc/Bcc by default with zero JS.
 */
export function composePage(model: ComposePageModel): SafeHtml {
  const accountField =
    model.accounts.length >= 2
      ? html`<div class="field">
      <label for="c-account">From</label>
      <select id="c-account" name="account">
        ${join(
          model.accounts.map((a) => {
            const selected = model.selectedAccount === a.ref;
            return html`<option value="${attr(a.ref)}" ${raw(selected ? 'selected' : '')}>${a.label} &lt;${a.email}&gt;</option>`;
          }),
        )}
      </select>
    </div>`
      : model.accounts.length === 1
        ? html`<input type="hidden" name="account" value="${attr(model.accounts[0]!.ref)}">`
        : html``;

  const ccOrBccPrefilled = model.cc.length > 0 || model.bcc.length > 0;

  return html`<h1>Compose</h1>
${model.error ? html`<p class="flash flash-error">${model.error}</p>` : ''}
<form method="post" action="/dashboard/compose/send" enctype="application/x-www-form-urlencoded" class="compose-form">
  <input type="hidden" name="_csrf" value="${attr(model.csrf)}">
  ${accountField}
  <div class="field">
    <label for="c-to">To</label>
    <input id="c-to" name="to" type="email" multiple inputmode="email" autocapitalize="none" autocorrect="off"
      spellcheck="false" enterkeyhint="next" required value="${attr(model.to)}" placeholder="a@example.com, b@example.com">
  </div>
  <div class="field">
    <label for="c-subject">Subject</label>
    <input id="c-subject" name="subject" type="text" enterkeyhint="next" required maxlength="512" value="${attr(model.subject)}">
  </div>
  <!-- §2.2: Subject immediately follows To in tab order (DoD 1 - "Subject reached with Tab") -
       Cc/Bcc's collapsed <details> comes after, so its focusable <summary> never sits between them. -->
  <details class="compose-extra" ${raw(ccOrBccPrefilled ? 'open' : '')}>
    <summary>Cc / Bcc</summary>
    <div class="field">
      <label for="c-cc">Cc</label>
      <input id="c-cc" name="cc" type="email" multiple inputmode="email" autocapitalize="none" autocorrect="off" spellcheck="false" value="${attr(model.cc)}">
    </div>
    <div class="field">
      <label for="c-bcc">Bcc</label>
      <input id="c-bcc" name="bcc" type="email" multiple inputmode="email" autocapitalize="none" autocorrect="off" spellcheck="false" value="${attr(model.bcc)}">
    </div>
  </details>
  <div class="field">
    <label for="c-body">Body</label>
    <textarea id="c-body" name="body" rows="10" enterkeyhint="send" required>${model.body}</textarea>
  </div>
  <div class="field field-inline">
    <label for="c-track-clicks"><input id="c-track-clicks" type="checkbox" name="trackClicks" ${raw(model.trackClicks ? 'checked' : '')}> Track clicks</label>
  </div>
  <button type="submit" class="btn-primary btn-send">Send</button>
  <p class="compose-transport-note">Transport: <strong>${model.transport}</strong>${model.dryRunForced ? ' (forced)' : ''}</p>
  ${
    model.dryRunForced
      ? html`<p class="flash-info">dry run: this writes files to OUT_DIR and sends nothing</p>`
      : ''
  }
  <p class="note">Attachments are not supported from the mobile compose page - use <code>openpost send</code> for anything beyond plain text and links.</p>
</form>`;
}
