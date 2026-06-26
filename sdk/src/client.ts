import { GNS_CONTRACT } from './constants.js'
import {
  decodeAddress,
  decodeBool,
  decodeBytes,
  decodeString,
  decodeUint256,
  encodeAddress,
  encodeBytes32,
  encodeString,
  encodeStringAddressBytes32,
  encodeStringBytes32,
  encodeStringUint256,
  encodeTwoUint256,
  encodeUint256,
  encodeUint256Address,
  encodeUint256Bytes,
  encodeUint256String,
  encodeUint256StringString,
} from './encoding.js'
import { type RpcConfig, ethCall } from './rpc.js'
import { isAddress, isGwei, normalizeName } from './utils.js'

// Function selectors — read
const COMPUTE_ID = '0xfb021939'
const RESOLVE = '0x4f896d4f'
const REVERSE_RESOLVE = '0x9af8b7aa'
const IS_AVAILABLE = '0x8f8dc386'
const IS_EXPIRED = '0xd9548e53'
const IN_GRACE_PERIOD = '0x85a8df9e'
const EXPIRES_AT = '0x17c95709'
const GET_FULL_NAME = '0x465411c1'
const OWNER_OF = '0x6352211e'
const BALANCE_OF = '0x70a08231'
const TEXT = '0x308e3386'
const CONTENTHASH = '0xcb323d76'
const ADDR_COIN = '0x724474cd'
const GET_FEE = '0xfcee45f4'
const GET_PREMIUM = '0x1bf1fffb'
const TOKEN_URI = '0xc87b56dd'

// Function selectors — write
const MAKE_COMMITMENT = '0xf49826be'
const COMMIT = '0xf14fcbc8'
const REVEAL = '0xea9384fa'
const RENEW = '0x5baa7509'
const SET_PRIMARY_NAME = '0xa4f69657'
const SET_ADDR = '0xeba36dbd'
const SET_TEXT = '0x3fb24782'
const SET_CONTENTHASH = '0x88f97a67'
const REGISTER_SUBDOMAIN = '0x8f449b85'

export interface GnsTx {
  to: string
  data: string
  value?: bigint
}

export interface GnsClient {
  // --- Existing methods ---

  /**
   * Resolve a .gwei name to an Ethereum address.
   * Accepts "name" or "name.gwei".
   */
  resolve(name: string): Promise<`0x${string}` | null>

  /**
   * Reverse resolve an Ethereum address to its primary .gwei name.
   */
  reverseResolve(address: string): Promise<string | null>

  /**
   * Smart resolve: if input is an address, return it directly.
   * If it's a .gwei name (or bare label), resolve it.
   */
  resolveAny(input: string): Promise<`0x${string}` | null>

  // --- Read methods (Phase 1) ---

  /** Check if a label is available for registration under a parent. */
  isAvailable(label: string, parentId?: bigint): Promise<boolean>

  /** Check if a name is expired. */
  isExpired(name: string): Promise<boolean>

  /** Check if a name is in its grace period. */
  inGracePeriod(name: string): Promise<boolean>

  /** Get the expiration timestamp for a name. */
  expiresAt(name: string): Promise<bigint>

  /** Get the full name string for a token ID. */
  getFullName(tokenId: bigint): Promise<string | null>

  /** Get the owner address of a name. */
  ownerOf(name: string): Promise<`0x${string}` | null>

  /** Get the number of names owned by an address. */
  balanceOf(address: string): Promise<bigint>

  /** Get a text record for a name. */
  getText(name: string, key: string): Promise<string | null>

  /** Get the contenthash for a name. */
  getContenthash(name: string): Promise<string | null>

  /** Get a multi-coin address for a name. */
  getAddr(name: string, coinType: bigint): Promise<string | null>

  /** Get the registration fee for a label length. */
  getFee(length: bigint): Promise<bigint>

  /** Get the premium for a name. */
  getPremium(name: string): Promise<bigint>

  /** Get the token URI for a name. */
  tokenURI(name: string): Promise<string | null>

  /** Compute the token ID for a name (on-chain). */
  computeId(name: string): Promise<bigint>

