#!/usr/bin/env python3
"""The gwei.domains publisher for GNS posts (posts/SPEC.md).

An author builds the blob for their post, computes its versioned hash and authorizes the post on
GnsPosts against that hash, putting a fee in escrow for this publisher. The publisher fetches the
post's bytes from the gateway API, rebuilds the same blob, checks that its versioned hash is the one
the author named, and sends a blob transaction (up to six blobs) calling GnsPosts.publish(), which
pays out the escrow for exactly those blobs in the same transaction. It also keeps a copy of every
blob that carries an authorized post, from any publisher, pinned on the local IPFS node after
checking it against its versioned hash.

Money rules: a blob is only sent if the fees for it that can't be refunded for a while cover sending
it alone, and no transaction may spend more than those fees, replacements included. A fee about to
become refundable doesn't count, so an author taking it back can't leave a sent blob unpaid.

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
import re
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

T_AUTHORIZED = "0x521590a9cca024d1ff93e37c9ee8f521cee9c2da79903939763c3c34bdb7eb28"  # PostAuthorized(uint256,bytes32,address,bytes32,address,uint256)
T_BLOB_PUBLISHED = "0xb51cc50f0049ae8836824f5ee55fbae269ff6cf4ff8fc6390b721310d5ade99b"  # BlobPublished(bytes32,address,uint256)
SEL_PUBLISH = bytes.fromhex("075d4782")  # publish()
SEL_DEPOSITS = "4f1c2c31"  # deposits(bytes32,address) -> (uint128 amount, uint64 refundableAt)
SEL_DELIVERED = "e495f1d4"  # delivered(bytes32) -> bool

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
GAS_BASE = 29_000  # measured on anvil: publish() with n paid blobs uses 28,496 + 24,900 * n gas
GAS_PER_BLOB = 25_500
MAX_BLOBS_PER_TX = 6  # the per-transaction blob limit since Fusaka (EIP-7594)
MIN_HEADROOM = 1.125  # fee caps must survive at least one block of base-fee growth
SAFETY_MARGIN = 6 * 3600  # a deposit refundable sooner than this doesn't count as paid
REPLACE_AFTER_BLOCKS = 3  # priced out for this long: replace (within what was paid)
REPLACE_STALE_BLOCKS = 25  # includable but ignored for this long: replace too
REBROADCAST_AFTER_BLOCKS = 10
MAX_REVERTS = 1  # publish() can't revert in practice; if it does, never pay for it twice
FETCHES_PER_STEP = 20  # post-byte downloads per pass, so a flood of jobs can't stall the loop
FETCH_TIMEOUT = 8
FETCH_BUDGET_SECONDS = 30
RECHECK_SECONDS = 60  # an underpaid job's deposits are read again after this, doubling each time
EXPIRE_SECONDS = 86400  # an underpaid job with nothing safe left in escrow after this stops being checked
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
    """Posts → one blob in the "gwei" v1 container. A post's own blob is encode_blob([post])."""
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


def versioned_hash(commitment: bytes) -> bytes:
    return b"\x01" + hashlib.sha256(commitment).digest()[1:]


def blob_hash(blob: bytes, setup) -> str:
    return "0x" + versioned_hash(ckzg.blob_to_kzg_commitment(blob, setup)).hex()


def escrow_key(blob_hash_hex: str, publisher: str) -> bytes:
    """GnsPosts.escrowKey: keccak256(abi.encode(blobHash, publisher))."""
    return keccak(bytes.fromhex(blob_hash_hex[2:]) + bytes(12) + bytes.fromhex(publisher[2:]))


# --- transactions ---------------------------------------------------------------------------------
class Signer:
    def __init__(self, secret: bytes):
        self.key = PrivateKey(secret)
        self.address = "0x" + keccak(self.key.public_key.format(compressed=False)[1:])[-20:].hex()

    def sign(self, digest: bytes):
        sig = self.key.sign_recoverable(digest, hasher=None)
        return sig[64], int.from_bytes(sig[:32], "big"), int.from_bytes(sig[32:64], "big")


