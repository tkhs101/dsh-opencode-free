# Plan：插件详情页模型显隐面板（一期）

- Parent spec: [.scratch/model-visibility/spec.md](./spec.md)（已批准，approach A1）
- Route: plan-writing（durable plan：新增 owner + 持久化 contract）
- Execution route: **inline**（任务顺序依赖、单 owner，subagent 协调无收益；工作区干净）
- `User confirmation required: no`（workstream 已批准；加法变更；提交为止，不 push、不发版）

## Aegis Visibility

新增持久化 contract（`Config.hiddenModels`）+ 新 owner（`src/client.js` 详情页卡片）+ picker 可见行为变化，值得一份 durable plan 来锁 owner、兼容边界与验证。

## Goal / Architecture / Tech Stack

- Goal：详情页 DSH 风格卡片，一期 12 行模型 Switch，开关经 Plugin Config 持久并控制 picker 显隐。
- Architecture：host 存状态（Config `hiddenModels`）+ 启动时包过滤视图（`getModels` 过滤，`refreshModels` 透传）→ `PiAiAdapter profiles()` 下一 operation 生效；client 为无构建手写 `__ModuleLoader__` bundle，只读写 `configForms`。
- Tech Stack：TS（host）+ 手写 JS（client，`React.createElement`，原生 elements + 内联 CSS，gitbash 同模式）+ schemastery（Config schema）+ tsx（测试/生成脚本）。

## Baseline / Authority Refs

- Required：`.scratch/model-visibility/spec.md`（批准）、`src/index.ts`（`inject=["llm"]` 不动、`ctx.get("attachments")` 不动）、`src/zen-provider.ts`（`freeModels()` 基线 7 模型 + `refreshModels` 交集语义）、`package.json`（bundle patch、scripts 生命周期）、`tsconfig.json`（`include: src/**/*.ts` —— client.js 不进 tsc）。
- Cited：gitbash-shell `src/client.js`（slot `plugins.bundle.config` key=包名；`configForms.get(ns)` ns=插件 row id；原生 elements + 内联 CSS + QuietBoundary + LocaleLive；require 白名单 react + ui-primitives）、`src/shell.js`（“row id doubles as namespace”；Config 字段用 `.default()` 表可选）、schemastery `src/index.ts`（`array(inner)` 存在；无 `.optional()`，可选语义用 `.default()`）、官方 `dsh-llm-pi-ai`（`PiAiAdapter` 无 hidden 参数；`resolveAttachments` 官方写法已对齐）。
- Probe 结论（已做，不再是 open）：
  - P1（configForms ns）：`opencode-free`（cordis id = 插件 `name` = row id）；slot key 用包名 `dsh-opencode-free`。
  - P2（ui-primitives）：一期不需要其组件，抄 gitbash——原生 elements + 内联 CSS；`require("@deepseek-ai/dsh-client-ui-primitives")` 保留（白名单 + icon 防御查找）。
  - P3（schema 可选数组）：`z.array(z.string()).default([])`（本仓 schemastery 无 `.optional()`；spec 中 `.optional()` 写法作废，以本 plan 为准，已同步改 spec）。

## Compatibility Boundary

- 老 Config 无 `hiddenModels` → 全显；缺省/空数组 = 全显。
- 未知/已下架 id：保留存储，不报错，client 不渲染（回归仍隐藏）。
- `PROVIDER_ID`、Zen 身份、传输、重试、attachment 修复、side-channel patches：全部不动。
- `lib/` 仍 gitignored；发包 `files` 新增 client 文件。

## Change Necessity

picker 可见性由 provider models 经 `PiAiAdapter` 驱动，无现成开关；docs/config-only 改不动行为。最小代码边界：`src/index.ts`（1 字段 + 过滤视图）+ 新 `src/client.js`（卡片）+ 小生成脚本 + `package.json` 接线。无更小路径。

## Ripple Signal Triage

- 信号：共享 picker 行为（producer=provider catalogue，consumer=picker 经由 adapter `listModels`/`resolveModel`）。Canonical owner：`src/index.ts apply()`。
- 隐藏 = 不可用（通用不可用错误，一期不定制文案）；auth/credential 路径不受影响（`resolveApiKey` 不动）。
- 扩展验证进 Task 5：隐藏模型 `resolveModel` 失败断言 + 未知 id 忽略断言。

## TDD Route

- `TDD Route: off`, decision `skipped`，authority：Aegis 默认 off，无显式 strict 请求。
- Test posture：最小变更 + 事后回归（现有 11 测试全过 + 新增 Task 5 断言 + client smoke）。无 RED/GREEN 仪式。

## Tasks

### T1 — Host：Config + 过滤视图（`src/index.ts`）

- Purpose：状态持久 + picker 显隐生效。
- Change：
  1. `Config` 接口加 `readonly hiddenModels?: readonly string[] | undefined`；schema 加 `hiddenModels: z.array(z.string()).default([])`。
  2. `apply` 内解析 `Set`（trim、去空、去重）。
  3. 构造过滤视图（`getModels` 过滤、`refreshModels` 透传；若对象展开丢失行为则改用原型委托——实现时以测试为准），`authModels.setProvider(filtered)` 且 `profile.piProvider = filtered`。
