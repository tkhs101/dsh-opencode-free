import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  CACHE_VERSION,
  DEFAULT_USER_AGENT,
  MODELS_DEV_URL,
  cachePath,
  channelFor,
  createCatalog,
  derive,
  fetchSection,
  isActive,
  isFree,
  modelCapability,
  readCache,
  thinkingLevelMapFor,
  topThinkingLevel,
  writeCacheAtomic,
} from '../src/catalog.ts'

/**
 * Fixtures reproduce the REAL models.dev `api.json` shape as read on
 * 2026-09-29: a provider-keyed top level whose `opencode` entry is a PROVIDER
 * record ({id,env,npm,api,name,doc,models}) wrapping the model dictionary
 * (113 models, 34 zero-cost, 8 of those active).
 *
 * The wrapper used to be missing here, and that omission is exactly what let a
 * provider record reach `derive()` and produce an empty catalogue. `apiBody()`
 * is therefore the default fixture everywhere, and `deriveGuard` pins the
 * failure mode itself.
 */
const modelsDict = () => ({
  // active, completions via interleaved
  'big-pickle': {
    id: 'big-pickle',
    name: 'Big Pickle',
    reasoning: true,
    interleaved: { field: 'reasoning_content' },
    reasoning_options: [],
    cost: { input: 0, output: 0, cache_read: 0, cache_write: 0 },
    limit: { context: 200000, output: 32000 },
    modalities: { input: ['text'], output: ['text'] },
  },
  // active, completions via toggle (no interleaved)
  'ling-3.0-flash-fin-free': {
    id: 'ling-3.0-flash-fin-free',
    name: 'Ling 3.0 Flash Fin Free',
    reasoning_options: [{ type: 'toggle' }],
    cost: { input: 0, output: 0, cache_read: 0, cache_write: 0 },
  },
  // active, responses via effort
  'muse-spark-1.3-contributor-free': {
    id: 'muse-spark-1.3-contributor-free',
    name: 'Muse Spark 1.3 Free',
    reasoning_options: [{ type: 'effort', values: ['minimal', 'low', 'medium', 'high', 'xhigh'] }],
    cost: { input: 0, output: 0, cache_read: 0, cache_write: 0 },
    limit: { context: 1048576, output: 32768 },
  },
  // free but retired upstream
  'muse-spark-1.2-contributor-free': {
    id: 'muse-spark-1.2-contributor-free',
    name: 'Muse Spark 1.2 Free',
    status: 'deprecated',
    reasoning_options: [{ type: 'effort', values: ['minimal', 'low', 'medium', 'high', 'xhigh'] }],
    cost: { input: 0, output: 0, cache_read: 0, cache_write: 0 },
  },
  'deepseek-v4-flash-free': {
    id: 'deepseek-v4-flash-free',
    name: 'DeepSeek V4 Flash Free',
    status: 'deprecated',
    cost: { input: 0, output: 0, cache_read: 0, cache_write: 0 },
    limit: { context: 200000, output: 128000 },
  },
  // active with published limits, non-text modalities
  'space-bunny-free': {
    id: 'space-bunny-free',
    name: 'Space Bunny Free',
    attachment: true,
    reasoning: true,
    reasoning_options: [{ type: 'effort', values: ['low', 'medium', 'high', 'xhigh', 'max'] }],
    interleaved: { field: 'reasoning_content' },
    cost: { input: 0, output: 0, cache_read: 0, cache_write: 0 },
    limit: { context: 1048576, input: 524288, output: 524288 },
    modalities: { input: ['text', 'image', 'video'], output: ['text'] },
  },
  // paid model must never appear
  'gpt-6-astra': {
    id: 'gpt-6-astra',
    name: 'GPT 6 Astra',
    cost: { input: 1.25, output: 10, cache_read: 0, cache_write: 0 },
    modalities: { input: ['text', 'image'] },
  },
  // malformed shapes must be skipped, not thrown on
  'broken-null': null,
  'broken-array': [],
  'broken-nocost': { id: 'broken-nocost', name: 'No Cost' },
})

/** The provider record models.dev publishes for `opencode`, verbatim shape. */
const opencodeProvider = () => ({
  id: 'opencode',
  env: ['OPENCODE_API_KEY'],
  npm: '@ai-sdk/openai-compatible',
  api: 'https://opencode.ai/zen/v1',
  name: 'opencode',
  doc: 'https://opencode.ai/docs',
  models: modelsDict(),
})

/** A whole `api.json` body: provider-keyed, with opencode among the entries. */
const apiBodyWith = (models) => ({ ...apiBody(), opencode: { ...opencodeProvider(), models } })

const apiBody = () => ({
  anthropic: { id: 'anthropic', npm: '@ai-sdk/anthropic', models: { 'claude-opus-4-5': { id: 'claude-opus-4-5', cost: { input: 5, output: 25 } } } },
  opencode: opencodeProvider(),
  'z-ai': { id: 'z-ai', npm: '@ai-sdk/z-ai', models: { 'glm-5-free': { id: 'glm-5-free', cost: { input: 0, output: 0 }, status: 'deprecated' } } },
})

/** The identity-mapped pi-ai record every derived model inherits from. */
const template = () => ({
  id: 'template-model',
  name: 'Template',
  api: 'openai-completions',
  provider: 'opencode-zen-free',
  baseUrl: 'https://opencode.ai/zen/v1',
  reasoning: true,
  input: ['text', 'image'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 200000,
  maxTokens: 32000,
  headers: { 'User-Agent': 'opencode/1.18.31', 'x-opencode-client': 'cli' },
  compat: { supportsStore: false, supportsDeveloperRole: false, supportsStrictMode: true, maxTokensField: 'max_tokens' },
})

const baseline = () => [
  { ...template(), id: 'big-pickle', name: 'Big Pickle' },
  { ...template(), id: 'muse-spark-1.3-contributor-free', name: 'Muse Spark 1.3 Free', api: 'openai-responses', compat: undefined },
]

const ids = (models) => models.map((m) => m.id)
const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

/**
 * The warm start is deliberately fire-and-forget (a container must answer
 * synchronously), so how many turns a `readFile` takes is not a contract.
 * Poll for the condition instead of betting on a tick count.
 */
async function waitFor(predicate, attempts = 100) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (predicate()) return true
    await tick()
  }
  return false
}

function fakeResponse({ status = 200, etag = null, body = {} } = {}) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (name) => (name.toLowerCase() === 'etag' ? etag : null) },
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  }
}

function scriptedFetch(responses) {
  const calls = []
  const impl = async (url, init) => {
    calls.push({ url, headers: init.headers })
    const next = responses.shift()
    if (next === undefined) throw new Error('unexpected extra fetch')
    if (typeof next === 'function') return next(init)
    return next
  }
  impl.calls = calls
  return impl
}

