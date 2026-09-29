# Plan：以实测探测取代 status 判定模型显隐

- Parent spec: [.scratch/model-probe/spec.md](./spec.md)（已批准）
- Route: plan-writing（durable：可见性判据变更 + 新增每日外部请求 + 持久化字段）
- 执行路线（agent-team）：`probe-transport`(P1) → `probe-state`(P2) → {`probe-endpoint`(P3) ∥ `probe-panel`(P4)} → `probe-docs`(P5)；Lead 收口
- `User confirmation required: no`（范围已批准；提交为止，不 push、不发版）

## Aegis Visibility

可见性判据从「静态 status」换成「实测事实」，并新增每天一轮的对外请求与一条持久化字段；判据错一次就会让整个模型列表消失，所以 owner、判据边界与失败语义必须逐条钉死。

## Goal / Architecture / Tech Stack

- Goal：模型显隐由一次真实最小请求决定；`status` 只决定「是否在目录内」。
- Architecture：`zen-provider` 提供「发一次探针并给出三态结论」（复用既有身份/工具闸门/失败分类）→ `catalog` 持有结论、每日节奏、顺序调度与可见性收敛（复用既有缓存文件与状态容器）→ `index` 暴露手动端点与懒触发 → `client` 加按钮与新文案。
- Tech Stack：TS，手写 JS client bundle，无构建；Node fs 原子写（复用既有缓存层）；探测走 `provider.streamSimple`（不手搓 HTTP）。

## Baseline / Authority Refs（实测/源码为据）

- spec D1–D9 + Cost Statement
- **可复用（不重写）**：
  - `src/zen-provider.ts:263 applyAnonymousToolGate(context, apiKey)` —— 匿名请求已自动注入 `read`+`bash` 桩工具（§8 实测闸门），探针**直接走它**，不手搓 tools
  - `src/zen-provider.ts:332 classifyZenFailure(status, body)` —— 已有 `anon-gated | quota-exhausted | bad-key | unknown` 四态
  - `provider.streamSimple(...)` —— 身份四件套、header、错误指引映射均已在此路径
- **缺口**：`classifyZenFailure` 无「该模型不可用」这一类；`unknown` 目前只表示「不可归类」。D4 的 `dead` 需要**新增**一个正信号（见 P1）
- `src/catalog.ts`（上一 workstream 交付）：`createCatalog` / `current()` / `effectiveModels()` / `applyZenGate()` / 缓存 `{version,etag,fetchedAt,models}` / 单飞 + TTL
- `src/index.ts`：两条既有路由（`GET /api/catalog`、`POST /api/refresh`）与「读目录时 `void ensureFresh()`」的懒触发写法
- 顺序触发可参照 Zen 自身既有接缝 `provider.refreshModels`（同为「一次动作 + publish 落盘」）
- 探针形状依据：`docs/reverse-engineering.md` §8 + `scripts/test-live.mjs`（`maxTokens: 512`、30s 超时）

## Compatibility Boundary

- `hiddenModels` 语义、volatile、读-改-写保留未知 id、隐藏模型不可 resolve：**全部不变**
- 传输/身份/重试/encrypted-content 重放/compaction/attachment：**不动**
- 探测**只做减法**：不新增可见模型（D6d）
- 断网/被闸/超时：结论 `inconclusive` → 不落盘、可见性逐字不变
- 首日列表是今日的超集（含 deprecated），此后按结论收窄

## Change Necessity

不改代码则显隐仍由不可靠的 `status` 决定（已实证同时犯两种错）。最小边界 = zen-provider 加探针与新分类、catalog 加结论与调度、index 加一条端点与懒触发、client 加按钮与文案。无更小路径。

## Ripple Signal Triage

- 信号：**共享可见性状态**被 picker（`effectiveModels`）、面板端点、`refreshModels` 三处消费；新增持久化字段。
- Canonical owner：`src/catalog.ts`（结论与可见性唯一计算点）。`zen-provider` 只负责「发一次并给结论」，不持有跨模型状态。
- 源-of-truth 风险：若探针在 provider 侧也缓存 verdict，会出现两个 owner → 明确禁止，verdict 只进 catalog。
- 扩展验证进 P2：`effectiveModels()` ≡ 端点 `visible`（既有等价用例）+ 探测后仍等价。

