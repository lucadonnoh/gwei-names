export { createGnsClient } from './client.js'
export type { GnsClient, GnsTx } from './client.js'
export type { RpcConfig } from './rpc.js'
export { MAINNET_RPCS, SEPOLIA_RPCS } from './rpc.js'
export { gnsAbi } from './abi.js'
export {
  GNS_CONTRACT,
  GWEI_NODE,
  BASE_PORTAL,
  ZERO_ADDRESS,
  REGISTRATION_PERIOD,
  GRACE_PERIOD,
  MAX_SUBDOMAIN_DEPTH,
  MIN_COMMITMENT_AGE,
  MAX_COMMITMENT_AGE,
  DEFAULT_FEE,
  getFee,
} from './constants.js'
export { isGwei, isAddress, normalizeName, parseLabel } from './utils.js'
export {
  encodeString,
  encodeAddress,
  encodeUint256,
  encodeBytes32,
  encodeBool,
  encodeBytes,
  encodeUint256String,
  encodeTwoUint256,
  encodeStringUint256,
  encodeStringAddressBytes32,
  encodeStringBytes32,
  encodeUint256Address,
  encodeUint256StringString,
  encodeUint256Bytes,
  decodeAddress,
  decodeUint256,
  decodeBool,
  decodeBytes,
  decodeString,
} from './encoding.js'
