# Release 0.3.0 — change audit

Baseline: `6717d60` ("Support DeepSeek Harness 0.2.0-rc.1 (release 0.2.0)").
The only commit that ever set `"version": "0.2.0"` in `package.json`
(`git log -S'"version": "0.2.0"' -- package.json`). Range audited: `6717d60..74cdf6a`
(33 commits). `f63cf34` is one commit into that range, not the baseline.

`0.2.1` exists on npm but not in this history (no tag, no matching
`package.json` commit). Its tarball is a smaller build with no `lib/catalog.js`,
so it is a predecessor of this release, not something it replaces. No entries
invented for it.

`tests/catalog.test.mjs`, `tests/client-render.test.mjs`, `tests/model-visibility.test.mjs`
are new files in this range; `tests/compatibility.test.mjs` pre-existed with 11
titles, all 11 still present, 14 added. **A pinned test = a contract.**

---

## Proof table

| # | Entry | Commit(s) | Proof |
|---|---|---|---|
| A1 | Visibility panel, per-model switch | `73eed0b` `1be8b49` | `src/index.ts:98` `src/index.ts:333`; `tests/model-visibility.test.mjs:186,195,203,211,221` |
| A2 | "Probe now" round + live progress | `b7e27d0` `193ba78` | `src/index.ts:82,84,264,291`; `tests/client-render.test.mjs:269,628` |
| A3 | Capability badges (vision/ctx/max-output/top-level) | `a19c14f` `b7e27d0` | `tests/catalog.test.mjs:349,374,385,399,447,459` |
| A4 | Per-model thinking levels from models.dev, incl. `off` | `a19c14f` `24706e7` | `tests/catalog.test.mjs:305,321` |
| A5 | Model list follows models.dev | `56ec564` `b13b18c` | `tests/catalog.test.mjs:447,459,659,673,706,715,828`; `docs/adr/0002-catalogue-source-of-truth.md` |
| A6 | Refusal names the gate condition | `a1cfae4` | `src/zen-provider.ts:411,495`; `src/client.js:106,160,648`; `tests/compatibility.test.mjs:179,379`; `tests/client-render.test.mjs:585`; `tests/catalog.test.mjs:1382` |
| A7 | `DSH_OPENCODE_FREE_DEBUG=1` prints sanitised body | `a1cfae4` | `src/zen-provider.ts:895,1176` — **UNPINNED** |
| C1 | Alphabetical list; ON pinned to top | `bee1d06` `74cdf6a` | `src/catalog.ts:247,268`; `src/client.js:925`; `tests/catalog.test.mjs:1156`; `tests/client-render.test.mjs:693,228` |
| C2 | Round asks only switched-ON models | `bee1d06` | `src/catalog.ts:946`; `tests/catalog.test.mjs:1172` |
| C3 | Gone model leaves the list; Zen-unlisted dropped free | `d9fa16d` `326137e` `7b45426` | `tests/catalog.test.mjs:922,1068,1099` |
| C4 | Connection failure names its cause | `d9fa16d` | `src/zen-provider.ts:460,1440`; `tests/compatibility.test.mjs:807` |
| C5 | Refusal blames upstream, carries stamp + retry | `f9e405c` `20d8b01` | `src/client.js:1184`; `tests/client-render.test.mjs:408,512` |
| C6 | Banner promises only what is enforced | `a1cfae4` | `tests/client-render.test.mjs:559`; `tests/catalog.test.mjs:1296` |
| C7 | Re-confirmed death ≠ removal | `20d8b01` `a1cfae4` | `src/client.js:635,1156,1213`; `tests/client-render.test.mjs:455`; `tests/catalog.test.mjs:1342` |
| C8 | Top thinking level not clamped | `a19c14f` | `tests/catalog.test.mjs:334` |
| C9 | Round asks catalogue before models | `ab43aa0` `1e9189d` | `tests/compatibility.test.mjs:496`; `tests/catalog.test.mjs:1068` |
| C10 | Failed refresh costs nothing | `56ec564` | `tests/catalog.test.mjs:734,753,1125` |
| F1 | **Probe re-asserts admission tools on the wire** | `a1cfae4` | `src/zen-provider.ts:428` (impl), `:861` (wired via `onPayload`); `tests/compatibility.test.mjs:399` |
| F2 | 24 models lost to one wrong verdict | `1b93d0e` `1e9189d` `5694f5b` | `src/catalog.ts:941`; `tests/catalog.test.mjs:1197,1234,943`; `tests/compatibility.test.mjs:570,535,617,593` |
| F3 | Reasoning model = answered | `5694f5b` | `tests/compatibility.test.mjs:435` |
| F4 | "Not measured" drawn as "has a problem" | `f9e405c` | `tests/client-render.test.mjs:408` |
| F5 | Live progress never showed; badges vanished mid-round | `7ac6f0c` | `tests/client-render.test.mjs:628` (progress), `:676-679` (badges stay, asserted inside the same test) |
| F6 | Round report lost on restart | `97dcc07` | `src/catalog.ts:361,469,529,755,1055`; `tests/catalog.test.mjs:1410` |
| F7 | Skipped row shown as queued | `bee1d06` | `src/client.js:925`; `tests/client-render.test.mjs:720` |
| F8 | Probe failure with no reason | `9200075` | `tests/catalog.test.mjs:1020`; `tests/compatibility.test.mjs:757` |
| F9 | Panel invisible under live config shape | `1be8b49` | `tests/model-visibility.test.mjs:231,241` |
| F10 | Image attachments never reached the model | `e4b9124` | `src/index.ts:422` (`resolveAttachments: () => ctx.get("attachments")`) — **UNPINNED** |