def blob_transaction(signer, *, chain_id, nonce, tip, max_fee, gas, to, data, max_blob_fee, blobs, setup, wrapper_version=1):
    """A signed EIP-4844 transaction in its network form, its hash, and its blobs' versioned hashes.

    wrapper_version 1 is the Fusaka (EIP-7594) wrapper with 128 cell proofs per blob; 0 is the
    original EIP-4844 wrapper with one proof per blob."""
    commitments = [ckzg.blob_to_kzg_commitment(blob, setup) for blob in blobs]
    hashes = [versioned_hash(c) for c in commitments]
    fields = [chain_id, nonce, tip, max_fee, gas, bytes.fromhex(to[2:]), 0, data, [], max_blob_fee, hashes]
    y_parity, r, s = signer.sign(keccak(b"\x03" + rlp(fields)))
    signed = fields + [y_parity, r, s]
    tx_hash = "0x" + keccak(b"\x03" + rlp(signed)).hex()
    if wrapper_version == 1:
        proofs = [proof for blob in blobs for proof in ckzg.compute_cells_and_kzg_proofs(blob, setup)[1]]
        network = [signed, 1, list(blobs), commitments, proofs]
    else:
        network = [signed, list(blobs), commitments, [ckzg.compute_blob_kzg_proof(b, c, setup) for b, c in zip(blobs, commitments)]]
    return "0x" + (b"\x03" + rlp(network)).hex(), tx_hash, ["0x" + h.hex() for h in hashes]


def expected_gas(n_blobs: int) -> int:
    return GAS_BASE + GAS_PER_BLOB * n_blobs


def gas_limit(n_blobs: int) -> int:
    return expected_gas(n_blobs) * 5 // 4 + 5_000


def batch_cost(n_blobs: int, base_fee: int, tip: int, blob_base_fee: int) -> int:
    """What a publish() transaction carrying n blobs should cost at these prices."""
    return expected_gas(n_blobs) * (base_fee + tip) + n_blobs * BLOB_GAS * blob_base_fee


def worst_case(gas: int, max_fee: int, max_blob_fee: int, n_blobs: int) -> int:
    """The most a transaction with these caps can ever spend."""
    return gas * max_fee + n_blobs * BLOB_GAS * max_blob_fee