async function withTempDir(run) {
  const dir = await mkdtemp(join(tmpdir(), 'catalog-test-'))
  try {
    return await run(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

// ── T1 derivation ───────────────────────────────────────────────────────────

test('isFree accepts only an all-zero cost object', () => {
  assert.equal(isFree({ cost: { input: 0, output: 0, cache_read: 0, cache_write: 0 } }), true)
  assert.equal(isFree({ cost: {} }), false, 'empty cost proves nothing')
  assert.equal(isFree({ cost: { input: 0, output: 1 } }), false)
  assert.equal(isFree({ cost: null }), false)
  assert.equal(isFree({}), false)
})

test('isFree treats a two-dimension zero cost as free (the rule, verbatim)', () => {
  // Observed: models.dev lists some free records with only input/output cost.
  // The pinned rule is "every declared value is 0", so this IS free.
  assert.equal(isFree({ cost: { input: 0, output: 0 } }), true)
})

test('isActive retires only status=deprecated', () => {
  assert.equal(isActive({}), true, 'models.dev omits status for active models')
  assert.equal(isActive({ status: 'deprecated' }), false)
  assert.equal(isActive({ status: 'preview' }), true)
})

test('derive keeps free-deprecated models in the catalogue and drops paid', () => {
  // D1 (model-probe) flipped the old D2 rule: `deprecated` on this provider
  // means both "gone" and "stale record" (muse-spark-1.2 and mimo-v2.5 are
  // deprecated and still answer; deepseek-v4-flash-free is deprecated and
  // dead), so no static field can decide visibility. `status` now only decides
  // membership; a probe decides visibility.
  const { candidates } = derive(modelsDict(), { template: template() })
  assert.deepEqual(ids(candidates).sort(), [
    'big-pickle',
    'deepseek-v4-flash-free',
    'ling-3.0-flash-fin-free',
    'muse-spark-1.2-contributor-free',
    'muse-spark-1.3-contributor-free',
    'space-bunny-free',
  ])
  assert.ok(!ids(candidates).includes('gpt-6-astra'), 'paid model must not be offered')
})

test('derive skips malformed records instead of throwing', () => {
  const { candidates } = derive(modelsDict(), { template: template() })
  for (const id of ['broken-null', 'broken-array', 'broken-nocost']) {
    assert.ok(!ids(candidates).includes(id), id)
  }
})

test('derive falls back to the section key when a record has no id', () => {
  const { candidates } = derive({ 'keyed-free': { cost: { input: 0, output: 0 } } }, { template: template() })
  assert.deepEqual(ids(candidates), ['keyed-free'])
  assert.equal(candidates[0].name, 'keyed-free', 'name falls back to the id')
})

test('channelFor infers completions from interleaved or a toggle', () => {
  assert.equal(channelFor({ id: 'x', interleaved: { field: 'reasoning_content' } }), 'openai-completions')
  assert.equal(channelFor({ id: 'x', reasoning_options: [{ type: 'toggle' }] }), 'openai-completions')
})

test('channelFor infers responses from an effort option', () => {
  assert.equal(
    channelFor({ id: 'x', reasoning_options: [{ type: 'effort', values: ['low', 'high'] }] }),
    'openai-responses',
  )
})

test('channelFor defaults to completions (opencode is openai-compatible)', () => {
  assert.equal(channelFor({ id: 'x' }), 'openai-completions')
  assert.equal(channelFor({ id: 'x', reasoning_options: [] }), 'openai-completions')
  assert.equal(channelFor({ id: 'x', reasoning_options: 'nonsense' }), 'openai-completions')
})

// ── capability alignment (models.dev is the source for all four) ────────────

/**
 * pi-ai's own reader, used as the oracle: these tests assert the LEVELS A HOST
 * WILL OFFER, not just the shape of the map we hand it. The two differ —
 * `xhigh`/`max` are opt-in (absent ⇒ not offered) while the lower levels are
 * offered unless explicitly nulled — and getting that backwards is exactly the
 * bug this alignment fixes.
 */
const { getSupportedThinkingLevels, clampThinkingLevel } = await import('@earendil-works/pi-ai')

test('thinkingLevelMapFor maps the published effort levels and nulls the rest', () => {
  // space-bunny-free, real record 2026-09-29. `off` stays absent (offered):
  // the placeholder effort that would otherwise reach the wire is stripped by
  // the plugin's onPayload guard instead (see the GUARD test in
  // compatibility.test.mjs).
  assert.deepEqual(thinkingLevelMapFor({ reasoning_options: [{ type: 'effort', values: ['low', 'medium', 'high', 'xhigh', 'max'] }] }), {
    minimal: null, low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'max',
  })
  // muse-spark, real record: no `max`, so it must not be offered.
  assert.deepEqual(thinkingLevelMapFor({ reasoning_options: [{ type: 'effort', values: ['minimal', 'low', 'medium', 'high', 'xhigh'] }] }), {
    minimal: 'minimal', low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh',
  })
  // Off is never claimed either way: it means "send no reasoning parameter".
  assert.equal(Object.prototype.hasOwnProperty.call(thinkingLevelMapFor({ reasoning_options: [{ type: 'effort', values: ['low'] }] }), 'off'), false)
})

test('thinkingLevelMapFor claims nothing when models.dev publishes no levels', () => {
  // A `toggle` model is reasoning on/off and pi-ai has no name for bare "on";
  // guessing would offer levels upstream rejects, which the host reports as
  // UNSUPPORTED_REASONING_EFFORT rather than clamping.
  assert.equal(thinkingLevelMapFor({ reasoning_options: [{ type: 'toggle' }] }), undefined)
  assert.equal(thinkingLevelMapFor({ reasoning_options: [] }), undefined)
  assert.equal(thinkingLevelMapFor({ reasoning_options: undefined }), undefined)
  assert.equal(thinkingLevelMapFor({ reasoning_options: 'nonsense' }), undefined)
  // An effort option with no usable level names is not a level list.
  assert.equal(thinkingLevelMapFor({ reasoning_options: [{ type: 'effort' }] }), undefined)
  assert.equal(thinkingLevelMapFor({ reasoning_options: [{ type: 'effort', values: [] }] }), undefined)
  assert.equal(thinkingLevelMapFor({ reasoning_options: [{ type: 'effort', values: ['turbo', 7, null] }] }), undefined)
  // Levels pi-ai does not know cannot be expressed, so a list of only those
  // makes no claim rather than producing an empty map.
  assert.equal(thinkingLevelMapFor({ reasoning_options: [{ type: 'effort', values: ['turbo'] }] }), undefined)
})

test('the levels a host offers follow models.dev, per model', () => {
  // The map the record produces, read back through pi-ai's own filter.
  // `off` is absent from every produced map, which is what keeps it offered —
  // the wire shape it would otherwise produce is guarded in zen-provider.ts.
  const of = (id) => getSupportedThinkingLevels({ id, reasoning: true, thinkingLevelMap: thinkingLevelMapFor(modelsDict()[id]) })
  assert.deepEqual(of('space-bunny-free'), ['off', 'low', 'medium', 'high', 'xhigh', 'max'])
  assert.deepEqual(of('muse-spark-1.3-contributor-free'), ['off', 'minimal', 'low', 'medium', 'high', 'xhigh'])
  // No published list: pi-ai's default set, unchanged from before this work.
  assert.deepEqual(of('big-pickle'), ['off', 'minimal', 'low', 'medium', 'high'])
  assert.deepEqual(of('ling-3.0-flash-fin-free'), ['off', 'minimal', 'low', 'medium', 'high'])
  // The derived records themselves carry the same maps.
  const derived = derive(modelsDict(), { template: template(), knownApis: new Map() })
  const spark = derived.candidates.find((m) => m.id === 'muse-spark-1.3-contributor-free')
  assert.deepEqual(getSupportedThinkingLevels(spark), ['off', 'minimal', 'low', 'medium', 'high', 'xhigh'])
})

test('GUARD: "off" is offered but never reaches the wire', () => {
  // pi-ai's responses transport renders an unoffered default as
  // `reasoning: { effort: "none" }` and an explicit "off" as `effort: "off"` —
  // two values neither pi-ai's own builtin records nor OpenCode ever send.
  // Keeping "off" offered is only safe because the plugin's onPayload guard
  // strips exactly those placeholders (see compatibility.test.mjs); this pins
  // the precondition that makes the guard necessary.
  const spark = derive(modelsDict(), { template: template(), knownApis: new Map() })
    .candidates.find((m) => m.id === 'muse-spark-1.3-contributor-free')
  assert.equal(getSupportedThinkingLevels(spark).includes('off'), true, 'off is offered')
  assert.equal(Object.prototype.hasOwnProperty.call(spark.thinkingLevelMap ?? {}, 'off'), false)
})

test('GUARD: the muse-spark xhigh default is no longer silently clamped away', async () => {
  // The plugin asks for `xhigh` on muse-spark (zen-provider streamSimple). With
  // no thinkingLevelMap, pi-ai's supported set tops out at `high` and the
  // request was quietly downgraded — the model never got the effort it was
  // asked for. Aligning the map from models.dev is what fixes it.
  const spark = derive(modelsDict(), { template: template(), knownApis: new Map() })
    .candidates.find((m) => m.id === 'muse-spark-1.3-contributor-free')
  assert.equal(clampThinkingLevel(spark, 'xhigh'), 'xhigh', 'the requested level survives')
  const bunny = derive(modelsDict(), { template: template(), knownApis: new Map() })
    .candidates.find((m) => m.id === 'space-bunny-free')
  assert.equal(clampThinkingLevel(bunny, 'max'), 'max', 'a published opt-in level is reachable')
  // A level the model does not publish clamps DOWN rather than being offered.
  assert.equal(getSupportedThinkingLevels(bunny).includes('minimal'), false)
})

test('a derived record carries all four capabilities from models.dev', () => {  const { candidates } = derive(modelsDict(), { template: template(), knownApis: new Map() })
  const bunny = candidates.find((m) => m.id === 'space-bunny-free')
  // modalities.input: pi-ai knows text/image only, so video is dropped rather
  // than passed through as a capability the transport cannot honour.
  assert.deepEqual(bunny.input, ['text', 'image'])
  assert.equal(bunny.contextWindow, 1048576, 'limit.context')
  assert.equal(bunny.maxTokens, 524288, 'limit.output')
  assert.equal(bunny.reasoning, true)
  // A model with no image support must not inherit the template's.
  const pickle = candidates.find((m) => m.id === 'big-pickle')
  assert.deepEqual(pickle.input, ['text'], 'text-only stays text-only')
  assert.equal(pickle.contextWindow, 200000)
  assert.equal(pickle.maxTokens, 32000)
  // A record that publishes nothing falls back to the template per field.
  const bare = derive({ 'bare-free': { id: 'bare-free', cost: { input: 0, output: 0 } } }, { template: template() })
    .candidates[0]
  assert.equal(bare.contextWindow, template().contextWindow)
  assert.equal(bare.maxTokens, template().maxTokens)
  assert.deepEqual(bare.input, template().input)
  // The template's level map is never inherited: it belongs to another model.
  assert.equal(bare.thinkingLevelMap, undefined)
})

// ── capability cards (what the detail-page panel renders per row) ──────────

test('topThinkingLevel reads the strongest published level, nothing else', () => {
  // The map's string entries ARE the published levels (identity values); null
  // entries and a missing map mean "no badge", not a default.
  assert.equal(topThinkingLevel({ id: 'x', thinkingLevelMap: { minimal: null, low: 'low', max: 'max' } }), 'max')
  assert.equal(topThinkingLevel({ id: 'x', thinkingLevelMap: { off: null, minimal: 'minimal' } }), 'minimal')
  assert.equal(topThinkingLevel({ id: 'x', thinkingLevelMap: { minimal: null, low: null } }), null)
  assert.equal(topThinkingLevel({ id: 'x', thinkingLevelMap: undefined }), null)
  assert.equal(topThinkingLevel({ id: 'x' }), null)
  assert.equal(topThinkingLevel({ id: 'x', thinkingLevelMap: { off: 'off' } }), null, 'off is never a badge')
})

test('modelCapability projects image and top level per record', () => {
  const { candidates } = derive(modelsDict(), { template: template(), knownApis: new Map() })
  const card = (id) => modelCapability(candidates.find((m) => m.id === id))
  assert.deepEqual(card('space-bunny-free'), { id: 'space-bunny-free', image: true, thinking: 'max' })
  assert.deepEqual(card('muse-spark-1.3-contributor-free'), { id: 'muse-spark-1.3-contributor-free', image: true, thinking: 'xhigh' })
  // Toggle-only and level-less records get no thinking badge. `ling` publishes
  // neither image input nor levels, so it inherits the template's text+image
  // input — the fallback pinned by the modalities test above. A badge rendered
  // from that record is faithful to the record; the record itself is a guess
  // for undeclared fields, which is what the template is for.
  assert.deepEqual(card('ling-3.0-flash-fin-free'), { id: 'ling-3.0-flash-fin-free', image: true, thinking: null })
  assert.deepEqual(card('big-pickle'), { id: 'big-pickle', image: false, thinking: null })
})

test('capabilities ride alongside visible, same ids in the same order', async () => {
  await withTempDir(async (dir) => {
    const probe = recordingProber({ 'deepseek-v4-flash-free': DEAD(404) })
    const catalog = await probedCatalog(dir, probe)
    await catalog.forceProbes()
    const state = catalog.current()
    assert.deepEqual(
      state.capabilities.map((c) => c.id),
      state.visible,
      'every visible id has exactly one card, in order',
    )
    const bunny = state.capabilities.find((c) => c.id === 'space-bunny-free')
    assert.equal(bunny.image, true)
    assert.equal(bunny.thinking, 'max')
    // Cards carry names and booleans only — never the full records.
    for (const card of state.capabilities) {
      assert.deepEqual(Object.keys(card).sort(), ['id', 'image', 'thinking'])
    }
  })
})

test('channelFor prefers the pi-ai builtin table over any signal', () => {
  const known = new Map([['big-pickle', 'openai-responses']])
  assert.equal(channelFor({ id: 'big-pickle', interleaved: { field: 'reasoning_content' } }, known), 'openai-responses')
  assert.equal(channelFor({ id: 'unknown', interleaved: { field: 'reasoning_content' } }, known), 'openai-completions')
})

test('channelFor reproduces the 7 known opencode models (7/7 agreement)', () => {
  // Ground truth is the pi-ai 0.85.1 builtin table read from node_modules.
  const truth = {
    'big-pickle': 'openai-completions',
    'ling-3.0-flash-fin-free': 'openai-completions',
    'mimo-v2.5-free': 'openai-completions',
    'nemotron-3-ultra-free': 'openai-completions',
    'nemotron-3.5-lightning-free': 'openai-completions',
    'muse-spark-1.2-contributor-free': 'openai-responses',
    'muse-spark-1.3-contributor-free': 'openai-responses',
  }
  for (const [id, expected] of Object.entries(truth)) {
    const record = modelsDict()[id] ?? {
      id,
      interleaved: { field: 'reasoning_content' },
      cost: { input: 0, output: 0 },
    }
    assert.equal(channelFor(record), expected, id)
  }
})

test('derive maps published limits and falls back per missing field', () => {
  const { candidates } = derive(modelsDict(), { template: template() })
  const bunny = candidates.find((m) => m.id === 'space-bunny-free')
  assert.equal(bunny.contextWindow, 1048576)
  assert.equal(bunny.maxTokens, 524288)
  // ling publishes no limit at all -> template values
  const ling = candidates.find((m) => m.id === 'ling-3.0-flash-fin-free')
  assert.equal(ling.contextWindow, 200000)
  assert.equal(ling.maxTokens, 32000)
  assert.equal(ling.name, 'Ling 3.0 Flash Fin Free')
})

test('derive keeps only text/image modalities and falls back when none survive', () => {
  const { candidates } = derive(modelsDict(), { template: template() })
  const bunny = candidates.find((m) => m.id === 'space-bunny-free')
  assert.deepEqual(bunny.input, ['text', 'image'], 'audio/video are not pi-ai input kinds')
  const ling = candidates.find((m) => m.id === 'ling-3.0-flash-fin-free')
  assert.deepEqual(ling.input, ['text', 'image'], 'no modalities -> template input')
})

test('derive inherits identity and zeroes cost on every candidate', () => {
  const { candidates } = derive(modelsDict(), { template: template() })
  for (const model of candidates) {
    assert.equal(model.provider, 'opencode-zen-free')
    assert.equal(model.baseUrl, 'https://opencode.ai/zen/v1')
    assert.equal(model.headers['x-opencode-client'], 'cli')
    assert.deepEqual(model.cost, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 })
  }
})

test('derive drops transport-specific compat when the channel changes', () => {
  const { candidates } = derive(modelsDict(), { template: template() })
  const completions = candidates.find((m) => m.id === 'big-pickle')
  assert.ok(completions.compat, 'same channel keeps the known-good overrides')
  const responses = candidates.find((m) => m.id === 'muse-spark-1.3-contributor-free')
  assert.equal(responses.api, 'openai-responses')
  assert.equal(responses.compat, undefined, "the template's completions compat must not leak onto responses")
})

// ── T2 fetch + cache ────────────────────────────────────────────────────────

test('GUARD: a provider record fed to derive yields an empty catalogue', () => {
  // This is the shipped defect, pinned: `api.json` keys providers, and
  // `body.opencode` is the PROVIDER record. derive() over it finds no cost on
  // any of {id,env,npm,api,name,doc,models} and silently returns nothing —
  // an EMPTY catalogue, worse than the 7-model offline floor.
  const provider = opencodeProvider()
  const { candidates } = derive(provider, { template: template() })
  assert.deepEqual(candidates, [], 'a provider record must never look like a catalogue')
  // ...and the real shape does produce one, from the same response body.
  const correct = derive(provider.models, { template: template() })
  assert.ok(correct.candidates.length > 0, 'the models dictionary does produce candidates')
})

test('GUARD: fetchSection output feeds derive directly from a real api.json body', async () => {
  const result = await fetchSection({ fetchImpl: scriptedFetch([fakeResponse({ body: apiBody() })]) })
  assert.equal(result.kind, 'ok')
  assert.equal(Object.prototype.hasOwnProperty.call(result.section, 'models'), false, 'the wrapper is unwrapped here')
  const { candidates } = derive(result.section, { template: template() })
  assert.deepEqual(ids(candidates).sort(), [
    'big-pickle',
    'deepseek-v4-flash-free',
    'ling-3.0-flash-fin-free',
    'muse-spark-1.2-contributor-free',
    'muse-spark-1.3-contributor-free',
    'space-bunny-free',
  ])
})

test('fetchSection returns the models dictionary and the etag on 200', async () => {
  const fetchImpl = scriptedFetch([fakeResponse({ etag: '"abc"', body: apiBody() })])
  const result = await fetchSection({ fetchImpl })
  assert.equal(result.kind, 'ok')
  assert.equal(result.etag, '"abc"')
  assert.deepEqual(Object.keys(result.section).sort(), Object.keys(modelsDict()).sort())
  assert.equal(fetchImpl.calls[0].url, MODELS_DEV_URL)
})

test('fetchSection reports 304 as not-modified', async () => {
  const fetchImpl = scriptedFetch([fakeResponse({ status: 304 })])
  assert.deepEqual(await fetchSection({ fetchImpl }), { kind: 'not-modified' })
})

test('fetchSection reports http, malformed, missing-section and oversize as failed', async () => {
  const cases = [
    [fakeResponse({ status: 500 }), 'http 500'],
    [fakeResponse({ body: 'not json at all' }), 'malformed response body'],
    [fakeResponse({ body: '[]' }), 'malformed response body'],
    [fakeResponse({ body: { anthropic: {} } }), 'missing opencode section'],
    [fakeResponse({ body: { opencode: 'nope' } }), 'missing opencode section'],
    // a provider record without its models dictionary is a failure, not an empty catalogue
    [fakeResponse({ body: { opencode: { id: 'opencode', npm: '@ai-sdk/openai-compatible' } } }), 'missing opencode models section'],
    [fakeResponse({ body: { opencode: { models: [] } } }), 'missing opencode models section'],
  ]
  for (const [response, reason] of cases) {
    const result = await fetchSection({ fetchImpl: scriptedFetch([response]) })
    assert.equal(result.kind, 'failed', reason)
    assert.equal(result.reason, reason)
  }
  const oversize = await fetchSection({ fetchImpl: scriptedFetch([fakeResponse({ body: apiBody() })]), maxBytes: 10 })
  assert.deepEqual(oversize, { kind: 'failed', reason: 'response too large' })
})

test('fetchSection classifies a timeout and never throws', async () => {
  const aborted = () => {
    const error = new Error('aborted')
    error.name = 'AbortError'
    throw error
  }
  const timedOut = await fetchSection({ fetchImpl: scriptedFetch([aborted]) })
  assert.deepEqual(timedOut, { kind: 'failed', reason: 'timeout' })
  const offline = await fetchSection({ fetchImpl: scriptedFetch([() => { throw new Error('getaddrinfo ENOTFOUND') }]) })
  assert.deepEqual(offline, { kind: 'failed', reason: 'getaddrinfo ENOTFOUND' })
})

test('fetchSection identifies itself honestly and never borrows the Zen identity', async () => {
  const fetchImpl = scriptedFetch([fakeResponse({ body: apiBody() })])
  await fetchSection({ fetchImpl })
  const headers = fetchImpl.calls[0].headers
  assert.equal(headers.accept, 'application/json')
  assert.equal(headers['user-agent'], DEFAULT_USER_AGENT)
  assert.match(headers['user-agent'], /^dsh-opencode-free\//)
  assert.ok(!headers['user-agent'].includes('opencode/'), 'must not impersonate the OpenCode CLI to models.dev')
  assert.equal(headers['if-none-match'], undefined)
})

test('fetchSection sends if-none-match only when an etag is supplied', async () => {
  const warm = scriptedFetch([fakeResponse({ etag: '"v1"', body: apiBody() })])
  await fetchSection({ fetchImpl: warm, etag: '"v1"' })
  assert.equal(warm.calls[0].headers['if-none-match'], '"v1"')
  const blank = scriptedFetch([fakeResponse({ body: apiBody() })])
  await fetchSection({ fetchImpl: blank, etag: '' })
  assert.equal(blank.calls[0].headers['if-none-match'], undefined)
})

test('cachePath honours DSH_HOME and falls back to ~/.dsh', () => {
  const expected = join(homedir(), '.dsh', 'dsh-opencode-free', 'catalog.json')
  assert.equal(cachePath({ DSH_HOME: '/custom/home' }), join('/custom/home', 'dsh-opencode-free', 'catalog.json'))
  assert.equal(cachePath({}), expected)
  assert.equal(cachePath({ DSH_HOME: '' }), expected, 'an empty DSH_HOME is not a home')
})

test('cache round-trips atomically and stores only the models dictionary', async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, 'nested', 'catalog.json')
    assert.equal(await writeCacheAtomic(path, { etag: '"v1"', fetchedAt: 123, models: modelsDict() }), true)
    const restored = await readCache(path)
    assert.equal(restored.version, CACHE_VERSION)
    assert.equal(restored.etag, '"v1"')
    assert.equal(restored.fetchedAt, 123)
    assert.deepEqual(Object.keys(restored.models).sort(), Object.keys(modelsDict()).sort())
    const onDisk = JSON.parse(await readFile(path, 'utf8'))
    assert.deepEqual(Object.keys(onDisk).sort(), ['etag', 'fetchedAt', 'models', 'version'])
    assert.equal(onDisk.api, undefined, 'provider base url is not persisted')
  })
})

