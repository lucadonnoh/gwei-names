#!/usr/bin/env python3
"""The gwei.domains publisher for GNS posts (posts/SPEC.md).

It watches GnsPosts for PostAuthorized events that name this publisher, fetches each post's bytes
from the gateway API (checking them against the authorized hash), packs them into a blob and sends
one blob transaction calling GnsPosts.publish(). A batch goes out once the fees its authors paid
cover the transaction's cost at current prices. It also keeps a copy of every blob that carries an
authorized post, from any publisher, pinned on the local IPFS node after checking it against its
versioned hash.

It holds a hot key with a small balance and talks only to the local node, the gateway API and the
local IPFS API. State lives in one SQLite file.

  gwei_poster.py keygen PATH   create a key file (mode 0400) and print its address
  gwei_poster.py address       print the configured key's address
  gwei_poster.py status        print balance, cursor and job counts
  gwei_poster.py run           publish forever
"""

import hashlib
import json
import logging
import os
import secrets
import sqlite3
import sys
import time
import urllib.error
import urllib.request

import ckzg
from coincurve import PrivateKey
from Crypto.Hash import keccak as _keccak

log = logging.getLogger("gwei-poster")

T_AUTHORIZED = "0x60bb4b36f4267731c8172311f0cc8b8b570684bb18146de3eecd621a3d2d6b99"
T_PUBLISHED = "0xb6a6d902d5e84c31e56c5494561be47a4365c35aa01be024ce175b76f1e1312e"
SEL_PUBLISH = bytes.fromhex("efeb21dd")  # publish(bytes32[][])

FIELD_ELEMENTS = 4096
BLOB_BYTES = FIELD_ELEMENTS * 32
PAYLOAD_BYTES = FIELD_ELEMENTS * 31
MAGIC = b"gwei\x01"
MAX_POST_BYTES = PAYLOAD_BYTES - len(MAGIC) - 3
BLOB_GAS = 131072
GWEI = 10**9

# Defaults; the comments say what each one defends against.
CONFIRMATIONS = 3  # an authorization reorged out after we publish would be a publish nobody paid for
LOG_RANGE = 2000
MIN_TIP = GWEI // 20  # 0.05 gwei
MAX_TIP = 2 * GWEI  # others' transactions move the node's tip suggestion; never follow it far
GAS_BASE = 23_000  # measured: a publish() blob transaction uses 22.3k gas plus 2.5k per post
GAS_PER_POST = 2_600
MAX_BATCH = 200  # 0.5M gas, far below the 2^24 per-transaction cap however small the posts are
MIN_HEADROOM = 1.125  # fee caps must survive at least one block of base-fee growth
REPLACE_AFTER_BLOCKS = 3  # priced out for this long: replace (within what was paid)
REPLACE_STALE_BLOCKS = 25  # includable but ignored for this long: replace too
REBROADCAST_AFTER_BLOCKS = 10
MAX_REVERTS = 1  # publish() can't revert in practice; if it does, never pay for it twice
FETCHES_PER_STEP = 20  # post-byte downloads per pass, so a flood of jobs can't stall the loop
FETCH_TIMEOUT = 8
FETCH_BUDGET_SECONDS = 30
DROPPED_AFTER_BLOCKS = 3  # a used nonce with no receipt of ours: wait this long before requeueing
MIRRORS_PER_STEP = 3
BYTES_GIVE_UP_SECONDS = 3 * 86400
MIRROR_GIVE_UP_SECONDS = 30 * 86400

def keccak(data: bytes) -> bytes:
    return _keccak.new(digest_bits=256, data=data).digest()


