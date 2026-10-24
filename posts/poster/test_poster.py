#!/usr/bin/env python3
"""Tests for gwei_poster.py.

Unit tests cover RLP, the blob container (against vectors from gateway/posts-format.js), calldata
(against `cast calldata`), keys and signatures. The end-to-end test runs a local anvil chain on the
Osaka hardfork with the real NameNFT and GnsPosts, registers a name, authorizes a post that pays the
poster, and checks that the poster's blob transaction lands and emits PostPublished for the right
blob. It needs anvil, cast and forge build output, and is skipped without them.

  POSTER_TRUSTED_SETUP=trusted_setup.txt python -m unittest test_poster.py
"""

import hashlib
import http.server
import json
import os
import shutil
import socket
import sqlite3
import subprocess
import threading
import time
import unittest
import urllib.request

import ckzg

import gwei_poster as gp

# Foundry's anvil (1.5) only decodes the original EIP-4844 wrapper, even on Osaka, so the end-to-end
# test uses wrapper 0; test_live_nodes_accept_the_fusaka_wrapper covers wrapper 1 against real nodes.
ANVIL_WRAPPER = 0
ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
SETUP_PATH = os.environ.get("POSTER_TRUSTED_SETUP", os.path.join(os.path.dirname(__file__), "trusted_setup.txt"))
SETUP = ckzg.load_trusted_setup(SETUP_PATH, 0)


def post(title, body, time_=None):
    doc = {"v": 1, "title": title, "body": body}
    if time_ is not None:
        doc["time"] = time_
    return json.dumps(doc, ensure_ascii=False, separators=(",", ":")).encode()


class Formats(unittest.TestCase):
    def test_rlp(self):
        self.assertEqual(gp.rlp(b"dog").hex(), "83646f67")
        self.assertEqual(gp.rlp([b"cat", b"dog"]).hex(), "c88363617483646f67")
        self.assertEqual(gp.rlp(b"").hex(), "80")
        self.assertEqual(gp.rlp([]).hex(), "c0")
        self.assertEqual(gp.rlp(0).hex(), "80")
        self.assertEqual(gp.rlp(15).hex(), "0f")
        self.assertEqual(gp.rlp(1024).hex(), "820400")
        self.assertEqual(gp.rlp([[], [[]], [[], [[]]]]).hex(), "c7c0c1c0c3c0c1c0")
        long = b"Lorem ipsum dolor sit amet, consectetur adipisicing elit"
        self.assertEqual(gp.rlp(long).hex(), "b838" + long.hex())

    def test_blob_matches_the_gateway(self):
        # gateway/posts-format.js: encodeBlob([encodePost({title:'Hello',body:'First **post**',time:1700000000}),
        #                                      encodePost({title:'Ünïcode',body:'x'.repeat(5000)})]) → sha256
        posts = [post("Hello", "First **post**", 1700000000), post("Ünïcode", "x" * 5000)]
        self.assertEqual(posts[0], b'{"v":1,"title":"Hello","body":"First **post**","time":1700000000}')
        blob = gp.encode_blob(posts)
        self.assertEqual(hashlib.sha256(blob).hexdigest(), "b74ebebb5df2cd4faacfeb7527e69730acc6eb8a20392d4bed18014ee54eb960")
        self.assertEqual(gp.decode_blob(blob), posts)
        self.assertTrue(all(blob[i * 32] == 0 for i in range(4096)))

    def test_blob_limits(self):
        largest = b"a" * gp.MAX_POST_BYTES
        self.assertEqual(gp.decode_blob(gp.encode_blob([largest])), [largest])
        with self.assertRaises(ValueError):
            gp.encode_blob([largest + b"a"])
        self.assertTrue(gp.fits([largest]))
        self.assertFalse(gp.fits([largest, b"x"]))
        self.assertEqual(gp.decode_blob(b"\x01" * gp.BLOB_BYTES), [])

    def test_publish_calldata(self):
        # cast calldata "publish(bytes32[][])" "[[0x11…11,0x22…22]]"
        expected = ("efeb21dd" + "20".rjust(64, "0") + "1".rjust(64, "0") + "20".rjust(64, "0") + "2".rjust(64, "0")
                    + "11" * 32 + "22" * 32)
        self.assertEqual(gp.publish_calldata([b"\x11" * 32, b"\x22" * 32]).hex(), expected)

    def test_signer(self):
        signer = gp.Signer((1).to_bytes(32, "big"))
        self.assertEqual(signer.address, "0x7e5f4552091a69125d5dfcb7b8c2659029395bdf")

    def test_blob_transaction_shape(self):
        signer = gp.Signer(os.urandom(32))
        blob = gp.encode_blob([post("t", "b")])
        raw, tx_hash, vh = gp.blob_transaction(signer, chain_id=1, nonce=7, tip=10**8, max_fee=10**9, gas=70_000,
                                               to="0x" + "ab" * 20, data=b"\x01\x02", max_blob_fee=5, blob=blob, setup=SETUP)
        self.assertTrue(raw.startswith("0x03"))
        commitment = ckzg.blob_to_kzg_commitment(blob, SETUP)
        self.assertEqual(vh, "0x" + gp.versioned_hash(commitment).hex())
        self.assertIn(commitment.hex(), raw)
        self.assertEqual(len(tx_hash), 66)
        self.assertGreater(len(raw), 2 * (gp.BLOB_BYTES + 128 * 48))  # the blob and 128 cell proofs travel with it

    def test_cost(self):
        self.assertEqual(gp.batch_cost(1, 10**8, 5 * 10**7, 10**7), (gp.GAS_BASE + gp.GAS_PER_POST) * 15 * 10**7 + 131072 * 10**7)
        self.assertLess(gp.expected_gas(1), gp.gas_limit(1))


