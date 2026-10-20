import { describe, expect, it } from 'vitest';
import { render } from '../../src/server/views/html.js';
import { composePage, type ComposePageModel } from '../../src/server/views/pages/compose.js';

function baseModel(overrides: Partial<ComposePageModel> = {}): ComposePageModel {
  return {
    to: '',
    cc: '',
    bcc: '',
    subject: '',
    body: '',
    accounts: [],
    selectedAccount: null,
    transport: 'dryrun',
    trackClicks: true,
    dryRunForced: true,
    error: null,
    csrf: 'tok',
    maxBodyBytes: 262144,
    maxRecipients: 25,
    ...overrides,
  };
}

describe('composePage', () => {
  it('renders a hidden account input for exactly one account', () => {
    const out = render(baseModelHtml({ accounts: [{ ref: 'a1', label: 'Work', email: 'w@example.com', isDefault: true }], selectedAccount: 'a1' }));
    expect(out).toContain('<input type="hidden" name="account" value="a1">');
    expect(out).not.toContain('<select id="c-account"');
  });

  it('renders a <select> for two or more accounts, marking the selected one', () => {
    const out = render(
      baseModelHtml({
        accounts: [
          { ref: 'a1', label: 'Work', email: 'w@example.com', isDefault: true },
          { ref: 'a2', label: 'Personal', email: 'p@example.com', isDefault: false },
        ],
        selectedAccount: 'a2',
      }),
    );
    expect(out).toContain('<select id="c-account"');
    expect(out).toContain('Work');
    expect(out).toContain('Personal');
    const a2Option = /<option value="a2"[^>]*>/.exec(out)?.[0] ?? '';
    expect(a2Option).toContain('selected');
  });

  it('renders no account field for zero accounts', () => {
    const out = render(baseModelHtml({ accounts: [] }));
    expect(out).not.toContain('name="account"');
  });

  it('renders the submitted error and preserves field values', () => {
    const out = render(baseModelHtml({ error: 'Something went wrong.', to: 'a@example.com', subject: 'Hi', body: 'body text' }));
    expect(out).toContain('Something went wrong.');
    expect(out).toContain('value="a@example.com"');
    expect(out).toContain('Hi');
    expect(out).toContain('body text');
  });

  it('opens the Cc/Bcc details when either is prefilled', () => {
    const closed = render(baseModelHtml({}));
    expect(closed).toMatch(/<details class="compose-extra" >/);
    const open = render(baseModelHtml({ cc: 'c@example.com' }));
    expect(open).toMatch(/<details class="compose-extra" open>/);
  });

  it('shows the dry-run banner only when forced', () => {
    const forced = render(baseModelHtml({ dryRunForced: true }));
    expect(forced).toContain('dry run: this writes files');
    const notForced = render(baseModelHtml({ dryRunForced: false }));
    expect(notForced).not.toContain('dry run: this writes files');
  });
});

function baseModelHtml(overrides: Partial<ComposePageModel>) {
  return composePage(baseModel(overrides));
}
