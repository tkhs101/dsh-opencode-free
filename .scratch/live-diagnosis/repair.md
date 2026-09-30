# 診斷與修復：2026-09-30 03:31:17 那一輪的「未測到 9／本輪下架 1」

`Status: resolved`

面板截圖這一輪的問題不是探針，是面板把三件事講錯了。本文記錄原因、
證據、改了什麼，以及刻意沒改什麼。

## 現象

`探測完成 1 · 未測到 9 · 本輪下架 1`，橫幅寫「本輪探測結論不可信……
模型顯示保持不變」與「本輪沒能測到這些模型（2026/9/30 03:31:17）：
匿名層級被拒 —— 這是當時的網絡狀況，不是該模型的結論」。

## 這一輪的真實內容（零請求取得）

`GET /dsh-opencode-free/api/probe` 的記憶體輪次記錄（11 列，非 10 列）：

| # | 模型 | 結果 |
|---|---|---|
| 1–3 | ling-3.0-flash-fin-free / muse-spark-1.2 / longcat-2.5 | anon-gated 403（544/347/347ms） |
| 4 | space-bunny-free | **ok 1196ms** |
| 5–7 | mimo-v2.6 / nemotron-3-ultra / mimo-v2.5 | anon-gated 403 |
| 8 | deepseek-v4-flash-free | dead 400（上游「Model is unavailable.」） |
| 9–11 | nemotron-3.5 / big-pickle / muse-spark-1.3 | anon-gated 403 |

## 原因

**上游在 03:31:17 處於「選擇性拒絕」狀態，這一輪量到的是上游的准入狀態，
不是模型的狀態。** 證據是 8 分鐘後的同形狀重測：`longcat-2.5-preview-free`
與 `big-pickle` 在本輪被記為 403，03:39 用逐字節相同的請求（read+bash 工具閘、
stream、maxTokens 1024、Bearer public）回 200 並作答。同一 id、同一程式、
同一請求形狀，8 分鐘內從 403 翻成 200 —— 這是上游狀態的性質，不是模型的性質。

探針本身沒有壞：D5 照常生效（inconclusive 不寫盤、不改顯示），這一輪
唯一寫進 `probes` 的是那個貨真價實的 `deepseek-v4-flash-free` 死亡判定。

## 面板講錯的三件事（本次修復）

1. **「這是當時的網絡狀況」是假的。** 11 列全部帶 HTTP 狀態碼，0 列
   `http:0`，0 次傳輸失敗 —— 網絡從頭到尾沒有參與。讀者會去查代理／VPN／
   DNS，那條路從未壞掉過。repo 自己的 `docs/reverse-engineering.md` 也明令
   禁止從 `FreeTierError` 報文推論「IP 被閘」。
   → `src/client.js` `probing.notModelFault`、`advice.anongated`（中英）
2. **「本輪下架 1：deepseek-v4-flash-free」是假的。** 它在 23:30:17 就已
   判死、當時就已離開清單；03:31:17 只是複核。面板的 `removedNote` 只看
   本輪的 `GONE_CODES`，不與輪次前的可見集合比對，於是把別輪的改動記在
   這一輪頭上 —— 而這正是讀者會據以行動的那張收據。
   → `src/catalog.ts` 輪次記錄新增 `removed`（寫入前讀舊判定），面板拆成
   「本輪下架」與「複核仍不可用」
3. **「模型顯示保持不變」是沒有被程式保證的全域宣稱。** 實際被保證的只有
   逐模型那條：`inconclusive` 不寫判定，所以**那些**模型顯示不變；同一輪
   裡掃完兩個通道賺來的 `dead` 照樣記錄並收起。面板卻把它講成全域的。
   → `probeUntrusted` 改為只說被保證的那一半

## 測試

- `tests/catalog.test.mjs`：**混合輪**（1 ok + 1 dead + 9 拒絕）—— 原有 D5
  用例只覆蓋「全部被閘」，真正會發生的混合輪是空白；現在釘死兩件事：拒絕者
  顯示逐字不變，且賺來的 `dead` 必須保留（拿掉它會讓已下架模型繼續可選）。
