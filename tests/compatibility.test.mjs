import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import test from 'node:test'
import {
  PROVIDER_ID,
  classifyZenFailure,
  describeTransportCause,
  isModelUnavailableFailure,
  probeModel,
  ZEN_FAILURE_GUIDANCE,
  freeModels,
  isEncryptedContentError,
  requestHeader,
  resolveZenApiKey,
  sessionHeader,
  stripStaleReasoning,
  swapCompactionPrompt,
} from '../src/zen-provider.ts'

const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url)))
const libUrl = new URL('../lib/', import.meta.url)
const hostFiles = (await readdir(libUrl)).filter((f) => f.endsWith('.js')).sort()
const host = (await Promise.all(hostFiles.map((f) => readFile(new URL(f, libUrl), 'utf8')))).join('\n')
const plugin = await import('../lib/index.js')
const { PiAiAdapter } = await import('@deepseek-ai/dsh-llm-pi-ai')
const { resolveRetryPolicy } = await import('@deepseek-ai/dsh-llm')

test('targets the DSH 0.2.0-rc.1 contracts', () => {
  assert.equal(pkg.version, '0.2.0')
  for (const [name, version] of Object.entries(pkg.peerDependencies)) {
    if (name.startsWith('@deepseek-ai/dsh-')) assert.equal(version, '0.2.0-rc.1', name)
    assert.equal(pkg.peerDependenciesMeta[name]?.optional, true, name)
  }
  assert.equal(pkg.peerDependencies['@earendil-works/pi-ai'], '^0.85.1')
  assert.equal(pkg.peerDependencies['react'], undefined)
  assert.deepEqual(pkg.dsh, {
    bundle: { patch: './cordis.patch.yml' },
    client: {
      inject: [
        '@deepseek-ai/dsh-client-runtime',
        '@deepseek-ai/dsh-client-locale',
        '@deepseek-ai/dsh-client-ui-slots',
        '@deepseek-ai/dsh-client-ui-settings',
      ],
      platform: 'web',
    },
  })
  assert.equal(pkg.exports['./client'], './src/client.js')
})

test('registers opencode-zen-free through the PiAiAdapter seam', async () => {
  const provider = plugin.zenProvider(() => 'test-session', () => undefined)
  assert.equal(provider.id, 'opencode-zen-free')
  const models = provider.getModels()
  assert.ok(models.length > 0, 'expected at least one free model')
  for (const m of models) {
    assert.equal(m.provider, PROVIDER_ID)
    assert.ok(m.baseUrl?.includes('opencode.ai/zen'), m.id)
    assert.ok(Object.values(m.cost).every((c) => c === 0), m.id)
  }
  const profile = Object.freeze({
    provider: PROVIDER_ID,
    displayName: 'OpenCode Zen Free',
    piProvider: provider,
    modelErrors: new Map(),
    configuredMaxTokens: new Map(),
    streamIdleTimeoutMs: 600000,
    maxRequestImageBytes: 20 * 1024 * 1024,
    requestImagePixelBudget: 2048 * 2048,
    requestImageMaxBytes: 1024 * 1024,
    retryPolicy: resolveRetryPolicy(undefined, 'compatibility test'),
    cacheRetention: 'short',
    transport: 'sse',
  })
  const registered = []
  // `apply()` also wires the catalogue routes through a `webServer` inject. This
  // stub keeps it on its normal path — and its "webServer wiring failed"
  // degradation warn quiet — without pretending the routes are exercised here:
  // tests/model-visibility.test.mjs is where their contract is asserted.
  const fakeCtx = {
    llm: { registerAdapter: (routes, adapter) => { registered.push([routes, adapter]) } },
    get: () => undefined,
    inject: (requires, applyChild) => {
      if (!requires.includes('webServer')) return
      applyChild({ webServer: { register: () => () => {} }, effect: (fn) => fn() })
    },
    effect: (fn) => fn(),
  }
  plugin.apply(fakeCtx, {})
  assert.deepEqual(registered[0][0], [PROVIDER_ID])
  assert.ok(registered[0][1] instanceof PiAiAdapter)
  const advertised = await registered[0][1].listModels(PROVIDER_ID)
  assert.deepEqual(advertised.map((m) => m.id), models.map((m) => m.id))
})

