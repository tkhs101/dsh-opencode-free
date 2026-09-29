/**
 * dsh-opencode-free — browser half (hand-written ModuleLoader bundle, no build step).
 *
 * ONE job: the card on this plugin's detail page (the plugins.bundle.config
 * seat, keyed by the package name) that toggles per-model visibility. Each
 * row flips one model id in this plugin's row Config form field
 * `hiddenModels`; the host filters those ids out of the model picker.
 *
 * The model list itself is NOT baked in here: the host owns the catalogue
 * (models.dev + the Zen availability gate + the live availability probe) and
 * serves it, so the rows always match what the picker can actually select. This
 * half reads that snapshot, writes `hiddenModels`, and offers the manual probe
 * that makes the host re-ask every model whether it still answers.
 *
 * Hand-written bundle rules (same shape as dsh-gitbash-shell):
 *   - ONE window.__ModuleLoader__.load({...}) call, id = package name;
 *   - require restricted to the client-module BASELINE whitelist
 *     (react and @deepseek-ai/dsh-client-ui-primitives only);
 *   - plain React.createElement, no JSX/TS; components at module level;
 *   - configForms is acquired lazily: a missing face must not take the card
 *     down with it;
 *   - copy ships zh/en inline (model ids are never translated); the lookup is
 *     live so a language switch repaints without a reload.
 */