Ground-truth items checked against the diff: F1 ✅ (`enforceAnonymousTools` at
`src/zen-provider.ts:428`, wired `:861`; the `read`/`bash` loss is reproduced in
the test by a provider that deletes `context.tools`), C2 ✅, C1 ✅ (with the
correction below), F5 ✅, F6 ✅, A6 ✅, A7 ✅-but-unpinned.

---

## Corrections to the supplied ground truth

1. **"The panel sorts alphabetically" — the panel does not sort.** `src/catalog.ts:247`
   (`byId`) sorts once, at the one place the list is born (`:268`, `:722`);
   `src/client.js:925` *partitions* (ON group, then OFF group) and explicitly
   declines to re-sort. The changelog says the list is alphabetical and the panel
   puts ON on top. Same user-visible result, correct owner.
2. **"9 of 10 models unmeasurable" / `403 FreeTierError` specifics are not
   test-pinned.** They come from `.scratch/live-diagnosis/repair.md` and the
   `a1cfae4` message. The *fix* is pinned (`tests/compatibility.test.mjs:399`);
   the *numbers* are a diagnostic record, not a contract. Kept out of the
   changelog body.
3. **"Badges stay on screen" and "live progress appears" are one commit**
   (`7ac6f0c`), one root cause (the poll timer closed over stale render state),
   two symptoms, and both are pinned by assertions inside the same test.
4. Two ground-truth items (A7 debug body, F10 image attachments) are real code
   with **no test anywhere** — flagged above, and both hedged in the changelog.

---

## A release note must NOT claim

- **Any model count.** The list follows models.dev. `b13b18c` made it 12,
  `bd8bde4` made it 11, and `56ec564` removed the hand-maintained list entirely.
  A count would be false within a week.
- **That `deepseek-v4-flash-free` was removed by this plugin.** Only comments
  remain (`src/zen-provider.ts:508`); models.dev and the probe decide.
- **That the 403 fix is verified against live Zen.** All evidence is offline
  tests plus the diagnostic record. No live round was run as part of this release.
- **That concurrency is ruled out as a cause.** `.scratch/live-diagnosis/round-isolation.md`
  rules out request shape, burst, clock, static session binding, proxy and key —
  and states concurrency is **untested**, not refuted.
- **That a Zen key lifts a refusal.** The code now says the opposite
  (`src/client.js:105` `advice.anongated`): a key raises the quota but is not
  guaranteed to lift the refusal (`src/client.js:102,156` `advice.anongated`).
  Do not repeat the old claim.
- **That the probe is now reliable.** It still reports unmeasured models; that is
  the designed state, not a bug.
- **That every refusal is `FreeTierError`.** Three markers exist
  (`src/zen-provider.ts:411`); the marker is only known when a body arrived, and
  an absent body gets no marker rather than a borrowed one
  (`tests/compatibility.test.mjs:179`).
- **That the report is kept forever.** It is dropped when `total === 0`
  (`src/catalog.ts:529`) and verdicts for models the catalogue dropped are pruned
  (`tests/catalog.test.mjs:1582`).
- **Any latency, throughput, or cost figure.** None is measured or pinned.
- **Any "other improvements" / catch-all line.** Everything above is cited.
- **That the three original 0.2.0 tests were kept *plus* new ones in a way that
  proves backward compatibility.** The 11 baseline titles still pass
  (`tests/compatibility.test.mjs:43-336`), but no test exercises a live host.
- **That the image fix restores image support end-to-end.** `src/index.ts:422` is
  one line, untested, and the round's own alignment experiment with the live agent
  path was reverted for unrelated reasons.