test('session/request headers are structurally valid OpenCode ids', () => {
  assert.match(sessionHeader('abc'), /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/)
  assert.equal(sessionHeader('abc'), sessionHeader('abc'), 'stable per session')
  assert.notEqual(sessionHeader('a'), sessionHeader('b'), 'distinct between sessions')
  assert.match(requestHeader(), /^msg_[0-9a-f]{12}[0-9A-Za-z]{14}$/)
})

test('encrypted-content retry triggers only on the 400 rotation signal', () => {
  assert.equal(isEncryptedContentError(400, 'reasoning `encrypted_content` was not issued to this caller'), true)
  assert.equal(isEncryptedContentError(400, 'encrypted content could not be verified'), true)
  assert.equal(isEncryptedContentError(403, 'reasoning `encrypted_content` was not issued'), false)
  assert.equal(isEncryptedContentError(400, 'FreeTierError'), false)
  const stripped = stripStaleReasoning({
    input: [
      { type: 'reasoning', id: 'rs_1' },
      { type: 'function_call', id: 'fc_1', call_id: 'c1' },
      { type: 'message', id: 'm1' },
    ],
  })
  assert.deepEqual(stripped, { input: [{ type: 'function_call', call_id: 'c1' }, { type: 'message', id: 'm1' }] })
  assert.equal(stripStaleReasoning({ input: [{ type: 'message' }] }), null)
})

test('compaction swap only rewrites short anonymous summarization prompts', async () => {
  const piPrompt = 'You are a context summarization assistant. Summarize.'
  const swapped = swapCompactionPrompt({ systemPrompt: piPrompt, messages: [], tools: [] }, 'public')
  assert.ok(swapped.systemPrompt.includes('context summarization agent'))
  assert.equal(swapCompactionPrompt({ systemPrompt: piPrompt, messages: [] }, 'sk-live-key').systemPrompt, piPrompt)
  assert.equal(swapCompactionPrompt({ systemPrompt: 'ordinary chat', messages: [] }, 'public').systemPrompt, 'ordinary chat')
  assert.equal((await resolveZenApiKey({ env: async () => undefined, configKey: '  ' })).apiKey, 'public')
  assert.equal((await resolveZenApiKey({ env: async () => 'env-key', configKey: undefined })).apiKey, 'env-key')
  assert.equal((await resolveZenApiKey({ env: async () => undefined, configKey: 'cfg-key' })).apiKey, 'cfg-key')
})

test('optional keys resolve config before env and send public when neither exists', async () => {
  const p = plugin.zenProvider()
  const model = p.getModels()[0]
  const context = { messages: [{ role: 'user', content: 'hi', timestamp: 1 }] }
  for (const [configKey, envKey, expected] of [
    [undefined, undefined, 'public'],
    ['  ', '  ', 'public'],
    [undefined, 'env-test-key', 'env-test-key'],
    ['config-test-key', 'env-test-key', 'config-test-key'],
  ]) {
    const { apiKey } = await resolveZenApiKey({ configKey, env: async () => envKey })
    let authorization
    await p.streamSimple(model, context, {
      apiKey,
      maxRetries: 0,
      fetch: async (_url, init) => {
        authorization = new Headers(init.headers).get('authorization')
        return new Response('{}', { status: 403, headers: { 'Content-Type': 'application/json' } })
      },
    }).result()
    assert.equal(authorization, `Bearer ${expected}`)
  }
})

test('upstream failures classify to actionable guidance (recorded bodies)', () => {
  // 403 body captured live 2026-09-22: the exact upstream verdict on this egress.
  assert.equal(classifyZenFailure(403, '{"type":"error","error":{"type":"FreeTierError","message":"Error from provider (Console): OpenCode\'s free tier can only be used from within OpenCode"}}'), 'anon-gated')
  // MissingSessionID shape per opencodex provider docs.
  assert.equal(classifyZenFailure(400, '{"type":"error","error":{"type":"MissingSessionID","message":"OpenCode\'s free tier can only be used in OpenCode"}}'), 'anon-gated')
  // 429 FreeUsageLimitError per opencode#42500.
  assert.equal(classifyZenFailure(429, '{"type":"error","error":{"type":"FreeUsageLimitError"}}'), 'quota-exhausted')
  assert.equal(classifyZenFailure(401, '{"error":{"type":"authentication_error","message":"invalid x-api-key"}}'), 'bad-key')
  assert.equal(classifyZenFailure(500, 'internal error'), 'unknown')
  assert.equal(classifyZenFailure(403, 'something entirely new'), 'unknown')
  // Guidance carries the actionable content, not just a label.
  assert.match(ZEN_FAILURE_GUIDANCE['anon-gated'], /匿名額度/)
  assert.match(ZEN_FAILURE_GUIDANCE['anon-gated'], /OPENCODE_API_KEY/)
  assert.doesNotMatch(ZEN_FAILURE_GUIDANCE['anon-gated'], /非插件問題|即解|出口 IP/)
  assert.match(ZEN_FAILURE_GUIDANCE['quota-exhausted'], /OPENCODE_API_KEY/)
  assert.match(ZEN_FAILURE_GUIDANCE['bad-key'], /key/)
})

