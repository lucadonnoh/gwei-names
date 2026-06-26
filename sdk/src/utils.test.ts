import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { isAddress, isGwei, normalizeName, parseLabel } from './utils.js'

describe('isGwei', () => {
  it('returns true for .gwei names', () => {
    assert.equal(isGwei('alice.gwei'), true)
    assert.equal(isGwei('ALICE.GWEI'), true)
    assert.equal(isGwei('test.Gwei'), true)
  })

  it('returns false for non-.gwei strings', () => {
    assert.equal(isGwei('alice.eth'), false)
    assert.equal(isGwei('alice'), false)
    assert.equal(isGwei(''), false)
  })
})

describe('isAddress', () => {
  it('returns true for valid addresses', () => {
    assert.equal(isAddress('0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045'), true)
    assert.equal(isAddress('0x0000000000000000000000000000000000000000'), true)
  })

  it('returns false for invalid addresses', () => {
    assert.equal(isAddress('0x123'), false)
    assert.equal(isAddress('not-an-address'), false)
    assert.equal(isAddress(''), false)
    assert.equal(isAddress('0xGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGG'), false)
  })
})

describe('normalizeName', () => {
  it('adds .gwei suffix if missing', () => {
    assert.equal(normalizeName('alice'), 'alice.gwei')
  })

  it('lowercases and trims', () => {
    assert.equal(normalizeName('  ALICE.GWEI  '), 'alice.gwei')
  })

  it('keeps .gwei suffix if present', () => {
    assert.equal(normalizeName('alice.gwei'), 'alice.gwei')
  })
})

describe('parseLabel', () => {
  it('strips .gwei suffix', () => {
    assert.equal(parseLabel('alice.gwei'), 'alice')
  })

  it('returns input if no .gwei suffix', () => {
    assert.equal(parseLabel('alice'), 'alice')
  })

  it('lowercases and trims', () => {
    assert.equal(parseLabel('  ALICE.GWEI  '), 'alice')
  })
})
