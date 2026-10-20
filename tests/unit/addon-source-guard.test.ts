import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ADDON_DIR = join(process.cwd(), 'addon');

describe('425. addon/*.gs source-text guard (never executed in CI, but its shape is checked)', () => {
  const gsFiles = readdirSync(ADDON_DIR).filter((f) => f.endsWith('.gs'));

  it('at least the three documented .gs files are present', () => {
    expect(gsFiles.sort()).toEqual(['Code.gs', 'Linker.gs', 'Setup.gs']);
  });

  it('UrlFetchApp.fetch is only ever called with a literal /api/addon/track or /api/addon/link path', () => {
    for (const file of gsFiles) {
      const src = readFileSync(join(ADDON_DIR, file), 'utf8');
      const calls = [...src.matchAll(/UrlFetchApp\.fetch\(([^,)]+)/g)];
      for (const call of calls) {
        const arg = call[1] as string;
        expect(arg, `${file}: UrlFetchApp.fetch(${arg}`).toMatch(/\/api\/addon\/(track|link)['"]/);
      }
    }
  });

  it('never Logger.log(...token...) - the token/pixel URL is never written to the Apps Script execution log', () => {
    for (const file of gsFiles) {
      const src = readFileSync(join(ADDON_DIR, file), 'utf8');
      const loggerCalls = [...src.matchAll(/Logger\.log\(([^)]*)\)/g)];
      for (const call of loggerCalls) {
        const arg = (call[1] as string).toLowerCase();
        expect(arg, `${file}: Logger.log(${call[1]})`).not.toMatch(/token/);
      }
    }
  });

  it('never calls drafts.send / GmailApp.sendEmail / message.send anywhere - the add-on never sends mail itself', () => {
    for (const file of gsFiles) {
      const src = readFileSync(join(ADDON_DIR, file), 'utf8');
      expect(src, file).not.toMatch(/drafts\.send/i);
      expect(src, file).not.toMatch(/\.sendEmail\s*\(/);
      expect(src, file).not.toMatch(/\.send\(\s*\)/);
    }
  });

  it('appsscript.json declares the compose trigger and both required base scopes', () => {
    const manifest = JSON.parse(readFileSync(join(ADDON_DIR, 'appsscript.json'), 'utf8'));
    expect(manifest.addOns.gmail.composeTrigger.selectActions[0].runFunction).toBe('onComposeTrack');
    expect(manifest.oauthScopes).toContain('https://www.googleapis.com/auth/gmail.addons.execute');
    expect(manifest.oauthScopes).toContain('https://www.googleapis.com/auth/gmail.addons.current.message.metadata');
    expect(manifest.oauthScopes).toContain('https://www.googleapis.com/auth/script.external_request');
  });

  it('README states the compose-surface uncertainty and the limitation table', () => {
    const readme = readFileSync(join(ADDON_DIR, 'README.md'), 'utf8');
    expect(readme).toMatch(/unverified/i);
    expect(readme).toMatch(/message-level/i);
    expect(readme).toMatch(/no click tracking|None\. `CardService/i);
  });
});
