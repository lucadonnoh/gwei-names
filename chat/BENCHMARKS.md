# gwei chat performance benchmarks

This document records reproducible performance measurements for the browser protocol. The benchmark
is intended to guide architecture decisions, not to advertise best-case throughput.

## Cold-start simulator

Run the default protected-vault simulation with:

```sh
cd chat
npm run bench:cold-start -- --blobs=100
```

Useful parameters are:

```text
--blobs=N              declarations and blobs in the unread availability backlog
--pending=N            locally initiated handshakes awaiting offers, from 0 to 32
--storage=vault        encrypted passkey vault, matching production
--storage=development  plaintext loopback storage, for comparison only
--page-size=N          ERC-8179 discovery page size
--beacon-latency-ms=N  fixed delay for each Beacon blob response
--beacon-mbps=N        Beacon response throughput; zero is unthrottled localhost
--cpu-throttle=N       Chromium CPU throttling multiplier
```

The command emits progress to stderr and one machine-readable JSON result to stdout. Run
`npm run bench:cold-start -- --help` for the complete interface.

### What it exercises

The simulator launches real headless Chromium and the actual application modules. It creates an
empty IndexedDB profile, protects and reloads it through a virtual WebAuthn PRF authenticator, then
processes a synthetic permissionless onchain backlog through:

1. a JSON-RPC server exposing ERC-8179 declaration logs from arbitrary declarers;
2. the real `OnchainBlobSource` cursor and pagination logic;
3. a trusted Beacon endpoint returning exactly one canonical JSON/hex blob for the requested hash;
4. canonical 31-byte field-element extraction and 62-slot unpacking;
5. SHA-256 transport identifiers;
6. `receiveEnvelopes`, including one IndexedDB/vault read per blob, HPKE trial decryption, and inner
   protocol rejection;
7. persistent onchain cursor updates.

The fixture uses 62 structurally valid X25519 dummy envelopes per blob. From the benchmark
identity's perspective, another user's valid HPKE envelope follows the same expensive rejection path:
X25519 decapsulation followed by a failing AES-GCM tag. The same canonical blob is declared many
times so fixture generation remains constant; the production client does not cache it, and every
declaration still performs the complete fetch, canonical parsing, hashing, and decryption path.

The simulator distributes six declarations per execution block and uses the production discovery
page size of eight. Beacon latency and throughput shaping apply only to blob response bodies; RPC
latency is local. Results exclude fixture generation and passkey setup. The reported scan time starts
before the first onchain discovery call.

Every run also creates a second fresh identity, establishes its cursor at a finalized block older
than that key, and asserts that zero historical declarations are listed. A 50 ms timer records event
loop delay throughout the scan.

## Measured results

Measured on 2026-07-12 using an Apple M4 Pro with 12 logical cores and Chromium 149. Each Beacon JSON
response was 262,205 bytes for a 131,072-byte blob because the current API path returns hex inside
JSON.

The original sequential implementation measured:

| Original profile | Blobs | Slots | Beacon data | Total scan |
| --- | ---: | ---: | ---: | ---: |
| Protected vault, localhost | 100 | 6,200 | 25.0 MiB | 31.3 s |
| Protected vault, 50 ms + 50 Mbit/s Beacon | 100 | 6,200 | 25.0 MiB | 41.5 s |
| Protected vault, localhost | 1,000 | 62,000 | 250.1 MiB | 251.8 s |
| Protected vault, 4× CPU throttle | 20 | 1,240 | 5.0 MiB | 47.7 s |

The 1,000-blob localhost run broke down as follows:

| Phase | Total | Share |
| --- | ---: | ---: |
| Beacon fetch, hex decoding, and KZG | 214.4 s | 85.1% |
| Vault state reads and HPKE trial decryption | 28.9 s | 11.5% |
| ERC-8179 discovery pages | 7.5 s | 3.0% |
| Cursor writes | 0.4 s | 0.2% |
| SHA-256 and blob unpacking | 0.5 s | 0.2% |

On the unthrottled desktop, the first blob took about 7.3 seconds because KZG-WASM initialized and
computed its first commitment. Warm fetch-plus-KZG cost had a 206.9 ms median. Trial decryption,
including an encrypted vault read for every slot, averaged 28.9 ms per blob.

With 4× CPU throttling, the first blob took 29.7 seconds, warm fetch-plus-KZG had an 812 ms median,
and vault-plus-HPKE scanning averaged 127 ms per blob. CPU throttling is not a substitute for real
phone measurements, but it establishes that the unoptimized cold path was unacceptable on slower
devices.

### Current trusted-read implementation

The receiver now reflects the application's actual trust boundary: the selected execution RPC is
trusted for finalized logs and GNS records, and the selected Beacon API is trusted to return the blob
requested by versioned hash. Receiver-side KZG was removed rather than retained as an optional mode.
Publisher-side KZG remains unchanged.

The other implemented scan optimizations are:

- a fresh delivery key starts at a finalized block that predates its creation;
- dense ERC-8179 log results are buffered instead of downloading the same range once per page;
- four Beacon requests may be in flight while ratchet mutation remains strictly ordered;
- all 62 slots share one decrypted private-state snapshot.