test('catalogue refresh intersects live ids and survives failure', async () => {
  const p = plugin.zenProvider(() => undefined, () => undefined)
  const before = p.getModels().map((m) => m.id)
  assert.ok(before.length > 0)
  const known = before[0]
  const ctx = (fetch, publish) => ({
    stored: undefined,
    allowNetwork: true,
    signal: AbortSignal.timeout(5000),
    publish,
  })
  const origFetch = globalThis.fetch
  try {
    globalThis.fetch = async () => Response.json({ data: [{ id: known }, { id: 'gpt-6-astra' }] })
    let update = null
    await p.refreshModels(ctx(null, async (u) => { update = u.update; return true }))
    update()
    assert.deepEqual(p.getModels().map((m) => m.id), [known])
    globalThis.fetch = async () => { throw new Error('offline') }
    await assert.rejects(p.refreshModels(ctx(null, async () => true)))
    assert.deepEqual(p.getModels().map((m) => m.id), [known])
    let called = false
    globalThis.fetch = async () => { called = true; throw new Error('must not fetch') }
    await p.refreshModels({ ...ctx(null, async () => true), allowNetwork: false })
    assert.equal(called, false)
  } finally {
    globalThis.fetch = origFetch
  }
})

test('request path surfaces guidance on gate failures (fixture transport)', async () => {
  const p = plugin.zenProvider(() => 's', () => undefined)
  const model = p.getModels()[0]
  const ctx = { messages: [{ role: 'user', content: 'hi', timestamp: 1 }] }
  const gate = (status, body) => async () =>
    new Response(body, { status, headers: { 'Content-Type': 'application/json' } })
  // pi-ai resolves transport failures (stopReason error), it does not reject.
  const r403 = await p.streamSimple(model, ctx, { fetch: gate(403, '{"type":"error","error":{"type":"FreeTierError","message":"only be used from within OpenCode"}}'), maxRetries: 0 }).result()
  assert.equal(r403.stopReason, 'error')
  assert.match(r403.errorMessage, /匿名額度/)
  const r429 = await p.streamSimple(model, ctx, { fetch: gate(429, '{"error":{"type":"FreeUsageLimitError"}}'), maxRetries: 0 }).result()
  assert.match(r429.errorMessage, /重置/)
  const r401 = await p.streamSimple(model, ctx, { fetch: gate(401, '{"error":{"message":"invalid x-api-key"}}'), maxRetries: 0 }).result()
  assert.match(r401.errorMessage, /key 無效/)
  const rUnknown = await p.streamSimple(model, ctx, { fetch: gate(403, 'something entirely new'), maxRetries: 0 }).result()
  assert.match(rUnknown.errorMessage, /403/)
  assert.doesNotMatch(rUnknown.errorMessage, /匿名額度/)
  // Responses transport formats failures differently (live-observed shape).
  const responsesModel = p.getModels().find((m) => m.api === 'openai-responses') ?? model
  const rResp = await p.streamSimple(responsesModel, ctx, { fetch: gate(403, '{"type":"FreeTierError","message":"only be used from within OpenCode"}}'), maxRetries: 0 }).result()
  assert.match(rResp.errorMessage, /匿名額度/)
  // The DSH session persists the streamed error event (its toStreamChunks
  // translates it to a finish chunk), not result(): iterate raw events.
  const seen = []
  for await (const ev of p.streamSimple(responsesModel, ctx, { fetch: gate(403, '{"type":"FreeTierError","message":"only be used from within OpenCode"}}'), maxRetries: 0 })) {
    seen.push(ev)
  }
  const errEv = seen.find((ev) => ev?.type === 'error' && typeof ev?.error?.errorMessage === 'string')
  assert.ok(errEv, 'expected a raw error event in the stream')
  assert.match(errEv.error.errorMessage, /匿名額度/)
})

