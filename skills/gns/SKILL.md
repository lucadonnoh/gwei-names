---
name: gns
description: Use when resolving, registering, or integrating .gwei names, the Gwei Name Service, an ENS-compatible ERC-721 naming system on Ethereum mainnet. Covers namehash to tokenId, address/contenthash/text resolution, reverse resolution, commit-reveal registration, subnames, websites through the gwei.limo gateway, and blogs stored in blobs. Applies to both onchain integration (Solidity, cast) and offchain (viem, gns-utils, plain HTTPS).
---

# GNS: Gwei Name Service (.gwei)

`.gwei` names are an ENS-compatible naming system on **Ethereum mainnet**, ownerless and non-upgradeable. If you can resolve ENS, you can resolve GNS: same namehash algorithm, same resolver selectors. You just point at a different contract.

## What You Probably Got Wrong

- **GNS is not ENS, but it is ENS-compatible.** Same namehash (EIP-137), same resolver interfaces (`addr`, `text`, `contenthash`). Modern ENS tooling goes through a universal resolver, so use the GNS one (below).
- **It is ONE contract.** `NameNFT` is the ERC-721 (ownership), the registrar (commit-reveal) and the resolver (addr/text/contenthash) at once. There is no registry, registrar and resolver split.
- **Token ID = `uint256(namehash(name))`.** The NFT tokenId is the ENS namehash. No separate node/id mapping.
- **You need no wallet or library to open a website.** `https://<name>.gwei.limo` serves a name's website over plain HTTPS. Just fetch the URL.
- **Names expire.** 365-day registration plus 90-day grace. During grace and after, resolver reads return empty, and `resolve()` returns the zero address. Don't cache resolutions forever.
- **A transfer keeps the records.** A name's address and text records stay as the last owner left them. See Gotchas before paying a name.
- **Fees depend on label length.** Don't assume a flat fee: read `getFee(labelByteLength)`.

## Contracts (Ethereum mainnet)

| | |
|---|---|
| `NameNFT` | `0x9D51D507BC7264d4fE8Ad1cf7Fe191933A0a81d6` |
| `GnsUniversalResolver` | `0xD658131FFB6D732335d37f199374289F1b31564F` |
| `SubdomainRegistrar` (subname sales) | `0xc1D5245bfd98dDB7E73B33209B346b4FC0E03f3c` |
| `HumanRegistrar` (free names, zkPassport) | `0xA4283D56f523d05bBd46e483f7861d6D10Cb330A` |
| `GnsPosts` (blogs in blobs) | `0x73849f6f2785BA7fd2f41b5B4573B75554417981` |
| `GWEI_NODE` = `namehash("gwei")` | `0xcca9c7f2dbe2808af0de2982fc84314bfa68a82a6a60ad5cd757f91a233d7d7f` |

`namehash("alice.gwei") = keccak256(GWEI_NODE ++ keccak256("alice"))`, and `tokenId = uint256(namehash)`. The contract computes it for you with `computeId`, so you never have to implement namehash yourself.

## Resolve a name (read-only, no wallet)

Every resolver read takes the `uint256` tokenId. Get it with `computeId(fullName)`, which accepts `"alice.gwei"` or `"alice"` and subnames like `"sub.alice.gwei"`.

```bash
GNS=0x9D51D507BC7264d4fE8Ad1cf7Fe191933A0a81d6

# name -> tokenId (this is the namehash)
TID=$(cast call $GNS "computeId(string)(uint256)" "alice.gwei" --rpc-url $RPC | awk '{print $1}')

cast call $GNS "resolve(uint256)(address)"    $TID --rpc-url $RPC        # ETH address
cast call $GNS "contenthash(uint256)(bytes)"  $TID --rpc-url $RPC        # IPFS/IPNS/Swarm
cast call $GNS "text(uint256,string)(string)" $TID "url" --rpc-url $RPC
cast call $GNS "addr(uint256,uint256)(bytes)" $TID 60 --rpc-url $RPC     # SLIP-44 coin (60 = ETH)
```

`resolve()` falls back to `ownerOf` when no explicit address is set, so a freshly registered name resolves to its owner.

**Never send to an unresolved name.** For an unregistered, expired or stale name, `resolve()` returns `0x0000000000000000000000000000000000000000` with no revert, and `addr(…, 60)` returns `0x`. Treat both as "doesn't resolve": ETH sent to the zero address is gone.

ENS-style `bytes32 node` overloads also exist, so a resolver client works once pointed at this contract:

