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
被寫成同一個值。任何外部資料源都無法自動分辨這兩種情況——這是本決策
的已知邊界，不是可以靠換資料源解決的問題。

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

- 免費判定：`cost` 全零。預設可見：免費且 `status ≠ "deprecated"`。
- 可用性閘門：與 Zen `/models` 在列求交集；Zen 抓取失敗時保持現有清單，
  不收窄。交集只算一次，模型選單與詳情頁讀同一份快照。
- 通道推導三級：Pi 內建表命中 → models.dev 訊號（有 `interleaved` 或
  `reasoning_options=[{type:"toggle"}]` 為 completions；`effort` 為
  responses）→ 兜底 completions（依據 `provider.npm =
  "@ai-sdk/openai-compatible"`）。已對 7 個已知模型驗證 7/7 吻合。
- 快取：`$DSH_HOME/dsh-opencode-free/catalog.json`，只存 models 段（不存
  provider 包裝層），臨時檔＋rename 原子寫，附 ETag 做條件重驗證。
- 失效：讀目錄時若快取超過 24h 則背景重拉，不阻塞當次請求，不設定時器
  （延續 v0.2「不做背景自動刷新」的決定）。
- 降級：無網路、無快取、畸形回應 → 退回 Pi 內建免費集。任何失敗都不得
  讓模型選單變空。

**Consequences**

- 好處：新增免費模型自動出現；名稱與上限來自上游，不必手抄。
- 代價：目錄檔案多了 `$DSH_HOME` 下一份插件私有快取；首次同步要下
  5.2MB；`status` 歧義導致部分仍可用模型被排除（面板底部列出被排除者名
  稱，使用者需自行以 key 或等上游恢復）。
- 監控：`scripts/reverify.sh` 仍是上游行為的漂移偵測器；models.dev 改
  schema 時症狀為「清單退回兜底基線」，由 catalog 的失敗降級路徑吸收。

**Retirement（隨本決策移除，不留相容分支）**

- `scripts/gen-client-models.mjs`（建置期把清單內聯進前端）
- `package.json` 的 `prebuild` hook
- `src/client.js` 的內聯 `MODELS` 常量（改讀宿主端點）
- `src/zen-provider.ts` 的手寫 synthetic 列表