- `tests/catalog.test.mjs`：複核舊判定 `removed: false`。複核只可能發生在
  「通道掃描之前的老判定」（無 `swept`），這正是 23:30:17 那 23 條的狀態。
- `tests/client-render.test.mjs`：複核不得出現在「本輪下架」；橫幅不得把上游
  的回應說成讀者的網絡；`probeUntrusted` 不得再做全域宣稱。
- `pnpm test` 119/119（連跑三次）；`pnpm typecheck` 通過。

## 刻意沒改（附理由）

- **提前中止這一輪**：證據反證。第 1、2、3 列被拒而第 4 列成功、第 8 列拿到
  真死亡判定 —— 拒絕不是單調的。連續兩次 `anon-gated` 就中止，會正好錯過
  space-bunny 的成功與 deepseek 的真死亡。
- **403 上不再掃第二通道**（`isCallerScoped`）：403 是呼叫端層級的現象，
  換通道會得到同一個答案，且要再花一份正在枯竭的額度。
- **上游還有第三個端點家族**（`/zen/v1/messages`，9router 對
  `union-alpha`／minimax／qwen 的路由）：本插件的 pi-ai 這個版本根本沒實作
  `anthropic-messages`，`SUPPORTED_APIS` 只有兩個。要補是功能，不是 bug 修復；
  風險是真的（那 23 條 401 死亡判定正是這種報文），但至今**沒有一條被實測
  驗證**——先前所有診斷腳本只抽 2–3 個模型／通道，從未抽過那 9 個。
- **`MODEL_GONE_STATUSES` 在 FORMAT_SCOPED／429 之前判 true**
  （`src/zen-provider.ts:555`）：潛在矛盾（D4b 要求 `dead` 必有模型特定信號，
  而 404/410 只看狀態碼）。本輪未觸發，本輪也不修 —— 避免把「順手改」混進
  這次修復。
- **探針超時 15s vs spec 30s、`maxTokens` 1024 vs spec 512、plan.md 三處漂移**：
  文件漂移，不是這一輪的因。

---

# 第二輪：03:54:28 又拒了之後

03:54:28 的輪次形狀與 03:31:17 逐字相同（1 ok / 9×403），間隔 23 分鐘。
**所以「上游瞬時狀態」是不完整解釋**——它可復現，而且復現點在宿主進程裡。

## 已測量排除（全部）

| 變數 | 結論 | 證據 |
|---|---|---|
| 請求 | **不是** | 三條路徑（輪次／單發／輪次+三層守衛）逐字節相同：URL、17 個 header、body 全同 |
| 序列／突發 | **不是** | 隔離進程用宿主那 10 個目標、同順序、同輪次代碼連發 → **9 ok / 1 failed** |
| 時鐘 | **不是** | 03:31:17 失敗在獨立測試第一條（03:39:37）**之前**；03:54:28 失敗在最後一條（03:41:25）**之後** |
| session id 靜態綁定 | **被推翻** | 釘死一個 id，先探 space-bunny-free（200），再用**同一個 id** 探 longcat（200） |
| 共享桶被自己抽乾 | **被推翻** | 輪 1 之前本機 **37.1 分鐘零 Zen 請求**（02:30–03:31 全段僅 6 次），而輪 1 第一個請求就被拒；兩輪之間有 **147 次成功**的 space-bunny-free，全程 **0 次 429/RATE_LIMIT** |
| 並發（本機流量） | **被推翻** | 兩次失敗所在分鐘，本機 agent 請求數均為 **0** |
| Zen key | **不是** | 插件 `config.apiKey` 未設（cordis.patch.yml 已查）、無 `OPENCODE_API_KEY`、credentials 無 Zen 條目 |
| 代理／出口 | **不是** | 無任何 `*_PROXY`、WinHTTP 報直連、DSH 配置無代理引用 |
| node 運行時 | **不是** | 宿主 `node …/dsh/lib/bin.js web`，同一 PATH shim v26.8.1 |
| 競爭插件 | **不是** | profile 裡確有第二個 `opencode-free` 提供者 `dsh-notoken-oc`，但它是**斷鏈的軟鏈**（目標目錄已不存在），不加載任何代碼；`@opencode2dsh` 是空目錄 |

