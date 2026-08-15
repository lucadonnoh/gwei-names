import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'
import { gnsAbi } from './abi.js'
import { MAX_SUBDOMAIN_DEPTH } from './constants.js'

const functions = new Set<string>(
  gnsAbi.filter((entry) => entry.type === 'function').map((entry) => entry.name),
)
const contractSource = readFileSync(new URL('../../src/NameNFT.sol', import.meta.url), 'utf8')

describe('deployed contract surface', () => {
  it('keeps the ownerless contract free of the removed admin API', () => {
    for (const name of [
      'defaultFee',
      'lengthFees',
      'setDefaultFee',
      'setLengthFees',
      'clearLengthFee',
      'setPremiumSettings',
      'withdraw',
    ]) {
      assert.equal(functions.has(name), false, `${name} must not be exported`)
    }
  })

  it('includes representative read and write methods', () => {
    for (const name of ['resolve', 'getFee', 'commit', 'reveal', 'registerSubdomain']) {
      assert.equal(functions.has(name), true, `${name} must be exported`)
    }
  })

  it('exports the contract subdomain-depth limit', () => {
    const match = contractSource.match(/uint256 constant MAX_SUBDOMAIN_DEPTH = (\d+);/)
    assert.ok(match, 'NameNFT must define MAX_SUBDOMAIN_DEPTH')
    assert.equal(MAX_SUBDOMAIN_DEPTH, Number(match[1]))
  })
})
