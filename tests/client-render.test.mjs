import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'

/**
 * Structural render smoke test for the detail-page card (src/client.js).
 *
 * The bundle cannot be mounted for real here — it needs the DSH host's
 * ModuleLoader, slots and configForms — so this file stands in a minimal
 * React (createElement/useState/useEffect) plus the host seams the card
 * touches, feeds it a fixture snapshot, and asserts on the rendered tree:
 * switches, capability badges, timestamp shape and dictionary parity.
 *
 * It does not assert pixels. It asserts that the data the backend sends
 * (`models: [{id, image, thinking}]`) is what the rows render, so a backend
 * rename or a dropped badge fails here instead of silently in the UI.
 */

const CLIENT_URL = new URL('../src/client.js', import.meta.url)

// ── stub React ──────────────────────────────────────────────────────────────

function flat(children) {
  const out = []
  for (const child of children) {
    if (Array.isArray(child)) out.push(...flat(child))
    else if (child === null || child === undefined || child === false) continue
    else out.push(child)
  }
  return out
}

let hookCells = []
let hookIndex = 0
let pendingEffects = []

const React = {
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: flat(children) }),
  useState: (initial) => {
    const slot = hookIndex++
    if (hookCells[slot] === undefined) hookCells[slot] = initial
    return [hookCells[slot], (next) => {
      hookCells[slot] = typeof next === 'function' ? next(hookCells[slot]) : next
    }]
  },
  useEffect: (fn) => { pendingEffects.push(fn) },
  Component: class {},
}

function expand(node, depth = 0) {
  if (node === null || node === undefined || typeof node === 'boolean') return null
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map((c) => expand(c, depth)).filter((x) => x !== null)
  const props = { ...node.props, children: node.children }
  if (typeof node.type === 'function') {
    if (node.type.prototype && node.type.prototype.render) {
      const instance = new node.type(props)
      instance.props = props
      instance.state = instance.state ?? {}
      return expand(instance.render(), depth + 1)
    }
    return expand(node.type(props), depth + 1)
  }
  return { tag: node.type, props: node.props, children: (node.children ?? []).map((c) => expand(c, depth + 1)).filter((x) => x !== null) }
}

function* walk(node) {
  if (node === null || node === undefined || typeof node === 'boolean') return
  if (typeof node === 'string' || typeof node === 'number') { yield { text: String(node) }; return }
  if (Array.isArray(node)) { for (const child of node) yield* walk(child); return }
  yield node
  for (const child of node.children ?? []) yield* walk(child)
}

// ── host stubs ──────────────────────────────────────────────────────────────

const SNAPSHOT = {
  visible: ['space-bunny-free', 'big-pickle', 'muse-spark-1.3-contributor-free'],
  models: [
    { id: 'space-bunny-free', image: true, thinking: 'max' },
    { id: 'big-pickle', image: false, thinking: null },
    { id: 'muse-spark-1.3-contributor-free', image: true, thinking: 'xhigh' },
  ],
  source: 'models.dev',
  updatedAt: 1,
  refreshing: false,
  probedAt: Date.parse('2026-09-29T23:30:17+08:00'),
  probeInconclusive: false,
}

