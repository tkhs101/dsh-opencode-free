// Live diagnosis 5: run the REAL production round (catalog + probe + Zen gate,
// wired exactly like index.ts) against a scratch dir, logging every upstream
// response. This is what the panel's 03:10:52 round did — reproduce it.
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createCatalog } from '../lib/catalog.js'
import {
  zenProvider, probeModel, fetchZenModelIds,
  builtinFreeModels, builtinKnownApis, catalogTemplate,
} from '../lib/zen-provider.js'

const dir = mkdtempSync(join(tmpdir(), 'diag-round-'))
let provider
const logFetch = (label) => async (url, init) => {
  const started = Date.now()
  const response = await fetch(url, init)
  let body = ''
  try { body = (await response.clone().text()).slice(0, 220) } catch {}
  console.log(JSON.stringify({
    label,
    ms: Date.now() - started,
    url: String(url).replace('https://opencode.ai', ''),
    status: response.status,
    body: response.ok ? body.slice(0, 80) : body,
  }))
  return response
}
const catalog = createCatalog({
  template: catalogTemplate() ?? builtinFreeModels()[0],
  builtinBaseline: builtinFreeModels(),
  knownApis: builtinKnownApis(),
  cachePath: join(dir, 'catalog.json'),
  fetchImpl: logFetch('models.dev'),
  now: Date.now,
  probe: async (model) => probeModel(model, {
    provider,
    apiKey: 'public',
    fetchImpl: logFetch(`probe:${model.id}`),
  }),
  listZenIds: async () => fetchZenModelIds(logFetch('zen-list')),
})
provider = zenProvider(() => undefined, () => undefined, { catalog })
await catalog.forceProbes()
const progress = catalog.probeProgress()
console.log(JSON.stringify({ done: progress.done, total: progress.total, results: progress.results }, null, 1))