test('readCache treats missing, corrupt and foreign-version files as no cache', async () => {
  await withTempDir(async (dir) => {
    assert.equal(await readCache(join(dir, 'absent.json')), null)
    const corrupt = join(dir, 'corrupt.json')
    await writeFile(corrupt, '{ truncated', 'utf8')
    assert.equal(await readCache(corrupt), null)
    const future = join(dir, 'future.json')
    await writeFile(future, JSON.stringify({ version: 99, models: {} }), 'utf8')
    assert.equal(await readCache(future), null)
    const wrongShape = join(dir, 'shape.json')
    await writeFile(wrongShape, JSON.stringify({ version: 1, models: 'nope' }), 'utf8')
    assert.equal(await readCache(wrongShape), null)
  })
})

test('readCache rejects a file still carrying the old `opencode` field', async () => {
  await withTempDir(async (dir) => {
    // The rename guard: a cache written before the field was renamed holds the
    // PROVIDER record, which would derive to an empty catalogue. It must read
    // as "no cache" so the next read re-downloads instead of emptying the picker.
    const legacy = join(dir, 'legacy.json')
    await writeFile(legacy, JSON.stringify({ version: CACHE_VERSION, etag: '"v1"', fetchedAt: 1, opencode: opencodeProvider() }), 'utf8')
    assert.equal(await readCache(legacy), null)
  })
})

