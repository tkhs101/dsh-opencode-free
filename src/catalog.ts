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
  /** Free AND active — the pre-Zen-gate catalogue. */
  readonly candidates: Model<Api>[];
  /** Free but not active, sorted for a stable panel rendering. */
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

/** Pure: models.dev models dictionary → pre-gate catalogue + retired ids. */
export function derive(section: CatalogRecord, options: DeriveOptions): DerivedCatalog {
  const candidates: Model<Api>[] = [];
  const excluded: string[] = [];
  for (const [key, value] of Object.entries(section)) {
    if (!isPlainObject(value)) continue;
    const id = typeof value.id === "string" && value.id !== "" ? value.id : key;
    if (id === "") continue;
    const record: CatalogRecord = { ...value, id };
    if (!isFree(record)) continue;
    if (!isActive(record)) {
      excluded.push(id);
      continue;
    }
    candidates.push(buildModel(record, options.template, options.knownApis));
  }
  excluded.sort();
  return { candidates, excluded };
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
    };
  } catch {
    return null;
  }
}

/** Temp file + rename, so a crash mid-write can never leave a torn cache. */
export async function writeCacheAtomic(
  path: string,
  record: { etag: string | undefined; fetchedAt: number; models: CatalogRecord },
): Promise<boolean> {
  const temporary = `${path}.${process.pid}.tmp`;
  try {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(
      temporary,
      JSON.stringify({ version: CACHE_VERSION, etag: record.etag, fetchedAt: record.fetchedAt, models: record.models }),
      "utf8",
    );
    await rename(temporary, path);
    return true;
  } catch {
    // A cache we cannot persist is a performance loss, never a failure.
    return false;
  }
}

export interface CatalogSnapshot {
  /** Pre-Zen-gate catalogue (what `refreshModels` intersects). */
  readonly models: Model<Api>[];
  /** Post-gate ids: exactly what the picker offers. */
  readonly visible: readonly string[];
  /** Free but not offered: deprecated, or absent from Zen's list. */
  readonly excluded: readonly string[];
  readonly source: CatalogSource;
  readonly updatedAt: number;
  readonly refreshing: boolean;
}

export interface CreateCatalogOptions {
  /** Identity + fallback field source; an already identity-mapped record. */
  readonly template: Model<Api>;
  /** D8 offline floor: the pi-ai builtin free set, used until a sync lands. */
  readonly builtinBaseline: Model<Api>[];
  readonly knownApis?: ReadonlyMap<string, Api>;
  readonly cachePath: string;
  readonly fetchImpl: FetchLike;
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
  /** `null` means Zen failed: keep the current gate rather than narrowing. */
  applyZenGate(ids: readonly string[] | null): void;
}

export function createCatalog(options: CreateCatalogOptions): Catalog {
  const { template, builtinBaseline, knownApis, cachePath: path, fetchImpl, ttlMs = DEFAULT_TTL_MS } = options;
  const now = options.now ?? Date.now;
  const userAgent = options.userAgent;

  let cache: CatalogCacheRecord | null = null;
  let models: Model<Api>[] = builtinBaseline.slice();
  let retired: string[] = [];
  let source: CatalogSource = "builtin-fallback";
  let updatedAt = 0;
  let zenIds: ReadonlySet<string> | null = null;
  let inflight: Promise<void> | null = null;

  // Warm start: a valid cache restores the catalogue without any network.
  const adopt = (record: CatalogCacheRecord): void => {
    const derived = derive(record.models, { knownApis, template });
    models = derived.candidates;
    retired = derived.excluded;
    source = "models.dev";
    updatedAt = record.fetchedAt;
  };

  const warmStart = (): void => {
    void readCache(path).then((found) => {
      if (found === null) return;
      cache = found;
      // Adopted whatever its age: a stale cache is still a far better answer
      // than the offline floor, and `ensureFresh` revalidates on the first read
      // in the background rather than making the user wait for 5.2MB.
      adopt(found);
    });
  };
  warmStart();

  const stale = (): boolean => now() - updatedAt > ttlMs;

  const effectiveExcluded = (): string[] => {
    const excluded = new Set(retired);
    if (zenIds !== null) for (const model of models) if (!zenIds.has(model.id)) excluded.add(model.id);
    return [...excluded].sort();
  };

  const effectiveVisible = (): string[] => {
    if (zenIds === null) return models.map((model) => model.id);
    return models.filter((model) => zenIds!.has(model.id)).map((model) => model.id);
  };

  const sync = async (): Promise<void> => {
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
        await writeCacheAtomic(path, { etag: cache.etag, fetchedAt: stamp, models: cache.models });
      }
      return;
    }
    // Retain the etag: without this every revalidation would be a full
    // 5.2MB download instead of a conditional request.
    cache = { version: CACHE_VERSION, etag: result.etag, fetchedAt: stamp, models: result.section };
    adopt(cache);
    await writeCacheAtomic(path, { etag: result.etag, fetchedAt: stamp, models: result.section });
  };

  const runSingle = (): Promise<void> => {
    if (inflight !== null) return inflight;
    inflight = sync().finally(() => {
      inflight = null;
    });
    return inflight;
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
      };
    },
    effectiveModels(): Model<Api>[] {
      if (zenIds === null) return models.slice();
      return models.filter((model) => zenIds!.has(model.id));
    },
    async ensureFresh(): Promise<void> {
      if (inflight !== null) return inflight;
      if (!stale()) return;
      return runSingle();
    },
    async forceRefresh(): Promise<void> {
      return runSingle();
    },
    applyZenGate(ids: readonly string[] | null): void {
      if (ids === null) return; // Zen failed: keep whatever gate is in force
      zenIds = new Set(ids);
    },
  };
}