async function renderCard({ hidden = [], locale = 'zh', snapshot = SNAPSHOT, routes = null } = {}) {
  hookCells = []
  const scope = {
    getSnapshot: () => ({ status: 'ready', value: { hiddenModels: hidden } }),
    set: async () => true,
    subscribe: () => () => {},
  }
  const registered = []
  const ctx = {
    get: (key) => (key === 'locale'
      ? { getSnapshot: () => ({ active: locale }), subscribe: () => () => {} }
      : undefined),
    inject: (deps, fn) => {
      if (deps.includes('configForms')) fn({ configForms: { get: () => scope } })
    },
    effect: (fn) => { try { fn() } catch { /* host-side */ } return () => {} },
    slots: {
      inject: (_name, fn) => { fn() },
      register: (opts, comp) => { registered.push([opts, comp]) },
    },
    locale: { register: () => () => {} },
  }
  // The bundle reads bare `window` and `fetch` like a browser would. The
  // factory's return value is the plugin surface; the harness keeps it.
  const stashWindow = globalThis.window
  const stashFetch = globalThis.fetch
  const stubRequire = (name) => {
    if (name === 'react') return React
    if (name === '@deepseek-ai/dsh-client-ui-primitives') return {}
    throw new Error(`unexpected require ${name}`)
  }
  globalThis.window = { __ModuleLoader__: { load: (entry) => { globalThis.__opfPlugin = entry.factory(stubRequire) } } }
  const calls = []
  globalThis.fetch = async (url, init) => {
    const method = (init && init.method) || 'GET'
    calls.push({ url: String(url), method })
    if (routes !== null) return routes({ url: String(url), method })
    return { ok: true, json: async () => snapshot }
  }
  // Timers are captured so polling is deterministic: the test fires them.
  const stashTimeout = globalThis.setTimeout
  const stashClear = globalThis.clearTimeout
  const timers = new Map()
  let timerSeq = 0
  globalThis.setTimeout = (fn) => {
    timerSeq += 1
    timers.set(timerSeq, fn)
    return timerSeq
  }
  globalThis.clearTimeout = (id) => { timers.delete(id) }
  // The bundle calls the ModuleLoader facade, which the harness answers.
  // `?render=` busts the module cache so each mount gets a fresh bundle.
  try {
    await import(`${CLIENT_URL.href}?render=${locale}-${hidden.join(',')}-${Date.now()}-${Math.random()}`)
    const plugin = globalThis.__opfPlugin
    assert.ok(plugin, 'the bundle must register through the ModuleLoader')
    plugin.apply(ctx)
    assert.equal(registered.length, 1, 'one card seat is registered')
    const [opts, Comp] = registered[0]
    // No `t` is passed on purpose: ModelsCard falls back to the identity
    // lookup, so the tree carries dictionary KEYS. That pins which key each
    // slot uses; the real wording in each language is covered by the parity
    // test below and by reading the dictionaries, not by rendering.
    const root = { type: Comp, props: { ...opts.inject() }, children: [] }
    // Render until the stubbed catalogue fetch settles into state. Flushes
    // use the REAL timer; the stub only captures the card's own polling.
    let tree = null
    for (let pass = 0; pass < 8; pass++) {
      hookIndex = 0
      pendingEffects = []
      tree = expand(root)
      const effects = pendingEffects
      pendingEffects = []
      for (const fn of effects) {
        try { fn() } catch { /* a failing effect must not fail the harness */ }
      }
      await new Promise((resolve) => stashTimeout(resolve, 0))
      await new Promise((resolve) => stashTimeout(resolve, 0))
    }
    hookIndex = 0
    pendingEffects = []
    tree = expand(root)
    const rerender = () => {
      hookIndex = 0
      pendingEffects = []
      for (const fn of pendingEffects) {
        try { fn() } catch { /* host-side */ }
      }
      return expand(root)
    }
    const fireTimers = async () => {
      const fns = [...timers.values()]
      timers.clear()
      for (const fn of fns) {
        try { fn() } catch { /* a failing timer must not fail the harness */ }
      }
      await new Promise((resolve) => stashTimeout(resolve, 0))
      await new Promise((resolve) => stashTimeout(resolve, 0))
    }
    const api = {
      tree, rerender, fireTimers, calls,
      findButton: (label) => {
        const current = rerender()
        return [...walk(current)].find((n) => n.tag === 'button' && [...walk(n)].some((d) => d.text === label))
      },
      // Stubs stay alive until the test is done driving; only then restore.
      dispose: () => {
        if (stashWindow === undefined) delete globalThis.window
        else globalThis.window = stashWindow
        globalThis.fetch = stashFetch
        globalThis.setTimeout = stashTimeout
        globalThis.clearTimeout = stashClear
        delete globalThis.__opfPlugin
      },
    }
    return api
  } catch (error) {
    if (stashWindow === undefined) delete globalThis.window
    else globalThis.window = stashWindow
    globalThis.fetch = stashFetch
    globalThis.setTimeout = stashTimeout
    globalThis.clearTimeout = stashClear
    delete globalThis.__opfPlugin
    throw error
  }
}

function collect(tree) {
  const nodes = [...walk(tree)]
  return {
    texts: nodes.filter((n) => n.text).map((n) => n.text),
    classes: nodes.filter((n) => n.props?.className).flatMap((n) => String(n.props.className).split(' ')),
    tags: nodes.filter((n) => n.tag).map((n) => n.tag),
    inputs: nodes.filter((n) => n.tag === 'input'),
  }
}

