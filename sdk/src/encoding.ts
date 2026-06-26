// Minimal ABI encoding helpers — no dependencies needed.

/**
 * ABI-encode a string argument (offset + length + padded data).
 */
export function encodeString(value: string): string {
  const bytes = new TextEncoder().encode(value)
  const len = bytes.length
  const paddedLen = 32 * Math.ceil(len / 32)
  const buf = new Uint8Array(64 + paddedLen)

  // offset: 0x20 (32)
  buf[31] = 32
  // length
  buf[63] = len
  // data
  buf.set(bytes, 64)

  return bytesToHex(buf)
}

/**
 * ABI-encode an address argument (left-padded to 32 bytes).
 */
export function encodeAddress(address: string): string {
  return address.toLowerCase().replace('0x', '').padStart(64, '0')
}

/**
 * ABI-encode a uint256 argument.
 */
export function encodeUint256(value: bigint): string {
  return value.toString(16).padStart(64, '0')
}

/**
 * ABI-encode a bytes32 argument (right-padded to 32 bytes).
 */
export function encodeBytes32(value: string): string {
  return value.replace('0x', '').padEnd(64, '0').slice(0, 64)
}

/**
 * ABI-encode a bool argument.
 */
export function encodeBool(value: boolean): string {
  return (value ? '1' : '0').padStart(64, '0')
}

/**
 * ABI-encode a dynamic bytes argument as a tail-encoded value.
 * Returns offset + length + padded data (like encodeString but from hex).
 */
export function encodeBytes(value: string): string {
  const hex = value.replace('0x', '')
  const len = hex.length / 2
  const paddedLen = 32 * Math.ceil(len / 32)
  // offset (0x20) + length + padded data
  const offset = encodeUint256(32n)
  const length = encodeUint256(BigInt(len))
  const data = hex.padEnd(paddedLen * 2, '0')
  return offset + length + data
}

/**
 * Encode a (uint256, string) tuple for functions like text(uint256, string).
 */
export function encodeUint256String(id: bigint, str: string): string {
  const bytes = new TextEncoder().encode(str)
  const len = bytes.length
  const paddedLen = 32 * Math.ceil(len / 32)

  // word 0: uint256 value
  // word 1: offset to string data = 0x40 (64 bytes from start of args)
  // word 2: string length
  // word 3+: string data
  const idHex = encodeUint256(id)
  const offsetHex = encodeUint256(64n)
  const lenHex = encodeUint256(BigInt(len))
  const dataHex = bytesToHex(paddedBytes(bytes, paddedLen))

  return idHex + offsetHex + lenHex + dataHex
}

/**
 * Encode a (uint256, uint256) tuple for functions like addr(uint256, uint256).
 */
export function encodeTwoUint256(a: bigint, b: bigint): string {
  return encodeUint256(a) + encodeUint256(b)
}

/**
 * Encode a (string, uint256) tuple for functions like isAvailable(string, uint256).
 */
export function encodeStringUint256(str: string, id: bigint): string {
  const bytes = new TextEncoder().encode(str)
  const len = bytes.length
  const paddedLen = 32 * Math.ceil(len / 32)

  // word 0: offset to string data = 0x40 (64 bytes)
  // word 1: uint256 value
  // word 2: string length
  // word 3+: string data
  const offsetHex = encodeUint256(64n)
  const idHex = encodeUint256(id)
  const lenHex = encodeUint256(BigInt(len))
  const dataHex = bytesToHex(paddedBytes(bytes, paddedLen))

  return offsetHex + idHex + lenHex + dataHex
}

/**
 * Encode a (string, address, bytes32) tuple for makeCommitment(string, address, bytes32).
 */
export function encodeStringAddressBytes32(str: string, addr: string, b32: string): string {
  const bytes = new TextEncoder().encode(str)
  const len = bytes.length
  const paddedLen = 32 * Math.ceil(len / 32)

  // word 0: offset to string data = 0x60 (96 bytes — 3 head slots)
  // word 1: address
  // word 2: bytes32
  // word 3: string length
  // word 4+: string data
  const offsetHex = encodeUint256(96n)
  const addrHex = encodeAddress(addr)
  const b32Hex = encodeBytes32(b32)
  const lenHex = encodeUint256(BigInt(len))
  const dataHex = bytesToHex(paddedBytes(bytes, paddedLen))

  return offsetHex + addrHex + b32Hex + lenHex + dataHex
}

/**
 * Encode a (string, bytes32) tuple for reveal(string, bytes32).
 */
export function encodeStringBytes32(str: string, b32: string): string {
  const bytes = new TextEncoder().encode(str)
  const len = bytes.length
  const paddedLen = 32 * Math.ceil(len / 32)

  // word 0: offset to string data = 0x40 (64 bytes — 2 head slots)
  // word 1: bytes32
  // word 2: string length
  // word 3+: string data
  const offsetHex = encodeUint256(64n)
  const b32Hex = encodeBytes32(b32)
  const lenHex = encodeUint256(BigInt(len))
  const dataHex = bytesToHex(paddedBytes(bytes, paddedLen))

  return offsetHex + b32Hex + lenHex + dataHex
}

