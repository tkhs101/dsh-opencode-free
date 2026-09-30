/**
 * Model catalogue owner: the models.dev `opencode.models` dictionary is the
 * source of truth for WHICH free models exist, while Zen's `/models` stays the
 * availability gate (a model models.dev calls free can still be unserved).
 *
 * Three layers, deliberately separable so each failure mode is attributable:
 *   1. derivation (pure): free test, activity test, channel inference, metadata
 *      mapping — no I/O, fully fixture-testable;
 *   2. fetch + cache: one conditional GET of the 5.2MB `api.json` (models.dev
 *      publishes no per-provider endpoint), storing ONLY the models dictionary
 *      so a warm start never re-downloads it;
 *   3. the state container: TTL, single-flight, degradation, and the Zen gate.
 *
 * DSH never calls `provider.refreshModels` (no host caller exists), so this
 * module owns its own trigger. It is host-side only: no DSH `ctx` concepts live
 * here, lifecycle wiring stays in `index.ts`.
 *
 * Identity (`provider` / `baseUrl` / `headers`) is NOT defined here — it is
 * inherited from `template`, an already identity-mapped pi-ai record, so the
 * Zen identity constants keep exactly one owner in `zen-provider.ts` and no
 * import cycle is introduced.
 */
import { Buffer } from "node:buffer";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";

/** Whole-file endpoint: models.dev serves no per-provider JSON (verified). */
export const MODELS_DEV_URL = "https://models.dev/api.json";
/** Cache schema version; anything else is treated as no cache at all. */
export const CACHE_VERSION = 1;
/** D4: lazy revalidation window. */
export const DEFAULT_TTL_MS = 86_400_000;
/** D1: bounded so a hung endpoint cannot pin a plugin fiber. */
export const DEFAULT_TIMEOUT_MS = 10_000;
/** R1: the real file is ~5.2MB; 20MB leaves headroom and rejects a runaway. */
export const DEFAULT_MAX_BYTES = 20 * 1024 * 1024;
/** Kept in step with package.json by hand (the repo has no build-time import). */
export const PLUGIN_VERSION = "0.2.0";
/**
 * models.dev is NOT Zen: it gets an honest agent string. Reusing the OpenCode
 * CLI identity here would be both pointless and misleading.
 */
export const DEFAULT_USER_AGENT = `dsh-opencode-free/${PLUGIN_VERSION}`;

/** Where the catalogue came from, as reported to the panel. */
export type CatalogSource = "models.dev" | "builtin-fallback";