**統計形態**：宿主外 17 次連續成功（1 次完整輪次 9/10 ＋ 4 次單發 ＋ 1 次單模型輪次
＋ 2 次 session 綁定），宿主內 2 次輪次共 19 個請求、只有 1 個通過，零重疊。
兩個失敗輪次來自**兩個不同的 DSH 進程**（03:31 屬於已退出的舊進程；03:54 屬於
PID 8000，創建於 03:54:11、輪次在其第 17 秒）——所以不是進程老化，是「在宿主裡
做這件事」本身。

## 仍未解

那 9 個 403 屬於 `ANON_GATED_PATTERN` 三支中的哪一支
（`FreeTierError`／`MissingSessionID`／`only be used … OpenCode`）**至今未知**：
`inconclusive` 從不落盤，報文在世界任何地方都沒留存。所有實驗都沒能復現出一次拒絕，
所以對這個問題的證據是零。

## 下一步（零成本）

`DSH_OPENCODE_FREE_DEBUG=1` 會把**宿主真實發出**的每條 Zen 請求打到 stderr
（`src/zen-provider.ts:1072`）：`fetch ua=… session=… auth=… arid=…` 加
`fetch <- 狀態碼 /路徑 after NNms`。重啟 DSH 帶這個變數、點一次「立即探測」，
就能第一次拿到宿主實際的 identity 與逐條狀態碼，與隔離環境的逐字抓包對拍。

> 該行會打印 `Authorization` 的**前 14 個字符**。當前無 key（打印 `Bearer public`），
> 但若將來配了 key，別把這段日誌貼到公開處。

## 順帶發現，未修（與本輪無因果關係，留檔）

1. **「先收後斷」是上游第四種行為，代碼沒建模**：200 ＋ 流被切斷
   （undici `TypeError: terminated`）→ `hasAnswer` 因 `stopReason:"error"` 判否 →
   `classifyZenFailure(200,"")` → `unknown` → 面板畫成**紅色「無響應」**並計入
   `badCount`。一次證明「閘門已放行」的 200 被報成失敗。
2. **23 條 unswept dead 永遠無法被重測**：`targets` 要 `live`（Zen 在列），
   `notListed` 又用 `verdict !== "dead"` 把它們排除（`src/catalog.ts:821-823`），
   而 Zen 現在不列這 23 個。它們既不可見也不可測——只要 Zen 不重新上架。

---

# 第三輪：使用者指出「列表中的模型在 DSH 都能正常用」

這是前兩輪都沒問的問題。生產路徑（`provider.stream()`，agent loop 走的那條）
**從來沒有被離線抓包對比過，也從來沒有被 live 測過**——repo 自己的
`scripts/test-live.mjs` 用的也是 `streamSimple`。而
`docs/reverse-engineering.md` 的踩雷紀錄把「探針請求形狀與生產不同」列為第 1 號教訓。

## 生產 vs 探針：離線逐字抓包（0 請求）

`.scratch/live-diagnosis/path-diff.mjs`，同一 model、同一進程、stub fetch：

| | 探針 | 生產 |
|---|---|---|
| URL / method | `POST /zen/v1/chat/completions` | 同 |
| header | 14 個相同 | 僅 session / request id 不同（設計如此） |
| `tools` | `read,bash`（空殼） | `read,bash,grep`（真 schema） |
| `max_tokens` | 1024 | 8192 |
| `reasoning_effort` | `"low"` | **無** |
| messages | 僅 `hi` | system + user |

**結論：沒有任何一項是閘門開關。** `reasoning_effort` 對四個模型（含唯一能過的
space-bunny-free）都一樣出現，所以也不是區分點。