/**
 * Encode a (uint256, address) tuple for setAddr(uint256, address).
 */
export function encodeUint256Address(id: bigint, addr: string): string {
  return encodeUint256(id) + encodeAddress(addr)
}

/**
 * Encode a (uint256, string, string) tuple for setText(uint256, string, string).
 */
export function encodeUint256StringString(id: bigint, str1: string, str2: string): string {
  const bytes1 = new TextEncoder().encode(str1)
  const len1 = bytes1.length
  const paddedLen1 = 32 * Math.ceil(len1 / 32)

  const bytes2 = new TextEncoder().encode(str2)
  const len2 = bytes2.length
  const paddedLen2 = 32 * Math.ceil(len2 / 32)

  // word 0: uint256
  // word 1: offset to string1 data = 0x60 (96, 3 head slots)
  // word 2: offset to string2 data = 0x60 + 32 + paddedLen1 (after str1 length word + str1 data)
  // then string1: length + padded data
  // then string2: length + padded data
  const idHex = encodeUint256(id)
  const offset1 = 96n // 3 * 32
  const str1TotalLen = 32 + paddedLen1 // length word + padded data
  const offset2 = offset1 + BigInt(str1TotalLen)

  const offset1Hex = encodeUint256(offset1)
  const offset2Hex = encodeUint256(offset2)

  const len1Hex = encodeUint256(BigInt(len1))
  const data1Hex = bytesToHex(paddedBytes(bytes1, paddedLen1))

  const len2Hex = encodeUint256(BigInt(len2))
  const data2Hex = bytesToHex(paddedBytes(bytes2, paddedLen2))

  return idHex + offset1Hex + offset2Hex + len1Hex + data1Hex + len2Hex + data2Hex
}

/**
 * Encode a (uint256, bytes) tuple for setContenthash(uint256, bytes).
 */
export function encodeUint256Bytes(id: bigint, value: string): string {
  const hex = value.replace('0x', '')
  const len = hex.length / 2
  const paddedLen = 32 * Math.ceil(len / 32)

  // word 0: uint256
  // word 1: offset to bytes data = 0x40 (64)
  // word 2: bytes length
  // word 3+: bytes data
  const idHex = encodeUint256(id)
  const offsetHex = encodeUint256(64n)
  const lenHex = encodeUint256(BigInt(len))
  const dataHex = hex.padEnd(paddedLen * 2, '0')

  return idHex + offsetHex + lenHex + dataHex
}

/**
 * Decode an address from a 32-byte ABI-encoded slot.
 */
export function decodeAddress(data: string): `0x${string}` | null {
  if (!data || data === '0x' || data.length < 66) return null
  const addr = `0x${data.slice(-40)}` as `0x${string}`
  if (addr === '0x0000000000000000000000000000000000000000') return null
  return addr
}

/**
 * Decode a uint256 from ABI-encoded data (first 32 bytes after 0x).
 */
export function decodeUint256(data: string): bigint {
  if (!data || data === '0x') return 0n
  return BigInt(data.slice(0, 66))
}

/**
 * Decode a bool from ABI-encoded data (first 32 bytes after 0x).
 */
export function decodeBool(data: string): boolean {
  if (!data || data === '0x') return false
  const hex = data.replace('0x', '')
  return BigInt(`0x${hex.slice(0, 64)}`) !== 0n
}

/**
 * Decode an ABI-encoded dynamic bytes return value.
 * Returns the raw hex string (with 0x prefix), or null for empty/missing data.
 */
export function decodeBytes(data: string): string | null {
  if (!data || data === '0x' || data.length < 130) return null
  const hex = data.slice(2)
  const length = Number.parseInt(hex.slice(64, 128), 16)
  if (length === 0) return null
  const bytesHex = hex.slice(128, 128 + 2 * length)
  return `0x${bytesHex}`
}

/**
 * Decode an ABI-encoded string return value.
 */
export function decodeString(data: string): string | null {
  if (!data || data === '0x' || data.length < 130) return null
  const hex = data.slice(2)
  const length = Number.parseInt(hex.slice(64, 128), 16)
  if (length === 0) return ''
  const strHex = hex.slice(128, 128 + 2 * length)
  const bytes: number[] = []
  for (let i = 0; i < strHex.length; i += 2) {
    bytes.push(Number.parseInt(strHex.slice(i, i + 2), 16))
  }
  return new TextDecoder().decode(new Uint8Array(bytes))
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

function paddedBytes(bytes: Uint8Array, paddedLen: number): Uint8Array {
  const buf = new Uint8Array(paddedLen)
  buf.set(bytes)
  return buf
}
