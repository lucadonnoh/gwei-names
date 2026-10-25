// Network stats for gwei.domains, read from NameNFT's events once here instead of by every visitor
// (a first visit's scan was about 700 KB of logs): names and free subdomains registered, top-level
// names by label length, the ETH locked in NameNFT, and the names serving a website, newest first.
//
// Top-level names have an expiry, free subdomains don't; "burned" is NameNFT's balance (no withdraw
// exists, so collected fees stay locked). It shares the post index's Durable Object, SQLite storage, cron and RPC rules (posts-store.js): the
// owner's node is trusted, public endpoints count only when two return the same logs.

const NAMENFT = '0x9d51d507bc7264d4fe8ad1cf7fe191933a0a81d6';
const DEPLOY_BLOCK = 25403689; // NameNFT's deployment
const T_NAME = '0xe9b829b8676c143f46f458c54ab9eedea80dc58eaec9c3df7e0134aabf7f9d28'; // NameRegistered
const T_CONTENTHASH = '0xe379c1624ed7e714cc0937528a32359d69d5281337765313dba4e081b72d7578'; // ContenthashChanged
const T_TEXT = '0xd8c9334b1a9c2f9da342a0a2b32629c1a229b6445dad78947f674b44444a7550'; // TextChanged
const K_CONTENTCONTRACT = '0x58d1a44eb778f49875f62ace52dcda3a77ed4f1b085b6668edba23e2aea510ec'; // keccak256('contentcontract')
const CONFIRMATIONS = 2;
// The owner's node answers big ranges; a refused range is halved down to what public endpoints take.
const MAX_RANGE = 50_000, MIN_RANGE = 2_000, RANGES_PER_SYNC = 10;
const READY_LAG = 100; // blocks behind the head at which the index counts as caught up
export const HIST_CAP = 20; // label lengths from 20 bytes up share one bucket
const SITES = 50;
const SCHEMA_VERSION = '1';

const SCHEMA = [
  // Every name ever registered; a re-registration overwrites it (top = it has an expiry, i.e. not a free subdomain).
  'CREATE TABLE IF NOT EXISTS stat_names (node TEXT PRIMARY KEY, label TEXT NOT NULL, len INTEGER NOT NULL, top INTEGER NOT NULL)',
  // A name's website records: the byte length and block of its last contenthash and contentcontract.
  'CREATE TABLE IF NOT EXISTS stat_sites (node TEXT PRIMARY KEY, ch_len INTEGER, ch_block INTEGER, cc_len INTEGER, cc_block INTEGER)',
];

export class StatsStore {
  // chain: { head(), logs(filter), rpc(method, params) }, the post store's RPC methods.
  constructor(sql, chain) {
    this.sql = sql;
    this.chain = chain;
    this.syncing = null;
    sql.exec('CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)');
    if (this.meta('stats_schema') !== SCHEMA_VERSION) {
      sql.exec('DROP TABLE IF EXISTS stat_names');
      sql.exec('DROP TABLE IF EXISTS stat_sites');
      sql.exec("DELETE FROM meta WHERE k IN ('stats_cursor', 'stats_head', 'stats_burned')");
      this.setMeta('stats_schema', SCHEMA_VERSION);
    }
    for (const statement of SCHEMA) sql.exec(statement);
  }

  meta(key) {
    return this.sql.exec('SELECT v FROM meta WHERE k = ?', key).toArray()[0]?.v ?? null;
  }

  setMeta(key, value) {
    this.sql.exec('INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v', key, String(value));
  }

  sync() {
    if (!this.syncing) this.syncing = this.#sync().finally(() => { this.syncing = null; });
    return this.syncing;
  }