test('anonymous requests satisfy the read+bash tool gate and map pwsh back', async () => {
  // Live replay 2026-09-27: Zen's anonymous tier 403s unless tools include
  // `read` and `bash` by name; DSH on Windows exposes `pwsh` instead.
  const p = plugin.zenProvider(() => 's', () => undefined)
  const model = p.getModels().find((m) => m.api === 'openai-responses')
  const tool = (name) => ({ name, description: name, parameters: { type: 'object', properties: {} } })
  const ctx = {
    tools: [tool('read'), tool('pwsh')],
    messages: [
      { role: 'user', content: 'ls', timestamp: 1 },
      { role: 'assistant', content: [{ type: 'toolCall', id: 'call_0|fc_0', name: 'pwsh', arguments: {} }], api: model.api, provider: model.provider, model: model.id, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: 'toolUse', timestamp: 2 },
      { role: 'toolResult', toolCallId: 'call_0|fc_0', toolName: 'pwsh', content: [{ type: 'text', text: 'ok' }], isError: false, timestamp: 3 },
    ],
  }
  const sse = [
    { type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'bash', arguments: '' } },
    { type: 'response.function_call_arguments.delta', output_index: 0, item_id: 'fc_1', delta: '{}' },
    { type: 'response.output_item.done', output_index: 0, item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'bash', arguments: '{}' } },
    { type: 'response.completed', response: { id: 'r1', status: 'completed', usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } },
  ].map((e) => `data: ${JSON.stringify(e)}\n\n`).join('')
  const run = async (context, apiKey) => {
    let body
    const events = []
    const s = p.streamSimple(model, context, {
      apiKey,
      maxRetries: 0,
      fetch: async (_url, init) => {
        body = JSON.parse(init.body)
        return new Response(sse, { headers: { 'Content-Type': 'text/event-stream' } })
      },
    })
    for await (const ev of s) events.push(ev)
    return { body, events, result: await s.result() }
  }
  const names = (body) => body.tools.map((t) => t.name).sort()

  const anon = await run(ctx, 'public')
  assert.deepEqual(names(anon.body), ['bash', 'read'])
  assert.ok(anon.body.input.some((i) => i.type === 'function_call' && i.name === 'bash'))
  assert.ok(!JSON.stringify(anon.body.input).includes('"pwsh"'))
  assert.equal(anon.result.content.find((c) => c.type === 'toolCall').name, 'pwsh')
  const end = anon.events.find((ev) => ev.type === 'toolcall_end')
  assert.equal(end.toolCall.name, 'pwsh')
  assert.equal(ctx.tools[1].name, 'pwsh', 'caller context must not be mutated')

  const keyed = await run(ctx, 'sk-test-key')
  assert.deepEqual(names(keyed.body), ['pwsh', 'read'])

  const bare = await run({ messages: [{ role: 'user', content: 'title', timestamp: 1 }] }, 'public')
  assert.deepEqual(names(bare.body), ['bash', 'read'])
})

test('free catalogue is non-empty and host output carries the Zen identity', () => {
  assert.ok(freeModels().length > 0)
  assert.match(host, /opencode-zen-free/)
  assert.match(host, /x-opencode-session/)
  assert.match(host, /registerAdapter/)
})

// ── availability probe (model-probe P5) ─────────────────────────────────────

/** A completions-shaped SSE reply with real text, so a probe reads `ok`. */
const okSse = [
  'data: {"choices":[{"index":0,"delta":{"content":"OK"},"finish_reason":null}]}',
  'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}',
  'data: [DONE]',
  '',
].join('\n\n')

const sseReply = () => new Response(okSse, { headers: { 'Content-Type': 'text/event-stream' } })

