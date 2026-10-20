import { loadConfig } from '../config/env.js';
import { GcsStore, metadataAccessToken } from './storage.js';
import { buildCloudServer } from './server.js';
const bucket=process.env.OPENPOST_GCS_BUCKET;
if(!bucket)throw new Error('OPENPOST_GCS_BUCKET is required');
const config=loadConfig({...process.env,DASHBOARD_LIVE:'false',COMPOSE_ENABLED:'false',JOBS_ENABLED:'false',NOTIFY_ENABLED:'false',MAIL_TRANSPORT:'dryrun'});
const app=buildCloudServer(config,new GcsStore(bucket,metadataAccessToken));
await app.listen({host:config.bindAddress,port:config.port});
for(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>{void app.close().then(()=>process.exit(0));});
