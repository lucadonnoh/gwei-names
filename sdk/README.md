# gns-utils

Utilities for the [Gwei Name Service](https://gwei.domains) (GNS). Resolve `.gwei` names to Ethereum addresses, reverse resolve addresses to names, and more.

Zero runtime dependencies. Works in Node.js, browsers, and edge runtimes.

> Gwei Name Service is currently deployed on **Sepolia** only. Pass a custom `contract` + `rpc` via config to target other networks.

## Install

```bash
npm install gns-utils
```

## Usage

```ts
import { createGnsClient } from 'gns-utils'

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

By default, the client uses free public Sepolia RPC endpoints with automatic fallback. You can provide your own:

```ts
// Single RPC
const gns = createGnsClient({ rpc: 'https://my-paid-rpc.com' })

// Multiple RPCs — tries in order, falls back on failure
const gns = createGnsClient({
  rpc: ['https://primary-rpc.com', 'https://fallback-rpc.com']
})
```

## Helpers

Standalone utility functions that don't make any RPC calls:

```ts
import { isGwei, isAddress, normalizeName, parseLabel } from 'gns-utils'

isGwei('alice.gwei')       // true
isGwei('alice.eth')        // false

isAddress('0xd8dA...')     // true

normalizeName('Alice')     // 'alice.gwei'
normalizeName('ALICE.GWEI') // 'alice.gwei'

parseLabel('alice.gwei')   // 'alice'
```

## Constants

```ts
import { GNS_CONTRACT, BASE_PORTAL, gnsAbi } from 'gns-utils'

GNS_CONTRACT // '0x9D51D507BC7264d4fE8Ad1cf7Fe191933A0a81d6' (Sepolia)
BASE_PORTAL  // '0x49048044D57e1C92A77f79988d21Fa8fAF74E97e'
```

The full contract ABI is exported as `gnsAbi` for use with viem, ethers, wagmi, or any other web3 library:

```ts
import { gnsAbi, GNS_CONTRACT } from 'gns-utils'
import { createPublicClient, http } from 'viem'
import { sepolia } from 'viem/chains'

const client = createPublicClient({ chain: sepolia, transport: http() })

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
| `rpc` | `string \| string[]` | Custom RPC endpoint(s). Defaults to free public Sepolia endpoints with fallback. |
| `contract` | `` `0x${string}` `` | Override the GNS contract address. Defaults to `GNS_CONTRACT`. |

Returns a `GnsClient` with the following methods:

| Method | Returns | Description |
|--------|---------|-------------|
| `resolve(name)` | `Promise<\`0x${string}\` \| null>` | Resolve a `.gwei` name to an address. |
| `reverseResolve(address)` | `Promise<string \| null>` | Reverse resolve an address to its primary `.gwei` name. |
| `resolveAny(input)` | `Promise<\`0x${string}\` \| null>` | Smart resolve — addresses pass through, `.gwei` names get resolved. |

## License

MIT
