# Changelog

All notable user-visible changes to `dsh-opencode-free` are recorded here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and
this project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.3.0] - unreleased

Compared with `0.2.1` (`02ef277`), the last version published from this
repository. Every entry below is traceable to a commit in this repository; the
supporting commit and code reference for each one is in
`.scratch/release-0.3.0/audit.md`.

### Added

- **A model visibility panel on the plugin's details page.** Every free model
  gets a switch. A model you switch off leaves the picker and the plugin's model
  list, and comes back when you switch it on. An id the catalogue no longer
  knows about is kept in the setting rather than dropped, so turning a model off
  and upgrading the plugin does not lose your choice.
  (`73eed0b`, `1be8b49`; `src/index.ts:98`, `src/index.ts:333`)

- **An availability check you can run from the panel.** "Probe now" runs a round
  that actually asks each model, and you watch it happen: a progress pill counts
  down, the model currently being asked says so, the ones not reached yet are
  queued, and each row ends with its own outcome and how long it took.
  (`b7e27d0`, `193ba78`; `src/index.ts:82`, `src/index.ts:84`, `src/index.ts:264`)

- **Capability badges on every model row** — vision support, context length,
  maximum output, and the strongest thinking level the model offers — taken from
  what models.dev publishes for that model rather than assumed.
  (`a19c14f`, `b7e27d0`; `src/catalog.ts` `buildModel`)

- **Per-model thinking levels, taken from models.dev.** A model offers exactly
  the effort levels that model publishes, including an explicit `off` entry.
  (`a19c14f`, `24706e7`; `tests/catalog.test.mjs:305`, `tests/catalog.test.mjs:321`)

- **The model list follows models.dev.** A newly-published free model shows up
  without waiting for a plugin update, and a withdrawn one leaves on its own. The
  list is refreshed with one conditional request and reuses its cached copy
  while it is still fresh, so it does not cost an inference call to keep current.
  (`56ec564`, `b13b18c`; `docs/adr/0002-catalogue-source-of-truth.md`)

- **A refusal now names which upstream condition answered.** "Refused" arrives as
  one of `FreeTierError` (free-tier admission refused), `MissingSessionID` (the
  request carried no session id), or "only the OpenCode client may send this",
  because the reader's next move differs for each and the three were previously
  folded into a single undifferentiated refusal.
  (`a1cfae4`; `src/zen-provider.ts:495`, `src/client.js:648`)

- **`DSH_OPENCODE_FREE_DEBUG=1` prints the upstream's own error body** when a
  probe is refused — truncated to 300 characters, and an upstream error payload
  only, never a request. The body is not retained anywhere else, so this is the
  only way to read what a refusal actually said after the round ends.
  (`a1cfae4`; `src/zen-provider.ts:895`, `src/zen-provider.ts:1176`)

### Changed

- **The declared host is now the host this actually runs on.** Peer dependencies
  move to `0.2.0-rc.2` and `@earendil-works/pi-ai` to `^0.87.1`. The previous
  release declared `0.2.0-rc.1` and `^0.85.1` while running against
  `0.2.0-rc.2` and `0.87.1`; it worked only because the payload backstop
  compensated. The pin is exact and deliberately does **not** span both releases:
  the two differ in how a request context reaches the provider, so a union would
  advertise a compatibility only one side of which has ever been observed.

- **The model list is alphabetical by id, and the panel puts the models you have
  switched on at the top.** Within each group the order is the catalogue's. The
  panel decides only what comes first; it does not re-sort, so there is one owner
  for the order.
  (`bee1d06`, `74cdf6a`; `src/catalog.ts:247`, `src/client.js:925`)

- **A round only asks about the models you have switched on.** A probe spends a
  request from a bucket shared by everything behind your egress, so the round no
  longer spends one on an answer you will never read.
  (`bee1d06`; `src/catalog.ts:946`)

- **A model that has gone away leaves the list.** It is no longer carried in a
  separate greyed-out "excluded" area, and a model Zen stops listing is dropped
  without spending an inference request to discover it. A model Zen puts back
  reappears — membership is never a permanent verdict.
  (`d9fa16d`, `326137e`, `7b45426`; `tests/catalog.test.mjs:1068`, `tests/catalog.test.mjs:1099`)