test('the card renders rows, switches, badges and toolbar from the snapshot', async () => {
  // The wrapper supplies the real zh translator, so assertions read the
  // resolved wording — which also proves the dictionary keys resolve.
  const mounted = await renderCard({ hidden: ['big-pickle'] })
  try {
    const { texts, classes, tags, inputs } = collect(mounted.tree)
  const has = (cls) => classes.includes(cls)
  // Rows: ids, status words, switches honouring hiddenModels.
  for (const id of ['space-bunny-free', 'big-pickle', 'muse-spark-1.3-contributor-free']) {
    assert.ok(texts.includes(id), `row for ${id} renders`);
  }
  assert.ok(texts.includes('显示') && texts.includes('已隐藏'), 'both status words render');
  assert.ok(has('opf-switch') && has('opf-track') && has('opf-thumb'), 'iOS-style switches render');
  // Shown models lead, each group keeping the catalogue's alphabetical order.
  const ids = ['space-bunny-free', 'big-pickle', 'muse-spark-1.3-contributor-free']
  assert.deepEqual(
    texts.filter((t) => ids.includes(t)),
    ['space-bunny-free', 'muse-spark-1.3-contributor-free', 'big-pickle'],
    'shown models come first, alphabetical within each group',
  )
  assert.deepEqual(inputs.map((i) => i.props.checked), [true, true, false],
    'switch states follow hiddenModels, in the new row order')
  // Badges: image + top thinking level, display-capitalized, per model.
  assert.ok(has('opf-badge-vision') && has('opf-badge-think'), 'both badge kinds render');
  assert.ok(texts.some((t) => t.includes('Max')), 'space-bunny shows its top level');
  assert.ok(texts.some((t) => t.includes('XHigh')), 'muse-spark shows its top level');
  assert.ok(!texts.some((t) => /(^| )xhigh($| )/.test(t)), 'no raw lowercase level leaks');
  assert.ok(texts.includes('视觉'), 'the vision badge word renders');
  assert.ok(texts.some((t) => t.includes('思考')), 'the thinking badge word renders');
  assert.ok(texts.includes('多模态视觉') && texts.includes('思考推理'), 'the footer legend renders');
  // Toolbar: pill buttons with icons, timestamp with green dot.
  assert.ok(texts.includes('立即刷新') && texts.includes('立即探测'), 'both actions render');
  assert.ok(tags.filter((t) => t === 'svg').length >= 4, 'buttons and badges carry icons');
  assert.ok(texts.some((t) => /20\d\d\/\d{1,2}\/\d{1,2} \d{2}:\d{2}:\d{2}/.test(t)), 'timestamp renders as YYYY/M/D H:mm:ss');
  assert.ok(has('opf-dot'), 'the probe timestamp carries the green dot');
  assert.ok(has('opf-toolbar') && has('opf-foot') && has('opf-head') && has('opf-body'), 'card sections render');
  } finally {
    mounted.dispose()
  }
});

