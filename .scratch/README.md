# `.scratch/` — 历史推理，不是现行设计

这个目录是**问题的草稿**，不是设计真相。

## 读之前先知道

每个 feature 目录对应一轮已经落地的工作。落地之后，**现行事实以这三处为准**：

| 想知道 | 去哪里 |
|---|---|
| 这个决定是什么、为什么这么定 | [`docs/adr/`](../docs/adr/) |
| 什么时候改的、改了什么 | [`CHANGELOG.md`](../CHANGELOG.md) |
| 现在实际怎么跑 | [`README.md`](../README.md) + 源码 |

本目录保留的是**推导过程**：走过的弯路、被推翻的假设、量测方法上的教训。这些在结论写完之后就不再更新了，因此可能与当前代码矛盾。

## 已知的矛盾（不要照着实现）

- `models-dev-catalog/spec.md` 的 D9 写过"面板底部灰字列出被排除的 deprecated 免费模型名"。**没有做**，而且是**故意不做**的：一个模型不可选时就是不出现在列表里，不存在第二份名单——否则它会和选择器不一致，并且会过期。理由见 `README.md` 与 `src/catalog.ts` 中 `effectiveList` 的注释。
- `models-dev-catalog/spec.md` 里的缓存字段是 `{etag, fetchedAt, opencode}`，TTL 只有 24h。**两者都已变**：schema 现在是 v1（含 `models` / `probes` / `lastRound`），`readCache` 会直接拒绝仍带 `opencode` 键的旧文件；TTL 在 304 验证过上游遵守条件头之后自适应到 6 小时。
- `live-diagnosis/` 里的 User-Agent 记录停在 `dsh-opencode-free/0.2.0`，那正是 0.3.1 修掉的漂移。

## 教训值得留下

- `model-probe/issues/01-api-label-vs-endpoint.md`：用一个**会覆盖**的单变量去记录可能发生多次调用的路径，读到的必然是最后一次。当时据此得出的两个结论都是错的，而它们当时看起来都很有说服力。
- `model-probe/issues/01` 末尾指出的 `channelFor` 里的 `interleaved` 优先级，是全项目**唯一**靠优先级而非唯一信号做判定的地方，比其他层脆弱。

## 状态

已落地的目录：`live-diagnosis/`、`model-probe/`、`model-visibility/`、`models-dev-catalog/`、`release-0.3.0/`、`v0.2/`。
新工作请在 `docs/adr/` 记决定，在 `CHANGELOG.md` 记变化，不要在这里另开一份。