## 同進程 A/B（3 請求，longcat-2.5-preview-free）

`.scratch/live-diagnosis/same-process-ab.mjs`——同一進程、同一時刻、同一 session：

| 變體 | 結果 |
|---|---|
| V1 探針原樣（`streamSimple` + 裸 context + `reasoning:"low"`） | **200，3436ms，正常作答** |
| V2 探針路徑 + 生產 context（真 tools、去 reasoning） | 200，2740ms |
| V3 生產路徑 `stream()` + sessionId | 200，3757ms |

**這是關鍵證據：探針自己那條請求，此刻就是 200。** 模型可測、探針的請求形狀沒問題。
使用者的觀察成立，而且被量化了。剩下的差異只在「跑在 DSH 宿主裡」。

## 為什麼前兩輪答不出來（已修）

`ANON_GATED_PATTERN` 把三支折成一個 `anon-gated`，而 `inconclusive` 從不落盤，
所以**回答問題的報文在輪次結束的瞬間就消失了**。三輪診斷全部卡死在這裡。

本次新增（`src/zen-provider.ts` / `src/catalog.ts` / `src/client.js`）：

- `anonGateMarker(body)`：按 pattern 順序判斷報文命中哪一支，回傳
  `FreeTierError` / `MissingSessionID` / `opencode-only` / `null`
- `ProbeOutcome.inconclusive.marker` → 輪次記錄 → 面板 tooltip 與**橫幅**
  （橫幅是重載後唯一還在的那一行）
- `DSH_OPENCODE_FREE_DEBUG=1` 時額外把脫敏後的報文前 300 字打到 stderr
  （預設關閉；這是上游錯誤報文，永遠不是請求）

折疊後的 `anon-gated` 保留——三支都不是對模型的判定——但現在**拒絕會自報是哪一種**。

`pnpm test` 122/122；其中一個用例把真實的 403 FreeTierError 報文灌進真的
`probeModel`，斷言 marker 從另一端出來。

## 下一步（需要使用者一個動作）

重啟 DSH（新版 `lib/` 需要它）→ 點一次「立即探測」。面板橫幅會直接寫出這 9 個 403
屬於哪一支；想看完整報文就同時設 `DSH_OPENCODE_FREE_DEBUG=1`，DSH 主控台會有
`[dsh-opencode-free] probe <- 403 marker=… body=…`。

---

# 第四輪：直接驗證「模型能不能用」＋ 再排除兩個宿主變數

## 使用者的前提成立（9 次請求，逐個走生產路徑）

`.scratch/live-diagnosis/production-path-check.mjs`：用**真實的目錄 model 物件**
（從 live cache 複製出來，不動本機 cache）、走 `provider.stream()`（生產路徑）、
逐個問。**0 個 403。**

| model | 通道 | 狀態 | 耗時 | 結果 |
|---|---|---|---|---|
| big-pickle | completions | 200 | 1390ms | **作答** |
| muse-spark-1.2-contributor-free | responses | 200 | 1178ms | **作答** |
| muse-spark-1.3-contributor-free | responses | 200 | 1192ms | **作答** |
| mimo-v2.5-free | completions | 200 | 2152ms | **作答** |
| nemotron-3-ultra-free | completions | 200 | 1882ms | **作答** |
| nemotron-3.5-lightning-free | completions | 200 | 888ms | **作答** |
| ling-3.0-flash-fin-free | completions | 400 | 405ms | 無應答（**真問題**，與 5f9a88d 當時的發現一致） |

連同先前 A/B 單獨測的 longcat（V1 探針原樣 200），**宿主輪次拒絕的 9 個裡，
7 個已證實可用，1 個（ling）是真的 400，1 個（mimo-v2.6）未測。**
所以「列表中的模型都能正常用」成立，而探針在宿主裡把它們判成測不到是錯的。

> 覆蓋範圍要說準：這次跑的是 7 個 pi-ai 內建免費模型（複製出來的 cache 沒帶
> models.dev 欄位，`createCatalog` 退回內建基線），不是全部 34 個。