- **A connection failure tells you what to look at.** A dropped socket, refused
  connection, or reset now reports its cause — the proxy, VPN, firewall, or DNS
  path — instead of the bare words "Connection error."
  (`d9fa16d`; `src/zen-provider.ts:460`; `tests/compatibility.test.mjs:807`)

- **An upstream refusal no longer points at your network.** The round banner now
  says the upstream refused at the time, and carries a timestamp and a "Probe now"
  to retry, so a refusal recorded hours ago does not read as a current fact.
  (`f9e405c`, `20d8b01`; `src/client.js:1184`)

- **The round's banner promises only what the code enforces.** It now names the
  models whose visibility was kept, rather than claiming the whole round concluded
  nothing — a model that went away in the same round is still recorded.
  (`a1cfae4`; `tests/client-render.test.mjs:559`)

- **A model re-confirmed gone is not reported as a removal that just happened.**
  If a round re-asks a model an earlier round already removed and upstream agrees,
  the panel says "re-confirmed gone" with the model's name; the count of models
  this round removed stays accurate.
  (`20d8b01`, `a1cfae4`; `src/client.js:635`, `src/client.js:1156`)

- **A restart could re-announce a removal that already happened.** The round
  report survived the restart, but not its `removed` flag: the write path kept
  only the `false` form, so a row that really did remove a model came back with
  no flag — and the card reads a missing flag as a fresh removal. The write and
  read paths are inverses of each other again.
  (`src/catalog.ts` `readLastRound`; `tests/catalog.test.mjs`)

- **A channel that never finished could remove a model for good.** One channel
  refusing and a second dropping its socket still concluded `dead`, because the
  verdict ranking put a positive refusal above "no conclusion" — and `dead` is
  the only verdict that writes the terminal `swept` marker. A request that never
  completed has said nothing about the model, and a 404 down the wrong channel
  looks exactly like a dead one, which is the whole reason the sweep exists.
  Silence now **vetoes** instead of losing an argument: `dead` requires every
  channel that was asked to finish, and the row keeps the reason and status so
  "we could not tell" still says why. The strength comparison is gone — under
  this rule there is nothing left for it to compare.

- **The channel a probe won on was thrown away.** A model whose probe answered on
  the second channel reported `ok` and then went on being routed by the first, so
  the failure the probe had just ruled out came straight back on the next chat.
  The measured channel now travels with the verdict and is applied in both
  places that matter: when the round records it, and when a warm read adopts a
  cache that already holds one — the half that makes it survive a restart. A
  **refusal** never records a channel; it is evidence that this one did not work,
  not that another would.
  (`src/catalog.ts` `applyMeasuredChannel`; `src/zen-provider.ts` `probeModel`)

- **A catalogue refresh could overwrite a round that was in flight.** The
  finished-round report belongs to startup, but `adopt()` restored it on every
  sync too — so a refresh during a round swapped the live progress for the
  previous round's snapshot and the round carried on counting on the swapped-in
  object, ending at **4/2** and persisting that. Restoration is startup-only now.
  The 304 path never reached `adopt`, which is why only a real body showed it.
  (found by review 2026-10-01)

- **Disabling the plugin could disable another plugin.** The `node:http` disposer
  restored the original methods unconditionally, so a plugin that wrapped
  `http.request` afterwards had its wrapper removed along with ours. It restores
  only what is still our own wrapper now — the ownership check the fetch guard has
  made since the start. That also fixes the reload order, where an older patch's
  disposer used to strip a newer patch's wrapper.
  (found by review 2026-10-01)

- **A watched automatic round left the card stale.** The catalogue was re-read only
  for a round a click had awaited, so a page open across the daily round kept a
  1970 timestamp and outdated inconclusive wording until it was reopened. The
  card now separates a round it **watched** from a report that was already on disk
  when the page opened — the second still costs no request.
  (found by review 2026-10-01)