```solidity
function addr(bytes32 node) view returns (address)
function addr(bytes32 node, uint256 coinType) view returns (bytes)
function text(bytes32 node, string key) view returns (string)
function contenthash(bytes32 node) view returns (bytes)
```

`supportsInterface` advertises `addr(bytes32)` `0x3b3b57de`, `addr(bytes32,uint256)` `0xf1cb7e06`, `text` `0x59d1d43c`, `contenthash` `0xbc1c58d1`, plus ERC-721 and ERC-165.

### With viem

Pass the GNS universal resolver to viem's ENS actions (viem >= 2.23):

```ts
import { normalize } from 'viem/ens'

const universalResolverAddress = '0xD658131FFB6D732335d37f199374289F1b31564F'
const address = await client.getEnsAddress({ name: normalize('alice.gwei'), universalResolverAddress })
const name = await client.getEnsName({ address, universalResolverAddress })
const avatar = await client.getEnsAvatar({ name: normalize('alice.gwei'), universalResolverAddress })
```

Unregistered and expired names give `null`, with no revert. ethers v6 can't be pointed at a custom name service: with ethers, call `NameNFT.resolve` and `reverseResolve` directly.

### With gns-utils

```ts
import { createGnsClient } from '@donnoh/gns-utils'

const gns = createGnsClient()
await gns.resolve('alice.gwei')       // '0x...' or null
await gns.reverseResolve('0xUser')    // 'alice.gwei' or null
```

### Reverse resolution (address to name)

```bash
cast call $GNS "reverseResolve(address)(string)" 0xUser --rpc-url $RPC
```

Returns the address's **primary name**, or `""` if it is unset, inactive, or no longer resolves to that address. Set it with `setPrimaryName(tokenId)` (callable by the owner or the address the token resolves to). `setPrimaryName(0)` clears it.

## Serve a website

Set a contenthash on the name and the gateway serves it, with no per-name DNS and no config:

```
https://alice.gwei.limo      ->  the website of alice.gwei
https://alice.gwei.domains   ->  same site, longer domain
```

- **IPFS, IPNS and Swarm** contenthashes all work. With **IPNS** the owner updates the site with no new transaction.
- **A site can live in a contract:** with no contenthash, the `contentcontract` text record (for example `eth:0x…`) is served over web3:// (ERC-6860). A contenthash wins over it.
- **A name with no website** gets a generated profile page at the same address.
- **Subnames have no host of their own:** the certificates cover one level, so `sub.alice.gwei.limo` doesn't load. Their pages are at `https://posts.gwei.limo/sub.alice.gwei/`.

## Blogs

Any name or subname can publish posts, whose text travels in EIP-4844 blobs (spec: `posts/SPEC.md`).

- A top-level name with no website shows them at `https://alice.gwei.limo/`.
- Every name, including subnames and names with a website, has them at `https://posts.gwei.limo/alice.gwei/`, with an Atom feed at `/feed.xml` under the same path. Recent posts on all names are at `https://posts.gwei.limo/`.
- The index is readable by anyone: `GET https://gwei.domains/api/posts/recent` and `GET https://gwei.domains/api/names/<tokenId as 0x + 64 hex>/posts`.

## Give an agent an identity

A `.gwei` name is a portable, human-readable identity for an autonomous agent, and complements **ERC-8004** (onchain agent identity, which is tokenId-based). One name gives an agent:

- **Name and address:** `setAddr` and `resolve()` let others pay or verify `agent.gwei` instead of a raw `0x…`. `setPrimaryName` makes wallets show `agent.gwei` for its address.
- **Endpoints and metadata:** `setText(tokenId, key, value)` for `url`, `description`, `com.twitter`, or custom keys (A2A or MCP endpoint, agent-card URI).
- **A hosted agent card or site:** `setContenthash`, served at `https://agent.gwei.limo` with no infrastructure.
- **Fleets:** one parent mints free subnames (`worker1.fleet.gwei`, `worker2.fleet.gwei`), each with its own address and records, up to 10 levels deep.

## Register a name (commit-reveal)

Front-running protection takes two transactions with a wait between them.

```bash
SECRET=0x<32-random-bytes>

# 1) commit (hides the label). makeCommitment is a pure helper.
COMMIT=$(cast call $GNS "makeCommitment(string,address,bytes32)(bytes32)" "alice" $ME $SECRET --rpc-url $RPC)
cast send $GNS "commit(bytes32)" $COMMIT --rpc-url $RPC --private-key $PK

# 2) wait at least 60s, and reveal within 24h
FEE=$(cast call $GNS "getFee(uint256)(uint256)" 5 --rpc-url $RPC | awk '{print $1}')   # 5 = byte length of "alice"
cast send $GNS "reveal(string,bytes32)" "alice" $SECRET --value $FEE --rpc-url $RPC --private-key $PK
```

