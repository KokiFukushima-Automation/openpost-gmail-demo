/** Small-instance GCS persistence. Generation preconditions fence every state update. */
export interface StoredObject { generation: string; bytes: Buffer }
export interface ObjectStore {
  get(name: string): Promise<StoredObject | null>;
  put(name: string, bytes: Buffer, generation: string): Promise<string>;
  remove(name: string, generation: string): Promise<void>;
}
export class StorageConflict extends Error {}
export class GcsStore implements ObjectStore {
  constructor(private bucket: string, private accessToken: () => Promise<string>, private fetcher: typeof fetch = fetch) {
    if (!/^[a-z0-9][a-z0-9._-]{1,220}[a-z0-9]$/.test(bucket)) throw new Error('Invalid state bucket');
  }
  private async request(url: string, init: RequestInit = {}): Promise<Response> {
    const response = await this.fetcher(url, {...init,redirect:'error',signal:AbortSignal.timeout(15000),headers:{...init.headers,authorization:`Bearer ${await this.accessToken()}`}});
    if (response.status === 412) throw new StorageConflict('State generation changed');
    if (!response.ok && response.status !== 404) throw new Error(`State storage HTTP ${response.status}`);
    return response;
  }
  async get(name: string): Promise<StoredObject | null> {
    const url = `https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(this.bucket)}/o/${encodeURIComponent(name)}`;
    const metadata = await this.request(`${url}?fields=generation,size`);
    if (metadata.status === 404) return null;
    const info = await metadata.json() as {generation:string;size:string};
    if (!/^\d+$/.test(info.generation) || Number(info.size) > 16*1024*1024) throw new Error('State object too large or invalid');
    const response = await this.request(`${url}?alt=media&ifGenerationMatch=${info.generation}`);
    if (!response.ok) throw new Error('State object disappeared');
    return {generation:info.generation,bytes:Buffer.from(await response.arrayBuffer())};
  }
  async put(name: string, bytes: Buffer, generation: string): Promise<string> {
    const url = new URL(`https://storage.googleapis.com/upload/storage/v1/b/${encodeURIComponent(this.bucket)}/o`);
    url.searchParams.set('uploadType','media'); url.searchParams.set('name',name);url.searchParams.set('ifGenerationMatch',generation);
    const res = await this.request(url.href,{method:'POST',headers:{'content-type':'application/octet-stream'},body:new Uint8Array(bytes)});
    if (!res.ok) throw new Error('State upload failed');
    return (await res.json() as {generation:string}).generation;
  }
  async remove(name: string, generation: string): Promise<void> {
    await this.request(`https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(this.bucket)}/o/${encodeURIComponent(name)}?ifGenerationMatch=${generation}`,{method:'DELETE'});
  }
}

let cachedToken: {value:string;expires:number} | undefined;
export async function metadataAccessToken(): Promise<string> {
  if (cachedToken && cachedToken.expires > Date.now()+60000) return cachedToken.value;
  const res = await fetch('http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token',{headers:{'Metadata-Flavor':'Google'},signal:AbortSignal.timeout(5000),redirect:'error'});
  if (!res.ok) throw new Error('Cloud identity unavailable');
  const data = await res.json() as {access_token:string;expires_in:number};
  cachedToken = {value:data.access_token,expires:Date.now()+data.expires_in*1000};
  return cachedToken.value;
}
