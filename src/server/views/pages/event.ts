import { attr, html, join, type SafeHtml } from '../html.js';
import { confidenceBar, fmtTime, RULE_DOC } from '../format.js';
import { overrideForm, type EventItemModel } from '../fragments.js';

export interface EventPageModel {
  event: EventItemModel;
  messageId: string;
  messageSubject: string;
  recipientId: string;
  recipientEmail: string;
  signals: {
    ipHashPrefix: string | null;
    ipNetHashPrefix: string | null;
    ua: string | null;
    os: string | null;
    country: string | null;
    region: string | null;
    city: string | null;
    proxied: boolean;
  };
  csrf: string;
}

function signalLabel(value: string | null, proxied: boolean): string {
  if (value !== null) return value;
  return proxied ? 'unknown (proxied)' : 'unknown';
}

export function eventPage(model: EventPageModel): SafeHtml {
  const ruleRows = model.event.reasons.map(
    (r) => html`<li><code>${r}</code> - ${RULE_DOC[r] ?? 'undocumented rule id'}</li>`,
  );
  return html`<h1>Event ${model.event.kind} · ${model.event.classification}</h1>
<p><a href="/dashboard/messages/${model.messageId}">${model.messageSubject}</a> · ${model.recipientEmail}</p>
<dl class="event-detail">
  <dt>Occurred</dt><dd>${fmtTime(model.event.occurredAt)}</dd>
  <dt>Classification</dt><dd>${model.event.classification}${model.event.counted ? ' (counted)' : ' (not counted)'}</dd>
  <dt>Confidence</dt><dd>${confidenceBar(model.event.confidence)}</dd>
  <dt>Rules</dt><dd><ul>${join(ruleRows)}</ul></dd>
  <dt>IP hash prefix</dt><dd><code>${signalLabel(model.signals.ipHashPrefix, model.signals.proxied)}</code></dd>
  <dt>IP network hash prefix</dt><dd><code>${signalLabel(model.signals.ipNetHashPrefix, model.signals.proxied)}</code></dd>
  <dt>User agent</dt><dd>${signalLabel(model.signals.ua, model.signals.proxied)}</dd>
  <dt>OS</dt><dd>${signalLabel(model.signals.os, model.signals.proxied)}</dd>
  <dt>Location</dt><dd>${signalLabel([model.signals.city, model.signals.region, model.signals.country].filter((v) => v !== null).join(', ') || null, model.signals.proxied)}</dd>
  ${model.event.overridden ? html`<dt>Overridden</dt><dd>was ${model.event.originalClassification ?? 'unknown'}</dd>` : ''}
  ${model.event.linkUrl ? html`<dt>Target URL</dt><dd>${model.event.linkUrl}</dd>` : ''}
</dl>
${overrideForm(model.event)}
<form method="post" action="/dashboard/actions/reclassify" class="override-form-full">
  <input type="hidden" name="kind" value="${attr(model.event.kind)}">
  <input type="hidden" name="eventId" value="${attr(model.event.id)}">
  <input type="hidden" name="_csrf" value="${attr(model.csrf)}">
  <label for="full-note">Note</label>
  <input id="full-note" type="text" name="note" maxlength="500">
  ${join(
    model.event.validClassifications
      .filter((c) => c !== model.event.classification)
      .map((c) => html`<button type="submit" name="classification" value="${attr(c)}">Override to ${c}</button>`),
  )}
</form>`;
}
