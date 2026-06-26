import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { decodeFunctionResult, encodeFunctionData, parseAbi } from 'viem'
import {
  decodeAddress,
  decodeBool,
  decodeBytes,
  decodeString,
  decodeUint256,
  encodeAddress,
  encodeBool,
  encodeBytes,
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

// Helper: extract args portion from viem's full calldata (strip 4-byte selector)
function viemArgs(calldata: string): string {
  return calldata.slice(10) // remove 0x + 4-byte selector
}

describe('encodeString', () => {
  it('encodes a simple string with offset + length + padded data', () => {
    const result = encodeString('hello.gwei')
    assert.ok(result.startsWith('0000000000000000000000000000000000000000000000000000000000000020'))
    assert.ok(result.includes('000000000000000000000000000000000000000000000000000000000000000a'))
  })

  it('encodes an empty string', () => {
    const result = encodeString('')
    assert.ok(result.startsWith('0000000000000000000000000000000000000000000000000000000000000020'))
    assert.ok(result.includes('0000000000000000000000000000000000000000000000000000000000000000'))
  })
})

describe('encodeAddress', () => {
  it('encodes an address to 32 bytes left-padded', () => {
    const result = encodeAddress('0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045')
    assert.equal(result.length, 64)
    assert.ok(result.endsWith('d8da6bf26964af9d7eed9e03e53415d37aa96045'))
    assert.ok(result.startsWith('000000000000000000000000'))
  })
})

describe('encodeUint256', () => {
  it('encodes zero', () => {
    const result = encodeUint256(0n)
    assert.equal(result, '0'.repeat(64))
  })

  it('encodes a non-zero value', () => {
    const result = encodeUint256(42n)
    assert.equal(result.length, 64)
    assert.ok(result.endsWith('2a'))
  })
})

describe('encodeBytes32', () => {
  it('encodes a bytes32 value', () => {
    const input = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
    const result = encodeBytes32(input)
    assert.equal(result.length, 64)
    assert.equal(result, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')
  })

  it('right-pads short values', () => {
    const result = encodeBytes32('0xabcd')
    assert.equal(result.length, 64)
    assert.ok(result.startsWith('abcd'))
    assert.ok(result.endsWith('0'.repeat(60)))
  })
})

describe('encodeBool', () => {
  it('encodes true', () => {
    const result = encodeBool(true)
    assert.equal(result.length, 64)
    assert.equal(result, `${'0'.repeat(63)}1`)
  })

  it('encodes false', () => {
    const result = encodeBool(false)
    assert.equal(result, '0'.repeat(64))
  })
})

describe('encodeTwoUint256 — cross-validated with viem', () => {
  const abi = parseAbi(['function addr(uint256 tokenId, uint256 coinType) view returns (bytes)'])

  it('matches viem for addr(uint256,uint256)', () => {
    const tokenId = 12345n
    const coinType = 60n
    const ours = encodeTwoUint256(tokenId, coinType)
    const viemCalldata = encodeFunctionData({
      abi,
      functionName: 'addr',
      args: [tokenId, coinType],
    })
    assert.equal(ours, viemArgs(viemCalldata))
  })

  it('matches viem for large values', () => {
    const a = 2n ** 128n - 1n
    const b = 2n ** 255n
    const ours = encodeTwoUint256(a, b)
    const viemCalldata = encodeFunctionData({ abi, functionName: 'addr', args: [a, b] })
    assert.equal(ours, viemArgs(viemCalldata))
  })
})

describe('encodeUint256String — cross-validated with viem', () => {
  const abi = parseAbi(['function text(uint256 tokenId, string key) view returns (string)'])

  it('matches viem for text(uint256,string)', () => {
    const tokenId = 999n
    const key = 'avatar'
    const ours = encodeUint256String(tokenId, key)
    const viemCalldata = encodeFunctionData({ abi, functionName: 'text', args: [tokenId, key] })
    assert.equal(ours, viemArgs(viemCalldata))
  })

  it('matches viem for empty string', () => {
    const tokenId = 1n
    const key = ''
    const ours = encodeUint256String(tokenId, key)
    const viemCalldata = encodeFunctionData({ abi, functionName: 'text', args: [tokenId, key] })
    assert.equal(ours, viemArgs(viemCalldata))
  })

  it('matches viem for long string (>32 bytes)', () => {
    const tokenId = 42n
    const key = 'a]very-long-key-that-exceeds-thirty-two-bytes-in-length'
    const ours = encodeUint256String(tokenId, key)
    const viemCalldata = encodeFunctionData({ abi, functionName: 'text', args: [tokenId, key] })
    assert.equal(ours, viemArgs(viemCalldata))
  })
})

describe('encodeStringUint256 — cross-validated with viem', () => {
  const abi = parseAbi(['function isAvailable(string label, uint256 parentId) view returns (bool)'])

  it('matches viem for isAvailable(string,uint256)', () => {
    const label = 'alice'
    const parentId = 0n
    const ours = encodeStringUint256(label, parentId)
    const viemCalldata = encodeFunctionData({
      abi,
      functionName: 'isAvailable',
      args: [label, parentId],
    })
    assert.equal(ours, viemArgs(viemCalldata))
  })

  it('matches viem with non-zero parentId', () => {
    const label = 'sub'
    const parentId = 77777n
    const ours = encodeStringUint256(label, parentId)
    const viemCalldata = encodeFunctionData({
      abi,
      functionName: 'isAvailable',
      args: [label, parentId],
    })
    assert.equal(ours, viemArgs(viemCalldata))
  })
})

describe('encodeStringAddressBytes32 — cross-validated with viem', () => {
  const abi = parseAbi([
    'function makeCommitment(string label, address owner, bytes32 secret) pure returns (bytes32)',
  ])

  it('matches viem for makeCommitment(string,address,bytes32)', () => {
    const label = 'testname'
    const owner = '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045'
    const secret = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef'
    const ours = encodeStringAddressBytes32(label, owner, secret)
    const viemCalldata = encodeFunctionData({
      abi,
      functionName: 'makeCommitment',
      args: [label, owner as `0x${string}`, secret as `0x${string}`],
    })
    assert.equal(ours, viemArgs(viemCalldata))
  })
})

describe('encodeStringBytes32 — cross-validated with viem', () => {
  const abi = parseAbi(['function reveal(string label, bytes32 secret) payable returns (uint256)'])

  it('matches viem for reveal(string,bytes32)', () => {
    const label = 'myname'
    const secret = '0xabababababababababababababababababababababababababababababababab'
    const ours = encodeStringBytes32(label, secret)
    const viemCalldata = encodeFunctionData({
      abi,
      functionName: 'reveal',
      args: [label, secret as `0x${string}`],
    })
    assert.equal(ours, viemArgs(viemCalldata))
  })
})

describe('encodeUint256Address — cross-validated with viem', () => {
  const abi = parseAbi(['function setAddr(uint256 tokenId, address addr)'])

  it('matches viem for setAddr(uint256,address)', () => {
    const tokenId = 5555n
    const addr = '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045'
    const ours = encodeUint256Address(tokenId, addr)
    const viemCalldata = encodeFunctionData({
      abi,
      functionName: 'setAddr',
      args: [tokenId, addr as `0x${string}`],
    })
    assert.equal(ours, viemArgs(viemCalldata))
  })
})

describe('encodeUint256StringString — cross-validated with viem', () => {
  const abi = parseAbi(['function setText(uint256 tokenId, string key, string value)'])

  it('matches viem for setText(uint256,string,string)', () => {
    const tokenId = 100n
    const key = 'avatar'
    const value = 'https://example.com/avatar.png'
    const ours = encodeUint256StringString(tokenId, key, value)
    const viemCalldata = encodeFunctionData({
      abi,
      functionName: 'setText',
      args: [tokenId, key, value],
    })
    assert.equal(ours, viemArgs(viemCalldata))
  })

  it('matches viem with empty strings', () => {
    const tokenId = 1n
    const key = ''
    const value = ''
    const ours = encodeUint256StringString(tokenId, key, value)
    const viemCalldata = encodeFunctionData({
      abi,
      functionName: 'setText',
      args: [tokenId, key, value],
    })
    assert.equal(ours, viemArgs(viemCalldata))
  })

  it('matches viem with long strings', () => {
    const tokenId = 42n
    const key = 'description'
    const value =
      'This is a very long description that spans more than thirty-two bytes to test multi-word padding.'
    const ours = encodeUint256StringString(tokenId, key, value)
    const viemCalldata = encodeFunctionData({
      abi,
      functionName: 'setText',
      args: [tokenId, key, value],
    })
    assert.equal(ours, viemArgs(viemCalldata))
  })
})

describe('encodeUint256Bytes — cross-validated with viem', () => {
  const abi = parseAbi(['function setContenthash(uint256 tokenId, bytes hash)'])

  it('matches viem for setContenthash(uint256,bytes)', () => {
    const tokenId = 200n
    const hash = '0xe3010170122029f2d17be6139079dc48696d1f582a8530eb9805b561eda517e22a892c7e3f1f'
    const ours = encodeUint256Bytes(tokenId, hash)
    const viemCalldata = encodeFunctionData({
      abi,
      functionName: 'setContenthash',
      args: [tokenId, hash as `0x${string}`],
    })
    assert.equal(ours, viemArgs(viemCalldata))
  })

  it('matches viem for short bytes', () => {
    const tokenId = 1n
    const hash = '0xabcd'
    const ours = encodeUint256Bytes(tokenId, hash)
    const viemCalldata = encodeFunctionData({
      abi,
      functionName: 'setContenthash',
      args: [tokenId, hash as `0x${string}`],
    })
    assert.equal(ours, viemArgs(viemCalldata))
  })
})

describe('encodeBytes', () => {
  it('encodes a simple hex bytes value', () => {
    const result = encodeBytes('0xabcd')
    // offset (32) + length (2) + padded data
    assert.ok(result.startsWith('0000000000000000000000000000000000000000000000000000000000000020'))
    assert.ok(result.includes('0000000000000000000000000000000000000000000000000000000000000002'))
    assert.ok(result.includes('abcd'))
  })
})

describe('decodeAddress', () => {
  it('decodes a valid address', () => {
    const encoded = '0x000000000000000000000000d8da6bf26964af9d7eed9e03e53415d37aa96045'
    const result = decodeAddress(encoded)
    assert.equal(result, '0xd8da6bf26964af9d7eed9e03e53415d37aa96045')
  })

  it('returns null for zero address', () => {
    const encoded = '0x0000000000000000000000000000000000000000000000000000000000000000'
    const result = decodeAddress(encoded)
    assert.equal(result, null)
  })

  it('returns null for empty data', () => {
    assert.equal(decodeAddress('0x'), null)
    assert.equal(decodeAddress(''), null)
  })
})

describe('decodeUint256', () => {
  it('decodes zero', () => {
    const encoded = '0x0000000000000000000000000000000000000000000000000000000000000000'
    assert.equal(decodeUint256(encoded), 0n)
  })

  it('decodes a non-zero value', () => {
    const encoded = '0x000000000000000000000000000000000000000000000000000000000000002a'
    assert.equal(decodeUint256(encoded), 42n)
  })

  it('returns 0n for empty data', () => {
    assert.equal(decodeUint256('0x'), 0n)
    assert.equal(decodeUint256(''), 0n)
  })
})

describe('decodeBool', () => {
  it('decodes true (1)', () => {
    const encoded = '0x0000000000000000000000000000000000000000000000000000000000000001'
    assert.equal(decodeBool(encoded), true)
  })

  it('decodes false (0)', () => {
    const encoded = '0x0000000000000000000000000000000000000000000000000000000000000000'
    assert.equal(decodeBool(encoded), false)
  })

  it('decodes non-zero as true', () => {
    const encoded = '0x00000000000000000000000000000000000000000000000000000000000000ff'
    assert.equal(decodeBool(encoded), true)
  })

  it('returns false for empty data', () => {
    assert.equal(decodeBool('0x'), false)
    assert.equal(decodeBool(''), false)
  })
})

describe('decodeBytes', () => {
  it('decodes a bytes value', () => {
    const hex =
      '0x' +
      '0000000000000000000000000000000000000000000000000000000000000020' + // offset
      '0000000000000000000000000000000000000000000000000000000000000002' + // length
      'abcd000000000000000000000000000000000000000000000000000000000000' // data
    assert.equal(decodeBytes(hex), '0xabcd')
  })

  it('returns null for zero-length bytes', () => {
    const hex =
      '0x' +
      '0000000000000000000000000000000000000000000000000000000000000020' +
      '0000000000000000000000000000000000000000000000000000000000000000'
    assert.equal(decodeBytes(hex), null)
  })

  it('returns null for empty data', () => {
    assert.equal(decodeBytes('0x'), null)
    assert.equal(decodeBytes(''), null)
  })
})

describe('decodeString', () => {
  it('decodes an ABI-encoded string', () => {
    const hex =
      '0x' +
      '0000000000000000000000000000000000000000000000000000000000000020' +
      '0000000000000000000000000000000000000000000000000000000000000005' +
      '68656c6c6f000000000000000000000000000000000000000000000000000000'
    assert.equal(decodeString(hex), 'hello')
  })

  it('decodes an empty string', () => {
    const hex =
      '0x' +
      '0000000000000000000000000000000000000000000000000000000000000020' +
      '0000000000000000000000000000000000000000000000000000000000000000'
    assert.equal(decodeString(hex), '')
  })

  it('returns null for insufficient data', () => {
    assert.equal(decodeString('0x'), null)
    assert.equal(decodeString(''), null)
    assert.equal(decodeString('0x00'), null)
  })
})