/** A models.dev model record, before mapping. Deliberately loose. */
export type CatalogRecord = Record<string, unknown>;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finitePositive(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

/** D2: zero cost across every declared dimension. */
export function isFree(record: CatalogRecord): boolean {
  const cost = record.cost;
  if (!isPlainObject(cost)) return false;
  const values = Object.values(cost);
  return values.length > 0 && values.every((value) => value === 0);
}

/** D2: models.dev omits `status` for active models; only `deprecated` retires one. */
export function isActive(record: CatalogRecord): boolean {
  return record.status !== "deprecated";
}

/**
 * D1: what the catalogue keeps — `status` absent (how models.dev says active),
 * `active`, or `deprecated`. A `deprecated` model STAYS in the catalogue:
 * only a probe can tell a finished free tier from a stale upstream record, and
 * a model dropped here could never be probed or brought back (D6a). Any other
 * status value is discarded outright.
 */
export function isCatalogueStatus(record: CatalogRecord): boolean {
  const status = record.status;
  if (status === undefined) return true;
  return status === "active" || status === "deprecated";
}

function reasoningOptionTypes(record: CatalogRecord): string[] {
  const options = record.reasoning_options;
  if (!Array.isArray(options)) return [];
  return options
    .map((option) => (isPlainObject(option) && typeof option.type === "string" ? option.type : undefined))
    .filter((type): type is string => type !== undefined);
}

/** pi-ai's level vocabulary, in the order it filters them. */
const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

/**
 * `getSupportedThinkingLevels` treats `xhigh` and `max` as opt-in — absent from
 * the map means NOT offered — but includes `off`/`minimal`/`low`/`medium`/`high`
 * unless they are explicitly mapped to `null`. A faithful map therefore has to
 * null out the ones models.dev does not publish; leaving them absent would
 * offer a level the model rejects.
 */
const OPT_IN_THINKING_LEVELS = new Set<string>(["xhigh", "max"]);

/**
 * D6: the thinking levels models.dev publishes for this model, as pi-ai's
 * `thinkingLevelMap`.
 *
 * The values are identity because OpenCode is OpenAI-compatible and the level
 * name is what goes on the wire (`reasoning_effort` on completions, `effort` on
 * responses); the map's job here is to say which levels EXIST.
 *
 * `off` is deliberately left absent (offered) rather than nulled: it means
 * "send no reasoning parameter", which is a real choice the user asked to keep
 * as an explicit row. The placeholder effort pi-ai would otherwise put on the
 * wire for it (`"none"` by default, `"off"` when explicitly chosen — neither of
 * which pi-ai's own builtin records nor OpenCode ever send) is stripped back
 * to "no reasoning object" by the plugin's onPayload guard in zen-provider.ts,
 * so offering it is safe.
 *
 * `undefined` means "models.dev published no level list, so make no claim" —
 * pi-ai then falls back to its own default set. That is the honest answer for
 * a `toggle` model (reasoning is on or off, and pi-ai has no name for bare
 * "on") and for a record with `reasoning_options: []`. Guessing there would
 * offer levels upstream rejects, which surfaces as an
 * `UNSUPPORTED_REASONING_EFFORT` failure rather than as a clamp.
 */
export function thinkingLevelMapFor(
  record: CatalogRecord,
): Record<string, string | null> | undefined {
  const options = record.reasoning_options;
  if (!Array.isArray(options)) return undefined;
  const published = new Set<string>();
  for (const option of options) {
    if (!isPlainObject(option) || option.type !== "effort") continue;
    const values = option.values;
    if (!Array.isArray(values)) continue;
    for (const value of values) {
      if (typeof value === "string" && (THINKING_LEVELS as readonly string[]).includes(value)) {
        published.add(value);
      }
    }
  }
  if (published.size === 0) return undefined;
  const map: Record<string, string | null> = {};
  for (const level of THINKING_LEVELS) {
    // `off` stays absent (offered) rather than nulled: the user asked to keep
    // it as an explicit choice. The placeholder effort this would otherwise
    // put on the wire is stripped back to "no reasoning object" by the
    // plugin's onPayload guard (see zen-provider.ts), so offering it is safe.
    if (level === "off") continue;
    if (published.has(level)) map[level] = level;
    else if (!OPT_IN_THINKING_LEVELS.has(level)) map[level] = null;
  }
  return map;
}

/**
 * D6, three tiers: the pi-ai builtin table when it knows the model, then
 * models.dev signals, then the provider's own default. Validated 7/7 against
 * the known opencode models (interleaved/toggle ⇒ completions, effort ⇒
 * responses).
 */
export function channelFor(record: CatalogRecord, knownApis?: ReadonlyMap<string, Api>): Api {
  const id = typeof record.id === "string" ? record.id : undefined;
  if (id !== undefined && knownApis !== undefined) {
    const known = knownApis.get(id);
    if (known !== undefined) return known;
  }
  if (record.interleaved !== undefined) return "openai-completions";
  const types = reasoningOptionTypes(record);
  if (types.includes("toggle")) return "openai-completions";
  if (types.includes("effort")) return "openai-responses";
  return "openai-completions";
}

export interface DeriveOptions {
  /** pi-ai builtin `id -> api`, tier 1 of D6. */
  readonly knownApis?: ReadonlyMap<string, Api>;
  /** An already identity-mapped record supplying the fallback field values. */
  readonly template: Model<Api>;
}

export interface DerivedCatalog {
  /** Free AND `status ∈ {active, deprecated}` — the pre-Zen-gate catalogue. */
  readonly candidates: Model<Api>[];
}

/**
 * Map one models.dev record onto a pi-ai model. `template` supplies identity
 * and every field models.dev does not publish. A record whose fields have the
 * wrong type falls back per-field rather than failing the whole catalogue.
 */
/**
 * One models.dev record → one pi-ai model. Everything the plugin can learn
 * about a model's CAPABILITIES is taken from the record rather than inherited:
 *
 *   - image input      ← `modalities.input` (pi-ai knows only text/image, so
 *                        audio/video/pdf are dropped, not silently kept)
 *   - context window   ← `limit.context`
 *   - max output       ← `limit.output`
 *   - thinking levels  ← `reasoning_options[].values`
 *
 * A field models.dev does not publish falls back to the template, and the
 * template is one fixed record — so `thinkingLevelMap` is set EXPLICITLY in
 * both branches. Inheriting another model's level list would offer levels this
 * model rejects, which the host reports as `UNSUPPORTED_REASONING_EFFORT`
 * rather than clamping.
 */
function buildModel(record: CatalogRecord, template: Model<Api>, knownApis?: ReadonlyMap<string, Api>): Model<Api> {
  const id = typeof record.id === "string" && record.id !== "" ? record.id : "";
  const api = channelFor(record, knownApis);
  const limit = isPlainObject(record.limit) ? record.limit : {};
  const modalities = isPlainObject(record.modalities) ? record.modalities : {};
  const declaredInput = Array.isArray(modalities.input)
    ? modalities.input.filter((entry): entry is "text" | "image" => entry === "text" || entry === "image")
    : [];
  const levels = thinkingLevelMapFor(record);
  return {
    ...template,
    id,
    name: typeof record.name === "string" && record.name !== "" ? record.name : id,
    api,
    reasoning: typeof record.reasoning === "boolean" ? record.reasoning : template.reasoning,
    input: declaredInput.length > 0 ? declaredInput : template.input,
    // Free by construction here (isFree already proved it); stated explicitly
    // so a stray inherited tier cannot reintroduce a non-zero rate.
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: finitePositive(limit.context) ?? template.contextWindow,
    maxTokens: finitePositive(limit.output) ?? template.maxTokens,
    thinkingLevelMap: (levels ?? undefined) as Model<Api>["thinkingLevelMap"],
    // `compat` is transport-specific. Carrying the template's completions
    // overrides onto a responses model would misconfigure it, so a channel
    // change drops them and lets pi-ai auto-detect from baseUrl.
    compat: (api === template.api ? template.compat : undefined) as Model<Api>["compat"],
  };
}

/**
 * Alphabetical by id, with a plain comparison rather than `localeCompare`: the
 * ids are lowercase ASCII, and ICU collation orders `kimi-k2.5-free` and
 * `kimi-k2-5-free` differently depending on the host's locale — a list whose
 * order depends on the machine is not an order anyone can rely on.
 */
export function byId<T extends { readonly id: string }>(a: T, b: T): number {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** Pure: models.dev models dictionary → pre-gate catalogue. */
export function derive(section: CatalogRecord, options: DeriveOptions): DerivedCatalog {
  const candidates: Model<Api>[] = [];
  for (const [key, value] of Object.entries(section)) {
    if (!isPlainObject(value)) continue;
    const id = typeof value.id === "string" && value.id !== "" ? value.id : key;
    if (id === "") continue;
    const record: CatalogRecord = { ...value, id };
    if (!isFree(record)) continue;
    // D1: `deprecated` is kept (a probe judges it); anything else is discarded.
    if (!isCatalogueStatus(record)) continue;
    candidates.push(buildModel(record, options.template, options.knownApis));
  }
  // Sorted HERE, at the one place the list is born, so the snapshot, the
  // visible set and the picker all inherit the same order instead of each
  // deciding for itself. models.dev's own order is grouped by vendor and
  // family, which reads as arbitrary to anyone scanning for one model.
  return { candidates: candidates.slice().sort(byId) };
}

export interface FetchLikeResponse {
  readonly status: number;
  readonly ok: boolean;
  readonly headers: { get(name: string): string | null };
  text(): Promise<string>;
}

export type FetchLike = (
  url: string,
  init: { headers: Record<string, string>; signal?: AbortSignal },
) => Promise<FetchLikeResponse>;

export interface FetchSectionOptions {
  readonly fetchImpl: FetchLike;
  /** Sent as `if-none-match`; callers MUST omit it when no cache exists (R5). */
  readonly etag?: string | undefined;
  readonly url?: string;
  readonly userAgent?: string;
  readonly timeoutMs?: number;
  readonly maxBytes?: number;
}

export type FetchSectionResult =
  | { readonly kind: "not-modified" }
  | { readonly kind: "ok"; readonly etag: string | undefined; readonly section: CatalogRecord }
  | { readonly kind: "failed"; readonly reason: string };

/** D1: one conditional GET. Every failure mode is reported, never thrown. */
export async function fetchSection(options: FetchSectionOptions): Promise<FetchSectionResult> {
  const {
    fetchImpl,
    etag,
    url = MODELS_DEV_URL,
    userAgent = DEFAULT_USER_AGENT,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    maxBytes = DEFAULT_MAX_BYTES,
  } = options;
  const headers: Record<string, string> = { accept: "application/json", "user-agent": userAgent };
  if (typeof etag === "string" && etag !== "") headers["if-none-match"] = etag;
  try {
    const response = await fetchImpl(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
    if (response.status === 304) return { kind: "not-modified" };
    if (!response.ok) return { kind: "failed", reason: `http ${response.status}` };
    const text = await response.text();
    if (Buffer.byteLength(text, "utf8") > maxBytes) return { kind: "failed", reason: "response too large" };
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      // A stable reason, not the engine's SyntaxError text: callers and logs
      // compare on this vocabulary.
      return { kind: "failed", reason: "malformed response body" };
    }
    if (!isPlainObject(body)) return { kind: "failed", reason: "malformed response body" };
    // api.json is keyed by provider: `body.opencode` is the PROVIDER record
    // ({id,env,npm,api,name,doc,models}) and the model dictionary sits one
    // level deeper. Handing the provider record to `derive` yields an EMPTY
    // catalogue — none of those keys carries a zero cost — which is worse than
    // the offline floor. The unwrap therefore happens here, once, and `derive`
    // only ever sees a models dictionary.
    const provider = body.opencode;
    if (!isPlainObject(provider)) return { kind: "failed", reason: "missing opencode section" };
    const models = provider.models;
    if (!isPlainObject(models)) return { kind: "failed", reason: "missing opencode models section" };
    return { kind: "ok", etag: response.headers.get("etag") ?? undefined, section: models };
  } catch (error) {
    const name = isPlainObject(error) && typeof error.name === "string" ? error.name : "Error";
    const message = error instanceof Error ? error.message : String(error);
    return { kind: "failed", reason: name === "TimeoutError" || name === "AbortError" ? "timeout" : message };
  }
}

export interface CatalogCacheRecord {
  readonly version: number;
  readonly etag: string | undefined;
  readonly fetchedAt: number;
  /** The `opencode.models` dictionary — named for what it holds, not the slice it came from. */
  readonly models: CatalogRecord;
  /** Conclusive verdicts only; empty means "no history", i.e. all unprobed. */
  readonly probes: ProbeMap;
  /** When the last probe ROUND ran, whether or not it concluded anything. */
  readonly lastProbeAt: number;
  /**
   * The last round's report — the tally and the per-row outcomes the panel
   * draws. It lives here because the live reading is memory-only, and memory
   * does not survive a restart: without this the card adopts nothing on mount
   * after a restart and the progress area is simply blank, which reads as
   * "the probe display is gone" rather than "there is nothing to report yet".
   * Optional and version-stable; a cache without it restores as before.
   */
  readonly lastRound?: {
    readonly total: number;
    readonly done: number;
    readonly results: Record<string, ProbeProgressResult>;
    /** The round's scope, so a restored report still says what it covered. */
    readonly targets?: readonly string[];
  };
}

/** A conclusive verdict. `inconclusive` is deliberately NOT one of them. */
export type ProbeVerdict = "ok" | "dead";

export interface ProbeRecord {
  readonly verdict: ProbeVerdict;
  readonly at: number;
  readonly reason?: string;
  /**
   * Whether this `dead` was established by asking every channel the provider
   * implements, rather than by a single request.
   *
   * It is the whole difference between "this model is gone" and "this request
   * was refused", because a wrong channel is answered with the same "not
   * supported" sentence a dead model produces. A verdict recorded before the
   * sweep existed has no marker and is therefore re-checked once: those older
   * verdicts are exactly the ones that may have been a routing mistake, and
   * leaving them permanent is how a working model stays missing forever.
   */
  readonly swept?: boolean;
}

export type ProbeMap = Record<string, ProbeRecord>;

/**
 * What the transport layer reports for one probe. Structurally compatible with
 * `zen-provider`'s `ProbeOutcome`; declared here so this module keeps no
 * dependency on the transport and no import cycle is introduced. A prober may
 * also reject, which is treated as "no conclusion" (D5).
 */
export interface ProbeResult {
  readonly kind: ProbeVerdict | "inconclusive";
  readonly reason?: string;
  /** Machine-readable failure code; the panel localizes it rather than guessing. */
  readonly code?: string;
  /** HTTP status the transport saw; 0 means no response ever arrived. */
  readonly http?: number;
  /**
   * Which anonymous-gate marker the upstream body carried, when it carried
   * one. `code: "anon-gated"` deliberately folds three conditions together
   * because none of them is a verdict about the model — but they need three
   * different fixes, and the body is the only place that fact ever exists.
   * Carried into the round record so the panel can say which.
   */
  readonly marker?: string | null | undefined;
}

/** Read persisted verdicts defensively: a damaged entry is dropped, not fatal. */
function readProbes(value: unknown): ProbeMap {
  if (!isPlainObject(value)) return {};
  const probes: ProbeMap = {};
  for (const [id, entry] of Object.entries(value)) {
    if (!isPlainObject(entry)) continue;
    if (entry.verdict !== "ok" && entry.verdict !== "dead") continue;
    if (typeof entry.at !== "number" || !Number.isFinite(entry.at)) continue;
    probes[id] = {
      verdict: entry.verdict,
      at: entry.at,
      ...(typeof entry.reason === "string" && entry.reason !== "" ? { reason: entry.reason } : {}),
      ...(entry.swept === true ? { swept: true } : {}),
    };
  }
  return probes;
}

/** D5: `$DSH_HOME/dsh-opencode-free/catalog.json` (same convention as dsh-pocket). */
export function cachePath(env: Record<string, string | undefined> = process.env): string {
  const home = env.DSH_HOME !== undefined && env.DSH_HOME !== "" ? env.DSH_HOME : join(homedir(), ".dsh");
  return join(home, "dsh-opencode-free", "catalog.json");
}

/** Any unreadable/foreign cache is simply "no cache" — never an error. */
export async function readCache(path: string): Promise<CatalogCacheRecord | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    if (!isPlainObject(parsed)) return null;
    if (parsed.version !== CACHE_VERSION) return null;
    // The `models` guard is what makes the field rename safe: a file still
    // carrying the old `opencode` provider record is rejected outright rather
    // than adopted as a catalogue.
    if (!isPlainObject(parsed.models)) return null;
    return {
      version: CACHE_VERSION,
      etag: typeof parsed.etag === "string" ? parsed.etag : undefined,
      fetchedAt: typeof parsed.fetchedAt === "number" ? parsed.fetchedAt : 0,
      models: parsed.models,
      probes: readProbes(parsed.probes),
      lastProbeAt: typeof parsed.lastProbeAt === "number" && Number.isFinite(parsed.lastProbeAt) ? parsed.lastProbeAt : 0,
      lastRound: readLastRound(parsed.lastRound),
    };
  } catch {
    return null;
  }
}