test('GUARD: the probe request carries the read+bash gate, streams, and asks for enough tokens', async () => {
  // A tool-less probe 403s on EVERY model at the anonymous tier (measured
  // 2026-09-27), so a probe that skipped the tools would report the whole
  // catalogue dead. The budget is 512 for the same reason scripts/test-live.mjs
  // uses it: reasoning models spend 60+ tokens thinking before any text, and a
  // tighter cap returns an empty completion that reads as "dead".
  const p = plugin.zenProvider(() => 'probe-session', () => undefined)
  const model = p.getModels().find((m) => m.api === 'openai-completions')
  let body
  const outcome = await probeModel(model, {
    provider: p,
    apiKey: 'public',
    fetchImpl: async (_url, init) => {
      body = JSON.parse(init.body)
      return sseReply()
    },
  })
  assert.equal(outcome.kind, 'ok')
  assert.deepEqual(body.tools.map((t) => t.function.name).sort(), ['bash', 'read'])
  assert.equal(body.stream, true)
  assert.ok(body.max_tokens >= 512, `max_tokens was ${body.max_tokens}`)
  assert.equal(body.model, model.id)
})

test('GUARD: placeholder efforts never reach the wire', async () => {
  // "off" is offered as an explicit level, but pi-ai renders it as
  // `reasoning: { effort: "none" }` when nothing is chosen and as
  // `effort: "off"` when it is explicitly chosen on the responses channel.
  // Neither value is ever sent by pi-ai's own records or by OpenCode, so the
  // request path strips exactly those two back to "no reasoning object".
  // Real levels pass through untouched.
  const p = plugin.zenProvider(() => 's', () => undefined)
  const base = p.getModels().find((m) => m.api === 'openai-responses')
  // A map with `off` absent (offered), like every derived record carries —
  // and an id outside the muse-spark xhigh default, so nothing is chosen.
  const { off: _dropped, ...rest } = base.thinkingLevelMap ?? {}
  const model = { ...base, id: 'probe-responses-free', thinkingLevelMap: rest }
  const ctx = { messages: [{ role: 'user', content: 'hi', timestamp: 1 }] }
  // Run each case and read the captured body. The stub answers 400 so the
  // stream settles immediately; onPayload has already run by then.
  const bodies = {}
  for (const [key, opts] of [['default', {}], ['explicit-off', { reasoning: 'off' }], ['real-level', { reasoning: 'low' }]]) {
    let body
    await p.streamSimple(model, ctx, {
      ...opts,
      maxRetries: 0,
      fetch: async (_url, init) => {
        body = JSON.parse(init.body)
        return new Response('{"error":{"message":"stop here"}}', { status: 400 })
      },
    }).result()
    bodies[key] = body
  }
  assert.equal(bodies.default.reasoning, undefined, 'no effort chosen sends no reasoning object')
  assert.equal(bodies['explicit-off'].reasoning, undefined, 'explicit "off" sends no reasoning object')
  assert.equal(bodies['real-level'].reasoning?.effort, 'low', 'a real level passes through')
})

