# Spec：模型目录跟随 models.dev（替换 pi-ai 内置表）

## Status

- state: draft（待用户评审）
- 批准记录：fetch 模式 = 纯运行时拉取+缓存；免费判定 = 默认隐藏+面板标注；通道映射 = 三级推导；面板 = 实时目录 + 立即刷新
- 前序 workstream：`.scratch/model-visibility/`（面板一期，已落地）

## Problem Statement

模型目录的 owner 目前是 pi-ai 内置表，而 DSH 锁死 `pi-ai@0.85.1`，无法随上游升级。结果是每次 Zen 上新免费模型，插件都要手工补一条 synthetic 记录（已发生一次：补 5 条、再手删 1 条 deprecated），且 models.dev 的元数据（名称、上下文/输出上限、attachment、reasoning、status）拿不到，只能靠猜。

`status: "deprecated"` 的语义存在歧义：在这家 provider 上，`deepseek-v4-flash-free`（免费层已结束、调用失败）与 `muse-spark-1.2-contributor-free` / `mimo-v2.5-free`（仍可用）被写成同一个值，任何数据源都无法自动区分二者。

## Solution

目录 owner 换成 **models.dev（运行时拉取）+ Zen `/models`（可用性闸门）**：
models.dev 回答「哪些免费、叫什么、上限多少、是否 active」，Zen 回答「上游现在真的在列」。
pi-ai 内置表降级为**已知通道覆盖表**与**离线兜底基线**，不再是 owner。

## Decisions（已定）

- D1 **fetch 模式**：纯运行时拉取 + 缓存。`GET https://models.dev/api.json`（无 per-provider 端点，整份 5.2MB），带 `If-None-Match`；`304` 不重建，`200` 只取 `opencode` 段。
- D2 **免费判定**：`cost` 全 0 = 免费候选；`默认可见 = 免费 && status ≠ "deprecated"`。无 `status` 字段视为 active（models.dev 对 active 模型省略该字段）。`deepseek-v4-flash-free` 这类因此自动消失。
- D3 **可用性闸门**：默认可见集 ∩ Zen `/models` 在列 = picker 实际可见集。Zen 拉取失败时保留当前目录（不收窄）。- D4 **触发时机**：懒重验证——读目录时若缓存超 TTL(24h) 则**后台非阻塞**重拉，不阻塞当次请求；**不设定时器**（`docs/spec-v0.2.md` 已定「不做背景自动刷新」）。同一时刻只允许一次在途同步，并发读共享。
- D5 **缓存位置**：`$DSH_HOME/dsh-opencode-free/catalog.json`（临时文件 + rename 原子写），内容 `{ etag, fetchedAt, opencode }`，**只存 opencode 段**，使 24h 内的启动无需再拉 5.2MB。理由：宿主不调 `refreshModels`（全仓 grep 无调用方），settings 的 `publish` 通道不可依赖；且这是插件数据而非用户配置，不应进 config form。本机 `dsh-pocket` 的 `$DSH_HOME/dsh-pocket/settings.json` 为同款先例。
- D6 **通道映射**（三级，已对 7 个已知模型验证 7/7 吻合）：① pi-ai 内置表命中则用其 `api`；② 否则按 models.dev 推导——有 `interleaved` 或 `reasoning_options=[{type:"toggle"}]` → `openai-completions`；`reasoning_options` 含 `{type:"effort"}` → `openai-responses`；③ 仍不决 → `openai-completions`（证据：`opencode.provider.npm = "@ai-sdk/openai-compatible"`）。
- D7 **元数据映射**：`name`；`limit.context → contextWindow`；`limit.output → maxTokens`；`modalities.input → input`；`reasoning` / `tool_call` 直传；缺字段时回落模板值（`mimo-v2.5-free` 记录形状）。**`compat` 不可跨通道继承**：仅当派生通道与 `template` 通道相同时继承，否则丢弃该字段、让 pi-ai 按 `baseUrl` 自侦（transport 专属配置错配会导致请求体/响应解析走错分支）。
- D8 **兜底**：无缓存且拉取失败/超时/响应畸形 → 用 pi-ai 兜底基线（当前内置免费集）。目录任何失败都不得让插件不可用。
- D9 **面板**：可开关行 = 默认可见集（picker 实际能选到的）；底部灰字 = 被排除的 deprecated 免费模型名（纯文字、无开关）；新增「立即刷新」按钮（绕过 TTL，仍受在途去重约束）。
- D10 **面板数据源**：host 新增只读端点 `GET /dsh-opencode-free/api/catalog`；`inject` 由 `["llm"]` 改为 `["llm", "webServer"]`，按 gitbash-shell 同款 `webServer.register({kind:'prefix', path, handler})` + dispose。**推翻先前「inject 不用动」的结论**。
- D11 **退役**：构建期 `scripts/gen-client-models.mjs`、`package.json` 的 `prebuild`、`src/client.js` 内联 `MODELS` 常量、`zen-provider.ts` 手写 synthetic 列表。均为真退役，不留兼容分支。
- D12 **`refreshModels` 接缝保留**：它继续作为 D3「Zen 可用性闸门」的实现入口（宿主虽不调用，但 pi-ai provider 形状包含它，且它是 Zen 交集逻辑的既有归属地）。变化仅一处：被交集的基线从「pi-ai 内置集」换成「catalog 派生目录」。**不退役**。

