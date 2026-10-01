# Agent Note: 这是 fork，不发 npm；安装路径走本地 tarball

Status: implemented

## Problem

本仓库是 `x5427876/dsh-opencode-free` 的 fork，**从未发布到 npm**（2026-09-30 由仓库所有者确认）。而文档此前写的是：

```
dsh plugin --profile web add dsh-opencode-free@0.3.1
```

npm registry 实测 `dist-tags.latest = 0.2.1`，0.3.x 从未发布。更关键的不是"装不上"，而是**装错人**：这个命令会拉到上游作者的构件，而不是这个 fork 的。而且把版本降到 `0.2.1` 只会装错得更彻底。

三处发布元数据也互不一致：`package.json` 的 repository/homepage/bugs 与 README 的 CI 徽章指向 `x5427876`，CHANGELOG 底部版本链接指向 `tkhs101`，而带 `v0.3.x` tag 的是 `tkhs101` 那个 remote。

另有一处同类问题：README 与 AGENTS.md 让用户运行 `scripts/reverify.sh`，但 `package.json` 的 `files` 不含 `scripts/`，npm 包里没有这个文件。

## Decision

发布源定为 **tkhs101**（tag 在那里），`x5427876` 是代码上游。

- README 顶部加 `> [!IMPORTANT]` 块说明这是 fork、不在 npm、npm 上同名包属于上游，并给出本 fork 的 release 地址；删掉会渲染成 `0.2.1` 的 npm 徽章。
- 安装步骤改为：clone → `pnpm install --frozen-lockfile` → `pnpm run build` → `pnpm pack --pack-destination .` → `dsh plugin --profile web add file:./dsh-opencode-free-<v>.tgz`。
- 更新不再是 `dsh plugin update`（没有 registry 可解析），而是重新打包后 remove + add。
- 校验段落移除裸跑 `dsh --profile web --dump-config`，并在其前后加警告：该命令**逐字、零脱敏**地打印 profile 的 `cordis.patch.yml`，而可选的 Zen key 就在其中（见 [dump-config 笔记](../bug-fix/2026-09-30-dump-config-prints-secrets.md)）。
- 验证脚本段落明写"脚本在仓库里、不在 tarball 里"。
- 缓存路径改写为 `$DSH_HOME/dsh-opencode-free/catalog.json`（未设时 `~/.dsh/…`），并说明 `DSH_HOME` 优先——DSH Desktop 的 profile 通常设了它，删 Windows 路径会删不到东西。
- `package.json` 的 repository/homepage/bugs 指向 tkhs101，删除已无意义的 `publishConfig`。

## Alternatives considered

- **在 npm 上发布 0.3.1，让文档成为事实**。论据是 npm 安装体验最好，且 `package.json` 的形态本来就是为它准备的。否决：维护者明确表示这个 fork 不打算发 npm；强行发布还会让"同名包"这件事更危险。
- **把版本号降到 0.2.1 让文档自洽**。论据是改动最小。否决：0.2.1 是上游的已发布版本，降级会让 `PLUGIN_VERSION` 谎报自己的身份。

## Consequences

- **收益**：安装步骤不会静默装到别人的构建；仓库归属三处一致；缓存恢复指引在 `DSH_HOME` 环境下指向正确的文件。
- **代价与已知上限**：用户必须能 clone 仓库并本地构建，`pnpm pack` 成为安装路径的一部分。已发布构件与 fork HEAD 的对应关系现在完全依赖 tag 纪律——`tests/compatibility.test.mjs` 的契约测试断言 CHANGELOG 的首个版本段就是 `package.json` 的版本，且断言 AGENTS.md **不含** npm 安装命令。
- `AGENTS.md` 仍指向 `docs/adr/` 记录领域决定；本仓库的工程决定走 `.agents/notes/`。两者并存，因为它们回答的是不同问题（领域语义 vs 改动取舍）。

## Verification

`tests/compatibility.test.mjs` 的 `targets the DSH 0.2.0-rc.2 contracts` 现在断言：CHANGELOG 的**首个** `## [` 段等于 `pkg.version`（原断言只检查字符串存在，`[Unreleased]` 盖在上面时依然通过）；AGENTS.md 匹配不到 `^\s*dsh plugin .*add\s+dsh-opencode-free@`；且含 `file:./dsh-opencode-free-<v>.tgz`。
