# gns-utils

Utilities for the [Gwei Name Service](https://gwei.domains) (GNS). Resolve `.gwei` names to Ethereum addresses, reverse resolve addresses to names, and more.

Zero runtime dependencies. Works in Node.js, browsers, and edge runtimes.

> Gwei Name Service is live on **Ethereum mainnet** (and Sepolia, at the same address). The client defaults to mainnet; pass `rpc: SEPOLIA_RPCS` — or any endpoint — via config to target Sepolia.

## Install

```bash
npm install @donnoh/gns-utils
```

## Usage

```ts
import { createGnsClient } from '@donnoh/gns-utils'

const gns = createGnsClient()

// Resolve a .gwei name to an address
const addr = await gns.resolve('name.gwei')
// => '0x...' or null

// Reverse resolve an address to its primary .gwei name
const name = await gns.reverseResolve('0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045')
// => 'name.gwei' or null

// Smart resolve — passes addresses through, resolves .gwei names
const result = await gns.resolveAny('name.gwei')
const same = await gns.resolveAny('0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045')
```

The `.gwei` suffix is optional — `gns.resolve('name')` and `gns.resolve('name.gwei')` are equivalent.

## Custom RPC

By default, the client uses free public **mainnet** RPC endpoints with automatic fallback. Provide your own, or switch networks with the exported presets:

```ts
// Single RPC
const gns = createGnsClient({ rpc: 'https://my-paid-rpc.com' })

// Multiple RPCs — tries in order, falls back on failure
const gns = createGnsClient({
  rpc: ['https://primary-rpc.com', 'https://fallback-rpc.com']
})

// Target Sepolia instead of mainnet (same contract address)
import { SEPOLIA_RPCS } from '@donnoh/gns-utils'
const sepoliaGns = createGnsClient({ rpc: SEPOLIA_RPCS })
```

## Helpers

Standalone utility functions that don't make any RPC calls:

```ts
import { isGwei, isAddress, normalizeName, parseLabel } from '@donnoh/gns-utils'

isGwei('alice.gwei')       // true
isGwei('alice.eth')        // false

isAddress('0xd8dA...')     // true

normalizeName('Alice')     // 'alice.gwei'
normalizeName('ALICE.GWEI') // 'alice.gwei'

parseLabel('alice.gwei')   // 'alice'
```

## Contract-hosted websites (web3://)

A name can host its website in a smart contract rather than on IPFS or Swarm. That pointer isn't a
contenthash — there's no multicodec for EVM contracts — so [ERC-6821][6821] stores it in the
`contentcontract` text record as an [ERC-3770][3770] chain-specific address.

```ts
import { createGnsClient, parseWeb3Url, formatWeb3Url } from '@donnoh/gns-utils'

const gns = createGnsClient()

// Read: null when the name has no contract-hosted site.
const pointer = await gns.getContentContract('ethereumrock.gwei')
// { chainId: 1, address: '0x6485b8b75a8ad382340abe333e1f6ee10e39f818' }
formatWeb3Url(pointer) // 'web3://0x6485b8b7…:1/'

// Write: takes a web3:// URL or a pointer. Mainnet and Sepolia are supported.
const tx = await gns.encodeSetContentContract('mysite.gwei', 'web3://0x6485B8B7…:1/')
const clear = await gns.encodeClearContentContract('mysite.gwei')
```

`parseWeb3Url` returns `null` for input that isn't a `web3://` URL (so it composes with CID
handling) and throws a readable error for a `web3://` URL that can't be stored — an unsupported
chain, a malformed address, or a non-empty path, since the record holds only a chain and an address.

A non-empty `contenthash` takes precedence at the gwei.domains gateway, so a name that already has
one must clear it before its contract-hosted site is served.

[6821]: https://eips.ethereum.org/EIPS/eip-6821
[3770]: https://eips.ethereum.org/EIPS/eip-3770

## Constants

```ts
import { GNS_CONTRACT, GWEI_NODE, MAX_SUBDOMAIN_DEPTH } from '@donnoh/gns-utils'

GNS_CONTRACT // '0x9D51D507BC7264d4fE8Ad1cf7Fe191933A0a81d6' (same on mainnet + Sepolia)
GWEI_NODE // '0xcca9c7f2dbe2808af0de2982fc84314bfa68a82a6a60ad5cd757f91a233d7d7f'
MAX_SUBDOMAIN_DEPTH // 10
```

The full contract ABI is exported as `gnsAbi` for use with viem, ethers, wagmi, or any other web3 library. It is generated from [`src/NameNFT.sol`](../src/NameNFT.sol); contributors can refresh it with `pnpm abi:generate`, and `pnpm check` rejects drift.

```ts
import { gnsAbi, GNS_CONTRACT } from '@donnoh/gns-utils'
import { createPublicClient, http } from 'viem'
import { mainnet } from 'viem/chains'

const client = createPublicClient({ chain: mainnet, transport: http() })

const owner = await client.readContract({
  address: GNS_CONTRACT,
  abi: gnsAbi,
  functionName: 'ownerOf',
  args: [tokenId],
})
```

## API

### `createGnsClient(config?)`

Creates a GNS client instance.

| Option | Type | Description |
|--------|------|-------------|
| `rpc` | `string \| string[]` | Custom RPC endpoint(s). Defaults to free public mainnet endpoints with fallback; `SEPOLIA_RPCS` / `MAINNET_RPCS` presets are exported. |
| `contract` | `` `0x${string}` `` | Override the GNS contract address. Defaults to `GNS_CONTRACT`. |

Returns a `GnsClient` with the following methods:

| Method | Returns | Description |
|--------|---------|-------------|
| `resolve(name)` | `Promise<\`0x${string}\` \| null>` | Resolve a `.gwei` name to an address. |
| `reverseResolve(address)` | `Promise<string \| null>` | Reverse resolve an address to its primary `.gwei` name. |
| `resolveAny(input)` | `Promise<\`0x${string}\` \| null>` | Smart resolve — addresses pass through, `.gwei` names get resolved. |

## License

MIT