def fee_caps(paid: int, gas: int, n_blobs: int, base_fee: int, tip: int, blob_base_fee: int):
    """Fee caps with up to 2x headroom over current prices, cut down so that even the worst case
    spends no more than `paid`. None if `paid` can't buy MIN_HEADROOM."""
    for blob_headroom in (2.0, MIN_HEADROOM):
        max_blob_fee = max(int(blob_headroom * blob_base_fee), 1)
        max_fee = min(2 * base_fee + tip, (paid - n_blobs * BLOB_GAS * max_blob_fee) // gas)
        if max_fee >= int(MIN_HEADROOM * base_fee) + tip:
            return max_fee, max_blob_fee
    return None


def min_fee(base_fee: int, tip: int, blob_base_fee: int) -> int:
    """The least a blob's safe deposits must add up to: a one-blob transaction's worst case at
    MIN_HEADROOM. Blobs that each clear this can always share a transaction within what they paid."""
    return worst_case(gas_limit(1), int(MIN_HEADROOM * base_fee) + tip, max(int(MIN_HEADROOM * blob_base_fee), 1), 1)


def quote(base_fee: int, tip: int, blob_base_fee: int) -> int:
    """What the dapp pays per post: three times the expected cost of a one-blob transaction, so
    prices can rise before it goes out (posts/SPEC.md)."""
    return 3 * batch_cost(1, base_fee, tip, blob_base_fee)


# --- I/O ------------------------------------------------------------------------------------------
def already_known(error) -> bool:
    """The node already has this exact transaction (geth, reth, erigon: "already known", older geth:
    "known transaction: …", nethermind: "AlreadyKnown", besu: "TRANSACTION_ALREADY_KNOWN"). Not
    "unknown …", which would leave a refused transaction tracked as pending."""
    return re.search(r"already[ _]?known|(?<![a-z])known transaction", str(error).lower()) is not None


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
-- A blob some author paid this publisher to deliver: the post it should carry, and who paid (the
-- escrow itself is read from the contract when it matters). bytes is the verified post.
CREATE TABLE IF NOT EXISTS jobs (blob TEXT PRIMARY KEY, post TEXT NOT NULL, block INTEGER NOT NULL, payers TEXT NOT NULL,
  bytes BLOB, status TEXT NOT NULL DEFAULT 'new', tries INTEGER NOT NULL DEFAULT 0, next_try INTEGER NOT NULL DEFAULT 0,
  reverts INTEGER NOT NULL DEFAULT 0, created INTEGER NOT NULL, tx TEXT);
CREATE INDEX IF NOT EXISTS jobs_ready ON jobs (status, next_try);
-- Every post a paid authorization said the job's blob carries. Anyone can name any blob, so a wrong
-- claim (or one whose bytes never show up) can't stand in for the right one: each is tried in turn,
-- and the one whose bytes make the blob becomes the job's post.
CREATE TABLE IF NOT EXISTS job_posts (blob TEXT NOT NULL, post TEXT NOT NULL, wrong INTEGER NOT NULL DEFAULT 0,
  tried INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (blob, post));
-- Every blob transaction sent; replacements share a nonce. paid caps what any of them may spend.
CREATE TABLE IF NOT EXISTS txs (hash TEXT PRIMARY KEY, nonce INTEGER NOT NULL, blobs TEXT NOT NULL,
  tip TEXT NOT NULL, max_fee TEXT NOT NULL, max_blob_fee TEXT NOT NULL, gas INTEGER NOT NULL, paid TEXT NOT NULL,
  sent_block INTEGER NOT NULL, replacements INTEGER NOT NULL, status TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS blobs (vh TEXT PRIMARY KEY, bytes BLOB NOT NULL);
-- Blobs some owner named for a post, and blobs anyone published.
CREATE TABLE IF NOT EXISTS claims (post TEXT NOT NULL, vh TEXT NOT NULL, PRIMARY KEY (post, vh));
CREATE TABLE IF NOT EXISTS published (vh TEXT PRIMARY KEY, block INTEGER NOT NULL);
-- Published blobs that carry an authorized post, mirrored to IPFS once the gateway has them.
CREATE TABLE IF NOT EXISTS mirror (vh TEXT PRIMARY KEY, block INTEGER NOT NULL, seen INTEGER NOT NULL, cid TEXT,
  tries INTEGER NOT NULL DEFAULT 0, next_try INTEGER NOT NULL DEFAULT 0);
"""


class Poster:
    """One publisher. Every spending decision obeys two rules: a blob is only sent if its safe
    deposits cover sending it alone, and no transaction may ever spend more than they add up to."""

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
        # Cursor, jobs and blobs only make sense for one deployment.
        bound = self.meta("contract")
        if bound is None:
            self.set_meta("contract", self.contract)
            db.commit()
        elif bound != self.contract:
            raise SystemExit(f"this database belongs to {bound}, not {self.contract}: start a new one")

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
                "topics": [[T_AUTHORIZED, T_BLOB_PUBLISHED]],
            })
            for entry in logs:
                if entry.get("removed") or entry.get("address", "").lower() != self.contract:
                    continue
                topics = [t.lower() for t in entry["topics"]]
                key = "|".join([entry["transactionHash"].lower(), *topics, entry["data"].lower()])
                if self.db.execute("SELECT 1 FROM seen WHERE key = ?", (key,)).fetchone():
                    continue
                self.db.execute("INSERT INTO seen (key) VALUES (?)", (key,))
                block = int(entry["blockNumber"], 16)
                data = entry["data"][2:]
                if topics[0] == T_AUTHORIZED and len(topics) == 4 and len(data) >= 192:
                    post, author = topics[2], "0x" + topics[3][-40:]
                    vh, publisher, fee = "0x" + data[:64], "0x" + data[88:128], int(data[128:192], 16)
                    self.db.execute("INSERT OR IGNORE INTO claims (post, vh) VALUES (?, ?)", (post, vh))
                    if publisher != self.signer.address or fee == 0:
                        continue
                    self.db.execute("INSERT OR IGNORE INTO job_posts (blob, post) VALUES (?, ?)", (vh, post))
                    row = self.db.execute("SELECT payers FROM jobs WHERE blob = ?", (vh,)).fetchone()
                    if row:
                        payers = sorted(set(json.loads(row[0])) | {author})
                        # A new payment gives a job whose claims all failed, or whose bytes never came,
                        # another go (the bytes may be there now). One that reverted stays failed.
                        self.db.execute(
                            "UPDATE jobs SET payers = ?, next_try = 0, created = CASE WHEN status IN ('mismatch', 'failed', 'expired') AND reverts < ? "
                            "THEN ? ELSE created END, status = CASE WHEN status IN ('mismatch', 'failed', 'expired') AND reverts < ? THEN 'new' ELSE status END "
                            "WHERE blob = ?", (json.dumps(payers), MAX_REVERTS, self.now(), MAX_REVERTS, vh))
                    else:
                        self.db.execute("INSERT INTO jobs (blob, post, block, payers, created) VALUES (?, ?, ?, ?, ?)",
                                        (vh, post, block, json.dumps([author]), self.now()))
                    log.info("job: blob %s for post %s, %s wei from %s", vh, post, fee, author)
                elif topics[0] == T_BLOB_PUBLISHED and len(topics) == 3:
                    vh, publisher = topics[1], "0x" + topics[2][-40:]
                    self.db.execute("INSERT OR IGNORE INTO published (vh, block) VALUES (?, ?)", (vh, block))
                    if publisher == self.signer.address:
                        self.db.execute("UPDATE jobs SET status = 'done' WHERE blob = ? AND status != 'done'", (vh,))
            cursor = to
            self.set_meta("cursor", cursor)
            self.db.commit()

    def post_bytes(self, post_hash):
        try:
            status, raw = http(f"{self.api}/posts/{post_hash}/raw", timeout=FETCH_TIMEOUT)
        except urllib.error.HTTPError as error:
            if error.code == 404:
                return None
            raise
        if status != 200 or len(raw) > MAX_POST_BYTES or "0x" + keccak(raw).hex() != post_hash:
            return None
        return raw

    def prices(self):
        block = self.rpc("eth_getBlockByNumber", "latest", False)
        base_fee = int(block["baseFeePerGas"], 16)
        blob_base_fee = int(self.rpc("eth_blobBaseFee"), 16)
        tip = min(max(int(self.rpc("eth_maxPriorityFeePerGas"), 16), MIN_TIP), MAX_TIP)
        return base_fee, tip, blob_base_fee, int(block["timestamp"], 16)

    def call(self, data: str) -> str:
        return self.rpc("eth_call", {"to": self.contract, "data": data}, "latest")

    def safe_paid(self, vh, payers, chain_time):
        """What the escrow holds for (vh, us) that no payer can take back within SAFETY_MARGIN, read
        from the contract. None if the blob was already delivered."""
        key = escrow_key(vh, self.signer.address)
        if int(self.call("0x" + SEL_DELIVERED + key.hex()), 16):
            return None
        total = 0
        for payer in payers:
            out = self.call("0x" + SEL_DEPOSITS + key.hex() + payer[2:].rjust(64, "0"))[2:]
            amount, refundable_at = int(out[:64], 16), int(out[64:128], 16)
            if refundable_at - chain_time >= SAFETY_MARGIN:
                total += amount
        return total

    def ready_jobs(self, floor, chain_time):
        """Jobs whose blob matches the hash the author named and whose safe deposits cover sending
        it alone, oldest first, as (vh, blob, safe_paid, payers)."""
        now = self.now()
        started = time.monotonic()
        ready, fetches = [], 0
        rows = self.db.execute(
            "SELECT blob, post, payers, created, tries, bytes FROM jobs WHERE status = 'new' AND next_try <= ? "
            "ORDER BY next_try, block LIMIT 200", (now,)).fetchall()
        for vh, post, payers_json, created, tries, raw in rows:
            if len(ready) >= MAX_BLOBS_PER_TX:
                break
            if raw is None:
                # The blob must be exactly the one a claimed post makes. Claims are tried least
                # recently tried first, so a pile of bogus ones only delays the right one.
                candidates = [r[0] for r in self.db.execute(
                    "SELECT post FROM job_posts WHERE blob = ? AND wrong = 0 ORDER BY tried, rowid", (vh,)).fetchall()]
                missing = out_of_budget = False
                for candidate in candidates:
                    if fetches >= FETCHES_PER_STEP or time.monotonic() - started > FETCH_BUDGET_SECONDS:
                        out_of_budget = True
                        break
                    fetches += 1
                    self.db.execute("UPDATE job_posts SET tried = ? WHERE blob = ? AND post = ?", (now, vh, candidate))
                    try:
                        found = self.post_bytes(candidate)
                    except Exception as error:
                        log.warning("fetching %s: %s", candidate, error)
                        found = None
                    if found is None:
                        missing = True
                    elif blob_hash(encode_blob([found]), self.setup) == vh:
                        post, raw = candidate, found
                        break
                    else:
                        self.db.execute("UPDATE job_posts SET wrong = 1 WHERE blob = ? AND post = ?", (vh, candidate))
                        log.warning("%s: post %s doesn't make that blob", vh, candidate)
                if raw is None:
                    if out_of_budget:
                        continue
                    if not missing:
                        self.db.execute("UPDATE jobs SET status = 'mismatch' WHERE blob = ?", (vh,))
                        log.warning("%s: no claimed post makes that blob; not publishing", vh)
                    elif now - created > BYTES_GIVE_UP_SECONDS:
                        self.db.execute("UPDATE jobs SET status = 'failed' WHERE blob = ?", (vh,))
                        log.warning("giving up on %s: no bytes", vh)
                    else:
                        self.db.execute("UPDATE jobs SET tries = tries + 1, next_try = ? WHERE blob = ?",
                                        (now + min(60 * 2 ** tries, 3600), vh))
                    continue
                self.db.execute("UPDATE jobs SET bytes = ?, post = ? WHERE blob = ?", (raw, post, vh))
            payers = json.loads(payers_json)
            paid = self.safe_paid(vh, payers, chain_time)
            if paid is None:
                self.db.execute("UPDATE jobs SET status = 'done' WHERE blob = ?", (vh,))
                continue
            if paid < floor:
                # Underpaid jobs back off, and once nothing safe is left in escrow they stop being
                # checked at all (a new payment reopens them), so no pile of them can crowd out the
                # window that paid jobs are picked from.
                expired = paid == 0 and now - created > EXPIRE_SECONDS
                self.db.execute("UPDATE jobs SET tries = tries + 1, next_try = ?, status = ? WHERE blob = ?",
                                (now + min(RECHECK_SECONDS * 2 ** tries, 3600), "expired" if expired else "new", vh))
                continue
            ready.append((vh, encode_blob([bytes(raw)]), paid, payers))
        return ready

    def maybe_publish(self, head):
        base_fee, tip, blob_base_fee, chain_time = self.prices()
        ready = self.ready_jobs(min_fee(base_fee, tip, blob_base_fee), chain_time)
        if not ready:
            return None
        paid = sum(p for _, _, p, _ in ready)
        n = len(ready)
        gas = gas_limit(n)
        caps = fee_caps(paid, gas, n, base_fee, tip, blob_base_fee)
        if caps is None:
            self.alert("underpaid", "gwei poster waiting", f"{n} blobs hold {paid} wei, not enough headroom at current prices")
            return None
        max_fee, max_blob_fee = caps
        balance = int(self.rpc("eth_getBalance", self.signer.address, "latest"), 16)
        if balance < worst_case(gas, max_fee, max_blob_fee, n):
            self.alert("balance", "gwei poster needs ETH",
                       f"{self.signer.address} has {balance} wei, a batch needs {worst_case(gas, max_fee, max_blob_fee, n)} up front")
            return None
        nonce = int(self.rpc("eth_getTransactionCount", self.signer.address, "latest"), 16)
        return self.send(nonce=nonce, blobs=[b for _, b, _, _ in ready], tip=tip, max_fee=max_fee,
                         max_blob_fee=max_blob_fee, gas=gas, paid=paid, head=head, replacements=0)

    def build(self, *, nonce, blobs, tip, max_fee, max_blob_fee, gas):
        return blob_transaction(
            self.signer, chain_id=self.chain_id, nonce=nonce, tip=tip, max_fee=max_fee, gas=gas, to=self.contract,
            data=SEL_PUBLISH, max_blob_fee=max_blob_fee, blobs=blobs, setup=self.setup, wrapper_version=self.wrapper_version)

    def send(self, *, nonce, blobs, tip, max_fee, max_blob_fee, gas, paid, head, replacements):
        if worst_case(gas, max_fee, max_blob_fee, len(blobs)) > paid:  # the invariant every path relies on
            raise AssertionError("fee caps exceed what the blobs paid")
        raw, tx_hash, hashes = self.build(nonce=nonce, blobs=blobs, tip=tip, max_fee=max_fee, max_blob_fee=max_blob_fee, gas=gas)
        # Recorded (and committed) before it is broadcast: if the broadcast times out after the node
        # took it, the transaction is still tracked and its blobs are never sent a second time.
        for vh, blob in zip(hashes, blobs):
            self.db.execute("INSERT OR REPLACE INTO blobs (vh, bytes) VALUES (?, ?)", (vh, blob))
        self.db.execute("INSERT INTO txs (hash, nonce, blobs, tip, max_fee, max_blob_fee, gas, paid, sent_block, replacements, status) "
                        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')",
                        (tx_hash, nonce, json.dumps(hashes), str(tip), str(max_fee), str(max_blob_fee), gas, str(paid), head, replacements))
        for vh in hashes:
            self.db.execute("UPDATE jobs SET status = 'sent', tx = ? WHERE blob = ?", (tx_hash, vh))
        self.db.commit()
        try:
            self.rpc("eth_sendRawTransaction", raw)
        except RpcError as error:
            if not already_known(error):
                # The node answered and refused it, so it can't be mined. A first send gives the
                # blobs back to the queue; a refused replacement leaves the original pending.
                self.db.execute("UPDATE txs SET status = 'refused' WHERE hash = ?", (tx_hash,))
                if replacements == 0:
                    for vh in hashes:
                        self.db.execute("UPDATE jobs SET status = 'new', tries = tries + 1 WHERE blob = ? AND tx = ?", (vh, tx_hash))
                self.db.commit()
                raise
        except Exception:
            # No answer (timeout, connection reset): it may have gone out. Keep tracking it; reconcile
            # rebroadcasts it or notices its nonce was used.
            log.warning("broadcasting %s got no answer; tracking it anyway", tx_hash)
        log.info("sent %s (nonce %s, %s blobs, at most %s of %s wei paid)", tx_hash, nonce, len(blobs),
                 worst_case(gas, max_fee, max_blob_fee, len(blobs)), paid)
        return tx_hash

    def settle(self, tx_hash, nonce, hashes_json, receipt):
        mined_ok = int(receipt["status"], 16) == 1
        self.db.execute("UPDATE txs SET status = 'replaced' WHERE nonce = ? AND hash != ? AND status = 'pending'", (nonce, tx_hash))
        self.db.execute("UPDATE txs SET status = ? WHERE hash = ?", ("mined" if mined_ok else "reverted", tx_hash))
        for vh in json.loads(hashes_json):
            if mined_ok:
                self.db.execute("UPDATE jobs SET status = 'done', tx = ? WHERE blob = ?", (tx_hash, vh))
            else:
                # A revert costs gas; never retry one forever.
                self.db.execute("UPDATE jobs SET reverts = reverts + 1, status = CASE WHEN reverts + 1 >= ? THEN 'failed' ELSE 'new' END "
                                "WHERE blob = ?", (MAX_REVERTS, vh))
        log.info("%s %s in block %s", tx_hash, "mined" if mined_ok else "REVERTED", int(receipt["blockNumber"], 16))
        if mined_ok:
            for vh in json.loads(hashes_json):
                self.pin(vh)
        else:
            self.alert("reverted", "gwei poster transaction reverted", tx_hash)

    def reconcile(self, head):
        """Settle sent transactions. Returns True while one is still pending."""
        pending = self.db.execute("SELECT hash, nonce, blobs, tip, max_fee, max_blob_fee, gas, paid, sent_block, replacements "
                                  "FROM txs WHERE status = 'pending' ORDER BY nonce, replacements").fetchall()
        if not pending:
            return False
        nonce = pending[0][1]
        same_nonce = [p for p in pending if p[1] == nonce]
        for tx_hash, _, hashes_json, *_ in same_nonce:
            receipt = self.rpc("eth_getTransactionReceipt", tx_hash)
            if receipt:
                self.settle(tx_hash, nonce, hashes_json, receipt)
                return False
        # No receipt yet. If the nonce was used anyway, look again (a block may have landed in between),
        # and only after a few more blocks give the blobs back to the queue.
        if int(self.rpc("eth_getTransactionCount", self.signer.address, "latest"), 16) > nonce:
            for tx_hash, _, hashes_json, *_ in same_nonce:
                receipt = self.rpc("eth_getTransactionReceipt", tx_hash)
                if receipt:
                    self.settle(tx_hash, nonce, hashes_json, receipt)
                    return False
            seen_used = self.used_nonces.setdefault(nonce, head)
            if head - seen_used < DROPPED_AFTER_BLOCKS:
                return True
            for tx_hash, _, hashes_json, *_ in same_nonce:
                self.db.execute("UPDATE txs SET status = 'dropped' WHERE hash = ?", (tx_hash,))
                for vh in json.loads(hashes_json):
                    self.db.execute("UPDATE jobs SET status = 'new' WHERE blob = ? AND status = 'sent'", (vh,))
            self.alert("dropped", "gwei poster nonce used elsewhere", f"nonce {nonce} was used by a transaction it did not send")
            return False
        tx_hash, _, hashes_json, tip, max_fee, max_blob_fee, gas, paid, sent_block, replacements = same_nonce[-1]
        tip, max_fee, max_blob_fee, paid = int(tip), int(max_fee), int(max_blob_fee), int(paid)
        hashes = json.loads(hashes_json)
        waited = head - sent_block
        if waited < REPLACE_AFTER_BLOCKS:
            return True
        base_fee, _, blob_base_fee, chain_time = self.prices()
        # What the blobs still hold safely. Once a deposit nears its refund time it stops counting, so
        # a transaction that can't land soon is neither resent nor replaced.
        safe = 0
        for vh in hashes:
            row = self.db.execute("SELECT payers FROM jobs WHERE blob = ?", (vh,)).fetchone()
            safe += self.safe_paid(vh, json.loads(row[0]) if row else [], chain_time) or 0
        if worst_case(gas, max_fee, max_blob_fee, len(hashes)) > safe:
            self.alert("deadline", "gwei poster transaction near its refund deadline",
                       f"{tx_hash} is still pending and its fees are about to become refundable; not resending it", every=86400)
            return True
        blobs = [bytes(self.db.execute("SELECT bytes FROM blobs WHERE vh = ?", (vh,)).fetchone()[0]) for vh in hashes]
        priced_out = max_fee < base_fee or max_blob_fee < blob_base_fee
        # A blob transaction is only replaced by one paying at least twice every fee, and the
        # replacement must stay within what its blobs safely hold. Replace when prices passed our
        # caps, or when a builder has ignored it for a while; otherwise keep it in the pool and wait.
        bump = (2 * tip, max(2 * max_fee, 2 * base_fee + 2 * tip), max(2 * max_blob_fee, 2 * blob_base_fee))
        if (not priced_out and waited < REPLACE_STALE_BLOCKS) or worst_case(gas, bump[1], bump[2], len(blobs)) > safe:
            if priced_out:
                self.alert("stuck", "gwei poster waiting for fees to fall",
                           f"{tx_hash} is priced out and a replacement would cost more than its blobs hold", every=86400)
            elif head - self.rebroadcasts.get(tx_hash, sent_block) >= REBROADCAST_AFTER_BLOCKS:
                # Nodes may drop a waiting transaction from their pool; resend the identical bytes.
                self.rebroadcasts[tx_hash] = head
                self.rebroadcast(nonce, blobs, tip, max_fee, max_blob_fee, gas)
            return True
        try:
            self.send(nonce=nonce, blobs=blobs, tip=bump[0], max_fee=bump[1], max_blob_fee=bump[2],
                      gas=gas, paid=safe, head=head, replacements=replacements + 1)
        except RpcError as error:
            log.warning("replacing %s: %s", tx_hash, error)
        return True

    def rebroadcast(self, nonce, blobs, tip, max_fee, max_blob_fee, gas):
        # Signatures are deterministic (RFC 6979), so this is byte-for-byte the transaction we sent.
        raw, tx_hash, _ = self.build(nonce=nonce, blobs=blobs, tip=tip, max_fee=max_fee, max_blob_fee=max_blob_fee, gas=gas)
        try:
            self.rpc("eth_sendRawTransaction", raw)
            log.info("rebroadcast %s", tx_hash)
        except RpcError as error:
            if not already_known(error):
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
        """Copy published blobs that some owner named for a post (from any publisher) from the
        gateway, check them against their versioned hash with KZG, and pin them. Blobs nobody named
        are never fetched, so spam blobs cost us nothing."""
        if not self.ipfs_api:
            return
        now = self.now()
        self.db.execute("INSERT OR IGNORE INTO mirror (vh, block, seen) SELECT p.vh, p.block, ? FROM published p "
                        "WHERE EXISTS (SELECT 1 FROM claims c WHERE c.vh = p.vh)", (now,))
        for vh, seen, tries in self.db.execute(
                "SELECT vh, seen, tries FROM mirror WHERE cid IS NULL AND next_try <= ? AND tries < 40 ORDER BY block LIMIT ?",
                (now, MIRRORS_PER_STEP)).fetchall():
            held = self.db.execute("SELECT bytes FROM blobs WHERE vh = ?", (vh,)).fetchone()
            blob = bytes(held[0]) if held else None
            if blob is None:
                try:
                    status, raw = http(f"{self.api}/blobs/{vh}", timeout=30)
                    if status == 200 and len(raw) == BLOB_BYTES and blob_hash(raw, self.setup) == vh:
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
