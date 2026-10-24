#!/usr/bin/env python3
"""Tests for gwei_poster.py.

Formats: RLP, the blob container (against vectors from gateway/posts-format.js), keys, escrow keys
and transaction shape. Griefing: every way to make the publisher spend more than it is paid, on a
fake chain that models GnsPosts' escrow. EndToEnd: a local anvil chain on Osaka with the real
NameNFT and GnsPosts; each scenario checks the publisher's balance never ends lower than it started.
The end-to-end tests need anvil, cast and `forge build`, and are skipped without them.

  POSTER_TRUSTED_SETUP=trusted_setup.txt python -m unittest test_poster.py
"""

import hashlib
import http.server
import json
import os
import random
import shutil
import socket
import sqlite3
import subprocess
import threading
import time
import unittest

import ckzg

import gwei_poster as gp

# Foundry's anvil (1.5) only decodes the original EIP-4844 wrapper, even on Osaka, so the end-to-end
# tests use wrapper 0; live mainnet and Sepolia nodes decode wrapper 1 (checked separately).
ANVIL_WRAPPER = 0
ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
SETUP_PATH = os.environ.get("POSTER_TRUSTED_SETUP", os.path.join(os.path.dirname(__file__), "trusted_setup.txt"))
SETUP = ckzg.load_trusted_setup(SETUP_PATH, 0)


def post(title, body):
    return json.dumps({"v": 1, "title": title, "body": body}, ensure_ascii=False, separators=(",", ":")).encode()


def post_hash(data):
    return "0x" + gp.keccak(data).hex()


def blob_of(data):
    return gp.encode_blob([data])


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
        # gateway/posts-format.js: encodeBlob([encodePost({title:'Hello',body:'First **post**'}),
        #                                      encodePost({title:'Ünïcode',body:'x'.repeat(5000)})]) → sha256
        posts = [post("Hello", "First **post**"), post("Ünïcode", "x" * 5000)]
        self.assertEqual(posts[0], b'{"v":1,"title":"Hello","body":"First **post**"}')
        blob = gp.encode_blob(posts)
        self.assertEqual(hashlib.sha256(blob).hexdigest(), "9c3e258e73193074a80ba36a65577f1676207ad0e437dcfdecb37dc1ca682a95")
        self.assertEqual(gp.decode_blob(blob), posts)
        self.assertTrue(all(blob[i * 32] == 0 for i in range(4096)))

    def test_blob_limits(self):
        largest = b"a" * gp.MAX_POST_BYTES
        self.assertEqual(gp.decode_blob(gp.encode_blob([largest])), [largest])
        with self.assertRaises(ValueError):
            gp.encode_blob([largest + b"a"])
        self.assertEqual(gp.decode_blob(b"\x01" * gp.BLOB_BYTES), [])

    def test_a_blobhash_depends_only_on_the_bytes(self):
        a = blob_of(post("t", "b"))
        self.assertEqual(gp.blob_hash(a, SETUP), gp.blob_hash(bytes(a), SETUP))
        self.assertNotEqual(gp.blob_hash(a, SETUP), gp.blob_hash(blob_of(post("t", "c")), SETUP))
        self.assertTrue(gp.blob_hash(a, SETUP).startswith("0x01"))

    def test_escrow_key_matches_the_contract(self):
        # cast keccak $(cast abi-encode "f(bytes32,address)" 0x01…01 0x00…ab)
        vh = "0x01" + "01" * 31
        who = "0x" + "00" * 19 + "ab"
        expected = gp.keccak(bytes.fromhex(vh[2:]) + bytes(12) + bytes.fromhex(who[2:]))
        self.assertEqual(gp.escrow_key(vh, who), expected)
        out = subprocess.run(["cast", "keccak", subprocess.run(["cast", "abi-encode", "f(bytes32,address)", vh, who],
                             capture_output=True, text=True).stdout.strip()], capture_output=True, text=True).stdout.strip() if shutil.which("cast") else None
        if out:
            self.assertEqual("0x" + expected.hex(), out)

    def test_signer(self):
        self.assertEqual(gp.Signer((1).to_bytes(32, "big")).address, "0x7e5f4552091a69125d5dfcb7b8c2659029395bdf")

    def test_blob_transaction_shape(self):
        signer = gp.Signer(os.urandom(32))
        blobs = [blob_of(post("a", "1")), blob_of(post("b", "2"))]
        raw, tx_hash, hashes = gp.blob_transaction(signer, chain_id=1, nonce=7, tip=10**8, max_fee=10**9, gas=70_000,
                                                   to="0x" + "ab" * 20, data=gp.SEL_PUBLISH, max_blob_fee=5, blobs=blobs, setup=SETUP)
        self.assertTrue(raw.startswith("0x03"))
        self.assertEqual(hashes, [gp.blob_hash(b, SETUP) for b in blobs])
        self.assertEqual(len(tx_hash), 66)
        self.assertGreater(len(raw), 2 * 2 * (gp.BLOB_BYTES + 128 * 48))  # two blobs and their cell proofs

    def test_costs(self):
        self.assertEqual(gp.batch_cost(2, 10**8, 5 * 10**7, 10**7), gp.expected_gas(2) * 15 * 10**7 + 2 * 131072 * 10**7)
        self.assertLess(gp.expected_gas(1), gp.gas_limit(1))
        for n in range(1, gp.MAX_BLOBS_PER_TX + 1):
            self.assertLessEqual(gp.gas_limit(n), n * gp.gas_limit(1), "sharing a transaction never needs more gas than sending alone")


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
            "data": body[7], "max_blob_fee": num(body[9]), "hashes": ["0x" + h.hex() for h in body[10]]}


