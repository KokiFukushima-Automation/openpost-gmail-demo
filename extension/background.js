import { threadId } from './matcher.js';

// local is also trusted-only: a saved token must never reach a Gmail content script.
const storageReady = Promise.all([
  chrome.storage.session.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' }),
  chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' }),
]);
chrome.action.onClicked.addListener(() => chrome.runtime.openOptionsPage());

export function instanceUrl(value) {
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error('URLはホスト名とポートまで指定してください');
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname))) throw new Error('HTTPSが必要です（localhostは例外）');
  return url.origin;
}
async function config() {
  const session = await chrome.storage.session.get('connection');
  if (session.connection) return session.connection;
  return (await chrome.storage.local.get('connection')).connection;
}
async function lookup(connection, ids) {
  const origin = instanceUrl(connection.origin);
  if (!(await chrome.permissions.contains({ origins: [`${origin}/*`] }))) throw new Error('サーバーへの接続権限が必要です');
  const res = await fetch(`${origin}/api/threads/lookup`, {
    method: 'POST', redirect: 'error', credentials: 'omit', cache: 'no-store',
    signal: AbortSignal.timeout(8000),
    headers: { authorization: `Bearer ${connection.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ threadIds: ids }),
  });
  if (!res.ok) throw new Error(`接続失敗 HTTP ${res.status}`);
  const data = await res.json();
  if (!Array.isArray(data.results)) throw new Error('openpost APIの応答ではありません');
  // Only the minimum status crosses into Gmail. No token, addresses, or subject.
  return data.results.filter(r => ids.includes(r.key)).map(r => ({key:r.key, matchedBy:r.matchedBy, summary:r.summary}));
}
async function handle(message, sender) {
  await storageReady;
  const options = sender.id === chrome.runtime.id && sender.url === chrome.runtime.getURL('options.html');
  if (options) {
    if (message.type === 'status') return {configured: Boolean(await config()), extensionOrigin: `chrome-extension://${chrome.runtime.id}`};
    if (message.type === 'disconnect') {
      await chrome.storage.session.remove('connection');
      await chrome.storage.local.remove('connection');
      return {ok:true};
    }
    if (message.type === 'configure') {
      const origin = instanceUrl(message.origin);
      if (typeof message.token !== 'string' || message.token.length < 16 || message.token.length > 4096 || /\s/.test(message.token)) throw new Error('API_TOKENは空白なしの16文字以上で指定してください');
      const connection = {origin, token:message.token};
      await lookup(connection, []);
      await chrome.storage.session.set({connection});
      if (message.remember === true) await chrome.storage.local.set({connection});
      else await chrome.storage.local.remove('connection');
      return {ok:true};
    }
  }
  if (sender.id !== chrome.runtime.id || !sender.tab || new URL(sender.url ?? 'about:blank').origin !== 'https://mail.google.com' || message.type !== 'lookup') throw new Error('許可されていないリクエストです');
  if (!Array.isArray(message.threadIds) || message.threadIds.length > 100 || message.threadIds.some(id => threadId(id) !== id)) throw new Error('スレッドIDが不正です');
  const connection = await config();
  if (!connection) return {results:[]};
  return {results:await lookup(connection, message.threadIds)};
}
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  handle(message, sender).then(respond).catch(error => respond({error:error.message}));
  return true;
});
