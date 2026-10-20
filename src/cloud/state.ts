import { randomUUID } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
import Database from 'better-sqlite3';
import { migrate, type DB } from '../db/index.js';
import { StorageConflict, type ObjectStore } from './storage.js';

const STATE = 'openpost/state.sqlite.gz';
const LOCK = 'openpost/request-lock.json';
export class BusyState extends Error {}
export class SnapshotState {
  constructor(private store: ObjectStore, private clock:()=>number = Date.now) {}
  async run<T>(action: (db:DB)=>Promise<T>): Promise<T> {
    const owner = randomUUID();
    let lockGeneration: string;
    const lock = await this.store.get(LOCK);
    if (lock) {
      const value = JSON.parse(lock.bytes.toString()) as {expires:number};
      // Invalid lock is not permission to overwrite it.
      if (!Number.isFinite(value.expires) || value.expires > this.clock()) throw new BusyState('Another request owns the state');
    }
    const expires = this.clock()+120000;
    try {
      lockGeneration = await this.store.put(LOCK,Buffer.from(JSON.stringify({owner,expires})),lock?.generation ?? '0');
    } catch(error) {if(error instanceof StorageConflict) throw new BusyState('Concurrent state acquisition');throw error;}
    let db: DB | undefined;
    try {
      const snapshot = await this.store.get(STATE);
      const bytes = snapshot ? gunzipSync(snapshot.bytes,{maxOutputLength:16*1024*1024}) : undefined;
      db = new Database(bytes ?? ':memory:');
      db.pragma('foreign_keys = ON'); migrate(db);
      const changesBefore = db.prepare('SELECT total_changes() AS n').get() as {n:number};
      const result = await action(db);
      const changesAfter = db.prepare('SELECT total_changes() AS n').get() as {n:number};
      if (!snapshot || changesAfter.n !== changesBefore.n) {
        const currentLock = await this.store.get(LOCK);
        if (this.clock() >= expires || currentLock?.generation !== lockGeneration) throw new BusyState('State lease expired; response not committed');
        // A successful response is returned only after the full, consistent SQLite image is durable.
        const data = db.serialize();
        if(data.length>16*1024*1024) throw new Error('Cloud snapshot limit reached');
        await this.store.put(STATE,gzipSync(data),snapshot?.generation ?? '0');
      }
      return result;
    } finally {
      db?.close();
      // Conditional deletion never removes a lock another instance acquired after expiry.
      await this.store.remove(LOCK,lockGeneration).catch(()=>{});
    }
  }
}
