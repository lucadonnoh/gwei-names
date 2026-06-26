import { readFileSync, writeFileSync } from 'fs'

const type = process.argv[2] || 'patch'
const pkg = JSON.parse(readFileSync('package.json', 'utf8'))
const [major, minor, patch] = pkg.version.split('.').map(Number)

const next =
  type === 'major' ? `${major + 1}.0.0` :
  type === 'minor' ? `${major}.${minor + 1}.0` :
  `${major}.${minor}.${patch + 1}`

const id = Date.now().toString(36)
const md = `---\n"gns-utils": ${type}\n---\n\n${next}\n`

writeFileSync(`.changeset/${id}.md`, md)
console.log(`changeset: ${type} → ${next}`)
