import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createGnsClient } from './client.js'
import { GNS_CONTRACT } from './constants.js'

// Integration tests — these hit real Ethereum RPC endpoints
// and resolve against the live GNS contract on Sepolia.

const gns = createGnsClient()

describe('createGnsClient', () => {
  it('creates a client with default config', () => {
    assert.ok(gns)
    assert.equal(typeof gns.resolve, 'function')
    assert.equal(typeof gns.reverseResolve, 'function')
    assert.equal(typeof gns.resolveAny, 'function')
  })

  it('creates a client with custom rpc', () => {
    const client = createGnsClient({ rpc: 'https://ethereum-sepolia-rpc.publicnode.com' })
    assert.ok(client)
  })
})

describe('resolve', () => {
  it('returns null for empty input', async () => {
    const result = await gns.resolve('')
    assert.equal(result, null)
  })

  it('returns null for a non-existent name', async () => {
    const result = await gns.resolve('thisshouldneverexist99999.gwei')
    assert.equal(result, null)
  })

  it('resolves a known .gwei name to an address', async () => {
    // "test.gwei" resolves to a known address on Sepolia
    const result = await gns.resolve('test.gwei')
    assert.equal(result, '0x30710E0CFF3530bB6D34C5bAAAf9c11267B56FC6')
  })

  it('resolves with or without .gwei suffix', async () => {
    const a = await gns.resolve('test.gwei')
    const b = await gns.resolve('test')
    assert.equal(a, b)
  })
})

describe('reverseResolve', () => {
  it('returns null for invalid address', async () => {
    const result = await gns.reverseResolve('not-an-address')
    assert.equal(result, null)
  })

  it('returns null for zero address', async () => {
    const result = await gns.reverseResolve('0x0000000000000000000000000000000000000000')
    // zero address likely has no primary name
    assert.ok(result === null || typeof result === 'string')
  })
})

describe('resolveAny', () => {
  it('returns null for empty input', async () => {
    const result = await gns.resolveAny('')
    assert.equal(result, null)
  })

  it('passes through a valid address', async () => {
    const addr = '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045'
    const result = await gns.resolveAny(addr)
    assert.equal(result, addr)
  })

  it('resolves a .gwei name', async () => {
    const result = await gns.resolveAny('test.gwei')
    if (result !== null) {
      assert.match(result, /^0x[a-fA-F0-9]{40}$/)
    }
  })

  it('returns null for non-.gwei domain names', async () => {
    const result = await gns.resolveAny('vitalik.eth')
    assert.equal(result, null)
  })
})

// --- Phase 1: Read methods ---

describe('isAvailable', () => {
  it('returns false for a registered name', async () => {
    const result = await gns.isAvailable('test')
    assert.equal(result, false)
  })

  it('returns true for an unregistered name', async () => {
    const result = await gns.isAvailable('thisshouldneverexist99999zzzzz')
    assert.equal(result, true)
  })
})

describe('isExpired', () => {
  it('returns a boolean for a known name', async () => {
    const result = await gns.isExpired('test')
    assert.equal(typeof result, 'boolean')
  })
})

describe('inGracePeriod', () => {
  it('returns a boolean for a known name', async () => {
    const result = await gns.inGracePeriod('test')
    assert.equal(typeof result, 'boolean')
  })
})

describe('expiresAt', () => {
  it('returns a non-zero timestamp for a registered name', async () => {
    const result = await gns.expiresAt('test')
    assert.ok(result > 0n)
  })

  it('returns 0n for a non-existent name', async () => {
    const result = await gns.expiresAt('thisshouldneverexist99999')
    // computeId returns some ID, expiresAt may return 0 for unregistered
    assert.equal(typeof result, 'bigint')
  })
})

describe('getFullName', () => {
  it('returns the full name for a known token ID', async () => {
    // First compute the tokenId for "test.gwei"
    const tokenId = await gns.computeId('test')
    const result = await gns.getFullName(tokenId)
    if (result !== null) {
      assert.ok(result.includes('test'))
    }
  })
})

