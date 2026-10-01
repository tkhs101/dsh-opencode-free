// Opt-in: sends one short anonymous request per selected free model.
// Run after building: node scripts/test-live.mjs [model-id ...]
//
// NOT an availability criterion. This probe declares no tools, and Zen's
// anonymous tier 403s (`FreeTierError`) any tool-less request on every model
// (measured 2026-09-27, docs/reverse-engineering.md §8) — so a `replied:false`
// here usually means "the gate said no", not "the model is gone". The real
// availability check injects the `read` + `bash` tool names and runs through
// `probeModel` / `catalog.forceProbes()`; see .scratch/model-probe/spec.md.
import { zenProvider } from '../lib/zen-provider.js'

const provider = zenProvider()
const requested = process.argv.slice(2)
const available = provider.getModels()
if (requested.some((id) => !available.some((model) => model.id === id))) {
  throw new Error('Only model IDs from the free catalogue are allowed')
}
const models = available.filter((model) => !requested.length || requested.includes(model.id))
if (!models.length) throw new Error('No free models available')

for (const model of models) {
  let status
  let errorType
  try {
    const result = await provider
      .streamSimple(
        model,
        {
          messages: [{ role: 'user', content: 'Reply with OK only.', timestamp: Date.now() }],
        },
        {
          apiKey: 'public',
          maxRetries: 0,
          maxTokens: 1024, // PROBE_MAX_TOKENS; scripts/probe-ab.mjs A/Bs this against the live tier
          signal: AbortSignal.timeout(30000),
          fetch: async (...args) => {
            const response = await fetch(...args)
            status = response.status
            if (!response.ok) {
              const body = await response
                .clone()
                .json()
                .catch(() => ({}))
              const kind = body.error?.type ?? body.type
              if (typeof kind === 'string' && /^[A-Za-z0-9_]{1,80}$/.test(kind)) errorType = kind
            }
            return response
          },
        },
      )
      .result()
    const replied =
      result.stopReason !== 'error' && result.content.some((part) => part.type === 'text' && part.text.trim())
    console.log(JSON.stringify({ model: model.id, status, errorType, replied }))
    if (!replied) process.exitCode = 1
  } catch {
    console.log(JSON.stringify({ model: model.id, status, errorType, replied: false, failed: true }))
    process.exitCode = 1
  }
}
