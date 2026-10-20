/**
 * phase5.1 finding #6: `addon/Linker.gs` is source shipped to Apps Script and never executed in CI
 * (see tests/unit/addon-source-guard.test.ts), but its actual matching logic is plain ES5 that runs
 * fine under Node's `vm` module with a mocked Advanced Gmail service - this exercises the real fix (oldest-first,
 * match-must-be-in-the-pixel's-own-<img>) rather than merely checking the source text.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

interface FakeMessage {
  id: string;
  dateMs: number;
  body: string;
}

function loadLinker(threads: FakeMessage[][], truncated = false, asBytes = true): { findSentMessageForToken_: (pending: { token: string; subject?: string }) => { messageId: string } | null } {
  const src = readFileSync(join(process.cwd(), 'addon', 'Linker.gs'), 'utf8');
  const messages = threads.flat();
  const sandbox: Record<string, unknown> = {
    Gmail: {Users: {Messages: {
      list: () => ({messages: messages.map(m => ({id:m.id})), ...(truncated ? {nextPageToken:'more'} : {})}),
      get: (_user:string,id:string) => {
        const m = messages.find(m => m.id === id)!;
        return {id,threadId:'thread-1',internalDate:String(m.dateMs),payload:{mimeType:'multipart/alternative',parts:[{mimeType:'text/html',body:{data:asBytes ? Array.from(Buffer.from(m.body)) : Buffer.from(m.body).toString('base64')}}],headers:[{name:'Message-ID',value:`<${id}@example.com>`}]}};
      },
    }}},
    Utilities: {base64DecodeWebSafe: (s:string) => { if (s.length % 4) throw new Error('padding required'); return Buffer.from(s,'base64url'); },newBlob: (b:Buffer|number[]) => ({getDataAsString: () => Buffer.from(b).toString('utf8')})},
  };
  vm.createContext(sandbox);
  vm.runInContext(`${src}\nthis.findSentMessageForToken_ = findSentMessageForToken_;\nthis.bodyHasPixelForToken_ = bodyHasPixelForToken_;`, sandbox);
  return sandbox as unknown as { findSentMessageForToken_: (pending: { token: string; subject?: string }) => { messageId: string } | null };
}

describe('addon/Linker.gs matching logic (phase5.1 finding #6)', () => {
  it('binds to the ORIGINAL (oldest) send, not a later forward that quotes the same pixel', () => {
    const token = 'abcXYZ123token';
    const original: FakeMessage = {
      id: 'original-send',
      dateMs: 1000,
      body: `<div>Hi there</div><img src="https://t.example.com/p/1${token}.sig" width="1" height="1" alt="">`,
    };
    const forward: FakeMessage = {
      id: 'later-forward',
      dateMs: 2000,
      // A forward's quoted HTML preserves the original <img> pixel verbatim.
      body: `<div>Fwd: see below</div><blockquote><img src="https://t.example.com/p/1${token}.sig" width="1" height="1" alt=""></blockquote>`,
    };
    const linker = loadLinker([[forward], [original]]);
    const result = linker.findSentMessageForToken_({ token: `1${token}.sig`, subject: 'Test' });
    expect(result).not.toBeNull();
    expect(result?.messageId).toBe('original-send');
  });

  it('does not match the token when it appears only as quoted plain text, never inside an <img> tag', () => {
    const token = 'plaintextOnlyToken';
    const quotedTextOnly: FakeMessage = {
      id: 'quoted-text-only',
      dateMs: 1000,
      body: `<div>fyi, someone pasted the raw token ${token} as text, not a pixel</div>`,
    };
    const realPixel: FakeMessage = {
      id: 'real-pixel-message',
      dateMs: 2000,
      body: `<div>Hi</div><img src="https://t.example.com/p/${token}" width="1" height="1" alt="">`,
    };
    const linker = loadLinker([[quotedTextOnly, realPixel]]);
    const result = linker.findSentMessageForToken_({ token, subject: 'Test' });
    expect(result).not.toBeNull();
    // The oldest message contains the token as bare text (not in an <img>), so it must be skipped
    // in favour of the message that actually carries the pixel.
    expect(result?.messageId).toBe('real-pixel-message');
  });

  it('does not bind when Gmail search results exceed the paging limit', () => {
    expect(loadLinker([],true).findSentMessageForToken_({token:'test'})).toBeNull();
  });

  it('also decodes base64 strings returned by REST-shaped mocks',()=>{
    const linker=loadLinker([[{id:'html-string',dateMs:1000,body:'<img src="https://x/p/token">'}]],false,false);
    expect(linker.findSentMessageForToken_({token:'token'})?.messageId).toBe('html-string');
  });

  it('bodyHasPixelForToken_ requires the token inside the <img> tag itself', () => {
    const linker = loadLinker([]) as unknown as { bodyHasPixelForToken_: (html: string, token: string) => boolean };
    expect(linker.bodyHasPixelForToken_('<img src="https://x/p/TOK">', 'TOK')).toBe(true);
    expect(linker.bodyHasPixelForToken_('<p>TOK mentioned here, no image</p>', 'TOK')).toBe(false);
    expect(linker.bodyHasPixelForToken_('', 'TOK')).toBe(false);
  });
});
