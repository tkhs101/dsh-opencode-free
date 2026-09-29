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
  /**
   * Always empty. Derivation no longer retires anything (D1 keeps deprecated
   * models so a probe can judge them), and the panel's `excluded` list is now
   * a probe verdict rather than a derivation output. Retained so the result
   * shape stays stable for callers and fixtures.
   */
  readonly excluded: string[];
}

/**
 * Map one models.dev record onto a pi-ai model. `template` supplies identity
 * and every field models.dev does not publish. A record whose fields have the
 * wrong type falls back per-field rather than failing the whole catalogue.
 */
function buildModel(record: CatalogRecord, template: Model<Api>, knownApis?: ReadonlyMap<string, Api>): Model<Api> {
  const id = typeof record.id === "string" && record.id !== "" ? record.id : "";
  const api = channelFor(record, knownApis);
  const limit = isPlainObject(record.limit) ? record.limit : {};
  const modalities = isPlainObject(record.modalities) ? record.modalities : {};
  const declaredInput = Array.isArray(modalities.input)
    ? modalities.input.filter((entry): entry is "text" | "image" => entry === "text" || entry === "image")
    : [];
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
    // `compat` is transport-specific. Carrying the template's completions
    // overrides onto a responses model would misconfigure it, so a channel
    // change drops them and lets pi-ai auto-detect from baseUrl.
    compat: (api === template.api ? template.compat : undefined) as Model<Api>["compat"],
  };
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
  return { candidates, excluded: [] };
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
}

/** A conclusive verdict. `inconclusive` is deliberately NOT one of them. */
export type ProbeVerdict = "ok" | "dead";

export interface ProbeRecord {
  readonly verdict: ProbeVerdict;
  readonly at: number;
  readonly reason?: string;
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
    };
  } catch {
    return null;
  }
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
  /** Post-gate ids: exactly what the picker offers. */
  readonly visible: readonly string[];
  /** Models a probe judged unusable (`dead`). */
  readonly excluded: readonly string[];
  readonly source: CatalogSource;
  readonly updatedAt: number;
  readonly refreshing: boolean;
  /** When the last probe round ran; 0 means never. */
  readonly probedAt?: number;
  /** The last round reached no conclusion (gated, quota, bad key, network). */
  readonly probeInconclusive?: boolean;
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
}

export function createCatalog(options: CreateCatalogOptions): Catalog {
  const { template, builtinBaseline, knownApis, cachePath: path, fetchImpl, ttlMs = DEFAULT_TTL_MS } = options;
  const now = options.now ?? Date.now;
  const userAgent = options.userAgent;
  const probe = options.probe;

  let cache: CatalogCacheRecord | null = null;
  let models: Model<Api>[] = builtinBaseline.slice();
  let source: CatalogSource = "builtin-fallback";
  let updatedAt = 0;
  let zenIds: ReadonlySet<string> | null = null;
  let inflight: Promise<void> | null = null;
  let probes: ProbeMap = {};
  let lastProbeAt = 0;
  let probeUntrusted = false;
  let probeInflight: Promise<void> | null = null;

  // Warm start: a valid cache restores the catalogue without any network.
  const adopt = (record: CatalogCacheRecord): void => {
    const derived = derive(record.models, { knownApis, template });
    models = derived.candidates;
    source = "models.dev";
    updatedAt = record.fetchedAt;
    if (Object.keys(record.probes).length > 0) probes = { ...record.probes };
    if (record.lastProbeAt > lastProbeAt) lastProbeAt = record.lastProbeAt;
    // Verdicts for models the catalogue no longer carries would otherwise sit
    // in `excluded` forever, since a vanished model is never probed again.
    // Dropping them is safe: a returning model starts unprobed, i.e. visible,
    // and the next round judges it on evidence.
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
   * Zen's gate, minus everything a probe judged dead. Probing only ever
   * REMOVES (D6d) — it can never add a model back into view.
   */
  const effectiveList = (): Model<Api>[] => {
    const gated = zenIds === null ? models : models.filter((model) => zenIds!.has(model.id));
    return gated.filter((model) => probes[model.id]?.verdict !== "dead");
  };

  const effectiveExcluded = (): string[] => {
    const present = new Set(models.map((model) => model.id));
    return Object.keys(probes)
      .filter((id) => probes[id].verdict === "dead" && present.has(id))
      .sort();
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
   * D2/D6b: one ordered round over the whole pre-gate catalogue.
   *
   * Sequential `for…await` on purpose (no concurrency, no batching): the round
   * spends a shared anonymous-quota bucket, and firing 30+ requests at once
   * would both exhaust it faster and hammer upstream.
   *
   * Only conclusive verdicts are recorded. An `inconclusive` — or a prober that
   * rejects — leaves the model exactly as it was (D5): one gated IP must never
   * empty the picker.
   */
  const runProbeRound = async (): Promise<void> => {
    const stamp = now();
    const targets = models.slice();
    let untrusted = false;
    for (const model of targets) {
      let outcome: ProbeResult;
      try {
        outcome = await probe!(model);
      } catch {
        untrusted = true;
        continue;
      }
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
      };
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
      return {
        models: models.slice(),
        visible: effectiveVisible(),
        excluded: effectiveExcluded(),
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
    applyZenGate(ids: readonly string[] | null): void {
      if (ids === null) return; // Zen failed: keep whatever gate is in force
      zenIds = new Set(ids);
    },
  };
}