CONTRACT = "0x" + "c0" * 20
word = lambda v: hex(v)[2:].rjust(64, "0")


class FakeChain:
    """Just enough of a node and of GnsPosts' escrow for the poster's spending decisions."""

    def __init__(self, publisher):
        self.publisher = publisher
        self.head = 1000
        self.time = 1_800_000_000
        self.base_fee = 10**8  # 0.1 gwei
        self.blob_base_fee = 6 * 10**6
        self.tip = 10**5
        self.balance = 10**18
        self.nonce = 0
        self.logs = []
        self.sent = []
        self.receipts = {}
        self.send_error = None
        self.deposits = {}  # escrow key → {payer: (amount, refundableAt)}
        self.delivered = set()

    def authorize(self, data, payer, fee, publisher=None, vh=None, block=10, idx=0, tx=None):
        """An author's PostAuthorized: escrow for the blob their post makes (or `vh`, if they name another)."""
        publisher = publisher or self.publisher
        vh = vh or gp.blob_hash(blob_of(data), SETUP)
        key = gp.escrow_key(vh, publisher)
        amount, _ = self.deposits.setdefault(key, {}).get(payer, (0, 0))
        self.deposits[key][payer] = (amount + fee, self.time + 86400)
        self.logs.append({"address": CONTRACT, "blockNumber": hex(block), "logIndex": hex(idx), "removed": False,
                          "transactionHash": tx or "0x" + f"{block:x}{idx:x}{len(self.logs):x}".rjust(64, "0"),
                          "topics": [gp.T_AUTHORIZED, "0x" + word(0x11), post_hash(data), "0x" + payer[2:].rjust(64, "0")],
                          "data": "0x" + vh[2:] + publisher[2:].rjust(64, "0") + word(fee)})
        return vh

    def mine(self, raw):
        """Include a sent transaction: deliver its blobs and pay the escrow, like GnsPosts.publish()."""
        fields = tx_fields(raw)
        paid = 0
        for vh in fields["hashes"]:
            key = gp.escrow_key(vh, self.publisher)
            if key not in self.delivered:
                self.delivered.add(key)
                paid += sum(a for a, _ in self.deposits.pop(key, {}).values())
        gas = gp.expected_gas(len(fields["hashes"]))
        cost = gas * (self.base_fee + min(fields["tip"], fields["max_fee"] - self.base_fee)) + len(fields["hashes"]) * gp.BLOB_GAS * self.blob_base_fee
        self.balance += paid - cost
        self.nonce += 1
        return paid, cost

    def __call__(self, method, *params):
        if method == "eth_blockNumber":
            return hex(self.head)
        if method == "eth_getLogs":
            f = params[0]
            return [l for l in self.logs if int(f["fromBlock"], 16) <= int(l["blockNumber"], 16) <= int(f["toBlock"], 16)]
        if method == "eth_getBlockByNumber":
            return {"baseFeePerGas": hex(self.base_fee), "timestamp": hex(self.time)}
        if method == "eth_blobBaseFee":
            return hex(self.blob_base_fee)
        if method == "eth_maxPriorityFeePerGas":
            return hex(self.tip)
        if method == "eth_getBalance":
            return hex(self.balance)
        if method == "eth_getTransactionCount":
            return hex(self.nonce)
        if method == "eth_call":
            data = params[0]["data"][2:]
            key = bytes.fromhex(data[8:72])
            if data.startswith(gp.SEL_DELIVERED):
                return "0x" + word(int(key in self.delivered))
            if data.startswith(gp.SEL_DEPOSITS):
                amount, at = self.deposits.get(key, {}).get("0x" + data[72 + 24:136], (0, 0))
                return "0x" + word(amount) + word(at)
            raise AssertionError("unexpected call " + data[:8])
        if method == "eth_sendRawTransaction":
            self.sent.append(params[0])
            if self.send_error:
                raise self.send_error
            return "0x" + "00" * 32
        if method == "eth_getTransactionReceipt":
            return self.receipts.get(params[0])
        raise AssertionError("unexpected " + method)