window.__ModuleLoader__.load({
	id: "dsh-opencode-free",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		var React = require("react");
		var ui = require("@deepseek-ai/dsh-client-ui-primitives");

		var E = React.createElement;
		var useState = React.useState;
		var useEffect = React.useEffect;

		var TAG = "[opencode-free/client]";
		/** Dictionary namespace (this plugin's own t seat). */
		var NS = "opencodeFree";
		/** The settings namespace the HOST half serves (row id = plugin name). */
		var SETTINGS_NAMESPACE = "opencode-free";
		/** The Plugins page bundle-config seat key (package name). */
		var SLOT_KEY = "dsh-opencode-free";

		/**
		 * The host's catalogue endpoints. ABSOLUTE paths on purpose: this card
		 * renders under a client-side route, so a relative specifier would
		 * resolve against the route instead of the server root.
		 */
		var CATALOG_URL = "/dsh-opencode-free/api/catalog";
		var REFRESH_URL = "/dsh-opencode-free/api/refresh";
		var PROBE_URL = "/dsh-opencode-free/api/probe";

		// ── dictionaries (zh/en inline; model ids are never translated) ──────
		//
		// zh and en MUST carry the exact same key set: a key present in only one
		// falls back to the other at lookup time and reads as a half-translated
		// card.

		var zh = {
			"title": "模型显示",
			"cardDesc": "选择在模型选择器中显示的模型",
			"row.visible": "显示",
			"row.hidden": "已隐藏",
			"hint": "隐藏后，该模型不会出现在模型选择器中；重新打开即可恢复。",
			"error": "写入失败",
			"loading": "正在读取模型目录…",
			"loadFailed": "读取模型目录失败，宿主暂时没有回应。",
			"fallback": "当前显示的是内置兜底目录，尚未与 models.dev 同步。",
			"refresh": "立即刷新",
			"refreshing": "刷新中…",
			"probe": "立即探测",
			"probing": "探测中…",
			"probeFailed": "探测请求失败，模型显示保持不变，可重试。",
			"probeUntrusted": "本轮探测结论不可信（上游限流、匿名额度被闸或网络异常），模型显示保持不变。",
			"probedAt": "上次探测",
			"empty": "当前没有可显示的模型。"
		};

		var en = {
			"title": "Model visibility",
			"cardDesc": "Choose which models appear in the model picker",
			"row.visible": "Shown",
			"row.hidden": "Hidden",
			"hint": "Hidden models disappear from the model picker; turn them back on to restore.",
			"error": "Write failed",
			"loading": "Loading the model catalogue…",
			"loadFailed": "Could not load the model catalogue — the host did not answer.",
			"fallback": "Showing the built-in fallback catalogue; it is not synced with models.dev yet.",
			"refresh": "Refresh now",
			"refreshing": "Refreshing…",
			"probe": "Probe now",
			"probing": "Probing…",
			"probeFailed": "The probe request failed; visibility is unchanged. You can retry.",
			"probeUntrusted": "This round's probe results were untrustworthy (upstream throttling, the anonymous tier refusing, or a network error), so visibility is unchanged.",
			"probedAt": "Last probe",
			"empty": "No models are available right now."
		};

		// ── locale resolution (live: read per lookup) ─────────────────────────

		function hasOwnKey(bag, key) {
			return Object.prototype.hasOwnProperty.call(bag, key);
		}

		function dictionaryFor(active) {
			var raw = active === undefined || active === null || active === "" ? "en" : String(active);
			var tag = raw.toLowerCase().replace(/_/g, "-");
			if (tag.split("-")[0] === "zh") return zh;
			return en;
		}

		function activeLocaleOf(ctx) {
			var active = "";
			try {
				var locale = ctx.get("locale");
				if (locale !== undefined && typeof locale.getSnapshot === "function") {
					var snapshot = locale.getSnapshot();
					if (snapshot !== null && typeof snapshot === "object" && typeof snapshot.active === "string") active = snapshot.active;
				}
			} catch (error) { /* fall through to the browser */ }
			if (active === "" && typeof navigator === "object" && navigator !== null && typeof navigator.language === "string") active = navigator.language;
			return active;
		}

		function translatorOf(ctx) {
			var cachedTag = null;
			var cachedDict = null;
			return function (key) {
				var tag = activeLocaleOf(ctx);
				if (tag !== cachedTag) { cachedTag = tag; cachedDict = dictionaryFor(tag); }
				if (hasOwnKey(cachedDict, key)) return cachedDict[key];
				return hasOwnKey(en, key) ? en[key] : key;
			};
		}

		// ── styles (opf- prefixed) ────────────────────────────────────────────

		var STYLE_ID = "dsh-opencode-free-style";

		var CSS = [
			".opf-card{display:flex;flex-direction:column;gap:10px;max-width:640px}",
			".opf-title{font-size:15px;font-weight:600;line-height:1.4;color:var(--dsw-alias-label-primary)}",
			".opf-desc{margin:0;font-size:13px;line-height:1.5;color:var(--dsw-alias-label-tertiary)}",
			".opf-list{display:flex;flex-direction:column;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;overflow:hidden}",
			".opf-row{display:flex;align-items:center;gap:10px;padding:8px 12px;font-size:13px;cursor:pointer;color:var(--dsw-alias-label-secondary)}",
			".opf-row+.opf-row{border-top:1px solid var(--dsw-alias-border-l2)}",
			".opf-id{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;color:var(--dsw-alias-label-primary)}",
			".opf-state{flex:none;font-size:12px;color:var(--dsw-alias-label-tertiary)}",
			".opf-row input{flex:none;margin:0;accent-color:var(--dsw-alias-brand-primary)}",
			".opf-hint{margin:0;font-size:12px;line-height:1.6;color:var(--dsw-alias-label-tertiary)}",
			".opf-error{margin:0;font-size:12px;color:var(--dsw-alias-status-danger,#e5484d)}",
			".opf-toolbar{display:flex;align-items:center;gap:10px;flex-wrap:wrap}",
			".opf-btn{font:inherit;font-size:12px;padding:4px 10px;border-radius:6px;border:1px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer}",
			".opf-btn[disabled]{opacity:.55;cursor:default}",
			".opf-note{margin:0;font-size:12px;line-height:1.6;color:var(--dsw-alias-label-tertiary)}"
		].join("\n");

		function ensureStyles() {
			try {
				if (typeof document === "undefined" || typeof document.getElementById !== "function") return function () {};
				if (document.getElementById(STYLE_ID)) return function () {};
				var style = document.createElement("style");
				style.id = STYLE_ID;
				style.textContent = CSS;
				document.head.appendChild(style);
				return function () {
					try {
						if (style.parentNode) style.parentNode.removeChild(style);
					} catch (error) { /* best effort */ }
				};
			} catch (error) {
				return function () {};
			}
		}

		/** Defensive primitives lookup: an unknown icon name degrades to null. */
		function icon(name) {
			try {
				var component = ui && ui[name];
				return typeof component === "function" ? component : null;
			} catch (error) {
				return null;
			}
		}

		// ── error boundary (the dsh-better-workspace QuietBoundary pattern) ───

		/** A render failure degrades THIS card, never the detail page. */
		function QuietBoundary(props) {}
		QuietBoundary.prototype = Object.create(React.Component.prototype);
		QuietBoundary.prototype.constructor = QuietBoundary;
		QuietBoundary.state = { failed: false };
		QuietBoundary.getDerivedStateFromError = function () { return { failed: true }; };
		QuietBoundary.prototype.componentDidCatch = function (error) {
			console.warn(TAG + " card render failed:", error && error.message ? error.message : error);
		};
		QuietBoundary.prototype.render = function () {
			if (this.state && this.state.failed) return null;
			return this.props.children;
		};

		// ── live locale (repaint the card on a language switch) ───────────────

		function LocaleLive(props) {
			var tickState = useState(0);
			var tick = tickState[0];
			var setTick = tickState[1];
			void tick;

			useEffect(function () {
				var locale = props.ctx && typeof props.ctx.get === "function" ? props.ctx.get("locale") : undefined;
				if (locale === undefined || typeof locale.subscribe !== "function") return undefined;
				var unsubscribe = locale.subscribe(function () { setTick(function (value) { return value + 1; }); });
				return typeof unsubscribe === "function" ? unsubscribe : undefined;
			}, []);

			return E(QuietBoundary, null, E(ModelsCard, Object.assign({}, props.cardProps, { t: props.t })));
		}

		// ── catalogue reads (the host owns the list; this half only reads it) ──

		/**
		 * Normalize one host snapshot. A malformed payload is a RENDERED state
		 * (the card shows a failure line), never an exception: the rows must
		 * not take the detail page down.
		 * @param payload - the endpoint's parsed JSON body.
		 * @returns a snapshot, or null when the body is not usable.
		 */
		function readSnapshot(payload) {
			if (payload === null || typeof payload !== "object") return null;
			var names = function (value) {
				if (!Array.isArray(value)) return [];
				var out = [];
				for (var i = 0; i < value.length; i++) {
					if (typeof value[i] === "string" && value[i] !== "" && out.indexOf(value[i]) === -1) out.push(value[i]);
				}
				return out;
			};
			return {
				visible: names(payload.visible),
				source: typeof payload.source === "string" ? payload.source : "unknown",
				/* Probe facts are OPTIONAL: a host older than the probe feature
				   simply omits them, and the card degrades to "never probed"
				   rather than failing to render. */
				probedAt: typeof payload.probedAt === "number" && isFinite(payload.probedAt) ? payload.probedAt : null,
				probeInconclusive: payload.probeInconclusive === true
			};
		}

		/** GET the current catalogue. Resolves null on any failure. */
		function loadCatalog() {
			if (typeof fetch !== "function") return Promise.resolve(null);
			try {
				return Promise.resolve(fetch(CATALOG_URL, { headers: { accept: "application/json" } }))
					.then(function (response) { return response && response.ok ? response.json() : null; })
					.then(readSnapshot)
					.catch(function (error) {
						console.warn(TAG + " catalogue read failed:", error && error.message ? error.message : error);
						return null;
					});
			} catch (error) {
				console.warn(TAG + " catalogue read threw:", error && error.message ? error.message : error);
				return Promise.resolve(null);
			}
		}

		/**
		 * POST a forced refresh (bypasses the host's TTL) and resolve with the
		 * snapshot the host returns, so the card repaints from the answer
		 * rather than re-reading a possibly stale list.
		 */
		function refreshCatalog() {
			if (typeof fetch !== "function") return Promise.resolve(null);
			try {
				return Promise.resolve(fetch(REFRESH_URL, { method: "POST", headers: { accept: "application/json" } }))
					.then(function (response) { return response && response.ok ? response.json() : null; })
					.then(readSnapshot)
					.catch(function (error) {
						console.warn(TAG + " catalogue refresh failed:", error && error.message ? error.message : error);
						return null;
					});
			} catch (error) {
				console.warn(TAG + " catalogue refresh threw:", error && error.message ? error.message : error);
				return Promise.resolve(null);
			}
		}

		/**
		 * POST a manual probe run (the host asks every catalogue model, in
		 * order, whether it still answers) and resolve with the snapshot it
		 * returns.
		 *
		 * Distinct from refreshCatalog() on purpose: a FAILED probe must not
		 * clobber a perfectly good list, so a null here means "no answer", not
		 * "empty catalogue". The caller keeps what it is showing.
		 */
		function probeCatalog() {
			if (typeof fetch !== "function") return Promise.resolve(null);
			try {
				return Promise.resolve(fetch(PROBE_URL, { method: "POST", headers: { accept: "application/json" } }))
					.then(function (response) { return response && response.ok ? response.json() : null; })
					.then(readSnapshot)
					.catch(function (error) {
						console.warn(TAG + " probe failed:", error && error.message ? error.message : error);
						return null;
					});
			} catch (error) {
				console.warn(TAG + " probe threw:", error && error.message ? error.message : error);
				return Promise.resolve(null);
			}
		}

		// ── models card (module-level component) ──────────────────────────────

		/**
		 * The detail-page card. t arrives from LocaleLive; scope arrives as a
		 * PLAIN prop from the inject factory. Snapshots are read per render;
		 * each write bumps a local tick so the card re-reads without an
		 * external-store hook adapter.
		 *
		 * `catalog` is tri-state on purpose: undefined = still loading, null =
		 * the host did not answer (the toolbar's refresh doubles as a retry),
		 * object = a snapshot whose `visible` rows are exactly what the picker
		 * can select.
		 */
		function ModelsCard(props) {
			var t = typeof props.t === "function" ? props.t : function (key) { return key; };
			var scope = props.scope;

			var tickState = useState(0);
			var tick = tickState[0];
			var bumpTick = tickState[1];
			void tick;

			var errorState = useState("");
			var error = errorState[0];
			var setError = errorState[1];

			var catalogState = useState(undefined);
			var catalog = catalogState[0];
			var setCatalog = catalogState[1];

			var busyState = useState(false);
			var busy = busyState[0];
			var setBusy = busyState[1];

			/* The probe keeps its OWN busy flag and its OWN error line: it is a
			   different action from a catalogue refresh, and a failed probe must
			   leave the rendered list exactly as it was. */
			var probingState = useState(false);
			var probing = probingState[0];
			var setProbing = probingState[1];

			var probeErrorState = useState("");
			var probeError = probeErrorState[0];
			var setProbeError = probeErrorState[1];

			useEffect(function () {
				if (scope === undefined || scope === null || typeof scope.subscribe !== "function") return undefined;
				var unsubscribe = scope.subscribe(function () { bumpTick(function (n) { return n + 1; }); });
				return typeof unsubscribe === "function" ? unsubscribe : undefined;
			}, []);

			useEffect(function () {
				var cancelled = false;
				loadCatalog().then(function (snapshot) { if (!cancelled) setCatalog(snapshot); });
				return function () { cancelled = true; };
			}, []);

			function refresh() {
				if (busy) return;
				setBusy(true);
				refreshCatalog().then(function (snapshot) {
					setCatalog(snapshot);
					setBusy(false);
				});
			}

			/* A null answer means the host did not answer, NOT an empty
			   catalogue: keep the rows on screen and offer the retry. */
			function probe() {
				if (probing) return;
				setProbeError("");
				setProbing(true);
				probeCatalog().then(function (snapshot) {
					if (snapshot !== null) setCatalog(snapshot);
					else setProbeError(t("probeFailed"));
					setProbing(false);
				});
			}

			var snap = { status: "unavailable" };
			try {
				if (scope && typeof scope.getSnapshot === "function") snap = scope.getSnapshot();
			} catch (error_) { /* keep unavailable */ }

			if (snap.status !== "ready") return null;

			var value = snap.value || {};
			var stored = Array.isArray(value.hiddenModels) ? value.hiddenModels : [];
			var hidden = {};
			for (var i = 0; i < stored.length; i++) {
				if (typeof stored[i] === "string" && stored[i] !== "") hidden[stored[i]] = true;
			}

			function writeHidden(next) {
				setError("");
				if (!scope || typeof scope.set !== "function") {
					setError(t("error"));
					return Promise.resolve(false);
				}
				try {
					return Promise.resolve(scope.set("hiddenModels", next)).then(
						function (accepted) {
							bumpTick(function (n) { return n + 1; });
							if (accepted !== true) setError(t("error"));
							return accepted === true;
						},
						function (err) {
							bumpTick(function (n) { return n + 1; });
							setError(t("error") + ": " + (err && err.message ? err.message : String(err)));
							return false;
						}
					);
				} catch (err) {
					bumpTick(function (n) { return n + 1; });
					setError(t("error") + ": " + (err && err.message ? err.message : String(err)));
					return Promise.resolve(false);
				}
			}

			/* Read-modify-write on the FRESH snapshot: unknown/stale ids ride
			   along untouched, so a model that returns stays hidden. */
			function toggle(id) {
				var fresh = { status: "unavailable" };
				try {
					if (scope && typeof scope.getSnapshot === "function") fresh = scope.getSnapshot();
				} catch (error_) { /* fall through to the rendered snapshot */ }
				var base = (fresh.status === "ready" && fresh.value && Array.isArray(fresh.value.hiddenModels))
					? fresh.value.hiddenModels
					: stored;
				var seen = {};
				var next = [];
				for (var k = 0; k < base.length; k++) {
					var entry = typeof base[k] === "string" ? base[k].trim() : "";
					if (entry === "" || entry === id || hasOwnKey(seen, entry)) continue;
					seen[entry] = true;
					next.push(entry);
				}
				if (!hasOwnKey(hidden, id)) {
					next.push(id);
					seen[id] = true;
				}
				return writeHidden(next);
			}

			var Chevron = icon("IconChevronDownOutline14");
			void Chevron;

			var visible = catalog !== undefined && catalog !== null ? catalog.visible : [];

			var rows = visible.map(function (id) {
				var shown = !hasOwnKey(hidden, id);
				return E("label",
					{ key: id, className: "opf-row" },
					E("span", { className: "opf-id" }, id),
					E("input", {
						type: "checkbox",
						checked: shown,
						onChange: function () { toggle(id); }
					}),
					E("span", { className: "opf-state" }, shown ? t("row.visible") : t("row.hidden")));
			});

			/* The list area has three honest states; none of them pretends the
			   catalogue is empty when it is merely unknown. */
			var listArea;
			if (catalog === undefined) {
				listArea = E("p", { className: "opf-note" }, t("loading"));
			} else if (catalog === null) {
				listArea = E("p", { className: "opf-error" }, t("loadFailed"));
			} else if (rows.length === 0) {
				listArea = E("p", { className: "opf-note" }, t("empty"));
			} else {
				listArea = E("div", { className: "opf-list" }, rows);
			}

			var fallbackNote = catalog !== undefined && catalog !== null && catalog.source === "builtin-fallback"
				? E("p", { className: "opf-note" }, t("fallback"))
				: null;

			/* Probe facts, each rendered only when the host actually reported
			   one. An older host omits them, and then none of this shows. */
			var untrustedNote = catalog !== undefined && catalog !== null && catalog.probeInconclusive === true
				? E("p", { className: "opf-note" }, t("probeUntrusted"))
				: null;

			var probedAtNote = null;
			if (catalog !== undefined && catalog !== null && typeof catalog.probedAt === "number") {
				var when = new Date(catalog.probedAt);
				if (!isNaN(when.getTime())) {
					var stamp = typeof when.toLocaleString === "function" ? when.toLocaleString() : String(catalog.probedAt);
					probedAtNote = E("p", { className: "opf-note" }, t("probedAt") + " " + stamp);
				}
			}

			return E("div",
				{ className: "opf-card" },
				E("div", { className: "opf-title" }, t("title")),
				E("p", { className: "opf-desc" }, t("cardDesc")),
				E("div", { className: "opf-toolbar" },
					E("button", {
						type: "button",
						className: "opf-btn",
						disabled: busy,
						onClick: refresh
					}, busy ? t("refreshing") : t("refresh")),
					E("button", {
						type: "button",
						className: "opf-btn",
						disabled: probing,
						onClick: probe
					}, probing ? t("probing") : t("probe"))),
				fallbackNote,
				probedAtNote,
				untrustedNote,
				listArea,
				error ? E("p", { className: "opf-error" }, error) : null,
				probeError ? E("p", { className: "opf-error" }, probeError) : null,
				E("p", { className: "opf-hint" }, t("hint")));
		}

		// ── plugin ────────────────────────────────────────────────────────────

		exports.name = "dsh-opencode-free/client";

		/**
		 * Required client services: only era-guaranteed ones are hard-injected;
		 * the settings face is acquired OPTIONALLY (a missing configForms on a
		 * stripped-down host must not take the card down with it).
		 */
		exports.inject = ["locale", "slots"];

		exports.apply = function (ctx) {
			// The settings face: one ConfigForm per live profile entry; the form
			// key is the row id "opencode-free" (contract: getSnapshot/set/subscribe).
			var scope = null;

			try {
				ctx.inject(["configForms"], function (fctx) {
					try {
						var forms = fctx && fctx.configForms;
						if (forms && typeof forms.get === "function") scope = forms.get(SETTINGS_NAMESPACE);
					} catch (error) {
						console.warn(TAG + " configForms acquisition failed:", error && error.message ? error.message : error);
					}
				});
			} catch (error) {
				console.warn(TAG + " configForms wiring failed:", error && error.message ? error.message : error);
			}
			/* The card's only copy entry point: a live lookup, never a captured
			   dictionary — the language preference switches without a reload. */
			var t = translatorOf(ctx);

			ctx.effect(function () {
				var disposers = [ensureStyles()];
				try {
					if (ctx.locale && typeof ctx.locale.register === "function") {
						var disposeDict = ctx.locale.register(NS, { zh: zh, en: en });
						if (typeof disposeDict === "function") disposers.push(disposeDict);
					}
				} catch (error) {
					console.warn(TAG + " dictionary registration failed:", error && error.message ? error.message : error);
				}
				return function () {
					for (var i = 0; i < disposers.length; i++) {
						try {
							if (typeof disposers[i] === "function") disposers[i]();
						} catch (error) { /* best effort */ }
					}
				};
			}, "dsh-opencode-free: styles, dictionaries");

			// Guarded registration: a thrown register degrades this one seat,
			// never the plugin fiber.
			try {
				var slots = ctx.slots;
				if (!slots || typeof slots.inject !== "function") {
					console.warn(TAG + " slots service unavailable; settings card idle");
					return;
				}
				var injected = function () {
					// The inject factory's returned members become the component's
					// props: the bound settings scope AND the ctx ride here as
					// PLAIN members (top-level options fields do NOT reach it).
					return { scope: scope, ctx: ctx };
				};
				// The detail page's bundle configuration seat, keyed by the
				// PACKAGE name. Each inject waits for its own slot declaration.
				slots.inject("plugins.bundle.config", function () {
					return slots.register({
						name: "plugins.bundle.config",
						key: SLOT_KEY,
						locale: NS,
						inject: injected
					}, function BundleConfigWithBoundary(props) {
						return E(LocaleLive, { ctx: ctx, t: t, cardProps: props });
					});
				});
			} catch (error) {
				console.warn(TAG + " settings card registration failed:", error && error.message ? error.message : error);
			}
		};

		return module.exports;
	}
});