test('a probe round paints the capsule, the counter and a badge per row', async () => {
  // The (2) mock's live state, driven end to end: clicking the probe button
  // starts the POST, the captured timers fire the polls, and the rows repaint
  // from each reading until the POST answers.
  let postResolve = null
  const progress = {
    running: true,
    total: 3,
    done: 1,
    current: 'big-pickle',
    results: { 'space-bunny-free': { status: 'ok', ms: 142 } },
    startedAt: 1,
  }
  const mounted = await renderCard({
    hidden: [],
    routes: ({ url, method }) => {
      if (url.endsWith('/api/probe') && method === 'POST') {
        return new Promise((resolve) => { postResolve = () => resolve({ ok: true, json: async () => SNAPSHOT }) })
      }
      if (url.endsWith('/api/probe') && method === 'GET') {
        return { ok: true, json: async () => ({ ...progress, results: { ...progress.results } }) }
      }
      return { ok: true, json: async () => SNAPSHOT }
    },
  })
  try {
    const button = mounted.findButton('立即探测')
    assert.ok(button, 'the probe button renders');
    // Clicking starts the POST (which hangs) and the first poll.
    button.props.onClick()
    await mounted.fireTimers()
    const mid = collect(mounted.rerender())
    const midHas = (cls) => mid.classes.includes(cls)
    assert.ok(midHas('opf-capsule'), 'the progress capsule renders');
    assert.ok(mid.texts.some((t) => t.includes('正在探测')), 'the capsule names the action');
    assert.ok(mid.texts.some((t) => t.includes('1/3')), 'the capsule counts done/total');
    assert.ok(midHas('opf-bar') && midHas('opf-fill'), 'the mini progress bar renders');
    // The finished row reports its latency, the current row spins, the queued
    // row waits.
    assert.ok(mid.texts.some((t) => t.includes('142ms')), 'a finished row shows its latency');
    assert.ok(mid.texts.some((t) => t.includes('探测中')), 'the current row spins');
    assert.ok(mid.texts.some((t) => t.includes('等待中')), 'queued rows wait');
    // Capability badges stay on screen mid-round. They used to step aside and
    // come back at the end, so every row lost its identity exactly while the
    // reader waited to find out what it was — and came back looking different
    // for reasons that had nothing to do with the model.
    const rowLabels = (tree) => [...walk(tree)].filter((n) => n.tag === 'label'
      && String(n.props?.className).split(' ').includes('opf-row'))
    const rowHasBadge = (row) => [...walk(row)].some((d) => String(d.props?.className ?? '')
      .split(' ').some((c) => c === 'opf-badge-vision' || c === 'opf-badge-think'))
    assert.ok(rowLabels(mounted.rerender()).some(rowHasBadge), 'capability badges stay on screen mid-round');
    assert.ok(midHas('opf-row-probing'), 'the active row highlights');
    assert.ok(midHas('opf-row-waiting'), 'queued rows dim');
    // The probe button shows its loading state and refresh is fenced off.
    const busyBtn = mounted.findButton('探测中…')
    assert.ok(busyBtn, 'the probe button shows its loading state');
    // Let the POST answer: polling stops, and the card keeps the round as a
    // report instead of blinking back to a bare list. The stubbed GET is still
    // `running: true`, so the pill stays live here — the finished-state
    // assertions live in the test below, which is where the reading is frozen.
    postResolve()
    await mounted.fireTimers()
    const end = collect(mounted.rerender())
    assert.ok(end.texts.some((t) => t.includes('视觉')), 'capability badges return');
  } finally {
    mounted.dispose()
  }
});

test('a finished round stays on screen: tally, per-row reasons, and the dead model named', async () => {
  // The reported bug, end to end: the POST answers, the progress is wiped, and
  // a card that says nothing looks like a probe that never ran. The host's own
  // frozen reading is the source of truth here — the card re-reads it after the
  // POST precisely so the report cannot be a half-polled guess.
  let postResolve = null
  const finished = {
    running: false,
    total: 3,
    done: 3,
    current: null,
    results: {
      'space-bunny-free': { status: 'ok', ms: 218 },
      'big-pickle': { status: 'failed', ms: 5000, code: 'timeout', http: 0 },
      'deepseek-v4-flash-free': { status: 'failed', ms: 41, code: 'dead', http: 404 },
    },
    startedAt: 1,
  }
  let live = true
  const mounted = await renderCard({
    hidden: [],
    routes: ({ url, method }) => {
      if (url.endsWith('/api/probe') && method === 'POST') {
        return new Promise((resolve) => {
          postResolve = () => resolve({
            ok: true,
            // The POST hands back a catalogue WITHOUT the dead model: that is
            // the whole reason the report has to survive on its own.
            json: async () => ({ ...SNAPSHOT, visible: ['space-bunny-free', 'big-pickle', 'muse-spark-1.3-contributor-free'] }),
          })
        })
      }
      if (url.endsWith('/api/probe') && method === 'GET') {
        return { ok: true, json: async () => (live
          ? { ...finished, running: true, done: 0, current: 'space-bunny-free', results: {} }
          : finished) }
      }
      return { ok: true, json: async () => SNAPSHOT }
    },
  })
  try {
    mounted.findButton('立即探测').props.onClick()
    await mounted.fireTimers()
    live = false
    postResolve()
    await mounted.fireTimers()
    const end = collect(mounted.rerender())
    const endHas = (cls) => end.classes.includes(cls)
    // The round is still a fact on screen, with its tally.
    assert.ok(endHas('opf-capsule'), 'the finished round keeps its capsule');
    assert.ok(endHas('opf-capsule-mixed'), 'a round with failures is tinted as one');
    assert.ok(end.texts.some((t) => t.includes('探测完成')), 'the capsule reads as finished');
    assert.ok(end.texts.some((t) => t.includes('1')), 'the tally renders');
    // Per-row: the success keeps its latency, the failure NAMES its reason.
    assert.ok(end.texts.some((t) => t.includes('218ms')), 'the answered row keeps its latency');
    assert.ok(end.texts.some((t) => t.includes('探测超时')), 'the timed-out row says so, not just "failed"');
    // The dead model has no row left to speak for itself, so it is named.
    assert.ok(end.texts.some((t) => t.includes('本轮下架')), 'the removed model is announced');
    assert.ok(end.texts.some((t) => t.includes('deepseek-v4-flash-free')), 'and named by id');
    assert.ok(!end.texts.includes('等待中'), 'a finished round leaves no row waiting');
    // The tooltip carries the full story, not just the word on the badge.
    const failBadges = [...walk(mounted.rerender())].filter((n) => String(n.props?.className ?? '')
      .split(' ').includes('opf-probe-fail'))
    assert.equal(failBadges.length, 1, 'one failed row in this catalogue')
    assert.match(String(failBadges[0].props.title), /探测超时/, 'the badge explains itself on hover');
  } finally {
    mounted.dispose()
  }
});

