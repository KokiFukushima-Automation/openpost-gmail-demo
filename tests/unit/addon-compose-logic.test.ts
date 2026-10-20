import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

function load(status = 200) {
  const calls: Array<{url:string; options:{payload:string; followRedirects:boolean}}> = [];
  const saved = new Map<string,string>([['OPENPOST_BASE_URL','https://tracking.example.com'],['OPENPOST_TOKEN','private-api-token']]);
  let inserts = 0;
  let callback = '';
  const builder = () => {
    const chain = new Proxy({} as Record<string,unknown>, {get: (_target,key) => key === 'build' ? () => ({built:true}) : (...args:unknown[]) => {
      if (key === 'addUpdateContent') inserts++;
      if (key === 'setFunctionName') callback = String(args[0]);
      return chain;
    }});
    return chain;
  };
  const CardService = new Proxy({ContentType:{IMMUTABLE_HTML:'html'},UpdateDraftBodyType:{IN_PLACE_INSERT:'insert'}} as Record<string,unknown>,{get:(target,key)=> target[String(key)] ?? builder});
  const ctx = vm.createContext({CardService,Utilities:{getUuid:()=> 'one-draft'},PropertiesService:{getUserProperties:()=>({getProperty:(k:string)=>saved.get(k),setProperty:(k:string,v:string)=>saved.set(k,v)})},UrlFetchApp:{fetch:(url:string,options:{payload:string;followRedirects:boolean})=>{calls.push({url,options});return {getResponseCode:()=>status,getContentText:()=>JSON.stringify({token:'issued-token',pixelHtml:'<img src="https://tracking.example.com/p/issued-token">'})};}}});
  vm.runInContext(readFileSync('addon/Code.gs','utf8'),ctx);
  return {trigger:()=>vm.runInContext('onComposeTrack()',ctx),apply:(event:unknown)=>{ctx.event=event;return vm.runInContext('applyComposeTrack(event)',ctx);},calls,saved,get inserts(){return inserts;},get callback(){return callback;}};
}
describe('Gmail compose host contract',()=>{
  it('opens a card without registering a tracking message until its insert button is clicked',()=>{
    const addon=load(); expect(Array.isArray(addon.trigger())).toBe(true);
    expect(addon.callback).toBe('applyComposeTrack'); expect(addon.calls).toHaveLength(0);
  });
  it('uses the Gmail event recipient fields and a stable card action id',()=>{
    const addon=load(); addon.apply({gmail:{toRecipients:['self@example.com']},parameters:{draftId:'stable-card-id'},commonEventObject:{formInputs:{trackingSubject:{stringInputs:{value:['Test label']}}}}});
    expect(addon.calls).toHaveLength(1); expect(JSON.parse(addon.calls[0]!.options.payload)).toMatchObject({to:['self@example.com'],subject:'Test label',draftId:'stable-card-id'});
    expect(addon.calls[0]!.options.followRedirects).toBe(false);expect(addon.inserts).toBe(1);expect(addon.saved.has('pending.issued-token')).toBe(true);
  });
  it('does not insert a pixel or save a pending linkage on server rejection or missing recipients',()=>{
    const rejected=load(503);rejected.apply({gmail:{toRecipients:['self@example.com']}});
    expect(rejected.inserts).toBe(0);expect(rejected.saved.has('pending.issued-token')).toBe(false);
    const empty=load();empty.apply({gmail:{toRecipients:[]}});expect(empty.calls).toHaveLength(0);expect(empty.inserts).toBe(0);
  });
});
