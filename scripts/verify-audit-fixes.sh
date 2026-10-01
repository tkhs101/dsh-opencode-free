#!/usr/bin/env bash
# Spot-verify that each audited finding's fix is actually present in the tree.
# Prints PRESENT / PARTIAL / DEFERRED per finding. Exits non-zero if any is missing
# in a way that was not declared.
cd "$(dirname "$0")/.." || exit 2
F=audit-report-dsh-opencode-free-2026-09-30.html
src=src/catalog.ts; zp=src/zen-provider.ts; ix=src/index.ts; cl=src/client.js
declare -A R

has() { grep -qF "$2" "$1" 2>/dev/null && echo 1 || echo 0; }

R[1]=$(has README.md 'is NOT published to npm')
R[2]=$(has README.md 'verbatim, with no redaction')
R[3]=$(has $zp 'The fallback below is scoped to the identity rewrite')
R[4]=$(has $src 'const previousRound = state.cache?.lastRound;')
R[5]=$(has $src 'FORCED_PROBE_MIN_INTERVAL_MS')
R[6]=$([ "$(node -p "Object.keys(require('./package.json').peerDependenciesMeta||{}).length")" = "0" ] && echo 1 || echo 0)
R[7]=$(has package.json 'prepublishOnly')
R[8]=$(has $cl 'pollRef.current')
R[9]=$(has .github/workflows/ci.yml 'node: ["22.19.0", "24", "26"]')
R[10]=$(has README.md 'not in the tarball')
R[11]=$(has $zp 'export function applyZenIdentity')
R[12]=$(has $src 'async function readBounded')
R[13]=$(has $zp '^you are a context summarization/i')
R[14]=$(has tests/client-render.test.mjs 'every palette colour meets WCAG AA')
R[15]=$(has $cl 'input:focus-visible+.opf-track')
R[16]=$(has .github/workflows/ci.yml 'actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683')
# Is the structural work landed? createCatalog should be materially smaller, and
# the rules that used to be buried in it should now be module-level and tested.
R[17]=$(has src/catalog.ts "export function planRound")
if [ "$(grep -c "^export function " src/catalog.ts)" -lt 15 ]; then R[17]=0; fi
if ! grep -q "planRound splits what it will ASK" tests/catalog.test.mjs; then R[17]=0; fi
R[18]=$(has $ix 'opencode-free: transport patches')
R[19]=$(has $src 'mode: 0o600')
R[20]=$(has $src 'models: state.cache?.models ?? {}')
R[21]=$(node -p "require('./package.json').repository.url.includes('tkhs101')?1:0")
R[22]=$(has scripts/reverify.sh 'PLUGIN_VERSION=')
R[23]=$(has README.md 'What it patches in your process')
R[24]=$(has README.md 'DSH_HOME/dsh-opencode-free/catalog.json')
R[25]=$(has scripts/reverify.sh 'Authorization: Bearer %s')
R[26]=$([ "$(grep -c 'payload\.probe\b' $cl)" = "0" ] && echo 1 || echo 0)
R[27]=$(has $zp '  activeCatalog = catalog;')
R[28]=$(has $ix 'LOCAL_HOSTS')
R[29]=$(has $src 'function admissibleGate')
R[30]=$(has $zp 'if (typeof iter !== "function") return Reflect.get')
R[31]=$([ "$(grep -c 'LlmError' $ix)" = "0" ] && echo 1 || echo 0)
R[32]="manual"
R[33]=$(has $zp 'T | TranscriptContext')
R[34]=$(has $cl 'getJSON')
R[35]=$(has $zp 'SESSION_SALT')
R[36]=$([ -n "$(git ls-files scripts/probe-ab.mjs)" ] && echo 1 || echo 0)
R[37]=$(has .github/workflows/ci.yml 'pnpm audit --audit-level=high')
R[38]=$(has $zp 'The full data and the two superseded arguments live in')
R[39]=$(has CHANGELOG.md 'published 2026-09-29 (2026-09-22 is the package')
R[40]=$(has tests/compatibility.test.mjs 'HERMETIC SANDBOX')
R[41]=$(has tests/catalog.test.mjs "a catalogue sync of EITHER kind")
R[42]=$(has tests/catalog.test.mjs 'share ONE Zen gate request')
R[43]=$(has tests/catalog.test.mjs 'concurrent forceRefresh calls share one sync')
R[44]=$(has tests/catalog.test.mjs 'a torn write is never observable')
R[45]=$(has tests/catalog.test.mjs 'readCache repairs a damaged probe map')
R[46]=$(has tests/client-render.test.mjs 'unmounting mid-round stops the poll chain')
R[47]=$(has tests/compatibility.test.mjs 'the probe budget must be the one constant')
R[48]=$(has tests/compatibility.test.mjs "await import('../src/index.ts')")
if [ "$(grep -c "await import('../src/index.ts')" tests/model-visibility.test.mjs)" = "0" ]; then R[48]=0; fi
R[49]=$(has tests/catalog.test.mjs 'one reading was taken per model, mid-round')
R[50]=$(has tests/catalog.test.mjs 'Gates, not wall clock')
R[51]=$(has tests/catalog.test.mjs 'concurrent runProbes share one round')

present=0; partial=0; deferred=0; missing=0
for i in $(seq 1 51); do
  v=${R[$i]}
  case "$v" in
    1) printf "  %-3s PRESENT\n" "#$i"; present=$((present+1));;
    manual) printf "  %-3s PRESENT (reviewed by hand, not greppable)\n" "#$i"; present=$((present+1));;
    deferred) printf "  %-3s DEFERRED by owner decision\n" "#$i"; deferred=$((deferred+1));;
    *) printf "  %-3s ** MISSING **\n" "#$i"; missing=$((missing+1));;
  esac
done
echo
echo "present=$present deferred=$deferred missing=$missing"
exit $((missing > 0))
