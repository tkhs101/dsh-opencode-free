# Live diagnosis: why 9 of 11 models were 未測到 at 2026-09-30 03:31:17 JST

Budget: **4 of 6** Zen requests spent (requests 1–4). No retries, sequential, ≤15s each.
No code, doc, or config file was modified. Secrets never printed (bodies reduced to
status + `error.type` + a marker boolean set).

## 0. Zero-cost evidence recovered first (no Zen budget)

The panel's own in-memory round record was still live and is readable with a
read-only local GET (`src/index.ts:264`, `GET /dsh-opencode-free/api/probe` →
`catalog.probeProgress()`), saved to `probe-progress-0331.json`. It is the round
that started at **2026-09-30 03:31:17 JST**, 11 rows, `running:false done:11`:

| model | status | ms | code | http |
|---|---|---|---|---|
| ling-3.0-flash-fin-free | failed | 544 | anon-gated | 403 |
| muse-spark-1.2-contributor-free | failed | 347 | anon-gated | 403 |
| longcat-2.5-preview-free | failed | 347 | anon-gated | 403 |
| **space-bunny-free** | **ok** | **1196** | — | — |
| mimo-v2.6-flash-free | failed | 348 | anon-gated | 403 |
| nemotron-3-ultra-free | failed | 378 | anon-gated | 403 |
| mimo-v2.5-free | failed | 393 | anon-gated | 403 |
| deepseek-v4-flash-free | failed | 682 | **dead** | **400** |
| nemotron-3.5-lightning-free | failed | 347 | anon-gated | 403 |
| big-pickle | failed | 354 | anon-gated | 403 |
| muse-spark-1.3-contributor-free | failed | 332 | anon-gated | 403 |

Two things this settles without spending a request:

1. **There was no network failure.** Every row carries an HTTP status; not one row
   has `http:0`. The 03:31 round never lost the socket — the refusals were
   application-level answers from upstream.
2. **`anon-gated` is not "any 403".** `classifyZenFailure` only returns it when the
   body matches `ANON_GATED_PATTERN` (`FreeTierError|MissingSessionID|only be used
   .*OpenCode`, `src/zen-provider.ts:411`). So those 9 bodies carried a real gate
   marker, and `deepseek-v4-flash-free` (HTTP 400, `dead`) is the only genuinely
   model-level fact in the round.

Why the failures left no other trace: an `inconclusive` outcome is deliberately
**not persisted** (`src/catalog.ts:876`, D5), and the cache only ever holds
`ok`/`dead` verdicts. So `catalog.json` records exactly two facts from that round —
`space-bunny-free: ok` and `deepseek-v4-flash-free: dead` — and the other 9 rows
exist only in the panel memory above. No DSH session transcript or plugin log
contains them (searched all 17 `session.v4.jsonl.zstd` under `~/.dsh/sessions`:
zero hits for `FreeTierError`/`anon-gated`/probe markers).

## 1. Pre-flight (0 requests): the wire shape was verified before spending #1

`dryrun.mjs` stubs `globalThis.fetch` and captures the real outgoing request, so
the first live request is guaranteed to carry the plugin's identity rather than
mine. Captured for `space-bunny-free`:

- `POST https://opencode.ai/zen/v1/chat/completions`
- header names: `authorization, user-agent, x-client-request-id, x-opencode-client,
  x-opencode-project, x-opencode-request, x-opencode-session` (+ pi-ai `x-stainless-*`)
- `x-opencode-session` matches `^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$`; `x-opencode-request`
  matches `^msg_…$`; `x-client-request-id === x-opencode-session`
- UA `opencode/1.18.31 ai-sdk/provider-utils/4.0.40 runtime/bun/1.3.14 dsh-opencode-free/0.2.0`
- body 513 bytes: `stream:true`, `max_tokens:1024`, **`tools: read,bash`**, 1 user
  message `hi`, `model: space-bunny-free`

`tools: read,bash` is the decisive part: the §8 anonymous gate is satisfied by the
same code path in the live experiment as in the 03:31 round, so a difference in
request shape is excluded by construction.

## 2. Request ledger (the 4 spent)

Harness: `.scratch/live-diagnosis/probe.mjs` — reuses the built `lib/zen-provider.js`
(built 03:28, the same artifact the round used), rebuilds each model record through
`catalog.derive()` from the warm `catalog.json` models.dev record (same template +
`knownApis` table as plugin startup), and calls `zenProvider().streamSimple` with
`probeOnce`'s exact options: prompt `hi`, `maxTokens 1024`, `maxRetries 0`,
`reasoning:"low"`, `AbortSignal.timeout(15000)`, `apiKey:"public"`. A counting
fetch refuses request #7, so the 6-cap is enforced in code, not by discipline.

| # | model id | channel | shape variant | status | latency | sanitized error class |
|---|---|---|---|---|---|---|
| 1 | space-bunny-free | openai-completions | d3 (exact) | **200** | 2029ms | none — answered, `stopReason:stop` |
| 2 | longcat-2.5-preview-free | openai-completions | d3 (exact) | **200** | 4472ms | none — answered, `stopReason:stop` |
| 3 | big-pickle | openai-completions | d3 (exact) | **200** | 3597ms | none — answered, `stopReason:stop` |
| 4 | muse-spark-1.3-contributor-free | openai-responses | d3 (exact) | **200** | 3719ms | not a gate refusal: `stopReason:error`, unmapped 10-char upstream message, no 403 |

