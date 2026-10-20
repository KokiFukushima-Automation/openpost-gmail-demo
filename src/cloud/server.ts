import Fastify from 'fastify';
import { fileURLToPath } from 'node:url';
import type { AppConfig } from '../config/env.js';
import { assertSafeToBind, assertSafeToServeDashboard } from '../config/env.js';
import { buildServer } from '../server/app.js';
import { loadDashboardAssets } from '../server/assets/index.js';
import { loadRangeIndex, EMPTY_RANGE_INDEX } from '../core/ranges.js';
import { VERSION } from '../version.js';
import { EXPECTED_SCHEMA } from '../db/index.js';
import { BusyState, SnapshotState } from './state.js';
import type { ObjectStore } from './storage.js';

/** Request-driven cloud profile: no background jobs or permanent SSE connections. */
export function buildCloudServer(config:AppConfig,store:ObjectStore) {
  assertSafeToBind(config); assertSafeToServeDashboard(config,config.dashboardBind,config.bindAddress);
  if (config.mailTransport !== 'dryrun') throw new Error('Cloud snapshot profile supports tracking/add-on only; real sends use Gmail, not this request runner');
  const app = Fastify({logger:false,bodyLimit:config.composeMaxBodyBytes+65536});
  app.removeAllContentTypeParsers();
  app.addContentTypeParser('*',{parseAs:'buffer'},(_req,body,done)=>done(null,body));
  const assets = loadDashboardAssets(fileURLToPath(new URL('../server/assets/',import.meta.url)));
  const cloudManifest = JSON.parse(assets.get('manifest.webmanifest')!.body.toString()) as Record<string,unknown>;
  delete cloudManifest.share_target;
  cloudManifest.shortcuts = [{name:'Messages',url:'/dashboard/messages'}];
  const ranges = config.rangesEnabled ? loadRangeIndex(config.rangesDir) : EMPTY_RANGE_INDEX;
  const state = new SnapshotState(store);
  const health = async()=>({ok:true,version:VERSION,schema:EXPECTED_SCHEMA,expectedSchema:EXPECTED_SCHEMA,storage:'gcs-snapshot',profile:'tracking-addon'});
  app.get('/health',health); // Cloud Run reserves /healthz before requests reach the container.
  app.get('/healthz',health);
  // Static requests do not touch the DB or acquire a state lock.
  app.get('/dashboard/assets/:name',async(req,reply)=>{
    const asset=assets.get((req.params as {name:string}).name);
    if(!asset) return reply.code(404).send({error:'not_found'});
    if((req.params as {name:string}).name==='manifest.webmanifest') {
      return reply.header('Cache-Control',asset.cacheControl).type(asset.type).send(JSON.stringify(cloudManifest));
    }
    if((req.params as {name:string}).name==='sw.js')reply.header('Service-Worker-Allowed','/dashboard/');
    return reply.header('Cache-Control',asset.cacheControl).type(asset.type).send(asset.body);
  });
  app.route({method:['GET','HEAD','POST','DELETE','OPTIONS'],url:'/*',handler:async(req,reply)=>{
    if(req.url.split('?')[0]?.endsWith('/events/stream')) return reply.code(404).send({error:'cloud_profile_uses_manual_refresh'});
    try {
      const response = await state.run(async db=>{
        const backend = buildServer({db,config:{...config,dashboardLive:false,composeEnabled:false},ranges,logger:false});
        try {
          return await backend.inject({method:req.method as 'GET'|'HEAD'|'POST'|'DELETE'|'OPTIONS',url:req.url,headers:req.headers,payload:req.body as Buffer,remoteAddress:req.ip});
        }finally{await backend.close();}
      });
      reply.code(response.statusCode);
      for(const [key,value]of Object.entries(response.headers)) {
        if(value!==undefined&&!['connection','transfer-encoding','keep-alive'].includes(key)) reply.header(key,value);
      }
      return reply.send(response.rawPayload);
    }catch(error){
      // Failure never acknowledges an uncommitted pixel, add-on registration, or state change.
      reply.header('Cache-Control','no-store').header('Retry-After','2');
      return reply.code(error instanceof BusyState?503:500).send({error:error instanceof BusyState?'state_busy':'state_unavailable'});
    }
  }});
  return app;
}