- Compat：缺省全显；其余逻辑逐行不动。
- Verify：`pnpm exec tsc --noEmit`（exit 0）。

### T2 — 生成脚本 + 构建接线（新 `scripts/gen-client-models.mjs`，改 `package.json`）

- Purpose：client 的 `MODELS` 常量与 `freeModels()` 基线同源。
- Change：脚本读 `freeModels().map(id)`，写 `src/client.js` 头部 `MODELS = [...]` 段（幂等、可重复跑）；`package.json` 加 `"prebuild": "tsx scripts/gen-client-models.mjs"`（`build` 仍是 `tsc`，`pretest`/`prepack` 自动受益）。
- Verify：`pnpm run build` 后 `grep MODELS src/client.js` 含 12 个 id。

### T3 — Client 卡片（新 `src/client.js`，约 200 行）

- Purpose：详情页控制面板 UI。
- Change（抄 gitbash 结构，全部模块顶层、手写、`createElement`）：
  1. 单次 `window.__ModuleLoader__.load({ id: "dsh-opencode-free", factory })`；`exports.inject = ["locale", "slots"]`。
  2. `apply` 内懒取 `configForms.get("opencode-free")`（缺失不拖卡片）；`slots.inject("plugins.bundle.config", () => slots.register({ name: "plugins.bundle.config", key: "dsh-opencode-free", locale: "opencodeFree", inject: () => ({ scope, ctx }) }, Card))`。
  3. `Card`：标题 + 12 行（模型 id + Switch/checkbox）+ hint；`scope` 快照读 `hiddenModels`，写回整数组（保留未知 id：读-改-写时合并，不覆盖丢弃）；`QuietBoundary` + 语言切换重绘（`locale.subscribe`，gitbash `LocaleLive` 精简版）；`zh/en` 内联字典（模型 id 不翻译）；内联 `<style>`（`opf-` 前缀防冲突）。
- Verify：`node --check src/client.js` + smoke grep（单次 load、白名单 require、slot key、`opencode-free` ns）。

### T4 — 打包接线（`package.json`）

- Change：`exports["./client"] = "./src/client.js"`；`dsh.client = { inject: ["@deepseek-ai/dsh-client-runtime", "@deepseek-ai/dsh-client-locale", "@deepseek-ai/dsh-client-ui-slots", "@deepseek-ai/dsh-client-ui-settings"], platform: "web" }`；`files[]` 加 `"src/client.js"`（及脚本不进包）。
- Verify：`node -e "JSON.parse(require('fs').readFileSync('package.json'))"` 通过；`pnpm pack --dry-run` 列表含 `src/client.js`（以实际输出为准）。

### T5 — 回归测试（新 `tests/model-visibility.test.mjs`）

- Cases（沿用 `compatibility.test.mjs` 的 fakeCtx + 真 `PiAiAdapter` 模式）：
  1. `hiddenModels: ["big-pickle"]` → `listModels(PROVIDER_ID)` 无此 id，其余 6 个在。
  2. 缺省/空数组 → 12 个全在。
  3. 未知 id（`"no-such-model"`）→ 不炸，12 个全在且存储保留（读回 `hiddenModels` 原样——经 `apply` 的 Config 视角断言，或 client 合并逻辑单测，取易实现者）。
  4. 隐藏模型 `resolveModel` → 失败（通用不可用，断言 reject/错误，不定死文案）。
- Verify：`pnpm test`（含现有 11 个）全过。

### T6 — 手动 + 提交

- Manual（用户侧 DSH，需重启一次）：web profile 装包 → 详情页卡片出现 → 关一个模型 → picker 消失 → 重开恢复 → 重启 DSH 状态保持。
- 提交：`TaskStartSnapshot`（`git status`）→ 全量 `pnpm run check`（typecheck + test + pack）→ 一个 scoped commit（`git add` 仅本 task 文件，`.scratch` spec/plan 是否入仓按用户习惯——默认纳入本次 commit 说明设计已批）。不 push。

## Verification（汇总）

`pnpm exec tsc --noEmit` → `pnpm test`（11+4）→ `node --check src/client.js` + smoke grep → `pnpm pack --dry-run` → 用户侧手动 picker/重启 → scoped commit。

## Risks

- R1 `...provider` 展开丢失原型行为 → Task 5 会暴露，预案原型委托；不改 design。
- R2 真机 `configForms` ns 若非 `opencode-free` → 卡片空态提示（不崩），按宿主日志修正一行常量；行话：gitbash row-id 规则证据较强，风险低。
- R3 `prebuild` 生命周期若未触发 → 改为 `build: "tsx scripts/gen-client-models.mjs && tsc"` 显式串行。

## Retirement

- 无。加法变更；旧行为（全量列表）= 空 `hiddenModels` 默认保留。A2（定制错误）/A3（目录契约）保持 defer，不建兼容分支。