| Label length (bytes) | Fee per year |
|---|---|
| 1 | 0.5 ETH |
| 2 | 0.1 ETH |
| 3 | 0.05 ETH |
| 4 | 0.01 ETH |
| 5 or more | 0.0005 ETH |

- **Excess ETH is refunded**, so the caller must be able to receive ETH.
- **The caller must accept ERC-721.** `reveal` uses `_safeMint`. A contract without `onERC721Received`, including a smart account or a 7702-delegated EOA whose code lacks it, reverts (`0xd1a57ed6`) and loses the gas spent.
- **Premium:** a name that just came out of grace costs extra, starting at 100 ETH and decaying to zero over 21 days. Read `getPremium(tokenId)`.
- **Timing:** reveal no sooner than 60s and no later than 24h after commit.
- **Renewal:** `renew(tokenId)` (payable) adds 365 days to the current expiry, any time before grace ends. Anyone can renew any name. For several years or names in one transaction, batch `renew` calls through Multicall3 `aggregate3Value`, with the exact fee on each call and `allowFailure: false`.
- **Availability:** `isAvailable(label, parentId)`, with `parentId = 0` for a top-level name.

## Subnames

The owner of `alice.gwei` creates children for free, with no commit-reveal and no fee:

```bash
PID=$(cast call $GNS "computeId(string)(uint256)" "alice.gwei" --rpc-url $RPC | awk '{print $1}')
cast send $GNS "registerSubdomain(string,uint256)" "sub" $PID --rpc-url $RPC --private-key $PK
# or registerSubdomainFor(label, parentId, to) to mint to someone else
```

- Depth up to **10** levels. Each subname is its own ERC-721 token with its own records.
- Subnames have no expiry of their own but go **stale** if the parent expires or is registered again (an epoch bump). Stale subnames resolve empty.
- The parent owner can always reclaim a subname label, which burns the old token and clears its holder's primary name.

## Resolver writes (token owner only)

```solidity
setAddr(uint256 tokenId, address addr)                        // ETH address
setContenthash(uint256 tokenId, bytes hash)                   // IPFS/IPNS/Swarm
setAddrForCoin(uint256 tokenId, uint256 coinType, bytes addr) // any SLIP-44 coin
setText(uint256 tokenId, string key, string value)            // text records
setPrimaryName(uint256 tokenId)                               // reverse record (owner or resolved address)
```

## Gotchas

- **Grace returns empty.** Between `expiresAt` and `expiresAt + 90d` a name is inactive: resolver reads return empty, resolver writes revert, transfers are blocked. Renewal still works.
- **`ownerOf` doesn't know about expiry.** A name long past grace still names its last owner. Use `resolve()` to tell whether a name is live. `expiresAt(tokenId)` works for top-level names only: it is always 0 for a subname.
- **A sold name keeps pointing where the seller set it.** A transfer clears no records, so `resolve()` and `addr(…, 60)` can both name the seller. They are also separate records: `setAddr` writes the one `resolve()` reads, `setAddrForCoin(…, 60, …)` writes the one `addr(…, 60)` prefers, and neither clears the other, so they can disagree. A new owner should set both, and a payer should resolve at payment time with the same call the recipient set.
- **Registering again wipes records.** After a name fully expires and is registered again, a `recordVersion` bump clears its resolver data.
- **Normalization is the caller's job for Unicode.** Onchain `normalize(label)` only lowercases ASCII. Normalize emoji and Unicode labels with **ENSIP-15** offchain before hashing or registering. `isAsciiLabel(label)` tells you if the onchain path is enough. Labels are 1 to 255 bytes.
- **Don't hallucinate the address.** Verify `0x9D51D507BC7264d4fE8Ad1cf7Fe191933A0a81d6` on a block explorer before sending value.

## Libraries and links

- **`@donnoh/gns-utils`** (npm): resolve, reverse-resolve, tokenIds, zero runtime dependencies.
- **`@1001-digital/ethereum-names`** (npm): one resolver for GNS, ENS and WNS.
- **App and registration:** https://gwei.domains
- **Source:** https://github.com/lucadonnoh/gwei-names
