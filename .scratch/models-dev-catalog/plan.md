# Plan：模型目录跟随 models.dev

- Parent spec: [.scratch/models-dev-catalog/spec.md](./spec.md)（已批准）
- Route: plan-writing（durable：owner 变更 + 持久化 + 契约面 + 退役）
- 执行路线（agent-team）：`catalog-core`（T1–T3，同一文件必须单 owner）→ `host-wire`（T4–T5）→ `panel-retire`（T6–T7）→ `tests-docs`（T8–T9）；T10 由 Lead 收口
- `User confirmation required: no`（范围已批准；加法+退役；提交为止，不 push、不发版）

## Aegis Visibility

目录的 source-of-truth 从依赖内置表换成外部数据源 + 自建缓存 + 两个 HTTP 端点，同时退役三条旧路径；owner、失效口径、验证边界都变了，值得 durable plan 锁死。

## Goal / Architecture / Tech Stack

- Goal：模型目录自动跟随 models.dev，picker 与详情面板一致，离线可用，退役手工维护。
- Architecture：`src/catalog.ts`（新 owner：抓取+缓存+派生+降级，纯函数可测）→ `zen-provider`（传输/身份，只读 catalog 派生结果）→ `index.ts`（生命周期编排 + 两个 webServer 端点）→ `client.js`（面板读端点）。Zen `/models` 仍是最后一道可用性闸门。
- Tech Stack：TS（host）、手写 JS client bundle（无构建）、Node `fs` 原子写、`AbortSignal.timeout`、注入式 `fetch`（测试无真网络）。

## Baseline / Authority Refs（均为本机/上游实测，非推测）

- spec D1–D12（本计划全部决策来源）
- `freeModels()` 现状与 synthetic 列表：`src/zen-provider.ts:34`、`:761`（`refreshModels` 以它为交集基线）
- 通道推导 7/7 吻合：已对 7 个已知模型核对 `interleaved` / `reasoning_options` 与 pi-ai `api`
- 兜底通道证据：`opencode.provider.npm = "@ai-sdk/openai-compatible"`（api.json 实读）
- `jev-1.13-free` 在 api.json 中不存在（`cost` 仅两项，不满足全 0）→ 随切换消失
- **宿主无 `refreshModels` 调用方**（全仓 grep 仅命中 Models 设置页自身 store 刷新）→ 同步必须自持
- `api.json`：5.2MB / 225 provider / opencode 段 113 模型；`ETag` + `must-revalidate` + `ACAO:*`；**无** per-provider 端点（3 条候选全 302/404）
- 端点模式先例：`dsh-gitbash-shell/src/index.js:2160-2193`（`ctx.inject(['webServer'])` → `register({kind:'prefix'})` → dispose）
- 缓存路径先例：`dsh-pocket` 的 `$DSH_HOME/dsh-pocket/settings.json`
- 会被本次波及的硬编码：`README.md:80-85`、`README.zh-TW.md:77-82` 的 7 模型表；`docs/reverse-engineering.md:136` 的目录来源表述
- 不受影响：`compatibility.test.mjs` 只断言 `pkg.dsh.client` 与 `exports`，不碰 `inject`/`scripts`

## Compatibility Boundary

- `hiddenModels` 语义、volatile、读-改-写保留未知 id、隐藏模型不可 resolve：**全部不变**
- 传输/身份四件套/重试/encrypted-content 重放/compaction/attachment 修复：**不动**
- 断网、无缓存、畸形响应 → 兜底基线（pi-ai 内置免费集）可用；目录失败永不影响插件可用性
- 端点不回显任何配置值；缓存文件不含凭据
- `freeModels()` 导出名保留，语义变为「当前派生目录」（启动瞬间 = 兜底基线）

## Change Necessity

无代码改动则目录仍需手工补 synthetic（已发生两轮），且 models.dev 元数据拿不到。最小边界 = 新增 `src/catalog.ts` + 3 处接线 + 1 端点对 + 3 条退役。docs-only 不可行（行为源在代码）。

## Ripple Signal Triage