// ── T3 state container ──────────────────────────────────────────────────────

function catalogWith({ dir, fetchImpl, clock = { t: 1_000_000 }, ttlMs, baselineModels = baseline(), probe } = {}) {
  return createCatalog({
    template: template(),
    builtinBaseline: baselineModels,
    knownApis: new Map(),
    cachePath: join(dir, 'catalog.json'),
    fetchImpl,
    now: () => clock.t,
    ...(ttlMs === undefined ? {} : { ttlMs }),
    ...(probe === undefined ? {} : { probe }),
  })
}

test('a fresh container serves the offline floor before any sync', async () => {
  await withTempDir(async (dir) => {
    const catalog = catalogWith({ dir, fetchImpl: scriptedFetch([]) })
    const state = catalog.current()
    assert.equal(state.source, 'builtin-fallback')
    assert.deepEqual(ids(state.models), ['big-pickle', 'muse-spark-1.3-contributor-free'])
    assert.deepEqual(state.visible, ['big-pickle', 'muse-spark-1.3-contributor-free'])
    assert.equal(state.updatedAt, 0)
    assert.equal(state.refreshing, false)
  })
})

test('ensureFresh does nothing while the cache is within the TTL', async () => {
  await withTempDir(async (dir) => {
    const fetchImpl = scriptedFetch([fakeResponse({ etag: '"v1"', body: apiBody() })])
    const clock = { t: 1_000_000 }
    const catalog = catalogWith({ dir, fetchImpl, clock, ttlMs: 60_000 })
    await catalog.forceRefresh()
    assert.equal(fetchImpl.calls.length, 1)
    clock.t += 30_000
    await catalog.ensureFresh()
    assert.equal(fetchImpl.calls.length, 1, 'still fresh')
    assert.equal(catalog.current().source, 'models.dev')
  })
})