test('a refused round accuses no model: grey rows, one banner, separate count', async () => {
  // The reported bug. A round that ran into a gated window learned nothing
  // about any model, and for a while the card painted exactly that ignorance
  // red on every row — so a model that works in DSH wore a failure badge. The
  // refusal is a fact about the round, and it renders as one banner plus grey
  // "unmeasured" rows, never as red verdicts.
  const refused = {
    running: false,
    total: 3,
    done: 3,
    current: null,
    results: {
      'space-bunny-free': { status: 'ok', ms: 218 },
      'big-pickle': { status: 'failed', ms: 12, code: 'anon-gated', http: 403 },
      'muse-spark-1.3-contributor-free': { status: 'failed', ms: 9, code: 'quota-exhausted', http: 429 },
    },
    startedAt: 1759146617000,
  }
  const mounted = await renderCard({
    hidden: [],
    routes: ({ url, method }) => {
      if (url.endsWith('/api/probe') && method === 'GET') return { ok: true, json: async () => refused }
      return { ok: true, json: async () => SNAPSHOT }
    },
  })
  try {
    await mounted.fireTimers()
    const end = collect(mounted.rerender())
    const endHas = (cls) => end.classes.includes(cls)
    // The banner says what happened and, crucially, what it does NOT mean.
    assert.ok(end.texts.some((t) => t.includes('本轮没能测到')), 'the round-level refusal is announced');
    assert.ok(end.texts.some((t) => t.includes('不是该模型的结论')), 'and disowned as a verdict');
    // And WHEN, so a retained refusal cannot read as a current fact.
    assert.ok(end.texts.some((t) => /20\d\d\/\d{1,2}\/\d{1,2}/.test(t)), 'the banner names the round time');
    // The refused rows are grey "unmeasured", never red.
    assert.ok(end.texts.some((t) => t.includes('未测到')), 'refused rows read as unmeasured');
    const failBadges = [...walk(mounted.rerender())].filter((n) => String(n.props?.className ?? '')
      .split(' ').includes('opf-probe-fail'))
    assert.equal(failBadges.length, 0, 'no row wears red for a refusal');
    // The answered row still shows its latency; the tally keeps the categories apart.
    assert.ok(end.texts.some((t) => t.includes('218ms')), 'the answered row is unaffected');
    assert.ok(endHas('opf-capsule'), 'the capsule still reports the round');
  } finally {
    mounted.dispose()
  }
});