def free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


class FakeApi(http.server.BaseHTTPRequestHandler):
    posts = {}
    blobs = {}
    requests = []

    def log_message(self, *args):
        pass

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


class Griefing(unittest.TestCase):
    """The publisher holds funds, so every way to make it spend more than it is paid is tested."""

    def setUp(self):
        FakeApi.requests = []
        self.api = http.server.ThreadingHTTPServer(("127.0.0.1", 0), FakeApi)
        threading.Thread(target=self.api.serve_forever, daemon=True).start()
        self.signer = gp.Signer(os.urandom(32))
        self.chain = FakeChain(self.signer.address)
        self.alerts = []
        self.poster = gp.Poster(rpc=self.chain, api=f"http://127.0.0.1:{self.api.server_port}/api", contract=CONTRACT,
                                from_block=0, signer=self.signer, db=sqlite3.connect(":memory:"), setup=SETUP,
                                ipfs_api="http://127.0.0.1:9", notify=lambda *a: self.alerts.append(a))
        self.quote = gp.quote(self.chain.base_fee, max(self.chain.tip, gp.MIN_TIP), self.chain.blob_base_fee)
        self.alice = "0x" + "a1" * 20

    def tearDown(self):
        self.api.shutdown()
        self.api.server_close()

    def job(self, title, fee, payer=None, **kwargs):
        data = post(title, "body of " + title)
        FakeApi.posts[post_hash(data)] = data
        return self.chain.authorize(data, payer or self.alice, fee, **kwargs), data

    def sent_hashes(self, i=0):
        return tx_fields(self.chain.sent[i])["hashes"]

    def test_a_paid_blob_goes_out_and_the_publisher_comes_out_ahead(self):
        vh, _ = self.job("paid", self.quote)
        start = self.chain.balance
        self.poster.step()
        self.assertEqual(self.sent_hashes(), [vh])
        paid, cost = self.chain.mine(self.chain.sent[0])
        self.assertEqual(paid, self.quote)
        self.assertGreater(self.chain.balance, start, f"paid {paid}, cost {cost}")

    def test_cheap_blobs_never_ride_on_paid_ones(self):
        good, _ = self.job("paid", self.quote)
        cheap = [self.job(f"cheap {i}", 1)[0] for i in range(5)]
        self.poster.step()
        self.assertEqual(self.sent_hashes(), [good])
        self.assertTrue(set(cheap).isdisjoint(self.sent_hashes()))

    def test_a_blob_that_isnt_the_one_its_post_makes_is_never_sent(self):
        data = post("swapped", "x")
        FakeApi.posts[post_hash(data)] = data
        other = gp.blob_hash(blob_of(post("something else", "y")), SETUP)
        self.chain.authorize(data, self.alice, 10 * self.quote, vh=other)
        self.poster.step()
        self.assertEqual(self.chain.sent, [])
        self.assertEqual(self.poster.db.execute("SELECT status FROM jobs").fetchone()[0], "mismatch")

    def test_deposits_close_to_their_refund_time_dont_count(self):
        self.job("late", self.quote)
        self.chain.time += 86400 - gp.SAFETY_MARGIN + 1  # refundable in under SAFETY_MARGIN
        self.poster.step()
        self.assertEqual(self.chain.sent, [], "the author could take the fee back before the blob lands")

    def test_only_safe_deposits_count_when_several_people_paid(self):
        floor = gp.min_fee(self.chain.base_fee, max(self.chain.tip, gp.MIN_TIP), self.chain.blob_base_fee)
        part = floor * 2 // 3  # each share alone is below what sending the blob needs
        vh, data = self.job("shared", part)
        self.chain.time += 86400 - gp.SAFETY_MARGIN + 1
        self.chain.authorize(data, "0x" + "b0" * 20, part, block=11)  # bob, fresh
        self.poster.step()
        self.assertEqual(self.chain.sent, [], "alice's share is about to be refundable, bob's alone is too little")
        self.chain.authorize(data, "0x" + "b0" * 20, part, block=self.chain.head)  # bob tops up: his shares now cover it
        self.chain.head += gp.CONFIRMATIONS
        self.poster.step()
        self.assertEqual(self.sent_hashes(), [vh])
        tx = tx_fields(self.chain.sent[0])
        self.assertLessEqual(gp.worst_case(tx["gas"], tx["max_fee"], tx["max_blob_fee"], 1), 2 * part, "alice's share doesn't count")

    def test_a_transaction_never_risks_more_than_its_blobs_hold(self):
        for i in range(3):
            self.job(f"p{i}", self.quote)
        self.poster.step()
        tx = tx_fields(self.chain.sent[0])
        self.assertEqual(len(tx["hashes"]), 3)
        self.assertLessEqual(gp.worst_case(tx["gas"], tx["max_fee"], tx["max_blob_fee"], 3), 3 * self.quote)
        self.assertGreaterEqual(tx["max_fee"], int(gp.MIN_HEADROOM * self.chain.base_fee))

    def test_at_most_six_blobs_per_transaction(self):
        for i in range(9):
            self.job(f"p{i}", self.quote)
        self.poster.step()
        self.assertEqual(len(self.sent_hashes()), gp.MAX_BLOBS_PER_TX)
        self.assertLess(gp.gas_limit(gp.MAX_BLOBS_PER_TX), 2**24)

    def test_fee_caps_invariant_over_many_prices(self):
        rng = random.Random(7)
        for _ in range(3000):
            base, tip, blob = rng.randint(1, 500 * gp.GWEI), rng.randint(0, gp.MAX_TIP), rng.randint(1, 50 * gp.GWEI)
            n = rng.randint(1, gp.MAX_BLOBS_PER_TX)
            floor = gp.min_fee(base, tip, blob)
            fees = [floor + rng.randint(0, floor) for _ in range(n)]
            gas = gp.gas_limit(n)
            caps = gp.fee_caps(sum(fees), gas, n, base, tip, blob)
            self.assertIsNotNone(caps, "blobs that each hold the minimum can always be carried")
            self.assertLessEqual(gp.worst_case(gas, *caps, n), sum(fees))
            self.assertGreaterEqual(caps[0], int(gp.MIN_HEADROOM * base) + tip)
            self.assertGreaterEqual(caps[1], blob)
            self.assertGreater(gp.quote(base, tip, blob), floor, "the dapp's quote clears the minimum")
            self.assertIsNone(gp.fee_caps(floor // 2, gp.gas_limit(1), 1, base, tip, blob))

    def test_replacement_stays_within_what_the_blobs_hold(self):
        self.job("p", self.quote)
        self.poster.step()
        self.chain.base_fee *= 3  # priced out; doubling every fee would cost more than the post paid
        self.chain.head += gp.REPLACE_AFTER_BLOCKS
        self.poster.step()
        self.assertEqual(len(self.chain.sent), 1)
        self.assertTrue(any("waiting for fees" in a[0] for a in self.alerts))

    def test_a_generously_paid_blob_can_be_replaced(self):
        self.job("rich", 10**16)
        self.poster.step()
        first = tx_fields(self.chain.sent[0])
        self.chain.base_fee *= 3
        self.chain.head += gp.REPLACE_AFTER_BLOCKS
        self.poster.step()
        self.assertEqual(len(self.chain.sent), 2)
        bumped = tx_fields(self.chain.sent[1])
        self.assertEqual(bumped["nonce"], first["nonce"])
        for key in ("tip", "max_fee", "max_blob_fee"):
            self.assertGreaterEqual(bumped[key], 2 * first[key])
        self.assertLessEqual(gp.worst_case(bumped["gas"], bumped["max_fee"], bumped["max_blob_fee"], 1), 10**16)

    def test_a_pending_transaction_near_its_refund_deadline_isnt_resent(self):
        self.job("p", 10**16)
        self.poster.step()
        self.chain.time += 86400 - gp.SAFETY_MARGIN + 1
        self.chain.base_fee *= 3
        self.chain.head += gp.REPLACE_STALE_BLOCKS + 1
        self.poster.step()
        self.assertEqual(len(self.chain.sent), 1, "no replacement or rebroadcast once fees may be refunded")
        self.assertTrue(any("refund deadline" in a[0] for a in self.alerts))

    def test_an_already_delivered_blob_is_done(self):
        vh, _ = self.job("p", self.quote)
        self.chain.delivered.add(gp.escrow_key(vh, self.signer.address))
        self.poster.step()
        self.assertEqual(self.chain.sent, [])
        self.assertEqual(self.poster.db.execute("SELECT status FROM jobs").fetchone()[0], "done")

    def test_unconfirmed_authorizations_wait(self):
        self.job("p", self.quote, block=self.chain.head - 1)
        self.poster.step()
        self.assertEqual(self.poster.db.execute("SELECT COUNT(*) FROM jobs").fetchone()[0], 0)
        self.chain.head += gp.CONFIRMATIONS
        self.poster.step()
        self.assertEqual(len(self.chain.sent), 1)

    def test_a_rescanned_or_reorged_payment_is_one_job_one_payer(self):
        vh, data = self.job("p", 5)
        tx = self.chain.logs[-1]["transactionHash"]
        self.poster.scan(self.chain.head)
        self.chain.logs.append(dict(self.chain.logs[-1], blockNumber=hex(12), logIndex=hex(3), transactionHash=tx))
        self.poster.set_meta("cursor", 0)
        self.poster.scan(self.chain.head)
        self.assertEqual(self.poster.db.execute("SELECT payers FROM jobs WHERE blob = ?", (vh,)).fetchone()[0], json.dumps([self.alice]))
        self.assertEqual(self.poster.db.execute("SELECT COUNT(*) FROM jobs").fetchone()[0], 1)

    def test_reverts_are_not_retried(self):
        vh, _ = self.job("p", self.quote)
        self.poster.step()
        tx_hash = self.poster.db.execute("SELECT hash FROM txs").fetchone()[0]
        self.chain.receipts[tx_hash] = {"status": "0x0", "blockNumber": hex(self.chain.head)}
        self.chain.nonce += 1
        self.chain.head += 1
        self.poster.step()
        self.assertEqual(self.poster.db.execute("SELECT status FROM jobs WHERE blob = ?", (vh,)).fetchone()[0], "failed")
        self.chain.head += 10
        self.poster.step()
        self.assertEqual(len(self.chain.sent), 1)

    def test_a_broadcast_with_no_answer_is_tracked_and_never_sent_twice(self):
        self.job("p", self.quote)
        self.chain.send_error = TimeoutError("timed out")
        self.poster.step()
        self.assertEqual(self.poster.db.execute("SELECT status FROM txs").fetchone()[0], "pending")
        self.chain.send_error = None
        for _ in range(3):
            self.chain.head += 1
            self.poster.step()
        self.assertEqual({tx_fields(r)["nonce"] for r in self.chain.sent}, {0})

    def test_a_refused_broadcast_gives_the_blob_back(self):
        vh, _ = self.job("p", self.quote)
        self.chain.send_error = gp.RpcError("eth_sendRawTransaction: insufficient funds")
        with self.assertRaises(gp.RpcError):
            self.poster.step()
        self.assertEqual(self.poster.db.execute("SELECT status FROM jobs WHERE blob = ?", (vh,)).fetchone()[0], "new")

    def test_a_used_nonce_is_rechecked_before_requeueing(self):
        vh, _ = self.job("p", self.quote)
        self.poster.step()
        tx_hash = self.poster.db.execute("SELECT hash FROM txs").fetchone()[0]
        self.chain.nonce = 1
        self.chain.head += 1
        self.poster.step()
        self.assertEqual(self.poster.db.execute("SELECT status FROM jobs WHERE blob = ?", (vh,)).fetchone()[0], "sent")
        self.chain.receipts[tx_hash] = {"status": "0x1", "blockNumber": hex(self.chain.head)}
        self.chain.head += 1
        self.poster.step()
        self.assertEqual(self.poster.db.execute("SELECT status FROM jobs WHERE blob = ?", (vh,)).fetchone()[0], "done")
        self.assertEqual(len(self.chain.sent), 1)

    def test_jobs_without_bytes_cant_crowd_out_the_rest(self):
        for i in range(60):  # paid, but their posts never show up
            self.chain.authorize(post(f"ghost {i}", ""), self.alice, self.quote, block=10, idx=i)
        good, _ = self.job("real", self.quote, block=20)
        for _ in range(4):
            if self.chain.sent:
                break
            self.chain.head += 1
            self.poster.step()
        self.assertEqual(self.sent_hashes(), [good])

    def test_spam_blobs_are_never_mirrored(self):
        self.chain.logs.append({"address": CONTRACT, "blockNumber": hex(10), "logIndex": "0x0", "removed": False,
                                "transactionHash": "0x" + "ee" * 32, "data": "0x" + word(0),
                                "topics": [gp.T_BLOB_PUBLISHED, "0x01" + "cd" * 31, "0x" + "00" * 12 + "bb" * 20]})
        self.poster.step()
        self.assertFalse(any("/blobs/" in path for path in FakeApi.requests))

    def test_no_funds_no_spend(self):
        self.chain.balance = 0
        self.job("p", self.quote)
        self.poster.step()
        self.assertEqual(self.chain.sent, [])
        self.assertTrue(any("needs ETH" in a[0] for a in self.alerts))


@unittest.skipUnless(shutil.which("anvil") and shutil.which("cast") and os.path.exists(os.path.join(ROOT, "out", "GnsPosts.sol", "GnsPosts.json")),
                     "needs anvil, cast and `forge build`")
class EndToEnd(unittest.TestCase):
    """The real contracts on anvil. Every test ends by checking the publisher didn't lose money."""

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
        accounts = cls.rpc("eth_accounts")
        cls.alice, cls.bob, cls.rival = accounts[0], accounts[1], accounts[2]
        cls.nft = cls.deploy("NameNFT.sol/NameNFT.json", "")
        cls.posts = cls.deploy("GnsPosts.sol/GnsPosts.json", cls.nft[2:].rjust(64, "0"))
        cls.tokens = {who: cls.register(label, who) for label, who in (("alice", cls.alice), ("bobby", cls.bob))}
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
    def register(cls, label, owner):
        secret = "0x" + os.urandom(32).hex()
        commitment = cls.cast("call", cls.nft, "makeCommitment(string,address,bytes32)(bytes32)", label, owner, secret)
        cls.cast("send", "--unlocked", "--from", owner, cls.nft, "commit(bytes32)", commitment)
        cls.rpc("evm_increaseTime", 120)
        cls.rpc("evm_mine")
        fee = cls.cast("call", cls.nft, "getFee(uint256)(uint256)", str(len(label))).split()[0]
        cls.cast("send", "--unlocked", "--from", owner, "--value", fee, cls.nft, "reveal(string,bytes32)", label, secret)
        return cls.cast("call", cls.nft, "computeId(string)(uint256)", f"{label}.gwei").split()[0]

    @classmethod
    def deploy(cls, artifact, args_hex):
        with open(os.path.join(ROOT, "out", artifact)) as fh:
            bytecode = json.load(fh)["bytecode"]["object"]
        tx = cls.rpc("eth_sendTransaction", {"from": cls.rpc("eth_accounts")[0], "data": bytecode + args_hex, "gas": hex(16_000_000)})
        return cls.receipt(tx)["contractAddress"]

    @classmethod
    def receipt(cls, tx):
        for _ in range(200):
            receipt = cls.rpc("eth_getTransactionReceipt", tx)
            if receipt:
                return receipt
            time.sleep(0.05)
        raise AssertionError(f"{tx} was never mined")

    def setUp(self):
        self.signer = gp.Signer(os.urandom(32))
        self.rpc("anvil_setBalance", self.signer.address, hex(10**17))
        self.poster = gp.Poster(rpc=self.rpc, api=f"http://127.0.0.1:{self.api_server.server_port}/api", contract=self.posts,
                                from_block=0, signer=self.signer, db=sqlite3.connect(":memory:"), setup=SETUP, chain_id=31337,
                                wrapper_version=ANVIL_WRAPPER)
        self.start = self.balance()

    def tearDown(self):
        self.assertGreaterEqual(self.balance(), self.start, "the publisher must never end up with less than it started with")

    def balance(self):
        return int(self.rpc("eth_getBalance", self.signer.address, "latest"), 16)

    def mine(self, blocks=gp.CONFIRMATIONS):
        for _ in range(blocks):
            self.rpc("evm_mine")

    def prices(self):
        block = self.rpc("eth_getBlockByNumber", "latest", False)
        return int(block["baseFeePerGas"], 16), max(int(self.rpc("eth_maxPriorityFeePerGas"), 16), gp.MIN_TIP), int(self.rpc("eth_blobBaseFee"), 16)

    def authorize(self, who, data, fee, vh=None, publisher=None):
        FakeApi.posts[post_hash(data)] = data
        vh = vh or gp.blob_hash(blob_of(data), SETUP)
        self.cast("send", "--unlocked", "--from", who, "--value", str(fee), self.posts, "authorize(uint256,bytes32,bytes32,address)",
                  self.tokens[who], post_hash(data), vh, publisher or self.signer.address)
        return vh

    def run_poster(self, passes=3):
        """Let the poster see the payments, send, and settle."""
        self.mine()
        for _ in range(passes):
            self.poster.step()
            self.mine(1)

    def blob_events(self):
        logs = self.rpc("eth_getLogs", {"address": self.posts, "fromBlock": "0x0", "toBlock": "latest", "topics": [gp.T_BLOB_PUBLISHED]})
        return {(l["topics"][1], "0x" + l["topics"][2][-40:], int(l["data"], 16)) for l in logs}

    def test_a_paid_post_is_delivered_in_its_own_blob_and_pays_more_than_it_costs(self):
        data = post("First", "Hello from **anvil** " + os.urandom(4).hex())
        fee = gp.quote(*self.prices())
        vh = self.authorize(self.alice, data, fee)
        self.run_poster()
        tx_hash = self.poster.db.execute("SELECT hash FROM txs WHERE status = 'mined'").fetchone()[0]
        receipt = self.rpc("eth_getTransactionReceipt", tx_hash)
        self.assertEqual(int(receipt["status"], 16), 1)
        self.assertEqual(self.rpc("eth_getTransactionByHash", tx_hash)["blobVersionedHashes"], [vh])
        self.assertIn((vh, self.signer.address, fee), self.blob_events())
        cost = int(receipt["gasUsed"], 16) * int(receipt["effectiveGasPrice"], 16) + int(receipt["blobGasUsed"], 16) * int(receipt["blobGasPrice"], 16)
        self.assertEqual(self.balance() - self.start, fee - cost)
        self.assertGreater(fee, cost)
        self.assertLessEqual(int(receipt["gasUsed"], 16), gp.expected_gas(1), "the cost model covers the real gas")

    def test_several_authors_share_one_transaction(self):
        prices = self.prices()
        fee = gp.quote(*prices)
        hashes = [self.authorize(who, post(f"Batch {i}", os.urandom(8).hex()), fee) for i, who in enumerate([self.alice, self.bob, self.alice])]
        self.run_poster()
        (blobs_json,) = self.poster.db.execute("SELECT blobs FROM txs WHERE status = 'mined'").fetchone()
        self.assertEqual(sorted(json.loads(blobs_json)), sorted(hashes))
        tx_hash = self.poster.db.execute("SELECT hash FROM txs WHERE status = 'mined'").fetchone()[0]
        receipt = self.rpc("eth_getTransactionReceipt", tx_hash)
        self.assertLessEqual(int(receipt["gasUsed"], 16), gp.expected_gas(3))
        self.assertGreater(self.balance(), self.start + 2 * fee, "sharing a transaction leaves even more")

    def test_a_blob_the_post_doesnt_make_is_never_sent(self):
        data = post("Mine", os.urandom(8).hex())
        other = gp.blob_hash(blob_of(post("Someone else's", "x")), SETUP)
        self.authorize(self.alice, data, 10**15, vh=other)
        self.run_poster()
        self.assertEqual(self.poster.db.execute("SELECT COUNT(*) FROM txs").fetchone()[0], 0)
        self.assertEqual(self.balance(), self.start)

    def test_an_underpaid_post_waits(self):
        self.authorize(self.alice, post("Cheap", os.urandom(8).hex()), 1)
        self.run_poster()
        self.assertEqual(self.poster.db.execute("SELECT COUNT(*) FROM txs").fetchone()[0], 0)

    def test_a_fee_about_to_be_refundable_isnt_worth_sending_for(self):
        data = post("Late", os.urandom(8).hex())
        vh = self.authorize(self.alice, data, 10**15)
        self.rpc("evm_increaseTime", 86400 - gp.SAFETY_MARGIN + 60)
        self.run_poster()
        self.assertEqual(self.poster.db.execute("SELECT COUNT(*) FROM txs").fetchone()[0], 0)
        self.rpc("evm_increaseTime", gp.SAFETY_MARGIN)
        self.mine(1)
        before = int(self.rpc("eth_getBalance", self.alice, "latest"), 16)
        self.cast("send", "--unlocked", "--from", self.alice, self.posts, "refund(bytes32,address)", vh, self.signer.address)
        self.assertGreater(int(self.rpc("eth_getBalance", self.alice, "latest"), 16), before, "the author got the fee back")

    def test_someone_else_delivering_the_blob_first_still_leaves_the_fee_for_us(self):
        data = post("Raced", os.urandom(8).hex())
        fee = gp.quote(*self.prices())
        vh = self.authorize(self.alice, data, fee)
        rival = gp.Signer(os.urandom(32))
        self.rpc("anvil_setBalance", rival.address, hex(10**17))
        nonce = int(self.rpc("eth_getTransactionCount", rival.address, "latest"), 16)
        raw, _, _ = gp.blob_transaction(rival, chain_id=31337, nonce=nonce, tip=10**9, max_fee=10**11, gas=200_000, to=self.posts,
                                        data=gp.SEL_PUBLISH, max_blob_fee=10**9, blobs=[blob_of(data)], setup=SETUP, wrapper_version=ANVIL_WRAPPER)
        self.rpc("eth_sendRawTransaction", raw)
        self.mine(1)
        self.assertIn((vh, rival.address, 0), self.blob_events(), "the rival delivered it, unpaid")
        self.run_poster()
        self.assertIn((vh, self.signer.address, fee), self.blob_events())

    @unittest.skipUnless(shutil.which("node"), "needs node")
    def test_the_whole_loop_dapp_publisher_and_gateway_index(self):
        """The blob hash the dapp computes, the real contract, this publisher and the gateway's own
        index code (gateway/posts-store.js) reading the real events agree end to end."""
        here = os.path.dirname(os.path.abspath(__file__))
        data = post("Whole loop", "From the **dapp** to the page " + os.urandom(4).hex())
        vh = subprocess.run(["node", os.path.join(here, "blobhash.mjs"), data.hex()], check=True, capture_output=True, text=True, timeout=60).stdout.strip()
        self.assertEqual(vh, gp.blob_hash(blob_of(data), SETUP), "the dapp and the publisher compute the same blob hash")
        fee = gp.quote(*self.prices())
        self.authorize(self.alice, data, fee, vh=vh)
        self.run_poster()
        self.assertIn((vh, self.signer.address, fee), self.blob_events())

        class Blobscan(http.server.BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def do_GET(self):
                found = self.path == f"/blobs/{vh}/data"
                self.send_response(200 if found else 404)
                self.end_headers()
                if found:
                    self.wfile.write(json.dumps("0x" + blob_of(data).hex()).encode())

        blobscan = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Blobscan)
        threading.Thread(target=blobscan.serve_forever, daemon=True).start()
        try:
            self.mine(3)
            out = subprocess.run(["node", os.path.join(here, "index_check.mjs"), self.url, self.posts, f"http://127.0.0.1:{blobscan.server_port}",
                                  self.tokens[self.alice], self.alice, data.hex()], check=True, capture_output=True, text=True, timeout=120)
        finally:
            blobscan.shutdown()
        shown = json.loads(out.stdout)
        self.assertEqual([p["title"] for p in shown], ["Whole loop"], out.stderr)
        self.assertEqual(shown[0]["hash"], post_hash(data))
        self.assertEqual(shown[0]["onchain"]["blob"], vh, "the index found the post in the delivered blob")
        self.assertEqual(shown[0]["onchain"]["publisher"], self.signer.address)

    def test_the_node_rejects_a_corrupted_proof(self):
        blob = blob_of(post("x", "y"))
        nonce = int(self.rpc("eth_getTransactionCount", self.signer.address, "pending"), 16)
        raw, _, _ = gp.blob_transaction(self.signer, chain_id=31337, nonce=nonce, tip=10**9, max_fee=10**11, gas=100_000, to=self.posts,
                                        data=gp.SEL_PUBLISH, max_blob_fee=10**9, blobs=[blob], setup=SETUP, wrapper_version=0)
        other = blob_of(post("x", "z"))
        proof = ckzg.compute_blob_kzg_proof(blob, ckzg.blob_to_kzg_commitment(blob, SETUP), SETUP).hex()
        wrong = ckzg.compute_blob_kzg_proof(other, ckzg.blob_to_kzg_commitment(other, SETUP), SETUP).hex()
        self.assertTrue(raw.endswith(proof))
        with self.assertRaises(gp.RpcError):
            self.rpc("eth_sendRawTransaction", raw[: -len(proof)] + wrong)


if __name__ == "__main__":
    unittest.main()
