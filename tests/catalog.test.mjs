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
  readCache,
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

test('derive splits free-active candidates from free-retired, and drops paid', () => {
  const { candidates, excluded } = derive(modelsDict(), { template: template() })
  assert.deepEqual(ids(candidates).sort(), [
    'big-pickle',
    'ling-3.0-flash-fin-free',
    'muse-spark-1.3-contributor-free',
    'space-bunny-free',
  ])
  assert.deepEqual(excluded, ['deepseek-v4-flash-free', 'muse-spark-1.2-contributor-free'])
  assert.ok(!ids(candidates).includes('gpt-6-astra'), 'paid model must not be offered')
})

test('derive skips malformed records instead of throwing', () => {
  const { candidates, excluded } = derive(modelsDict(), { template: template() })
  for (const id of ['broken-null', 'broken-array', 'broken-nocost']) {
    assert.ok(!ids(candidates).includes(id), id)
    assert.ok(!excluded.includes(id), id)
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
  const { candidates, excluded } = derive(provider, { template: template() })
  assert.deepEqual(candidates, [], 'a provider record must never look like a catalogue')
  assert.deepEqual(excluded, [])
  // ...and the real shape does produce one, from the same response body.
  const correct = derive(provider.models, { template: template() })
  assert.ok(correct.candidates.length > 0, 'the models dictionary does produce candidates')
})

test('GUARD: fetchSection output feeds derive directly from a real api.json body', async () => {
  const result = await fetchSection({ fetchImpl: scriptedFetch([fakeResponse({ body: apiBody() })]) })
  assert.equal(result.kind, 'ok')
  assert.equal(Object.prototype.hasOwnProperty.call(result.section, 'models'), false, 'the wrapper is unwrapped here')
  const { candidates, excluded } = derive(result.section, { template: template() })
  assert.deepEqual(ids(candidates).sort(), [
    'big-pickle',
    'ling-3.0-flash-fin-free',
    'muse-spark-1.3-contributor-free',
    'space-bunny-free',
  ])
  assert.deepEqual(excluded, ['deepseek-v4-flash-free', 'muse-spark-1.2-contributor-free'])
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

function catalogWith({ dir, fetchImpl, clock = { t: 1_000_000 }, ttlMs, baselineModels = baseline() } = {}) {
  return createCatalog({
    template: template(),
    builtinBaseline: baselineModels,
    knownApis: new Map(),
    cachePath: join(dir, 'catalog.json'),
    fetchImpl,
    now: () => clock.t,
    ...(ttlMs === undefined ? {} : { ttlMs }),
  })
}

test('a fresh container serves the offline floor before any sync', async () => {
  await withTempDir(async (dir) => {
    const catalog = catalogWith({ dir, fetchImpl: scriptedFetch([]) })
    const state = catalog.current()
    assert.equal(state.source, 'builtin-fallback')
    assert.deepEqual(ids(state.models), ['big-pickle', 'muse-spark-1.3-contributor-free'])
    assert.deepEqual(state.visible, ['big-pickle', 'muse-spark-1.3-contributor-free'])
    assert.deepEqual(state.excluded, [])
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
      'ling-3.0-flash-fin-free',
      'muse-spark-1.3-contributor-free',
      'space-bunny-free',
    ])
    assert.deepEqual(catalog.current().excluded, ['deepseek-v4-flash-free', 'muse-spark-1.2-contributor-free'])
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

test('the Zen gate narrows visible and moves the remainder into excluded', async () => {
  await withTempDir(async (dir) => {
    const catalog = catalogWith({ dir, fetchImpl: scriptedFetch([fakeResponse({ body: apiBody() })]) })
    await catalog.forceRefresh()
    catalog.applyZenGate(['big-pickle', 'space-bunny-free', 'not-in-catalogue'])
    const state = catalog.current()
    assert.deepEqual(state.visible, ['big-pickle', 'space-bunny-free'])
    assert.deepEqual(state.excluded, [
      'deepseek-v4-flash-free',
      'ling-3.0-flash-fin-free',
      'muse-spark-1.2-contributor-free',
      'muse-spark-1.3-contributor-free',
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
    // Per the spec, `excluded` explains models we still know are free but are
    // not offered (deprecated, or absent from Zen's list). A model models.dev
    // dropped altogether is in neither bucket, so it leaves both.
    assert.deepEqual(state.excluded, [])
    assert.ok(!state.excluded.includes('space-bunny-free'), 'absent upstream is not "free but unavailable"')
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