test('a re-confirmed death is not announced as a removal that just happened', async () => {
  // The reported bug, verbatim from the 2026-09-30 03:31:17 round:
  // `deepseek-v4-flash-free` had been judged dead four hours earlier (23:30:17)
  // and had already left the list. The round re-asked it, upstream said the
  // same thing, and the card filed that under "本轮下架" — telling the reader a
  // model had just been taken away when nothing had changed since the night
  // before. The backend now says which kind of dead it is; the card must keep
  // the two apart.
  const round = {
    running: false,
    total: 2,
    done: 2,
    current: null,
    results: {
      'space-bunny-free': { status: 'ok', ms: 1196 },
      // Re-asked, re-confirmed: already dead before the round, so `removed:false`.
      'deepseek-v4-flash-free': { status: 'failed', ms: 682, code: 'dead', http: 400, removed: false },
      // Freshly removed: it was visible when the round started.
      'big-pickle': { status: 'failed', ms: 41, code: 'not-listed', http: 0, removed: true },
    },
    startedAt: 1759146617000,
  }
  const mounted = await renderCard({
    hidden: [],
    snapshot: { ...SNAPSHOT, visible: ['space-bunny-free'] },
    routes: ({ url }) => {
      if (url.endsWith('/api/probe')) return { ok: true, json: async () => round }
      return { ok: true, json: async () => SNAPSHOT }
    },
  })
  try {
    await mounted.fireTimers()
    const end = collect(mounted.rerender())
    const summary = end.texts.filter((t) => t.includes('下架') || t.includes('复核'))
    // The fresh removal is still announced — that one is real.
    assert.ok(end.texts.some((t) => t.includes('本轮下架：big-pickle')), 'a real removal is still announced, by id');
    // The re-confirmation is reported as exactly that, and never as a removal.
    // The two receipts share one line, so this checks the id is not filed
    // under 本轮下架 rather than that the words are absent from the line.
    assert.ok(
      summary.some((t) => t.includes('复核仍不可用：deepseek-v4-flash-free')),
      'the re-confirmation is labelled and named by id',
    );
    assert.ok(
      !summary.some((t) => t.includes('下架：deepseek-v4-flash-free')),
      'never filed under 本轮下架, which removed nothing',
    );
    // The capsule keeps the two counts apart too.
    assert.ok(
      end.texts.some((t) => /本轮下架\s*1/.test(t)),
      'the capsule counts one removal, not two',
    );
  } finally {
    mounted.dispose()
  }
})

test('a refused round names the upstream, never the reader\'s network', async () => {
  // The 03:31:17 round recorded eleven HTTP statuses and zero transport
  // failures: nothing reached the network layer. The banner called it "当时的
  // 网络状况", which sent the reader to debug a proxy/VPN/DNS path that was
  // never broken — and the repo's own reverse-engineering notes forbid reading a
  // FreeTierError body as a verdict about the IP. Same for the per-row advice:
  // "匿名额度被闸" claims the cause the evidence does not support.
  const refused = {
    running: false,
    total: 2,
    done: 2,
    current: null,
    results: {
      'space-bunny-free': { status: 'ok', ms: 1196 },
      'big-pickle': { status: 'failed', ms: 347, code: 'anon-gated', http: 403 },
    },
    startedAt: 1759146617000,
  }
  const mounted = await renderCard({
    hidden: [],
    routes: ({ url }) => {
      if (url.endsWith('/api/probe')) return { ok: true, json: async () => refused }
      return { ok: true, json: async () => SNAPSHOT }
    },
  })
  try {
    await mounted.fireTimers()
    const end = collect(mounted.rerender())
    const banner = end.texts.filter((t) => t.includes('本轮没能测到'))
    assert.equal(banner.length, 1, 'the refusal is announced once')
    assert.match(banner[0], /上游/, 'the banner blames the upstream answer')
    assert.doesNotMatch(banner[0], /网络状况/, 'not the reader\'s network, which never failed')
    // The per-row tooltip must not claim the anonymous bucket was gated either:
    // a FreeTierError body is one upstream response to several conditions, and
    // a key is not guaranteed to lift it.
    const failBadges = [...walk(mounted.rerender())].filter((n) => String(n.props?.className ?? '')
      .split(' ').includes('opf-probe-fail'))
    assert.equal(failBadges.length, 0, 'a refusal is never a red row')
    assert.ok(
      !end.texts.some((t) => t.includes('匿名额度被闸')),
      'the row advice does not assert the bucket was gated',
    );
  } finally {
    mounted.dispose()
  }
})

test('the untrusted-round note promises only what the code enforces', async () => {
  // The round-level note used to end "模型显示保持不变" — a global claim about
  // every model. What the catalogue actually enforces (src/catalog.ts) is
  // narrower and specific: an inconclusive outcome writes no verdict, so THOSE
  // models keep their visibility; a `dead` earned by sweeping both channels is
  // still recorded inside the very same round. The note now says the enforced
  // half, so it cannot be caught out by a mixed round.
  const untrusted = { ...SNAPSHOT, probeInconclusive: true }
  const mounted = await renderCard({
    hidden: [],
    // `routes` answers every fetch, so the untrusted snapshot has to come from
    // here — the `snapshot` option is only the fallback when no route is given.
    routes: () => ({ ok: true, json: async () => untrusted }),
  })
  try {
    await mounted.fireTimers()
    const end = collect(mounted.rerender())
    const note = end.texts.find((t) => t.includes('没能测到'))
    assert.ok(note !== undefined, 'the untrusted round is announced')
    assert.match(note, /这些模型的显示保持不变/, 'it names the models whose visibility is kept')
    assert.doesNotMatch(note, /结论不可信/, 'and stops claiming the whole round concluded nothing')
  } finally {
    mounted.dispose()
  }
})