/**
 * The last round's report, read defensively. A damaged or absent field means
 * "no report to show", which is exactly what the panel showed before — the
 * report is a convenience, never a verdict.
 */
function readLastRound(value: unknown): CatalogCacheRecord["lastRound"] {
  if (!isPlainObject(value)) return undefined;
  const total = value.total;
  const done = value.done;
  if (typeof total !== "number" || !isFinite(total) || total <= 0) return undefined;
  if (typeof done !== "number" || !isFinite(done)) return undefined;
  const results: Record<string, ProbeProgressResult> = {};
  if (isPlainObject(value.results)) {
    for (const [id, entry] of Object.entries(value.results)) {
      if (!isPlainObject(entry)) continue;
      if (entry.status === "ok" && typeof entry.ms === "number") {
        results[id] = { status: "ok", ms: entry.ms };
        continue;
      }
      if (entry.status === "failed" && typeof entry.ms === "number") {
        results[id] = {
          status: "failed",
          ms: entry.ms,
          code: typeof entry.code === "string" ? entry.code : "unknown",
          http: typeof entry.http === "number" && isFinite(entry.http) ? entry.http : 0,
          ...(entry.removed === false ? { removed: false } : {}),
          ...(typeof entry.marker === "string" && entry.marker !== "" ? { marker: entry.marker } : {}),
        };
      }
    }
  }
  const targets = Array.isArray(value.targets)
    ? value.targets.filter((id): id is string => typeof id === 'string')
    : [];
  return { total, done, results, targets };
}