test('probe verdicts: a text reply is ok, only a positive signal is dead', async () => {
  const p = plugin.zenProvider(() => 'probe-session', () => undefined)
  const model = p.getModels().find((m) => m.api === 'openai-completions')
  const run = (fetchImpl) => probeModel(model, { provider: p, apiKey: 'public', fetchImpl })

  assert.equal((await run(async () => sseReply())).kind, 'ok')

  // dead requires positive evidence about THIS model.
  for (const [status, text] of [
    [404, '{"error":{"message":"model not found"}}'],
    [410, '{"error":{"message":"no longer available"}}'],
    [400, '{"error":{"message":"The model has been retired"}}'],
  ]) {
    const outcome = await run(async () => new Response(text, { status }))
    assert.equal(outcome.kind, 'dead', `${status} ${text}`)
  }

  // Everything the request path already understands is inconclusive: none of
  // it is evidence about the model.
  for (const [status, text] of [
    [403, '{"type":"error","error":{"type":"FreeTierError","message":"only be used from within OpenCode"}}'],
    [429, '{"error":{"type":"FreeUsageLimitError"}}'],
    [401, '{"error":{"message":"invalid x-api-key"}}'],
    [500, 'internal error'],
    [403, 'something entirely new'],
    // A body carrying BOTH a quota marker and model wording must resolve to
    // the safe side, or one throttled minute could empty the picker.
    [429, '{"error":{"message":"usage limit exceeded; model not found"}}'],
  ]) {
    const outcome = await run(async () => new Response(text, { status }))
    assert.equal(outcome.kind, 'inconclusive', `${status} ${text}`)
  }
  assert.equal(isModelUnavailableFailure(429, 'usage limit exceeded; model not found'), false)

  // Calibrated against real Zen bodies, 2026-09-29. These three are one word
  // apart from each other, and reading any of them wrong empties the picker.
  const DEAD_400 = '{"error":{"type":"server_error","message":"Error from provider (Console): Upstream request failed: Model is unavailable."}}'
  const ENDPOINT_400 = '{"error":{"type":"server_error","message":"Error from provider (Console): Upstream request failed: Endpoint is unavailable."}}'
  // The free route declining to serve a model models.dev still lists free.
  const UNSUPPORTED_401 = '{"type":"error","error":{"type":"ModelError","message":"Model kimi-k2.5-free is not supported"}}'
  // The SAME sentence about the request instead of the model: a healthy model
  // sent down the wrong channel. Never a death notice.
  const FORMAT_401 = '{"type":"error","error":{"type":"ModelError","message":"Model space-bunny-free is not supported for format openai"}}'
  assert.equal(isModelUnavailableFailure(400, DEAD_400), true, 'the model is gone')
  assert.equal(isModelUnavailableFailure(400, ENDPOINT_400), false, 'the ENDPOINT is gone, not the model')
  assert.equal(isModelUnavailableFailure(401, UNSUPPORTED_401), true, 'the free route will not serve it')
  assert.equal(isModelUnavailableFailure(401, FORMAT_401), false, 'wrong channel, healthy model')
  assert.equal((await run(async () => new Response(DEAD_400, { status: 400 }))).kind, 'dead')
  assert.equal((await run(async () => new Response(ENDPOINT_400, { status: 400 }))).kind, 'inconclusive')
  assert.equal((await run(async () => new Response(UNSUPPORTED_401, { status: 401 }))).kind, 'dead')
  assert.equal((await run(async () => new Response(FORMAT_401, { status: 401 }))).kind, 'inconclusive')

  // A bad key must never empty the picker, however it is phrased.
  for (const body of [
    '{"error":{"message":"Invalid API key provided"}}',
    '{"detail":"Unauthorized"}',
    '{"error":{"type":"authentication_error","message":"bad credentials"}}',
  ]) {
    assert.equal(isModelUnavailableFailure(401, body), false, body)
    assert.equal((await run(async () => new Response(body, { status: 401 }))).kind, 'inconclusive', body)
  }

  // A thrown transport error concludes nothing, and never rejects.
  const thrown = await run(async () => {
    throw Object.assign(new TypeError('fetch failed'), { cause: new Error('ECONNRESET') })
  })
  assert.equal(thrown.kind, 'inconclusive')
  assert.match(thrown.reason, /transport failure/)
  assert.match(thrown.reason, /ECONNRESET/)

  // An empty completion is not a reply: no text means no conclusion.
  const empty = await run(async () => new Response(
    'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
    { headers: { 'Content-Type': 'text/event-stream' } },
  ))
  assert.equal(empty.kind, 'inconclusive')
})

