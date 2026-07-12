# gwei chat prototype

A small browser messenger addressed by `.gwei` names. Messages are end-to-end encrypted, delivered
live when possible, and published in permissionless Ethereum blob batches for recovery during the
normal blob-availability window.

This is a prototype, not yet a safe place for real secrets.

## Highlights

- Type `alice.gwei` to start a chat after Alice publishes her contact bundle in the existing
  `domains.gwei.chat` GNS text record.
- First contact privately identifies the requester to the recipient, who can accept or silently
  ignore it. Acceptance generates a fresh signed Olm one-time key; there is no prekey server,
  public key pool, or reusable fallback key.
- Private identity and ratchet state are encrypted locally in a passkey-unlocked browser vault.
- The browser submits only opaque, fixed-size encrypted envelopes. It never holds a batcher's
  transaction key.
- Live delivery and blobs are interchangeable transport paths for the same encrypted message.
- Blob reading is permissionless: the browser discovers valid batches from every publisher, not
  only the configured submission batcher.
- The subsidized relay can admit `.gwei` holders with unlinkable one-time Privacy Pass tokens.
- No archive is provided. Messages disappear when Ethereum's blob-availability window closes.

The complete protocol design, trust boundaries, storage model, batching geometry, and known limits
are documented in [ARCHITECTURE.md](./ARCHITECTURE.md).

## Run locally

Use Node.js 24, then start the relay:

```sh
cd chat
npm install
npm run relay
```

In a second terminal:

```sh
cd chat
npm run dev
```

Open `http://localhost:5173/?profile=alice` and
`http://localhost:5173/?profile=bob`. Use `localhost`, not `127.0.0.1`, because the local passkey
relying party is bound to that hostname.

The `profile` parameter is a development convenience for creating separate IndexedDB identities on
one origin. Add `&live=0` to a recipient URL to test blob-only reception.

## Use it

The first-run screen walks through the useful path in order:

1. Publish the browser's public chat identity to a `.gwei` name.
2. Choose a fully verified identity from public discovery or enter one specific name.
3. The recipient sees a request only after the sender's signed identity matches its current GNS
   record. They can accept or silently ignore it.
4. After acceptance returns a fresh one-time key, send the first encrypted message.

Starting a new chat takes three encrypted envelopes: request, key offer, and first message. On a
holder-gated relay, an accepted chat needs passes from both people because each publishes part of
the handshake. Ignoring sends no response and spends no recipient pass. Established chats return to
one envelope per message.

Contact codes are kept under **Advanced identity options** as a fallback for unpublished contacts.
The sidebar identity control can also:

- obtain relay passes for subsidized submission;
- copy the fallback contact code;
- lock the private vault immediately.

Open **New chat** later to choose another currently valid published identity, type a specific name,
or expand the advanced contact-code fallback.

Open **Transport settings** to set your own:

- batcher submission URL;
- execution RPC;
- Beacon API;
- onchain-read preference.

These settings are local to the browser. Selecting a batcher affects submission only; onchain
recovery still accepts valid declarations from every batcher.
The selected execution RPC and Beacon API are trusted read sources; use endpoints you trust or your
own node. The receiver validates canonical framing and end-to-end messages but does not run an
Ethereum light client or recompute blob KZG commitments.

## Batcher configuration

With no key configured, `npm run relay` is local-only and cannot spend funds. A testnet publisher
uses a server-side key file:

```sh
BATCHER_KEY_FILE=../.sepolia-batcher.key \
PUBLISH_EXECUTION_RPC_URL=https://ethereum-sepolia-rpc.publicnode.com \
EXPECTED_CHAIN_ID=11155111 \
ERC8179_ADDRESS=0x9C4b230066a6808D83F5FBa0c040E0Df2Fcc7314 \
MAX_BLOBS_PER_TRANSACTION=6 \
BATCH_MAX_WAIT_MS=300000 \
DAILY_BUDGET_USD=20 \
npm run relay
```

The key file must be mode `0600` and must remain server-side. Holder admission is enabled by
default when a publisher key is present. The main controls are:

| Variable | Default purpose |
| --- | --- |
| `ADMISSION_DAILY_QUOTA` | Messages allowed per top-level `.gwei` name per UTC day |
| `ADMISSION_BATCH_SIZE` | Blind passes issued per refill |
| `ADMISSION_DATABASE` | Persistent issuance and spent-token SQLite ledger |
| `MAX_BUFFERED_ENVELOPE_SLOTS` | Hard cap on queued publication work |
| `DAILY_BUDGET_USD` | Persistent UTC subsidy ceiling |
| `MAX_BLOBS_PER_TRANSACTION` | Blobs grouped into one transaction, from 1 to 6 |
| `BATCH_MAX_WAIT_MS` | Maximum wait before publishing a non-empty partial batch |
| `BATCH_RETENTION` | Local development replay retention only |

Set `ADMISSION_REQUIRED=0` only for local development or when deliberately supplying another
admission policy. Full publisher and admission behavior is described in
[Batching and publication](./ARCHITECTURE.md#batching-and-publication) and
[Spam resistance](./ARCHITECTURE.md#spam-resistance-and-subsidy-admission).

## Verify it

```sh
npm run typecheck
npm test
npm run crypto:test
npm run build
npm run test:e2e
```

Browser tests run against isolated local services with onchain publication disabled, so they cannot
spend funds. To regenerate the checked-in WASM bindings after changing the Rust wrapper:

```sh
rustup target add wasm32-unknown-unknown
npm run crypto:build
```

Run the full browser cold-start simulator with `npm run bench:cold-start -- --blobs=100`. Its
methodology, options, measured baselines, and scaling decisions are in [BENCHMARKS.md](./BENCHMARKS.md).

The Foundry ERC-8179 compatibility fixture and manual blob round-trip commands are documented in
[Onchain discovery and interoperability](./ARCHITECTURE.md#onchain-discovery-and-interoperability).

## Production gate

Do not deploy this as a production messenger until the composition has received independent review.
If it advances, the browser app must use the isolated `chat.gwei.domains` origin, pinned reproducible
bundles, strict response headers, and no third-party scripts. See
[Security model and honest limits](./ARCHITECTURE.md#security-model-and-honest-limits).