test('ensureFresh revalidates past the TTL and adopts the derived catalogue', async () => {
  await withTempDir(async (dir) => {
    const fetchImpl = scriptedFetch([
      fakeResponse({ etag: '"v1"', body: apiBody() }),
      fakeResponse({ status: 304 }),
    ])
    const clock = { t: 1_000_000 }
    const catalog = catalogWith({ dir, fetchImpl, clock, ttlMs: 60_000 })
    await catalog.forceRefresh()
    assert.deepEqual(catalog.current().visible.sort(), [
      'big-pickle',
      'deepseek-v4-flash-free',
      'ling-3.0-flash-fin-free',
      'muse-spark-1.2-contributor-free',
      'muse-spark-1.3-contributor-free',
      'space-bunny-free',
    ])
    clock.t += 120_000
    await catalog.ensureFresh()
    assert.equal(fetchImpl.calls.length, 2)
    assert.equal(fetchImpl.calls[1].headers['if-none-match'], '"v1"', 'a warm etag is reused')
  })
})

test('concurrent ensureFresh calls share a single in-flight sync', async () => {
  await withTempDir(async (dir) => {
    const fetchImpl = scriptedFetch([fakeResponse({ body: apiBody() })])
    const catalog = catalogWith({ dir, fetchImpl, ttlMs: 0 })
    await Promise.all([catalog.ensureFresh(), catalog.ensureFresh(), catalog.ensureFresh()])
    assert.equal(fetchImpl.calls.length, 1)
  })
})

test('without a cache the conditional header is never sent (R5)', async () => {
  await withTempDir(async (dir) => {
    const fetchImpl = scriptedFetch([fakeResponse({ status: 304, etag: '"v1"' })])
    const catalog = catalogWith({ dir, fetchImpl, ttlMs: 0 })
    await catalog.ensureFresh()
    assert.equal(fetchImpl.calls[0].headers['if-none-match'], undefined, 'a 304 with no cache would lose the catalogue')
  })
})

test('a 304 only bumps freshness, it does not rebuild or empty the catalogue', async () => {
  await withTempDir(async (dir) => {
    const fetchImpl = scriptedFetch([
      fakeResponse({ etag: '"v1"', body: apiBody() }),
      fakeResponse({ status: 304 }),
    ])
    const clock = { t: 1_000_000 }
    const catalog = catalogWith({ dir, fetchImpl, clock, ttlMs: 10 })
    await catalog.forceRefresh()
    const before = catalog.current()
    clock.t += 100
    await catalog.ensureFresh()
    const after = catalog.current()
    assert.deepEqual(after.visible, before.visible)
    assert.equal(after.source, 'models.dev')
    assert.equal(after.updatedAt, clock.t, 'freshness advanced so the next read is quiet')
  })
})

test('a failed sync preserves the current catalogue', async () => {
  await withTempDir(async (dir) => {
    const fetchImpl = scriptedFetch([
      fakeResponse({ etag: '"v1"', body: apiBody() }),
      fakeResponse({ status: 503 }),
    ])
    const clock = { t: 1_000_000 }
    const catalog = catalogWith({ dir, fetchImpl, clock, ttlMs: 10 })
    await catalog.forceRefresh()
    const before = catalog.current()
    clock.t += 100
    await catalog.ensureFresh()
    const after = catalog.current()
    assert.deepEqual(after.visible, before.visible)
    assert.equal(after.source, 'models.dev')
    assert.equal(after.updatedAt, before.updatedAt, 'a failure does not pretend to be fresh')
  })
})