## 再排除兩個宿主變數（0 請求）

- **DSH 沒有動 fetch 或環境**：`@deepseek-ai/dsh/lib` 裡沒有
  `setGlobalDispatcher` / `ProxyAgent`，沒有 `globalThis.fetch =`，
  沒有 `process.env.X =`。三道守衛在 `src/index.ts:418-428` 拿到的都是
  `() => undefined`，與測試 harness 完全相同。
- **DNS 沒有分流**：`opencode.ai` 只解析出 4 個 IPv4（172.65.90.20–23），
  沒有 IPv6，不存在「主機走 v6、腳本走 v4」這種分歧。
  `isZenRequest`（`src/zen-provider.ts:1170`）只是 URL 前綴比對，兩條路徑都成立。

## 現況

證據鏈完整且一致：**模型可用、探針請求可用、獨立進程可用、宿主進程不可用**，
且請求逐字節相同。唯一還缺的是**宿主自己那份回應報文**——它決定「宿主裡被拒」
落到哪個具體機制上，而這需要重啟後跑一輪。

## 時序排除了「週期性上游窗口」

失敗在 03:31、03:54；成功在 03:39–03:42、04:05、04:16、04:26。
**03:54 那次失敗夾在兩段成功之間**，所以不是週期性窗口，是進程相關。

## composed config 給出的最尖銳事實

`dsh --profile web --dump-config`：

```yaml
- id: agent-default-model
  name: '@deepseek-ai/dsh-agent-default-model'
  config:
    provider: opencode-zen-free
    model: muse-spark-1.3-contributor-free
    reasoningEffort: xhigh
```

**agent 的預設模型就是 `muse-spark-1.3-contributor-free`——宿主輪次拒絕的 9 個之一，
而且它此刻正在這個進程裡跑著這場對話。** 所以「同一個進程內，生產路徑用它正常作答、
探針路徑對它 403」是正在發生的事，不是推論。

同時確認：composed config 裡只有 `dsh-opencode-free` 這個 provider，
`dsh-notoken-oc` 沒有被載入（斷鏈軟鏈），**不存在第二個搶 Zen 請求的插件**。

## 已交付並驗證

- 面板三處失實（網絡歸因、本輪下架假帳、全域「顯示不變」宣稱）——已修，
  使用者截圖確認新版文案與計數上線。
- 拒絕自報是哪一支閘門條件（`FreeTierError` / `MissingSessionID` / 只能 OpenCode），
  走 `ProbeOutcome` → 輪次記錄 → 面板 tooltip 與橫幅；`DSH_OPENCODE_FREE_DEBUG=1`
  額外打印脫敏報文。
- `pnpm test` 123/123，其中三條把真實報文灌過整條鏈：
  `anonGateMarker` 分支、`probeModel` 出 marker、輪次記錄帶 marker 到面板。

## 剩下的（需要使用者一個動作）

重啟 DSH → 點一次「立即探測」。這是唯一還能觀察到**宿主自己那份回應報文**的途徑；
沒有權限自行重啟（`AGENTS.md`），且未經許可不得重啟。



---

# 第五轮：终局实验 + 修复

## 三选一的答案：FreeTierError

宿主在跑新版代码，`/api/probe` 的结果里出现了 marker：

```
ling-3.0-flash-fin-free    351ms  anon-gated 403 FreeTierError
space-bunny-free         1102ms  ok
longcat-2.5-preview-free  388ms  anon-gated 403 FreeTierError
```

即上游回的是 `FreeTierError`——依本 repo 已录制的报文形状，讯息是
**"OpenCode's free tier can only be used from within OpenCode"**。
**这是身分检查，不是额度墙。**

## 宿主 vs 进程：同一时刻、同一模型（决定性）

宿主路由可从本机直接调用（`POST /api/probe` 需带 `Origin`，否则 `sameOrigin`
回 403；这也是先前 curl「没有反应」的原因）。于是做了交错实验：