- 信号：共享目录状态被 picker（`listModels`/`resolveModel`）、面板端点、`refreshModels` 三处消费；cache 是新持久化面。
- Canonical owner：`src/catalog.ts`。`zen-provider` 与 `index` 只消费，不各自派生（防双 owner）。
- 源-of-truth 风险：models.dev 派生 vs Zen 交集若各算一次会不一致 → 交集只在 catalog 内算一次，端点与 picker 读同一份快照。
- 扩展验证进 T5：端点 `visible` ≡ `listModels` 断言。

## TDD Route

- `TDD Route: off` → decision `skipped`（本会话 Aegis TDD mode=off，无显式 strict 请求）
- 事后回归 + fixture 驱动单测（spec Testing Decisions）。不写 RED/GREEN 仪式。
- 若你要 strict TDD，现在说，我改写 T1–T3 的步骤为 RED→GREEN。

## Tasks

### T1 — 派生纯函数（`src/catalog.ts` 新建）
- 输入/输出契约（实现须逐条满足）：
  - `isFree(record)`: `record.cost` 为对象且 `Object.values(cost).every(v => v === 0)`
  - `isActive(record)`: `record.status !== "deprecated"`
  - `channelFor(record, knownApis)`: ① `knownApis.get(id)` 命中即用；② `record.interleaved` 存在 或 `reasoning_options` 含 `{type:"toggle"}` → `openai-completions`；`reasoning_options` 含 `{type:"effort"}` → `openai-responses`；③ 兜底 `openai-completions`
  - `derive(section, { knownApis, template })` → `{ candidates: Model[], excluded: string[] }`；`candidates` = 免费且 active；`excluded` = 免费但非 active 的 id（排序稳定）
  - 元数据：`name` → `record.name ?? id`；`limit.context` → `contextWindow`；`limit.output` → `maxTokens`；缺任一 → `template` 同字段；`modalities.input` → `input`；`reasoning`/`tool_call` 直传；`cost` 归零；`provider`/`baseUrl`/`headers` 走既有 `STATIC_ZEN_HEADERS` 逻辑
  - 记录缺失/字段类型异常 → 跳过该模型，不抛
- Compat：纯新增，无既有行为影响。
- Verify：`tests/catalog.test.mjs` fixture 断言（含 deprecated 排除、通道 7/7 已知表、limits 映射、畸形记录跳过）。

### T2 — 抓取与缓存（`src/catalog.ts`）
- `fetchSection({ fetchImpl, etag, timeoutMs = 10_000, maxBytes = 20 * 1024 * 1024 })` →
  `{ kind: "not-modified" }`（304）| `{ kind: "ok", etag, section }` | `{ kind: "failed", reason }`（非 2xx / 超时 / 解析失败 / 缺 `opencode` 对象 / 超 maxBytes）
- URL `https://models.dev/api.json`；headers：`accept: application/json`、有 etag 时 `if-none-match`、**UA 用 `dsh-opencode-free/<version>`，不得复用 Zen 的 OpenCode 身份 UA**（models.dev 不是 Zen，仿冒无意义且误导）
- **R5 防护**：缓存文件不存在时**绝不**发送 `if-none-match`（否则 304 无缓存可还原）
- `cachePath()` = `$DSH_HOME/dsh-opencode-free/catalog.json`（`DSH_HOME` 缺省 `~/.dsh`）
- `readCache(path)`：JSON 解析失败或 `version !== 1` → `null`
- `writeCacheAtomic(path, rec)`：写临时文件 + `rename`；只存 `{version, etag, fetchedAt, opencode}`
- Verify：同 T1 文件新增用例（200/304/超时/畸形/超限/无 opencode 段、缓存往返、损坏缓存、缺文件时不发 etag）。

### T3 — 目录状态容器（`src/catalog.ts`）
- `createCatalog({ cachePath, fetchImpl, now, ttlMs = 86_400_000, knownApis, template, builtinBaseline })`
  - `builtinBaseline` 为**必填**（plan 初稿漏列）：D8 的离线兜底需要整份内置免费集，而非单条 `template`
