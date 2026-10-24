import { DurableObject } from 'cloudflare:workers';
import { PostStore } from './posts-store.js';

// One instance holds the whole post index in its SQLite storage (see posts-store.js). The cron
// trigger calls sync() every minute; pages and the /api routes read through the other methods.
export class PostIndex extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.store = new PostStore(ctx.storage.sql, env);
  }

  upload(bytes, ip) { return this.store.upload(new Uint8Array(bytes), ip); }
  raw(hash) { return this.store.raw(hash); }
  blobBytes(vh) { return this.store.blobBytes(vh); }
  detail(hash) { return this.store.detail(hash); }
  forToken(token, owner, limit) { return this.store.forToken(token, owner, limit); }
  postForToken(token, owner, prefix) { return this.store.postForToken(token, owner, prefix); }
  bodies(hashes) { return hashes.map((hash) => this.store.detail(hash)?.body ?? null); }
  recent(limit) { return this.store.recent(limit); }
  async forCurrentOwner(token, limit) {
    const owner = (await this.store.currentOwners([token])).get(token);
    return owner ? this.store.forToken(token, owner, limit) : [];
  }
  sync() { return this.store.sync(); }
  poke() { return this.store.poke(); }
}
