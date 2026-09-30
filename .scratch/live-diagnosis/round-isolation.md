# Round 2 — separating request / process environment / moment

Budget: **12 of 12** Zen requests spent (sequential, no retries, ≤15s each).
Nothing under `src/`, `lib/`, `tests/`, `docs/`, `scripts/` was modified. The
user's real `catalog.json` was never written — the isolated rounds ran against a
copy in `./tmp-cache/`.

## Step 0 (0 requests) — the request is ruled out

`capture.mjs` stubs `globalThis.fetch` and captures the outgoing request of three
paths for the **same model id** (`longcat-2.5-preview-free`):

- **B** — `probe.mjs` single-shot, standalone
- **A** — the real round: `createCatalog` → `forceProbes` → `probeModel` →
  `probeOnce` → `provider.streamSimple`
- **A+guard** — the same round with the three guards `apply()` installs
  (`patchCompatDirectTransport` / `patchGlobalFetchForZen` / `patchNodeHttpForZen`),
  i.e. what the 03:31 and 03:54 rounds really sent

Result: **A ≡ B ≡ A+guard**, byte for byte.

- URL: `POST https://opencode.ai/zen/v1/chat/completions` in all three
- 17 headers, identical names in all three; every value equal except the three id
  headers, whose values are random per request *by design*
- `user-agent` identical; `authorization` identical (`Bearer`, same length, value
  never printed); `x-stainless-retry-count: 0`; `x-stainless-timeout: 180`
- bodies deep-equal: `model`, `stream:true`, `max_tokens:1024`,
  `tools: read,bash`, `reasoning_effort`, key set
  `{max_tokens, messages, model, reasoning_effort, stream, stream_options, tools}`
- id shape valid in all three (`^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$`,
  `^msg_…$`), and `x-client-request-id === x-opencode-session` in all three

One harness bug found and fixed on the way: the first isolated round probed the
**7-model pi-ai builtin floor** instead of the 39-model models.dev catalogue,
because the warm cache read is fire-and-forget (`catalog.ts:678`) and lands after
`createCatalog` returns. `ensureFresh()` awaits it (`catalog.ts:667`); with that,
the round targets 34 models. The host never had this problem (its round runs long
after startup), so it did not affect the conclusion.

## Step 1 (12 requests) — the isolation results

Every run below is an isolated process, the real round code path, the real guards,
the real network, the D3 probe shape proven identical in Step 0.

### 1a. Single-model round — target list constrained to one id

Constraining Zen's served list is how the round picks targets
(`live = models ∩ servedSet`, `catalog.ts:818`), so the other 33 models became
`not-listed` rows at zero request cost. **1 request.**

| model | status | ms | code | http |
|---|---|---|---|---|
| **longcat-2.5-preview-free** | **ok** | 3548 | — | — |

`longcat` is refused by both host rounds. Through the real round path, alone, it
answers. → **the refusal is not a property of that model, and not of that request.**

### 1b. Full isolated round — the host's exact 10 targets, in the round's order

**11 requests** (10 models + 1: `ling-3.0-flash-fin-free` got a 400 on its first
channel, which is not caller-scoped, so `probeModel` asked the other channel too).

| model | status | ms | code | http |
|---|---|---|---|---|
| ling-3.0-flash-fin-free | failed | 1385 | unknown | **400** |
| muse-spark-1.2-contributor-free | ok | 1577 | — | — |
| longcat-2.5-preview-free | ok | 2572 | — | — |
| space-bunny-free | ok | 1514 | — | — |
| mimo-v2.6-flash-free | ok | 4992 | — | — |
| nemotron-3-ultra-free | ok | 6229 | — | — |
| mimo-v2.5-free | ok | 5931 | — | — |
| nemotron-3.5-lightning-free | ok | 2694 | — | — |
| big-pickle | ok | 1189 | — | — |
| muse-spark-1.3-contributor-free | ok | 3887 | — | — |

**9 ok / 1 failed**, wall 31975ms. The host round over the same 10 ids, in the
same order, with the same bytes: **1 ok / 9 × 403**.

Two side observations that constrain the explanation:

- The isolated round took **32s for 10 models** (1.2–6.2s each). The host round
  finished in about 4s, refusing each model in **332–393ms**. A 403 gate is fast;
  real inference is not. The host never actually ran those 9 models.
- `ling-3.0-flash-fin-free` is the one model that did not answer in isolation, and
  it failed differently: **HTTP 400, `code: unknown`** → `inconclusive`, not
  `dead`. It is also refused in both host rounds (403). Ling may be a genuinely
  separate case; I do not have enough evidence to call it.

### Request ledger (12/12)

