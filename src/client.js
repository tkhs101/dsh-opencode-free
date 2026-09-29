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
			"probing.now": "正在探测",
			"probing.waiting": "等待中",
			"probing.failed": "探测失败",
			"badge.vision": "视觉",
			"badge.thinking": "思考",
			"legend.vision": "多模态视觉",
			"legend.thinking": "思考推理",
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
			"probing.now": "Probing",
			"probing.waiting": "Waiting",
			"probing.failed": "Failed",
			"badge.vision": "Vision",
			"badge.thinking": "Thinking",
			"legend.vision": "Multimodal vision",
			"legend.thinking": "Reasoning",
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
		//
		// Apple-card look from the approved mock: literal palette, self-contained
		// white card so it reads the same on any host theme. Class names stay
		// opf- namespaced so they cannot collide with the host page.

		var STYLE_ID = "dsh-opencode-free-style";

		var CSS = [
			".opf-card{display:flex;flex-direction:column;max-width:720px;background:#FFFFFF;border:1px solid rgba(229,229,234,.8);border-radius:16px;box-shadow:0 12px 40px rgba(0,0,0,.06),0 1px 3px rgba(0,0,0,.04);overflow:hidden;font-family:-apple-system,BlinkMacSystemFont,'SF Pro Text','PingFang SC','Hiragino Sans GB','Microsoft YaHei',sans-serif;-webkit-font-smoothing:antialiased}",
			".opf-head{padding:28px 28px 20px}",
			".opf-title{font-size:22px;font-weight:600;letter-spacing:-.01em;line-height:1.3;color:#1D1D1F}",
			".opf-desc{margin:4px 0 20px;font-size:13px;line-height:1.5;color:#86868B}",
			".opf-toolbar{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap}",
			".opf-actions{display:flex;align-items:center;gap:10px}",
			".opf-btn{display:inline-flex;align-items:center;gap:6px;font:inherit;font-size:13px;font-weight:500;padding:6px 14px;border-radius:8px;border:1px solid #E5E5EA;background:#F5F5F7;color:#1D1D1F;cursor:pointer;box-shadow:0 1px 2px rgba(0,0,0,.04);transition:background-color .15s ease-out}",
			".opf-btn:hover{background:#EBEBEF}",
			".opf-btn:active{background:#E2E2E6}",
			".opf-btn[disabled]{opacity:.55;cursor:default}",
			".opf-btn svg{width:14px;height:14px;color:#515154;flex:none}",
			".opf-stamp{display:flex;align-items:center;gap:6px;margin:0;font-size:12px;line-height:1.5;color:#86868B}",
			".opf-dot{display:inline-block;width:6px;height:6px;border-radius:50%;background:#34C759;flex:none}",
			".opf-body{padding:8px 28px}",
			".opf-list{display:flex;flex-direction:column;border:1px solid #E5E5EA;border-radius:12px;overflow:hidden;background:#FFFFFF;box-shadow:0 1px 2px rgba(0,0,0,.02)}",
			".opf-row{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:14px 16px;font-size:13px;cursor:pointer;color:#1D1D1F}",
			".opf-row+.opf-row{border-top:1px solid rgba(229,229,234,.7)}",
			".opf-row:hover{background:#F9F9FB}",
			".opf-main{display:flex;align-items:center;gap:8px;flex-wrap:wrap;min-width:0;padding-right:12px}",
			".opf-id{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:'SF Mono',Monaco,Menlo,Consolas,'Liberation Mono','Courier New',monospace;font-size:13px;font-weight:500;letter-spacing:-.01em;color:#1D1D1F}",
			".opf-badge{display:inline-flex;align-items:center;gap:4px;padding:2px 8px;border-radius:9999px;font-size:11px;font-weight:500;line-height:1.6;white-space:nowrap;user-select:none}",
			".opf-badge svg{width:12px;height:12px;flex:none}",
			".opf-badge-vision{background:rgba(48,176,199,.10);color:#008397;border:1px solid rgba(48,176,199,.25)}",
			".opf-badge-think{background:rgba(255,69,58,.08);color:#E0382E;border:1px solid rgba(255,69,58,.20)}",
			".opf-badge-think svg{width:10px;height:10px}",
			".opf-side{display:flex;align-items:center;gap:12px;flex:none}",
			".opf-state{font-size:13px;color:#86868B;user-select:none}",
			".opf-state.on{color:#1D1D1F;font-weight:500}",
			".opf-switch{position:relative;display:inline-flex;align-items:center;cursor:pointer;user-select:none}",
			".opf-switch input{position:absolute;opacity:0;width:0;height:0}",
			".opf-track{width:44px;height:26px;background:#E9E9EA;border-radius:9999px;transition:background-color .28s cubic-bezier(.4,0,.2,1);position:relative}",
			".opf-thumb{position:absolute;top:2px;left:2px;width:22px;height:22px;background:#FFFFFF;border-radius:50%;box-shadow:0 1.5px 3px rgba(0,0,0,.15),0 1px 1px rgba(0,0,0,.06);transition:transform .28s cubic-bezier(.4,0,.2,1)}",
			".opf-switch input:checked+.opf-track{background:#34C759}",
			".opf-switch input:checked+.opf-track .opf-thumb{transform:translateX(18px)}",
			".opf-foot{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;padding:12px 28px 24px}",
			".opf-hint{margin:0;font-size:12px;line-height:1.6;color:#86868B}",
			".opf-legend{display:flex;align-items:center;gap:10px;flex:none}",
			".opf-note{margin:0;font-size:12px;line-height:1.6;color:#86868B}",
			".opf-error{margin:0;font-size:12px;color:#E0382E}",
			"@keyframes opf-spin{to{transform:rotate(360deg)}}",
			"@keyframes opf-ping{0%{transform:scale(1);opacity:.75}80%,100%{transform:scale(2.4);opacity:0}}",
			".opf-spin{animation:opf-spin 1s linear infinite}",
			".opf-btn-probing{color:#0071E3 !important;background:rgba(0,113,227,.10) !important;border-color:rgba(0,113,227,.30) !important}",
			".opf-btn-probing svg{color:#0071E3 !important}",
			".opf-capsule{display:inline-flex;align-items:center;gap:8px;background:#F5F5F7;border:1px solid #E5E5EA;border-radius:9999px;padding:4px 12px;font-size:12px;box-shadow:0 1px 2px rgba(0,0,0,.04);white-space:nowrap}",
			".opf-pingwrap{position:relative;display:inline-flex;width:8px;height:8px;flex:none}",
			".opf-pingring{position:absolute;display:inline-flex;width:100%;height:100%;border-radius:50%;background:#0071E3;animation:opf-ping 1.4s cubic-bezier(0,0,.2,1) infinite}",
			".opf-pingdot{position:relative;display:inline-flex;width:8px;height:8px;border-radius:50%;background:#0071E3}",
			".opf-capsulelabel{color:#1D1D1F;font-weight:500}",
			".opf-count{font-family:'SF Mono',Monaco,Menlo,Consolas,monospace;font-size:11px;color:#0071E3}",
			".opf-bar{width:56px;height:6px;background:#E5E5EA;border-radius:9999px;overflow:hidden;flex:none}",
			".opf-fill{height:100%;background:#0071E3;border-radius:9999px;transition:width .3s ease-out}",
			".opf-probe{display:inline-flex;align-items:center;gap:6px;padding:4px 10px;border-radius:9999px;font-size:12px;font-weight:500;line-height:1.6;white-space:nowrap;user-select:none}",
			".opf-probe svg{width:14px;height:14px;flex:none}",
			".opf-probe-ms{font-family:'SF Mono',Monaco,Menlo,Consolas,monospace;font-size:11px}",
			".opf-probe-ok{background:rgba(52,199,89,.10);color:#28A745}",
			".opf-probe-fail{background:rgba(255,59,48,.10);color:#FF3B30}",
			".opf-probe-busy{background:rgba(0,113,227,.10);color:#0071E3}",
			".opf-probe-wait{background:rgba(229,229,234,.50);color:#86868B}",
			".opf-waitdot{display:inline-block;width:6px;height:6px;border-radius:50%;background:#C7C7CC;flex:none}",
			".opf-row-probing{background:rgba(0,113,227,.02)}",
			".opf-row-probing:hover{background:rgba(0,113,227,.04)}",
			".opf-row-waiting{opacity:.8}"
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

		// ── inline artwork (the mock's own icons, hand-copied) ────────────────
		//
		// The host's icon set has no refresh/magnifier/eye/star that match the
		// approved mock, and the client bundle may only require react plus the
		// ui primitives — so the four glyphs ship here as static SVG. They use
		// currentColor throughout and inherit their size from CSS.

		function svgIcon(paths, strokeWidth) {
			var attrs = strokeWidth === 0
				? { fill: "currentColor", viewBox: "0 0 24 24", "aria-hidden": "true" }
				: {
					fill: "none",
					stroke: "currentColor",
					strokeWidth: strokeWidth,
					viewBox: "0 0 24 24",
					"aria-hidden": "true",
				};
			return E.apply(null, ["svg", attrs].concat(paths.map(function (d) {
				return E("path", {
					key: d.slice(0, 24),
					d: d,
					strokeLinecap: "round",
					strokeLinejoin: "round",
				});
			})));
		}

		var ICON_REFRESH = "M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0l3.181 3.183a8.25 8.25 0 0013.803-3.7M4.031 9.865a8.25 8.25 0 0113.803-3.7l3.181 3.182m0-4.991v4.99";
		var ICON_SEARCH = "M21 21l-5.197-5.197m0 0A7.5 7.5 0 105.196 5.196a7.5 7.5 0 0010.607 10.607z";
		var ICON_EYE_OUTLINE = "M2.036 12.322a1.012 1.012 0 010-.639C3.423 7.51 7.36 4.5 12 4.5c4.638 0 8.573 3.007 9.963 7.178.07.207.07.431 0 .639C20.577 16.49 16.64 19.5 12 19.5c-4.638 0-8.573-3.007-9.963-7.178z";
		var ICON_EYE_PUPIL = "M15 12a3 3 0 11-6 0 3 3 0 016 0z";
		var ICON_STAR = "M12 2l2.4 6.9 7.1.3-5.5 4.5 1.9 6.9-5.9-4-5.9 4 1.9-6.9-5.5-4.5 7.1-.3L12 2z";
		var ICON_CHECK = "M4.5 12.75l6 6 9-13.5";
		var ICON_CROSS = "M6 18L18 6M6 6l12 12";

		function refreshIcon() { return svgIcon([ICON_REFRESH], 2.2); }
		function searchIcon() { return svgIcon([ICON_SEARCH], 2.2); }
		function eyeIcon() { return svgIcon([ICON_EYE_OUTLINE, ICON_EYE_PUPIL], 2); }
		function starIcon() { return svgIcon([ICON_STAR], 0); }
		function checkIcon() { return svgIcon([ICON_CHECK], 2.4); }
		function crossIcon() { return svgIcon([ICON_CROSS], 2.4); }

		/** Loading spinner from the mock: faint ring plus a solid arc. */
		function spinnerIcon(spinning) {
			return E("svg",
				{
					className: spinning ? "opf-spin" : undefined,
					fill: "none",
					viewBox: "0 0 24 24",
					"aria-hidden": "true",
				},
				E("circle", { cx: "12", cy: "12", r: "10", stroke: "currentColor", strokeWidth: "3.5", opacity: "0.25" }),
				E("path", {
					d: "M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z",
					fill: "currentColor",
					opacity: "0.9",
				}));
		}

		/** Display names for thinking levels: "xhigh" reads "XHigh", not "Xhigh". */
		var LEVEL_LABELS = { minimal: "Minimal", low: "Low", medium: "Medium", high: "High", xhigh: "XHigh", max: "Max" };

		function levelLabel(level) {
			if (typeof level !== "string" || level === "") return "";
			if (Object.prototype.hasOwnProperty.call(LEVEL_LABELS, level)) return LEVEL_LABELS[level];
			return level.charAt(0).toUpperCase() + level.slice(1);
		}

		/** The mock's timestamp: `2026/9/29 23:30:17`, not a locale string. */
		function stampOf(ms) {
			try {
				var d = new Date(ms);
				if (isNaN(d.getTime())) return "";
				var pad = function (n) { return (n < 10 ? "0" : "") + n; };
				return d.getFullYear() + "/" + (d.getMonth() + 1) + "/" + d.getDate() +
					" " + pad(d.getHours()) + ":" + pad(d.getMinutes()) + ":" + pad(d.getSeconds());
			} catch (error) {
				return "";
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
			// Capability cards, one per visible id: `{id, image, thinking}`.
			// A malformed card is dropped, never fatal — the row still renders,
			// just without its badges.
			var cards = {};
			if (Array.isArray(payload.models)) {
				for (var k = 0; k < payload.models.length; k++) {
					var card = payload.models[k];
					if (card === null || typeof card !== "object") continue;
					if (typeof card.id !== "string" || card.id === "") continue;
					cards[card.id] = {
						image: card.image === true,
						thinking: typeof card.thinking === "string" && card.thinking !== "" ? card.thinking : null,
					};
				}
			}
			return {
				visible: names(payload.visible),
				cards: cards,
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

		/**
		 * GET the live progress of the current (or last) probe round. Resolves
		 * null on any failure; the progress pill simply keeps showing the last
		 * reading until the POST that started the round answers.
		 */
		function loadProgress() {
			if (typeof fetch !== "function") return Promise.resolve(null);
			try {
				return Promise.resolve(fetch(PROBE_URL, { method: "GET", headers: { accept: "application/json" } }))
					.then(function (response) { return response && response.ok ? response.json() : null; })
					.then(function (payload) {
						if (payload === null || typeof payload !== "object") return null;
						return {
							running: payload.running === true,
							total: typeof payload.total === "number" ? payload.total : 0,
							done: typeof payload.done === "number" ? payload.done : 0,
							current: typeof payload.current === "string" ? payload.current : null,
							results: payload.results !== null && typeof payload.results === "object" ? payload.results : {},
						};
					})
					.catch(function (error) {
						console.warn(TAG + " probe progress failed:", error && error.message ? error.message : error);
						return null;
					});
			} catch (error) {
				console.warn(TAG + " probe progress threw:", error && error.message ? error.message : error);
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

			/* Live round progress, polled while the probe POST is in flight.
			   Null means "no reading yet" — the pill and the row badges only
			   render once the first poll lands. */
			var progressState = useState(null);
			var progress = progressState[0];
			var setProgress = progressState[1];

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
			   catalogue: keep the rows on screen and offer the retry.
			   While the POST is in flight the progress endpoint is polled, so
			   the pill and the per-row badges track the round live; when the
			   POST answers, polling stops and the card repaints from the final
			   snapshot (capability badges return). */
			var PROGRESS_POLL_MS = 800;

			function probe() {
				if (probing) return;
				setProbeError("");
				setProbing(true);
				setProgress(null);
				var timer = null;
				var stopped = false;
				var poll = function () {
					if (stopped) return;
					loadProgress().then(function (reading) {
						if (stopped) return;
						if (reading !== null) setProgress(reading);
						if (typeof setTimeout === "function" && !stopped) {
							timer = setTimeout(poll, PROGRESS_POLL_MS);
						}
					});
				};
				poll();
				probeCatalog().then(function (snapshot) {
					stopped = true;
					if (timer !== null && typeof clearTimeout === "function") {
						try { clearTimeout(timer); } catch (error_) { /* best effort */ }
					}
					if (snapshot !== null) setCatalog(snapshot);
					else setProbeError(t("probeFailed"));
					setProgress(null);
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
			var cards = catalog !== undefined && catalog !== null && catalog.cards !== undefined ? catalog.cards : {};

			/* One row per visible id. At rest: mono id, capability badges, status
			   word, iOS-style switch. While a round is running, the capability
			   badges step aside for the probe badge — green "✓ 142ms", red
			   "探测失败", blue spinner "探测中...", grey "等待中" — and the
			   active row highlights while queued rows dim, per the approved
			   mock. Badge data comes from the host's `models` array; a row
			   whose card is missing renders bare rather than failing — the
			   toggle is the contract, badges are decoration. */
			var live = progress !== null && progress.running === true;
			var liveResults = live ? progress.results : {};
			var liveCurrent = live ? progress.current : null;

			var rows = visible.map(function (id) {
				var shown = !hasOwnKey(hidden, id);
				var card = hasOwnKey(cards, id) ? cards[id] : null;
				var left = [E("span", { key: "id", className: "opf-id" }, id)];
				var rowClass = "opf-row";
				if (!live) {
					if (card !== null && card.image === true) {
						left.push(E("span", { key: "vision", className: "opf-badge opf-badge-vision" },
							eyeIcon(),
							E("span", null, t("badge.vision"))));
					}
					if (card !== null && card.thinking !== null) {
						left.push(E("span", { key: "think", className: "opf-badge opf-badge-think" },
							starIcon(),
							E("span", null, t("badge.thinking") + " · " + levelLabel(card.thinking))));
					}
				} else {
					var verdict = hasOwnKey(liveResults, id) ? liveResults[id] : null;
					var status = verdict !== null && verdict.status === "ok" ? "ok"
						: verdict !== null ? "failed"
						: id === liveCurrent ? "probing" : "waiting";
					if (status === "ok") {
						var ms = typeof verdict.ms === "number" && isFinite(verdict.ms) ? Math.max(0, Math.round(verdict.ms)) : null;
						left.push(E("span", { key: "probe", className: "opf-probe opf-probe-ok" },
							checkIcon(),
							E("span", { className: "opf-probe-ms" }, ms === null ? "" : ms + "ms")));
					} else if (status === "failed") {
						left.push(E("span", { key: "probe", className: "opf-probe opf-probe-fail" },
							crossIcon(),
							E("span", null, t("probing.failed"))));
					} else if (status === "probing") {
						rowClass += " opf-row-probing";
						left.push(E("span", { key: "probe", className: "opf-probe opf-probe-busy" },
							spinnerIcon(true),
							E("span", null, t("probing"))));
					} else {
						rowClass += " opf-row-waiting";
						left.push(E("span", { key: "probe", className: "opf-probe opf-probe-wait" },
							E("span", { className: "opf-waitdot" }),
							E("span", null, t("probing.waiting"))));
					}
				}
				return E("label",
					{ key: id, className: rowClass },
					E("span", { className: "opf-main" }, left),
					E("span", { className: "opf-side" },
						E("span", { className: "opf-state" + (shown ? " on" : "") }, shown ? t("row.visible") : t("row.hidden")),
						E("span", { className: "opf-switch" },
							E("input", {
								type: "checkbox",
								checked: shown,
								onChange: function () { toggle(id); }
							}),
							E("span", { className: "opf-track" },
								E("span", { className: "opf-thumb" })))));
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
			   one. An older host omits them, and then none of this shows. The
			   timestamp sits top-right of the toolbar with a green dot, per
			   the approved mock — not in the body flow. */
			var untrustedNote = catalog !== undefined && catalog !== null && catalog.probeInconclusive === true
				? E("p", { className: "opf-note" }, t("probeUntrusted"))
				: null;

			var stamp = null;
			if (catalog !== undefined && catalog !== null && typeof catalog.probedAt === "number") {
				var stampText = stampOf(catalog.probedAt);
				if (stampText !== "") {
					stamp = E("p", { className: "opf-stamp" },
						E("span", { className: "opf-dot" }),
						E("span", null, t("probedAt") + " " + stampText));
				}
			}

			/* Footer legend: what the two badge colours mean. Static, so it
			   renders whenever the card does. */
			var legend = E("span", { className: "opf-legend" },
				E("span", { className: "opf-badge opf-badge-vision" }, eyeIcon(), E("span", null, t("legend.vision"))),
				E("span", { className: "opf-badge opf-badge-think" }, starIcon(), E("span", null, t("legend.thinking"))));

			/* Progress capsule: pulsing dot, "正在探测", live "done/total" and a
			   mini bar. Renders only while a polled reading says a round is
			   running; sits next to the timestamp, per the mock. */
			var capsule = null;
			if (progress !== null && progress.running === true && progress.total > 0) {
				var pct = Math.max(0, Math.min(100, Math.round((progress.done / progress.total) * 100)));
				capsule = E("span", { className: "opf-capsule" },
					E("span", { className: "opf-pingwrap" },
						E("span", { className: "opf-pingring" }),
						E("span", { className: "opf-pingdot" })),
					E("span", { className: "opf-capsulelabel" },
						t("probing.now"),
						" ",
						E("span", { className: "opf-count" }, progress.done + "/" + progress.total)),
					E("span", { className: "opf-bar" },
						E("span", { className: "opf-fill", style: { width: pct + "%" } })));
			}

			var toolbarRight = stamp !== null || capsule !== null
				? E("div", { className: "opf-actions" }, capsule, stamp)
				: null;

			return E("div",
				{ className: "opf-card" },
				E("div", { className: "opf-head" },
					E("div", { className: "opf-title" }, t("title")),
					E("p", { className: "opf-desc" }, t("cardDesc")),
					E("div", { className: "opf-toolbar" },
						E("div", { className: "opf-actions" },
							E("button", {
								type: "button",
								className: "opf-btn",
								disabled: busy || probing,
								onClick: refresh
							}, refreshIcon(), E("span", null, busy ? t("refreshing") : t("refresh"))),
							E("button", {
								type: "button",
								className: "opf-btn" + (probing ? " opf-btn-probing" : ""),
								disabled: probing,
								onClick: probe
							}, probing ? spinnerIcon(true) : searchIcon(), E("span", null, probing ? t("probing") : t("probe")))),
						toolbarRight)),
				E("div", { className: "opf-body" },
					fallbackNote,
					untrustedNote,
					listArea,
					error ? E("p", { className: "opf-error" }, error) : null,
					probeError ? E("p", { className: "opf-error" }, probeError) : null),
				E("div", { className: "opf-foot" },
					E("p", { className: "opf-hint" }, t("hint")),
					legend));
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
