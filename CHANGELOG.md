# Changelog

All notable user-visible changes to `dsh-opencode-free` are recorded here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and
this project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

The probe round now measures what it offers, and the panel says what a round
cost. Behaviour below is what a user can observe change.

### Added

- **The panel row reports the limits the request actually uses, and says which
  of them were measured.** A row now shows the context window and the maximum
  output pi-ai clamps with, plus vision, thinking and tool-call badges — and a
  tick on anything that was verified on the route rather than copied from
  models.dev, with a replaced declaration struck through beside the number that
  replaced it. The card used to carry two booleans and a level, so a declared
  200,000 and a measured 1,048,576 were the same object on screen, and the panel
  could not disagree with the wire even in principle.
- **A round now measures the two capabilities it used to assume.** Given an
  image and asked to name its top half, a model answers or it does not; given
  real tool schemas — not the admission gate's "do not call" stubs — and asked
  to run one command, it emits a tool call or it does not. Each axis is asked
  once per model and the verdict is persisted, so a model you keep using costs
  nothing afterwards. A round that learns nothing writes nothing: the badge stays
  unmarked, because "we could not find out" and "it cannot" are different facts.
- **A round's cost is reported.** The report names how many requests it sent
  (a round may take several samples of one model, so the model count is not the
  bill) and how many models still owe samples.
- **A click that is refused says so.** Two clicks inside five minutes: the
  second is refused with the time remaining instead of starting a round.
- **A row that learned nothing names the condition inline** — `not measured ·
  quota spent`, `not measured · upstream overloaded`, `not measured ·
  endpoint unreachable` — rather than three identical words with the reason in a
  hover.

### Changed

- **`off` is measured, not assumed.** The round asks the model for no
  reasoning and for its own lowest level and compares the reasoning tokens
  against that model's own baseline. `off` is offered only when there is a
  real reduction: the exact `none` where the model reaches zero, otherwise the
  lowest level that measurably helps. A model that reduces nothing gets no `off`
  row at all, which withdraws the row rather than leaving a control that does
  nothing.
- **Probe now finishes a measurement.** A manual round keeps asking each model
  you have switched on until the axis has an answer (up to nine requests), so
  one click can complete it. The daily round still spends one request per
  model — but now covers every model Zen lists, including the ones you
  switched off, because a hidden model's status is what nobody would otherwise
  find out.
- **An unreachable endpoint and an overloaded upstream are named** instead of
  being reported as a model failure, and neither spends a second request on
  the other channel.
- **A model the upstream retires in words is removed.** `Model <id> has been
  deprecated` is treated as a positive answer, and a channel that answers
  nothing can no longer overrule a channel that named the model. Before this, a
  model Zen had explicitly retired sat in the picker as a red failure.

### Fixed

- **The probe read no reasoning counts at all**, so no capability row could
  ever be earned and repeated rounds changed nothing.
- **A model whose reasoning the route never reports is asked once and then
  left alone**, instead of being asked again at the full budget every round,
  forever.
- **A withdrawal visible in Zen's own list no longer lingers.** A model that
  answers `Model is unavailable.` on the channel it actually serves is removed.
- **A restored cache report can no longer overwrite a round that is running**,
  which made the panel sit still while the round you started ran on invisibly.
- **Measured context windows are used.** Where the endpoint has stated its own
  limit, that value is offered instead of models.dev's declaration, and a
  changed declaration discards it. A stated verdict keeps the samples behind
  it, so any verdict can be recomputed.
- **A reply could not outlast 180 seconds.** That timeout reached pi-ai as the
  SDK's whole-request deadline, and it was the wall before any max-output number
  mattered: measured 2026-10-07, asking Mimo V2.6 Flash for 34,000 or 40,000
  output tokens died at 181s with HTTP 200 and no usage frame, while the same
  request with a longer timeout produced all 40,000 at about 152 tokens/second.
  At that rate 180s bought roughly 27,000 tokens — less than the plugin used to
  advertise. The host profile's copy was the one that won, so both are now 600s,
  matching the profile's own stream idle timeout. Short replies are unaffected.
- **Measured maximum output is used.** `limit.output` was never checked, and it
  is the number every reply is cut at: a model whose route accepts far more was
  silently stopping at the declaration, with `finish_reason: "length"` and
  nothing in the panel to say so. Measured 2026-10-07 — Mimo V2.6 Flash was being
  held to 32,000 while accepting 1,040,384, Muse Spark and Fledge Alpha to
  131,072 while accepting 1,040,384, Nemotron 3.5 Lightning to 262,144 while
  accepting 991,808, Nemotron 3 Ultra to 128,000 while accepting 991,808,
  Longcat to 131,072 while accepting 262,144, Big Pickle to 32,000 while
  accepting 128,000. Space Bunny Free measured correct at 524,288
  and is used as declared. A changed declaration discards the measurement, and a
  ceiling is never advertised above the context window it has to fit inside.