| # | experiment | model(s) | shape | status | latency | error class |
|---|---|---|---|---|---|---|
| 1 | 1a single-model round | longcat-2.5-preview-free | D3 | 200 | 3548ms | none — answered |
| 2–11 | 1b full isolated round | 9 of the 10 targets | D3 | 200 | 1189–6229ms | none — answered |
| 12 | 1b full isolated round | ling-3.0-flash-fin-free (2 channels) | D3 | 400 | 1385ms | `unknown` (unmapped upstream 4xx) → inconclusive |

Accounting note: request #1 was sent but **not counted** by my guard — the guards
capture `globalThis.fetch` as their `original` at patch time, so a counting wrapper
installed afterwards is bypassed. It is recorded here and in
`round2-ledger.json` as used. Fixed before 1b.

## Verdict on the three variables

1. **Request different? — NO.** Step 0: byte-identical, including with the host's
   own guards installed.
2. **Sequence / burst different? — NO.** 1b is the same target set in the same
   order through the same round code, back to back, and 9 of 10 answered.
3. **Moment different? — UNLIKELY, and no longer needed to explain anything.**
   The lead's objection was that the failures coincided with my testing window.
   But the 03:31:17 round failed *before* my first request (03:39:37), the 03:54:28
   round failed *after* my last one (03:41:25), and my isolated round at ~04:05
   passed. Moment does not separate the data.

**The difference is in the host process.** Something about the DSH host process,
not about the request, not about the sequence, not about the clock.

## The one host/isolation difference I can identify (hypothesis, NOT proven)

