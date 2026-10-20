const status = document.querySelector('#status');
const initial = await chrome.runtime.sendMessage({type:'status'});
status.textContent = initial.configured ? '接続設定があります。変更時はURLとトークンを再入力してください。' : '未接続です。';
document.querySelector('#extension-origin').textContent = initial.extensionOrigin;
document.querySelector('#connect').addEventListener('submit', async event => {
  event.preventDefault();
  status.textContent = '接続中…';
  try {
    const url = new URL(document.querySelector('#origin').value);
    if (url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error('URLはホスト名とポートまで指定してください');
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1','localhost'].includes(url.hostname))) throw new Error('HTTPSのURLを指定してください');
    const granted = await chrome.permissions.request({origins:[`${url.origin}/*`]});
    if (!granted) throw new Error('接続権限が許可されませんでした');
    const response = await chrome.runtime.sendMessage({type:'configure',origin:url.origin,token:document.querySelector('#token').value,remember:document.querySelector('#remember').checked});
    if (response.error) throw new Error(response.error);
    document.querySelector('#token').value = '';
    status.textContent = '接続成功。Gmailを再読み込みしてください。';
  } catch(error) { status.textContent = error.message; }
});
document.querySelector('#disconnect').addEventListener('click', async () => {
  await chrome.runtime.sendMessage({type:'disconnect'});
  document.querySelector('#token').value = '';
  status.textContent = '接続を解除しました。Gmailの表示は次回更新時に消えます。';
});
