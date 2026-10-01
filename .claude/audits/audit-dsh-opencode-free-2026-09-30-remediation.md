# dsh-opencode-free 审计整改索引

| | |
|---|---|
| 审计报告 | [`audit-report-dsh-opencode-free-2026-09-30.html`](audit-report-dsh-opencode-free-2026-09-30.html) |
| 审计时间 | 2026-09-30（HEAD `cf57d09` + 未提交工作树） |
| 整改范围 | 51 项发现，全部修复 |
| 决策记录 | [`.agents/notes/`](../../.agents/notes/)（19 篇） |

> **审计报告是快照，不是现状。** 报告里的 **6.6 分、146 个测试、若干"不成立"的结论**描述的是 **2026-09-30 审计当时**的状态。整改在报告写完之后进行，因此报告与代码不一致是**预期的**，不是文档失守。要看当前状态，请读下面这份索引，或直接跑 `pnpm run check`。

---

## 一句话现状

51 项发现全部修复并逐条验证；`createCatalog` 从 520 行降到 202 行；`pnpm run check` 退出码 0；八条变异守卫逐条仍会红。

---

## 按审计的修复顺序

| 优先级 | 项 | 做了什么 |
|---|---|---|
| **P0 立即** | #1 #2 #3 #4 | 安装路径改为 fork 的 tarball 流程；`--dump-config` 明文密钥加警告；fetch 守卫收窄兜底 `catch` 作用域（此前一次网络失败会重发且丢身份头）；`lastRound` 两个写入者都修（同步分支携带 + 探测轮回写内存） |
| **P1 本迭代** | #5–#28、#40–#48 | 强制探测加配额下限；peer 改为非可选；`prepublishOnly` + CHANGELOG 位置断言；轮询状态进 `useRef`；流式体积上限；WCAG AA 达标；CI Node 矩阵 + SHA 固定 + `pnpm audit`；身份头单一所有者；缓存临时名与 0600；无缓存时也落盘；仓库归属与版本派生；`DSH_HOME` 与全局补丁入文档；测试套件改为 hermetic |
| **P2 排期** | #11、#17、#29–#39、#49–#51 | `applyZenIdentity`；`createCatalog` 拆分；准入判定单一实现；asyncIterator 存在性判断；会话 id 加盐；`probe-ab.mjs` 入库；prettier + 门禁；注释瘦身；补齐并发/原子写/schema 解析/预算接口的测试 |

---

## 三处值得单独记住的

**1. 审计报告自己有一条结论是错的。**
第一轮报告写「146 个用例全部离线」。第二遍用变异测试审测试体系时发现 `compatibility.test.mjs` 从不设 `DSH_HOME`，因此它读写**开发者真实的** `~/.dsh/dsh-opencode-free/catalog.json` 并真实访问 models.dev。报告已就地标注为否定语境。

**2. 一次脚本化重构失败三次，根因是反斜杠被 shell 吃掉。**
`\w` 变成 `w`、`\b` 消失，正则从一开始就是坏的且**静默匹配 0 处**。当时误判为"正则排除规则不可靠"，实际是转义问题。教训写在 [2026-10-01-explicit-catalog-state-step1.md](../../.agents/notes/implemented/simplification/2026-10-01-explicit-catalog-state-step1.md)。

**3. 本仓库是 fork，不在 npm 上。**
`dsh-opencode-free@<version>` 装到的是**上游作者的构建**。审计最初把这条记作"文档指向未发布版本"，实际性质更严重。安装走 `pnpm pack` + `file:`。

---

## 怎么复核

```sh
pnpm install
pnpm run check                        # 全部门禁；退出码 0 即通过
bash scripts/verify-audit-fixes.sh    # 逐条核对 51 项修复是否在位
node scripts/verify-vendored.mjs      # scripts/notes/ 未漂移出 skill
```

`verify-audit-fixes.sh` 是 grep 式的存在性检查，不是行为证明；行为证明在测试里，而测试里最关键的几条都有对应的**变异验证**（删掉实现，测试必须变红）。

---

## 已知不处理的两项

| 项 | 为什么 |
|---|---|
| `LICENSE` 署名 `dsh-claude-subscription contributors` | 上游作者所写，本 fork 原样继承；改版权归属不是本仓库该做的决定 |
| `createCatalog` 仍有 202 行 | 刚过 100 行阈值；再降要动接口实现本身，收益远小于改动面 |