- **A slow catalogue gate could end the poll before the requested round
  started.** The backend publishes `running: true` only after the Zen catalogue
  gate answers — one cheap GET — so a round slower than the poll interval hands
  the card the **previous** round's report, which reads as complete. The button
  came back, the panel settled, and the round that really did start was never
  seen. The card now compares the reading's `startedAt` against the one that was
  on screen when the button was pressed: still equal means ours has not been
  published yet, so it keeps waiting — bounded, and without repainting the stale
  report under a busy button.
  (`src/client.js` `adopt`, `probe`; found by review 2026-10-02)

- **A model was shown working before its channel was applied.** Per-model results
  are painted as they land, so a model already displayed as working must already
  be routed the way it worked. Applying the measured channel when the round
  finished left a visibly successful model on the channel the probe had just
  ruled out, for as long as the rest of the sequential round took. It is applied
  per model now; the cache write stays once per round.
  (`src/catalog.ts` `runProbeRound`; found by review 2026-10-02)

- **A round could judge models against an empty probe map.** A round reads the
  probe map twice: to decide what is already settled, and to fill the one field
  that separates a fresh removal from a re-confirmed old one. Both arrive with
  the warm cache read, which is fire-and-forget — so a round that started first
  read every prior verdict as "unknown": settled models were re-asked, and a
  model removed hours earlier was recorded as removed just now. `sync()` already
  waited on that promise for the same reason; a round does too now, bounded by
  the same timeout.
  (`src/catalog.ts` `runProbeRound`)

- **The strongest thinking level a model offers is no longer quietly downgraded.**
  The level the plugin asks for reaches the wire; a level the model does not
  publish is still clamped down rather than offered.
  (`a19c14f`; `tests/catalog.test.mjs:334`)

- **The round asks the catalogue before it asks the models.** The availability
  check spends one cheap catalogue request, and a model that model no longer
  lists is settled at zero inference cost.
  (`ab43aa0`, `1e9189d`; `tests/compatibility.test.mjs:496`)

- **A failed or unreachable catalogue refresh costs you nothing.** The model list
  you already have stays exactly as it was, and no verdict is written.
  (`56ec564`; `tests/catalog.test.mjs:734`, `tests/catalog.test.mjs:753`)

- **The Zen availability gate now expires on its own clock.** It was refreshed
  only as the first step of the daily probe round, so a model Zen withdrew
  stayed in the picker for up to 24 hours — long enough to be picked and to
  fail. `GET /zen/v1/models` costs no inference quota, so it is now re-asked
  every 30 minutes, lazily on read, with no new timer. `zenIds` gained a single
  writer: with two cadences running, two writers would mean the older answer
  could silently overwrite the newer one.

- **The catalogue re-check interval adapts to what the endpoint actually does.**
  Measured 2026-09-30: models.dev answers `If-None-Match` with `304` and zero
  bytes. So a re-check that hits costs a few hundred bytes rather than a
  5.2 MB download, and the interval drops to 6 hours — but only after a `304`
  has earned it. A fetch that transfers the body puts the interval back to
  24 hours, so an endpoint that stops honouring the header costs one download a
  day instead of four. The 6-hour window lives only inside a long-running
  process: the evidence that earned it is in-memory, and every boot re-downloads
  once and starts over at 24 hours.

- **The detail-page panel reports the blind spot in the two-source design.**
  If Zen serves a free-tier id that models.dev has not published yet, the panel
  names it. It is deliberately not added to the picker: its channel and context
  limits are not obtainable from any source available here, and a wrong number
  there is acted on rather than merely displayed. The ids are not a second list
  of offered models and never become rows.

- **"Probe now" no longer holds an HTTP request open for the whole round.** It
  answers `202` as soon as the round is accepted. A round is one request per
  model and a hung model can hold it for its full 15 s, so the button used to
  leave a request open for minutes — and if the host's web server enforces a
  request timeout, that would have failed rather than merely been slow. Two jobs
  moved to the progress poll, which already existed: noticing that the round
  ended, and releasing the busy button. The response carries no progress
  reading, because a round marks itself running only after asking Zen what it
  serves — a reading taken at that instant is the pre-round one, and a panel
  that adopted it would conclude the round had finished before it began.