| | 时间 | 模型 | 结果 |
|---|---|---|---|
| 宿主轮次 | 08:56:56 起 | longcat-2.5-preview-free | **403 FreeTierError，388ms** |
| 我的进程 | 08:57:04.488 | longcat-2.5-preview-free | **作答，5847ms** |

同机、同出口、同一模型、相隔 7 秒。**拒绝绑在宿主进程上。**

## 修复：让探针走生产那条路

证据指向「探针量的是一个没人会发的请求」，所以修在源头：

- `probeOnce` 改用 `provider.stream()`（生产入口），不再是 `streamSimple`
- 上下文带上 `systemPrompt`，不再是一条光秃秃的讯息
- 新增 `PROBE_REQUEST_SHAPE = { cacheRetention: "short" }`，与生产 profile
  （`src/index.ts`）一致，避免两边再漂移
- **保留 `maxRetries: 0`**：实测拿掉后 429 会从 1 次变 3 次请求，
  `tests/compatibility.test.mjs` 的 guard 抓到了，这是对的

`pnpm test` 123/123。

## 为什么还没生效

宿主 PID 9872 启动于 04:35:31，而这批改动 04:49 才编译。
DSH 的 HMR 只热重载 `cordis.patch.yml` 的**配置**，不重载插件**模块**
（实测：新增的 `/dsh-opencode-free/diag/one` 路由在宿主里 404；
touch / 同内容重写 / 插入可回滚的空配置注释，三种都没有触发插件重新 apply）。
配置档已还原，与备份逐字相同。

**下一步只需重启 DSH，然后由我直接调 `POST /api/probe` 跑一轮并读结果**
（已验证可行），使用者不需要点按钮、也不需要截图。

---

# 第六轮：抓到宿主真正发出去的那条请求

诊断路由加上「抓线上流量」后，宿主与我的进程**逐字段对拍**（同一个 `ling`，相隔几秒）：

| | host | mine |
|---|---|---|
| URL / method | 相同 | 相同 |
| headers | 仅 3 个随机 id 不同 | 同 |
| body 键 | `model, messages, stream, stream_options, max_tokens` | `… , tools`（多一个） |
| messages | `[{"role":"user","content":"hi"}]` | 带 system |
| 结果 | **403 FreeTierError** | **400（真正穿过闸门）** |

**宿主那条请求里没有 `tools`。**

而本 repo 自己的 `docs/reverse-engineering.md` §8 写得很清楚：
匿名层缺 `read`/`bash` 工具名的请求**必然 403**——这正是观测到的
`FreeTierError: "OpenCode's free tier can only be used from within OpenCode"`。

## 关键矛盾

- `applyAnonymousToolGate` 在 `apiKey === "public"` 时一定注入 `read`+`bash`
  （`src/zen-provider.ts`），宿主那条请求的 `Authorization` 确实是 `Bearer public`
- pi-ai 的 `Context.tools` 就是正确位置（`dist/types.d.ts:389`）
- 已发布版 0.2.0 同样带 `GATE_TOOLS`
- profile 声明 `link:C:/Users/YANG/Desktop/dsh-opencode-free`，宿主加载的就是工作树
- 宿主进程 09:07:12 启动，晚于 09:04:26 的构建

**=> 没有任何版本的这个插件能发出「无 tools」的请求。**
要么宿主执行的不是这条探测路径，要么有别的东西在用我们的身份发这条请求。

## 顺带查到的宿主自述

```
node v26.8.1 · execArgv [] · cwd C:\Users\YANG\.dsh · 无任何 PROXY
NODE_OPTIONS=--require=".../dsh-desktop/compat/explorer-visibility-*.cjs"
```
该 preload 只改 `childProcess.execFile` 的 Explorer 可见性，不碰网络。

## 已回滚的改动（重要）

尝试让探针「走生产那条路」（`provider.stream()` + systemPrompt + 生产 cacheRetention）
**已回滚**。原因是我自己的进程实测出它引入回归：`stream()` 忽略 `model.api`，
自行决定传输通道，把目录里标成 `openai-completions` 的模型发到了 responses 通道。
而且它对宿主的 403 毫无影响。`pnpm test` 123/123。