/** Temp file + rename, so a crash mid-write can never leave a torn cache. */
export async function writeCacheAtomic(
  path: string,
  record: {
    etag: string | undefined;
    fetchedAt: number;
    models: CatalogRecord;
    probes?: ProbeMap;
    lastProbeAt?: number;
    lastRound?: CatalogCacheRecord["lastRound"];
  },
): Promise<boolean> {
  const temporary = `${path}.${process.pid}.tmp`;
  try {
    await mkdir(dirname(path), { recursive: true });
    const payload: Record<string, unknown> = {
      version: CACHE_VERSION,
      etag: record.etag,
      fetchedAt: record.fetchedAt,
      models: record.models,
    };
    // Probe fields are omitted until a round has something to record, so a
    // never-probed cache keeps exactly the file shape it had before probing
    // existed (and a catalogue sync must carry the current verdicts forward
    // rather than silently dropping them).
    if (record.probes !== undefined && Object.keys(record.probes).length > 0) payload.probes = record.probes;
    if (record.lastProbeAt !== undefined && record.lastProbeAt > 0) payload.lastProbeAt = record.lastProbeAt;
    const round = record.lastRound;
    if (round !== undefined && round.total > 0) payload.lastRound = round;
    await writeFile(temporary, JSON.stringify(payload), "utf8");
    await rename(temporary, path);
    return true;
  } catch {
    // A cache we cannot persist is a performance loss, never a failure.
    return false;
  }
}

