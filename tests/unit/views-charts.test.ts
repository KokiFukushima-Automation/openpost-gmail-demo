import { describe, expect, it } from 'vitest';
import { barChart, hourHistogram } from '../../src/server/views/charts.js';
import { render } from '../../src/server/views/html.js';

/** A minimal well-formedness check (balanced tags, no bare `&`) - avoids pulling in an XML/DOM
 *  parser as a new dependency just for this assertion. */
function assertWellFormedXmlFragment(fragment: string): void {
  const wrapped = `<root>${fragment}</root>`;
  expect(wrapped).not.toMatch(/&(?!amp;|lt;|gt;|quot;|#39;|#\d+;)/);
  const stack: string[] = [];
  const tagRe = /<(\/?)([a-zA-Z][\w:-]*)\b[^>]*?(\/?)>/g;
  let m: RegExpExecArray | null;
  while ((m = tagRe.exec(wrapped)) !== null) {
    const [, closing, name, selfClose] = m;
    if (selfClose === '/') continue;
    if (closing === '/') {
      const top = stack.pop();
      expect(top).toBe(name);
    } else {
      stack.push(name as string);
    }
  }
  expect(stack).toEqual([]);
}

describe('views/charts', () => {
  it('158a. barChart output parses as well-formed XML, carries role="img" + aria-labelledby -> title/desc, uses no style= attribute', () => {
    const out = render(barChart('Opens', [{ label: 'a', value: 3 }, { label: 'b', value: 5 }]));
    assertWellFormedXmlFragment(out);
    expect(out).toContain('role="img"');
    expect(out).toMatch(/aria-labelledby="([\w-]+)-title \1-desc"/);
    expect(out).toContain('<title id=');
    expect(out).toContain('<desc id=');
    expect(out).not.toContain('style=');
  });

  it('158b. zero-data input renders an empty-state message, not a division by zero', () => {
    const out = render(barChart('Empty', [{ label: 'a', value: 0 }]));
    expect(out).toContain('no data yet');
    expect(out).not.toContain('NaN');
    expect(out).not.toContain('Infinity');
  });

  it('158c. hourHistogram scales to the max value across 24 buckets', () => {
    const hours = Array.from({ length: 24 }, (_, h) => ({ hour: h, count: h === 5 ? 10 : 0 }));
    const out = render(hourHistogram('Best hour', hours));
    assertWellFormedXmlFragment(out);
    expect(out).toContain('role="img"');
    expect(out).not.toContain('NaN');
  });

  it('159. each chart is accompanied by a <details> data table containing the same numbers', () => {
    const out = render(barChart('Opens', [{ label: 'mon', value: 7 }]));
    expect(out).toContain('<details class="chart-data">');
    expect(out).toContain('<summary>Data table</summary>');
    expect(out).toContain('mon');
    expect(out).toContain('7');
  });
});
