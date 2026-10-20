import { html, join, raw, type SafeHtml } from './html.js';

let chartIdCounter = 0;
function nextChartId(prefix: string): string {
  chartIdCounter += 1;
  return `${prefix}-${chartIdCounter}`;
}

export interface BarDatum {
  label: string;
  value: number;
}

const CHART_WIDTH = 480;
const CHART_HEIGHT = 160;
const BAR_GAP = 4;

function dataTable(caption: string, columns: [string, string], rows: Array<[string, string]>): SafeHtml {
  return html`<details class="chart-data"><summary>Data table</summary>
    <table><caption class="visually-hidden">${caption}</caption>
      <thead><tr><th scope="col">${columns[0]}</th><th scope="col">${columns[1]}</th></tr></thead>
      <tbody>${join(
        rows.map(([a, b]) => html`<tr><td>${a}</td><td>${b}</td></tr>`),
      )}</tbody>
    </table>
  </details>`;
}

/** A simple vertical bar chart as inline SVG (§2.6/2.7): `role="img"`, `aria-labelledby` pointing
 *  at `<title>`+`<desc>`, CSS classes only (no `style=`), and a zero-data empty state instead of a
 *  division by zero. Always followed by a `<details>` data table with the same numbers. */
export function barChart(title: string, data: BarDatum[]): SafeHtml {
  const id = nextChartId('bar');
  const max = Math.max(0, ...data.map((d) => d.value));
  if (max === 0) {
    return html`<div class="chart chart-empty"><p class="note">${title}: no data yet.</p>${dataTable(
      title,
      ['Label', 'Count'],
      data.map((d) => [d.label, String(d.value)]),
    )}</div>`;
  }
  const barWidth = data.length > 0 ? (CHART_WIDTH - BAR_GAP * (data.length + 1)) / data.length : 0;
  const bars = data.map((d, i) => {
    const h = Math.round((d.value / max) * (CHART_HEIGHT - 24));
    const x = BAR_GAP + i * (barWidth + BAR_GAP);
    const y = CHART_HEIGHT - 24 - h;
    return html`<g class="chart-bar"><rect x="${String(x)}" y="${String(y)}" width="${String(barWidth)}" height="${String(h)}" class="bar"></rect><text x="${String(x + barWidth / 2)}" y="${String(CHART_HEIGHT - 8)}" class="bar-label" text-anchor="middle">${d.label}</text></g>`;
  });
  return html`<figure class="chart">
    <svg viewBox="0 0 ${String(CHART_WIDTH)} ${String(CHART_HEIGHT)}" role="img" aria-labelledby="${id}-title ${id}-desc" class="chart-svg">
      <title id="${id}-title">${title}</title>
      <desc id="${id}-desc">${join(data.map((d) => `${d.label}: ${d.value}`), '; ')}</desc>
      ${join(bars)}
    </svg>
    ${dataTable(title, ['Label', 'Count'], data.map((d) => [d.label, String(d.value)]))}
  </figure>`;
}

/** 24-bucket best-hour histogram, same shape as `barChart` but labelled by hour. */
export function hourHistogram(title: string, hours: Array<{ hour: number; count: number }>): SafeHtml {
  return barChart(
    title,
    hours.map((h) => ({ label: String(h.hour), value: h.count })),
  );
}

/** A tiny inline sparkline (polyline) for a short numeric series - e.g. opens per day. */
export function sparkline(title: string, values: number[]): SafeHtml {
  const id = nextChartId('spark');
  const width = 200;
  const height = 40;
  if (values.length === 0 || values.every((v) => v === 0)) {
    return html`<div class="chart chart-empty"><p class="note">${title}: no data yet.</p></div>`;
  }
  const max = Math.max(...values, 1);
  const step = values.length > 1 ? width / (values.length - 1) : 0;
  const points = values.map((v, i) => `${(i * step).toFixed(1)},${(height - (v / max) * height).toFixed(1)}`).join(' ');
  return html`<figure class="chart chart-sparkline">
    <svg viewBox="0 0 ${String(width)} ${String(height)}" role="img" aria-labelledby="${id}-title ${id}-desc" class="chart-svg">
      <title id="${id}-title">${title}</title>
      <desc id="${id}-desc">${join(values.map((v, i) => `${i}: ${v}`), '; ')}</desc>
      <polyline points="${raw(points)}" class="spark-line"></polyline>
    </svg>
    ${dataTable(title, ['Index', 'Value'], values.map((v, i) => [String(i), String(v)]))}
  </figure>`;
}

/** A single labelled number, used for the stats page's summary row. */
export function statTile(label: string, value: string, sub?: string): SafeHtml {
  return html`<div class="stat-tile"><span class="stat-label">${label}</span><span class="stat-value">${value}</span>${
    sub ? html`<span class="stat-sub">${sub}</span>` : ''
  }</div>`;
}

/** A campaign's send progress as inline SVG (§2.11): sent/skipped/failed/pending stacked
 *  proportionally, `role="img"` with a text alternative, and the same data-table fallback as the
 *  other charts here. Every number passed in is a value the caller already validated (never
 *  interpolated as raw markup - `String(n)` only). */
export function progressBar(
  title: string,
  segments: { sent: number; skipped: number; failed: number; pending: number },
): SafeHtml {
  const id = nextChartId('progress');
  const total = segments.sent + segments.skipped + segments.failed + segments.pending;
  const width = 480;
  const height = 24;
  if (total === 0) {
    return html`<div class="chart chart-empty"><p class="note">${title}: no rows yet.</p></div>`;
  }
  const order: Array<[keyof typeof segments, string]> = [
    ['sent', 'progress-sent'],
    ['skipped', 'progress-skipped'],
    ['failed', 'progress-failed'],
    ['pending', 'progress-pending'],
  ];
  let x = 0;
  const rects = order
    .filter(([key]) => segments[key] > 0)
    .map(([key, cls]) => {
      const w = (segments[key] / total) * width;
      const rect = html`<rect x="${x.toFixed(1)}" y="0" width="${w.toFixed(1)}" height="${String(height)}" class="${cls}"></rect>`;
      x += w;
      return rect;
    });
  const desc = order.map(([key]) => `${key}: ${segments[key]}`).join('; ');
  return html`<figure class="chart chart-progress">
    <svg viewBox="0 0 ${String(width)} ${String(height)}" role="img" aria-labelledby="${id}-title ${id}-desc" class="chart-svg">
      <title id="${id}-title">${title}</title>
      <desc id="${id}-desc">${desc}</desc>
      ${join(rects)}
    </svg>
    ${dataTable(title, ['Status', 'Count'], order.map(([key]) => [key, String(segments[key])]))}
  </figure>`;
}
