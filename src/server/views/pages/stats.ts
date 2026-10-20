import type { StatsReport } from '../../../db/stats.js';
import type { AccuracyReport } from '../../../db/report.js';
import { html, join, type SafeHtml } from '../html.js';
import { fmtPercent } from '../format.js';
import { barChart, hourHistogram, statTile } from '../charts.js';

export interface StatsPageModel {
  stats: StatsReport;
  accuracy: AccuracyReport;
}

export function statsPage(model: StatsPageModel): SafeHtml {
  const { stats } = model;
  return html`<h1>Stats</h1>
<p class="note">${new Date(stats.since).toISOString()} .. ${new Date(stats.until).toISOString()} (${stats.timeZone})</p>
<div class="stat-tiles">
  ${statTile('Messages', String(stats.totals.messages))}
  ${statTile('Recipients', String(stats.totals.recipients))}
  ${statTile('Open rate', fmtPercent(stats.rates.openRate))}
  ${statTile('Click rate', fmtPercent(stats.rates.clickRate))}
  ${statTile('Click-to-open', fmtPercent(stats.rates.clickToOpenRate))}
  ${statTile('Reply rate', fmtPercent(stats.rates.replyRate))}
  ${statTile('Prefetch suppression', fmtPercent(stats.rates.prefetchSuppressionRate))}
  ${statTile(
    'Median time to open',
    stats.timeToOpen.medianMs !== null ? `${Math.round(stats.timeToOpen.medianMs / 1000)}s` : 'n/a',
  )}
</div>
<section aria-labelledby="tto-h">
  <h2 id="tto-h">Time to open</h2>
  ${barChart('Time to open distribution', stats.timeToOpen.buckets.map((b) => ({ label: b.label, value: b.count })))}
</section>
<section aria-labelledby="bh-h">
  <h2 id="bh-h">Best hour to send (${stats.bestHour.timeZone})</h2>
  ${hourHistogram('Opens by hour of day', stats.bestHour.hours)}
  <p class="note">${stats.bestHour.peakHour !== null ? `Peak hour: ${stats.bestHour.peakHour}:00` : 'No counted opens yet.'}</p>
</section>
<section aria-labelledby="bd-h">
  <h2 id="bd-h">By day</h2>
  ${barChart('Sent per day', stats.byDay.map((d) => ({ label: d.day.slice(5), value: d.sent })))}
</section>
<section aria-labelledby="top-h">
  <h2 id="top-h">Top messages</h2>
  <div class="table-wrap">
  <table>
    <caption class="visually-hidden">Top messages by recipient count</caption>
    <thead><tr><th scope="col">Subject</th><th scope="col">Recipients</th><th scope="col">Open rate</th><th scope="col">Click rate</th><th scope="col">Reply rate</th></tr></thead>
    <tbody>${join(
      stats.topMessages.map(
        (m) =>
          html`<tr><td data-label="Subject"><a href="/dashboard/messages/${m.id}">${m.subject}</a></td><td data-label="Recipients">${String(m.recipients)}</td><td data-label="Open rate">${fmtPercent(m.openRate)}</td><td data-label="Click rate">${fmtPercent(m.clickRate)}</td><td data-label="Reply rate">${fmtPercent(m.replyRate)}</td></tr>`,
      ),
    )}</tbody>
  </table>
  </div>
</section>
<section aria-labelledby="acc-h">
  <h2 id="acc-h">Accuracy self-report</h2>
  <p>Counted open rate: ${fmtPercent(model.accuracy.derived.countedOpenRate)} · Prefetch suppression: ${fmtPercent(model.accuracy.derived.prefetchSuppressionRate)} · Overrides: ${String(model.accuracy.derived.overrides)}</p>
</section>`;
}