test('a failed first sync leaves the offline floor in place', async () => {
  await withTempDir(async (dir) => {
    const fetchImpl = scriptedFetch([() => { throw new Error('offline') }])
    const catalog = catalogWith({ dir, fetchImpl, ttlMs: 0 })
    await catalog.ensureFresh()
    const state = catalog.current()
    assert.equal(state.source, 'builtin-fallback')
    assert.deepEqual(ids(state.models), ['big-pickle', 'muse-spark-1.3-contributor-free'])
  })
})

test('a warm cache is adopted on start without touching the network', async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, 'catalog.json')
    await writeCacheAtomic(path, { etag: '"v1"', fetchedAt: 900_000, models: modelsDict() })
    const fetchImpl = scriptedFetch([])
    const catalog = catalogWith({ dir, fetchImpl, clock: { t: 1_000_000 }, ttlMs: 60_000 })
    assert.equal(await waitFor(() => catalog.current().source === 'models.dev'), true, 'the warm cache was adopted')
    const state = catalog.current()
    assert.equal(state.source, 'models.dev')
    assert.equal(state.updatedAt, 900_000)
    assert.equal(fetchImpl.calls.length, 0, 'a fresh cache answers without a download')
    assert.ok(state.visible.includes('space-bunny-free'))
  })
})

test('the Zen gate narrows visible, and nothing else is reported', async () => {
  await withTempDir(async (dir) => {
    const catalog = catalogWith({ dir, fetchImpl: scriptedFetch([fakeResponse({ body: apiBody() })]) })
    await catalog.forceRefresh()
    catalog.applyZenGate(['big-pickle', 'space-bunny-free', 'not-in-catalogue'])
    const state = catalog.current()
    assert.deepEqual(state.visible, ['big-pickle', 'space-bunny-free'])
    // There is no companion list naming what was dropped — not for a gate
    // artifact, not for a dead verdict. A model that is not offered is simply
    // not in `visible`.
    assert.deepEqual(Object.keys(state).sort(), [
      'capabilities', 'models', 'probeInconclusive', 'probedAt', 'refreshing', 'source', 'updatedAt', 'visible',
    ])
    assert.deepEqual(ids(catalog.effectiveModels()), ['big-pickle', 'space-bunny-free'])
  })
})

test('a null Zen gate never narrows an existing one', async () => {
  await withTempDir(async (dir) => {
    const catalog = catalogWith({ dir, fetchImpl: scriptedFetch([fakeResponse({ body: apiBody() })]) })
    await catalog.forceRefresh()
    catalog.applyZenGate(['big-pickle'])
    catalog.applyZenGate(null)
    assert.deepEqual(catalog.current().visible, ['big-pickle'], 'Zen being unreachable must not empty the picker')
  })
})

test('effectiveModels and visible stay the same set after a re-sync', async () => {
  await withTempDir(async (dir) => {
    const fetchImpl = scriptedFetch([
      fakeResponse({ body: apiBody() }),
      // upstream dropped space-bunny-free from its free list entirely
      fakeResponse({ body: apiBodyWith({ 'big-pickle': modelsDict()['big-pickle'] }) }),
    ])
    const clock = { t: 1_000_000 }
    const catalog = catalogWith({ dir, fetchImpl, clock, ttlMs: 10 })
    await catalog.forceRefresh()
    catalog.applyZenGate(['big-pickle', 'space-bunny-free'])
    clock.t += 100
    await catalog.ensureFresh()
    const state = catalog.current()
    assert.deepEqual(state.visible, ['big-pickle'], 'the re-derived catalogue was re-gated')
    assert.deepEqual(ids(catalog.effectiveModels()), state.visible, 'picker and panel read one set')
    // A model models.dev dropped altogether is simply gone: it leaves the
    // catalogue, the visible list, and every other report.
    assert.ok(!state.models.some((m) => m.id === 'space-bunny-free'))
  })
})

test('a 304 also refreshes the cache file, so the next boot stays quiet', async () => {
  await withTempDir(async (dir) => {
    const fetchImpl = scriptedFetch([
      fakeResponse({ etag: '"v1"', body: apiBody() }),
      fakeResponse({ status: 304 }),
    ])
    const clock = { t: 1_000_000 }
    const catalog = catalogWith({ dir, fetchImpl, clock, ttlMs: 10 })
    await catalog.forceRefresh()
    clock.t += 100
    await catalog.ensureFresh()
    const onDisk = JSON.parse(await readFile(join(dir, 'catalog.json'), 'utf8'))
    assert.equal(onDisk.fetchedAt, clock.t, 'freshness persisted, not just held in memory')
    assert.equal(onDisk.etag, '"v1"')
  })
})

test('the snapshot is a copy, so callers cannot mutate catalogue state', async () => {
  await withTempDir(async (dir) => {
    const catalog = catalogWith({ dir, fetchImpl: scriptedFetch([fakeResponse({ body: apiBody() })]) })
    await catalog.forceRefresh()
    const state = catalog.current()
    state.models.push({ ...template(), id: 'injected' })
    state.visible.push('injected')
    assert.ok(!catalog.current().visible.includes('injected'))
  })
})

// ── T4 availability probe (model-probe D2–D6) ───────────────────────────────

/** The verdict text `probeModel` produces, kept out of the assertions below. */
const DEAD = (status) => ({ kind: 'dead', reason: `probe says gone (HTTP ${status})` })

/**
 * A prober that records call order and never overlaps. The round spends a
 * shared anonymous-quota bucket, so "sequential" is a cost property rather
 * than a style choice — which is why it is asserted and not assumed.
 */
function recordingProber(verdicts = {}) {
  const calls = []
  let inFlight = 0
  let overlapped = false
  const probe = async (model) => {
    calls.push(model.id)
    inFlight += 1
    if (inFlight > 1) overlapped = true
    await tick()
    inFlight -= 1
    return verdicts[model.id] ?? { kind: 'ok' }
  }
  probe.calls = calls
  probe.overlapped = () => overlapped
  return probe
}

/** A catalogue carrying the real derived set, ready to probe. */
async function probedCatalog(dir, probe, clock = { t: 1_000_000 }) {
  const catalog = catalogWith({
    dir,
    clock,
    fetchImpl: scriptedFetch([fakeResponse({ body: apiBody() })]),
    probe,
  })
  await catalog.forceRefresh()
  return catalog
}

const DERIVED = [
  'big-pickle',
  'deepseek-v4-flash-free',
  'ling-3.0-flash-fin-free',
  'muse-spark-1.2-contributor-free',
  'muse-spark-1.3-contributor-free',
  'space-bunny-free',
]

test('a round covers the whole pre-gate catalogue, in order, one at a time', async () => {
  await withTempDir(async (dir) => {
    const probe = recordingProber()
    const catalog = await probedCatalog(dir, probe)
    // Gate first, to prove the round covers the pre-gate set and not the
    // narrowed one: a model Zen does not list still deserves a verdict.
    catalog.applyZenGate(['big-pickle', 'space-bunny-free'])
    await catalog.forceProbes()
    assert.deepEqual(
      probe.calls,
      catalog.current().models.map((m) => m.id),
      'every derived model, in catalogue order',
    )
    assert.deepEqual(probe.calls.slice().sort(), DERIVED, 'and that is the whole derived set')
    assert.equal(probe.overlapped(), false, 'requests must not overlap')
  })
})

