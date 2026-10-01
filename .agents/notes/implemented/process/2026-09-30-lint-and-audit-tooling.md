# Agent Note: 引入 prettier 与依赖审计，但不在本次整改里全量格式化

Status: implemented

## Problem

仓库没有任何 lint / format / 依赖审计工具：`devDependencies` 只有 `typescript`、`tsx`、`@types/node`，CI 只跑 `pnpm run check`。后果是格式残留无人拦截——审计实际找到两处：`src/zen-provider.ts` 的 `return "unknown";}`（闭合花括号挤在 return 同行）与 `src/catalog.ts` 里一个全仓唯一的单引号（该文件其余部分都是双引号）。这类噪声混在真改动里增加 diff 噪音与评审负担，而 `pnpm run check` 全绿区分不了"风格一致"与"风格混乱"。

## Decision

分三步，刻意不对称：

1. **引入 prettier，配置成仓库的既有风格**（不是 prettier 的默认风格）。仓库实际有三种风格，`.prettierrc.json` 用 `overrides` 表达它们，而不是强行统一：
   - `src/**/*.ts`：分号 + 双引号
   - `tests/**/*.mjs`、`scripts/**/*.mjs`：无分号 + 单引号
   - `src/client.js`：Tab 缩进的手写 bundle，进 `.prettierignore`——它没有构建步骤，缩进对手工编辑流程是承重的，格式化它会让每一次改动的 diff 都被淹没
2. **修掉那两处真实残留**，并加 `format` / `format:check` 脚本。
3. **CI 加 `pnpm audit --audit-level=high --no-fund`**；`format:check` 暂不进 CI，理由见下。

## Alternatives considered

- **在本次整改里 `prettier --write .` 全量格式化**。论据是"要么全做要么不做"，半格式化等于多一种风格。否决——而且是本次整改里最该否决的选项：它会产生数百行纯空白 diff，把这批**行为修复**完全淹没。审计报告本身就点名了"格式噪声混在真问题里增加评审负担"这个反模式，我们不能在修它的同时再犯一次。实测残留量级：`src/` 三个文件合计 400+ 行改动，另有全部测试与脚本。
- **改用 ESLint 而不只 prettier**。论据是能抓 `no-floating-promises`、未处理 rejection 这类更值钱的问题。否决：ESLint 需要额外的 flat config + plugins，是一整套工具链决定，应当单独一次决策；先拿到零成本的格式一致性。
- **`format:check` 直接进 CI，CI 立刻变红**。否决：一个从未被格式化过的仓库第一次接上 `--check` 必然全红，那是把红灯留给别人而不是留下一条可执行的路径。

## Consequences

- **收益**：两处真实残留修掉；新写的文件可以用 `pnpm run format:check` 自查；高危依赖漏洞会在 CI 里阻断而不是躺在日志里。
- **代价与已知上限**：`format:check` 起初**不是**门禁——全树格式化会产生数百行纯空白 diff。2026-10-01 已按计划完成那次独立格式化并打开门禁，见 [format-gate-enabled](2026-10-01-format-gate-enabled.md)。

## Verification

`pnpm run check` 全绿；`npx prettier --check src/` 现只剩三个文件的历史格式差异（有意保留，见上）。`pnpm audit` 已接入 CI。