test('GUARD: every inconclusive outcome carries a code and a status the card can word', async () => {
  // The panel localizes the failure itself, so the outcome must hand it
  // something structured. A red badge that can only read "failed" is exactly
  // the report this test exists to prevent — the prober is the only place
  // that still knows WHY.
  const p = plugin.zenProvider(() => 's', () => undefined)
  const model = p.getModels().find((m) => m.api === 'openai-completions')
  const run = (fetchImpl) => probeModel(model, { provider: p, apiKey: 'public', fetchImpl })
  const CODES = new Set(['anon-gated', 'quota-exhausted', 'bad-key', 'unknown', 'timeout', 'transport'])

  // A gated anonymous request, a quota wall, a bad key, an empty completion and
  // a thrown socket: five different situations, five different sentences.
  const bodies = [
    { status: 403, text: '{"error":{"type":"FreeTierError","message":"only be used in OpenCode"}}' },
    { status: 429, text: '{"error":{"type":"FreeUsageLimitError"}}' },
    { status: 401, text: '{"error":{"message":"Invalid API key provided"}}' },
    { status: 200, text: 'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', sse: true },
  ]
  for (const { status, text, sse } of bodies) {
    const outcome = await run(async () => new Response(text, {
      status,
      headers: sse ? { 'Content-Type': 'text/event-stream' } : undefined,
    }))
    assert.equal(outcome.kind, 'inconclusive', `HTTP ${status}`)
    assert.ok(CODES.has(outcome.code), `HTTP ${status} produced code ${outcome.code}`)
    assert.equal(typeof outcome.http, 'number', `HTTP ${status} carries a status`)
    if (status !== 0) assert.equal(outcome.http, status, `HTTP ${status} is reported as itself`)
  }

  const thrown = await run(async () => { throw new TypeError('fetch failed') })
  assert.equal(thrown.kind, 'inconclusive')
  assert.ok(CODES.has(thrown.code), `a thrown socket produced code ${thrown.code}`)
  assert.equal(thrown.http, 0, 'no response means no status, not a fake one')

  // A timeout is its own code: "the model sat there" and "the socket broke"
  // need different things from the reader, and an AbortError is the only
  // evidence that separates them.
  const aborted = await run(async () => { throw Object.assign(new Error('aborted'), { name: 'AbortError' }) })
  assert.equal(aborted.code, 'timeout', 'a blown AbortSignal is reported as a timeout')

  // And a genuinely dead model says dead, with the status that proved it.
  const dead = await run(async () => new Response(
    '{"error":{"message":"The model does not exist"}}',
    { status: 404 },
  ))
  assert.equal(dead.kind, 'dead')
  assert.equal(dead.code, 'dead')
  assert.equal(dead.http, 404)
})

test('a socket failure reports its cause instead of a bare "Connection error."', async () => {  // The chain this exists for, recorded live 2026-09-29: undici rejects, the
  // OpenAI SDK flattens it to `APIConnectionError { message: 'Connection
  // error.' }` and keeps the reason in `cause`, and pi-ai reads only
  // `error.message`. Without the recorder the user saw those four words for
  // 45 minutes with no way to act on them.
  const socket = () => {
    const err = new TypeError('fetch failed')
    err.cause = Object.assign(new Error('other side closed'), { code: 'UND_ERR_SOCKET' })
    throw err
  }
  assert.equal(
    describeTransportCause(Object.assign(new TypeError('fetch failed'), {
      cause: Object.assign(new Error('other side closed'), { code: 'UND_ERR_SOCKET' }),
    })),
    'TypeError: fetch failed <- Error/UND_ERR_SOCKET: other side closed',
  )
  // A cause carrying its own three-digit run must not be able to re-file a
  // socket kill as an upstream status error: the host reads 4xx/5xx literals
  // off this message before it ever reaches the transport rule.
  assert.doesNotMatch(describeTransportCause(
    Object.assign(new TypeError('fetch failed'), {
      cause: Object.assign(new Error('read ECONNRESET after 500 bytes'), { code: 'ECONNRESET' }),
    }),
  ), /\b\d{3}\b/)
  assert.equal(describeTransportCause('not an error'), 'string')

  const p = plugin.zenProvider(() => 's', () => undefined)
  const model = p.getModels().find((m) => m.api === 'openai-completions')
  const ctx = { messages: [{ role: 'user', content: 'hi', timestamp: 1 }] }
  const r = await p.streamSimple(model, ctx, { fetch: socket, maxRetries: 0 }).result()
  assert.equal(r.stopReason, 'error')
  assert.match(r.errorMessage, /Connection error\./)
  assert.match(r.errorMessage, /UND_ERR_SOCKET/)
  assert.match(r.errorMessage, /other side closed/)
  assert.match(r.errorMessage, /網路層/)
  // APPENDED, not substituted: the host classifies from this message, and the
  // original wording is what still carries the transport class.
  assert.ok(r.errorMessage.startsWith('Connection error.'), r.errorMessage)

  // A healthy request records nothing and is left exactly as it was.
  const sse = 'data: {"choices":[{"index":0,"delta":{"content":"OK"},"finish_reason":null}]}\n\ndata: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'
  const ok = await p.streamSimple(model, ctx, {
    maxRetries: 0,
    fetch: async () => new Response(sse, { headers: { 'Content-Type': 'text/event-stream' } }),
  }).result()
  assert.equal(ok.stopReason, 'stop')
  assert.equal(ok.errorMessage, undefined)
})