export interface CatalogSnapshot {
  /** Pre-Zen-gate catalogue (what `refreshModels` intersects and probes). */
  readonly models: Model<Api>[];
  /**
   * Post-gate, post-probe ids: exactly what the picker offers. A model a probe
   * judged `dead` is simply absent — there is no companion list naming it.
   */
  readonly visible: readonly string[];
  /**
   * One capability card per `visible` id, same order: what the detail-page
   * panel renders next to each row. Names and booleans only, never the full
   * records (which carry request-shaping internals the browser has no use for).
   */
  readonly capabilities: readonly ModelCapability[];
  readonly source: CatalogSource;
  readonly updatedAt: number;
  readonly refreshing: boolean;
  /** When the last probe round ran; 0 means never. */
  readonly probedAt?: number;
  /** The last round reached no conclusion (gated, quota, bad key, network). */
  readonly probeInconclusive?: boolean;
}

/**
 * The three facts the detail-page panel renders per row. `thinking` is the
 * strongest published thinking level (`"Max"`, `"XHigh"`, …) or `null` when
 * the model publishes no level list — the panel shows no thinking badge then,
 * rather than guessing. The raw level id travels here; display capitalization
 * is the panel's business.
 */
export interface ModelCapability {
  readonly id: string;
  readonly image: boolean;
  readonly thinking: string | null;
}

/** Strongest-first thinking levels; `off` is never a badge. */
const THINKING_LEVEL_RANK = ["max", "xhigh", "high", "medium", "low", "minimal"] as const;

/**
 * The badge level for one derived record: the strongest level whose map value
 * is a real (string) entry. A string-valued map entry IS a published level —
 * `thinkingLevelMapFor` only writes identity entries for published names and
 * `null` for unpublished ones — so this reads the same fact back without
 * re-parsing models.dev. No map, or no string entry, means no badge.
 */
export function topThinkingLevel(model: Model<Api>): string | null {
  const map = model.thinkingLevelMap;
  if (!map || typeof map !== "object") return null;
  for (const level of THINKING_LEVEL_RANK) {
    if (typeof (map as Record<string, unknown>)[level] === "string") return level;
  }
  return null;
}

/** Project one effective record to the panel's capability card. */
export function modelCapability(model: Model<Api>): ModelCapability {
  return {
    id: model.id,
    image: Array.isArray(model.input) && model.input.includes("image"),
    thinking: topThinkingLevel(model),
  };
}

export interface CreateCatalogOptions {
  /** Identity + fallback field source; an already identity-mapped record. */
  readonly template: Model<Api>;
  /** D8 offline floor: the pi-ai builtin free set, used until a sync lands. */
  readonly builtinBaseline: Model<Api>[];
  readonly knownApis?: ReadonlyMap<string, Api>;
  readonly cachePath: string;
  readonly fetchImpl: FetchLike;
  /**
   * Sends one minimal request per model and classifies the answer. Injected so
   * this module keeps no transport dependency; when absent, probing is simply
   * unavailable and every probe entry point is a no-op.
   */
  readonly probe?: ((model: Model<Api>) => Promise<ProbeResult>) | undefined;
  /**
   * The ids Zen currently serves, from one `GET /zen/v1/models` — the same cheap
   * availability check 9router performs for its free provider, and the reason
   * that check is worth doing before anything expensive.
   *
   * A model missing from this list is not available, full stop, and saying so
   * costs one GET instead of one inference request per model. Resolves null when
   * the fetch failed, which must never narrow anything: the round then falls
   * back to probing everything it would otherwise have probed.
   */
  readonly listZenIds?: (() => Promise<readonly string[] | null>) | undefined;
  /**
   * Is this model switched OFF in the picker? A round asks only about the
   * models the user has on: a probe costs a request from a bucket shared by
   * everything behind this egress, so spending one on a model that is hidden
   * is an answer nobody will read, taken at the expense of the ones that will
   * be. Read live, so a toggle mid-round is honoured on the next round.
   */
  readonly hidden?: ((id: string) => boolean) | undefined;
  readonly now?: () => number;
  readonly ttlMs?: number;
  readonly userAgent?: string;
}

export interface Catalog {
  current(): CatalogSnapshot;
  /** Post-Zen-gate models — the single list the picker and the panel share. */
  effectiveModels(): Model<Api>[];
  /** Fire-and-forget revalidation; shared by concurrent callers. */
  ensureFresh(): Promise<void>;
  /** Ignores the TTL and waits for the sync to settle. */
  forceRefresh(): Promise<void>;
  /** One ordered probe round; at most one per local day (D2). */
  runProbes(): Promise<void>;
  /** Ignores the daily gate; used by the panel button (D8). */
  forceProbes(): Promise<void>;
  /** `null` means Zen failed: keep the current gate rather than narrowing. */
  applyZenGate(ids: readonly string[] | null): void;
  /**
   * The live progress of the current (or last) probe round, for the panel's
   * progress pill and per-row badges. In-memory only — it is a transient fuel
   * gauge, not a verdict, so it is never persisted and never narrows anything.
   */
  probeProgress(): ProbeProgress;
}

/**
 * What the panel polls while a round is running — and reads again after it
 * ends, so the last round's outcome is still on screen instead of vanishing.
 * `results` holds one entry per FINISHED model; the in-flight one is `current`;
 * everything else is waiting. `ms` is the wall time that model's probe took,
 * for the "✓ 142ms" badge.
 *
 * A failure carries `code` (a {@link ProbeFailureCode} the card localizes) and
 * `http` (0 when no status ever arrived). A red badge that only says "failed"
 * is the thing this type exists to prevent.
 */
export interface ProbeProgress {
  readonly running: boolean;
  readonly total: number;
  readonly done: number;
  readonly current: string | null;
  readonly results: Readonly<Record<string, ProbeProgressResult>>;
  /**
   * The ids this round accounts for — its whole scope, asked or not-yet-asked.
   *
   * A round now only asks about the models the user has switched ON, so "no
   * result yet" means two different things: queued, or not in this round at
   * all. The panel cannot tell them apart from `results` alone, and calling a
   * skipped model "waiting" is a claim about a round that will never reach it.
   */
  readonly targets: readonly string[];
  /** When the current (or last) round started; 0 means no round has ever run. */
  readonly startedAt: number;
}