def rlp_decode(data, at=0):
    """Minimal RLP decoder for checking the transactions the poster builds."""
    p = data[at]
    if p < 0x80:
        return data[at:at + 1], at + 1
    if p < 0xB8:
        return data[at + 1:at + 1 + p - 0x80], at + 1 + p - 0x80
    if p < 0xC0:
        n = p - 0xB7
        length = int.from_bytes(data[at + 1:at + 1 + n], "big")
        return data[at + 1 + n:at + 1 + n + length], at + 1 + n + length
    if p < 0xF8:
        start, end = at + 1, at + 1 + p - 0xC0
    else:
        n = p - 0xF7
        start = at + 1 + n
        end = start + int.from_bytes(data[at + 1:at + 1 + n], "big")
    items, i = [], start
    while i < end:
        item, i = rlp_decode(data, i)
        items.append(item)
    return items, end


def tx_fields(raw_hex):
    network, _ = rlp_decode(bytes.fromhex(raw_hex[4:]))
    body = network[0]
    num = lambda b: int.from_bytes(b, "big")
    return {"nonce": num(body[1]), "tip": num(body[2]), "max_fee": num(body[3]), "gas": num(body[4]),
            "data": body[7], "max_blob_fee": num(body[9]), "hashes": body[10]}


class FakeChain:
    """Just enough of a node for the poster's spending decisions."""

    def __init__(self):
        self.head = 1000
        self.base_fee = 10**8  # 0.1 gwei
        self.blob_base_fee = 6 * 10**6
        self.tip = 10**5
        self.balance = 10**18
        self.nonce = 0
        self.logs = []
        self.sent = []
        self.receipts = {}
        self.send_error = None

    def __call__(self, method, *params):
        if method == "eth_blockNumber":
            return hex(self.head)
        if method == "eth_getLogs":
            f = params[0]
            return [l for l in self.logs if int(f["fromBlock"], 16) <= int(l["blockNumber"], 16) <= int(f["toBlock"], 16)]
        if method == "eth_getBlockByNumber":
            return {"baseFeePerGas": hex(self.base_fee)}
        if method == "eth_blobBaseFee":
            return hex(self.blob_base_fee)
        if method == "eth_maxPriorityFeePerGas":
            return hex(self.tip)
        if method == "eth_getBalance":
            return hex(self.balance)
        if method == "eth_getTransactionCount":
            return hex(self.nonce)
        if method == "eth_sendRawTransaction":
            self.sent.append(params[0])
            if self.send_error:
                raise self.send_error
            return "0x" + "00" * 32
        if method == "eth_getTransactionReceipt":
            return self.receipts.get(params[0])
        raise AssertionError("unexpected " + method)