`apply()` builds the provider as `zenProvider(() => undefined, getConfigKey, …)`
([src/index.ts:347](src/index.ts#L347)) — the session-id getter is hard-coded to
`undefined`, so `compatRequestOptions` falls back to `fallbackSession`, a **single
`randomUUID()` created once per DSH process** ([src/zen-provider.ts:1422](src/zen-provider.ts#L1422),
[src/zen-provider.ts:915](src/zen-provider.ts#L915)).

Consequence: **every request in a DSH process — the user's live conversation and
all 10 probes — carries the same `x-opencode-session` value**, and that value never
changes until DSH restarts. In every isolated process I ran, the id was fresh and
had never been used by any model before the round.

That fits every observation, and fits the two failures being identical despite the
restart:

- the DSH host process (PID 8000) started **03:54:11**, and the failing round ran
  at **03:54:28** — 17 seconds later;
- in **both** host rounds the only model that passed is `space-bunny-free`, the
  model the user is actually chatting on;
- `x-opencode-session` is documented as Zen's **sticky-backend routing** key
  ([src/zen-provider.ts:146](src/zen-provider.ts#L146)); a session already bound to
  one model is the obvious thing for a free tier to refuse to re-point at another;
- it is deterministic and restart-surviving, which is why 03:31 and 03:54 are
  byte-identical in outcome while every fresh process passes.

**This is inference, not a measurement.** I have not seen the host's session id, I
have not seen Zen's response body, and I have not run the controlled test. What
rules *out* the alternatives is measured; this particular explanation is not yet.

Ruled out along the way, at zero request cost:

- **A Zen key in the host.** No `OPENCODE_API_KEY` in this shell and no Zen entry
  in `~/.dsh/.credentials.yaml` (only web-tool keys). And a keyed request would
  not be answered with the anonymous markers `classifyZenFailure` requires for
  `anon-gated` (`FreeTierError|MissingSessionID|only be used .*OpenCode`).
- **The node runtime differing.** The host is `node …/dsh/lib/bin.js web --no-open`
  launched through the same PATH shim this shell uses (v26.8.1), so
  `x-stainless-runtime*` is very likely identical — not proven, since I never
  observed the host's headers.

## The test that would settle it — 2 requests, needs your authorization

I am at the 12-request cap, so I stopped. The experiment is ready in
`.scratch/live-diagnosis/session-binding.mjs` (written but never run): in ONE
process, pin the session id with a fixed `getSessionId` so `sessionHeader()` is
deterministic, then

1. probe **`space-bunny-free`** with fixed id S — expect 200, binding S;
2. probe **`longcat-2.5-preview-free`** with the **same** S.

If step 2 returns 403 `FreeTierError`, the hypothesis is proven: the tier refuses a
second model on an already-bound session id, and the host round fails for that
reason. The control is already in hand — `longcat` on a fresh id has answered 200
three times (03:39, the single-model round, and the full round). A null result
(fresh-bound id also passes) kills the hypothesis just as cleanly.

Cost: 2 requests. I did not run it, per the hard cap.

---

# Addendum — session-binding test (2 approved requests): HYPOTHESIS REFUTED

`session-binding.mjs`, sequential, ≤15s each, no retries, stopped at the cap.

**S (pinned, both steps):** `ses_28a8e22c0a8caG1UQ9qnfX9yHC`
Derived by the plugin's own `sessionHeader()` from a constant `getSessionId`, not
hand-assembled. Form is identical to a `fallbackSession` id — `ses_` + 12 hex + 14
base62, matching `^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$`, and
`x-client-request-id === x-opencode-session` in both steps. The only difference
from the host is that S was *chosen* rather than random, which is what makes the
two steps comparable.

| step | model | session | x-client-request-id | x-opencode-request | status | latency | error class |
|---|---|---|---|---|---|---|---|
| 1 | space-bunny-free | `ses_28a8e22c…` | `ses_28a8e22c…` | `msg_b9b0a9a4…` | **200** | 1750ms | none (2xx) |
| 2 | longcat-2.5-preview-free | `ses_28a8e22c…` | `ses_28a8e22c…` | `msg_14e2c2c2…` | **200** | 1858ms | none (2xx) |

Both answered. Body on both: `tools: read+bash`, `stream: true`, `max_tokens: 1024`
— the shape proven identical in Step 0.

**Step 2 was NOT a 403, so there is no sanitized error body to report and none
exists.** The `ANON_GATED_PATTERN` question — whether the host's 9 refusals are
`FreeTierError`, `MissingSessionID`, or `only be used … OpenCode` — is **still
unknown**. This experiment did not reproduce a 403 at all, so it produced no
evidence about it either way. I could only have learned that from a reproduced
refusal, which I did not and cannot stage without spending further requests.

**Verdict: the session-binding hypothesis is refuted.** A session id already used
by `space-bunny-free` served `longcat-2.5-preview-free` without complaint. Combined
with the control (longcat on a fresh id answered 200 three times), the id's prior
binding is not the cause. The prediction that failed: that the host's 9 refusals
come from re-pointing one already-bound id at other models.

**Scope of the refutation, stated precisely.** The test was *sequential*: step 1
completed before step 2 started, so the id was bound by a **finished** request.
The host's state is different in one respect that this test did not reproduce —
its id is bound and **concurrently in use**, because the user's live conversation
is streaming on `space-bunny-free` while the round fires its 10 requests. So the
static-binding form is refuted; a concurrent-use form is **untested**, not refuted.

## Process lifecycle: the two failing rounds are in DIFFERENT processes

| round | JST | process |
|---|---|---|
| 1st failure | 03:31:17 | a DSH process that no longer exists |
| 2nd failure | 03:54:28 | PID 8000, created **03:54:11** — 17s into its life |

The only running `dsh web` process is PID 8000, created 03:54:11
(`node …\@deepseek-ai\dsh\lib\bin.js web --no-open`). The 03:31:17 round predates
its creation by 23 minutes, so it belonged to a **previous** DSH process — the one
the user restarted.

So the two identical failures (1 ok + 9 × `anon-gated` 403, same 10 ids, same
latency band) came from **two independent process lifetimes**. That is the
stronger form of the anomaly: it is not one process degrading over time, and not a
process-age effect. Whatever the two processes share is the *work they were doing*
— a live conversation on the same provider, on the same egress, over the same
catalogue — not the state of a single long-lived process.

## Remaining candidates, after every measurement

Ruled out by measurement:

1. **The request** — byte-identical across all three paths, guards included.
2. **The sequence / burst** — the isolated 10-model round passed 9/10 back to back.
3. **The moment** — the two failures straddle my whole testing window.
4. **Static session-id binding** — refuted above.
5. **A different egress path / proxy** — zero cost: no `HTTP(S)_PROXY`/`ALL_PROXY`
   in the environment, WinHTTP reports direct access with no proxy, and no proxy
   reference in `settings.yaml`, `cordis.yml`, or the web profile. Host and shell
   share one direct egress.
6. **A Zen key in the host** — no `OPENCODE_API_KEY` in the environment and no Zen
   entry in `~/.dsh/.credentials.yaml`; and a keyed request would not come back
   carrying the anonymous markers `classifyZenFailure` requires for `anon-gated`.

Not ruled out, and I am out of authorized budget:

7. **Concurrency** — the host round's 10 requests overlap the user's live stream
   on the same session id and the same egress; every isolated run I did had zero
   concurrent traffic. This is the one difference that remains consistent with all
   the data, and the only experiment that would separate it is a 2-request one
   that deliberately overlaps two in-flight requests on one pinned id. Not run —
   it was not authorized, and I am not adding requests on my own.

Also unresolved, and not something I can answer without reproducing a refusal:
which of the three `ANON_GATED_PATTERN` branches the host's 9 × 403 actually are.
The plugin deliberately folds them into one class, and nothing retained anywhere
(the panel keeps class + status only; an `inconclusive` is never persisted) holds
the bodies.

No fix proposed, per instruction — measurements only.
