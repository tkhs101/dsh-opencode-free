// Live diagnosis 3: same model, pinned session (what the probe uses) vs a
// fresh session (what a new DSH conversation gets). Minimal requests.
import { zenProvider } from '../lib/zen-provider.js'

// EXACTLY how index.ts wires it: getSessionId always undefined, so every
// request falls back to the one randomUUID minted at plugin load.
const pinned = zenProvider(() => undefined, () => undefined)
const model = pinned.getModels().find((m) => m.id === 'muse-spark-1.3-contributor-free')
if (!model) throw new Error('model not in catalogue')

async function ask(label, provider) {
  let status = 0
  let body = ''
  try {
    const result = await provider.streamSimple(model, {
      messages: [{ role: 'user', content: 'hi', timestamp: Date.now() }],
    }, {
      apiKey: 'public',
      maxTokens: 64,
      maxRetries: 0,
      reasoning: 'low',
      signal: AbortSignal.timeout(15000),
      fetch: async (url, init) => {
        const response = await fetch(url, init)
        status = response.status
        if (!response.ok) { try { body = (await response.clone().text()).slice(0, 300) } catch {} }
        return response
      },
    }).result()
    const text = (result.content ?? []).filter((c) => c.type === 'text').map((c) => c.text).join('').trim()
    console.log(JSON.stringify({ label, status, stopReason: result.stopReason, text: text.slice(0, 60) }))
  } catch (error) {
    console.log(JSON.stringify({ label, status, threw: String((error && error.message) || error).slice(0, 120), body }))
  }
}

await ask('pinned-session', pinned)
// A fresh provider = a fresh fallbackSession, like a new DSH conversation gets.
const fresh = zenProvider(() => undefined, () => undefined)
await ask('fresh-session', fresh)
