# Agent Note: 测试套件必须在临时 $DSH_HOME 与离线 fetch 下运行

Status: implemented

## Problem

`tests/compatibility.test.mjs` 在模块作用域 `await import(...)` 之后，顶层调用 `plugin.apply(fakeCtx, {})`，却**从不设置 `process.env.DSH_HOME`**。`apply()` 构建的 Catalog 其 `cachePath()` 回落到 `homedir()/.dsh`，其 `fetchImpl` 指向真实的 `globalThis.fetch`。于是这 26 个用例：

- 读写**开发者真实的** `~/.dsh/dsh-opencode-free/catalog.json`；
- 真的向 models.dev 发请求。

README 明写 "The unit tests use in-memory fixtures. They do not use the network"，而这句话是错的。2026-09-30 实测：把 `DSH_HOME` 指向临时目录后单跑该文件，产物 `catalog.json` 带着真实 etag `W/"58e29fa3…"`；本机那份 80KB、含 33 条探针判决的缓存，正是在审计过程中执行 `pnpm run check` 时被覆盖的。

同仓库的 `model-visibility.test.mjs:11-18` 做得完全正确（`mkdtemp` + 固定 503），说明这是遗漏而非设计。

## Decision

两条约定：

1. **凡是会触发 `apply()` 的测试文件，在任何 `import`/`apply` 之前建立沙箱**：`mkdtemp` → `process.env.DSH_HOME` → `globalThis.fetch` 换成 503 → `after` 里全部还原。`compatibility.test.mjs` 顶部按此补齐。
2. **测试导入 `src/`，不导入 `lib/`**。`npx tsx --test tests/*.test.mjs` 是最高频的内层循环，它不跑 `pretest`，所以导入构建产物等于静默测试一份陈旧构建（40/146 个用例受影响）。`compatibility` 与 `model-visibility` 已改指 `../src/index.ts`；对 `lib/` 的整体扫描保留，因为它验证的是"发布产物确实带上了身份"，那是另一件正当的事。

## Alternatives considered

- **把 `apply()` 从这个文件里移走，只留在 `model-visibility.test.mjs`**。论据是最小的修复面。否决：`apply()` 与 key 优先级、`PiAiAdapter` 装配是同一件事，拆开会让"装配是否正确"与"凭据优先级是否正确"分属两个文件，失败时更难定位。
- **用 `mock.module` 之类拦截 `homedir()`**。论据是不必碰环境变量。否决：拦截的是被测代码的一个纯函数，而 `DSH_HOME` 本身就是要测的分支；拦 `homedir` 会让"DSH_HOME 为空时回退到 ~/.dsh"这条无法测试。

## Consequences

- **收益**：套件可重复、可离线、不再破坏开发者状态；本机真实缓存在连续两次全量运行后保持字节数与 mtime 不变。
- **代价与已知上限**：每个新测试文件都要自带前导，忘了就是一次静默的污染。已用 `model-visibility.test.mjs` 作为可复制的样板；若将来这类前导超过三份，再抽成共享 helper 才划算。

## Verification

`tests/compatibility.test.mjs:36-76`。单跑该文件前后对比 `~/.dsh/dsh-opencode-free/catalog.json`：修复前 82821 字节被重写且 `lastRound` 消失，修复后两者均不变。
