# dsh-opencode-free

**English** | [繁體中文](README.zh-TW.md)

[![npm](https://img.shields.io/npm/v/dsh-opencode-free)](https://www.npmjs.com/package/dsh-opencode-free)
[![CI](https://github.com/x5427876/dsh-opencode-free/actions/workflows/ci.yml/badge.svg)](https://github.com/x5427876/dsh-opencode-free/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

Use the free [OpenCode Zen](https://opencode.ai/docs/providers) models in
DeepSeek Harness (DSH). You do not need to
install OpenCode, log in, get an API key, or run a separate server.

> [!WARNING]
> This is an unofficial community plugin. It is not affiliated with OpenCode or
> DeepSeek. It reaches the keyless free tier by sending the OpenCode CLI
> identity. The upstream has no third-party contract, so it can stop working at
> any time. See [How it works](#how-it-works).

## Features

- Free Zen models in the DSH model picker, under the `opencode-zen-free` provider.
  The list follows models.dev and refreshes itself; a per-model switch on the
  plugin's detail page hides the ones you never pick.
- Anonymous by default. A Zen API key is optional.
- Native streaming through pi-ai: text, reasoning, tool calls, usage, and abort.
- Tools run inside DSH. The Windows `pwsh` shell works too.
- Clear error messages when the upstream rejects a request.

## Requirements

| Requirement | Version |
|---|---|
| DeepSeek Harness | `0.2.0-rc.1` (exact) |
| Node.js | `^22.19.0` or `>=24.0.0` |

Each plugin release pins one exact DSH version. Check yours first:

```sh
dsh --version
```

| Plugin | DSH |
|---|---|
| `0.2.x` | `0.2.0-rc.1` |
| `0.1.3` – `0.1.4` | `0.1.7-rc.2` |

Do not ignore peer dependency warnings.

## Install

The examples use the `web` profile. Replace it with your target profile.

```sh
dsh plugin --profile web add dsh-opencode-free@0.2.0
```

Check the install:

```sh
dsh plugin --profile web list dsh-opencode-free --depth 0
dsh --profile web --dump-config
```

The install is correct when the package appears once and `opencode-free`
appears in the composed config. Other profiles and plugins do not change.

Update or remove:

```sh
dsh plugin --profile web update dsh-opencode-free
dsh plugin --profile web remove dsh-opencode-free
```

## Usage

Restart DSH (or let HMR reload it). Open the model picker and select a model
under **OpenCode Zen Free**.

The catalogue follows [models.dev](https://models.dev): Zen's own `/models`
endpoint says which models exist, and models.dev says which of them are free,
what they are called, and how large their context is. The plugin reads it in the
background — at most once a day, never blocking a request — and caches the
result, so a newly published free model shows up on its own. There is nothing
to reinstall when Zen adds one.

Models currently listed as free and not retired upstream:

| Model | ID | Input | Context |
|---|---|---|---|
| Muse Spark 1.3 Free | `muse-spark-1.3-contributor-free` | text, image, video, audio | 1M |
| Space Bunny Free | `space-bunny-free` | text, image, video | 1M |
| LongCat 2.5 Preview Free | `longcat-2.5-preview-free` | text, image | 1M |
| MiMo-V2.6-Flash Free | `mimo-v2.6-flash-free` | text, image, audio, video | 200K |
| Nemotron 3 Ultra Free | `nemotron-3-ultra-free` | text | 1M |
| Nemotron 3.5 Lightning Free | `nemotron-3.5-lightning-free` | text | 256K |
| Ling 3.0 Flash Fin Free | `ling-3.0-flash-fin-free` | text | 256K |
| Big Pickle | `big-pickle` | text | 200K |

All models support reasoning and tool calls. DSH passes your reasoning level
through, and the levels it offers come from models.dev per model — Muse Spark
gets `minimal`…`xhigh`, Space Bunny gets `low`…`max`, and a level a model does
not publish is never offered. `off` stays offered as an explicit choice; it
sends no reasoning parameter at all, exactly like OpenCode's "Default" (the
request path strips the placeholder efforts pi-ai would otherwise put on the
wire for it). If you do not choose one, Muse Spark uses `xhigh`.

Each model's picture support, context size and maximum output are read from
models.dev as well, so a screenshot is only attached to a model that declares
image input and the context figure in the picker is the model's real one rather
than a copy of another model's.

**This table is a snapshot, not a contract.** It is here so you can recognise
what you are picking; the live list is whatever the plugin last read. The
plugin's detail page is where you see and change it: every model there has a
switch that hides it from the picker, and each row carries capability badges —
a vision badge when the model declares image input, and a thinking badge naming
its strongest published reasoning level. Models that publish no level list get
no thinking badge rather than a guessed one.

A probe round is reported live and then kept. While it runs, a progress pill
counts finished models against the total and every row shows its own state —
green with the answering latency, a spinner on the model being asked right now,
grey for the ones still queued. A red row never says only "failed": it names the
reason (gone, timed out, connection failed, the anonymous tier refusing, quota
used up, a bad key) and carries the HTTP status plus what to do about it in its
tooltip. Once the round ends the pill turns into its tally and stays on screen
instead of blinking away, and the capability badges return beside the outcome
badges. A model the round took out of the list is named in a "removed this
round" line, because a row that silently disappears has no way to explain
itself.

Two rules decide what you are offered:

- A model is offered until it stops answering **on the route you are using**.
  The plugin sends each model one short request and keeps the ones that reply.
  models.dev's `deprecated` flag only decides whether a model is *in* the
  catalogue, never whether you see it: on this provider that flag can mean the
  free tier ended, or only that the record is stale, and no static field can
  tell those apart.
- A model Zen no longer serves is not offered either, for the same reason.

A model that is not offered is simply **not in the list**. There is no second
list naming what was dropped, so there is nothing that can disagree with the
picker or go stale.

**A dead verdict is final.** Once the route has refused a model, the plugin
never asks about it again — re-asking a settled question would spend quota for
nothing, and on this provider it is the difference between roughly 34 requests
a day and roughly 10.

Adding a Zen key does not bring a removed model back, because **a key changes
your quota, not the model list**. The same models are served either way; the
free tier and a keyed account see the same catalogue, and a key only raises how
much you may send. A model the route refuses is refused with a key too.

If you want the whole catalogue re-judged anyway — after Zen brings a model
back, or fixes a channel — delete the plugin's cache file and restart DSH once:

```
%USERPROFILE%\.dsh\dsh-opencode-free\catalog.json
```

The next start re-reads models.dev, treats every model as unprobed, and probes
them all again. This is the only way back, so it is worth knowing before you
rely on the smaller list.

A model counts as gone when the route answers that it will not serve it —
`Model is unavailable.`, `Model <id> is not supported`, `404`, `410`. The last
of those is what most of the catalogue currently hits: **most models models.dev
lists at zero cost are not actually served on this provider at all** — with or
without a key — so a first probe typically narrows the list from around 34 to
about 10, and because the verdict is final that is a one-time cost rather than
a daily one.

### What the availability check costs you

Once a day, the plugin asks Zen one short question per model and waits for the
answers. That is a real cost and it is worth being explicit about it:

- **One round per local day, sent one at a time.** The requests are sequential
  on purpose — anonymous callers share one quota bucket, so firing them all at
  once would spend it faster and hammer upstream. The round only covers models
  that have never been judged, so it shrinks as models are retired. A Zen key
  raises your quota, which makes this round cheaper in practice, but it does not
  change which models are in it.
- **It can be turned off by not using it.** There is no separate switch: the
  round runs when you read the model list, and the detail page's **Probe now**
  button asks for an extra round on demand, bypassing the daily limit. If you
  never touch the picker you never pay for it.
- **A refused or throttled round changes nothing.** If the anonymous tier
  gates you, the quota runs out, your key is rejected, the network drops, or a
  whole endpoint is down, the plugin concludes nothing at all: the list stays
  exactly as it was and the card says this round's results are untrustworthy.
  The only thing that removes a model is the route positively saying that
  model will not be served.
- **Hiding a model is still yours to decide.** The switch on the card is
  independent of all of the above.

Offline, and on a first start: with neither network nor a cached copy, the
plugin falls back to the model set that ships inside pi-ai, so the picker still
works and the card says it is showing the built-in fallback. A failed refresh
never empties the list.

## Configuration

### Zen API key (optional)

Without a key, the plugin sends `Authorization: Bearer public` and no personal
credentials. If the anonymous tier rejects you, the plugin reports the error.
It never asks for a key or switches to a paid model on its own.

To use a key, choose one:

1. Add `apiKey` to the plugin's `config`. This takes effect on reload.
2. Set the `OPENCODE_API_KEY` environment variable.

Priority: `apiKey` config, then `OPENCODE_API_KEY`, then anonymous `public`.

DSH Desktop has no shell environment, so use option 1. Override the plugin
entry in the profile's `cordis.patch.yml`:

```yaml
- id: opencode-free
  name: dsh-opencode-free
  config:
    apiKey: <your Zen key>
```

Verify the key before you chat. This sends one 16-token request:

```sh
OPENCODE_API_KEY=<your Zen key> ./scripts/reverify.sh
```

Check lamp ③. Green means the key works. Red means the key is invalid or the
upstream has a problem.

## How it works

The plugin registers the `opencode-zen-free` provider through DSH's
`PiAiAdapter`. It sends requests straight to `https://opencode.ai/zen/v1` with
pi-ai's own transports: Responses for Muse Spark, Chat Completions for the
other models. The approach follows Pi's
[`pi-opencode-direct`](https://github.com/Aymendje/pi-opencode-direct).

The anonymous tier accepts a request only when it looks like the OpenCode CLI:

- the OpenCode `User-Agent` and `x-opencode-*` headers, with a valid `ses_` session ID;
- `stream: true`;
- tools named exactly `read` and `bash`.

On Windows, DSH ships `pwsh` instead of `bash`. For anonymous requests, the
plugin sends `pwsh` as `bash` and renames the returned calls back to `pwsh`.
Requests without tools (titles, compaction) get inert placeholder tools.
Requests with an API key are never rewritten.

The full investigation, with replay results and pitfalls, is in
[`docs/reverse-engineering.md`](docs/reverse-engineering.md).

## Troubleshooting

**`403 FreeTierError ... only be used from within OpenCode`**
Run `./scripts/reverify.sh`. Lamp ② sends a request that meets every known
gate condition. If lamp ② is yellow, the upstream gate changed. This is not a
configuration problem.

**HTTP 200, but no reply**
A `200` means the request passed the gate. If no content follows, that model
is stalled upstream. Try another model, or test it directly:

```sh
pnpm run build
node scripts/test-live.mjs nemotron-3.5-lightning-free
```

**Debug logs**
Set `DSH_OPENCODE_FREE_DEBUG=1` before you start DSH. The plugin logs the
outbound identity and request shape to stderr. It never logs content or keys.

## Development

Edit `src/*.ts`. Do not edit `lib/`: `tsc` generates it.

```sh
pnpm install
pnpm run typecheck  # strict type check
pnpm run build      # emit lib/
pnpm run test       # build, then run offline tests
pnpm run check      # typecheck, test, and pack
```

The unit tests use in-memory fixtures. They do not use the network or free
quota. These scripts send real requests:

| Script | What it checks |
|---|---|
| `scripts/reverify.sh` | ① catalogue reachable, ② anonymous gate, ③ API key (only when `OPENCODE_API_KEY` is set) |
| `node scripts/test-live.mjs [model-id ...]` | Every free model (or the ones you list) replies anonymously. Run `pnpm run build` first. |

For Agents that install or verify this plugin, see [`AGENTS.md`](AGENTS.md).

## License

[MIT](LICENSE). This is an independent extension. It is not affiliated with
OpenCode or DeepSeek.
