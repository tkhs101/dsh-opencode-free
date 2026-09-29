// Does the anthropic-messages probe variant reach the wire, or throw first?
import { zenProvider } from '../lib/zen-provider.js'

const provider = zenProvider(() => 'diag-session', () => undefined)
const base = provider.getModels().find((m) => m.api === 'openai-completions')
const variant = { ...base, api: 'anthropic-messages', compat: undefined }
let fetched = 0
try {
  const result = await provider.streamSimple(variant, {
    messages: [{ role: 'user', content: 'hi', timestamp: Date.now() }],
  }, {
    apiKey: 'public',
    maxTokens: 64,
    maxRetries: 0,
    reasoning: 'low',
    signal: AbortSignal.timeout(15000),
    fetch: async (url, init) => {
      fetched += 1
      console.log(JSON.stringify({ fetchedUrl: String(url).replace('https://opencode.ai', '') }))
      const response = await fetch(url, init)
      return response
    },
  }).result()
  console.log(JSON.stringify({ fetched, stopReason: result.stopReason, errorMessage: (result.errorMessage || "").slice(0,300), content: JSON.stringify(result.content).slice(0,200) }))
} catch (error) {
  console.log(JSON.stringify({ fetched, threw: String((error && error.message) || error).slice(0, 300) }))
}