  // --- Transaction encoders (Phase 2) ---

  /** Compute a commitment hash (read call). */
  makeCommitment(label: string, owner: string, secret: string): Promise<string>

  /** Encode a commit transaction. */
  encodeCommit(commitment: string): GnsTx

  /** Encode a reveal (register) transaction. */
  encodeReveal(label: string, secret: string, value: bigint): GnsTx

  /** Encode a renew transaction. */
  encodeRenew(name: string, value: bigint): Promise<GnsTx>

  /** Encode a setPrimaryName transaction. */
  encodeSetPrimaryName(name: string): Promise<GnsTx>

  /** Encode a setAddr transaction. */
  encodeSetAddr(name: string, addr: string): Promise<GnsTx>

  /** Encode a setText transaction. */
  encodeSetText(name: string, key: string, value: string): Promise<GnsTx>

  /** Encode a setContenthash transaction. */
  encodeSetContenthash(name: string, hash: string): Promise<GnsTx>

  /** Encode a registerSubdomain transaction. */
  encodeRegisterSubdomain(label: string, parentName: string): Promise<GnsTx>
}

/**
 * Create a GNS client.
 *
 * @example
 * ```ts
 * import { createGnsClient } from 'gns-utils'
 *
 * const gns = createGnsClient()
 * const addr = await gns.resolve('name.gwei')
 * const name = await gns.reverseResolve('0x...')
 * ```
 *
 * @example
 * ```ts
 * // With custom RPC
 * const gns = createGnsClient({ rpc: 'https://my-rpc.com' })
 * ```
 */
