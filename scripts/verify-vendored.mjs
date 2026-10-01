#!/usr/bin/env node
// Vendored from the write-notes-like-deepseek skill, byte-for-byte.
//
// `.prettierignore` lists `scripts/notes/` — which is correct (reformatting them
// would drift from the skill and turn every future skill update into a merge
// conflict) but it also makes them UNCHECKED. That hole is real: on 2026-10-01 a
// stray edit left one of these files differing from upstream and nothing
// noticed, because nothing was looking.
//
// So the files are excluded from formatting and included in a checksum manifest
// instead. Run `node scripts/verify-vendored.mjs` in CI (wired into `check`).
// When the skill itself is upgraded, refresh the manifest deliberately:
//
//   node scripts/verify-vendored.mjs --refresh
//
// which re-reads them and rewrites the manifest — an explicit, reviewable act.
import { createHash } from 'node:crypto'
import { readFile, writeFile, readdir } from 'node:fs/promises'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const dir = join(here, 'notes')
const manifestPath = join(here, 'vendored-manifest.json')

const files = (await readdir(dir)).filter((f) => f.endsWith('.ts') || f.endsWith('.mjs')).sort()

async function digests() {
  const out = {}
  for (const f of files) {
    const bytes = await readFile(join(dir, f))
    out[f] = createHash('sha256').update(bytes).digest('hex').slice(0, 16)
  }
  return out
}

const current = await digests()

if (process.argv.includes('--refresh')) {
  await writeFile(manifestPath, JSON.stringify(current, null, 2) + '\n', 'utf8')
  console.log(`vendored manifest refreshed: ${files.length} file(s)`)
  process.exit(0)
}

let expected
try {
  expected = JSON.parse(await readFile(manifestPath, 'utf8'))
} catch {
  console.error(
    `missing ${relative(process.cwd(), manifestPath)} — run: node scripts/verify-vendored.mjs --refresh`,
  )
  process.exit(1)
}

const problems = []
for (const f of files) {
  if (!(f in expected)) problems.push(`${f}: vendored but not in the manifest (new file?)`)
  else if (expected[f] !== current[f]) {
    problems.push(
      `${f}: ${expected[f]} -> ${current[f]}  (edited in place, or the skill was upgraded without --refresh)`,
    )
  }
}
for (const f of Object.keys(expected)) {
  if (!files.includes(f)) problems.push(`${f}: in the manifest but missing from scripts/notes/`)
}

if (problems.length > 0) {
  console.error('scripts/notes/ has drifted from the skill it is vendored from:\n')
  for (const p of problems) console.error(`  - ${p}`)
  console.error('\nIf this was an intentional skill upgrade, run: node scripts/verify-vendored.mjs --refresh')
  process.exit(1)
}
console.log(`ok: ${files.length} vendored file(s) match the skill`)
