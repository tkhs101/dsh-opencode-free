#!/usr/bin/env node
// Refuse to publish from a working tree that does not match the changelog.
//
// Two failure modes it exists for (audit 2026-09-30):
//
//   1. Unreleased work sitting on an already-published version. The tree carried
//      +1133 lines of behaviour change while package.json still said a version
//      that had shipped, and CHANGELOG kept them under `## [Unreleased]`. The
//      test that should have caught it only checked that a `## [<version>]` string
//      existed somewhere in the file — it did not check POSITION, so the
//      `[Unreleased]` block sat above the released one and everything was green.
//
//   2. A dirty tree producing a tarball nobody reviewed. `prepack` runs `tsc`
//      and nothing else; without this guard, `pnpm publish` ships a build that
//      never went through `pnpm run check`.
//
// This is a gate, not a formatter: it exits non-zero and says what to do.
import { readFile } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'

const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
const changelog = await readFile(new URL('../CHANGELOG.md', import.meta.url), 'utf8')
const problems = []

// 1. The changelog must LEAD with the shipped version.
const firstSection = changelog.match(/^## \[/m)
if (firstSection === null) {
  problems.push('CHANGELOG.md has no `## [` version section at all')
} else {
  const lead = changelog.slice(firstSection.index).match(/^## \[([^\]]+)\]/)
  const leadName = lead === null ? '' : lead[1]
  if (leadName !== pkg.version) {
    problems.push(
      `CHANGELOG.md leads with [${leadName}] but package.json says ${pkg.version}.\n` +
        '  Either promote the section (rename `## [Unreleased]` to the new version)\n' +
        '  or bump package.json to match what is actually being shipped.',
    )
  }
}

// 2. Nothing uncommitted, unless explicitly allowed.
let dirty = []
try {
  const out = execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' })
  dirty = out.split('\n').filter((line) => line.trim() !== '')
} catch {
  // No git (a tarball-only checkout): nothing to compare, and the changelog
  // check above still applies.
  dirty = []
}
if (dirty.length > 0 && process.env.ALLOW_DIRTY_PUBLISH !== '1') {
  problems.push(
    `the working tree has ${dirty.length} uncommitted change(s):\n` +
      dirty
        .slice(0, 10)
        .map((l) => `    ${l}`)
        .join('\n') +
      (dirty.length > 10 ? '\n    …' : '') +
      '\n  Commit them, or re-run with ALLOW_DIRTY_PUBLISH=1 if that is genuinely intended.',
  )
}

if (problems.length > 0) {
  console.error('refusing to publish:\n')
  for (const p of problems) console.error(`  - ${p}\n`)
  process.exit(1)
}
console.log(`publish gate ok (${pkg.version})`)
