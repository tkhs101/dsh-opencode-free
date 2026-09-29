import assert from 'node:assert/strict'
import test from 'node:test'
import { PROVIDER_ID, freeModels } from '../src/zen-provider.ts'

const plugin = await import('../lib/index.js')

const baselineIds = freeModels().map((m) => m.id)
assert.ok(baselineIds.includes('big-pickle'), 'baseline must include big-pickle')
assert.equal(baselineIds.length, 7, `baseline is pinned at 7 models, got ${baselineIds.length}`)

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

test('hiddenModels filters listModels (big-pickle hidden, other 6 stay)', async () => {
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

test('missing/empty hiddenModels lists all 7', async () => {
  for (const config of [undefined, {}, { hiddenModels: [] }]) {
    const adapter = await adapterFor(config)
    assert.deepEqual([...(await listedIds(adapter))].sort(), [...baselineIds].sort(), `config ${JSON.stringify(config)} must list all`)
  }
})

test('unknown hidden id is ignored, all 7 stay (storage retention is DSH config passthrough)', async () => {
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