## TDD Route

- `TDD Route: off` → decision `skipped`（本会话 Aegis TDD mode=off，无显式 strict 请求）
- 事后回归 + fixture 驱动单测（spec Testing Decisions），全部离线注入 fetch，不打真实网络
- 若你要 strict TDD，现在说，我把 P1–P2 改成 RED→GREEN

## Tasks

### P1 — 探针与新分类（`src/zen-provider.ts`）
- 新增结论类型（形状钉死，P2 依赖它）：
  ```ts
  export type ProbeOutcome =
    | { kind: "ok" }
    | { kind: "dead"; reason: string }
    | { kind: "inconclusive"; reason: string };
  ```
- 新增 `probeModel(model, deps)`：走 `provider.streamSimple(model, ctx, opts)`，`ctx` 只含一条极短 user 消息（`"Reply with OK only."`，与 `test-live.mjs` 同文案），`opts`：`maxTokens: 512`、`maxRetries: 0`、`signal: AbortSignal.timeout(30_000)`、沿用既有 `apiKey` 解析路径
  - **不得手搓 tools**：`applyAnonymousToolGate` 已在该路径内注入 `read`+`bash`
- 三态判定（**`dead` 必须是正信号，默认不成立**）：
  - `ok`：`stopReason !== "error"` 且 content 含非空 text
  - `inconclusive`：`classifyZenFailure` ∈ {`anon-gated`, `quota-exhausted`, `bad-key`, `unknown`}，或超时/网络异常/5xx
  - `dead`：**新增**「模型不可用」识别（HTTP 404/410，或报文明确指向该模型不存在/已下线/不再提供）——须新增分类分支而非复用 `unknown`；**额度耗尽不属于此类**（临时状态、非模型之过）
  - 顺序（**P1 实施时修正了本计划原字面顺序，以实现为准**）：有效文本应答 → `ok`；否则**先**排除更强的具体信号（被闸/额度/坏 key 报文标记，或 429/401 状态码）→ `inconclusive`；**再**判 `dead` 正信号；最后兜底 `inconclusive`
    理由：报文同时含额度标记与「模型不可用」措辞时，原顺序（先判 dead）会误杀，直接违反 D5。守卫断言：`isModelUnavailableFailure(429, 含 model 措辞的报文) === false`
  - `dead` 正信号**刻意写窄**：无真实死亡报文样本，首轮若措辞不符则该模型判 `inconclusive`（留在列表、面板提示不可信）而非误杀；以 P6 实测报文校准，不凭想象放宽
- Compat：既有 `classifyZenFailure` 的四个 kind 语义与返回类型**不得改变**（`compatibility.test.mjs` 断言其映射）；新增为向后兼容的扩展或独立函数
- Verify：`pnpm exec tsc --noEmit`；`compatibility.test.mjs` 11 条仍全绿

### P2 — D1 翻转 + 结论、节奏与可见性收敛（`src/catalog.ts`）
> **本任务范围在开工时被修正并扩入**（见下「D1 翻转」小节）：spec D1 与上一个 workstream 已提交的 `derive()` 过滤规则直接冲突。

#### D1 翻转（必须做，且是本任务的前置）

- 现状 `src/catalog.ts:157` 用 `if (!isActive(record))` 把 `deprecated` 排除出目录（上一个 workstream 的 D2 规则，已随 `56ec564` 提交）。
- 新 spec D1：目录 = `cost` 全 0 **且** `status ∈ {active, deprecated}`；付费与其他 status 值仍丢弃。
- 因此 `derive()` 必须改为**收进** deprecated 模型。`isActive()` 谓词保留（仍用于分类 active/deprecated 两类，且其既有单测保留）。
- **`excluded` 的定义随之改变**：旧 = 「免费但未提供（deprecated ∪ Zen 未在列）」；新 = **仅「探测判定 `dead` 的模型名」**。旧 bucket 整体消失。
- 「免费且 active 但 Zen 未在列」现在会同时离开 `visible` 与 `excluded`（与「上游整条删除」同命运）。**这是可接受的**：这类模型探测时会拿到 404/不再提供 → 落入 `dead` → 出现在 `excluded` 里，可解释性由探测恢复，不靠旧 bucket 兜。**不要为了保留可解释性而复活旧 bucket。**