# --- RLP ------------------------------------------------------------------------------------------
def rlp(item) -> bytes:
    if isinstance(item, int):
        if item < 0:
            raise ValueError("negative integer")
        item = item.to_bytes((item.bit_length() + 7) // 8, "big") if item else b""
    if isinstance(item, (bytes, bytearray)):
        item = bytes(item)
        if len(item) == 1 and item[0] < 0x80:
            return item
        return _rlp_length(len(item), 0x80) + item
    if isinstance(item, list):
        body = b"".join(rlp(x) for x in item)
        return _rlp_length(len(body), 0xC0) + body
    raise TypeError(f"can't RLP-encode {type(item)}")


def _rlp_length(length: int, offset: int) -> bytes:
    if length < 56:
        return bytes([offset + length])
    encoded = length.to_bytes((length.bit_length() + 7) // 8, "big")
    return bytes([offset + 55 + len(encoded)]) + encoded


# --- formats (gateway/posts-format.js) -------------------------------------------------------------
def encode_blob(posts: list) -> bytes:
    """Posts → one blob in the "gwei" v1 container."""
    payload = bytearray(MAGIC)
    for post in posts:
        if not 0 < len(post) <= MAX_POST_BYTES:
            raise ValueError("post size")
        payload += len(post).to_bytes(3, "big") + post
    if len(payload) > PAYLOAD_BYTES:
        raise ValueError("posts don't fit in one blob")
    payload += bytes(PAYLOAD_BYTES - len(payload))
    blob = bytearray(BLOB_BYTES)
    for i in range(FIELD_ELEMENTS):
        blob[i * 32 + 1:(i + 1) * 32] = payload[i * 31:(i + 1) * 31]
    return bytes(blob)


def decode_blob(blob: bytes) -> list:
    if len(blob) != BLOB_BYTES or any(blob[i * 32] for i in range(FIELD_ELEMENTS)):
        return []
    payload = b"".join(blob[i * 32 + 1:(i + 1) * 32] for i in range(FIELD_ELEMENTS))
    if not payload.startswith(MAGIC):
        return []
    posts, at = [], len(MAGIC)
    while at + 3 <= len(payload):
        length = int.from_bytes(payload[at:at + 3], "big")
        if length == 0 or at + 3 + length > len(payload):
            break
        posts.append(payload[at + 3:at + 3 + length])
        at += 3 + length
    return posts


def fits(posts: list) -> bool:
    return len(MAGIC) + sum(3 + len(p) for p in posts) <= PAYLOAD_BYTES


def publish_calldata(hashes: list) -> bytes:
    """publish(bytes32[][]) with every hash in blob 0."""
    word = lambda n: n.to_bytes(32, "big")
    return SEL_PUBLISH + word(32) + word(1) + word(32) + word(len(hashes)) + b"".join(hashes)


def versioned_hash(commitment: bytes) -> bytes:
    return b"\x01" + hashlib.sha256(commitment).digest()[1:]


# --- transactions ---------------------------------------------------------------------------------
class Signer:
    def __init__(self, secret: bytes):
        self.key = PrivateKey(secret)
        self.address = "0x" + keccak(self.key.public_key.format(compressed=False)[1:])[-20:].hex()

    def sign(self, digest: bytes):
        sig = self.key.sign_recoverable(digest, hasher=None)
        return sig[64], int.from_bytes(sig[:32], "big"), int.from_bytes(sig[32:64], "big")


def blob_transaction(signer, *, chain_id, nonce, tip, max_fee, gas, to, data, max_blob_fee, blob, setup, wrapper_version=1):
    """A signed EIP-4844 transaction in its network form, and its hash.

    wrapper_version 1 is the Fusaka (EIP-7594) wrapper with 128 cell proofs per blob; 0 is the
    original EIP-4844 wrapper with one blob proof."""
    commitment = ckzg.blob_to_kzg_commitment(blob, setup)
    vh = versioned_hash(commitment)
    fields = [chain_id, nonce, tip, max_fee, gas, bytes.fromhex(to[2:]), 0, data, [], max_blob_fee, [vh]]
    y_parity, r, s = signer.sign(keccak(b"\x03" + rlp(fields)))
    signed = fields + [y_parity, r, s]
    tx_hash = "0x" + keccak(b"\x03" + rlp(signed)).hex()
    if wrapper_version == 1:
        _, proofs = ckzg.compute_cells_and_kzg_proofs(blob, setup)
        network = [signed, 1, [blob], [commitment], list(proofs)]
    else:
        network = [signed, [blob], [commitment], [ckzg.compute_blob_kzg_proof(blob, commitment, setup)]]
    return "0x" + (b"\x03" + rlp(network)).hex(), tx_hash, "0x" + vh.hex()


def expected_gas(n_posts: int) -> int:
    return GAS_BASE + GAS_PER_POST * n_posts


def gas_limit(n_posts: int) -> int:
    return expected_gas(n_posts) * 5 // 4 + 5_000


def batch_cost(n_posts: int, base_fee: int, tip: int, blob_base_fee: int) -> int:
    """What a blob transaction carrying n posts should cost at these prices."""
    return expected_gas(n_posts) * (base_fee + tip) + BLOB_GAS * blob_base_fee


def worst_case(gas: int, max_fee: int, max_blob_fee: int) -> int:
    """The most a transaction with these caps can ever spend."""
    return gas * max_fee + BLOB_GAS * max_blob_fee


def fee_caps(paid: int, gas: int, base_fee: int, tip: int, blob_base_fee: int):
    """Fee caps with up to 2x headroom over current prices, cut down so that even the worst case
    spends no more than `paid`. None if `paid` can't buy MIN_HEADROOM."""
    for blob_headroom in (2.0, MIN_HEADROOM):
        max_blob_fee = max(int(blob_headroom * blob_base_fee), 1)
        max_fee = min(2 * base_fee + tip, (paid - BLOB_GAS * max_blob_fee) // gas)
        if max_fee >= int(MIN_HEADROOM * base_fee) + tip:
            return max_fee, max_blob_fee
    return None


def min_fee(base_fee: int, tip: int, blob_base_fee: int) -> int:
    """The least one post must pay to be carried now: a one-post transaction's worst case at
    MIN_HEADROOM. Any batch of posts that each pay this can be capped within what they paid."""
    return worst_case(gas_limit(1), int(MIN_HEADROOM * base_fee) + tip, max(int(MIN_HEADROOM * blob_base_fee), 1))


def quote(base_fee: int, tip: int, blob_base_fee: int) -> int:
    """What the dapp pays per post: three times the expected cost, so prices can rise before the
    batch goes out (posts/SPEC.md)."""
    return 3 * batch_cost(1, base_fee, tip, blob_base_fee)


# --- I/O ------------------------------------------------------------------------------------------
class RpcError(Exception):
    pass


def http(url, data=None, headers=None, timeout=20, method=None):
    request = urllib.request.Request(url, data=data, method=method, headers={"user-agent": "gwei-poster", **(headers or {})})
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return response.status, response.read()


class Rpc:
    def __init__(self, url):
        self.url = url

    def __call__(self, method, *params):
        body = json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": list(params)}).encode()
        _, raw = http(self.url, body, {"content-type": "application/json"}, timeout=30)
        reply = json.loads(raw)
        if reply.get("error"):
            raise RpcError(f"{method}: {reply['error'].get('message', reply['error'])}")
        return reply.get("result")


SCHEMA = """
CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
-- Every event processed once, even if a pass is retried or a reorg moves its transaction to
-- another block: keyed by transaction and content, not position.
CREATE TABLE IF NOT EXISTS seen (key TEXT PRIMARY KEY);
-- Posts authorized with this publisher. fee is the total paid to us for the hash (wei, as text);
-- fee_gwei is its floor in gwei, for filtering in SQL.
CREATE TABLE IF NOT EXISTS jobs (hash TEXT PRIMARY KEY, token TEXT NOT NULL, block INTEGER NOT NULL, fee TEXT NOT NULL,
  fee_gwei INTEGER NOT NULL, bytes BLOB, status TEXT NOT NULL DEFAULT 'new', tries INTEGER NOT NULL DEFAULT 0,
  next_try INTEGER NOT NULL DEFAULT 0, reverts INTEGER NOT NULL DEFAULT 0, created INTEGER NOT NULL, tx TEXT);
CREATE INDEX IF NOT EXISTS jobs_ready ON jobs (status, fee_gwei);
-- Every blob transaction sent; replacements share a nonce. paid caps what any of them may spend.
CREATE TABLE IF NOT EXISTS txs (hash TEXT PRIMARY KEY, nonce INTEGER NOT NULL, hashes TEXT NOT NULL, vh TEXT NOT NULL,
  tip TEXT NOT NULL, max_fee TEXT NOT NULL, max_blob_fee TEXT NOT NULL, gas INTEGER NOT NULL, paid TEXT NOT NULL,
  sent_block INTEGER NOT NULL, replacements INTEGER NOT NULL, status TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS blobs (vh TEXT PRIMARY KEY, bytes BLOB NOT NULL);
-- Hashes some owner authorized (for any publisher), and which blobs claim to carry which hashes.
CREATE TABLE IF NOT EXISTS authorized (hash TEXT PRIMARY KEY);
CREATE TABLE IF NOT EXISTS published (hash TEXT NOT NULL, vh TEXT NOT NULL, block INTEGER NOT NULL, PRIMARY KEY (hash, vh));
-- Blobs carrying an authorized post, mirrored to IPFS once the gateway has them.
CREATE TABLE IF NOT EXISTS mirror (vh TEXT PRIMARY KEY, block INTEGER NOT NULL, seen INTEGER NOT NULL, cid TEXT,
  tries INTEGER NOT NULL DEFAULT 0, next_try INTEGER NOT NULL DEFAULT 0);
"""


class Poster:
    """One publisher. Every spending decision obeys two rules: a post is only included if its own fee
    covers publishing it alone, and no transaction may ever spend more than its posts paid."""

    def __init__(self, *, rpc, api, contract, from_block, signer, db, setup, ipfs_api=None, notify=None,
                 chain_id=1, wrapper_version=1, now=time.time):
        self.rpc = rpc
        self.api = api.rstrip("/")
        self.contract = contract.lower()
        self.from_block = from_block
        self.signer = signer
        self.db = db
        self.setup = setup
        self.ipfs_api = ipfs_api.rstrip("/") if ipfs_api else None
        self.notify = notify or (lambda title, message: None)
        self.chain_id = chain_id
        self.wrapper_version = wrapper_version
        self.now = lambda: int(now())
        self.notified = {}
        self.rebroadcasts = {}
        self.used_nonces = {}
        db.executescript(SCHEMA)

    # state helpers
    def meta(self, key, default=None):
        row = self.db.execute("SELECT v FROM meta WHERE k = ?", (key,)).fetchone()
        return row[0] if row else default

    def set_meta(self, key, value):
        self.db.execute("INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v", (key, str(value)))

    def alert(self, key, title, message, every=6 * 3600):
        """Notify at most once per `every` seconds per key."""
        if self.now() - self.notified.get(key, 0) >= every:
            self.notified[key] = self.now()
            log.warning("%s: %s", title, message)
            try:
                self.notify(title, message)
            except Exception as error:  # a broken notifier must not stop publishing
                log.warning("notify failed: %s", error)

    # one pass
    def step(self):
        head = int(self.rpc("eth_blockNumber"), 16)
        self.scan(head - CONFIRMATIONS)
        if not self.reconcile(head):
            self.maybe_publish(head)
        self.mirror_blobs()
        self.db.commit()

    def scan(self, safe):
        cursor = int(self.meta("cursor", self.from_block - 1))
        while cursor < safe:
            to = min(safe, cursor + LOG_RANGE)
            logs = self.rpc("eth_getLogs", {
                "address": self.contract, "fromBlock": hex(cursor + 1), "toBlock": hex(to),
                "topics": [[T_AUTHORIZED, T_PUBLISHED]],
            })
            for entry in logs:
                if entry.get("removed") or len(entry["topics"]) != 4 or entry.get("address", "").lower() != self.contract:
                    continue
                block = int(entry["blockNumber"], 16)
                key = "|".join([entry["transactionHash"].lower(), *(t.lower() for t in entry["topics"]), entry["data"].lower()])
                if self.db.execute("SELECT 1 FROM seen WHERE key = ?", (key,)).fetchone():
                    continue
                self.db.execute("INSERT INTO seen (key) VALUES (?)", (key,))
                topic, a, b, _ = (t.lower() for t in entry["topics"])
                if topic == T_AUTHORIZED:
                    self.db.execute("INSERT OR IGNORE INTO authorized (hash) VALUES (?)", (b,))
                    data = entry["data"][2:]
                    if len(data) < 128:
                        continue
                    publisher, fee = "0x" + data[24:64], int(data[64:128], 16)
                    if publisher != self.signer.address:
                        continue
                    row = self.db.execute("SELECT fee FROM jobs WHERE hash = ?", (b,)).fetchone()
                    total = (int(row[0]) if row else 0) + fee
                    fee_gwei = min(total // GWEI, 2**62)
                    if row:
                        self.db.execute("UPDATE jobs SET fee = ?, fee_gwei = ? WHERE hash = ?", (str(total), fee_gwei, b))
                    else:
                        self.db.execute("INSERT INTO jobs (hash, token, block, fee, fee_gwei, created) VALUES (?, ?, ?, ?, ?, ?)",
                                        (b, a, block, str(total), fee_gwei, self.now()))
                    log.info("job %s for token %s, fee %s wei", b, a, fee)
                elif topic == T_PUBLISHED:
                    self.db.execute("INSERT OR IGNORE INTO published (hash, vh, block) VALUES (?, ?, ?)", (a, b, block))
            cursor = to
            self.set_meta("cursor", cursor)
            self.db.commit()

    def post_bytes(self, job_hash):
        try:
            status, raw = http(f"{self.api}/posts/{job_hash}/raw", timeout=FETCH_TIMEOUT)
        except urllib.error.HTTPError as error:
            if error.code == 404:
                return None
            raise
        if status != 200 or len(raw) > MAX_POST_BYTES or "0x" + keccak(raw).hex() != job_hash:
            return None
        return raw

    def prices(self):
        block = self.rpc("eth_getBlockByNumber", "latest", False)
        base_fee = int(block["baseFeePerGas"], 16)
        blob_base_fee = int(self.rpc("eth_blobBaseFee"), 16)
        tip = min(max(int(self.rpc("eth_maxPriorityFeePerGas"), 16), MIN_TIP), MAX_TIP)
        return base_fee, tip, blob_base_fee

    def ready_jobs(self, floor):
        """Jobs whose own fee covers publishing them alone, with their bytes, oldest first. Underpaid
        jobs are left alone (not even fetched) until prices fall."""
        now = self.now()
        started = time.monotonic()
        ready, fetches = [], 0
        # Jobs with bytes first, then the ones that failed fewest fetches, so paid jobs whose bytes
        # never show up can't crowd out the rest.
        rows = self.db.execute(
            "SELECT hash, created, tries, bytes, fee FROM jobs WHERE status = 'new' AND next_try <= ? AND fee_gwei >= ? "
            "ORDER BY bytes IS NULL, tries, block LIMIT ?", (now, floor // GWEI, MAX_BATCH * 4)).fetchall()
        for job_hash, created, tries, raw, fee in rows:
            if int(fee) < floor:
                continue
            if raw is None:
                if fetches >= FETCHES_PER_STEP or time.monotonic() - started > FETCH_BUDGET_SECONDS:
                    continue
                fetches += 1
                try:
                    raw = self.post_bytes(job_hash)
                except Exception as error:
                    log.warning("fetching %s: %s", job_hash, error)
                    raw = None
                if raw is None:
                    if now - created > BYTES_GIVE_UP_SECONDS:
                        self.db.execute("UPDATE jobs SET status = 'failed' WHERE hash = ?", (job_hash,))
                        log.warning("giving up on %s: no bytes", job_hash)
                    else:
                        self.db.execute("UPDATE jobs SET tries = tries + 1, next_try = ? WHERE hash = ?",
                                        (now + min(60 * 2 ** tries, 3600), job_hash))
                    continue
                self.db.execute("UPDATE jobs SET bytes = ? WHERE hash = ?", (raw, job_hash))
            ready.append((job_hash, bytes(raw), int(fee)))
        return ready

    def maybe_publish(self, head):
        base_fee, tip, blob_base_fee = self.prices()
        floor = min_fee(base_fee, tip, blob_base_fee)
        ready = self.ready_jobs(floor)
        if not ready:
            return None
        batch = []
        for job in ready:
            if len(batch) < MAX_BATCH and fits([p for _, p, _ in batch] + [job[1]]):
                batch.append(job)
        paid = sum(fee for _, _, fee in batch)
        gas = gas_limit(len(batch))
        caps = fee_caps(paid, gas, base_fee, tip, blob_base_fee)
        if caps is None:
            self.alert("underpaid", "gwei poster waiting", f"{len(batch)} posts paid {paid} wei, not enough headroom at current prices")
            return None
        max_fee, max_blob_fee = caps
        balance = int(self.rpc("eth_getBalance", self.signer.address, "latest"), 16)
        if balance < worst_case(gas, max_fee, max_blob_fee):
            self.alert("balance", "gwei poster needs ETH",
                       f"{self.signer.address} has {balance} wei, a batch needs {worst_case(gas, max_fee, max_blob_fee)} up front")
            return None
        nonce = int(self.rpc("eth_getTransactionCount", self.signer.address, "latest"), 16)
        hashes = [bytes.fromhex(h[2:]) for h, _, _ in batch]
        blob = encode_blob([p for _, p, _ in batch])
        return self.send(nonce=nonce, hashes=hashes, blob=blob, tip=tip, max_fee=max_fee, max_blob_fee=max_blob_fee,
                         gas=gas, paid=paid, head=head, replacements=0)

    def build(self, *, nonce, hashes, blob, tip, max_fee, max_blob_fee, gas):
        return blob_transaction(
            self.signer, chain_id=self.chain_id, nonce=nonce, tip=tip, max_fee=max_fee, gas=gas, to=self.contract,
            data=publish_calldata(hashes), max_blob_fee=max_blob_fee, blob=blob, setup=self.setup,
            wrapper_version=self.wrapper_version)

    def send(self, *, nonce, hashes, blob, tip, max_fee, max_blob_fee, gas, paid, head, replacements):
        if worst_case(gas, max_fee, max_blob_fee) > paid:  # the invariant every path relies on
            raise AssertionError("fee caps exceed what the batch paid")
        raw, tx_hash, vh = self.build(nonce=nonce, hashes=hashes, blob=blob, tip=tip, max_fee=max_fee,
                                      max_blob_fee=max_blob_fee, gas=gas)
        # Recorded (and committed) before it is broadcast: if the broadcast times out after the node
        # took it, the transaction is still tracked and its posts are never sent a second time.
        names = json.dumps(["0x" + h.hex() for h in hashes])
        self.db.execute("INSERT OR REPLACE INTO blobs (vh, bytes) VALUES (?, ?)", (vh, blob))
        self.db.execute("INSERT INTO txs (hash, nonce, hashes, vh, tip, max_fee, max_blob_fee, gas, paid, sent_block, replacements, status) "
                        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')",
                        (tx_hash, nonce, names, vh, str(tip), str(max_fee), str(max_blob_fee), gas, str(paid), head, replacements))
        for h in json.loads(names):
            self.db.execute("UPDATE jobs SET status = 'sent', tx = ? WHERE hash = ?", (tx_hash, h))
        self.db.commit()
        try:
            self.rpc("eth_sendRawTransaction", raw)
        except RpcError as error:
            if "known" not in str(error).lower():
                # The node answered and refused it, so it can't be mined. A first send gives the
                # posts back to the queue; a refused replacement leaves the original pending.
                self.db.execute("UPDATE txs SET status = 'refused' WHERE hash = ?", (tx_hash,))
                if replacements == 0:
                    for h in json.loads(names):
                        self.db.execute("UPDATE jobs SET status = 'new', tries = tries + 1 WHERE hash = ? AND tx = ?", (h, tx_hash))
                self.db.commit()
                raise
        except Exception:
            # No answer (timeout, connection reset): it may have gone out. Keep tracking it; reconcile
            # rebroadcasts it or notices its nonce was used.
            log.warning("broadcasting %s got no answer; tracking it anyway", tx_hash)
        log.info("sent %s (nonce %s, %s posts, blob %s, at most %s of %s wei paid)", tx_hash, nonce, len(hashes), vh,
                 worst_case(gas, max_fee, max_blob_fee), paid)
        return tx_hash

    def settle(self, tx_hash, nonce, names, vh, receipt):
        mined_ok = int(receipt["status"], 16) == 1
        self.db.execute("UPDATE txs SET status = 'replaced' WHERE nonce = ? AND hash != ? AND status = 'pending'", (nonce, tx_hash))
        self.db.execute("UPDATE txs SET status = ? WHERE hash = ?", ("mined" if mined_ok else "reverted", tx_hash))
        for h in json.loads(names):
            if mined_ok:
                self.db.execute("UPDATE jobs SET status = 'done', tx = ? WHERE hash = ?", (tx_hash, h))
            else:
                # A revert costs gas; never retry one forever.
                self.db.execute("UPDATE jobs SET reverts = reverts + 1, status = CASE WHEN reverts + 1 >= ? THEN 'failed' ELSE 'new' END "
                                "WHERE hash = ?", (MAX_REVERTS, h))
        log.info("%s %s in block %s", tx_hash, "mined" if mined_ok else "REVERTED", int(receipt["blockNumber"], 16))
        if mined_ok:
            self.pin(vh)
        else:
            self.alert("reverted", "gwei poster transaction reverted", tx_hash)

    def reconcile(self, head):
        """Settle sent transactions. Returns True while one is still pending."""
        pending = self.db.execute("SELECT hash, nonce, hashes, vh, tip, max_fee, max_blob_fee, gas, paid, sent_block, replacements "
                                  "FROM txs WHERE status = 'pending' ORDER BY nonce, replacements").fetchall()
        if not pending:
            return False
        nonce = pending[0][1]
        same_nonce = [p for p in pending if p[1] == nonce]
        for tx_hash, _, names, vh, *_ in same_nonce:
            receipt = self.rpc("eth_getTransactionReceipt", tx_hash)
            if receipt:
                self.settle(tx_hash, nonce, names, vh, receipt)
                return False
        # No receipt yet. If the nonce was used anyway, look again (a block may have landed in between),
        # and only after a few more blocks give the batch back to the queue.
        if int(self.rpc("eth_getTransactionCount", self.signer.address, "latest"), 16) > nonce:
            for tx_hash, _, names, vh, *_ in same_nonce:
                receipt = self.rpc("eth_getTransactionReceipt", tx_hash)
                if receipt:
                    self.settle(tx_hash, nonce, names, vh, receipt)
                    return False
            seen_used = self.used_nonces.setdefault(nonce, head)
            if head - seen_used < DROPPED_AFTER_BLOCKS:
                return True
            for tx_hash, _, names, *_ in same_nonce:
                self.db.execute("UPDATE txs SET status = 'dropped' WHERE hash = ?", (tx_hash,))
                for h in json.loads(names):
                    self.db.execute("UPDATE jobs SET status = 'new' WHERE hash = ? AND status = 'sent'", (h,))
            self.alert("dropped", "gwei poster nonce used elsewhere", f"nonce {nonce} was used by a transaction it did not send")
            return False
        tx_hash, _, names, vh, tip, max_fee, max_blob_fee, gas, paid, sent_block, replacements = same_nonce[-1]
        tip, max_fee, max_blob_fee, paid = int(tip), int(max_fee), int(max_blob_fee), int(paid)
        blob = bytes(self.db.execute("SELECT bytes FROM blobs WHERE vh = ?", (vh,)).fetchone()[0])
        hashes = [bytes.fromhex(h[2:]) for h in json.loads(names)]
        waited = head - sent_block
        if waited < REPLACE_AFTER_BLOCKS:
            return True
        base_fee, _, blob_base_fee = self.prices()
        priced_out = max_fee < base_fee or max_blob_fee < blob_base_fee
        # A blob transaction is only replaced by one paying at least twice every fee, and the
        # replacement must stay within what its posts paid. Replace when prices passed our caps, or
        # when a builder has ignored it for a while; otherwise keep it in the pool and wait.
        bump = (2 * tip, max(2 * max_fee, 2 * base_fee + 2 * tip), max(2 * max_blob_fee, 2 * blob_base_fee))
        if (not priced_out and waited < REPLACE_STALE_BLOCKS) or worst_case(gas, bump[1], bump[2]) > paid:
            if priced_out:
                self.alert("stuck", "gwei poster waiting for fees to fall",
                           f"{tx_hash} is priced out and a replacement would cost more than its {paid} wei", every=86400)
            elif head - self.rebroadcasts.get(tx_hash, sent_block) >= REBROADCAST_AFTER_BLOCKS:
                # Nodes may drop a waiting transaction from their pool; resend the identical bytes.
                self.rebroadcasts[tx_hash] = head
                self.rebroadcast(nonce, hashes, blob, tip, max_fee, max_blob_fee, gas)
            return True
        try:
            self.send(nonce=nonce, hashes=hashes, blob=blob, tip=bump[0], max_fee=bump[1], max_blob_fee=bump[2],
                      gas=gas, paid=paid, head=head, replacements=replacements + 1)
        except RpcError as error:
            log.warning("replacing %s: %s", tx_hash, error)
        return True

    def rebroadcast(self, nonce, hashes, blob, tip, max_fee, max_blob_fee, gas):
        # Signatures are deterministic (RFC 6979), so this is byte-for-byte the transaction we sent.
        raw, tx_hash, _ = self.build(nonce=nonce, hashes=hashes, blob=blob, tip=tip, max_fee=max_fee, max_blob_fee=max_blob_fee, gas=gas)
        try:
            self.rpc("eth_sendRawTransaction", raw)
            log.info("rebroadcast %s", tx_hash)
        except RpcError as error:
            if "known" not in str(error).lower():
                log.warning("rebroadcasting %s: %s", tx_hash, error)

    # IPFS copies
    def ipfs_add(self, data: bytes) -> str:
        boundary = "gwei" + secrets.token_hex(8)
        body = (f"--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"blob\"\r\n"
                "Content-Type: application/octet-stream\r\n\r\n").encode() + data + f"\r\n--{boundary}--\r\n".encode()
        _, raw = http(f"{self.ipfs_api}/api/v0/add?pin=true&cid-version=1&raw-leaves=true&quieter=true", body,
                      {"content-type": f"multipart/form-data; boundary={boundary}"}, timeout=60)
        return json.loads(raw)["Hash"]

    def pin(self, vh):
        """Pin a blob we hold to IPFS, and remember the CID."""
        row = self.db.execute("SELECT bytes FROM blobs WHERE vh = ?", (vh,)).fetchone()
        self.db.execute("INSERT OR IGNORE INTO mirror (vh, block, seen) VALUES (?, 0, ?)", (vh, self.now()))
        if not self.ipfs_api or not row:
            return None
        try:
            cid = self.ipfs_add(bytes(row[0]))
        except Exception as error:
            log.warning("pinning %s: %s", vh, error)
            return None
        self.db.execute("UPDATE mirror SET cid = ? WHERE vh = ?", (cid, vh))
        log.info("pinned blob %s as %s", vh, cid)
        return cid

    def mirror_blobs(self):
        """Copy blobs that carry an authorized post (from any publisher) from the gateway, check them
        against their versioned hash with KZG, and pin them. Blobs nobody authorized a post in are
        never fetched, so spam PostPublished events cost us nothing."""
        if not self.ipfs_api:
            return
        now = self.now()
        self.db.execute("INSERT OR IGNORE INTO mirror (vh, block, seen) SELECT p.vh, MIN(p.block), ? FROM published p "
                        "JOIN authorized a ON a.hash = p.hash GROUP BY p.vh", (now,))
        for vh, seen, tries in self.db.execute(
                "SELECT vh, seen, tries FROM mirror WHERE cid IS NULL AND next_try <= ? AND tries < 40 ORDER BY block LIMIT ?",
                (now, MIRRORS_PER_STEP)).fetchall():
            held = self.db.execute("SELECT bytes FROM blobs WHERE vh = ?", (vh,)).fetchone()
            blob = bytes(held[0]) if held else None
            if blob is None:
                try:
                    status, raw = http(f"{self.api}/blobs/{vh}", timeout=30)
                    if status == 200 and len(raw) == BLOB_BYTES and "0x" + versioned_hash(ckzg.blob_to_kzg_commitment(raw, self.setup)).hex() == vh:
                        blob = raw
                        self.db.execute("INSERT OR IGNORE INTO blobs (vh, bytes) VALUES (?, ?)", (vh, blob))
                except Exception:
                    blob = None
            if blob is None:
                if now - seen > MIRROR_GIVE_UP_SECONDS:
                    self.db.execute("UPDATE mirror SET tries = 40 WHERE vh = ?", (vh,))
                else:
                    self.db.execute("UPDATE mirror SET tries = tries + 1, next_try = ? WHERE vh = ?", (now + min(300 * 2 ** tries, 6 * 3600), vh))
                continue
            self.pin(vh)

    def status(self):
        balance = int(self.rpc("eth_getBalance", self.signer.address, "latest"), 16)
        counts = dict(self.db.execute("SELECT status, COUNT(*) FROM jobs GROUP BY status").fetchall())
        mirrored = self.db.execute("SELECT COUNT(*) FROM mirror WHERE cid IS NOT NULL").fetchone()[0]
        return {"address": self.signer.address, "balance_wei": balance, "cursor": self.meta("cursor"), "jobs": counts, "pinned_blobs": mirrored}


# --- entry point ----------------------------------------------------------------------------------
def read_key(path) -> bytes:
    with open(path) as fh:
        secret = bytes.fromhex(fh.read().strip().removeprefix("0x"))
    if len(secret) != 32:
        raise SystemExit(f"{path}: expected a 32-byte hex key")
    return secret


def ntfy_from_env():
    url = os.environ.get("POSTER_NTFY_URL")
    token_file = os.environ.get("POSTER_NTFY_TOKEN_FILE")
    if not url or not token_file:
        return None
    with open(token_file) as fh:
        token = fh.read().strip()

    def notify(title, message):
        http(url, message.encode(), {"authorization": f"Bearer {token}", "title": title, "tags": "warning"}, timeout=10)

    return notify


def build_from_env():
    env = os.environ
    db = sqlite3.connect(env.get("POSTER_DB", "/data/poster.db"))
    setup = ckzg.load_trusted_setup(env.get("POSTER_TRUSTED_SETUP", "/opt/gwei-poster/trusted_setup.txt"), 0)
    rpc = Rpc(env.get("POSTER_RPC", "http://127.0.0.1:8545"))
    chain_id = int(env.get("POSTER_CHAIN_ID", "1"))
    if int(rpc("eth_chainId"), 16) != chain_id:
        raise SystemExit("the RPC is on a different chain than POSTER_CHAIN_ID")
    return Poster(
        rpc=rpc, api=env.get("POSTER_API", "https://gwei.domains/api"), contract=env["POSTER_CONTRACT"],
        from_block=int(env["POSTER_FROM_BLOCK"]), signer=Signer(read_key(env.get("POSTER_KEY_FILE", "/run/secrets/poster-key"))),
        db=db, setup=setup, ipfs_api=env.get("POSTER_IPFS_API"), notify=ntfy_from_env(), chain_id=chain_id,
        wrapper_version=int(env.get("POSTER_WRAPPER_VERSION", "1")),
    )


def main(argv):
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    command = argv[1] if len(argv) > 1 else "run"
    if command == "keygen":
        path = argv[2]
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o400)
        secret = secrets.token_bytes(32)
        with os.fdopen(fd, "w") as fh:
            fh.write(secret.hex() + "\n")
        print(Signer(secret).address)
        return
    if command == "address":
        print(Signer(read_key(os.environ.get("POSTER_KEY_FILE", "/run/secrets/poster-key"))).address)
        return
    poster = build_from_env()
    if command == "status":
        print(json.dumps(poster.status(), indent=2))
        return
    interval = int(os.environ.get("POSTER_INTERVAL", "12"))
    log.info("publishing as %s for %s", poster.signer.address, poster.contract)
    failures = 0
    while True:
        try:
            poster.step()
            failures = 0
        except Exception as error:
            failures += 1
            log.warning("step failed: %s", error)
            if failures >= 30:
                poster.alert("failing", "gwei poster failing", f"{failures} failed steps in a row, last: {error}")
        time.sleep(interval)


if __name__ == "__main__":
    main(sys.argv)