test('dead removes a model from every list; ok changes nothing', async () => {
  await withTempDir(async (dir) => {
    const probe = recordingProber({ 'deepseek-v4-flash-free': DEAD(404) })
    const catalog = await probedCatalog(dir, probe)
    const before = catalog.current().visible.slice().sort()
    assert.deepEqual(before, DERIVED)
    await catalog.forceProbes()
    const state = catalog.current()
    assert.ok(!state.visible.includes('deepseek-v4-flash-free'), 'a dead model leaves the picker')
    // "Not in the list" is the whole contract: the snapshot carries no
    // companion list of unavailable models that could drift or be re-shown.
    assert.equal(Object.prototype.hasOwnProperty.call(state, 'excluded'), false)
    // It stays in the pre-gate catalogue, which is the target list every round
    // walks — otherwise it could never be re-probed and could never return.
    assert.ok(state.models.some((m) => m.id === 'deepseek-v4-flash-free'))
    assert.equal(state.visible.length, before.length - 1, 'an ok verdict adds nothing back')
    assert.equal(state.probeInconclusive, false)
    assert.equal(state.probedAt, 1_000_000)
  })
})

test('a dead verdict is final: the model is never probed again', async () => {
  await withTempDir(async (dir) => {
    // The cost argument, pinned: re-asking a model the route already refused
    // spends the shared bucket to re-learn a settled fact. A catalogue whose
    // first round kills 24 of 34 must probe 10 the next day, not 34.
    const probe = recordingProber({ 'deepseek-v4-flash-free': DEAD(404) })
    const catalog = await probedCatalog(dir, probe)
    await catalog.forceProbes()
    assert.equal(probe.calls.length, DERIVED.length, 'round one covers everything')
    probe.calls.length = 0
    await catalog.forceProbes()
    assert.deepEqual(probe.calls.slice().sort(), DERIVED.filter((id) => id !== 'deepseek-v4-flash-free'))
    assert.ok(!catalog.current().visible.includes('deepseek-v4-flash-free'))

    // Still final after a re-sync and across a restart — including the case
    // that used to resurrect it: `adopt` prunes verdicts for models the
    // catalogue lacks, so a dead model must NOT be dropped from `models`.
    const resynced = catalogWith({
      dir,
      fetchImpl: scriptedFetch([fakeResponse({ etag: '"v2"', body: apiBody() })]),
      probe,
      baselineModels: [],
    })
    await waitFor(() => resynced.current().source === 'models.dev')
    assert.ok(resynced.current().models.some((m) => m.id === 'deepseek-v4-flash-free'), 'the record is kept')
    assert.ok(!resynced.current().visible.includes('deepseek-v4-flash-free'), 'the verdict survived the re-sync')
    probe.calls.length = 0
    await resynced.forceProbes()
    assert.ok(!probe.calls.includes('deepseek-v4-flash-free'), 'and it is not re-asked')
  })
})

test('probeProgress tracks the round live: current, done/total and per-model results', async () => {
  await withTempDir(async (dir) => {
    const seen = []
    const clock = { t: 1_000_000 }
    const probe = async (model) => {
      // A slow model first, so the mid-round read catches it in flight.
      if (model.id === 'ling-3.0-flash-fin-free') await new Promise((resolve) => setTimeout(resolve, 50))
      clock.t += model.id === 'deepseek-v4-flash-free' ? 0 : 120
      seen.push({ ...catalog.probeProgress(), at: model.id })
      if (model.id === 'deepseek-v4-flash-free') return DEAD(404)
      return { kind: 'ok' }
    }
    const catalog = await probedCatalog(dir, probe, clock)
    assert.deepEqual(catalog.probeProgress(), {
      running: false, total: 0, done: 0, current: null, results: {}, startedAt: 0,
    }, 'no round has ever run')
    const running = catalog.forceProbes()
    // Let the first model start, then read mid-round.
    await new Promise((resolve) => setTimeout(resolve, 10))
    const mid = catalog.probeProgress()
    assert.equal(mid.running, true)
    assert.equal(mid.total, DERIVED.length)
    assert.ok(typeof mid.current === 'string' && mid.current !== '', 'one model is in flight')
    assert.equal(mid.startedAt, 1_000_000)
    await running
    const end = catalog.probeProgress()
    assert.equal(end.running, false)
    assert.equal(end.done, DERIVED.length)
    assert.equal(end.current, null)
    assert.equal(end.results['big-pickle'].status, 'ok')
    assert.equal(end.results['big-pickle'].ms, 120)
    assert.equal(end.results['deepseek-v4-flash-free'].status, 'failed', 'dead counts as not-answered for the row')
    assert.equal(end.results['deepseek-v4-flash-free'].ms, 0)
    // The verdicts (not the progress) are what persist.
    assert.ok(!catalog.current().visible.includes('deepseek-v4-flash-free'))
  })
})

test('probeProgress is a copy: the panel cannot mutate round state', async () => {
  await withTempDir(async (dir) => {
    const catalog = await probedCatalog(dir, recordingProber())
    await catalog.forceProbes()
    const first = catalog.probeProgress()
    first.results['big-pickle'] = { status: 'failed', ms: 0 }
    assert.equal(catalog.probeProgress().results['big-pickle'].status, 'ok')
  })
})

test('D5 GUARD: an all-gated round leaves visibility unchanged and persists no verdict', async () => {
  await withTempDir(async (dir) => {
    // The failure this whole design exists to prevent: one gated egress IP
    // makes every model answer 403 at once, and if that reached `dead` the
    // entire catalogue would empty itself.
    const gated = { kind: 'inconclusive', reason: 'anon-gated (HTTP 403)' }
    const probe = recordingProber(Object.fromEntries(DERIVED.map((id) => [id, gated])))
    const catalog = await probedCatalog(dir, probe)
    const before = catalog.current()
    await catalog.forceProbes()
    const after = catalog.current()
    assert.deepEqual(after.visible, before.visible, 'visibility unchanged')
    assert.equal(after.probeInconclusive, true, 'the panel is told the round is untrustworthy')
    // `inconclusive` is never persisted, only the round marker — so a fully
    // gated day does not re-probe on every read.
    const onDisk = JSON.parse(await readFile(join(dir, 'catalog.json'), 'utf8'))
    assert.equal(onDisk.probes, undefined, 'no inconclusive verdict is ever written')
    assert.equal(onDisk.lastProbeAt, 1_000_000, 'the round marker is written anyway')
  })
})

test('a prober that rejects is treated as no conclusion, not as dead', async () => {
  await withTempDir(async (dir) => {
    const probe = async (model) => {
      if (model.id === 'big-pickle') throw new Error('probe transport exploded')
      return { kind: 'ok' }
    }
    const catalog = await probedCatalog(dir, probe)
    const before = catalog.current().visible.slice()
    await catalog.forceProbes()
    const after = catalog.current()
    assert.deepEqual(after.visible, before, 'a thrown prober must not narrow anything')
    assert.equal(after.probeInconclusive, true)
  })
})

test('probing is a no-op without a prober, and never throws', async () => {
  await withTempDir(async (dir) => {
    const catalog = await probedCatalog(dir, undefined)
    await catalog.forceProbes()
    await catalog.runProbes()
    assert.equal(catalog.current().probedAt, 0, 'no prober, no round marker')
  })
})

test('runProbes allows one round per local day; forceProbes ignores the gate', async () => {
  await withTempDir(async (dir) => {
    const probe = recordingProber()
    const catalog = await probedCatalog(dir, probe)
    await catalog.runProbes()
    assert.equal(probe.calls.length, DERIVED.length)
    await catalog.runProbes()
    assert.equal(probe.calls.length, DERIVED.length, 'same day: no second round')
    await catalog.forceProbes()
    assert.equal(probe.calls.length, DERIVED.length * 2, 'the manual button always asks')
    probe.calls.length = 0
    const clock = { t: new Date(2026, 8, 30, 12, 0, 0).getTime() }
    const later = catalogWith({
      dir,
      clock,
      fetchImpl: scriptedFetch([fakeResponse({ body: apiBody() })]),
      probe,
    })
    await later.forceRefresh()
    await later.runProbes()
    assert.equal(probe.calls.length, DERIVED.length, 'a new local day permits one round')
  })
})