### Fixed

- **The anonymous admission gate was a no-op on every request the plugin
  initiates itself.** pi-ai 0.87 normalises a legacy `Context` into a
  `TranscriptContext` before dispatch, and only that form can reach a provider,
  so writing the required `read`/`bash` tool names onto `context.tools` put them
  somewhere nothing reads. The gate now operates on the transcript, at every
  entry point, so the tools are where the provider actually looks. The payload-
  boundary backstop stays: it is version-agnostic, and it is what the measured
  result below rests on.

- **The availability check is admitted again.** Its outbound request could lose
  the `read` and `bash` tool names on the way down — the documented admission
  requirement for this tier — and the upstream answered `403 FreeTierError` to a
  request it would otherwise have served. The probe now re-asserts its admission
  tools on the final payload, the last boundary before the bytes leave, so a layer
  above it can no longer cost the probe its admission.
  (`a1cfae4`; `src/zen-provider.ts:428`, `src/zen-provider.ts:861`;
  `tests/compatibility.test.mjs:399`)

- **24 models were removed for good by a single wrong verdict.** A model is now
  only judged gone after every channel has refused it, the strongest conclusion
  across channels wins, and a gate or quota refusal is never retried on another
  channel and mistaken for a model failure. A death recorded before this sweep
  existed is re-checked and can come back. (`1b93d0e`, `1e9189d`, `5694f5b`;
  `src/catalog.ts:941`; `tests/catalog.test.mjs:1197`, `tests/compatibility.test.mjs:570`)

- **A network failure became a second request.** The global fetch guard's
  fallback `catch` wrapped the whole function, so the inner rethrow of a socket
  error was caught by it and the request was re-sent with the *un-rewritten*
  `init` — no `Authorization`, no session. Wi-Fi jitter therefore surfaced as
  "the anonymous tier refused us", which is exactly the diagnosis
  `TransportRecorder` and `describeTransportCause` exist to avoid.

- **The probe round report vanished.** Two writers, one field. The full-sync
  branch rebuilt the cache record without `lastRound`, and the round wrote to
  disk without updating the in-memory copy the next sync reads — so up to four
  revalidations a day could each delete it. Either path deleted the report. The
  test guarding it covered only the `304` branch and, because it pinned no
  `ttlMs`, never actually performed a revalidation at all. Pre-existing, but the
  shorter revalidation window is what made the loss frequent.

- **`catalogTemplate()` no longer silently matches nothing.** It pinned
  `mimo-v2.5-free`, which pi-ai 0.87 renamed to `mimo-v2.6-flash-free`, so every
  caller had been falling back to `builtinFreeModels()[0]` — `big-pickle`, a
  model Zen does not serve. Harmless in content (the template supplies identity
  only; the channel is inferred and capabilities come from models.dev), but the
  fallback is now explicit and prefers a record the free tier serves.

- **An empty Zen listing can no longer reach the gate.** Neither can a
  *disjoint* one: a well-formed answer naming none of the models we hold is far
  likelier to be a changed shape, a wrong egress or a different tenant than a
  simultaneous withdrawal of every free model, and acting on it emptied the
  picker — the one outcome the gate exists to prevent. Null, non-array, empty
  and wholly-disjoint are all now "could not tell", on both doors into the
  gate. Found by review; the `[]`-only guard shipped believing it was
  sufficient.

- **The plugin identified itself as a version it was no longer.** The
  `User-Agent` the provider sends upstream was a second, hardcoded copy of the
  version and had drifted to `0.2.0` while `package.json` said `0.3.0`. Both
  strings now derive from one definition, and the release check asserts it.

- **A reasoning model that spent its whole budget thinking was counted as a
  failure.** A model that runs out of budget before it answers now counts as
  answered.
  (`5694f5b`; `tests/compatibility.test.mjs:435`)

