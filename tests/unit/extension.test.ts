import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

const matcher = readFileSync('extension/matcher.js', 'utf8').replaceAll('export ', '');
const ctx = vm.createContext({});
vm.runInContext(`${matcher}\nthis.matchRows=matchRows;this.threadId=threadId;`, ctx);
const matchRows = ctx.matchRows as (rows: object[], results: object[]) => Array<{glyph:string;title:string}>;
const threadId = ctx.threadId as (v:unknown) => string|null;
const id = '18fabc1234567890';
function result(state: string, matchedBy = 'threadId') {
  return {key:id,matchedBy,summary:{state,opens:2,clicks:1}};
}

describe('Gmail overlay matching', () => {
  it('accepts only legacy hex thread IDs, never Gmail opaque IDs or arbitrary text', () => {
    expect(threadId(`#${id.toUpperCase()}`)).toBe(id);
    for (const invalid of ['thread-f:123', '', 'subject', '<script>', null]) expect(threadId(invalid)).toBeNull();
  });
  it.each([['not_opened','○'],['prefetched','◐'],['opened','●'],['read_confirmed','◉'],['replied','↩']])('renders %s honestly', (state,glyph) => {
    const badges = matchRows([{rowId:'0',threadId:id}], [result(state)]);
    expect(badges[0]?.glyph).toBe(glyph);
    expect(badges[0]?.title).toContain('宛先全員の既読を意味しません');
    if (state === 'prefetched') expect(badges[0]?.title).toContain('開封は未確認');
  });
  it('refuses subject guesses, unknown states and unmatched rows', () => {
    expect(matchRows([{rowId:'0',threadId:id}], [result('opened','subject')])).toHaveLength(0);
    expect(matchRows([{rowId:'0',threadId:id}], [result('nonsense')])).toHaveLength(0);
    expect(matchRows([{rowId:'0',threadId:id}], [])).toHaveLength(0);
  });
});

async function worker() {
  const session: Record<string,unknown> = {};
  const local: Record<string,unknown> = {};
  const area = (data: Record<string,unknown>) => ({
    setAccessLevel:vi.fn(async () => {}), get:vi.fn(async () => data),
    set:vi.fn(async (value:object) => Object.assign(data,value)),
    remove:vi.fn(async (key:string) => {delete data[key];}),
  });
  const chrome = {
    storage:{session:area(session),local:area(local)},
    runtime:{id:'test-id',getURL:(path:string) => `chrome-extension://test-id/${path}`,onMessage:{addListener:vi.fn()},openOptionsPage:vi.fn()},
    action:{onClicked:{addListener:vi.fn()}},
    permissions:{contains:vi.fn(async () => true)},
  };
  const fetch = vi.fn(async () => ({ok:true,json:async () => ({results:[]})}));
  const sandbox = vm.createContext({chrome,fetch,URL,AbortSignal});
  const src = readFileSync('extension/background.js','utf8').replace(/^import .*;\n/m,'').replaceAll('export ','');
  await vm.runInContext(`(async () => {${matcher}\n${src}\nthis.handle=handle;})()`,sandbox);
  const handle = sandbox.handle as (msg:object,sender:object) => Promise<unknown>;
  const options = {id:'test-id',url:'chrome-extension://test-id/options.html'};
  return {chrome,handle,fetch,session,local,options};
}

describe('extension credential boundary', () => {
  it('stores tokens in trusted session storage and sends them only to the configured fixed API', async () => {
    const w = await worker();
    await w.handle({type:'configure',origin:'https://track.example.com',token:'test-token-at-least-16'},w.options);
    expect(w.chrome.storage.session.setAccessLevel).toHaveBeenCalledWith({accessLevel:'TRUSTED_CONTEXTS'});
    expect(w.chrome.storage.local.setAccessLevel).toHaveBeenCalledWith({accessLevel:'TRUSTED_CONTEXTS'});
    expect(w.session.connection).toBeDefined();
    expect(w.local.connection).toBeUndefined();
    expect(w.fetch.mock.calls[0]?.[0]).toBe('https://track.example.com/api/threads/lookup');
    await w.handle({type:'disconnect'},w.options);
    expect(w.session.connection).toBeUndefined();
  });
  it('does not let a Gmail content script configure destinations or access credentials', async () => {
    const w = await worker();
    const gmail = {id:'test-id',url:'https://mail.google.com/mail/u/0/',tab:{id:1}};
    await expect(w.handle({type:'configure',origin:'https://evil.example',token:'test-token-at-least-16'},gmail)).rejects.toThrow();
    await expect(w.handle({type:'lookup',threadIds:['not-an-id']},gmail)).rejects.toThrow();
    await expect(w.handle({type:'lookup',threadIds:[id]},{...gmail,url:'https://evil.example/'})).rejects.toThrow();
    expect(w.fetch).not.toHaveBeenCalled();
  });
  it.each(['http://remote.example/','https://user:pass@track.example/','https://track.example/subpath','https://track.example/?token=oops'])('rejects unsafe instance URL %s', async origin => {
    const w = await worker();
    await expect(w.handle({type:'configure',origin,token:'test-token-at-least-16'},w.options)).rejects.toThrow();
    expect(w.fetch).not.toHaveBeenCalled();
  });
  it('refuses redirects and omits server cookies', async () => {
    const w = await worker();
    await w.handle({type:'configure',origin:'https://track.example.com',token:'test-token-at-least-16'},w.options);
    expect(w.fetch.mock.calls[0]?.[1]).toMatchObject({redirect:'error',credentials:'omit',cache:'no-store'});
  });
});

describe('PWA release update', () => {
  it('refetches precached assets instead of repopulating a new release cache from old immutable HTTP entries', async () => {
    const listeners: Record<string,(event:object)=>void> = {};
    const addAll = vi.fn(async () => {});
    const self = {addEventListener:(name:string,fn:(event:object)=>void)=>{listeners[name]=fn;},skipWaiting:vi.fn(async()=>{})};
    const fakeRequest = class {
      url:string;cache:string;
      constructor(url:string,init:{cache:string}){this.url=url;this.cache=init.cache;}
    };
    vm.runInNewContext(readFileSync('src/server/assets/sw.js','utf8'),{self,Request:fakeRequest,caches:{open:async()=>({addAll})}});
    let done:Promise<unknown>|undefined;
    listeners.install!({waitUntil:(promise:Promise<unknown>)=>{done=promise;}});
    await done;
    const entries = addAll.mock.calls[0]?.[0] as Array<{url:string;cache:string}>;
    expect(entries.some(e=>e.url==='/dashboard/assets/app.js')).toBe(true);
    expect(entries.every(e=>e.cache==='reload')).toBe(true);
  });
});
