import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDirectory = dirname(fileURLToPath(import.meta.url))
const sdkDirectory = resolve(scriptDirectory, '..')
const repositoryRoot = resolve(sdkDirectory, '..')
const abiPath = resolve(sdkDirectory, 'src/abi.ts')
const checkOnly = process.argv.includes('--check')

const abiJson = execFileSync(
  'forge',
  ['inspect', 'src/NameNFT.sol:NameNFT', 'abi', '--json'],
  {
    cwd: repositoryRoot,
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
  },
)
const abi = JSON.parse(abiJson)

if (!Array.isArray(abi)) {
  throw new Error('forge inspect returned an invalid NameNFT ABI')
}

const unformatted = `// Generated from src/NameNFT.sol by scripts/generate-abi.mjs. Do not edit by hand.\nexport const gnsAbi = ${JSON.stringify(abi, null, 2)} as const\n`
const formatted = execFileSync(
  'pnpm',
  ['exec', 'biome', 'format', '--stdin-file-path', 'src/abi.ts'],
  {
    cwd: sdkDirectory,
    encoding: 'utf8',
    input: unformatted,
    maxBuffer: 10 * 1024 * 1024,
  },
)

if (checkOnly) {
  if (readFileSync(abiPath, 'utf8') !== formatted) {
    console.error('src/abi.ts is out of date. Run `pnpm abi:generate` from sdk/.')
    process.exitCode = 1
  }
} else {
  writeFileSync(abiPath, formatted)
  console.log('Generated src/abi.ts from src/NameNFT.sol')
}