test('a refusal names which upstream condition answered, not just "refused"', async () => {
  // `anon-gated` deliberately folds three upstream conditions into one code,
  // because none of them is a verdict about the model. But the reader's next
  // move differs for each: an exhausted tier, a request that failed to carry a
  // session id, and a route that only answers the OpenCode client. Three rounds
  // of diagnosis stalled on this being unanswerable, so the round now carries
  // the marker and the card shows it.
  const round = {
    running: false,
    total: 2,
    done: 2,
    current: null,
    results: {
      'space-bunny-free': { status: 'ok', ms: 1209 },
      'big-pickle': { status: 'failed', ms: 354, code: 'anon-gated', http: 403, marker: 'FreeTierError' },
    },
    startedAt: 1759146617000,
  }
  const mounted = await renderCard({
    hidden: [],
    routes: ({ url }) => {
      if (url.endsWith('/api/probe')) return { ok: true, json: async () => round }
      return { ok: true, json: async () => SNAPSHOT }
    },
  })
  try {
    await mounted.fireTimers()
    const end = collect(mounted.rerender())
    const banner = end.texts.find((t) => t.includes('本轮没能测到'))
    assert.ok(banner !== undefined, 'the refusal is announced')
    assert.match(banner, /FreeTierError/, 'the banner names the condition that answered')
    // Still hedged: knowing the marker is not a verdict about the model.
    assert.match(banner, /不是该模型的结论/, 'and still disowned as a verdict on the model')
    // A result with no marker (an older backend) must not invent one.
    assert.ok(
      !end.texts.some((t) => t.includes('MissingSessionID')),
      'a refusal without a marker does not borrow another one',
    )
  } finally {
    mounted.dispose()
  }
})

test('a live round is followed: the pill counts down and rows report progress', async () => {
  // The live view never worked. The poll timer outlives the render that created
  // it, and that render captured `probing` as it was BEFORE the click — still
  // false — so the chain returned after one tick and the pill froze while the
  // round ran on. What the reader saw was no process at all, only the final
  // report the POST reads back. Driven here across several poll ticks.
  //
  // The catalogue POST is left pending, as it is in the host: the round blocks
  // it, which is the whole time window the live view has to live in.
  const first = {
    running: true, total: 3, done: 1, current: 'big-pickle',
    results: { 'space-bunny-free': { status: 'ok', ms: 218 } },
    startedAt: 1759146617000,
  }
  const second = {
    running: true, total: 3, done: 2, current: 'muse-spark-1.3-contributor-free',
    results: {
      'space-bunny-free': { status: 'ok', ms: 218 },
      'big-pickle': { status: 'ok', ms: 402 },
    },
    startedAt: 1759146617000,
  }
  // Flipped by the test, not by a read count: how many reads happen before an
  // assertion is a property of the harness, not of the behaviour under test.
  let advance = false
  const mounted = await renderCard({
    hidden: [],
    routes: ({ url, method }) => {
      if (url.endsWith('/api/probe') && method === 'POST') return new Promise(() => {})
      if (url.endsWith('/api/probe') && method === 'GET') {
        return { ok: true, json: async () => (advance ? second : first) }
      }
      return { ok: true, json: async () => SNAPSHOT }
    },
  })
  try {
    mounted.findButton('立即探测').props.onClick()
    await mounted.fireTimers()
    const opening = collect(mounted.rerender())
    assert.ok(opening.texts.some((t) => t.includes('正在探测')), 'the pill says a round is running')
    assert.ok(opening.classes.includes('opf-bar'), 'with a bar to fill')
    assert.ok(opening.texts.some((t) => t.includes('1/3')), 'and a count for this round')
    assert.ok(opening.texts.some((t) => t.includes('218ms')), 'the answered row keeps its latency')
    assert.ok(opening.texts.some((t) => t.includes('探测中')), 'the model being asked says so')
    assert.ok(opening.texts.some((t) => t.includes('等待中')), 'and the ones not asked yet are queued')
    // Capability badges stay put. A round used to take them away and hand them
    // back, so every row lost its identity exactly while the reader waited to
    // find out what it was, then came back looking different for reasons that
    // had nothing to do with the model.
    assert.ok(opening.texts.some((t) => t.includes('视觉')), 'the vision badge survives the round')
    assert.ok(opening.texts.some((t) => t.includes('Max')), 'and so does the thinking level')

    // The chain must survive past the first tick — that is the whole defect:
    // the round moves on, and the pill must move with it.
    advance = true
    await mounted.fireTimers()
    const later = collect(mounted.rerender())
    assert.ok(later.texts.some((t) => t.includes('402ms')), 'a later poll is still applied')
    assert.ok(later.texts.some((t) => t.includes('2/3')), 'and the count advanced')
    assert.ok(later.texts.some((t) => t.includes('探测中')), 'still following the round')
  } finally {
    mounted.dispose()
  }
})