- **"Not measured" was drawn as "measured, and has a problem."** A model the
  upstream refused is now shown grey, accused of nothing, counted separately from
  the models that failed, and never as a red row.
  (`f9e405c`; `tests/client-render.test.mjs:408`)

- **The live progress never appeared, and the capability badges vanished for the
  duration of every round.** The progress chain stopped after one tick, so the
  panel showed no process at all until the round ended; and each row lost its
  badges exactly while you were waiting to find out what the row was. Both are
  fixed: the progress follows the round, and the badges stay on screen throughout.
  (`7ac6f0c`; `tests/client-render.test.mjs:628`, `tests/client-render.test.mjs:676`)

- **A finished round's report was lost on restart**, leaving the progress area
  blank, which reads as "the probe display is gone" and made restarting look
  worse. The report — the tally, every row's outcome and the time the round ran
  — is now persisted alongside the verdicts and restored on start.
  (`97dcc07`; `src/catalog.ts:1055`; `tests/catalog.test.mjs:1410`)

- **A model the round skipped was shown as queued.** The panel used to call every
  untouched row "waiting", which promised the round would reach a model it never
  intended to ask about.
  (`bee1d06`; `tests/client-render.test.mjs:720`)

- **A probe failure with no reason showed a red row and no explanation.** Every
  outcome now carries a code and a status the panel can put in words, including a
  prober that throws.
  (`9200075`; `tests/catalog.test.mjs:1020`, `tests/compatibility.test.mjs:757`)

- **The visibility panel did not appear at all under the host's live config
  shape.** The setting now unwraps through the host's ref, and the schema marks it
  volatile so the host serves the config row at all.
  (`1be8b49`; `tests/model-visibility.test.mjs:231`, `tests/model-visibility.test.mjs:241`)

- **Images attached to a message never reached the model.** The adapter resolved
  attachments to nothing unconditionally, so every image you sent was dropped
  before the request.
  (`e4b9124`; `src/index.ts:422`)

### Also fixed — found by running the suite on CI, not locally

Two of the defects above passed a full green suite on a developer machine and
were caught the first time the branch ran on a Linux runner. That makes the tests
themselves worth reporting:

- **A test raced the round it was asserting about.** "Re-confirming an old death"
  never drove its own round: the manual-round floor compares against a frozen
  clock, so `forceProbes()` refused, and the re-check it then read was the warm
  start's fire-and-forget round — whichever report happened to be mounted. It
  passed 165/165 locally and on Node 22 and 26, and failed on Node 24 about a
  third of the time. It now moves the clock past the floor, like every other
  test that wants a second round.
- **The gate above it is tested at the seam, not at the factory.** Whether the
  warm read lands before a round starts is local filesystem timing, so removing
  the new wait fails nothing at the factory level — verified, 0/10. The
  accompanying test drives `runProbeRound` with a warm read it controls, and
  fails on the spot if the wait is removed.
- **The audit gate was never green.** `.github/workflows/ci.yml` passed
  `pnpm audit --audit-level=high --no-fund`; `--no-fund` is npm's flag and pnpm's
  audit has never accepted it, so the step exited non-zero on all three Node
  versions. The comment beside the line claimed the flag kept the funding banner
  out of CI output — a claim nothing had ever executed.
- **Every fix above is mutation-checked.** Putting each one back the way it was
  makes its own test fail — including the two halves of the measured channel
  (the round applying it, and the warm read re-applying it), which are verified
  separately because fixing only one leaves the restart case broken.

### Also fixed — audit remediation

A full audit on 2026-09-30 found 51 issues; all are fixed here. Each entry says
what was observable before, because "correctness" is not a symptom.

**Correctness and cost**

- Forced probes are floored at 5 minutes: the POST route had no rate limit, and
  one round is up to 34 real requests against a bucket shared per egress IP.
- A peer marked `optional` is imported unconditionally at the top level, so a
  missing one failed at load with no installer warning — while both READMEs say
  "do not ignore peer dependency warnings".
- The response size cap ran *after* `response.text()`, so an oversized body was
  already fully resident when it was rejected.