- `current()`（同步）→ `{ models, visible, excluded, source, updatedAt, refreshing }`；`models` 是**闸门前**目录（供 `refreshModels` 求交集）
- `effectiveModels()`（同步）→ **闸门后**列表；`current().visible` 与之恒等。**验收断言 1 的单一 owner**：provider 的 catalogue 与端点 `visible` 都读它，禁止两处各算一次交集
- `ensureFresh()`：超 TTL 且无在途 → **fire-and-forget** 后台同步（不 await 当次读）；有在途 → 直接返回
- `forceRefresh()`：忽略 TTL，等待完成
- 单飞：并发调用共享同一 promise
- 失败：保留当前目录；无缓存 → 保持兜底基线，`source` 不变
- `applyZenGate(ids | null)`：`ids` 非 null → 闸门置为 `ids`；`null`（Zen 失败）→ **保留既有闸门，不收窄**（D3）
- **warm start 是异步的**：`readCache` 为 fire-and-forget promise，新进程里 `current()` 需过一个微任务才反映磁盘缓存；启动瞬间为 `builtin-fallback` 属预期
- `template` 必须是**已做身份映射**的 pi-ai 记录（含 `PROVIDER_ID` / `BASE_URL` / `STATIC_ZEN_HEADERS`）；catalog 刻意不 import 任何 Zen 身份常量，避免与 `zen-provider` 循环依赖
- `PLUGIN_VERSION` 为手写常量（本仓无构建期 JSON 导入），发版需同步；`createCatalog` / `fetchSection` 均支持 `userAgent` 覆盖
- Verify：TTL 边界、single-flight、失败保旧、兜底基线、Zen 闸门增删 excluded。

### T4 — provider 改接目录（`src/zen-provider.ts`）
- `freeModels()` → 返回 `catalog.current().models`（无 catalog 时回退原内置路径，保证既有调用不炸）
- `zenProvider(getSessionId, getConfigKey, opts?: { catalog })`（第三参可选，向后兼容既有测试调用）
- `refreshModels`：`const baseline = catalog.current().models`（替 `freeModels()`）；交集逻辑不变；成功后 `catalog.applyZenGate(ids)`
- **删除** synthetic 列表与其注释块
- Compat：传输/身份/重试路径零改动。
- Verify：`tsc` 过；既有 `catalogue refresh intersects live ids and survives failure` 用例仍过。

### T5 — 生命周期编排与端点（`src/index.ts`）
- 建 catalog（注入 `fetchImpl = fetch`、`now = Date.now`），传给 `zenProvider`
- 懒重验证：过滤视图的 `getModels` 内 `void catalog.ensureFresh()` 后返回当前 models（fire-and-forget，不阻塞）
- `inject` → `["llm", "webServer"]`
- `ctx.inject(["webServer"])` 注册两条：`GET /dsh-opencode-free/api/catalog`（只读快照）、`POST /dsh-opencode-free/api/refresh`（`forceRefresh` 后返回快照）；其余方法 `405`；dispose 随 fiber
- 响应体 = `catalog.current()` 的公开子集（`models` 不外传完整记录，只出名称数组 + 元信息）
- Compat：`hiddenModels` 过滤、attachments 修复、side-channel patches 全部不动。
- Verify：端点 payload 形状；`visible` ≡ `adapter.listModels()`；405 分支；响应体不含 `apiKey`（断言字符串不含）。

### T6 — 面板改造（`src/client.js`）
- 删除内联 `MODELS` 块与 `gen-client-models` 标记
- 挂载时 `fetch("/dsh-opencode-free/api/catalog")`；行 = `visible`，逐行开关写 `hiddenModels`（沿用既有读-改-写，保留未知 id）
- 「立即刷新」按钮 → `POST .../refresh` → 用返回快照重绘
- 底部灰字列 `excluded`（纯文字）
- loading / 拉取失败 / `source === "builtin-fallback"` 三态各有可读文案（新增字典 key，zh/en 对齐）
- Compat：`QuietBoundary` + `LocaleLive` + slot 注册方式不变。
- Verify：`node --check` + smoke grep（单次 load、白名单 require、slot key、无 `MODELS`）。