CONTRACT = "0x" + "c0" * 20


def auth_log(block, idx, post_hash, publisher, fee, token="0x" + "11" * 32, tx=None):
    return {"address": CONTRACT, "blockNumber": hex(block), "logIndex": hex(idx), "removed": False,
            "transactionHash": tx or "0x" + f"{block:x}{idx:x}".rjust(64, "0"),
            "topics": [gp.T_AUTHORIZED, token, post_hash, "0x" + "00" * 12 + "aa" * 20],
            "data": "0x" + publisher[2:].rjust(64, "0") + hex(fee)[2:].rjust(64, "0")}


def pub_log(block, idx, post_hash, vh):
    return {"address": CONTRACT, "blockNumber": hex(block), "logIndex": hex(idx), "removed": False,
            "transactionHash": "0x" + f"{block:x}{idx:x}".rjust(64, "0"),
            "topics": [gp.T_PUBLISHED, post_hash, vh, "0x" + "00" * 12 + "bb" * 20], "data": "0x"}


class Griefing(unittest.TestCase):
    """The publisher holds funds, so every way to make it spend more than it was paid is tested."""

    def setUp(self):
        FakeApi.requests = []
        self.api = http.server.ThreadingHTTPServer(("127.0.0.1", 0), FakeApi)
        threading.Thread(target=self.api.serve_forever, daemon=True).start()
        self.chain = FakeChain()
        self.signer = gp.Signer(os.urandom(32))
        self.poster = gp.Poster(rpc=self.chain, api=f"http://127.0.0.1:{self.api.server_port}/api", contract=CONTRACT,
                                from_block=0, signer=self.signer, db=sqlite3.connect(":memory:"), setup=SETUP,
                                ipfs_api="http://127.0.0.1:9", notify=lambda *a: self.alerts.append(a))
        self.alerts = []
        self.prices = (self.chain.base_fee, max(self.chain.tip, gp.MIN_TIP), self.chain.blob_base_fee)

    def tearDown(self):
        self.api.shutdown()
        self.api.server_close()

    def job(self, block, idx, fee, title="post"):
        data = post(f"{title} {block}/{idx}", "body")
        h = "0x" + gp.keccak(data).hex()
        FakeApi.posts[h] = data
        self.chain.logs.append(auth_log(block, idx, h, self.signer.address, fee))
        return h

    def test_cheap_posts_never_ride_on_paid_ones(self):
        good = self.job(10, 0, gp.quote(*self.prices))
        cheap = [self.job(11, i, 1) for i in range(50)]
        self.poster.step()
        self.assertEqual(len(self.chain.sent), 1)
        tx = tx_fields(self.chain.sent[0])
        self.assertEqual(tx["data"], gp.publish_calldata([bytes.fromhex(good[2:])]))
        fetched = {path.split("/")[3] for path in FakeApi.requests if "/posts/" in path}
        self.assertTrue(fetched.isdisjoint(cheap), "underpaid posts are not even downloaded")

    def test_a_transaction_never_risks_more_than_its_posts_paid(self):
        paid = [self.job(10, i, gp.quote(*self.prices)) for i in range(3)]
        self.poster.step()
        tx = tx_fields(self.chain.sent[0])
        self.assertLessEqual(gp.worst_case(tx["gas"], tx["max_fee"], tx["max_blob_fee"]), 3 * gp.quote(*self.prices))
        self.assertGreaterEqual(tx["max_fee"], int(gp.MIN_HEADROOM * self.chain.base_fee))
        self.assertEqual(len(paid), 3)

    def test_fee_caps_invariant_over_many_prices(self):
        import random
        rng = random.Random(7)
        for _ in range(2000):
            base, tip, blob = rng.randint(1, 500 * gp.GWEI), rng.randint(0, gp.MAX_TIP), rng.randint(1, 50 * gp.GWEI)
            n = rng.randint(1, gp.MAX_BATCH)
            floor = gp.min_fee(base, tip, blob)
            fees = [floor + rng.randint(0, floor) for _ in range(n)]
            gas = gp.gas_limit(n)
            caps = gp.fee_caps(sum(fees), gas, base, tip, blob)
            self.assertIsNotNone(caps, "posts that each pay the minimum can always be carried")
            self.assertLessEqual(gp.worst_case(gas, *caps), sum(fees))
            self.assertGreaterEqual(caps[0], int(gp.MIN_HEADROOM * base) + tip)
            self.assertGreaterEqual(caps[1], blob)
            self.assertGreater(gp.quote(base, tip, blob), floor, "the dapp's quote clears the minimum")
            self.assertIsNone(gp.fee_caps(floor // 2, gp.gas_limit(1), base, tip, blob))

    def test_replacement_stays_within_what_was_paid(self):
        self.job(10, 0, gp.quote(*self.prices))
        self.poster.step()
        first = tx_fields(self.chain.sent[0])
        # Prices triple: the transaction is priced out, and doubling every fee would cost more than
        # the post paid, so the poster waits instead of replacing.
        self.chain.base_fee *= 3
        self.chain.head += gp.REPLACE_AFTER_BLOCKS
        self.poster.step()
        self.assertEqual(len(self.chain.sent), 1)
        self.assertTrue(any("waiting for fees" in a[0] for a in self.alerts))
        # A generously paid post can be replaced, at no less than twice every fee and within its payment.
        chain2 = FakeChain()
        self.chain.__dict__.update(chain2.__dict__)
        self.setUp_rich()
        self.poster.step()
        rich = tx_fields(self.chain.sent[0])
        self.chain.base_fee *= 3
        self.chain.head += gp.REPLACE_AFTER_BLOCKS
        self.poster.step()
        self.assertEqual(len(self.chain.sent), 2)
        bumped = tx_fields(self.chain.sent[1])
        self.assertEqual(bumped["nonce"], rich["nonce"])
        for key in ("tip", "max_fee", "max_blob_fee"):
            self.assertGreaterEqual(bumped[key], 2 * rich[key])
        self.assertLessEqual(gp.worst_case(bumped["gas"], bumped["max_fee"], bumped["max_blob_fee"]), 10**16)
        self.assertEqual(first["nonce"], 0)

    def setUp_rich(self):
        self.poster = gp.Poster(rpc=self.chain, api=f"http://127.0.0.1:{self.api.server_port}/api", contract=CONTRACT,
                                from_block=0, signer=self.signer, db=sqlite3.connect(":memory:"), setup=SETUP)
        self.job(10, 0, 10**16)

    def test_unconfirmed_authorizations_wait(self):
        self.chain.logs.append(auth_log(self.chain.head - 1, 0, "0x" + "ab" * 32, self.signer.address, 10**16))
        self.poster.step()
        self.assertEqual(self.poster.db.execute("SELECT COUNT(*) FROM jobs").fetchone()[0], 0)
        self.chain.head += gp.CONFIRMATIONS
        self.poster.scan(self.chain.head - gp.CONFIRMATIONS)
        self.assertEqual(self.poster.db.execute("SELECT COUNT(*) FROM jobs").fetchone()[0], 1)

    def test_a_rescanned_payment_is_counted_once(self):
        h = self.job(10, 0, 5)
        self.poster.scan(self.chain.head)
        self.poster.set_meta("cursor", 0)  # as if a pass were retried
        self.poster.scan(self.chain.head)
        self.assertEqual(self.poster.db.execute("SELECT fee FROM jobs WHERE hash = ?", (h,)).fetchone()[0], "5")
        self.chain.logs.append(auth_log(20, 0, h, self.signer.address, 7))  # a second, real payment
        self.poster.set_meta("cursor", 0)
        self.poster.scan(self.chain.head)
        self.assertEqual(self.poster.db.execute("SELECT fee FROM jobs WHERE hash = ?", (h,)).fetchone()[0], "12")

    def test_reverts_are_not_retried_forever(self):
        h = self.job(10, 0, gp.quote(*self.prices))
        for round_ in range(gp.MAX_REVERTS):
            self.poster.step()
            tx_hash = self.poster.db.execute("SELECT hash FROM txs WHERE status = 'pending'").fetchone()[0]
            self.chain.receipts[tx_hash] = {"status": "0x0", "blockNumber": hex(self.chain.head)}
            self.chain.nonce += 1
            self.chain.head += 1
            self.poster.step()
        self.assertEqual(self.poster.db.execute("SELECT status FROM jobs WHERE hash = ?", (h,)).fetchone()[0], "failed")
        sent = len(self.chain.sent)
        self.chain.head += 10
        self.poster.step()
        self.assertEqual(len(self.chain.sent), sent)

    def test_batches_are_capped(self):
        fee = gp.quote(*self.prices)
        for i in range(gp.MAX_BATCH + 50):
            self.job(10 + i // 100, i % 100, fee, title="t")
        for _ in range(40):  # fetching is limited per pass, so it takes a few passes
            if self.chain.sent:
                break
            self.poster.step()
        while not self.chain.sent:
            self.poster.step()
        tx = tx_fields(self.chain.sent[0])
        self.assertLessEqual(len(tx["data"]), len(gp.publish_calldata([b"\x00" * 32] * gp.MAX_BATCH)))
        self.assertLessEqual(tx["gas"], gp.gas_limit(gp.MAX_BATCH))
        self.assertLess(gp.gas_limit(gp.MAX_BATCH), 2**24)

    def test_spam_blobs_are_never_mirrored(self):
        vh = "0x01" + "cd" * 31
        self.chain.logs.append(pub_log(10, 0, "0x" + "ef" * 32, vh))
        self.poster.step()
        self.assertFalse(any("/blobs/" in path for path in FakeApi.requests))

    def test_a_payment_moved_by_a_reorg_is_counted_once(self):
        h = self.job(10, 0, 5)
        tx = self.chain.logs[-1]["transactionHash"]
        self.poster.scan(self.chain.head)
        # The same transaction lands in another block after a reorg.
        self.chain.logs.append(auth_log(12, 3, h, self.signer.address, 5, tx=tx))
        self.poster.set_meta("cursor", 0)
        self.poster.scan(self.chain.head)
        self.assertEqual(self.poster.db.execute("SELECT fee FROM jobs WHERE hash = ?", (h,)).fetchone()[0], "5")

    def test_a_broadcast_with_no_answer_is_tracked_and_never_sent_twice(self):
        self.job(10, 0, gp.quote(*self.prices))
        self.chain.send_error = TimeoutError("timed out")  # the node may have taken it anyway
        self.poster.step()
        self.assertEqual(len(self.chain.sent), 1)
        self.assertEqual(self.poster.db.execute("SELECT status FROM txs").fetchone()[0], "pending")
        self.chain.send_error = None
        for _ in range(3):
            self.chain.head += 1
            self.poster.step()
        nonces = {tx_fields(r)["nonce"] for r in self.chain.sent}
        self.assertEqual(nonces, {0}, "no second batch at a new nonce, only rebroadcasts of the same one")

    def test_a_refused_broadcast_gives_the_posts_back(self):
        h = self.job(10, 0, gp.quote(*self.prices))
        self.chain.send_error = gp.RpcError("eth_sendRawTransaction: insufficient funds")
        with self.assertRaises(gp.RpcError):
            self.poster.step()
        self.assertEqual(self.poster.db.execute("SELECT status FROM txs").fetchone()[0], "refused")
        self.assertEqual(self.poster.db.execute("SELECT status FROM jobs WHERE hash = ?", (h,)).fetchone()[0], "new")

    def test_a_used_nonce_is_rechecked_before_requeueing(self):
        h = self.job(10, 0, gp.quote(*self.prices))
        self.poster.step()
        tx_hash = self.poster.db.execute("SELECT hash FROM txs").fetchone()[0]
        self.chain.nonce = 1  # the nonce is used, but the receipt isn't visible yet
        self.chain.head += 1
        self.poster.step()
        self.assertEqual(self.poster.db.execute("SELECT status FROM jobs WHERE hash = ?", (h,)).fetchone()[0], "sent")
        self.chain.receipts[tx_hash] = {"status": "0x1", "blockNumber": hex(self.chain.head)}
        self.chain.head += 1
        self.poster.step()
        self.assertEqual(self.poster.db.execute("SELECT status FROM jobs WHERE hash = ?", (h,)).fetchone()[0], "done")
        self.assertEqual(len(self.chain.sent), 1)

    def test_jobs_without_bytes_cant_crowd_out_the_rest(self):
        fee = gp.quote(*self.prices)
        for i in range(60):  # paid, but their bytes never show up
            self.chain.logs.append(auth_log(10, i, "0x" + f"{i:064x}", self.signer.address, fee))
        good = self.job(20, 0, fee)
        for _ in range(4):
            if self.chain.sent:
                break
            self.chain.head += 1
            self.poster.step()
        self.assertEqual(tx_fields(self.chain.sent[0])["data"], gp.publish_calldata([bytes.fromhex(good[2:])]))

    def test_no_funds_no_spend(self):
        self.chain.balance = 0
        self.job(10, 0, gp.quote(*self.prices))
        self.poster.step()
        self.assertEqual(self.chain.sent, [])
        self.assertTrue(any("needs ETH" in a[0] for a in self.alerts))


def free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


class FakeApi(http.server.BaseHTTPRequestHandler):
    posts = {}
    blobs = {}

    def log_message(self, *args):
        pass

    requests = []

    def do_GET(self):
        FakeApi.requests.append(self.path)
        parts = self.path.strip("/").split("/")
        data = None
        if len(parts) == 4 and parts[:2] == ["api", "posts"] and parts[3] == "raw":
            data = self.posts.get(parts[2])
        elif len(parts) == 3 and parts[:2] == ["api", "blobs"]:
            data = self.blobs.get(parts[2])
        self.send_response(200 if data is not None else 404)
        self.end_headers()
        self.wfile.write(data or b"")


@unittest.skipUnless(shutil.which("anvil") and shutil.which("cast") and os.path.exists(os.path.join(ROOT, "out", "GnsPosts.sol", "GnsPosts.json")),
                     "needs anvil, cast and `forge build`")
class EndToEnd(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.port = free_port()
        cls.url = f"http://127.0.0.1:{cls.port}"
        cls.anvil = subprocess.Popen(["anvil", "--hardfork", "osaka", "--port", str(cls.port), "--silent"],
                                     stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        try:
            cls.prepare()
        except BaseException:
            cls.anvil.terminate()
            raise

    @classmethod
    def prepare(cls):
        for _ in range(100):
            try:
                gp.Rpc(cls.url)("eth_chainId")
                break
            except Exception:
                time.sleep(0.1)
        cls.rpc = gp.Rpc(cls.url)
        cls.owner = cls.rpc("eth_accounts")[0]
        cls.nft = cls.deploy("NameNFT.sol/NameNFT.json", "")
        cls.posts = cls.deploy("GnsPosts.sol/GnsPosts.json", cls.nft[2:].rjust(64, "0"))
        # Register alice.gwei for the owner: commit, wait out the commitment age, reveal.
        secret = "0x" + "5e" * 32
        commitment = cls.cast("call", cls.nft, "makeCommitment(string,address,bytes32)(bytes32)", "alice", cls.owner, secret)
        cls.cast("send", "--unlocked", "--from", cls.owner, cls.nft, "commit(bytes32)", commitment)
        cls.rpc("evm_increaseTime", 120)
        cls.rpc("evm_mine")
        fee = cls.cast("call", cls.nft, "getFee(uint256)(uint256)", "5").split()[0]
        cls.cast("send", "--unlocked", "--from", cls.owner, "--value", fee, cls.nft, "reveal(string,bytes32)", "alice", secret)
        cls.token = cls.cast("call", cls.nft, "computeId(string)(uint256)", "alice.gwei").split()[0]
        cls.api_server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), FakeApi)
        threading.Thread(target=cls.api_server.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.anvil.terminate()
        cls.api_server.shutdown()

    @classmethod
    def cast(cls, *args):
        return subprocess.run(["cast", *args, "--rpc-url", cls.url], check=True, capture_output=True, text=True, timeout=60).stdout.strip()

    @classmethod
    def deploy(cls, artifact, args_hex):
        with open(os.path.join(ROOT, "out", artifact)) as fh:
            bytecode = json.load(fh)["bytecode"]["object"]
        tx = cls.rpc("eth_sendTransaction", {"from": cls.owner, "data": bytecode + args_hex, "gas": hex(16_000_000)})
        return cls.receipt(tx)["contractAddress"]

    @classmethod
    def receipt(cls, tx):
        for _ in range(100):
            receipt = cls.rpc("eth_getTransactionReceipt", tx)
            if receipt:
                return receipt
            time.sleep(0.05)
        raise AssertionError(f"{tx} was never mined")

    def make_poster(self, signer, **kwargs):
        return gp.Poster(rpc=self.rpc, api=f"http://127.0.0.1:{self.api_server.server_port}/api", contract=self.posts,
                         from_block=0, signer=signer, db=sqlite3.connect(":memory:"), setup=SETUP, chain_id=31337,
                         wrapper_version=ANVIL_WRAPPER, **kwargs)

    def authorize(self, post_hash, publisher, fee):
        self.cast("send", "--unlocked", "--from", self.owner, "--value", str(fee), self.posts,
                  "authorize(uint256,bytes32,address)", self.token, post_hash, publisher)

    def mine(self, blocks=gp.CONFIRMATIONS):
        for _ in range(blocks):
            self.rpc("evm_mine")

    def published_logs(self):
        return self.rpc("eth_getLogs", {"address": self.posts, "fromBlock": "0x0", "toBlock": "latest", "topics": [gp.T_PUBLISHED]})

    def test_publishes_a_paid_post_in_a_blob(self):
        signer = gp.Signer(os.urandom(32))
        self.rpc("anvil_setBalance", signer.address, hex(10**17))
        poster = self.make_poster(signer)
        a, b = post("First", "Hello from **anvil**", 1700000000), post("Second", "ü" * 3000)
        ha, hb = "0x" + gp.keccak(a).hex(), "0x" + gp.keccak(b).hex()
        FakeApi.posts.update({ha: a, hb: b})
        self.authorize(ha, signer.address, 10**15)
        self.authorize(hb, signer.address, 10**15)
        self.authorize("0x" + "99" * 32, "0x" + "00" * 19 + "01", 0)  # someone else's job
        self.mine()

        poster.step()  # finds both jobs and sends one blob transaction
        sent = poster.db.execute("SELECT hash, vh, status FROM txs").fetchall()
        self.assertEqual(len(sent), 1)
        tx_hash, vh, _ = sent[0]
        self.mine()
        poster.step()  # settles it
        self.assertEqual(poster.db.execute("SELECT status FROM txs").fetchone()[0], "mined")
        self.assertEqual(dict(poster.db.execute("SELECT hash, status FROM jobs").fetchall()), {ha: "done", hb: "done"})

        receipt = self.rpc("eth_getTransactionReceipt", tx_hash)
        self.assertEqual(int(receipt["status"], 16), 1)
        self.assertEqual(int(receipt["blobGasUsed"], 16), gp.BLOB_GAS)
        logs = self.published_logs()
        self.assertEqual({(l["topics"][1], l["topics"][2], l["topics"][3][-40:]) for l in logs},
                         {(ha, vh, signer.address[2:]), (hb, vh, signer.address[2:])})
        tx = self.rpc("eth_getTransactionByHash", tx_hash)
        self.assertEqual(tx["blobVersionedHashes"], [vh])
        # The blob the chain committed to decodes to exactly the authorized posts.
        blob = bytes(poster.db.execute("SELECT bytes FROM blobs WHERE vh = ?", (vh,)).fetchone()[0])
        self.assertEqual(gp.decode_blob(blob), [a, b])

    def test_waits_until_the_fee_covers_the_cost(self):
        signer = gp.Signer(os.urandom(32))
        self.rpc("anvil_setBalance", signer.address, hex(10**17))
        poster = self.make_poster(signer)
        c = post("Cheap", "underpaid")
        hc = "0x" + gp.keccak(c).hex()
        FakeApi.posts[hc] = c
        self.authorize(hc, signer.address, 1)
        self.mine()
        poster.step()
        self.assertEqual(poster.db.execute("SELECT COUNT(*) FROM txs").fetchone()[0], 0)
        self.assertEqual(poster.db.execute("SELECT status FROM jobs").fetchone()[0], "new")
        self.authorize(hc, signer.address, 10**15)  # a second authorization tops it up
        self.mine()
        poster.step()
        self.assertEqual(poster.db.execute("SELECT COUNT(*) FROM txs").fetchone()[0], 1)

    def test_rejects_bytes_that_dont_match_the_hash(self):
        signer = gp.Signer(os.urandom(32))
        self.rpc("anvil_setBalance", signer.address, hex(10**17))
        poster = self.make_poster(signer)
        good = post("Good", "real")
        hd = "0x" + gp.keccak(good).hex()
        FakeApi.posts[hd] = post("Evil", "swapped")
        self.authorize(hd, signer.address, 10**15)
        self.mine()
        poster.step()
        self.assertEqual(poster.db.execute("SELECT COUNT(*) FROM txs").fetchone()[0], 0)
        self.assertEqual(poster.db.execute("SELECT tries FROM jobs").fetchone()[0], 1)

    def test_node_rejects_a_corrupted_proof(self):
        # Anvil checks the blob proof, so the happy path above really exercised the KZG side.
        signer = gp.Signer(os.urandom(32))
        self.rpc("anvil_setBalance", signer.address, hex(10**17))
        blob = gp.encode_blob([post("x", "y")])
        other = gp.encode_blob([post("x", "z")])
        nonce = int(self.rpc("eth_getTransactionCount", signer.address, "pending"), 16)
        raw, _, _ = gp.blob_transaction(signer, chain_id=31337, nonce=nonce, tip=10**9, max_fee=10**11, gas=100_000,
                                        to=self.posts, data=gp.publish_calldata([b"\x01" * 32]), max_blob_fee=10**9,
                                        blob=blob, setup=SETUP, wrapper_version=0)
        proof = ckzg.compute_blob_kzg_proof(blob, ckzg.blob_to_kzg_commitment(blob, SETUP), SETUP).hex()
        wrong = ckzg.compute_blob_kzg_proof(other, ckzg.blob_to_kzg_commitment(other, SETUP), SETUP).hex()
        self.assertTrue(raw.endswith(proof))
        with self.assertRaises(gp.RpcError):
            self.rpc("eth_sendRawTransaction", raw[: -len(proof)] + wrong)


if __name__ == "__main__":
    unittest.main()