export function createGnsClient(config?: RpcConfig): GnsClient {
  const contract = config?.contract ?? GNS_CONTRACT

  async function getTokenId(name: string): Promise<bigint> {
    const fullName = normalizeName(name)
    const calldata = COMPUTE_ID + encodeString(fullName)
    const result = await ethCall(calldata, config)
    return decodeUint256(result)
  }

  return {
    // --- Existing methods ---

    async resolve(name) {
      if (!name) return null
      try {
        const tokenId = await getTokenId(name)
        if (tokenId === 0n) return null

        const resolveData = RESOLVE + encodeUint256(tokenId)
        const addrResult = await ethCall(resolveData, config)
        return decodeAddress(addrResult)
      } catch {
        return null
      }
    },

    async reverseResolve(address) {
      if (!isAddress(address)) return null
      try {
        const calldata = REVERSE_RESOLVE + encodeAddress(address)
        const result = await ethCall(calldata, config)
        return decodeString(result) || null
      } catch {
        return null
      }
    },

    async resolveAny(input) {
      if (!input) return null
      if (isAddress(input)) return input as `0x${string}`
      if (isGwei(input) || !input.includes('.')) {
        return this.resolve(input)
      }
      return null
    },

    // --- Read methods ---

    async isAvailable(label, parentId = 0n) {
      try {
        const calldata = IS_AVAILABLE + encodeStringUint256(label, parentId)
        const result = await ethCall(calldata, config)
        return decodeBool(result)
      } catch {
        return false
      }
    },

    async isExpired(name) {
      try {
        const tokenId = await getTokenId(name)
        const calldata = IS_EXPIRED + encodeUint256(tokenId)
        const result = await ethCall(calldata, config)
        return decodeBool(result)
      } catch {
        return false
      }
    },

    async inGracePeriod(name) {
      try {
        const tokenId = await getTokenId(name)
        const calldata = IN_GRACE_PERIOD + encodeUint256(tokenId)
        const result = await ethCall(calldata, config)
        return decodeBool(result)
      } catch {
        return false
      }
    },

    async expiresAt(name) {
      try {
        const tokenId = await getTokenId(name)
        const calldata = EXPIRES_AT + encodeUint256(tokenId)
        const result = await ethCall(calldata, config)
        return decodeUint256(result)
      } catch {
        return 0n
      }
    },

    async getFullName(tokenId) {
      try {
        const calldata = GET_FULL_NAME + encodeUint256(tokenId)
        const result = await ethCall(calldata, config)
        return decodeString(result)
      } catch {
        return null
      }
    },

    async ownerOf(name) {
      try {
        const tokenId = await getTokenId(name)
        const calldata = OWNER_OF + encodeUint256(tokenId)
        const result = await ethCall(calldata, config)
        return decodeAddress(result)
      } catch {
        return null
      }
    },

    async balanceOf(address) {
      if (!isAddress(address)) return 0n
      try {
        const calldata = BALANCE_OF + encodeAddress(address)
        const result = await ethCall(calldata, config)
        return decodeUint256(result)
      } catch {
        return 0n
      }
    },

    async getText(name, key) {
      try {
        const tokenId = await getTokenId(name)
        const calldata = TEXT + encodeUint256String(tokenId, key)
        const result = await ethCall(calldata, config)
        return decodeString(result)
      } catch {
        return null
      }
    },

    async getContenthash(name) {
      try {
        const tokenId = await getTokenId(name)
        const calldata = CONTENTHASH + encodeUint256(tokenId)
        const result = await ethCall(calldata, config)
        return decodeBytes(result)
      } catch {
        return null
      }
    },

    async getAddr(name, coinType) {
      try {
        const tokenId = await getTokenId(name)
        const calldata = ADDR_COIN + encodeTwoUint256(tokenId, coinType)
        const result = await ethCall(calldata, config)
        return decodeBytes(result)
      } catch {
        return null
      }
    },

    async getFee(length) {
      try {
        const calldata = GET_FEE + encodeUint256(length)
        const result = await ethCall(calldata, config)
        return decodeUint256(result)
      } catch {
        return 0n
      }
    },

    async getPremium(name) {
      try {
        const tokenId = await getTokenId(name)
        const calldata = GET_PREMIUM + encodeUint256(tokenId)
        const result = await ethCall(calldata, config)
        return decodeUint256(result)
      } catch {
        return 0n
      }
    },

    async tokenURI(name) {
      try {
        const tokenId = await getTokenId(name)
        const calldata = TOKEN_URI + encodeUint256(tokenId)
        const result = await ethCall(calldata, config)
        return decodeString(result)
      } catch {
        return null
      }
    },

    async computeId(name) {
      try {
        return await getTokenId(name)
      } catch {
        return 0n
      }
    },

    // --- Transaction encoders ---

    async makeCommitment(label, owner, secret) {
      const calldata = MAKE_COMMITMENT + encodeStringAddressBytes32(label, owner, secret)
      const result = await ethCall(calldata, config)
      return result
    },

    encodeCommit(commitment) {
      return {
        to: contract,
        data: COMMIT + encodeBytes32(commitment),
      }
    },

    encodeReveal(label, secret, value) {
      return {
        to: contract,
        data: REVEAL + encodeStringBytes32(label, secret),
        value,
      }
    },

    async encodeRenew(name, value) {
      const tokenId = await getTokenId(name)
      return {
        to: contract,
        data: RENEW + encodeUint256(tokenId),
        value,
      }
    },

    async encodeSetPrimaryName(name) {
      const tokenId = await getTokenId(name)
      return {
        to: contract,
        data: SET_PRIMARY_NAME + encodeUint256(tokenId),
      }
    },

    async encodeSetAddr(name, addr) {
      const tokenId = await getTokenId(name)
      return {
        to: contract,
        data: SET_ADDR + encodeUint256Address(tokenId, addr),
      }
    },

    async encodeSetText(name, key, value) {
      const tokenId = await getTokenId(name)
      return {
        to: contract,
        data: SET_TEXT + encodeUint256StringString(tokenId, key, value),
      }
    },

    async encodeSetContenthash(name, hash) {
      const tokenId = await getTokenId(name)
      return {
        to: contract,
        data: SET_CONTENTHASH + encodeUint256Bytes(tokenId, hash),
      }
    },

    async encodeRegisterSubdomain(label, parentName) {
      const parentId = await getTokenId(parentName)
      return {
        to: contract,
        data: REGISTER_SUBDOMAIN + encodeStringUint256(label, parentId),
      }
    },
  }
}
