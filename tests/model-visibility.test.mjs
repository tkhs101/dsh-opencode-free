import assert from 'node:assert/strict'
import test from 'node:test'
import { PROVIDER_ID, freeModels } from '../src/zen-provider.ts'

const plugin = await import('../lib/index.js')

const baselineIds = freeModels().map((m) => m.id)
assert.ok(baselineIds.includes('big-pickle'), 'baseline must include big-pickle')
assert.equal(baselineIds.length, 12, `baseline is pinned at 12 models, got ${baselineIds.length}`)
for (const id of ['mimo-v2.6-flash-free', 'deepseek-v4-flash-free', 'space-bunny-free', 'longcat-2.5-preview-free', 'jev-1.13-free']) {
  assert.ok(baselineIds.includes(id), `baseline must include synthetic ${id}`)
}

async function adapterFor(config) {
  const registered = []
  const fakeCtx = {
    llm: { registerAdapter: (routes, adapter) => { registered.push([routes, adapter]) } },
    get: () => undefined,
  }
  if (config === undefined) plugin.apply(fakeCtx)
  else plugin.apply(fakeCtx, config)
  assert.deepEqual(registered[0][0], [PROVIDER_ID])
  return registered[0][1]
}

async function listedIds(adapter) {
  return (await adapter.listModels(PROVIDER_ID)).map((m) => m.id)
}

test('hiddenModels filters listModels (big-pickle hidden, other 11 stay)', async () => {
  const adapter = await adapterFor({ hiddenModels: ['big-pickle'] })
  const ids = await listedIds(adapter)
  assert.ok(!ids.includes('big-pickle'), 'hidden model must not be listed')
  assert.deepEqual([...ids].sort(), baselineIds.filter((id) => id !== 'big-pickle').sort())
})

test('hiddenModels parsing trims, drops empties, dedupes', async () => {
  const adapter = await adapterFor({ hiddenModels: ['  big-pickle  ', '', '   ', 'big-pickle'] })
  const ids = await listedIds(adapter)
  assert.ok(!ids.includes('big-pickle'), 'whitespace/dup entries must still hide')
  assert.equal(ids.length, baselineIds.length - 1)
})

test('missing/empty hiddenModels lists all 12', async () => {
  for (const config of [undefined, {}, { hiddenModels: [] }]) {
    const adapter = await adapterFor(config)
    assert.deepEqual([...(await listedIds(adapter))].sort(), [...baselineIds].sort(), `config ${JSON.stringify(config)} must list all`)
  }
})

test('unknown hidden id is ignored, all 12 stay (storage retention is DSH config passthrough)', async () => {
  const adapter = await adapterFor({ hiddenModels: ['no-such-model'] })
  assert.deepEqual([...(await listedIds(adapter))].sort(), [...baselineIds].sort())
  const mixed = await adapterFor({ hiddenModels: ['no-such-model', 'big-pickle'] })
  const ids = await listedIds(mixed)
  assert.ok(!ids.includes('big-pickle'), 'known hidden id still filtered alongside unknown')
  assert.equal(ids.length, baselineIds.length - 1)
})

test('hidden model resolveModel fails, visible model resolves (no message assertion)', async () => {
  const adapter = await adapterFor({ hiddenModels: ['big-pickle'] })
  await assert.rejects(adapter.resolveModel(PROVIDER_ID, 'big-pickle'))
  const visible = baselineIds.find((id) => id !== 'big-pickle')
  const resolved = await adapter.resolveModel(PROVIDER_ID, visible)
  assert.equal(resolved.id, visible)
})

test('synthetic records resolve through the adapter (shape check)', async () => {
  const adapter = await adapterFor({})
  for (const id of ['mimo-v2.6-flash-free', 'deepseek-v4-flash-free', 'space-bunny-free', 'longcat-2.5-preview-free', 'jev-1.13-free']) {
    const resolved = await adapter.resolveModel(PROVIDER_ID, id)
    assert.equal(resolved.id, id, `synthetic ${id} must resolve`)
  }
})

test('Volatile-ref hiddenModels (DSH live shape) unwraps via get()', async () => {
  const adapter = await adapterFor({ hiddenModels: { get: () => ['big-pickle'] } })
  const ids = await listedIds(adapter)
  assert.ok(!ids.includes('big-pickle'), 'ref-wrapped hidden model must not be listed')
  assert.equal(ids.length, baselineIds.length - 1)
  const emptyRef = await adapterFor({ hiddenModels: { get: () => undefined } })
  assert.deepEqual([...(await listedIds(emptyRef))].sort(), [...baselineIds].sort())
})

test('schema marks hiddenModels volatile so DSH serves the config row', async () => {
  const { Config } = plugin
  const node = Config.dict?.hiddenModels ?? Config.inner
  assert.ok(node?.meta?.volatile === true, 'hiddenModels must be volatile (configForms row + live writes)')
})