test('switched-on models are pinned to the top, each group still alphabetical', async () => {
  // Someone reading this panel is looking for "what can I use", so what they
  // can use leads. The order WITHIN each group is the catalogue's — the card
  // partitions, it does not re-sort, so there is one owner for the order.
  const shown = ['apple-free', 'mango-free', 'zebra-free']
  const off = ['banana-free', 'cherry-free']
  const ids = [...shown, ...off]
  const mounted = await renderCard({
    hidden: ['banana-free', 'cherry-free'],
    snapshot: {
      ...SNAPSHOT,
      visible: ids,
      models: ids.map((id) => ({ id, image: false, thinking: null })),
    },
  })
  try {
    const { texts } = collect(mounted.rerender())
    assert.deepEqual(
      texts.filter((t) => ids.includes(t)),
      [...shown, ...off],
      'the on-switch group leads, the off-switch group follows, both alphabetical',
    )
  } finally {
    mounted.dispose()
  }
})

test('a model outside the round wears no probe badge at all', async () => {
  // A round only asks about the models the user has switched ON. The panel used
  // to call every untouched row "waiting", which promises a round that will
  // never reach it — a model the user deliberately switched off was announced
  // as queued. Only the server knows the round's scope, so it sends it.
  const live = {
    running: true,
    total: 1,
    done: 0,
    current: 'big-pickle',
    // Only one of the two models is in this round.
    targets: ['big-pickle'],
    results: {},
    startedAt: 1759146617000,
  }
  const mounted = await renderCard({
    hidden: [],
    routes: ({ url, method }) => {
      if (url.endsWith('/api/probe') && method === 'POST') return new Promise(() => {})
      if (url.endsWith('/api/probe') && method === 'GET') return { ok: true, json: async () => live }
      return { ok: true, json: async () => SNAPSHOT }
    },
  })
  try {
    mounted.findButton('立即探测').props.onClick()
    await mounted.fireTimers()
    const mid = collect(mounted.rerender())
    // The covered model is in flight and says so.
    assert.ok(mid.texts.some((t) => t.includes('探测中')), 'the covered row spins')
    // The uncovered one says nothing at all — no badge, and not dimmed either.
    const rows = [...walk(mounted.rerender())].filter((n) => n.tag === 'label'
      && String(n.props?.className).split(' ').includes('opf-row'))
    const byId = (needle) => rows.find((r) => [...walk(r)].some((d) => d.text === needle))
    const coveredRow = byId('big-pickle')
    const skippedRow = byId('space-bunny-free')
    assert.ok(coveredRow, 'the covered row renders')
    assert.ok(skippedRow, 'the skipped row still renders')
    const hasProbeBadge = (row) => [...walk(row)].some((d) => String(d.props?.className ?? '')
      .split(' ').some((c) => c.startsWith('opf-probe')))
    assert.ok(hasProbeBadge(coveredRow), 'the covered row wears a probe badge')
    assert.ok(!hasProbeBadge(skippedRow), 'the skipped row wears none')
    assert.ok(!String(skippedRow.props?.className).includes('opf-row-waiting'),
      'and is not dimmed as if queued')
  } finally {
    mounted.dispose()
  }
})

test('zh and en dictionaries carry the same key set', async () => {
  const src = await readFile(CLIENT_URL, 'utf8')
  const grab = (tag) => {
    const start = src.indexOf(`var ${tag} = {`)
    const end = src.indexOf('\n\t\t};', start)
    const body = src.slice(start, end)
    return [...body.matchAll(/"([a-zA-Z.]+)":/g)].map((m) => m[1]).sort()
  }
  const zh = grab('zh')
  const en = grab('en')
  assert.ok(zh.length > 0 && en.length > 0, 'both dictionaries exist')
  assert.deepEqual(zh, en, 'a key in one language but not the other renders half-translated')
});
