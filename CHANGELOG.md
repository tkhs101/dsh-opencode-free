# Changelog

All notable user-visible changes to `dsh-opencode-free` are recorded here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and
this project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

> **Note on 0.2.1 — two different builds, one version number.** The npm
> registry lists a `0.2.1` published 2026-09-22. That artifact is **not** the
> `0.2.1` in this repository's history: the commit that sets
> `package.json` to `0.2.1` here is `02ef277` (2026-09-29), merged from upstream
> and only reachable from this repository after that merge. They are different
> builds sharing a number — the published one is smaller and carries none of
> the catalogue work described below (no `lib/catalog.js` at all), because that
> work postdates it. The consequence for anyone reading the registry: **the
> version number alone does not identify the build.** This changelog records
> what is visible in this repository's history; the contents of the published
> `0.2.1` are not here, so they are not described. It is a predecessor of this
> release, not something this release replaces or rolls back.

## [0.3.0] - 2026-09-30

Compared with `0.2.0` (`6717d60`), the last version published from this
repository's history. Every entry below is traceable to a commit in this
repository; the supporting commit and code reference for each one is in
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

### Fixed

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

### Known limitation in this release

- **A model that Zen stops listing cannot be re-checked.** A model judged gone in
  an early round and then dropped from Zen's own catalogue is neither visible nor
  eligible for the round, so the only way it returns is for Zen to list it again.
  The fix would have to re-probe models the catalogue no longer offers, at
  inference cost. Recorded here rather than fixed, because it is a pre-existing
  boundary and not a regression. (Found while preparing this release.)

[0.3.0]: https://github.com/tkhs101/dsh-opencode-free/releases/tag/v0.3.0