##### 现有测试中「编码了旧规则、必须改写」的断言（逐条列出，实施者按此改）

- `tests/catalog.test.mjs:209-218` `derive splits free-active candidates from free-retired…` —— candidates 现应**包含**两个 deprecated；`excluded` 期望值不再是那两个 id
- `tests/catalog.test.mjs:339-346` 同上，走 `fetchSection` 集成路径
- `tests/catalog.test.mjs:519` `catalog.current().excluded` 期望含 deprecated id
- `tests/catalog.test.mjs:616` `state.excluded` 期望含 deprecated id

##### 现有测试中「与 D1 无关、必须原样保留」的守卫（一条都不许删改）

- `:203-206` `isActive retires only status=deprecated`
- `:222-224` 付费模型（`gpt-6-astra`）必须被丢弃 —— D1 仍丢弃付费
- `:323-332` provider 记录喂 `derive()` 必须得到空 —— 上一 workstream 阻塞缺陷的回归守卫
- 其余通道推导 / limits 映射 / 缓存 / ETag / 降级 / 闸门等既有用例

#### 探测机制（原 P2 范围，不变）

- 缓存新增可选字段 `probes: Record<id, {verdict:"ok"|"dead"; at:number; reason?:string}>`；读写往返；**`inconclusive` 永不落盘**；`version` 保持 1
- `runProbes():Promise<void>`：对 `current().models`（闸门前的目录全集）`for…await` 顺序串行，不并发不分批
- 每日至多一轮自动（以 `probes` 最新 `at` 与注入 `now` 的本地日历日比较）；`forceProbes()` 忽略日限
- 单飞：并发共享同一轮 promise
- 每探完一个即更新内存 verdict，**轮次结束统一原子落盘**（半轮不得被读成完整结论）
- `effectiveModels()` = （目录 ∩ Zen 在列）再减去 `dead`
- `current()` 快照新增 `probedAt?: number`、`probeInconclusive?: boolean`
- 验证：`tsc` 通过；`tests/catalog.test.mjs` 全绿（既有断言只按上表改写，行为覆盖不得减少；新增三态收敛、D5 守卫、顺序性、日限与手动绕过、单飞、落盘往返、缺字段=无历史）
- 注意：不得触碰 `src/zen-provider.ts`、`src/index.ts`、`src/client.js`、`docs/`、`README*`
- 新增 `probeRunner` 能力（钉死）：
  - `runProbes(): Promise<void>` —— 对派生目录**全集**（`current().models`，闸门前）**按顺序**逐个 `probeModel`（串行 `for…await`，不并发、不分批）
  - 每日至多一轮自动：以 `probes` 中最新 `at` 与本地日历日比较（用注入的 `now`，便于测试）；手动 `forceProbes()` 忽略日限
  - 单飞：并发调用共享同一轮 promise
  - 每探完一个即更新内存 verdict 并**按轮次结束统一原子落盘**（避免半轮状态被读成完整结论）
- 可见性收敛：`effectiveModels()` = 现有（目录 ∩ Zen 在列）**再减去** verdict 为 `dead` 的 id
- 快照扩展：`current()` 增加 `probedAt?: number`、`probeInconclusive?: boolean`（本轮出现 inconclusive 时为 true，供面板提示「结论不可信」）
- Compat：`hiddenModels` 过滤在 `index.ts` 侧叠加，不动此层逻辑
- Verify：`tests/catalog.test.mjs` 新增用例 —— 三态收敛、**D5 守卫**（全集 403 FreeTimerError → 可见性逐字不变且无落盘）、顺序性（断言请求串行不重叠）、日限与手动绕过、单飞、落盘往返、缺字段=无历史
- 注意：P2 依赖 P1 的 `ProbeOutcome` 形状，**P1 完成并通过验证后再开工**（上一 workstream 的形状不匹配教训：生产者/消费者不可并行）