Measured results for the exact current path are:

| Current profile | Blobs | Slots | Beacon data | Total scan |
| --- | ---: | ---: | ---: | ---: |
| Protected vault, localhost | 100 | 6,200 | 25.0 MiB | 2.92 s |
| Protected vault, 50 ms + 50 Mbit/s Beacon | 100 | 6,200 | 25.0 MiB | 5.46 s |
| Protected vault, localhost | 1,000 | 62,000 | 250.1 MiB | 28.93 s |
| Protected vault, 4× CPU throttle | 20 | 1,240 | 5.0 MiB | 2.27 s |
| Protected vault, one pending reply key | 100 | 6,200 | 25.0 MiB | 5.20 s |

The current 1,000-blob localhost run broke down as follows:

| Phase | Total | Share |
| --- | ---: | ---: |
| Batched HPKE trial decryption | 21.30 s | 73.6% |
| Pipelined Beacon fetch and JSON/hex decoding | 6.19 s | 21.4% |
| Cursor writes | 0.86 s | 3.0% |
| SHA-256 and blob unpacking | 0.43 s | 1.5% |
| ERC-8179 discovery pages | 0.12 s | 0.4% |

Compared with the original strict path, 100 localhost blobs improved from 31.3 to 2.92 seconds,
100 shaped-network blobs from 41.5 to 5.46 seconds, and 1,000 localhost blobs from 251.8 to 28.93
seconds. The first localhost blob now completes in about 110 ms rather than more than seven seconds.

The 1,000-blob run's event-loop-delay median was 0 ms, p95 was 17.8 ms, and maximum was 68.9 ms.
With no pending reply key, all 62 trial decryptions averaged 21.3 ms per blob. One pending reply key
increased that to 43.1 ms per blob, as expected from trying a second private key.

Most importantly, the simulator verified that a fresh identity listed **zero** of the 100 historical
blobs. The measured backlog numbers apply to a returning identity whose saved cursor is behind,
not to normal first-run onboarding. Returning identities still do the necessary work for the period
in which they were offline.

The official Beacon API defines an `application/octet-stream` SSZ response that would avoid JSON's
2× hex expansion. The configured Sepolia PublicNode endpoint returned the 262,205-byte JSON response
even when explicitly requested with that media type, so production must negotiate it opportunistically
and retain a JSON fallback. See the [Beacon `getBlobs` API](https://github.com/ethereum/beacon-APIs/blob/master/apis/beacon/blobs/blobs.yaml).

### Backlog projections

At the current 18.2-day mainnet availability window, measured throughput with no pending reply keys
implies:

| Scenario | Unread blobs | Localhost desktop | Approx. 50 Mbit/s | Beacon JSON |
| --- | ---: | ---: | ---: | ---: |
| 1,000-blob backlog | 1,000 | 28.9 s measured | ~55 s | 262 MB |
| One non-empty blob every five minutes | 5,243 | ~2.5 min | ~5 min | 1.37 GB |
| Saturated $20/day relay at the 2026-07-12 fee snapshot | ~62,000 | ~30 min | ~1 hour | 16.3 GB |
| Every current mainnet blob slot, one unique declaration each | 2.75 million | ~22 hours | ~2 days | 722 GB |

These are returning-user backlog estimates; a fresh identity skips preceding history. The budget row
is fee-sensitive and assumes full six-blob transactions. The chain-wide row is an engineering bound,
not a plausible product workload. It also excludes duplicate ERC-8179 events: identical declarations
are permitted, so hostile log spam has no useful blob-count bound until the reader deduplicates and
adaptively limits log queries.

## Conclusions and implementation order

HPKE trial decryption is now the main localhost CPU cost. On slower or remote connections, Beacon
latency and JSON transfer can dominate instead. Each pending reply key adds another HPKE trial for
every slot, so the existing cap and 24-hour expiry remain important. Every recipient's work still
grows with total global blob traffic rather than inbox traffic; no local optimization changes that
asymptotic limit.

The remaining implementation order is deliberately short:

1. **Prefer binary Beacon responses.** Request SSZ/octet-stream when supported, with strict fallback
   to the current JSON parser. The default provider currently ignores this negotiation.
2. **Make long sync explicit and bounded.** Show block/blob progress and throughput, add pause/resume,
   deduplicate identical declarations, and adaptively split dense log ranges.
3. **Validate on physical phones.** Record the 100- and 1,000-blob profiles on ordinary mobile
   devices and establish an explicit automatic-download warning threshold.

Public recipient or session tags would reduce scanning but would change the privacy model. The
current data does not justify adding them.

## Honest scope

This stack measures the complete current data plane but not every real-world variable. It does not
model Beacon provider queueing, packet loss, radio wakeups, competing tabs, valid-message rendering,
or a hostile number of declarations in one block. The virtual passkey removes human interaction
time. It does not model an actively malicious selected RPC or Beacon provider.

Benchmark JSON includes the browser version, CPU, options, stored-state size, phase distributions,
bytes, cursors, event-loop delay, a verified fresh-identity baseline, and accepted-event count so
future changes can be compared without relying on this document's rounded tables.
