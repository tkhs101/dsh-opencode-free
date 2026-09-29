# Spec：插件详情页模型显隐面板（一期：模型列表）

## Status

- state: draft（待用户评审）
- approved approach: A1（Config `hiddenModels` + host 过滤 provider 视图 + client 内嵌基线列表）
- prior scope note: `docs/spec-v0.2.md` Out of Scope 曾排除“設定頁／client UI”；本次为范围扩张，需本 spec 批准即视为批准扩张

## Problem Statement

`opencode-zen-free` 一次给出 11 个免费模型，picker 常年全量展示，用户无法精简常用模型。
期望：在截图的插件详情页（DSH 风格）加一块控制面板，一期只做模型列表功能区，每行一个开关，控制模型显隐。

当前 11 个模型（`freeModels()` 基线）：

- `big-pickle`
- `ling-3.0-flash-fin-free`
- `mimo-v2.5-free`
- `nemotron-3-ultra-free`
- `nemotron-3.5-lightning-free`
- `muse-spark-1.2-contributor-free`
- `muse-spark-1.3-contributor-free`
- `mimo-v2.6-flash-free`（合成：pi-ai 0.87 已收录同形记录，api/limits 交叉验证）
- `deepseek-v4-flash-free`（合成：limits 取 models.dev，api 取 completions 默认）
- `space-bunny-free`（合成：同上）
- `longcat-2.5-preview-free`（合成：limits 未公布，沿模板默认值）
- `jev-1.13-free`（合成：同上）

## User Stories

1. 作为对话用户，我想在插件详情页看到模型列表及每行开关，以便隐藏不用的模型。
2. 作为对话用户，我把开关关掉后，模型选择器里不再出现该模型；重新打开后恢复可见。
3. 作为老用户，我不改任何配置时行为不变（默认全显，零迁移）。
4. 作为维护者，我希望隐藏项在模型下架后仍保留（回来仍隐藏，不惊喜复活），未知 id 不清洗。

## Decisions（已定）

- D1 持久化：Plugin Config 新增 `hiddenModels: string[]`（可选，缺省全显）。不做 per-account visibility 文件，不做 localStorage。
- D2 语义：隐藏 = `listModels` 不出 + `resolveModel` 自然不可用（通用不可用错误，一期不定制“已隐藏”文案）。隐藏 ≠ 服务端屏蔽/鉴权。
- D3 列表源：client 渲染基线列表，build 时从 `freeModels()` 生成并内联进 `src/client.js` 头部 `MODELS` 常量（不另出文件，免多一次取文件路径）。浏览器不直连 Zen，不新增 host HTTP/RPC。
- D4 stale：`hiddenModels` 中的未知/已下架 id 保留存储；client 只渲染基线交集，下架项不渲染（workbuddy 同策略：回来仍隐藏）。
- D5 风格：抄 `dsh-gitbash-shell` 卡片——`slots.inject("plugins.bundle.config", key=包名)` + `configForms` 读写 + `ui-primitives` Switch + `zh/en` 内联字典（模型 id 不翻译）。
- D6 生效：Config 非 volatile，改后走 HMR 重载；`PiAiAdapter profiles()` 每次现读，下一 operation 生效，无需重启 DSH。
- D7 `inject`：host 保持 `["llm"]`；client 为独立 `inject=["locale","slots"]`（+ 可选 `configForms` 懒获取，与 gitbash 同模式）。

## Contract Changes

### Config（`src/index.ts`）

```ts
export interface Config {
  readonly apiKey?: string | undefined;
  // volatile 必不可少，见下 schema 注释；运行时 DSH 以 live ref 交付，apply 做容错解包。
  readonly hiddenModels?: readonly string[] | { readonly get: () => readonly string[] | undefined } | undefined;
}

export const Config = z.object({
  apiKey: z.string(),
  // volatile 必不可少：dsh-settings 只为含 volatile 字段的插件服务 configForms
  // 行（volatileForm 无 volatile 字段返回 undefined，整行被跳过），且只接受对
  // volatile 路径的写入（否则 scope.set 抛 "not volatile"）。无此 flag 时卡片
  // 的 scope 为空、渲染 null——即面板不显示的根因。
  hiddenModels: z.array(z.string()).default([]).volatile(),
});
```

- 缺省/空数组 = 全显；未知 id 保留，不校验清洗。
- 老配置无此字段 = 全显。

### Host（`src/index.ts` `apply`）

- 解析 `config?.hiddenModels → Set<string>`（trim + 去空，可选去重）。
- 构造过滤视图（示意，`refreshModels` 透传）：