### P3 — 端点与懒触发（`src/index.ts`）
- 新增 `POST /dsh-opencode-free/api/probe` → `await catalog.runProbes()` 后返回与 `/api/catalog` 同形状快照；非 POST → `405`；**沿用既有写路由的同源校验（403）**，不新造一套
- 懒触发：既有「读目录时 `void catalog.ensureFresh()`」处，追加「目录已非 `builtin-fallback` 且今日无轮次 → `void catalog.runProbes()`」，**fire-and-forget 且 `.catch(() => undefined)`**（探测失败绝不影响 provider 注册）
- Compat：既有两条路由与 `hiddenModels` 过滤不动
- Verify：端点 payload ≡ `/api/catalog` 形状；405/403；懒触发不阻塞；探测抛错时 `registerAdapter` 仍成功

### P4 — 面板按钮与文案（`src/client.js`）
- 新增「立即探测」按钮 → `POST '/dsh-opencode-free/api/probe'` → 用返回快照重绘（与既有「立即刷新」同模式：busy 时 disabled、失败时按钮即重试）
- 灰字区语义改为「探测判定失败」（`excluded` 字段复用，不新增字段名）
- 新增文案：`probe` / `probing` / `probeUntrusted`（本轮 inconclusive 提示）/ 灰字标题改为「探测判定不可用」；zh/en key 集合必须一致（沿用既有校验方式）
- Compat：`QuietBoundary` / `LocaleLive` / slot 注册 / 读-改-写 toggle 全部不动
- Verify：`node --check`；smoke grep；zh/en key 对齐

### P5 — 测试与文档（`tests/`、`docs/`、`README*`）
- 探针形状守卫用例：断言实际请求体含 `read` 与 `bash` 工具名、streaming、`max_tokens ≥ 512`（spec Testing Decisions 的核心守卫，缺任一即红）
- 三态分类用例：`ok` / `dead`（正信号报文）/ `inconclusive`（403 FreeTierError、429、5xx、超时）
- 修订 `docs/adr/0002-catalogue-source-of-truth.md` 的可见性判据节（**修订而非新增 0003**）：status 由闸门降级为「是否在目录内」，可见性由探测决定
- `docs/spec-v0.2.md`：把「不做背景自动刷新」标注为被本 spec 显式取代（并写明每日一轮、顺序发送、落在共享桶）
- `README.md` / `README.zh-TW.md`：**如实披露每日探测的额度代价**、inconclusive 不改列表、用户可随时不点/关掉；灰字说明改为「探测判定不可用」
- `scripts/test-live.mjs`：加一行注释指向新探测路径（其不带 tools 的探针在匿名层必然 403，勿被误用为可用性判据）
- Verify：`pnpm test` 全绿且行为用例不减少；文档无「不做后台刷新」类过期表述

### P6 — 收口（Lead）
- `pnpm exec tsc --noEmit` → `pnpm test` → 退役检查 → 一次真实探测（`DSH_HOME` 指临时目录）确认：全集 34 顺序探、`muse-spark-1.2-contributor-free` 探活、`deepseek-v4-flash-free` 探死、结论落盘
- 一个 scoped commit，不 push

## Verification 汇总

`tsc` 全绿 · `pnpm test` 全绿（行为用例不减少）· 探针形状守卫用例在 · D5 守卫用例在 · 真实探测四项目标观测达成 · ADR 0002 已修订 · 文档已披露额度代价

## Risks

- R1 **一次 IP 被闸导致列表清空**：由 D5 + P2 守卫用例挡住（三态里 `inconclusive` 覆盖 anon-gated 且不落盘）
- R2 探针形状不达标产生假阴性：P5 形状守卫用例直接断言请求体三项
- R3 `dead` 误判（把 key 失效当模型死）：`bad-key` 明确归入 `inconclusive`，不进 `dead`
- R4 每日 34 次请求的额度代价：已在 Cost Statement 与 README 披露；顺序发送为限流；用户可只手动
- R5 探测与既有 `refreshModels` 争用 Zen：两者都串行且各自独立，探测不写 Zen 侧状态

## Retirement

| 对象 | 处置 | 移除检查 |
|---|---|---|
| D2「非 deprecated 才显示」 | 被 D6 取代 | `docs/adr/0002` 同节已修订 |
| 面板「deprecated 灰字」文案 | 改「探测判定失败」 | `grep -c "已停止维护" src/client.js` = 0 |
| spec-v0.2「不做背景自动刷新」 | 标注被显式取代 | 该文件含取代标注 |
| `test-live.mjs` 被当作可用性判据的用法 | 加注释纠正 | 注释在位 |