## Contract Changes

### Owner 划分

| 文件 | 职责 | 边界 |
|---|---|---|
| `src/catalog.ts`（**新增 owner**） | api.json 抓取与条件请求、缓存读写、派生纯函数（免费判定/通道推导/元数据映射）、Zen 交集、降级编排 | 不碰传输、身份、重试；不含 DSH ctx 概念（同步/端点编排留在 `index.ts`） |
| `src/zen-provider.ts` | 传输、身份、会话 id、失败分类、compaction | 不再持有 synthetic 列表；`freeModels()` 改为读取 catalog 派生结果 |
| `src/index.ts` | 目录同步的生命周期编排（懒重验证、在途去重、端点注册） | 已有逻辑不动 |
| `src/client.js` | 面板：读端点、开关写 `hiddenModels`、立即刷新、灰字列出 `excluded` | 移除内联 `MODELS` |

拆出新文件而非塞进 `zen-provider.ts`（已 815 行）：目录派生的 owner 与传输 owner 关注点不同，混住会让两边的失效原因无法分别定位。

### 缓存文件（新增，插件私有）

```jsonc
{ "version": 2, "etag": "\"9ebf…\"", "fetchedAt": 1789…, "models": { /* models.dev 的 opencode provider 之 models 段 */ } }
```

- 注意只存 **models 段**（`body.opencode.models`），不存 provider 包装层：`opencode.api` 等字段运行时不读（base URL 由 `BASE_URL` 常量提供），而名实不符的字段名曾直接导致过一次「provider 对象被当成 models 字典」的缺陷（picker 变空）
- 缓存 `version` 为 **1**（本 workstream 新建、从未发版，线上不存在旧缓存；提到 2 会凭空造一个不存在的迁移）。读到 `version !== 1`、缺 `models` 字段、或 `models` 非 plain object 一律视为无缓存（退化为兜底基线）——这条守卫同时覆盖手改、截断与旧字段名三种文件

- 路径：`$DSH_HOME/dsh-opencode-free/catalog.json`（`DSH_HOME` 缺省 `~/.dsh`）
- 写：临时文件 + `rename`；读：`JSON.parse` 失败视为无缓存
- 不含任何凭据；`opencode.api`（base URL）不落盘（每次由 `BASE_URL` 常量提供）

### host 端点（新增）

`GET /dsh-opencode-free/api/catalog` → `200 application/json`

```jsonc
{ "visible": ["big-pickle", "…"], "excluded": ["muse-spark-1.2-contributor-free", "…"],
  "updatedAt": 1789…, "source": "models.dev" | "builtin-fallback", "refreshing": false }
```

- `visible` = **picker 实际可见集**（已过 D2 与 D3 两道闸门），因此面板行与 picker 恒等，验收断言 1 无需例外
- `excluded` = 免费但当前不可见的全部模型名：`status === "deprecated"` 者 ∪ 免费且 active 但 Zen 未在列者。只给名称，不含其他元数据
- 只读、GET only；不回显 `apiKey` 或任何配置值

### 刷新端点（新增，D9 所需）

`POST /dsh-opencode-free/api/refresh` → `200` + 同上 payload 形状

- 存在理由：强制刷新是写动作，塞进只读 GET 会让「只读端点」失真
- 语义：触发一次绕过 TTL 的同步，**等待完成**后返回当前快照（面板据此立即拿到新目录）
- 并发调用受在途去重约束，共享同一次同步；不涉及任何配置写入
- 非 GET/POST 一律 `405`

### `freeModels()` 语义变更

- 旧：同步返回 pi-ai 内置免费集（7 条）
- 新：返回**当前派生目录**。启动瞬间 = 兜底基线（pi-ai 内置免费集，7 条）；首次成功同步后 = models.dev 派生集
- 导出名保留不变（`freeModels`），调用方（`zen-provider` 内部、测试）随之改语义

## Compatibility Boundary