  async #sync() {
    const head = await this.chain.head();
    const safe = head - CONFIRMATIONS;
    let cursor = Number(this.meta('stats_cursor') ?? DEPLOY_BLOCK - 1);
    let range = MAX_RANGE, events = 0;
    for (let n = 0; n < RANGES_PER_SYNC && cursor < safe; n++) {
      const from = cursor + 1;
      const to = Math.min(safe, from + range - 1);
      let logs;
      try {
        logs = await this.chain.logs({ address: NAMENFT, fromBlock: '0x' + from.toString(16), toBlock: '0x' + to.toString(16), topics: [[T_NAME, T_CONTENTHASH, T_TEXT]] });
      } catch (error) {
        if (range <= MIN_RANGE) throw error;
        range = Math.max(MIN_RANGE, Math.ceil(range / 2));
        continue;
      }
      events += this.ingest(logs);
      cursor = to;
      this.setMeta('stats_cursor', cursor);
    }
    this.setMeta('stats_head', safe);
    try {
      this.setMeta('stats_burned', BigInt(await this.chain.rpc('eth_getBalance', [NAMENFT, 'latest'])).toString());
    } catch (_) {}
    return { cursor, events };
  }

  ingest(logs) {
    let events = 0;
    for (const log of logs) {
      if (log.removed || log.address?.toLowerCase() !== NAMENFT || !log.topics?.[1]) continue;
      const node = log.topics[1].toLowerCase();
      const data = (log.data || '0x').slice(2);
      const word = (i) => data.slice(i * 64, (i + 1) * 64);
      const block = Number(BigInt(log.blockNumber));
      if (log.topics[0] === T_NAME) {
        // NameRegistered(uint256 indexed id, string label, address indexed owner, uint256 expiresAt): [offset, expiresAt, length, label]
        const len = Number(BigInt('0x' + (word(2) || '0')));
        const label = new TextDecoder().decode(hexBytes(data.slice(192, 192 + len * 2)));
        const top = BigInt('0x' + (word(1) || '0')) > 0n ? 1 : 0;
        this.sql.exec('INSERT INTO stat_names (node, label, len, top) VALUES (?, ?, ?, ?) ON CONFLICT (node) DO UPDATE SET label = excluded.label, len = excluded.len, top = excluded.top', node, label, len, top);
        // A re-registration starts a new record version: the previous owner's website records are gone.
        this.sql.exec('DELETE FROM stat_sites WHERE node = ?', node);
      } else if (log.topics[0] === T_CONTENTHASH) {
        this.site(node, 'ch', Number(BigInt('0x' + (word(1) || '0'))), block);
      } else if (log.topics[0] === T_TEXT && log.topics[2]?.toLowerCase() === K_CONTENTCONTRACT) {
        // Only the length matters: an empty value clears the record.
        this.site(node, 'cc', Number(BigInt('0x' + (word(1) || '0'))), block);
      } else continue;
      events++;
    }
    return events;
  }

  site(node, kind, len, block) {
    this.sql.exec(`INSERT INTO stat_sites (node, ${kind}_len, ${kind}_block) VALUES (?, ?, ?) ` +
      `ON CONFLICT (node) DO UPDATE SET ${kind}_len = excluded.${kind}_len, ${kind}_block = excluded.${kind}_block`, node, len, block);
  }

  stats() {
    const one = (query, ...params) => this.sql.exec(query, ...params).toArray()[0];
    const cursor = Number(this.meta('stats_cursor') ?? DEPLOY_BLOCK - 1);
    const head = Number(this.meta('stats_head') ?? 0);
    const lengths = {};
    for (const { l, n } of this.sql.exec(`SELECT MIN(len, ${HIST_CAP}) AS l, COUNT(*) AS n FROM stat_names WHERE top = 1 GROUP BY l`).toArray()) lengths[l] = n;
    // A site is the contenthash when set (the gateway serves it first), else the contentcontract
    // record, dated by the record being served. Top-level names only: a subdomain has no gateway host.
    const sites = this.sql.exec(
      'SELECT n.label FROM stat_names n JOIN stat_sites s ON s.node = n.node WHERE n.top = 1 AND (s.ch_len > 0 OR s.cc_len > 0) ' +
      'ORDER BY CASE WHEN s.ch_len > 0 THEN s.ch_block ELSE s.cc_block END DESC LIMIT ?', SITES,
    ).toArray().map((r) => r.label);
    return {
      ready: head > 0 && cursor >= head - READY_LAG,
      block: cursor,
      names: one('SELECT COUNT(*) AS n FROM stat_names WHERE top = 1').n,
      subdomains: one('SELECT COUNT(*) AS n FROM stat_names WHERE top = 0').n,
      burnedWei: this.meta('stats_burned'),
      lengths,
      sites,
    };
  }
}

function hexBytes(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}
