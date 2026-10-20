// Local-only article demo. Synthetic data and image fetch; never sends mail.
import {randomBytes} from 'node:crypto';
import {URL} from 'node:url';
import {loadConfig} from '../dist/config/env.js';
import {openDb,migrate} from '../dist/db/index.js';
import {buildServer} from '../dist/server/app.js';
import {addonTrack,addonLink} from '../dist/server/services/addon.js';
const port=18901;
const config=loadConfig({TRACKING_SECRET:randomBytes(36).toString('base64'),TRACKING_BASE_URL:`http://127.0.0.1:${port}`,DB_PATH:':memory:',FROM_EMAIL:'demo@example.com',MAIL_TRANSPORT:'dryrun',OUT_DIR:'out/demo',BIND_ADDRESS:'127.0.0.1',PORT:String(port),OPEN_IGNORE_SECONDS:'0',PROXY_PREFETCH_SECONDS:'0'});
const db=openDb(':memory:');migrate(db);
const tracked=addonTrack(db,config,{subject:'操作デモ：見積もりのご案内',to:['reader@example.com'],draftId:'local-article-demo'});
addonLink(db,config,{token:tracked.token,gmailMessageId:'a000000000000001',threadId:'a000000000000001',sentAt:Date.now()});
const app=buildServer({db,config,clock:()=>Date.now(),logger:false});
let opened=false;
app.get('/demo',async(_request,reply)=>{
 const row=db.prepare('SELECT open_count FROM recipients WHERE message_id = ? AND is_aggregate = 1').get(tracked.messageId);
 const count=row.open_count;const state=count?'● 開封の可能性あり':'○ シグナルなし';
 return reply.type('text/html').send(`<!doctype html><html lang="ja"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>openpost 操作デモ</title><style>*{box-sizing:border-box}body{margin:0;padding:44px;background:#eef5f0;color:#173f30;font:18px/1.7 system-ui}main{max-width:1240px;margin:auto}.eyebrow{font-weight:700;font-size:16px;color:#4d7660}h1{font-size:34px;margin:12px 0 10px}p{margin:8px 0}.badge{padding:10px 16px;background:#fff1cf;border-radius:8px;font-size:15px;color:#725919}.grid{display:grid;grid-template-columns:1.2fr 1fr;gap:26px;margin:32px 0}.card{background:white;border:1px solid #d2e1d6;border-radius:18px;padding:28px}.muted{color:#64806d;font-size:16px}h2{margin:4px 0 20px;font-size:23px}.subject{padding:18px 0;border-top:1px solid #e1e9e3;border-bottom:1px solid #e1e9e3;font-weight:700}.state{font-size:28px;color:#15744b;font-weight:750;margin:20px 0}.counter{font-size:52px;font-weight:750;line-height:1.4}.counter span{font-size:18px;font-weight:400}.help{font-size:15px;color:#64806d}button{background:#176b4c;color:white;border:0;padding:16px 24px;border-radius:10px;font:inherit;font-weight:700;cursor:pointer}button:disabled{background:#789c87}a{color:#176b4c}.footer{margin-top:24px;font-size:15px;color:#64806d}</style><main><div class="eyebrow">openpost / 自分用に変えられる、メール開封シグナル</div><h1>画像の取得が記録されると、表示が変わる</h1><div class="badge">架空データ・合成アクセスのローカルデモです。実Gmailの録画ではありません。</div><div class="grid"><section class="card"><div class="muted">架空の送信メール</div><h2>見積もりのご案内</h2><div class="subject">demo@example.com → reader@example.com</div><p>「送った」履歴に、画像取得の目安を追加します。</p><p class="state">${state}</p><p class="help">画像の取得は、本文を読んだ証明ではありません。</p></section><section class="card"><div class="muted">実際の記録処理を通した結果</div><h2>開封シグナル</h2><div class="counter">${count}<span> 回</span></div><p>${count?'取得記録が保存されました':'画像取得はまだ記録されていません'}</p><p class="help">記録はメモリ内。デモを終了すると消えます。</p></section></div><button id="open" ${count?'disabled':''}>${count?'記録済み：画像取得 1回':'画像取得をシミュレーション'}</button> <a href="/dashboard/messages/${tracked.messageId}">同じ記録を管理画面で見る</a><p class="footer">デモでは画面確認用に時間帯の除外を0秒にしています。実Gmailでは、下書き・先読み・照合待ちを分けて判断します。</p></main><script>document.querySelector('#open').onclick=async()=>{const r=await fetch('/demo/open',{method:'POST'});if(r.ok)location.reload();}</script></html>`);
});
app.post('/demo/open',async()=>{
 if(!opened){const result=await app.inject({method:'GET',url:new URL(tracked.pixelUrl).pathname,headers:{'user-agent':'Mozilla/5.0 LocalArticleDemo','accept':'image/gif'}});if(result.statusCode!==200)throw new Error('Demo pixel failed');opened=true;}
 return {ok:true};
});
await app.listen({host:'127.0.0.1',port});
console.log(`Synthetic local demo, no delivery: http://127.0.0.1:${port}/demo`);
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,async()=>{await app.close();db.close();process.exit(0);});
