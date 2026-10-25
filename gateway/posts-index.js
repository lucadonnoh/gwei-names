import { DurableObject } from 'cloudflare:workers';
import { PostStore } from './posts-store.js';
import { StatsStore } from './stats-store.js';

// One instance holds the whole post index in its SQLite storage (see posts-store.js), and the
// network stats beside it (stats-store.js). The cron trigger calls sync() every minute; pages and
// the /api routes read through the other methods.
export class PostIndex extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.store = new PostStore(ctx.storage.sql, env);
    this.stats = new StatsStore(ctx.storage.sql, this.store);
  }

  upload(bytes, ip) { return this.store.upload(new Uint8Array(bytes), ip); }
  raw(hash) { return this.store.raw(hash); }
  blobBytes(vh) { return this.store.blobBytes(vh); }
  detail(hash) { return this.store.detail(hash); }
  forToken(token, owner, limit) { return this.store.forToken(token, owner, limit); }
  postForToken(token, owner, prefix) { return this.store.postForToken(token, owner, prefix); }
  bodies(hashes) { return hashes.map((hash) => this.store.body(hash)); }
  recent(limit) { return this.store.recent(limit); }
  archive(after, limit) { return this.store.archive(after, limit); }
  paidBy(author, limit) { return this.store.paidBy(author, limit); }
  async forCurrentOwner(token, limit) {
    const owner = (await this.store.currentOwners([token])).get(token);
    return owner ? this.store.forToken(token, owner, limit) : [];
  }
  // Posts and stats sync side by side; one failing doesn't stop the other.
  async sync() {
    const [posts, stats] = await Promise.allSettled([this.store.sync(), this.stats.sync()]);
    if (posts.status === 'rejected' && stats.status === 'rejected') throw posts.reason;
    return {
      ...(posts.status === 'fulfilled' ? posts.value : { postsError: String(posts.reason?.message || posts.reason).slice(0, 200) }),
      stats: stats.status === 'fulfilled' ? stats.value : { error: String(stats.reason?.message || stats.reason).slice(0, 200) },
    };
  }
  networkStats() { return this.stats.stats(); }
  poke() { return this.store.poke(); }
}
