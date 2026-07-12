# gwei chat architecture

This document describes the browser messenger in `chat/`: its protocol layers, trust boundaries,
storage, delivery paths, admission system, and intentional limitations. For setup and commands, see
[README.md](./README.md).

## Design goal

The goal is a useful, private, browser-native way to message `alice.gwei` without inventing an
identity registry, running a trusted directory, exposing recipient routing tags, or requiring users
to operate infrastructure.

The design stays deliberately layered:

```text
GNS name  -> signed public contact bundle
                    |
                    v
  recipient-private identified request
       / accepted one-time-key offer
                    |
                    v
          Olm / Double Ratchet message
                    |
                    v
           fixed 2,048-byte HPKE envelope
                    |
             +------+------+
             |             |
             v             v
          live SSE    Ethereum blob batch
                              |
                              v
                    permissionless ERC-8179 discovery
```

Delivery is outside the cryptographic session. Removing SSE, changing batchers, or disabling blob
recovery does not change identities, ratchets, or the UI message format.

## Components and trust boundaries

| Component | Responsibility | Must be trusted with |
| --- | --- | --- |
| Browser | Identity, contacts, ratchets, local trial decryption, GNS and blob reads | Decrypted messages while unlocked |
| GNS `NameNFT` | Existing public contact-record publication and ownership | Public contact bundle only |
| Submission batcher | Admission, queueing, padding, shuffling, blob transaction payment | Opaque envelopes and submission metadata |
| Any blob publisher | Declare matching content in Ethereum blobs | Nothing; messages authenticate end to end |
| Execution RPC | Return GNS state and finalized ERC-8179 logs | GNS ownership/contact bindings and the chain/log view |
| Beacon API | Return the one requested blob within the availability window | Availability and the versioned-hash-to-bytes mapping |
| Passkey provider | Release a PRF result after user verification | Vault unlock, not chat identity or message contents |

The browser never receives a batcher's Ethereum transaction key. A sender configures a submission
URL, not an exclusive publisher identity. A recipient discovers all matching onchain declarations
within the supported window regardless of who posted them.

## Identity and session encryption

The browser uses `vodozemac`, the Matrix cryptography implementation, for signed identity keys,
fresh one-time keys, Olm/Double Ratchet sessions, out-of-order messages, and encrypted serializable
ratchet state.

A v1 contact bundle contains only stable public identity and delivery material:

```json
{"v":1,"s":"<Ed25519 signing key>","i":"<Olm Curve25519 identity key>","d":"<HPKE X25519 delivery key>","x":"<Ed25519 signature>"}
```

It contains no fallback key, one-time-key pool, service URL, or routing identifier. The signature
`x` covers `v`, `s`, `i`, and `d`. The ratchet provides message confidentiality, forward evolution,
and sender authentication. There is no gwei-specific identity contract.

The four cryptographic fields have separate jobs:

| Field | Public material | Role |
| --- | --- | --- |
| `s` | Ed25519 signing key | Browser-profile signing identity. It verifies `x`, identified session requests, and accepted one-time-key offers. |
| `i` | Olm Curve25519 identity key | Long-lived Diffie-Hellman identity used with the recipient's fresh one-time key to establish an Olm session. |
| `d` | Independent HPKE X25519 delivery key | Private inbox before an Olm session exists and routing-hiding outer encryption for established messages. |
| `x` | Ed25519 signature made by `s` | Self-authenticates the canonical `{v,s,i,d}` manifest and proves control of the browser signing identity. |

An Olm account contains both an Ed25519 signing key and a Curve25519 identity key; `i` is not the
entire account identity. Olm session creation itself uses `i` and a one-time key. The application
uses `s` around Olm to prove who created a request or key offer without asking an Ethereum wallet to
sign every new chat. The independent `d` key is necessary because there is no Olm session, public
one-time key, or fallback key when the first request is delivered. Reusing `i` as a generic HPKE key
would cross protocol boundaries and is not supported by the vodozemac account API.

The trust hierarchy is deliberately shorter than Matrix cross-signing:

```text
current .gwei NameNFT owner (EOA or ERC-1271 account)
  └─ signs the GNS binding to the exact contact-code hash
       └─ browser profile bundle: s + i + d
            └─ x: self-signature by s over the complete bundle
```

