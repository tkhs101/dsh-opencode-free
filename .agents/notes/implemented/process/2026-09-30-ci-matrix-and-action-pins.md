# Agent Note: CI 覆盖 engines 承诺的 Node 范围，action 按 SHA 固定

Status: implemented

## Problem

`engines.node` 是 `^22.19.0 || >=24.0.0`——一个对外的兼容承诺；CI 却只跑 `node@22.19.0` 单点，且没有 `strategy.matrix`。承诺与被验证的集合不一致，而这种不一致只能靠一次手工运行发现。

两个 action 用的是可移动标签（`actions/checkout@v6`、`pnpm/setup@v1`）。标签指向的提交可在上游被重新指向，而本仓库的锁文件保护不了 CI 步骤本身：工作流在 `push` 与 `pull_request` 上运行，带着仓库写权限上下文。

另有两处：没有 `concurrency`（连续 push 并发跑多个近乎相同的 run，PR 上的绿色检查容易混），没有 `timeout-minutes`（卡住的步骤占用 runner 直到平台 6 小时上限）。

## Decision

- 矩阵取 `["22.19.0", "24", "26"]`，覆盖 `engines` 每一段的**下界**。测试全离线，多跑两个版本的成本以秒计。
- 两个 action 固定到提交 SHA，行尾注释保留版本号便于 Dependabot 升级。
- 补 `concurrency`（同 ref 的旧 run 直接取消）与 `timeout-minutes: 15`。
- 新增 `the Node versions CI tests are the ones engines promises`：从 `engines.node` 解析每一段的 major，断言都出现在矩阵里；同时断言每个 `uses:` 都匹配 `@[0-9a-f]{40}$`。

**SHA 必须真实。** 整改过程中曾凭记忆写下一个 `pnpm/action-setup` 的 SHA，`git ls-remote` 查不到——那会让工作流直接跑不起来。两个 SHA 现已用 `git ls-remote --tags` 逐个核对：
`actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683` = v4.2.2；
`pnpm/setup@5d160c5bc68a09337ad0d5654e237e03253b5879` = v1。
顺带确认 `pnpm/setup` 与 `pnpm/action-setup` 是两个不同的仓库，原工作流用的是前者，保持不变。

## Alternatives considered

- **只加一个 `node@24`**，认为 `>=24.0.0` 已被覆盖。否决：`>=` 是开区间，26 上周的行为变化 CI 一样看不见；审计时本机就跑在 Node 26 上。
- **用 Dependabot 代替手动 SHA 固定**。论据是维护成本更低。否决：Dependabot 更新 action 引用与"引用是否可移动"是两个问题——SHA 固定是安全属性，必须在引用里表达。

## Consequences

- **收益**：engines 与 CI 不再能各自漂移；CI 步骤的供应链暴露面从"上游任意提交"收窄为"这两个提交"。
- **代价与已知上限**：SHA 固定意味着 action 升级要手动或依赖 Dependabot；矩阵使 CI 时长约为原来的三倍（仍然以分钟计）。若将来 `engines` 改成不连续的范围，测试里"取每段下界"的解析需要跟着调整。

## Verification

`tests/compatibility.test.mjs`；`.github/workflows/ci.yml` 经 YAML 解析确认 `matrix.node`、`timeout-minutes`、`concurrency` 与两处 `uses` 均按预期落地。