/** One model's outcome in a round: answered (with latency) or not (with why). */
export type ProbeProgressResult =
  | { readonly status: "ok"; readonly ms: number }
  | {
      readonly status: "failed";
      readonly ms: number;
      readonly code: string;
      readonly http: number;
      /**
       * Present only on a `dead` verdict: did THIS round take the model out of
       * the list, or did it only re-confirm a death that had already removed
       * it? A re-confirmation is a real answer and worth showing, but calling it
       * a removal reports a change the round did not make. Omitted by older
       * backends, which the card reads as "removed" — its own behaviour.
       */
      readonly removed?: boolean | undefined;
      /** Which anonymous-gate marker the refusal carried, when it named one. */
      readonly marker?: string | undefined;
    };

export function createCatalog(options: CreateCatalogOptions): Catalog {
  const { template, builtinBaseline, knownApis, cachePath: path, fetchImpl, ttlMs = DEFAULT_TTL_MS } = options;
  const now = options.now ?? Date.now;
  const userAgent = options.userAgent;
  const probe = options.probe;
  const listZenIds = options.listZenIds;
  const hidden = options.hidden;

  let cache: CatalogCacheRecord | null = null;
  let models: Model<Api>[] = builtinBaseline.slice().sort(byId);
  let source: CatalogSource = "builtin-fallback";
  let updatedAt = 0;
  let zenIds: ReadonlySet<string> | null = null;
  let inflight: Promise<void> | null = null;
  let probes: ProbeMap = {};
  let lastProbeAt = 0;
  let probeUntrusted = false;
  // Live round state, replaced wholesale at the start of every round. Plain
  // mutable object on purpose: the panel polls a copy while the round mutates
  // the original, and no verdict logic ever reads this.
  let probeRun: {
    running: boolean;
    total: number;
    done: number;
    current: string | null;
    results: Record<string, ProbeProgressResult>;
    startedAt: number;
    targets: string[];
  } = { running: false, total: 0, done: 0, current: null, results: {}, targets: [], startedAt: 0 };
  let probeInflight: Promise<void> | null = null;

  // Warm start: a valid cache restores the catalogue without any network.
  const adopt = (record: CatalogCacheRecord): void => {
    const derived = derive(record.models, { knownApis, template });
    models = derived.candidates;
    source = "models.dev";
    updatedAt = record.fetchedAt;
    if (Object.keys(record.probes).length > 0) probes = { ...record.probes };
    if (record.lastProbeAt > lastProbeAt) lastProbeAt = record.lastProbeAt;
    // The report of a round that already finished, so a restart shows the
    // outcome instead of an empty progress area. `running` stays false: this is
    // a completed round, not one to follow.
    const restored = record.lastRound;
    if (restored !== undefined && restored.total > 0) {
      probeRun = {
        running: false,
        total: restored.total,
        done: restored.done,
        current: null,
        results: { ...restored.results },
        targets: Array.isArray(restored.targets) ? restored.targets.slice() : [],
        startedAt: record.lastProbeAt,
      };
    }
    // Verdicts for models the catalogue no longer carries are dropped: a
    // vanished model is not in any round's target list, so keeping its verdict
    // would only grow the cache file across upstream removals. This is also
    // why a DEAD model is not removed from `models` above — see effectiveList.
    const present = new Set(models.map((model) => model.id));
    for (const id of Object.keys(probes)) if (!present.has(id)) delete probes[id];
  };

  /**
   * Resolves once the warm cache read has settled.
   *
   * The warm start is deliberately fire-and-forget — a container must answer
   * synchronously — but that left it free to land AFTER a sync and replace the
   * fresher section with the older cached one, holding a removed model in the
   * picker for a whole TTL. `sync()` therefore waits for this before fetching.
   * The wait is one local `readFile` of the cache (megabytes, not a download)
   * and is bounded, so a wedged filesystem delays a sync rather than hanging
   * it forever.
   */
  const WARM_READ_TIMEOUT_MS = 2_000;
  let settleWarm: () => void = () => undefined;
  const warm = new Promise<void>((resolve) => {
    settleWarm = resolve;
  });

  const warmStart = (): void => {
    void readCache(path)
      .then((found) => {
        if (found === null) return;
        cache = found;
        // Adopted whatever its age: a stale cache is still a far better answer
        // than the offline floor, and `ensureFresh` revalidates on the first read
        // in the background rather than making the user wait for 5.2MB.
        adopt(found);
      })
      .catch(() => undefined)
      .finally(settleWarm);
  };
  warmStart();

  const stale = (): boolean => now() - updatedAt > ttlMs;

  /**
   * D2: at most one round per LOCAL calendar day — the plan's rule, compared
   * against the previous round's local day via the injected `now` so a test can
   * place both ends exactly.
   *
   * Calendar day, not a rolling 24h window: the bound is on how much of the
   * shared anonymous bucket one day's sweep may spend, and "same day" is what a
   * user reading the panel would expect. The known edge is a round at 23:50
   * followed by one at 00:10 — different days, so both run. That is deliberate,
   * not an oversight; `forceProbes` bypasses this gate entirely, so a manual
   * click is never blocked either way.
   */
  const probedToday = (): boolean => {
    if (lastProbeAt <= 0) return false;
    const previous = new Date(lastProbeAt);
    const today = new Date(now());
    return (
      previous.getFullYear() === today.getFullYear() &&
      previous.getMonth() === today.getMonth() &&
      previous.getDate() === today.getDate()
    );
  };

  /**
   * The one list the picker and the panel share: the catalogue, narrowed by
   * Zen's gate, minus everything a probe judged dead. A dead model is dropped
   * from here and named nowhere — the user asked for it to simply not be in the
   * list, so there is deliberately no companion "unavailable" list to restore
   * or to go stale.
   *
   * `models` itself still carries dead entries, and that is load-bearing rather
   * than untidy: `adopt` prunes verdicts for models the catalogue no longer
   * has, so a dead model physically removed from `models` would lose its
   * verdict on the next sync, come back as a fresh candidate, and be re-probed
   * to the same answer. Keeping the record is what makes the verdict final.
   */
  const effectiveList = (): Model<Api>[] => {
    const gated = zenIds === null ? models : models.filter((model) => zenIds!.has(model.id));
    // Order comes from where the catalogue is born (derive / the offline
    // floor); this only filters, so it cannot drift from it.
    return gated.filter((model) => probes[model.id]?.verdict !== "dead");
  };

  const effectiveVisible = (): string[] => effectiveList().map((model) => model.id);

  const sync = async (): Promise<void> => {
    // Never fetch before the warm read settles: the response below is built
    // from `cache` (for the conditional etag) and adopted over whatever the
    // warm start installed, so letting the two interleave either resurrects a
    // removed model or drops the persisted probe history.
    await Promise.race([warm, new Promise<void>((resolve) => setTimeout(resolve, WARM_READ_TIMEOUT_MS).unref?.())]);
    // R5: without a cache there is nothing a 304 could rebuild, so the
    // conditional header must not be sent at all.
    const result = await fetchSection({ fetchImpl, etag: cache?.etag, userAgent });
    if (result.kind === "failed") return; // failure preserves the current catalogue
    const stamp = now();
    if (result.kind === "not-modified") {
      updatedAt = stamp;
      // Carry the new freshness into the cache file too, otherwise every boot
      // would revalidate again despite the catalogue being current.
      if (cache !== null) {
        cache = { ...cache, fetchedAt: stamp };
        await writeCacheAtomic(path, {
          etag: cache.etag,
          fetchedAt: stamp,
          models: cache.models,
          probes,
          lastProbeAt,
        });
      }
      return;
    }
    // Retain the etag: without this every revalidation would be a full
    // 5.2MB download instead of a conditional request.
    cache = { version: CACHE_VERSION, etag: result.etag, fetchedAt: stamp, models: result.section, probes, lastProbeAt };
    adopt(cache);
    await writeCacheAtomic(path, { etag: result.etag, fetchedAt: stamp, models: result.section, probes, lastProbeAt });
  };

  const runSingle = (): Promise<void> => {
    if (inflight !== null) return inflight;
    inflight = sync().finally(() => {
      inflight = null;
    });
    return inflight;
  };

  /**
   * D2/D6b: one ordered round over the models that are still unjudged.
   *
   * Sequential `for…await` on purpose (no concurrency, no batching): the round
   * spends a shared anonymous-quota bucket, and firing 30+ requests at once
   * would both exhaust it faster and hammer upstream.
   *
   * A model already judged `dead` is NOT re-probed. The verdict is final by
   * design: re-asking a model the route has already refused spends quota to
   * re-learn a settled fact, and on this provider that is the difference
   * between ~34 requests a day and ~10. A Zen key does not change this — it
   * raises the quota, not the model list, so a refused model is refused with a
   * key too. Recovery is manual and is for upstream changes (a model coming
   * back, a channel being fixed): delete
   * `$DSH_HOME/dsh-opencode-free/catalog.json` and the next start re-derives
   * and re-probes the whole catalogue.
   *
   * Only conclusive verdicts are recorded. An `inconclusive` — or a prober that
   * rejects — leaves the model exactly as it was (D5): one gated IP must never
   * empty the picker.
   */
  const runProbeRound = async (): Promise<void> => {
    const stamp = now();
    // Cheap authoritative availability first. One `GET /zen/v1/models` answers
    // "does Zen serve this id at all" without spending inference quota, so a
    // withdrawn model costs one GET instead of one completion — and the answer
    // is Zen's own, not a reading of error prose. This is the same check 9router
    // makes for its free provider, and it is the reason its availability test
    // is fast.
    //
    // It is deliberately NOT recorded as a `dead` verdict. `dead` is permanent
    // and learned by asking the model; membership is recomputed from the
    // authority on every round, so a model Zen puts back simply reappears.
    // Conflating the two is how a model that came back stays suppressed forever.
    const served = await listZenIds?.().catch(() => null) ?? null;
    if (served !== null) zenIds = new Set(served);
    const servedSet = served === null ? null : new Set(served);
    const live = servedSet === null
      ? models
      : models.filter((model) => servedSet.has(model.id));
    // A `dead` verdict is final ONLY once it has been earned by asking every
    // channel. A verdict without that marker predates the sweep, so it gets one
    // re-check: those are precisely the verdicts that may have been a wrong
    // channel refused rather than a model that is gone — and a permanent verdict
    // on a wrong channel is how a working model goes missing for good.
    const settled = (id: string): boolean => {
      const record = probes[id];
      if (record === undefined || record.verdict !== "dead") return false;
      return record.swept === true;
    };
    const isShown = (id: string): boolean => hidden?.(id) !== true;
    const targets = live.filter((model) => isShown(model.id) && !settled(model.id));
    // Models Zen dropped: out of `visible` without ever being asked. They still
    // count toward the round, because the panel's tally has to add up and a
    // silent hole in the list is exactly what a reader cannot explain.
    const notListed = servedSet === null
      ? []
      : models.filter((model) => !servedSet.has(model.id) && probes[model.id]?.verdict !== "dead");
    // The panel polls this while the round runs: a progress pill ("4/10") and
    // one badge per row (ok with latency / failed / probing / waiting). It is
    // replaced wholesale at the start of every round and frozen when the round
    // ends, so a late poll never shows a previous round's leftovers as live.
    probeRun = {
      running: true,
      // The round's whole scope, so the panel can tell "queued" from "skipped".
      targets: [...targets, ...notListed].map((model) => model.id),
      total: targets.length + notListed.length,
      done: 0,
      current: null,
      results: {},
      startedAt: stamp,
    };
    let untrusted = false;
    for (const model of notListed) {
      // At zero cost, with the reason that is actually known: Zen does not list
      // it. This is what lets the panel say so rather than leave a gap.
      probeRun.results[model.id] = { status: "failed", ms: 0, code: "not-listed", http: 0, removed: true };
      probeRun.done += 1;
    }
    try {
      for (const model of targets) {
        probeRun.current = model.id;
        const started = now();
        let outcome: ProbeResult;
        try {
          outcome = await probe!(model);
        } catch {
          untrusted = true;
          probeRun.results[model.id] = { status: "failed", ms: Math.max(0, now() - started), code: "error", http: 0 };
          probeRun.done += 1;
          continue;
        }
        // The row badge reports whether the model ANSWERED, not what the
        // verdict was: `dead` removes the model from the list, but from this
        // round's point of view it is still "did not answer usably". Only
        // `ok` earns the green badge; everything else is red — and red carries
        // WHY, because a red badge with no reason is not a report.
        const elapsed = Math.max(0, now() - started);
        if (outcome !== undefined && outcome !== null && outcome.kind === "ok") {
          probeRun.results[model.id] = { status: "ok", ms: elapsed };
        } else {
          // A prober that predates the coded outcome still gets a reason: the
          // verdict itself is the coarse fallback, never a silent failure.
          const code = typeof outcome?.code === "string" && outcome.code !== ""
            ? outcome.code
            : outcome?.kind === "dead" ? "dead" : "unknown";
          probeRun.results[model.id] = {
            status: "failed",
            ms: elapsed,
            code,
            http: typeof outcome?.http === "number" && isFinite(outcome.http) ? outcome.http : 0,
            // Read BEFORE the verdict is written below, while it is still the
            // pre-round one: a model already judged `dead` left the list in an
            // earlier round, so re-asking it and re-confirming the answer
            // removes nothing. Reporting that as a removal invents a change the
            // round did not make — which is the difference between "this round
            // took a model away" and "this round agreed with an old verdict".
            ...(code === "dead" ? { removed: probes[model.id]?.verdict !== "dead" } : {}),
            // Which gate marker the body carried, so the refusal names itself
            // instead of arriving as one anonymous "未测到".
            ...(typeof outcome?.marker === "string" && outcome.marker !== "" ? { marker: outcome.marker } : {}),
          };
        }
        probeRun.done += 1;
        if (outcome === undefined || outcome === null || outcome.kind === "inconclusive") {
          untrusted = true;
          continue;
        }
        if (outcome.kind !== "ok" && outcome.kind !== "dead") {
          untrusted = true;
          continue;
        }
        probes[model.id] = {
          verdict: outcome.kind,
          at: stamp,
          ...(typeof outcome.reason === "string" && outcome.reason !== "" ? { reason: outcome.reason } : {}),
          // Reaching here means the prober exhausted every channel before
          // concluding, so this `dead` is earned and can be final.
          ...(outcome.kind === "dead" ? { swept: true } : {}),
        };
      }
    } finally {
      probeRun.running = false;
      probeRun.current = null;
    }
    // The round marker is written even when nothing concluded: it is the only
    // thing that stops a fully-gated day from re-probing on every single read.
    lastProbeAt = stamp;
    probeUntrusted = untrusted;
    // One atomic write per round, never per model: a half-finished round must
    // not be read back as a complete set of verdicts.
    if (cache !== null) {
      await writeCacheAtomic(path, {
        etag: cache.etag,
        fetchedAt: cache.fetchedAt,
        models: cache.models,
        probes,
        lastProbeAt,
        // The report, so the panel's progress area survives a restart.
        lastRound: {
          total: probeRun.total,
          done: probeRun.done,
          results: probeRun.results,
          targets: probeRun.targets,
        },
      });
    }
  };

  const runProbeSingle = (): Promise<void> => {
    if (probeInflight !== null) return probeInflight;
    probeInflight = runProbeRound().finally(() => {
      probeInflight = null;
    });
    return probeInflight;
  };

  return {
    current(): CatalogSnapshot {
      // One pass over the single effective list feeds both `visible` and
      // `capabilities`, so the ids and the cards can never disagree.
      const effective = effectiveList();
      return {
        models: models.slice(),
        visible: effective.map((model) => model.id),
        capabilities: effective.map(modelCapability),
        source,
        updatedAt,
        refreshing: inflight !== null,
        probedAt: lastProbeAt,
        probeInconclusive: probeUntrusted,
      };
    },
    effectiveModels(): Model<Api>[] {
      return effectiveList();
    },
    async ensureFresh(): Promise<void> {
      if (inflight !== null) return inflight;
      if (!stale()) return;
      return runSingle();
    },
    async forceRefresh(): Promise<void> {
      return runSingle();
    },
    async runProbes(): Promise<void> {
      if (probe === undefined) return;
      if (probeInflight !== null) return probeInflight;
      if (probedToday()) return;
      return runProbeSingle();
    },
    async forceProbes(): Promise<void> {
      if (probe === undefined) return;
      return runProbeSingle();
    },
    probeProgress(): ProbeProgress {
      // A copy: the round mutates `probeRun` while the panel reads this.
      return {
        running: probeRun.running,
        total: probeRun.total,
        done: probeRun.done,
        current: probeRun.current,
        results: { ...probeRun.results },
        targets: probeRun.targets.slice(),
        startedAt: probeRun.startedAt,
      };
    },
    applyZenGate(ids: readonly string[] | null): void {
      if (ids === null) return; // Zen failed: keep whatever gate is in force
      zenIds = new Set(ids);
    },
  };
}