As an analogy, GNS ownership combines the user-level authorization roles that Matrix separates into
a master key and a self-signing key, then directly authorizes one browser-profile bundle. This is
not Matrix cross-signing: there is no user-signing key, cross-user trust graph, device list, or
multi-device hierarchy. The `s` and `i` fields are merely analogous to Matrix's device Ed25519 and
Curve25519 keys. See the [Matrix cross-signing hierarchy](https://spec.matrix.org/latest/client-server-api/#cross-signing).

### Service-free first contact

New sessions use an interactive three-envelope handshake through the same dumb-pipe batchers as
messages:

1. Alice generates a random 128-bit request ID and an ephemeral HPKE reply key. Inside a fixed-size
   envelope encrypted to Bob, she includes those values, her `.gwei` name, her exact signed contact
   bundle, and a 24-hour expiry. Her Ed25519 identity signs the complete request and binds it to all
   three of Bob's public keys, so it cannot be redirected to another recipient.
2. Bob verifies Alice's chat-identity signature and resolves her current GNS record through his own
   RPC. The request appears only when the current owner-bound record exactly matches the contact
   bundle Alice supplied. Bob can then accept or ignore it. Immediately before acceptance, the
   browser resolves the record again and requires the same exact contact code. Ignore is silent: it
   creates no key, response envelope, or relay-pass redemption.
3. Only after Bob accepts does he generate a fresh Olm one-time key. His Ed25519 identity signs an
   offer bound to the request ID, Alice's reply key, Bob's signing and Olm identity keys, and that
   exact one-time key. The offer is encrypted to Alice's ephemeral reply key.
4. Alice verifies the offer against Bob's GNS-bound contact bundle. Her first user message creates
   the Olm session and is sent as a prekey envelope naming the request ID.
5. Bob accepts that prekey message only if its embedded Olm key equals the key he offered. The
   encrypted plaintext must also bind Alice's signed contact bundle, Bob's signing key, and the
   request ID. Successful authenticated decryption consumes the one-time key locally.

There is no prekey service, public pool, claim operation, or consumption announcement. Batchers
cannot distinguish handshake controls from messages and keep no per-user state. Alice's name and
contact bundle are visible to Bob before he accepts, but remain inside Bob's HPKE envelope and are
not exposed in the blob or to the batcher.

Requests and unused offers expire after 24 hours. Signed expiry, random logical IDs, bounded handled
ID memory, and transport deduplication limit replay; expired private one-time keys are deleted.
Browsers cap themselves at 32 outgoing requests, 32 incoming requests, and 16 accepted unanswered
offers. When the incoming cap is full, a new request may replace the oldest unverified request but
never an already verified request. These caps bound work and key generation but do not solve
targeted denial of service.

The request uses HPKE base mode with Bob's stable delivery key. It deliberately does **not** provide
recipient-compromise forward secrecy for the request metadata: an attacker who records envelopes
and later steals Bob's delivery private key can recover Alice's name and contact bundle from old
requests. That compromise does not reveal the later Olm session or its messages, which are
established with Bob's fresh one-time key and ratchet state. This is the explicit cost of letting
Bob authenticate Alice before deciding whether to answer without adding a prekey service.

Profiles made by the fallback-key prototype are upgraded in place to a v1 contact bundle and must
republish their GNS record. Established ratchets remain usable. Legacy contact bundles can still be
read for their signed stable keys, but the current protocol ignores their fallback field and rejects
every prekey message that lacks a matching locally issued offer.

Private state includes:

- stable identity keys and short-lived offered one-time keys;
- the last successfully published `.gwei` name, used only to resume the guided UI;
- contacts and ratchet sessions;
- pending request IDs and ephemeral HPKE reply private keys;
- replay identifiers and the onchain cursor;
- the creation time used once to establish a fresh identity's safe finalized-head cursor baseline;
- a ciphertext outbox;
- unspent relay passes and their refill session.

Readable chat messages are held only by the current page. They are not persisted and disappear on
reload.

## Envelope format and local routing

RFC 9180 HPKE with X25519 wraps every handshake control or ratchet message in an exactly 2,048-byte
envelope. The envelope contains no public recipient tag. Each browser tries candidate slots against
its stable delivery key and its bounded set of pending ephemeral reply keys; random slots and
messages for other recipients fail authentication.

Structured X25519 dummy envelopes fill unused batch slots. The batcher securely shuffles real and
dummy envelopes before publication, so public batch layout does not reveal which positions contain
messages.

The live and batched copies of an envelope share the same SHA-256 transport identifier. Persistent
replay state therefore displays a message once even if the receiver obtains it first by SSE and
later from a blob. The browser advances its batch cursor only after scanning the complete batch.
All slots in one blob share one decrypted vault snapshot. A matching envelope still commits
handshake and Olm state before the next match is processed.

## Passkey private vault

Normal startup is locked. A new profile creates a discoverable WebAuthn credential with user
verification required and requests the standard PRF extension. The passkey is a local vault unlock
mechanism; it does not replace or derive the chat identity, ratchet, or delivery keys.

The vault construction is:

1. Generate a random 256-bit vault data-encryption key.
2. Evaluate WebAuthn PRF with a random per-vault input after user verification.
3. Use HKDF with an independent random salt to derive an AES-GCM key-encryption key.
4. Wrap the vault key with that key-encryption key.
5. Encrypt the complete private state with the vault key and AES-256-GCM.

Only versioned salts, credential metadata, nonces, the wrapped key, and encrypted state are stored.
PRF output is consumed locally and is never serialized or sent to the relay. Imported vault keys and
derived wrapping keys are non-extractable Web Crypto keys.

Every state write uses a fresh 96-bit nonce. AES-GCM associated data authenticates the schema
version, local profile, and monotonically increasing revision.

### Migration and locking

Existing prototype profiles migrate atomically. The passkey configuration and authenticated
ciphertext are committed in the same IndexedDB transaction that removes the old clear state. If
credential creation, encryption, or the transaction fails, the old state remains intact.

Reloading or choosing **Lock now** drops the in-memory vault key. A protected page hidden for five
minutes reloads into the locked gate. Page lifecycle handling also prevents a back-forward-cache
restore from silently reviving an unlocked page.

The vault is not a backup. Clearing site data destroys the ciphertext, and losing the passkey
requires resetting the vault, creating a fresh chat identity, and republishing the GNS contact.
Mutable Double Ratchet state is intentionally not synchronized between devices.

### Origin boundary

Production must serve the messenger from `chat.gwei.domains` and use that exact WebAuthn RP ID. The
app rejects setup on the shared `gwei.domains` parent because sibling or user-controlled subdomains
must not share the credential boundary.

Numeric loopback hosts are rejected in favor of `http://localhost`. For automated tests only,
`vault=off` bypasses setup on loopback when no encrypted vault already exists; production ignores
the parameter.

## Addressing through GNS

The public contact record uses the existing `domains.gwei.chat` text key on GNS `NameNFT`. Its exact
UTF-8 value is compact JSON:

```json
{"v":0,"c":"<base64url contact code>","s":"<hex owner signature>"}
```

This outer record and the inner contact bundle have independent versions: `v: 0` is the first GNS
record schema, while the decoded contact bundle currently has `v: 1`. In the outer record, `c` is
the base64url encoding of the `{v,s,i,d,x}` bundle and `s` is the GNS owner's wallet signature. The
outer `s` must not be confused with the inner bundle's Ed25519 signing-key field of the same compact
name.

The owner signs this exact EIP-191 message:

```text
gwei.domains chat contact
Version: 0
Chain ID: <chain ID>
NameNFT: <checksummed contract address>
Token ID: <uint256 namehash of the normalized .gwei name>
Text record: domains.gwei.chat
Contact hash: <keccak256 of the UTF-8 contact-code string>
```

For an EOA, the browser recovers the EIP-191 signer. For a contract owner, it verifies the same
message hash with ERC-1271 at the block used for the GNS reads. Publishing therefore requires two
bindings:

1. The contact bundle signs its own public key material.
2. The current NFT owner signs a statement bound to chain ID, NameNFT address, token ID, record key,
   and contact-code hash.

When resolving `alice.gwei`, the browser reads the record directly from the selected RPC and verifies
both signatures. A previous owner's record becomes invalid immediately after an NFT transfer rather
than silently following the name. No chat identity registry or trusted indexer is introduced.

### Directory discovery

The **New chat** dialog scans the existing key-filtered `TextChanged` events from the NameNFT
deployment block. It stores a public token-ID checkpoint locally and later rescans only a reorg
window plus new blocks.

Events are discovery hints, never current truth. Every candidate is re-read and fully verified at
one current block before display. The browser stops at 2,000 distinct candidates to bound hostile or
accidental work. Direct `.gwei` lookup remains available if an RPC cannot provide historical logs.

Publishing is an explicit public directory opt-in. It exposes the already-public contact bundle and
owner binding, never chat private keys.

## Batching and publication

An Ethereum blob has 4,096 field elements. Reserving each field element's high byte leaves exactly
126,976 application bytes, which fits 62 fixed 2,048-byte envelopes without an application header or
wasted data bytes.

A blob transaction can carry more than one blob. The supported post-Osaka limit is six blobs per
transaction, so one transaction can carry up to 372 envelope slots. The batcher fills blobs in
order; only the final blob may be partial, and that blob is padded to 62 slots with shuffled dummy
envelopes.

The default batching policy is:

- publish immediately when six blobs are full;
- otherwise publish a non-empty batch after a five-minute maximum wait;
- never publish an empty transaction;
- cap buffered publication work so a stopped publisher cannot grow memory without bound.

Publication groups are serialized to avoid nonce races. A failed group remains queued for retry.
Multi-blob transactions use the canonical Multicall3 deployment to declare each blob index through
ERC-8179; no gwei-specific contract is added.

The server maintains a persistent UTC subsidy ceiling. Before signing, it reserves the
transaction's worst-case fee cap using an ETH/USD quote plus a safety margin. If the quote is
unavailable or the remaining daily budget is insufficient, publication fails closed and the group
stays queued. Each retry receives a separate reservation so an ambiguous broadcast cannot hide a
second spend.

Local replay retains a bounded number of recent batches only to simulate Ethereum's finite window.
It is not an archive.

## Permissionless receiving

The configured batcher URL is used only to submit envelopes. Onchain receiving independently:

1. scans ERC-8179 declarations for the public gwei chat content tag;
2. accepts matching declarations from any address;
3. retrieves each declared blob from the selected Beacon API;
4. requires exactly one 131,072-byte response with the canonical gwei field encoding;
5. parses all 62 slots and trial-decrypts them locally;
6. advances the persistent cursor only after the full batch is processed.

The reader buffers dense log pages and permits four Beacon requests in flight, but consumes fetched
blobs in declaration order because handshake and Olm ratchet mutation are sequential. A fresh
identity advances past a finalized block only when that block's timestamp predates the delivery key;
if the app reconnects too late to prove this, it conservatively scans history.

The browser does not recompute a KZG commitment while receiving. The user-selected execution RPC is
already the authority for finalized logs, GNS ownership, and contact records; the selected Beacon
API is likewise trusted to map the requested versioned hash to its blob bytes. Running a local node
or selecting providers is therefore a real security decision, not merely an availability setting.
Publisher-side KZG commitments and proofs remain mandatory for constructing valid blob transactions.

Anyone, including a batcher, can encrypt an outer HPKE envelope to a public delivery key. HPKE base
mode provides confidential delivery and hides routing; it does not authenticate the sender. A
batcher still cannot forge an accepted request, key offer, or chat message because the handshake
signatures, exact one-time-key checks, and Olm session authenticate the inner protocol. It can
observe submission metadata, delay or omit an envelope, and spend money publishing junk. Other
publishers can restore availability by carrying the same valid opaque envelopes.

## Spam resistance and subsidy admission

A public subsidized relay cannot accept unbounded anonymous writes. Admission uses standard RFC
9578 VOPRF Privacy Pass tokens:

1. SIWE proves current wallet control of an active top-level `.gwei` name during blind issuance.
2. The issuer grants a bounded daily allowance in blinded batches.
3. `/submit` redeems a one-time token with an opaque envelope.

Free subdomains do not multiply quotas, and escrowed parent-name controllers are recognized. Issuance
and spent nonces are atomic in a mode-`0600` SQLite database. Passes use a common daily challenge, so
unused allowance expires at UTC midnight instead of becoming a permanent hoard.

The issuer learns which name obtained how many passes, but the VOPRF transcript does not provide a
cryptographic link to a later redemption. Timing and IP correlation are intentionally left to the
user's network choices and are not claimed as protocol protections.

Relay passes and their refill session are bearer secrets stored inside the encrypted vault. Because
a failed request may have ambiguously spent a pass, the client fails safe and uses another pass on
retry.

## Onchain discovery and interoperability

The discovery tag is:

```text
keccak256("gwei.chat.envelopes.v0")
= 0x0e809357534e030cdd3d5c5dcb401ebadeaf0313a04d5e8a90222d216953ceac
```

ERC-8179 supplies only the small primitive the protocol needs: permissionless declarations pointing
to content ranges in transaction blobs. ERC-8180 is intentionally absent because its public sender,
nonce, and signature-registry model does not map cleanly to routing-free HPKE envelopes. Both
standards remain drafts, so deployments must verify addresses and bytecode.

`../test/fixtures/BlobSpaceSegments.sol` is a test-only copy of the draft ERC-8179 reference
contract. It checks the standard event and `BLOBHASH` behavior on Anvil and is not a proposed gwei
contract.

```sh
cd ..
forge test --match-contract BlobSpaceSegmentsTest
```

Foundry's `SimpleCoder` reserves one field element for a length header, so its `cast --blob --path`
flow carries 61 envelopes and is not the canonical application codec. Generate that compatibility
fixture with:

```sh
cd chat
npm run blob:fixture -- /tmp/gwei-chat.payload
```

The typed round-trip publisher constructs the exact headerless 62-envelope blob and type-3 sidecar
with `ethers`, using BlobKit's KZG-WASM package only for commitments and proofs:

```sh
EXECUTION_RPC_URL=http://127.0.0.1:8545 \
BEACON_API_URL=http://127.0.0.1:8545 \
ERC8179_ADDRESS=<fixture-address> \
BATCHER_KEY_FILE=<key-file> \
npm run onchain:roundtrip
```

It verifies chain ID, contract bytecode, balance, estimated maximum cost, emitted declaration,
blob-gas usage, KZG identity, byte-for-byte retrieval, and all decoded slots.

### Sepolia proof

The canonical single-blob path completed on Sepolia on 2026-07-11:

```text
transaction     0xbe23123c794dd227f6d900217c1bc1b9faa7ba4181fdba9f151b89870117bb8a
block           11249783
versioned hash  0x01aded251af9f83c8c1232b65347c8509b915c8cdd150e140d4dc1ace0b28ebe
beacon slot     10669625
range           [0, 4096)
envelope slots  62
```

The retrieved 131,072-byte blob had the same SHA-256 digest as the submitted blob. An independent
execution RPC returned the declaration from only the contract address and content-tag filter. The
round-trip publisher verified the KZG identity; after finality, the browser discovered the blob,
scanned all slots, and advanced its cursor.

The multi-blob path then carried two canonical blobs in one transaction:

```text
transaction     0x3d79bc05a5c6058f7ef4fcb7419e1d3b607afd24f5bd038a90612e2c846c18a3
block           11250408
blob gas        262144 (2 blobs)
envelope slots  124
beacon slot     10670287
```

A UI composition test also delivered an encrypted ratchet message through Sepolia with SSE disabled
and no access to the publisher's local replay path:

```text
transaction     0x518559393b6e1940d3f6169c30abfe22413af99a466aaa172625061780693710
block           11249958
versioned hash  0x01ff29ccbf4e621647f3e89fe42a81eda156a2d72511829ef5b55219f32e784e
beacon slot     10669812
blob bytes      131072
envelope slots  62
```

The receiving browser rejected 61 slots, decrypted the intended envelope, and displayed the exact
message once.

## Availability and retention

The app intentionally provides no archive. It scans only Ethereum's normal blob-availability window
and shows only messages recovered while they remain available. A message not opened before its blob
expires is permanently unavailable.

This keeps storage and background synchronization out of the protocol. It is a product constraint,
not an unfinished archival feature.

### Cold-start scaling

Routing-free broadcast means every recipient downloads and trial-decrypts every declared gwei blob
in its unread availability interval. Work therefore scales with total protocol traffic, not with
the number of messages addressed to one recipient.

The reproducible Chromium simulation, measured baselines, and resulting implementation priorities
are maintained in [BENCHMARKS.md](./BENCHMARKS.md). A fresh identity now skips finalized history
that provably predates its delivery key; returning identities retain their cursor and process only
their offline interval. A large returning-user backlog still needs validation on physical mobile
hardware before this can be considered production-ready.

## Security model and honest limits

The protocol aims to protect message contents, sender authenticity, and recipient routing from
public batch data. It does not claim to hide network metadata or make an untrusted web origin safe.

- Empty intervals produce no cover blob. Connections, IP addresses, active intervals, and submission
  timing remain observable.
- Anyone can publish junk under the public content tag. Junk cannot forge a message but can consume
  client bandwidth and trial-decryption work, so scanning stays bounded to the availability window.
- A batcher can censor, delay, or drop submissions. Permissionless publication prevents it from
  becoming the only source, but does not guarantee that somebody else republishes a message.
- The selected execution RPC and Beacon API are trusted read sources. A malicious execution RPC can
  fabricate finalized logs or GNS ownership/contact records; a malicious Beacon API can censor or
  substitute blob bytes. Canonical parsing and inner cryptography reject malformed or unauthenticated
  messages, but they do not prove that provider answers reflect Ethereum. Users can select their own
  endpoints, including a local node.
- Arbitrary user-selected HTTPS endpoints require a broad `connect-src https:` policy. URLs carrying
  API tokens are locally stored secrets.
- The passkey vault protects copied or closed browser storage, not a page compromised after unlock.
  Same-origin JavaScript can ask the unlocked application to use its keys.
- Losing site data or the passkey loses the identity. Recovery, contact-key rotation, blocking, and
  multi-device support are deliberately absent.
- Anyone with a public contact bundle and relay admission can submit an encrypted session request.
  A request is displayed only after its signed identity exactly matches the current GNS record.
  Invalid claims can still consume bounded decryption and RPC work, and a valid holder can still
  create request spam. Ignore sends nothing and spends no recipient pass; accepting spends one pass
  when publishing the one-time-key offer.
- HPKE base mode does not give recorded identified requests recipient-compromise forward secrecy.
  Later theft of Bob's stable delivery key can expose who requested him and when, but not recover
  the Olm messages established with one-time keys.
- Starting a new chat costs three envelopes and two additional transport turns before the first
  user message. Both browsers must revisit or remain open during the 24-hour handshake window;
  browser background execution is not reliable. Established ratchets need only one envelope per
  message.
- The outer HPKE framing, Privacy Pass composition, and complete browser protocol still need
  independent security review even though their underlying primitives and libraries are established.

Production therefore requires the isolated `chat.gwei.domains` origin, strict response headers,
reproducible pinned bundles, and no third-party scripts.

## Go/no-go boundary

The prototype remains small enough to continue because each addition is an envelope around an
existing layer:

- the passkey protects stored state without becoming a second identity system;
- GNS discovery uses one existing text record, existing key-filtered events, and signed bindings;
- relay admission wraps `/submit` with SIWE and standard Privacy Pass;
- onchain replay is another transport source and cursor, not another messaging protocol;
- blob publication is permissionless and does not assign authority to the configured batcher;
- first contact uses signed, locally generated Olm one-time keys and ordinary encrypted envelopes,
  without a prekey server or public coordination state.

There is still no custom identity registry, payment contract, public recipient tag, archive, or new
cryptographic primitive. If a future milestone requires one of those, stop and reassess before
adding it.

## Implementation and test coverage

Handwritten browser, relay, batcher, codec, storage, and test code is strict TypeScript. Generated
`wasm-bindgen` JavaScript remains checked in beside its declarations.

Automated coverage includes:

- fixed envelope length, wrong-key rejection, random-slot rejection, and tamper detection;
- canonical blob geometry, dummy padding, secure shuffling, and bounded retention;
- ratchet persistence, distinct one-time-key setup, exact-offer enforcement, key consumption and
  cleanup, out-of-order delivery, and maximum-size initial messages;
- fixed-size identified request/offer parsing, signatures bound to every handshake identity and
  routing input, current GNS verification, explicit acceptance, and silent ignore without an offer;
- live-plus-blob deduplication and browser delivery with live reception disabled;
- multi-blob grouping, retained retries, and the persistent daily subsidy guard;
- GNS directory discovery plus current owner and contact-key verification;
- the SIWE to blind issuance to one-time redemption flow;
- a virtual WebAuthn PRF authenticator proving atomic migration, removal of plaintext state,
  lock/unlock across reload, and preservation of the exact chat identity.