## [0.3.1] - 2026-10-03

Supports DeepSeek Harness `0.2.1-alpha.1`.

### Changed

- **Targets DeepSeek Harness `0.2.1-alpha.1`.** The peer pins move to
  `@deepseek-ai/dsh-llm` and `@deepseek-ai/dsh-llm-pi-ai` `0.2.1-alpha.1` and
  `@deepseek-ai/schemastery` `~3.18.5-alpha.1` (the old `^3.18.3` range excludes
  that prerelease). The pin stays exact, so `0.2.0-rc.2` is no longer supported
  by this release; stay on `0.3.0` for it. DSH `0.2.1-alpha.1` keeps `pi-ai`
  `^0.87.1` and leaves `dsh-llm-pi-ai` unchanged; `dsh-llm` only drops its
  internal `INVARIANT` error code, so the plugin's behaviour is unchanged.

## [0.3.0] - 2026-10-02

The catalogue now follows models.dev, the availability check can be watched as it
runs, and a panel on the plugin's details page controls which models you see.

### Added

- **The model list follows [models.dev](https://models.dev).** Zen's own `/models`
  endpoint says which models exist; models.dev says which are free, what they are
  called, how large their context is, whether they take images, and which thinking
  levels each offers. A newly published free model appears without a plugin
  update, and a withdrawn one leaves on its own. Refreshed with one conditional
  request, so staying current costs no inference quota. Without a usable answer the
  plugin keeps serving its last known list, and then an offline floor — a failed or
  unreachable refresh changes nothing you can see.
- **An availability check you can watch run.** "Probe now" asks each model and
  reports as it goes: a progress pill counts down, the model being asked says so,
  the ones not reached yet are queued, and each row ends with its own outcome and
  how long it took. A round only spends a request on the models you have switched
  **on**, because a probe draws from a bucket shared by everything behind your
  egress IP.
- **A model visibility panel on the plugin's details page.** Every free model gets
  a switch; switched off, it leaves the picker and comes back when switched on. An
  id the catalogue no longer knows about is kept in the setting, so hiding a model
  and upgrading the plugin does not lose your choice.
- **Capability badges on every row** — vision support, context length, maximum
  output, and the strongest thinking level the model offers — taken from what
  models.dev publishes for that model rather than assumed.

### Changed

- **A model is removed only on a positive signal.** A text reply is `ok`; only a
  positive "this model is gone" is `dead`; anything else is `inconclusive` and the
  model stays. `dead` is reached only after every channel the provider implements
  has refused, and a channel that never answered — a dropped socket, a timeout —
  vetoes it rather than losing an argument. **A temporary network failure can no
  longer remove a model permanently.** The cost is deliberate: a model on a channel
  that times out keeps its place in the picker as a grey row.
- **A model is routed by the channel that actually worked.** The check asks each
  channel in turn, and a channel that answered is remembered — in the catalogue and
  across restarts — rather than re-inferred from a record that may describe the
  wrong one.
- **Probing stays sequential, and the button is not a repeat-click machine.** A
  manual round is floored at five minutes, because one round is up to 34 real
  requests against a shared bucket.
- **The round's report is persisted with its verdicts** and restored on restart, so
  the progress area shows the last outcome instead of appearing to have vanished.

### Fixed

- **A network blip is no longer read as "the anonymous tier refused us".** A socket
  error was caught by the identity guard's own fallback and the request re-sent
  without its credentials, which is exactly the diagnosis a dropped connection
  should not produce. Connection failures now name their cause — proxy, VPN,
  firewall or DNS — and never cost a second request.
- **A refusal names which upstream condition answered.** `FreeTierError` (free-tier
  admission refused), `MissingSessionID`, and "only the OpenCode client may send
  this" are told apart, because the reader's next move differs for each.
- **The availability check is admitted.** Its own request could lose the `read` and
  `bash` tool names the tier requires, and the upstream answered `403` to a request
  it would otherwise have served. The check re-asserts them on the final payload.
- **Images attached to a message reach the model.** They were resolved to nothing
  unconditionally, so every image was dropped before the request.
- **The visibility panel appears under the host's live config shape**, and a hidden
  model leaves the actual picker rather than only the plugin's own list.

### Known limitations

- **A model that Zen stops listing cannot be re-checked.** One judged gone and then
  dropped from Zen's own catalogue is neither visible nor eligible for a round, so
  the only way it returns is for Zen to list it again. Fixing this would mean
  re-probing models the catalogue no longer offers, at inference cost.
- **The anonymous tier is shared per egress IP and gated upstream without notice.**
  It can refuse at any time; an optional API key raises the limit.
- **The check spends quota.** One round asks every visible model once. The daily
  round runs at most once per local day; the button is floored at five minutes.

### Design rationale

`docs/adr/0002-catalogue-source-of-truth.md` records the final decisions and the
evidence behind them, including two questions where measurement overruled the
original recommendation.