Requests 2 and 3 are the decisive ones: both are rows the round itself recorded as
`anon-gated` HTTP 403, and both now return 200 with a byte-identical request shape
and the same build of the plugin.

## 3. Verdicts

**1. Is the anonymous tier reachable right now? — YES.**
Decided by request #1 (200/2029ms, answered) and confirmed by #2–#4: 4 of 4 live
requests to `opencode.ai` returned HTTP 200, 3 of them fully answered, zero
transport failures, zero 403s, zero 429s.

**2. Tier-level or model-level? — The 03:31 rejections were NOT model-level.**
The single deciding piece of evidence: request #2. `longcat-2.5-preview-free` is
recorded in the panel's own round as `anon-gated` HTTP 403 at 03:31:17.861, and it
returned **200 with an answer at 03:39:54** on the identical shape. A model's
availability is a property of the model; a property that flips for the *same* id,
the *same* code, the *same* shape, eight minutes apart, is a property of the tier's
state. Corroborated twice: `big-pickle` (403 at 03:31 → 200) and
`muse-spark-1.3-contributor-free` (403 at 03:31 → **200, no longer refused**; it
ends in a stream-level error on the other channel, which is a separate matter from
admission).

The 03:31 pattern itself also argues against a per-model reading: nine different
vendors' models (Ling, Muse Spark, LongCat, Mimo, Nemotron, Big Pickle) refused
with an identical 403 inside a 332–393ms band — eleven seconds before the one
success took 1196ms. Nine independent simultaneous model deaths do not cluster that
way; one upstream condition does.

**3. Shape-sensitive? — NO.**
Requests #1 and #2 used the identical shape, and the 03:31 round used the identical
shape and got 403 for 9 of the same 11 ids. The gate therefore keys on *when* a
request arrives, not on tools / maxTokens / streaming. The pre-flight proves the
tools axis is already correct on the live path (`tools: read,bash` always injected
by `applyAnonymousToolGate` for `Bearer public`), and the 03:31 403s came from that
same code — so a "too heavy / wrong shape" explanation is excluded, and no probe
shape change would have saved that round.

**Root cause (one sentence):** at 03:31:17 the upstream anonymous tier was in a
degraded, selectively-refusing state — it answered 9 of 11 probed models with a
uniform gate 403 within ~350ms while still serving `space-bunny-free` — and that
state lifted within about eight minutes, so the round measured the tier's
momentary condition rather than any model's condition.

## 4. Is the panel's wording true?

The panel says: 「这是当时的网络状况，不是该模型的结论」 ("that was the network
conditions at the time, not a conclusion about the model").

- **The conclusion it draws is TRUE.** Decided by request #2: a model the panel
  itself labelled 未測到/匿名層級被拒 answers 200 right now on a byte-identical
  request. The round's reds were not verdicts about those models. The plugin's own
  design is vindicated: `inconclusive` is never persisted and never removes a model
  from the picker (`src/catalog.ts:876`), so the 9 rows cost nothing but a red badge.
- **The mechanism it names is FALSE.** There was no network condition. All 11 rows
  carry an HTTP status, none is `http:0`, and my 4 live requests all reached
  upstream. "网络状况" points the reader at their proxy/VPN/DNS
  (`ZEN_TRANSPORT_GUIDANCE`, `src/zen-provider.ts:421`), which would send them
  debugging a path that was never broken. The honest wording is 「上游匿名層當時的
  准入狀態」 — an upstream admission/gate state, not a local network fault. The
  per-row code was already correct (`anon-gated` + 403); only the round-level
  sentence is misleading.

## 5. What remains unknown (not guessed)

1. **7 of the 9 refused models are untested now** — verifying the full recovery
   would cost 7 more requests, over budget. I verified 2/2 that I tested (plus the
   previously-ok model); the other 7 are untested, not failing.
2. **Whether the 403 cluster was an upstream outage or per-model free-quota
   exhaustion.** Both produce a gate 403 within a 332–393ms band, and the 03:31
   response bodies are not retained anywhere (the cache persists only `ok`/`dead`;
   `probeRun` keeps only class + status). I cannot separate them.
3. **Why `space-bunny-free` was exempt** at 03:31 while every sibling was refused
   in the same process and the same round. No evidence either way — possibly an
   upstream allow-list, possibly a distinct route. Unknown.
4. **Request #4's `200 + stopReason:error`** on `openai-responses` is an upstream
   stream-level failure after admission, not a gate refusal. Not investigated; it
   does not bear on any verdict above.
5. Minor spec drift worth flagging: the brief specified `maxTokens 512` "per spec
   D3", but `PROBE_MAX_TOKENS` is **1024** (`src/zen-provider.ts:470`); 512 is
   `scripts/test-live.mjs`. My experiment used 1024, matching the real probe path.

## 6. Files (all under `.scratch/live-diagnosis/`, nothing else touched)

- `probe.mjs` — the live harness, with a code-enforced 6-request cap
- `dryrun.mjs` — zero-network pre-flight that prints the wire shape
- `ledger.json` — the request ledger (machine-written by the cap guard)
- `probe-progress-0331.json` — the panel's raw 03:31 round record, unmodified
- `findings.md` — this file