test('the daily gate compares local calendar days, not a rolling 24 hours', async () => {
  await withTempDir(async (dir) => {
    // Pinned deliberately: a rolling 24h window would allow a second round
    // 23h59m after the first. The other edge, 23:50 then 00:10, IS allowed,
    // because those are different days — see probedToday() in catalog.ts.
    const probe = recordingProber()
    const catalog = await probedCatalog(dir, probe, { t: new Date(2026, 8, 29, 12, 0, 0).getTime() })
    await catalog.runProbes()
    assert.equal(probe.calls.length, DERIVED.length)
    const sameDay = catalogWith({
      dir,
      clock: { t: new Date(2026, 8, 29, 23, 50, 0).getTime() },
      fetchImpl: scriptedFetch([fakeResponse({ body: apiBody() })]),
      probe,
    })
    await sameDay.forceRefresh()
    await sameDay.runProbes()
    assert.equal(probe.calls.length, DERIVED.length, 'same local day: no second round')
    const nextDay = catalogWith({
      dir,
      clock: { t: new Date(2026, 8, 30, 0, 10, 0).getTime() },
      fetchImpl: scriptedFetch([fakeResponse({ body: apiBody() })]),
      probe,
    })
    await nextDay.forceRefresh()
    await nextDay.runProbes()
    assert.equal(probe.calls.length, DERIVED.length * 2, 'a new local day permits one round')
  })
})

test('concurrent probe calls share one round', async () => {
  await withTempDir(async (dir) => {
    const probe = recordingProber()
    const catalog = await probedCatalog(dir, probe)
    await Promise.all([catalog.forceProbes(), catalog.forceProbes(), catalog.forceProbes()])
    assert.equal(probe.calls.length, DERIVED.length, 'one round, not three')
  })
})

test('verdicts round-trip through the cache file and survive a restart', async () => {
  await withTempDir(async (dir) => {
    const probe = recordingProber({ 'muse-spark-1.2-contributor-free': DEAD(410) })
    const catalog = await probedCatalog(dir, probe)
    await catalog.forceProbes()
    const onDisk = JSON.parse(await readFile(join(dir, 'catalog.json'), 'utf8'))
    assert.deepEqual(Object.keys(onDisk.probes).sort(), DERIVED.slice().sort(), 'ok is recorded too')
    assert.equal(onDisk.probes['muse-spark-1.2-contributor-free'].verdict, 'dead')
    assert.equal(onDisk.probes['muse-spark-1.2-contributor-free'].at, 1_000_000)

    // A restart adopts the verdicts without probing: the dead model must not
    // reappear just because the process restarted.
    const restarted = catalogWith({
      dir,
      fetchImpl: scriptedFetch([]),
      baselineModels: [],
      probe: async () => {
        throw new Error('must not probe on a warm start')
      },
    })
    assert.equal(await waitFor(() => restarted.current().source === 'models.dev'), true)
    assert.ok(!restarted.current().visible.includes('muse-spark-1.2-contributor-free'))
  })
})

test('a cache with no probes field is "never probed", not an error', async () => {
  await withTempDir(async (dir) => {
    await writeFile(
      join(dir, 'catalog.json'),
      JSON.stringify({ version: CACHE_VERSION, etag: '"v1"', fetchedAt: 1_000_000, models: modelsDict() }),
      'utf8',
    )
    const catalog = catalogWith({ dir, fetchImpl: scriptedFetch([]), baselineModels: [] })
    assert.equal(await waitFor(() => catalog.current().source === 'models.dev'), true)
    const state = catalog.current()
    assert.deepEqual(state.visible.slice().sort(), DERIVED, 'everything is offered again')
    assert.equal(state.probedAt, 0)
  })
})

test('effectiveModels and the panel visible stay one set after a probe', async () => {
  await withTempDir(async (dir) => {
    const probe = recordingProber({ 'big-pickle': DEAD(404), 'muse-spark-1.2-contributor-free': DEAD(404) })
    const catalog = await probedCatalog(dir, probe)
    await catalog.forceProbes()
    assert.deepEqual(ids(catalog.effectiveModels()), catalog.current().visible)
  })
})

test('a verdict for a model the catalogue dropped is pruned from the cache', async () => {
  await withTempDir(async (dir) => {
    const probe = recordingProber({ 'space-bunny-free': DEAD(404) })
    const catalog = await probedCatalog(dir, probe)
    await catalog.forceProbes()
    assert.ok(!catalog.current().visible.includes('space-bunny-free'))
    // Upstream removes it entirely. Nothing will ever probe it again, so its
    // verdict can never change — keeping it would grow the cache file without
    // bound across upstream removals.
    const reSynced = catalogWith({
      dir,
      fetchImpl: scriptedFetch([fakeResponse({ body: apiBodyWith({ 'big-pickle': modelsDict()['big-pickle'] }) })]),
      baselineModels: [],
    })
    await reSynced.forceRefresh()
    assert.deepEqual(reSynced.current().visible, ['big-pickle'])
    const onDisk = JSON.parse(await readFile(join(dir, 'catalog.json'), 'utf8'))
    assert.deepEqual(Object.keys(onDisk.probes ?? {}), ['big-pickle'], 'the dead verdict for a vanished model is gone')
  })
})

test('GUARD: a warm start landing after a sync cannot resurrect the older catalogue', async () => {
  await withTempDir(async (dir) => {
    // The container must answer synchronously, so the warm start reads the
    // cache in the background while the first ensureFresh downloads. If the
    // warm start then adopts, the OLDER section replaces the fresher one and
    // the picker keeps offering a model upstream has removed for a whole TTL.
    // The download below yields, which is exactly the window: the warm start
    // lands second.
    const path = join(dir, 'catalog.json')
    await writeFile(
      path,
      JSON.stringify({ version: CACHE_VERSION, etag: '"old"', fetchedAt: 1, models: modelsDict() }),
      'utf8',
    )
    let release
    const gate = new Promise((resolve) => {
      release = resolve
    })
    const fetchImpl = scriptedFetch([
      async () => {
        await gate
        return fakeResponse({ etag: '"new"', body: apiBodyWith({ 'big-pickle': modelsDict()['big-pickle'] }) })
      },
    ])
    const catalog = catalogWith({ dir, fetchImpl, baselineModels: [] })
    const syncing = catalog.forceRefresh()
    await tick()
    release()
    await syncing
    assert.deepEqual(catalog.current().visible, ['big-pickle'], 'the sync won, not the warm start')
    // The stale record must not have been kept either: the next conditional
    // request has to carry the etag the sync just stored.
    const onDisk = JSON.parse(await readFile(path, 'utf8'))
    assert.equal(onDisk.etag, '"new"')
    const revalidated = scriptedFetch([fakeResponse({ status: 304 })])
    const second = catalogWith({ dir, fetchImpl: revalidated, baselineModels: [] })
    await waitFor(() => second.current().source === 'models.dev')
    await second.forceRefresh()
    assert.equal(revalidated.calls.length, 1)
    assert.equal(revalidated.calls[0].headers['if-none-match'], '"new"', 'the fresh etag survived')
  })
})
