# Agent Note: 格式门禁启用，vendor 文件改用校验和守护

Status: implemented

## Problem

`format:check` 在 2026-09-30 被**有意**留在门禁之外：仓库早于任何格式化器，一次全量格式化会产生 400+ 行纯空白 diff，把那批行为修复完全淹没——正是审计报告本身点名过的反模式。处置是"先跑一次格式化，单独提交，再把门禁打开"。

同一天发现了第二个问题：`.prettierignore` 列了 `src/client.js`（手写 bundle，Tab 缩进是承重的）与 `scripts/notes/`（从 skill 原样 vendor）。**被忽略的文件同时也是不被检查的文件。** 这个洞是实的：启用门禁的当天，`scripts/notes/agent-note-tree.ts` 就与上游产生了差异，而没有任何东西发现——因为没有东西在看。

## Decision

1. **扩大 ignore 到有理由的最小集**，每条都写明理由：
   - `src/client.js` — 手写 bundle，无构建步骤
   - `scripts/notes/` — vendor，改格式会让每次 skill 升级都变成冲突
   - `*.md` / `docs/**/*.md` / `.agents/**/*.md` — 实测 prettier 对 markdown 只做表格内边距重排（README.md 74 行 diff，全是 `| … |` 里的空白），是噪声不是强制，而且会跟手工对齐的表格打架
   - `audit-report-*.html` / `.claude/` — 生成的交付物
2. **跑一次 `prettier --write`**，只作用于自有代码。
3. **`format:check` 进入 `check` 与 CI。**
4. **vendor 文件改用校验和守护**：新增 `scripts/verify-vendored.mjs` + `scripts/vendored-manifest.json`，把被排除的那批文件重新纳入检查——不是靠格式，而是靠 sha256。

## Alternatives considered

- **不排除 `scripts/notes/`，直接格式化并接受与上游漂移。**否决：那正是把 vendor 变成分叉的起点，此后每次 skill 升级都要人工比对。
- **在 markdown 上也启用 prettier。**否决：见上，只有表格空白重排。
- **不跑格式化，直接开门禁。**否决：树不干净时门禁第一次运行就全红，那不是门禁，是给后来人留一个红灯。
- **把 vendor 文件改成每次从 skill 路径直接引用。**否决：那样 `pnpm run check` 就依赖这台机器上 skill 的存在位置，不可移植。

## Consequences

- **收益**：`pnpm run check` 现在串起 format:check、typecheck、162 条测试、pack、笔记校验、vendor 校验；CI 同。门禁经实证会咬人——我写 `verify-vendored.mjs` 时它立刻把这个新文件标红，那正是它该做的。
- **代价与已知上限**：格式化的 diff 单独存在（`src/`+`tests/`+`scripts/` 约 3800 行变动中相当一部分是空白），评审时建议单独一次提交、单独评审。vendor 升级需要显式跑 `node scripts/verify-vendored.mjs --refresh`——这是刻意的：让"我升级了 skill"成为一个可评审的动作，而不是一次静默的文件改动。

## Verification

- `prettier --check .` → `All matched files use Prettier code style!`
- 门禁实证：往 `src/zen-provider.ts` 追加一行 `function   badlySpaced( a:number ) :number{return a}` → `pnpm run format:check` 退出码 1；还原后退出码 0。
- vendor 实证：往 `scripts/notes/agent-note-tree.ts` 追加一行 → `verify-vendored` 报出 `93afd668d6f52fa4 -> 614ca6da9284684a` 并退出码 1；还原后 7 个文件全部匹配。
- `pnpm run check` 退出码 0。