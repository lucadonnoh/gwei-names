// Used by test_poster.py: runs the gateway's post index (gateway/posts-store.js) against a local chain
// and prints what it shows for a name, so the end-to-end test can check the whole loop.
//   node index_check.mjs <rpc> <contract> <blobscan> <token> <owner> <post-bytes-hex>
import { DatabaseSync } from 'node:sqlite';
import { PostStore } from '../../gateway/posts-store.js';

const [rpc, contract, blobscan, token, owner, postHex] = process.argv.slice(2);
const db = new DatabaseSync(':memory:');
const sql = {
  exec(query, ...params) {
    const statement = db.prepare(query);
    const args = params.map((p) => (p instanceof ArrayBuffer ? new Uint8Array(p) : p));
    if (/^\s*(SELECT|WITH)/i.test(query)) { const rows = statement.all(...args); return { toArray: () => rows }; }
    statement.run(...args);
    return { toArray: () => [] };
  },
};
const store = new PostStore(sql, { POSTS_CONTRACT: contract, POSTS_FROM_BLOCK: '1', RPC_URL: rpc, BLOB_SOURCES: JSON.stringify({ blobscan, beacons: [] }) });
console.error(JSON.stringify(store.upload(Uint8Array.from(Buffer.from(postHex, 'hex')), 'test')));
const result = await store.sync();
console.error(JSON.stringify(result));
console.log(JSON.stringify(store.forToken('0x' + BigInt(token).toString(16).padStart(64, '0'), owner)));