- A dead socket re-asking a settled verdict is unchanged; but an unswept `dead`
  verdict is now re-checked, so a wrong channel cannot suppress a working model
  permanently.

**The test suite was not hermetic.** `tests/compatibility.test.mjs` never set
`DSH_HOME`, so its cases read and rewrote the developer's real
`~/.dsh/dsh-opencode-free/catalog.json` and really requested models.dev — while
the README claimed the suite does not use the network. Found by mutation-testing
the suite against itself.

**Accessibility** — every palette colour now meets WCAG AA against the card
(measured 2.99–4.35:1 before, 26/26 pass now), and the model switch declares a
focus indicator it previously had none of.

**Supply chain and process** — CI covers the Node range `engines` promises,
pins actions to commit SHAs, runs `pnpm audit`, and gates formatting.
`scripts/guard-dirty-publish.mjs` refuses to publish from a tree that does not
match the changelog.

### Measured after this release

Three consecutive probe rounds on `0.2.0-rc.2`: every model in scope answered,
and **zero** admission refusals. (Before the payload backstop, the same round
answered 1 of 10 and was refused 9 times.)

### Known limitation

- **A model that Zen stops listing cannot be re-checked.** A model judged gone in
  an early round and then dropped from Zen's own catalogue is neither visible nor
  eligible for the round, so the only way it returns is for Zen to list it again.
  The fix would have to re-probe models the catalogue no longer offers, at
  inference cost. Recorded here rather than fixed, because it is a pre-existing
  boundary and not a regression. (Found while preparing this release.)

### Not changed, and why

- **The probe's output budget stays at 1024 — now on measured evidence, and the
  measurement reversed the review's own recommendation.** A review of the
  siblings suggested it was ~64x more expensive than necessary. Two rounds of
  correction followed. First, the stated reason was stale: an empty reply is
  `inconclusive`, not `dead`, and both leave the model in the picker. Second, the
  first A/B measured wall clock when the claimed benefit is tokens, and
  `usage.output` — already computed by pi-ai and dropped by `probeOnce` — is now
  carried through. Re-measured over 33 models in two agreeing runs:

  | model | 1024 | 16 | verdict |
  |---|---|---|---|
  | muse-spark-1.2 | 158 / 236 tokens | none | ok → **inconclusive** |
  | muse-spark-1.3 | 69 / 160 tokens | none | ok → **inconclusive** |

  The token median does fall (48 → 16) — but precisely *because* the two most
  expensive models stop answering and drop out of the sample. A smaller ceiling
  does not make expensive models cheap; it makes the priciest ones go silent.
  `probe-ab.mjs` now checks answer quality before it checks tokens, and fails.
  The original reasoning was right and its remembered consequence was wrong: an
  empty reply is not a death sentence, but it is not a clean success either, and
  on this provider it lands on the models that cost the most.
- **Probing stays sequential, but the reason is not "it is fast".** The same
  review showed the ~0.5 s figure is a zero-hang sample, which is the worst
  sample to extrapolate a tail from. A hanging model costs the full 15 s
  *every day, permanently* — `settled()` only covers `dead` verdicts, so a
  timeout lands as `inconclusive`, is never persisted, and is re-asked
  tomorrow, having learned nothing while the model stays in the picker. Still
  not worth concurrency: the daily round is fire-and-forget, and the only
  user-perceived cost is the "Probe now" button, which is better addressed by
  making the POST non-blocking than by changing the scheduler.
- `docs/adr/0002-catalogue-source-of-truth.md` records both reversals with the
  evidence, and rewrites its "not doing" list as contracts that state what
  evidence would overturn each entry.

### Not fixed, deliberately

- `LICENSE` credits `dsh-claude-subscription contributors` while the package is
  named `dsh-opencode-free`. Changing a copyright attribution is not this
  change's decision; it is the repository owner's.
- `createCatalog` is still 202 lines. Lowering it further means restructuring the
  interface implementation, whose payoff does not justify the blast radius.

[0.3.0]: https://github.com/x5427876/dsh-opencode-free/releases/tag/v0.3.0