### T7 — 退役构建期生成
- 删 `scripts/gen-client-models.mjs`；`package.json` 移除 `prebuild`（`build` 回到仅 `tsc`）
- Verify：`pnpm run build` 输出仅 `tsc`；`git ls-files scripts/gen-client-models.mjs` 为空；`grep -c MODELS src/client.js` = 0；`grep -c synthetic src/zen-provider.ts` = 0

### T8 — 测试对齐新 owner（`tests/`）
- `tests/catalog.test.mjs`（新建，承载 T1–T3 全部 fixture 用例）
- `tests/model-visibility.test.mjs`：**删除**「pinned at 11 models」及 synthetic id 断言；`baselineIds` 改为「不依赖具体目录内容」的比对方式（如用 `adapter.listModels()` 自身集合做差）；**保留**全部行为用例（过滤/trim/去重/缺省全显/未知 id/隐藏不可 resolve/volatile 解包/volatile 断言/synthetic→改为目录派生 resolve）
- `tests/compatibility.test.mjs`：无需改（不碰 inject/scripts）；若 `free catalogue is non-empty` 语义变化则最小调整
- Verify：`pnpm test` 全绿（既有行为用例数不减少）。

### T9 — 文档同步
- `README.md` / `README.zh-TW.md`：7 模型硬编码表 → 「目录跟随 models.dev」说明 + 当前清单（标注 deprecated 处理规则与离线兜底）
- `docs/reverse-engineering.md:136`：目录来源表述更新为新接缝
- 新增 `docs/adr/0002-catalogue-source-of-truth.md`（来源、真实替代方案、缓存/失效口径、退役记录）
- `docs/spec-v0.2.md`：标注其「目录维持打包基线＋公开端点交集」决策已被 0002 取代
- Verify：grep 全仓无过期模型表残留；ADR 存在且含替代方案与退役记录

### T10 — 收口（Lead）
- `pnpm exec tsc --noEmit` → `pnpm test` → `pnpm run build` → 退役四项 grep 检查
- 用户侧手动：刷新面板看到新目录；断网（可关网络/改 hosts）启动仍可用兜底基线；隐藏开关仍生效
- 一个 scoped commit（不 push）

## Verification 汇总

`tsc` 全绿 · `pnpm test` 全绿且行为用例不减少 · 退役四项 grep 为零 · 端点 ≡ picker 一致 · 断网兜底可用 · ADR 落地。

## Risks

- R1 首次同步 5.2MB 解析瞬时内存（~50MB）：只解析一次并只留 opencode 段，20MB 上限兜底
- R2 models.dev schema 漂移：派生全部防御式读取，异常 → 保留缓存（D8）
- R3 新模型通道猜错：表现为模型错误 + 既有指引；自动改道为 non-goal（已批准）
- R4 端点路径冲突：prefix 含包名，不会撞
- R5 etag 与缓存文件不同步：**已前置防护**（T2：无缓存不发 etag）

## Retirement

| 对象 | 动作 | 移除检查 |
|---|---|---|
| `scripts/gen-client-models.mjs` | 删文件 | `git ls-files` 空 |
| `package.json` `prebuild` | 删字段 | build 输出仅 tsc |
| `src/client.js` 内联 `MODELS` | 删块 | `grep -c MODELS` = 0 |
| `zen-provider.ts` synthetic 列表 | 删块 | `grep -c synthetic` = 0 |
| `zen-provider.refreshModels` | **不退役**（仍是 Zen 闸门归属地，spec D12） | — |

> **Superseded.** 本文件是历史推理，已落地。当前事实见
> [`docs/adr/0002-catalogue-source-of-truth.md`](../../docs/adr/0002-catalogue-source-of-truth.md)
> 与 [`CHANGELOG.md`](../../CHANGELOG.md)；已知矛盾见 [`../README.md`](../README.md)。