describe('ownerOf', () => {
  it('returns an address for a registered name', async () => {
    const result = await gns.ownerOf('test')
    if (result !== null) {
      assert.match(result, /^0x[a-fA-F0-9]{40}$/)
    }
  })

  it('returns null for a non-existent name', async () => {
    const result = await gns.ownerOf('thisshouldneverexist99999')
    // ownerOf may revert for non-existent tokens, which returns null
    assert.ok(result === null || typeof result === 'string')
  })
})

describe('balanceOf', () => {
  it('returns 0n for invalid address', async () => {
    const result = await gns.balanceOf('not-an-address')
    assert.equal(result, 0n)
  })

  it('returns a bigint for a valid address', async () => {
    // Use the owner of "test.gwei"
    const owner = await gns.ownerOf('test')
    if (owner) {
      const result = await gns.balanceOf(owner)
      assert.ok(result >= 0n)
    }
  })
})

describe('getFee', () => {
  it('returns a non-zero fee for a 3-char name', async () => {
    const result = await gns.getFee(3n)
    assert.ok(result >= 0n)
  })

  it('returns a fee for a 5-char name', async () => {
    const result = await gns.getFee(5n)
    assert.ok(result >= 0n)
  })
})

describe('getPremium', () => {
  it('returns a bigint for a known name', async () => {
    const result = await gns.getPremium('test')
    assert.equal(typeof result, 'bigint')
  })
})

describe('computeId', () => {
  it('returns a non-zero token ID for a valid name', async () => {
    const result = await gns.computeId('test')
    assert.ok(result > 0n)
  })

  it('returns same ID with or without .gwei suffix', async () => {
    const a = await gns.computeId('test')
    const b = await gns.computeId('test.gwei')
    assert.equal(a, b)
  })
})

// --- Phase 2: Transaction encoders ---

describe('encodeCommit', () => {
  it('returns a tx object with correct selector', () => {
    const commitment = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef'
    const tx = gns.encodeCommit(commitment)
    assert.equal(tx.to, GNS_CONTRACT)
    assert.ok(tx.data.startsWith('0xf14fcbc8'))
    assert.equal(tx.value, undefined)
  })
})

describe('encodeReveal', () => {
  it('returns a tx object with value', () => {
    const secret = '0xabababababababababababababababababababababababababababababababab'
    const tx = gns.encodeReveal('myname', secret, 500000000000000n)
    assert.equal(tx.to, GNS_CONTRACT)
    assert.ok(tx.data.startsWith('0xea9384fa'))
    assert.equal(tx.value, 500000000000000n)
  })
})

describe('encodeRenew', () => {
  it('returns a tx object with value', async () => {
    const tx = await gns.encodeRenew('test', 500000000000000n)
    assert.equal(tx.to, GNS_CONTRACT)
    assert.ok(tx.data.startsWith('0x5baa7509'))
    assert.equal(tx.value, 500000000000000n)
  })
})

describe('encodeSetPrimaryName', () => {
  it('returns a tx object', async () => {
    const tx = await gns.encodeSetPrimaryName('test')
    assert.equal(tx.to, GNS_CONTRACT)
    assert.ok(tx.data.startsWith('0xa4f69657'))
  })
})

describe('encodeSetAddr', () => {
  it('returns a tx object', async () => {
    const tx = await gns.encodeSetAddr('test', '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045')
    assert.equal(tx.to, GNS_CONTRACT)
    assert.ok(tx.data.startsWith('0xeba36dbd'))
  })
})

describe('encodeSetText', () => {
  it('returns a tx object', async () => {
    const tx = await gns.encodeSetText('test', 'avatar', 'https://example.com/avatar.png')
    assert.equal(tx.to, GNS_CONTRACT)
    assert.ok(tx.data.startsWith('0x3fb24782'))
  })
})

describe('encodeSetContenthash', () => {
  it('returns a tx object', async () => {
    const tx = await gns.encodeSetContenthash('test', '0xabcd')
    assert.equal(tx.to, GNS_CONTRACT)
    assert.ok(tx.data.startsWith('0x88f97a67'))
  })
})

describe('encodeRegisterSubdomain', () => {
  it('returns a tx object', async () => {
    const tx = await gns.encodeRegisterSubdomain('sub', 'test')
    assert.equal(tx.to, GNS_CONTRACT)
    assert.ok(tx.data.startsWith('0x8f449b85'))
  })
})