保留的是已验证有价值的部分：拒绝自报是哪一支闸门、debug 打印脱敏报文、
面板三处失实修正、`本轮下架` 与「复核」区分。

---

# 第七轮：标记实验 + 真正的修复

## 标记实验一击定案

探针 prompt 改成 `"hi #dshprobe"` 后重启，宿主抓到的 body：

```
messages : [{"role":"user","content":"hi #dshprobe"}]   ← 标记在
body keys: model, messages, stream, stream_options, max_tokens, reasoning_effort
tools    : ABSENT
status   : 403  FreeTierError
```

**宿主跑的就是这份代码**（标记在），而且 `reasoning_effort` 回来了（回滚生效）。
**但 `tools` 依然不在。**

排除掉的解释：
- 不是旧代码（标记在）
- 不是我的 `stream()` 改动（已回滚，`reasoning_effort` 证明走的是 `streamSimple`）
- 不是 provider wrapper 被 spread 覆盖（`...provider` 在前，`stream`/`streamSimple` 在后）
- 不是两个 pi-ai 版本（全机只有 0.85.1 一份）
- 不是 `swapCompactionPrompt` 动了 tools（它只碰 systemPrompt）
- 不是 key 不是 "public"（线上 `Authorization: Bearer public`；若是真 key，header 会是那个 key）

也就是说：**context 上的工具闸门确实执行了，工具却在到达线路之前被丢了。**
丢失点在插件管不到的一层里。

## 修复：在最后一道边界自己兜住

插件能碰到的、字节离开前的最后一道边界，是 `onPayload`。
`enforceAnonymousTools()` 在那里重新断言 `read` + `bash`：

- 幂等：已经在就不写
- 两种通道的形状都认（responses 是 `type/name`，completions 是 `type/function.name`）
- 用 body 自己的 `input`/`messages` 字段判断通道，不猜

**为什么这不是补丁而是正确的归属**：这份代码的目的就是「问上游这个模型还能不能用」，
而上游的准入条件是请求形状。把准入条件在出口处保证住，是探针自己的责任；
让它依赖四层上游都正确转发，是把责任推给了别人。

验证（离线，模拟宿主丢工具）：`tools on the wire: ["read","bash"] ADMITTED`。
回归用例 `GUARD: the probe re-asserts its admission tools on the final payload`。
`pnpm test` 124/124。

---

# 第八轮：修好并验证

宿主里连续三轮，形状完全一致：

```
answered 8/10 · gate-refusals 0 · not-ok {
  ling-3.0-flash-fin-free:      (unknown, 400)
  nemotron-3.5-lightning-free:  (timeout, 200)
}
```

修复前是 `answered 1/10 · gate-refusals 9`。

## 两行没答对的，各是什么

- **`ling-3.0-flash-fin-free` → HTTP 400**：模型级真问题。独立进程拿到的是同一条
  `Upstream request failed: Endpoint is unavailable.`。`ENDPOINT_FAILURE_PATTERN`
  刻意不把 endpoint 失败判成 `dead`（通道可能选错），所以判 inconclusive 是对的。
- **`nemotron-3.5-lightning-free` → HTTP 200 超时**：被放行了，只是不作答。
  实测 15s 与 30s 两个预算都不产出应答（`stopReason=aborted`），
  所以 15s 上限没有制造假阴性，**不改**。

## 诊断脚手架已全部拆除

`/dsh-opencode-free/diag/one` 路由、进程自述 `hostFacts`、线上抓包、`#dshprobe`
标记，全部移除；`src/index.ts` 回到 HEAD（`git checkout`），诊断期对 index.ts 的
改动一行不剩。保留的只有：

- `enforceAnonymousTools()`：出口处保证准入工具（**修复本体**）
- 拒绝自报是哪一支闸门 + debug 打印脱敏报文
- 面板三处失实修正
- `本轮下架` 与「复核仍不可用」区分

`pnpm test` 124/124。
