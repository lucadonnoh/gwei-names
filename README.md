<p align="center">
  <img src="./gns-icon.svg" alt="GNS" width="64" height="64">
</p>

# Gwei Name Service (GNS)

A simple, ownerless namespace on Ethereum named after **gwei** — the unit Ethereum gas is priced in.

GNS is an ownerless, neutral fork of [wei-names](https://github.com/z0r0z/wei-names). It keeps everything that made wei-names good and removes the two things that made it un-neutral:

- **No owner.** wei-names has an `Ownable` admin who can change fees and withdraw the contract's ETH. GNS has **no owner, no admin, and no upgrade path** — there is nothing to rug.
- **Fees are burned, not collected.** Registration/renewal still cost a *fixed*, length-based fee (the same anti-squat schedule wei-names uses — shorter names cost more), but that ETH is **locked in the contract forever** — there is no `withdraw()`, so nobody profits. Like the EIP-1559 base fee, every `.gwei` registration simply burns ETH.

The result is a neutral public good: fixed rules nobody can change, and money nobody can extract.

**Status:** live + verified on **Ethereum mainnet and Sepolia**. The core contracts share addresses across both networks; `HumanRegistrar` has a network-specific address.

| Contract | Mainnet | Sepolia |
|---|---|---|
| `NameNFT.sol` | [`0x9D51…81d6`](https://etherscan.io/address/0x9D51D507BC7264d4fE8Ad1cf7Fe191933A0a81d6) | [`0x9D51…81d6`](https://sepolia.etherscan.io/address/0x9D51D507BC7264d4fE8Ad1cf7Fe191933A0a81d6) |
| `SubdomainRegistrar.sol` | [`0xc1D5…3f3c`](https://etherscan.io/address/0xc1D5245bfd98dDB7E73B33209B346b4FC0E03f3c) | [`0xc1D5…3f3c`](https://sepolia.etherscan.io/address/0xc1D5245bfd98dDB7E73B33209B346b4FC0E03f3c) |
| `GnsUniversalResolver.sol` | [`0xD658…1564`](https://etherscan.io/address/0xD658131FFB6D732335d37f199374289F1b31564F) | [`0xD658…1564`](https://sepolia.etherscan.io/address/0xD658131FFB6D732335d37f199374289F1b31564F) |
| `HumanRegistrar.sol` | [`0xA428…330A`](https://etherscan.io/address/0xA4283D56f523d05bBd46e483f7861d6D10Cb330A) | [`0xAA6C…E870`](https://sepolia.etherscan.io/address/0xAA6C81c54ecA32e1949b9Ff80eAC21D03261E870) |

`NameNFT` takes no constructor args; `SubdomainRegistrar`'s constructor takes the deployed `NameNFT` address.

**Dapp:** [`gwei.domains`](https://gwei.domains) — source at `dapp/gweiNS.html` (a single self-contained, network-aware HTML file).

**JS SDK:** [`gns-utils`](sdk/) — resolve `.gwei` names, reverse-resolve, compute IDs and fees. `createGnsClient()` defaults to the mainnet deployment.

**MetaMask Snap:** [`@donnoh/gwei-name-service-snap`](https://www.npmjs.com/package/@donnoh/gwei-name-service-snap) — forward and reverse `.gwei` resolution in MetaMask. It reads GNS through MetaMask's Ethereum provider.

**Gateway:** [`gwei.domains`](https://gwei.domains) resolves `name.gwei.domains` to IPFS, IPNS, or Swarm content.

---

## Overview

GNS provides `.gwei` names as NFTs (ERC-721). Names can:
- Resolve to an Ethereum address (receive payments)
- Host a website via IPFS, IPNS, or Swarm contenthash
- Have unlimited free subdomains
- Store multi-coin addresses and text records (ENS-compatible resolver)
- Display as your wallet's identity (reverse resolution)

The contract is a single, non-upgradeable Solidity file (`NameNFT.sol`) that combines ERC-721 ownership, registration logic, and resolver functionality.

- **Solidity:** `^0.8.30`
- **License:** MIT

---

## Architecture

### Inheritance

```
NameNFT
  ├── ERC721        (solady)   — gas-optimized NFT
  └── ReentrancyGuard (soledge) — reentrancy protection
```

There is no `Ownable` (or any other access-control base): GNS has no privileged role.

### Token ID = Namehash

Token IDs are computed as `uint256(namehash)`, following the ENS namehash algorithm (EIP-137).

```
namehash("") = bytes32(0)
namehash("gwei") = keccak256(abi.encodePacked(namehash(""), keccak256("gwei")))
namehash("alice.gwei") = keccak256(abi.encodePacked(namehash("gwei"), keccak256("alice")))
namehash("sub.alice.gwei") = keccak256(abi.encodePacked(namehash("alice.gwei"), keccak256("sub")))
```

The precomputed constant:
```
GWEI_NODE = namehash("gwei")
         = keccak256(abi.encodePacked(bytes32(0), keccak256("gwei")))
         = 0xcca9c7f2dbe2808af0de2982fc84314bfa68a82a6a60ad5cd757f91a233d7d7f
```

**JavaScript example:**
```javascript
import { ethers } from 'ethers';

const GWEI_NODE = '0xcca9c7f2dbe2808af0de2982fc84314bfa68a82a6a60ad5cd757f91a233d7d7f';

function computeTokenId(label) {
  const labelHash = ethers.keccak256(ethers.toUtf8Bytes(label));
  return BigInt(ethers.keccak256(ethers.concat([GWEI_NODE, labelHash])));
}

function computeSubdomainId(label, parentId) {
  const parentNode = ethers.zeroPadValue(ethers.toBeHex(parentId), 32);
  const labelHash = ethers.keccak256(ethers.toUtf8Bytes(label));
  return BigInt(ethers.keccak256(ethers.concat([parentNode, labelHash])));
}
```

---

## Constants

All fee parameters are `constant`. There are no admin-settable fee variables, so there are also no admin caps (`MAX_PREMIUM_CAP` / `MAX_DECAY_PERIOD` from wei-names are gone — nothing to cap).

| Constant | Value | Description |
|---|---|---|
| `GWEI_NODE` | `0xcca9...7d7f` | Namehash of the "gwei" TLD |
| `MAX_LABEL_LENGTH` | 255 bytes | Maximum label byte length |
| `MIN_LABEL_LENGTH` | 1 byte | Minimum label byte length |
| `MIN_COMMITMENT_AGE` | 60 seconds | Minimum wait before reveal |
| `MAX_COMMITMENT_AGE` | 86400 seconds (24h) | Commitment expiration |
| `REGISTRATION_PERIOD` | 365 days | Duration of one registration |
| `GRACE_PERIOD` | 90 days | Post-expiry renewal window |
| `MAX_SUBDOMAIN_DEPTH` | 10 | Maximum nesting of subdomains |
| `COIN_TYPE_ETH` | 60 | SLIP-44 coin type for ETH |
| `FEE_LEN1` | 0.5 ETH | Fee for 1-byte labels (burned) |
| `FEE_LEN2` | 0.1 ETH | Fee for 2-byte labels (burned) |
| `FEE_LEN3` | 0.05 ETH | Fee for 3-byte labels (burned) |
| `FEE_LEN4` | 0.01 ETH | Fee for 4-byte labels (burned) |
| `DEFAULT_FEE` | 0.0005 ETH | Fee for 5+ byte labels (burned) |
| `MAX_PREMIUM` | 100 ETH | Fixed starting anti-snipe premium (burned) |
| `PREMIUM_DECAY_PERIOD` | 21 days | Fixed premium decay window |

---

## Constructor

There is **no constructor** — and no owner to initialize. All parameters are compile-time constants, so the contract deploys with no arguments and no privileged deployer state. (wei-names used `constructor() { _initializeOwner(tx.origin); ... }`; GNS removes it entirely.)

---

## Name Lifecycle

### 1. Registration (Commit-Reveal)

A two-step commit-reveal pattern prevents frontrunning:

1. **Commit** — Submit `keccak256(abi.encode(normalizedLabel, owner, secret))` on-chain. The commitment uses the *normalized* label bytes (ASCII lowercased), not the raw input.
2. **Wait** — At least 60 seconds (`MIN_COMMITMENT_AGE`).
3. **Reveal** — Submit the label, secret, and payment. The commitment must be no older than 24 hours (`MAX_COMMITMENT_AGE`).

The commitment is deleted after a successful reveal. An expired commitment (>24h) can be overwritten by a new `commit()`.

**Off-chain commitment computation:**
```javascript
// IMPORTANT: normalize the label the same way the contract does (lowercase ASCII)
const normalized = label.toLowerCase(); // for ASCII-only labels
const commitment = ethers.keccak256(
  ethers.AbiCoder.defaultAbiCoder().encode(
    ['bytes', 'address', 'bytes32'],
    [ethers.toUtf8Bytes(normalized), ownerAddress, secret]
  )
);
```

### 2. Active Period

- Registration lasts **365 days** from the time of reveal.
- The name is **active** while `block.timestamp <= expiresAt`.
- While active: transfers, resolver writes, and resolution all work.

### 3. Expiry + Grace Period

- After `expiresAt`, the name enters a **90-day grace period**.
- During grace: the name is **not active** — transfers are blocked, resolver reads return empty, resolver writes revert.
- During grace: **renewal is allowed** and extends from the original `expiresAt` (not from current time).
- Anyone can call `renew()` for any name (not restricted to the owner).

### 4. Full Expiration

- After `expiresAt + GRACE_PERIOD`, the name is fully expired.
- It can be re-registered by anyone through a new commit-reveal cycle.
- Re-registration increments the `epoch`, invalidating all existing subdomains.
- Re-registration increments `recordVersion`, clearing all resolver data.

### 5. Premium Pricing (Dutch Auction)

Immediately after a name fully expires (grace period ends), a premium is charged on top of the base fee. The premium starts at `MAX_PREMIUM` (fixed: 100 ETH) and decays linearly to 0 over `PREMIUM_DECAY_PERIOD` (fixed: 21 days).

```
premium = MAX_PREMIUM * (PREMIUM_DECAY_PERIOD - elapsed) / PREMIUM_DECAY_PERIOD
```

Where `elapsed` is seconds since `expiresAt + GRACE_PERIOD`. After the decay period, premium is 0. Like the base fee, this premium is **burned** (locked in the contract) — it is an anti-snipe cost, not revenue.

---

## Fee Structure

### Fixed Length-Based Schedule, and Burned

GNS keeps the **same length-based schedule the live wei-names uses** — shorter labels cost more, to make squatting premium names expensive — but freezes it into `constant`s:

| Label length (UTF-8 bytes) | Fee |
|---|---|
| 1 | 0.5 ETH |
| 2 | 0.1 ETH |
| 3 | 0.05 ETH |
| 4 | 0.01 ETH |
| 5 or more | 0.0005 ETH (`DEFAULT_FEE`) |

```
getFee(length):
  length == 1 → 0.5 ETH
  length == 2 → 0.1 ETH
  length == 3 → 0.05 ETH
  length == 4 → 0.01 ETH
  else        → 0.0005 ETH
```

The fee is keyed on `bytes(label).length` (UTF-8 byte length, not character count) — e.g. a 4-byte emoji pays the 4-byte tier.

The two differences from wei-names are exactly what make GNS neutral:

- **The schedule cannot change.** Every tier is a `constant`. There is no `setDefaultFee`, no `setLengthFees`, no owner. wei-names' owner has already changed these values on-chain (the default was lowered from the source's 0.001 ETH to 0.0005 ETH, and the 1–4 byte tiers were added) — in GNS, nobody can.
- **The fee is never collected.** Paid ETH stays in the contract permanently — there is no `withdraw()` and no owner, so the balance is unreachable. In effect, registering a `.gwei` name **burns** its fee (plus any expiry premium). The fee exists only to make mass-squatting cost something; nobody earns it.

### Renewal Fee

Renewal costs the same length-based fee as registration. No premium is charged on renewal. Renewal ETH is burned the same way.

---

## Integration Voting

The website can order its curated integration cards by `.gwei` voting power. Voting changes only the order; adding or removing an integration remains a curated decision.

Voting power is proportional to the fixed annual registration price, with a 5+ byte name as one vote:

| Label length (UTF-8 bytes) | Votes |
|---|---:|
| 1 | 1,000 |
| 2 | 200 |
| 3 | 100 |
| 4 | 20 |
| 5 or more | 1 |

Only currently active, top-level names are eligible. Expired names and subdomains contribute zero. Premiums and transaction gas do not affect voting power.

The website combines every eligible name owned by the connected address into one pool. The user allocates that pool directly on the integration cards, sees the remaining amount in a small fixed dock, and signs once. The dapp deterministically packs the pooled allocation into complete per-name ballots and calls `cast(...)` once. The practical name limit depends on the allocation shape, so the complete batch is gas-estimated before the wallet opens.

[`GnsIntegrationVoting.sol`](src/GnsIntegrationVoting.sol) is an ownerless, non-upgradeable, stateless event emitter:

- It reads ownership, activity, epoch, top-level status, and the immutable fee schedule directly from `NameNFT`.
- It has no admin, allowlist, treasury, fees, or mutable storage.
- Each `BallotCast` event is the complete replacement ballot for one `(tokenId, epoch)`; an empty allocation clears it.
- Integration IDs are `keccak256` hashes of stable website slugs. The current tally is reconstructed from the latest event per token and checked against current `NameNFT` records, so expiry, transfer, and re-registration are reflected without a governance transaction. A ballot stops counting while its signer does not own the name or the name is expired. It can resume after a transfer back or renewal in the same registration epoch; re-registration increments the epoch and permanently invalidates the old ballot.
- `NameNFT` renewal is permissionless: anyone may pay to keep a name and its already-signed ballot active. Expiry is therefore not revocation; the owner revokes with an empty replacement ballot.
- A ballot cannot contain more nonzero allocations than its name has voting power, so oversized arrays fail before the contract walks them. The website estimates the complete batch before opening the wallet and refuses a batch at Ethereum's per-transaction gas cap. Tests cover 100-name batches with both one allocation per name and all 24 current integrations per name.

For fast wallet loading, the browser asks Blockscout's open API for candidate token IDs, then proves the result complete with `balanceOf` and `ownerOf` in same-block onchain multicalls. An unavailable, stalled, stale, truncated, or incorrect index response is rejected automatically and falls back to the complete direct-RPC event scanner. Blockscout is therefore an optional accelerator, not a voting authority or availability dependency. The query exposes the connected address and visitor IP to Blockscout; the voting panel discloses this before connection and offers a persistent **RPC only** mode, which instead exposes the address filter to the configured public RPC providers. After a vote is mined, the UI validates and applies the canonical `BallotCast` receipt logs immediately, while a complete public-index reconciliation runs in the background.

The contract is deployed and verified at the same address, [`0xaA2c…5005`](https://etherscan.io/address/0xaA2c0f39F0b1a62A8aEB359bCd67874D2D145005), on Ethereum mainnet from block `25,838,194` and on [Sepolia](https://sepolia.etherscan.io/address/0xaA2c0f39F0b1a62A8aEB359bCd67874D2D145005) from block `11,562,708`. The deployment script is [`DeployGnsIntegrationVoting.s.sol`](script/DeployGnsIntegrationVoting.s.sol).

---

## Subdomains

### Registration

- Parent owner calls `registerSubdomain(label, parentId)` or `registerSubdomainFor(label, parentId, to)`.
- Subdomains are **free** (no fee).
- Subdomains have **no independent expiry** — they are active as long as the parent chain is active.
- Maximum nesting depth: 10 levels below the top-level name.

### Epoch-Based Invalidation

Each name record has an `epoch` counter. When a subdomain is created, it stores `parentEpoch` — the parent's epoch at creation time. A subdomain is considered **stale** (inactive) if its `parentEpoch` does not match the parent's current `epoch`.

This happens when:
- The parent name expires and is re-registered (epoch increments).
- The parent owner reclaims the subdomain via `registerSubdomain()` (burns the old token, mints a new one with incremented epoch).

Stale subdomains:
- Return empty strings from resolver reads.
- Show `[Invalid]` in `tokenURI`.
- Cannot be transferred (blocked by `_isActive` check in `_beforeTokenTransfer`).

### Reclaim

The parent owner can always call `registerSubdomain()` with an existing subdomain label. This burns the old token (clearing the previous owner's holding), increments the epoch, and mints a fresh token to the parent owner. The previous owner's `primaryName` is cleared if it pointed to the reclaimed token.

**Note:** `isAvailable()` returns `false` for active subdomains, even though the parent owner can overwrite them. Parent owners should call `registerSubdomain()` directly — it will succeed for reclaim regardless of `isAvailable()` result.

---

## Record Versioning

Each token has a `recordVersion` counter. All resolver data (address, contenthash, multi-coin addresses, text records) is keyed by `(tokenId, recordVersion)`. When a name is re-registered after expiry, `recordVersion` is incremented, effectively clearing all previous resolver data without paying gas to delete storage.

---

## Resolution

### Forward Resolution

```
resolve(tokenId):
  if name is not active → return address(0)
  if explicit address is set → return that address
  else → return ownerOf(tokenId)
```

The fallback to `ownerOf` means a freshly registered name resolves to its owner by default.

### Reverse Resolution

Users set a **primary name** via `setPrimaryName(tokenId)`. The caller must be the token owner or the address that the token resolves to.

```
reverseResolve(addr):
  if primaryName[addr] is 0, or name is not active, or resolve(tokenId) != addr → return ""
  else → return "label.gwei" (or "sub.label.gwei" etc.)
```

Setting `primaryName` to `tokenId = 0` clears the primary name.

### Multi-Coin Addresses

`setAddrForCoin(tokenId, coinType, addr)` stores addresses for any SLIP-44 coin type. For coin type 60 (ETH), the `addr()` function first checks the explicit coin address, then falls back to `resolve()`.

### Text Records

Standard key-value text records via `setText` / `text`. Common keys: `avatar`, `url`, `description`, `com.twitter`, `com.github`, etc.

### Contenthash

`setContenthash` / `contenthash` for IPFS/Swarm/etc. content addressing. Used by the gateway (`gwei.domains`) to serve websites. A name can instead point at a contract-hosted site through the `contentcontract` text record — see [Contract-hosted websites](#contract-hosted-websites-web3).

---

## Normalization & Validation

### On-Chain Validation (`_validateAndNormalize`)

The contract enforces:
- Label byte length: 1–255 bytes
- Valid UTF-8 encoding (rejects invalid sequences, overlong encodings, surrogates, codepoints above U+10FFFF)
- No control characters (0x00–0x1F), space (0x20), dot (0x2E), or DEL (0x7F)
- No leading or trailing hyphens
- ASCII A–Z is lowercased to a–z

The contract does **not** perform Unicode normalization (NFC/NFD), confusable detection, or script restriction. These are delegated to the client layer.

### Off-Chain Normalization (ENSIP-15)

For proper Unicode safety, callers SHOULD pre-normalize labels using [ENSIP-15](https://docs.ens.domains/ensip/15/) via the `@adraffy/ens-normalize` library before calling the contract.

```javascript
import { ens_normalize } from '@adraffy/ens-normalize';

function normalizeLabel(label) {
  try {
    const normalized = ens_normalize(label);
    if (normalized.includes('.')) return null; // No dots in labels
    return normalized;
  } catch (e) {
    return null; // Invalid (confusables, invisible chars, etc.)
  }
}
```

### Why Client-Side Normalization

1. **Future-proof** — Normalization standards evolve (ENSIP-15 replaced ENSIP-1, Unicode updates yearly). On-chain rules would be frozen or require expensive upgrades.
2. **Ecosystem alignment** — ENS, DNS, and other naming systems handle normalization at the application layer.
3. **International support** — Overly restrictive on-chain validation could block legitimate international names.
4. **Gas efficiency** — Full Unicode normalization tables are impractical on-chain.

### Helper Functions

- `normalize(label)` — On-chain validation + ASCII lowercasing. Reverts on invalid input.
- `isAsciiLabel(label)` — Returns `true` if label is pure ASCII. If true, on-chain normalization is sufficient.
- `computeNamehash(fullName)` — Computes namehash for a full name (e.g., `"sub.name"` or `"sub.name.gwei"`). Lowercases ASCII but does not validate label characters (no UTF-8 check, no hyphen rules). Does reject empty labels (leading/trailing/consecutive dots). Strips `.gwei` suffix if present.
- `computeId(fullName)` — Returns `uint256(computeNamehash(fullName))`.

---

## Access Control

| Function | Access |
|---|---|
| `commit` | Anyone |
| `reveal` | Anyone (must match commitment owner) |
| `registerSubdomain` / `registerSubdomainFor` | Parent token owner only |
| `renew` | Anyone (for any name) |
| `setAddr`, `setContenthash`, `setAddrForCoin`, `setText` | Token owner only |
| `setPrimaryName` | Token owner or resolved address |

There is **no "Contract owner only" row** — every owner-gated function in wei-names (`setDefaultFee`, `setLengthFees`, `clearLengthFee`, `setPremiumSettings`, `withdraw`) has been removed. No address has any privilege over the contract.

---

## Transfer Restrictions

The `_beforeTokenTransfer` hook blocks transfers of **inactive** tokens. A token is inactive when:
- Top-level name: `block.timestamp > expiresAt` (after expiry, including during grace period)
- Subdomain: parent epoch mismatch, or parent chain is inactive

Mint (`from == address(0)`) and burn (`to == address(0)`) are always allowed regardless of active status.

---

## Security Properties

### Reentrancy Protection

The following functions have the `nonReentrant` modifier:
- `reveal` — uses `_safeMint` which calls `onERC721Received` on contract recipients
- `registerSubdomain` / `registerSubdomainFor` — also uses `_safeMint`
- `renew` — sends ETH refund

(wei-names' `withdraw` was also `nonReentrant`; it no longer exists.)

### Refund Handling

`reveal` and `renew` refund excess ETH to `msg.sender` via `SafeTransferLib.safeTransferETH`. If the caller cannot receive ETH (e.g., a contract without a `receive` function), the transaction reverts.

### Frontrunning Protection

The commit-reveal scheme requires a 60-second minimum delay between commit and reveal, preventing miners/searchers from observing a reveal transaction and frontrunning it.

### Primary Name Cleanup

When a name is re-registered or a subdomain is reclaimed, if the previous owner's `primaryName` pointed to that token, it is deleted.

---

## Contract Interface

### Read Functions

```solidity
// Registration helpers
function makeCommitment(string label, address owner, bytes32 secret) pure returns (bytes32)
function isAvailable(string label, uint256 parentId) view returns (bool)
function getFee(uint256 length) pure returns (uint256)   // fixed length-based schedule (see Fee Structure)
function getPremium(uint256 tokenId) view returns (uint256)
function normalize(string label) pure returns (string)
function isAsciiLabel(string label) pure returns (bool)

// Lookup
function computeId(string fullName) pure returns (uint256)
function computeNamehash(string fullName) pure returns (bytes32)
function getFullName(uint256 tokenId) view returns (string)

// Expiration
function expiresAt(uint256 tokenId) view returns (uint256)
function isExpired(uint256 tokenId) view returns (bool)     // true after expiresAt + GRACE_PERIOD
function inGracePeriod(uint256 tokenId) view returns (bool) // true between expiresAt and expiresAt + GRACE_PERIOD

// Resolution (uint256 tokenId overloads)
function resolve(uint256 tokenId) view returns (address)
function reverseResolve(address addr) view returns (string)
function contenthash(uint256 tokenId) view returns (bytes)
function text(uint256 tokenId, string key) view returns (string)
function addr(uint256 tokenId, uint256 coinType) view returns (bytes)

// Resolution (bytes32 node overloads — ENS-compatible)
function addr(bytes32 node) view returns (address)
function addr(bytes32 node, uint256 coinType) view returns (bytes)
function text(bytes32 node, string key) view returns (string)
function contenthash(bytes32 node) view returns (bytes)

// ERC-165
function supportsInterface(bytes4 interfaceId) view returns (bool)
// Supported: ERC-721, ERC-165, addr(bytes32) [0x3b3b57de], addr(bytes32,uint256) [0xf1cb7e06],
//            text [0x59d1d43c], contenthash [0xbc1c58d1]

// ERC-721 read functions
function name() pure returns (string)             // "Gwei Name Service"
function symbol() pure returns (string)           // "GWEI"
function tokenURI(uint256 tokenId) view returns (string)
function ownerOf(uint256 tokenId) view returns (address)
function balanceOf(address owner) view returns (uint256)
function getApproved(uint256 tokenId) view returns (address)
function isApprovedForAll(address owner, address operator) view returns (bool)

// Storage accessors (auto-generated)
function records(uint256 tokenId) view returns (string label, uint256 parent, uint64 expiresAt, uint64 epoch, uint64 parentEpoch)
function recordVersion(uint256 tokenId) view returns (uint256)
function commitments(bytes32) view returns (uint256)
function primaryName(address) view returns (uint256)
function GWEI_NODE() view returns (bytes32)
```

> Removed vs wei-names: the `defaultFee`, `maxPremium`, `premiumDecayPeriod`, `lengthFees`, and `lengthFeeSet` storage getters no longer exist — those values are now `constant`s read via `getFee` / `getPremium` (or `DEFAULT_FEE` / `MAX_PREMIUM` / `PREMIUM_DECAY_PERIOD`).

### Write Functions

```solidity
// Commit-reveal registration
function commit(bytes32 commitment)
function reveal(string label, bytes32 secret) payable returns (uint256 tokenId)

// Subdomains
function registerSubdomain(string label, uint256 parentId) returns (uint256 tokenId)
function registerSubdomainFor(string label, uint256 parentId, address to) returns (uint256 tokenId)

// Renewal
function renew(uint256 tokenId) payable

// Resolver writes (token owner only)
function setAddr(uint256 tokenId, address addr)
function setContenthash(uint256 tokenId, bytes hash)
function setAddrForCoin(uint256 tokenId, uint256 coinType, bytes addr)
function setText(uint256 tokenId, string key, string value)

// Reverse resolution
function setPrimaryName(uint256 tokenId)

// (No admin functions — wei-names' setDefaultFee / setLengthFees / clearLengthFee /
//  setPremiumSettings / withdraw have all been removed. There is no owner.)

// Standard ERC-721
function transferFrom(address from, address to, uint256 tokenId)
function safeTransferFrom(address from, address to, uint256 tokenId)
function safeTransferFrom(address from, address to, uint256 tokenId, bytes data)
function approve(address to, uint256 tokenId)
function setApprovalForAll(address operator, bool approved)
```

---

## Events

```solidity
// Registration
event NameRegistered(uint256 indexed tokenId, string label, address indexed owner, uint256 expiresAt)
event SubdomainRegistered(uint256 indexed tokenId, uint256 indexed parentId, string label)
event NameRenewed(uint256 indexed tokenId, uint256 newExpiresAt)
event PrimaryNameSet(address indexed addr, uint256 indexed tokenId)
event Committed(bytes32 indexed commitment, address indexed committer)

// ENS-compatible resolver events
event AddrChanged(bytes32 indexed node, address addr)
event ContenthashChanged(bytes32 indexed node, bytes contenthash)
event AddressChanged(bytes32 indexed node, uint256 coinType, bytes addr)
event TextChanged(bytes32 indexed node, string indexed key, string value)

// (No admin events — there are no admin functions to emit them.)
```

---

## Custom Errors

| Error | Condition |
|---|---|
| `Expired()` | Operation requires active name but name is expired/inactive |
| `TooDeep()` | Subdomain nesting exceeds `MAX_SUBDOMAIN_DEPTH` (10) |
| `EmptyLabel()` | Label is empty or name contains consecutive dots |
| `InvalidName()` | Label contains invalid characters or fails validation |
| `Unauthorized()` | Caller is not the token owner (resolver writes, `renew` on a subdomain, etc.) |
| `InvalidLength()` | Label byte length outside 1–255 range |
| `NotParentOwner()` | Subdomain registration attempted by non-parent-owner |
| `InsufficientFee()` | `msg.value` less than required fee + premium |
| `AlreadyCommitted()` | Commitment already exists and hasn't expired |
| `CommitmentTooNew()` | Reveal attempted before `MIN_COMMITMENT_AGE` (60s) |
| `CommitmentTooOld()` | Reveal attempted after `MAX_COMMITMENT_AGE` (24h) |
| `AlreadyRegistered()` | Top-level name still active or in grace period |
| `CommitmentNotFound()` | No matching commitment on-chain |

`Unauthorized()` is now declared by `NameNFT` itself (wei-names inherited it from `Ownable`, which GNS no longer uses) and is used in `setAddr`, `setContenthash`, `setAddrForCoin`, `setText`, `setPrimaryName`, and `renew` (subdomains cannot be renewed). The `LengthMismatch` / `PremiumTooHigh` / `DecayPeriodTooLong` errors were removed along with the admin functions that raised them.

The contract also uses an inherited error:
- `TokenDoesNotExist()` (from ERC721) — used in `tokenURI` and `renew` when the token has no record

---

## Storage Layout

```solidity
// Fee configuration: NONE. All fees are `constant`s (see Constants), so there is no
// fee-related storage and nothing for an owner to mutate.

// Name records
mapping(uint256 => NameRecord) public records;   // tokenId → record
mapping(uint256 => uint256) public recordVersion; // tokenId → version (increments on re-registration)

// Commitments
mapping(bytes32 => uint256) public commitments;   // commitment hash → timestamp

// Reverse resolution
mapping(address => uint256) public primaryName;   // address → tokenId

// Versioned resolver data (keyed by tokenId, recordVersion)
mapping(uint256 => mapping(uint256 => address)) internal _resolvedAddress;
mapping(uint256 => mapping(uint256 => bytes)) internal _contenthash;
mapping(uint256 => mapping(uint256 => mapping(uint256 => bytes))) internal _coinAddr;
mapping(uint256 => mapping(uint256 => mapping(string => string))) internal _text;

struct NameRecord {
    string label;        // Normalized label (ASCII lowercased)
    uint256 parent;      // Parent token ID (0 for top-level)
    uint64 expiresAt;    // Expiry timestamp (0 for subdomains)
    uint64 epoch;        // Increments on re-registration
    uint64 parentEpoch;  // Parent's epoch at time of subdomain creation
}
```

---

## IPFS and IPNS Contenthash

To host a website at `name.gwei.domains`:

1. Pin your site to IPFS (Pinata, web3.storage, etc.)
2. Get the CID (`Qm...` or `baf...`)
3. Call `setContenthash(tokenId, encodedHash)`

**Encoding:**
```javascript
// Contenthash = varint(0xe3) (IPFS namespace) + CID bytes
function encodeContenthash(cid) {
  let cidBytes;
  if (cid.startsWith('Qm')) {
    // CIDv0 -> CIDv1
    cidBytes = new Uint8Array([0x01, 0x70, ...base58Decode(cid)]);
  } else if (cid.startsWith('baf')) {
    // CIDv1 base32
    cidBytes = base32Decode(cid.slice(1));
  }
  return ethers.concat(['0xe301', cidBytes]);
}
```

IPNS records use the ENSIP-7 encoding `0xe501 || CIDv1(libp2p-key)`. The Set Website form accepts
`ipns://k...`, `/ipns/k...`, or the bare base36 `k...` name. The gateway validates that CID and
renders its IPNS name in the conventional lowercase base36 form before fetching it.

---

## Contract-hosted websites (web3://)

A name can also serve a site that lives entirely in a smart contract, fetched with one `eth_call`
instead of from a storage network. There is no multicodec for EVM contracts, so this cannot be a
contenthash; [ERC-6821](https://eips.ethereum.org/EIPS/eip-6821) puts it in a **`contentcontract`
text record** as an [ERC-3770](https://eips.ethereum.org/EIPS/eip-3770) chain-specific address.

```solidity
setText(tokenId, "contentcontract", "eth:0x6485b8b75a8ad382340abe333e1f6ee10e39f818")
```

Accepted values are `eth:0x…` (mainnet), `sep:0x…` (Sepolia), or a bare `0x…`, which ERC-6821 reads
as mainnet. In the dapp you paste the `web3://` URL into the same **Set Website** field used for
IPFS/IPNS and `bzz://` references, and it writes this record for you.

**`contenthash` takes precedence.** A name with both records set serves its contenthash, so no
existing site changes behavior when a `contentcontract` record appears. Clear the contenthash to
switch a name over. Set Website spells that out whenever a name holds both, and its **Remove
contenthash** button clears the one record in a single transaction, leaving the contract pointer
in place.

Two notes on how this differs from the spec and from other gateways:

- ERC-6821 also says to fall back to the name's *resolved address* when no `contentcontract` record
  exists. GNS `resolve()` falls back to `ownerOf`, so honoring that fallback would make every
  registered name claim to be a website. Only an explicit record counts.
- w3link injects a script into pages it serves, to rewrite `web3://` links into gateway URLs. We
  serve the contract's bytes unmodified, the same as the IPFS path does.

---

## Gateway (gwei.domains)

The gateway is a Cloudflare Worker (or equivalent) on the `gwei.domains` wildcard domain that:

1. Extracts name from subdomain (`name.gwei.domains`)
2. Queries contract for contenthash, falling back to the `contentcontract` text record
3. Decodes the IPFS, IPNS, or Swarm reference and fetches it from the matching public gateway, or
   calls the contract directly for a `contentcontract` record
4. Serves content with caching

For a contract-hosted site it first reads `resolveMode()`
([ERC-6860](https://eips.ethereum.org/EIPS/eip-6860)) and dispatches on the answer:

| `resolveMode()` | How the gateway calls it | Content type |
|---|---|---|
| `"5219"` | [ERC-6944](https://eips.ethereum.org/EIPS/eip-6944) `request(pathSegments, queryPairs)` returning `(status, body, headers)` | from the contract's own headers |
| `"manual"` | raw `path?query` as calldata (`"/"` at the root), returning ABI-encoded `bytes` | from the path extension, else `text/html` |
| anything else (auto) | not served yet — returns 415 | — |

Contract-supplied headers pass through an allowlist (`content-type`, `cache-control`,
`content-encoding`, `content-language`, `etag`, `last-modified`, `location`, `vary`); everything else
is dropped, and the standard security headers are applied on top. Chunked responses
(`web3-next-chunk`) are refused with a 501 rather than served truncated. `resolveMode` is cached for
24h, resolutions for 5 minutes, and content per URL, so a warm page costs no RPC calls at all.

**Root domain** (`gwei.domains`) resolves to `gns.gwei` (the official dapp).

> `gwei.domains` is the project's own gateway domain (the analogue of wei-names' `wei.domains`); it's the one piece of off-chain infrastructure GNS relies on. Until it's registered and the worker is deployed, name websites remain viewable through any public IPFS gateway (e.g. `https://ipfs.io/ipfs/<cid>`).

---

## Universal Resolver (wallets & dapps)

`NameNFT` implements the ENS resolver profile (`addr(bytes32)`, `text`, `contenthash`), but modern ENS tooling never calls resolver contracts directly: viem's `getEnsAddress` / `getEnsName` / `getEnsAvatar` (and everything built on them, including wagmi and wallets like Ambire) talk to a router contract, the "universal resolver", through `resolveWithGateways` / `reverseWithGateways`. `GnsUniversalResolver.sol` is that router for GNS: a stateless, ownerless adapter that forwards resolver-profile calls to `NameNFT` and wraps `reverseResolve` for reverse lookups.

With it, any viem-based app resolves `.gwei` names by passing one option:

```javascript
import { normalize } from 'viem/ens';

const GNS_UNIVERSAL_RESOLVER = '0xD658131FFB6D732335d37f199374289F1b31564F'; // mainnet + Sepolia

const address = await client.getEnsAddress({
  name: normalize('alice.gwei'),
  universalResolverAddress: GNS_UNIVERSAL_RESOLVER
});
const name = await client.getEnsName({ address, universalResolverAddress: GNS_UNIVERSAL_RESOLVER });
const avatar = await client.getEnsAvatar({
  name: normalize('alice.gwei'),
  universalResolverAddress: GNS_UNIVERSAL_RESOLVER
});
```

Behavior notes:

- Unregistered/expired names and addresses without a primary name yield empty values, which viem maps to `null`. No reverts, so integrators need no error handling.
- Reverse lookups inherit NameNFT's on-chain forward check (a name that no longer resolves back to the queried address is not returned) and answer coin type 60 (ETH) only.
- `findResolver(bytes)` (used by viem's `getEnsResolver`) computes the EIP-137 namehash from the DNS-encoded name and always returns `NameNFT`.
- Gateway parameters are ignored: GNS is fully on-chain, so there is never a CCIP-read round trip.
- Requires the post-2025 universal resolver call shape (viem >= 2.23). ethers v6 walks the ENS registry directly and cannot be pointed at a custom name service; ethers-based integrators should call `NameNFT.resolve` / `reverseResolve` directly instead.

Deployed and verified at [`0xD658131FFB6D732335d37f199374289F1b31564F`](https://etherscan.io/address/0xD658131FFB6D732335d37f199374289F1b31564F) on **Ethereum mainnet and Sepolia** (same address on both, same fresh-deployer/nonce trick as NameNFT; script: `script/DeployGnsUniversalResolver.s.sol`).

---

## Verification Tool

The official dapp includes a "verify name" helper:
- Enter a token ID (from OpenSea URL, etc.)
- See the actual on-chain name and byte representation
- Check ENSIP-15 normalization status
- Compare against an expected name

Useful for secondary market purchases or inspecting unfamiliar names.

---

## Multicall

For efficient batching, use Multicall3:

```javascript
const MULTICALL3 = '0xcA11bde05977b3631167028862bE2a173976CA11';

const results = await multicall.aggregate3([
  { target: GNS, callData: encodeFunctionData('isAvailable', [name, 0]) },
  { target: GNS, callData: encodeFunctionData('getFee', [byteLength]) },
  { target: GNS, callData: encodeFunctionData('getPremium', [tokenId]) }
]);
```

---

## Best Practices for Integrators

1. **Normalize input** with ENSIP-15 before registration (same as ENS)
2. **Use the verification tool** or compute expected token IDs when buying on secondary markets
3. **Display normalization warnings** for names that don't pass ENSIP-15
4. **Link to the official dapp** (`gwei.domains/#name`) for name lookups
5. **Check `isActive` state** before displaying resolver data — expired names return empty from all resolver reads
6. **Handle refund failures** — if your contract calls `reveal` or `renew`, ensure it can receive ETH refunds

---

## Audits

> ⚠️ **These audits were performed on upstream [wei-names](https://github.com/z0r0z/wei-names), not on GNS.** They are kept here because GNS inherits the audited logic (commit-reveal, resolver, subdomain epochs, the SubdomainRegistrar) essentially unchanged. **GNS's own changes — removing `Ownable`/all admin functions, freezing the fee schedule into `constant`s, burning fees instead of collecting them, and the `.wei`→`.gwei` rename — have not been separately audited.** Removing code (the admin surface) generally shrinks attack surface rather than expanding it, but treat the fork as unaudited and review it yourself before relying on it.

AI-assisted audits performed on the upstream codebase:

| Audit | Scope | Findings | Status |
|---|---|---|---|
| [Plainshift AI](audit/plainshift.md) | NameNFT, SubdomainRegistrar | 1 High, 1 Medium | All fixed |
| [Cantina Apex](audit/cantina.md) | NameNFT, Dapp | 3 Medium | All patched |
| [Zellic V12](audit/zellic.md) | NameNFT, SubdomainRegistrar | 1 Medium, 1 Low | Both invalid |

**Plainshift AI** found two valid SubdomainRegistrar issues: subdomain hijacking via missing `isAvailable` check (High), and stale escrow controller enabling NFT theft via epoch mismatch (Medium). Both were fixed in the redeployed SubdomainRegistrar.

**Cantina Apex** found three valid dapp/integration issues: XSS via unescaped name in `innerHTML`, router commit-reveal frontrunning, and refund misdirection through router. All were patched in the dapp and zRouter. NameNFT contract was not affected. (SubdomainRegistrar not included.)

**Zellic V12** reported two findings on SubdomainRegistrar, both self-invalidated: flash mode `transferFrom` does not trigger `onERC721Received` (incorrect premise), and `tx.origin` in constructor is intentional for CREATE2/CREATE3 deployment. (Note: GNS's `NameNFT` has **no constructor at all**, so the `tx.origin` finding is moot here; the `SubdomainRegistrar` takes the NameNFT address as a normal constructor argument.)

---

## Links

- **Dapp:** [gwei.domains](https://gwei.domains) (source: `dapp/gweiNS.html`)
- **JS SDK:** [`gns-utils`](sdk/)
- **Deployment (mainnet):** [NameNFT](https://etherscan.io/address/0x9D51D507BC7264d4fE8Ad1cf7Fe191933A0a81d6) · [SubdomainRegistrar](https://etherscan.io/address/0xc1D5245bfd98dDB7E73B33209B346b4FC0E03f3c) · [Universal Resolver](https://etherscan.io/address/0xD658131FFB6D732335d37f199374289F1b31564F) · [HumanRegistrar](https://etherscan.io/address/0xA4283D56f523d05bBd46e483f7861d6D10Cb330A) · [Integration Voting](https://etherscan.io/address/0xaA2c0f39F0b1a62A8aEB359bCd67874D2D145005)
- **Upstream (wei-names):** https://github.com/z0r0z/wei-names
- **ENSIP-15:** https://docs.ens.domains/ensip/15/
- **ens-normalize:** https://github.com/adraffy/ens-normalize.js
