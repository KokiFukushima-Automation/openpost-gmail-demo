import { describe, expect, it } from 'vitest';
import { makeConfig } from '../helpers/setup.js';
import { buildCloudServer } from '../../src/cloud/server.js';
import { SnapshotState, BusyState } from '../../src/cloud/state.js';
import { StorageConflict, type ObjectStore, type StoredObject } from '../../src/cloud/storage.js';

class MemoryStore implements ObjectStore {
  values = new Map<string,StoredObject>();
  counter = 0;
  failState = false;
  async get(name:string) {const value=this.values.get(name);return value?{generation:value.generation,bytes:Buffer.from(value.bytes)}:null;}
  async put(name:string,bytes:Buffer,generation:string) {
    if(this.failState&&name.endsWith('sqlite.gz'))throw new Error('storage offline');
    const value=this.values.get(name);
    if((value?.generation??'0')!==generation)throw new StorageConflict('conflict');
    const next=String(++this.counter);this.values.set(name,{generation:next,bytes:Buffer.from(bytes)});return next;
  }
  async remove(name:string,generation:string) {
    if(this.values.get(name)?.generation!==generation)throw new StorageConflict('conflict');
    this.values.delete(name);
  }
}
const config=()=>makeConfig({apiToken:'cloud-test-token-long',addonEnabled:true,trackingBaseUrl:'https://track.example.com',openIgnoreSeconds:0,dashboardLive:false});
const auth={authorization:'Bearer cloud-test-token-long'};

describe('request-driven cloud persistence',()=>{
  it('tracks → links → records a pixel → restores from storage on a different server, with no guessed recipient',async()=>{
    const store=new MemoryStore();
    const first=buildCloudServer(config(),store);
    const track=await first.inject({method:'POST',url:'/api/addon/track',headers:auth,payload:{subject:'Cloud test',to:['test@example.com'],draftId:'draft-1'}});
    expect(track.statusCode).toBe(200);
    const tracked=track.json();
    const link=await first.inject({method:'POST',url:'/api/addon/link',headers:auth,payload:{token:tracked.token,gmailMessageId:'18fabc1234567890',threadId:'18fabc1234567890',sentAt:Date.now()-60000}});
    expect(link.statusCode).toBe(200);
    await first.close();
    const second=buildCloudServer(config(),store);
    const pixel=await second.inject({method:'GET',url:new URL(tracked.pixelUrl).pathname+'?v=test',headers:{'user-agent':'Mozilla/5.0 Chrome/130.0 Safari/537.36'}});
    expect(pixel.statusCode).toBe(200);expect(pixel.rawPayload.length).toBe(43);
    const lookup=await second.inject({method:'POST',url:'/api/threads/lookup',headers:auth,payload:{threadIds:['18fabc1234567890']}});
    expect(lookup.json().results[0].summary).toMatchObject({opens:1,recipients:1});
    const page=await second.inject({method:'GET',url:`/dashboard/messages/${tracked.messageId}`,headers:auth});
    expect(page.statusCode).toBe(200);expect(page.body).not.toContain('data-live="1"');
    expect(page.body).toContain('Refresh');
    expect(store.values.has('openpost/state.sqlite.gz')).toBe(true);
    expect(store.values.has('openpost/request-lock.json')).toBe(false);
    await second.close();
  });
  it('never acknowledges a state change when remote persistence fails',async()=>{
    const store=new MemoryStore();store.failState=true;
    const app=buildCloudServer(config(),store);
    const response=await app.inject({method:'POST',url:'/api/addon/track',headers:auth,payload:{subject:'Must not acknowledge',to:['test@example.com']}});
    expect(response.statusCode).toBe(500);expect(response.json()).toEqual({error:'state_unavailable'});
    expect(store.values.has('openpost/state.sqlite.gz')).toBe(false);await app.close();
  });
  it('serializes simultaneous requests across processes and recovers an expired lock conditionally',async()=>{
    const store=new MemoryStore();let now=1000;
    await store.put('openpost/request-lock.json',Buffer.from(JSON.stringify({owner:'other',expires:2000})),'0');
    const state=new SnapshotState(store,()=>now);
    await expect(state.run(async()=>true)).rejects.toBeInstanceOf(BusyState);
    now=3000;expect(await state.run(async()=>true)).toBe(true);
  });
  it('fences a request that outlives its lease instead of overwriting a later state',async()=>{
    const store=new MemoryStore();let now=1000;const state=new SnapshotState(store,()=>now);
    await expect(state.run(async db=>{db.prepare("INSERT INTO settings(key,value,updated_at)VALUES('proof','1',1000)").run();now+=121000;})).rejects.toBeInstanceOf(BusyState);
    expect(store.values.has('openpost/state.sqlite.gz')).toBe(false);
  });
  it('keeps authentication and private snapshot state off the public pixel surface',async()=>{
    const store=new MemoryStore();const app=buildCloudServer(config(),store);
    expect((await app.inject({method:'POST',url:'/api/addon/track',payload:{subject:'No token',to:['test@example.com']}})).statusCode).toBe(401);
    expect((await app.inject('/dashboard/events/stream')).statusCode).toBe(404);
    expect((await app.inject('/dashboard/assets/app.css')).statusCode).toBe(200);
    const manifest=(await app.inject('/dashboard/assets/manifest.webmanifest')).json();
    expect(manifest.share_target).toBeUndefined();
    expect(manifest.shortcuts).toEqual([{name:'Messages',url:'/dashboard/messages'}]);
    await app.close();
  });
});
