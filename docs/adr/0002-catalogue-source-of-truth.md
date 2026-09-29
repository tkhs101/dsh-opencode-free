# 模型目錄的 source-of-truth 是 models.dev，不是 Pi 內建表

模型目錄（哪些模型是免費的、叫什麼名字、上下文多大）改由
`https://models.dev/api.json` 的 `opencode.models` 決定，執行時抓取、
本地快取；Zen 自己的 `/models` 保留為最後一道可用性閘門。Pi 內建
`opencode` 表降級為「已知通道覆蓋表」與離線兜底基線。

取代 `docs/spec-v0.2.md` 的「目錄維持打包基線＋公開端點交集」決策。

**Status**: accepted

**Context**

Pi 內建表曾經是唯一的目錄來源。DSH 把 `pi-ai` 鎖在 `0.85.1`（peer
依賴），插件無法隨上游升級，於是 Zen 每新增一個免費模型，就要手工補一
條記錄。實測已發生兩輪：先補 5 條，再手動刪掉 1 條。同時 models.dev
已發布的 metadata（名稱、上下文／輸出上限、attachment、reasoning、
status）完全取不到，只能靠猜。

要點在於 `status: "deprecated"` 的語義有歧義：在 opencode 這家
provider 上，`deepseek-v4-flash-free`（免費層已結束、實測呼叫失敗）與
`muse-spark-1.2-contributor-free`／`mimo-v2.5-free`（當時仍可用）
被寫成同一個值。這正是後來「以實測探針取代 status 判定可見性」的理由
（見下「可見性判據（2026-09-29 修訂）」）。

**Considered Options**

- **維持 Pi 內建表＋手工補條（否決）**：來源不變，但每個新模型都要人
  動，且 metadata 仍缺；已實際發生兩輪，成本證明它不成立。
- **建置期快照（否決）**：發版時用腳本生成一份 models.dev 快照隨包發
  布。啟動零開銷，但「跟隨」等於「等下次發版」——使用者看到的仍然過期，
  只是把過期責任從人手上換到發版流程上。
- **models.dev 執行時拉取＋快取（採用）**：真正跟得上上游；代價是首次
  需下載整份 `api.json`（約 5.2MB，models.dev 未提供 per-provider 端
  點），必須有離線兜底。
- **Pi 內建表升版（否決）**：最乾淨，但被 DSH 的 peer 依賴鎖死，不是
  插件能自己決定的。

**決策細節**

- 免費判定：`cost` 全零。目錄 membership：`status ∈ {active, deprecated}`。
- 可用性閘門：與 Zen `/models` 在列求交集；Zen 抓取失敗時保持現有清單，
  不收窄。交集只算一次，模型選單與詳情頁讀同一份快照。
- 通道推導三級：Pi 內建表命中 → models.dev 訊號（有 `interleaved` 或
  `reasoning_options=[{type:"toggle"}]` 為 completions；`effort` 為
  responses）→ 兜底 completions（依據 `provider.npm =
  "@ai-sdk/openai-compatible"`）。已對 7 個已知模型驗證 7/7 吻合。
- 快取：`$DSH_HOME/dsh-opencode-free/catalog.json`，只存 models 段（不存
  provider 包裝層），臨時檔＋rename 原子寫，附 ETag 做條件重驗證。
- 失效：讀目錄時若快取超過 24h 則背景重拉，不阻塞當次請求，不設定時器
  （延續 v0.2「不做背景自動刷新」的決定；探針是唯一的例外，見下）。
- 降級：無網路、無快取、畸形回應 → 退回 Pi 內建免費集。任何失敗都不得
  讓模型選單變空。

**可見性判據（2026-09-29 修訂，取代本節原「免費且 `status ≠
deprecated` 即預設可見」）**

`status` 降級為「是否在目錄內」，可見性改由實測決定：

- 每日至多一輪探針，對目錄全集按順序各發一次最小請求
  （`max_tokens: 512`、30s 超時、帶 `read`+`bash` 工具名——匿名層沒有這兩
  個工具名就一律 403，見 `docs/reverse-engineering.md` §8）。
- 三態結論：`ok`（有非空文字回覆）／`dead`（**只接受正信號**：404、410，
  或報文明確指此模型不存在／已下線）／`inconclusive`（被閘、額度用完、
  key 失效、5xx、傳輸異常、空回覆）。`dead` 是唯一會讓模型離開選單的結論，
  且預設不成立——單一被閘的 IP 會讓所有模型同時 403，若這算 `dead`，
  整份清單會清空。
- `inconclusive` 永不落盤、可見性逐字不變，只留一個「本輪不可信」旗標給
  面板。`dead` 落盤到同一個快取檔，重啟後仍然生效。
- **判定為 dead 的模型直接不在清單裡**，不另設一份「不可用」名單：那樣的
  第二份清單會與選單不一致、會過期、也沒有任何好處。代價是無法從卡片看出
  某個模型為什麼消失——這是刻意接受的取捨。
- **dead 判定是最終的**：一旦判定，後續輪次不再探這個模型。理由是成本——每天
  為同一個已經有答案的問題再花一次共享額度，在這家 provider 上是 34 次與 10 次
  的差別。目錄（`current().models`）仍保留 dead 条目，這是必要而非整潔問題：
  `adopt` 會剪掉目錄裡已不存在的模型的判定，若把 dead 模型真的從 `models` 移除，
  它下次同步就會失去判定、當成新候選回來、再被探到同樣的答案。唯一的回頭路是
  手動刪除 `$DSH_HOME/dsh-opencode-free/catalog.json`，README 有寫。
- 面板另有「立即探測」按鈕繞過每日限制；使用者不點也會在讀取目錄時自動觸
  發一輪。
- 代價要講清楚：這是每天對共享的匿名額度桶多打 N 次請求（N = 目錄集
  合），已在 README 與 Cost Statement 披露。順序發送是刻意的限流手段。

**Consequences**

- 好處：新增免費模型自動出現；名稱與上限來自上游，不必手抄；免費層結束
  的模型會自己消失，不必等上游修 `status`。
- 代價：目錄檔案多了 `$DSH_HOME` 下一份插件私有快取；首次同步要下
  5.2MB；每天一輪探針請求。
- 監控：`scripts/reverify.sh` 仍是上游行為的漂移偵測器；models.dev 改
  schema 時症狀為「清單退回兜底基線」，由 catalog 的失敗降級路徑吸收。

**Retirement（隨本決策移除，不留相容分支）**

- `scripts/gen-client-models.mjs`（建置期把清單內聯進前端）
- `package.json` 的 `prebuild` hook
- `src/client.js` 的內聯 `MODELS` 常量（改讀宿主端點）
- `src/zen-provider.ts` 的手寫 synthetic 列表
- D2「`status ≠ deprecated` 才可見」規則（被上面的探針判據取代；
  `grep -c 'isActive(record)' src/catalog.ts` = 0）
- 面板「上游停止維護／已排除」灰字（連同 `excluded` 欄位整段移除：判定為
  dead 的模型直接不在清單裡，不另設名單去列舉它們；
  `grep -c 'opf-excluded' src/client.js` = 0）