```ts
const filtered = {
  ...provider,
  getModels: () => provider.getModels().filter((m) => !hidden.has(m.id)),
  refreshModels: (c: unknown) => (provider as { refreshModels: (c: unknown) => unknown }).refreshModels(c),
};
authModels.setProvider(filtered as never);
profile.piProvider = filtered; // profiles() 返回的 profile 用 filtered
```

- 其余不动：传输/身份/重试/attachment（`ctx.get("attachments")`）/side-channel patches。

### Client（新增）

- 新增手写 bundle `src/client.js`（无构建步骤）：单次 `window.__ModuleLoader__.load({ id: <包名>, factory })`，`require` 仅 `react` + `@deepseek-ai/dsh-client-ui-primitives`（白名单，smoke  enforcement），`React.createElement` 无 JSX，组件顶层声明。
- `exports.inject = ["locale", "slots"]`；`apply` 内懒取 `configForms`（缺失不拖卡片下水），注册：
  `slots.inject("plugins.bundle.config", () => slots.register({ name: "plugins.bundle.config", key: <包名>, locale: <ns>, inject: () => ({ scope, ctx }) }, Card))`。
- 卡片内容：一期 = 标题 + 11 行（模型 id + Switch）+ 一行 hint（“隐藏后模型选择器不可见”）。预留二期功能区插槽（注释占位，不渲染）。
- `package.json`：`exports["./client"]`、`dsh.client = { inject: ["@deepseek-ai/dsh-client-runtime", "@deepseek-ai/dsh-client-locale", "@deepseek-ai/dsh-client-ui-slots", "@deepseek-ai/dsh-client-ui-settings"], platform: "web" }`（以 gitbash 实测值为准，允许实现时微调）。
- 模型列表注入：`pnpm build` 前跑 `tsx scripts/gen-client-models.mjs`（新建小脚本，只读 `freeModels()` 写常量），输出内联进 `src/client.js` 头部 `MODELS`。

### Probe 结论（已做，见 plan）

- P1 `configForms.get()` 命名空间 = `opencode-free`（cordis id = 插件 `name` = row id，gitbash row-id 规则）；slot key 用包名 `dsh-opencode-free`。
- P2 `ui-primitives` 一期不用其组件，原生 elements + 内联 CSS（gitbash 模式）；`require` 保留走白名单。
- P3 数组可选 = `z.array(z.string()).default([])`（已定，上方 Contract 即此写法）。

## Compatibility Boundary

- 老 Config 无 `hiddenModels`：全显，通过。
- `hiddenModels` 含未知 id：保留，不报错，不渲染（或灰显，实现时定）。
- 上游下架模型：`refreshModels` 交集变小，隐藏项保留；模型回归仍保持隐藏。
- 卸载插件：卡片随 fiber 销毁，无残留。
- 不碰：`PROVIDER_ID`、Zen 身份四件套、传输、重试、attachment 修复。

## Testing

- `pnpm exec tsc --noEmit` 通过。
- 现有 11 测试全过。
- 新增 host 单测（`tests/` 沿用 fixture 风格）：`apply(fakeCtx, { hiddenModels: ["big-pickle"] })` 后 `listModels(PROVIDER_ID)` 不含该 id；空配置 = 全显；未知 id 不炸。
- 新增 client smoke：单次 `__ModuleLoader__.load`、slot key = 包名、`require` 白名单、字典 `zh/en` key 对齐（抄 gitbash smoke 约束）。
- 手动：详情页拨开关 → picker 消失/恢复；重启 DSH 仍保持；HMR 无需重启。

## Non-goals（一期不做）

- 搜索/全选/重置/按系列分组（列表 11 行；面板留插槽，二期再加）。
- 定制“已隐藏”错误文案（A2，已 defer）。
- `registerConfigurableProviders` 目录切换（A3，已 defer）。
- 额度卡片、key 设置 UI、登录/OAuth、其他功能区。
- pi-ai 0.86、背景刷新、目录自动更新。

## ADR Signal

- 若实现中发现 `registerAdapter` 无法干净表达“隐藏”，需回看是否要 A3（目录契约），届时补 ADR（owner/contract 变更才写，现在不写）。

## Acceptance（可观测）

1. 详情页卡片出现，11 行 Switch 与 DSH 风格一致。
2. 关闭某模型 → 模型选择器无此模型；打开 → 恢复。
3. 改动持久：重启 DSH 后开关状态与显隐一致。
4. 无 `hiddenModels` 的老用户：全显，现有测试全过。