- 老 `hiddenModels` 语义、volatile 行为、读-改-写保留未知 id：**不变**
- 未知/已下架模型 id 仍保留在存储中，不清洗
- 传输、Zen 身份四件套、重试策略、encrypted-content 重放、compaction 提示词、attachment 修复：**一律不动**
- 断网/畸形响应：降级到缓存或兜底基线，插件可用
- `jev-1.13-free`：**models.dev 的 api.json 中无此条**（实测查询为 `null`），随目录切换而消失。注：其 models.dev toml 虽标 `cost = {input: 0, output: 0}`，该值满足「每项为 0」因而按 D2 会被判为免费 —— 消失原因是**整条缺失**，不是 cost 判定（此处更正了本 spec 早前写反的理由）
- **上游整条删除的模型**（既非 deprecated、又不在 Zen 在列）按 D2/D9 既不进 `visible` 也不进 `excluded`：面板上该行直接消失，`hiddenModels` 中的旧 id 仍保留。这是已知且有意的边界（模型已不存在，无须标注），不新增第三个桶

## Testing Decisions

- 只测外部行为：给定 api.json 片段 → 期望的派生集（免费判定、deprecated 排除、通道推导、limits 映射）；给定 HTTP 状态（200/304/超时/畸形/超限）→ 期望的目录与缓存状态；给定 cache 状态 → 期望的降级结果
- 端点：返回的 `visible` 与 picker `listModels` 一致（同源派生，断言一致性而非具体文案）
- 不测：models.dev 内部实现、Zen 上游行为、浏览器渲染细节
- 不引入真实网络依赖：全部用 fixture + 注入式 fetch
- **「不回归」的准确含义**：行为覆盖不得减少——过滤、volatile 解包、未知 id 忽略、隐藏模型不可 resolve、端点与 picker 恒等等用例必须继续存在并通过。**计数与 id 列表类断言随 owner 变更而更新**（原「pinned at 11 models」断言改为针对 fixture 派生集），这类更新不算回归

## ADR Signal

- **成立**：目录 source-of-truth 从「pi-ai 内置表」变为「models.dev + Zen `/models`」，属持久架构决策（数据源、缓存、失效口径、退役旧路径）
- 来源：`docs/spec-v0.2.md` 的「目录维持打包基线＋公开端点交集」决策被本 spec 取代
- 真实替代方案：构建期快照（已否决：新鲜度等于发版频率）、纯 pi-ai 内置表（已否决：DSH 锁版本）
- 完成时应写 `docs/adr/0002-catalogue-source-of-truth.md`，并同步 `docs/spec-v0.2.md` 中被取代的那条

## Non-goals

- 定时/后台周期刷新（只懒重验证 + 手动按钮）
- 通道猜错时的自动改道重试（错误走既有失败分类与指引）
- models.dev 上其他 provider
- key/额度卡片、登录、per-account 目录
- 升级 pi-ai 版本（被 DSH peer 锁死）
- 面板搜索/分组/批量（二期）

## Retirement

| 退役对象 | 位置 | 理由 | 移除检查 |
|---|---|---|---|
| `scripts/gen-client-models.mjs` | 整文件删除 | 目录不再构建期内联 | `git ls-files` 无该文件；`prebuild` 移除 |
| `prebuild` script | `package.json` | 同上 | `pnpm run build` 仅剩 `tsc` |
| `MODELS` 内联常量 | `src/client.js` | 面板改读端点 | `grep -c MODELS src/client.js` = 0 |
| 手写 synthetic 列表 | `src/zen-provider.ts` | 由 models.dev 派生取代 | `grep -c synthetic src/zen-provider.ts` = 0 |

## Acceptance（可观测）

1. picker 可见模型集 == 端点 `visible` ∩ Zen 在列（同一断言两处读数一致）
2. 隐藏某模型 → picker 无它；打开 → 恢复；重启 DSH → 状态保持（既有行为不回归）
3. 断网启动（无缓存）→ 仍能用兜底基线选模型，不空列表
4. TTL 到期或点「立即刷新」→ 新出现的免费模型进入列表；`deepseek-v4-flash-free` 类 deprecated 项从 picker 消失
5. 面板底部灰字列出被排除的 deprecated 免费模型名
6. 现有行为覆盖不回归（过滤/volatile/未知 id/隐藏不可 resolve/端点与 picker 恒等）；新增目录派生、ETag 304、失败降级、端点用例通过
7. `pnpm exec tsc --noEmit` 与 `pnpm test` 全绿
8. `docs/adr/0002-catalogue-source-of-truth.md` 已写，`docs/spec-v0.2.md` 中被取代的目录决策已同步

> **Superseded.** 本文件是历史推理，已落地。当前事实见
> [`docs/adr/0002-catalogue-source-of-truth.md`](../../docs/adr/0002-catalogue-source-of-truth.md)
> 与 [`CHANGELOG.md`](../../CHANGELOG.md)；已知矛盾见 [`../README.md`](../README.md)。
