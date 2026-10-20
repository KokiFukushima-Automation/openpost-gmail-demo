// Local-only, disposable demonstration: no credentials, real recipients or delivery.
import {randomBytes} from 'node:crypto';
import {loadConfig} from '../dist/config/env.js';
import {openDb,migrate} from '../dist/db/index.js';
import {seedDemo} from '../dist/db/seed.js';
import {buildServer} from '../dist/server/app.js';
const port = 18878;
const config = loadConfig({
  TRACKING_SECRET:randomBytes(36).toString('base64'),
  TRACKING_BASE_URL:`http://127.0.0.1:${port}`,
  DB_PATH:':memory:', FROM_EMAIL:'demo@example.com',MAIL_TRANSPORT:'dryrun',
  OUT_DIR:'out/demo',BIND_ADDRESS:'127.0.0.1',PORT:String(port),
});
const db = openDb(':memory:');migrate(db);
seedDemo(db,{seed:7,nowMs:Date.now(),messages:12,reset:false,force:false});
const app = buildServer({db,config,clock:()=>Date.now()});
await app.listen({host:'127.0.0.1',port});
console.log(`Demo only (no delivery): http://127.0.0.1:${port}/dashboard/messages`);
for (const signal of ['SIGINT','SIGTERM']) process.on(signal,async()=>{await app.close();db.close();process.exit(0);});
