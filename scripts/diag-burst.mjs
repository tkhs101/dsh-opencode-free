// Live diagnosis 4: does a sequential burst trip the limiter mid-round?
// 12 tiny requests, same session, logging every status. This is what a probe
// round looks like to upstream, minus the model variety.
import { zenProvider } from '../lib/zen-provider.js'

const provider = zenProvider(() => undefined, () => undefined)
const model = provider.getModels().find((m) => m.api === 'openai-completions')
if (!model) throw new Error('no completions model')

for (let i = 1; i <= 12; i += 1) {
  let status = 0
  let err = ''
  try {
    await provider.streamSimple(model, {
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
        if (!response.ok) { try { err = (await response.clone().text()).slice(0, 160) } catch {} }
        return response
      },
    }).result()
  } catch (error) {
    err = String((error && error.message) || error).slice(0, 120)
  }
  console.log(JSON.stringify({ n: i, status, err }))
}
