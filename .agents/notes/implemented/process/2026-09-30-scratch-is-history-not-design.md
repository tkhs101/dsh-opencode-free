# Agent Note: `.scratch/` 是历史推理，不是现行设计

Status: implemented

## Problem

`.scratch/` 的 17 个文件全部被 git 跟踪，而 `docs/agents/issue-tracker.md` 把这里指为设计真相的存放处。至少三处内容已被当前代码推翻：

- `models-dev-catalog/spec.md` 的 D9 写过"面板底部灰字列出被排除的 deprecated 免费模型名"。**没做，而且是故意不做的**——不可选就是不出现在列表里；存在第二份名单它就会和选择器不一致并会过期。`README.md` 与 `catalog.ts` 的 `effectiveList` 注释都明确写了这一点。
- 同一份 spec 的缓存字段是 `{etag, fetchedAt, opencode}`、TTL 只有 24h。两者都变了：schema 已是 v1（含 `models`/`probes`/`lastRound`），`readCache` 会**拒绝**仍带 `opencode` 键的旧文件；TTL 在 304 验证过之后自适应到 6h。
- `live-diagnosis/` 里的 User-Agent 记录停在 `dsh-opencode-free/0.2.0`——那正是 0.3.1 修掉的漂移。

## Decision

不改历史文件的内容——它们是推理记录，改了就失去意义。改为**让读者不可能误读**：

- 新增 `.scratch/README.md`：开头三行就说清这里是什么、现行事实去哪三个地方查（`docs/adr/` / `CHANGELOG.md` / README + 源码），并逐条列出**已知矛盾**与**仍然值得留下的教训**。
- 给已落地 feature 的 spec/plan 文件尾部加一段 `Superseded` 引用，指向 ADR 0002、CHANGELOG 与该 README。

## Alternatives considered

- **删掉已落地目录**。论据是它们已经不产出任何东西。否决：其中至少两条教训是**活的**——`model-probe/issues/01` 记的"用会覆盖的单变量去记录可能多次调用的路径，读到的必然是最后一次"，以及它指出的 `channelFor` 里 `interleaved` 优先级是全项目唯一靠优先级而非唯一信号做判定的地方。这些删了就没了。
- **把 `.scratch/` 移出仓库**。论据是 911 行内部排障推理进公开仓库不合适。否决：那会把上面两条教训一并带走，且这是维护者可以自己决定的事——本篇只负责让误读的成本可见。

## Consequences

- **收益**：新维护者或 Agent 不会再依据过时 spec 去实现一个被明确否决的功能，也不会照着旧缓存字段名去写迁移代码。
- **代价与已知上限**：矛盾仍然存在于文件里，只是被标注了。彻底消除需要删除或改写历史记录，那是另一个决定。

## Verification

`.scratch/README.md` + 六个 spec/plan 的 `Superseded` 尾注。人工校对，成本 1h。
