# Spec：以实测探测取代 status 判定模型显隐

## Status

- state: draft（待用户评审）
- 前序：`.scratch/models-dev-catalog/spec.md`（已完成并提交 `56ec564`）；本 spec 在其上**取代 D2 的可见性规则**，不重开目录抓取
- **Supersedes**：上一个 workstream 的「目录只收 active（`derive()` 排除 `deprecated`）」规则。本 spec D1 改为目录收 `active ∪ deprecated`，`deprecated` 的去留交由探测结论决定。连带 `excluded` 字段语义改变（见 D6e）
- ADR：与已提交的 `docs/adr/0002-catalogue-source-of-truth.md` 属同一决策面（"什么决定可见模型列表"）→ **修订 0002 而非新增 0003**，避免同一决策面散落两份

## Problem Statement

`status` 是「免费层是否结束」的不可靠代理。实证：`deepseek-v4-flash-free`（免费已结束、调用失败）与 `muse-spark-1.2-contributor-free`、`mimo-v2.5-free`（仍可用）在 models.dev 上**都是 `deprecated`**。当前 D2 规则「非 deprecated 才显示」因此同时犯两种错：靠 static 数据保住了该藏的纯属侥幸，且把仍在用的模型藏了起来。

只有一次真实调用能分辨二者。

## Solution

对派生目录内的每个模型发一次最小请求，用应答事实决定可见性。`status` 降级为「是否在目录内」的判据，不再是可见性闸门。

## Decisions（已定）

- D1 **目录与探测范围同源**：`cost` 全 0 **且** `status ∈ {active, deprecated}`。`status` 缺省视为 active；付费模型与其他任何 status 值一律丢弃。
- D2 **探测节奏**：自动每天至多一轮；手动由面板按钮触发。两者都对该全集**按顺序逐个**发送，**不分批**、不并发。
- D3 **探针形状**（缺一即产生假阴性）：请求须带 `read` 与 `bash` 两个**工具名**、开启 streaming、`maxTokens ≥ 512`（推理模型思考 token 地板）、**每模型超时 30s**（与 `scripts/test-live.mjs` 同值）。依据 `docs/reverse-engineering.md` §8：不带 tools 的探针在匿名层**必然 403**。沿用既有 Zen 仿冒身份与 header 逻辑，不新增身份。
- D4 **结论三态**：
  - `ok` —— 得到非空文本应答
  - `dead` —— **确定性**失败：上游明确表示**该模型**不存在/已下线/不再提供（HTTP 404/410，或报文命中此类措辞）。**额度耗尽不属于此类**——那是临时状态、不是模型的过错，隐藏它会造成列表收缩
  - `inconclusive` —— **不可作为结论**：网络错误、超时、5xx、`403 FreeTierError`（匿名被闸 / IP 被闸）、`429` 额度耗尽、`401` 坏 key，以及任何无法明确归因到「该模型」的失败
- D4a **判定优先级（有歧义时落在安全侧）**：拿到有效文本应答 → `ok`；否则**先**排除更强的具体信号（被闸 / 额度 / 坏 key 的报文标记，或 429 / 401 状态码）→ `inconclusive`；**再**判 `dead` 正信号；最后兜底 `inconclusive`。
  理由：若报文同时含额度标记与「模型不可用」措辞，先判 dead 会误杀，直接违反 D5。已加断言 `isModelUnavailableFailure(429, 含 model 措辞的报文) === false`。
- D4b **`dead` 正信号是待校准的窄模式**：目前无 `deepseek-v4-flash-free` 死亡时的真实报文样本（依据来自口述），故模式刻意写窄。首轮真实探测若发现上游用别的措辞，该模型会判 `inconclusive`（安全侧：留在列表并在面板提示不可信）而非误杀；届时以实测报文**收窄或扩展**模式，而不是凭想象放宽。
- D5 **inconclusive 绝不改变可见性**（本 spec 最重要的一条）：一次 IP 被闸会让全集同时返回 `403 FreeTierError`；若把它当 `dead`，整个模型列表会瞬间清空——比现状更糟。遇到 inconclusive 保持当前可见性不变，并在面板提示「本次探测结论不可信」。
- D6 **可见性规则**：可见 = 目录内 且（`ok` 或 未探测）。`dead` 移出可见集，面板底部灰字列出其模型名。首次运行探测完成前，全部目录内模型可见（即首日列表是今日的**超集**）。
- D6a **恢复是自动的**：探测范围是全集（D1），因此每轮都会**重测**上轮判 `dead` 的模型；一旦探活即回到可见集，无需人工干预。
- D6b **探测范围是闸门前的派生目录全集**：不以 Zen `/models` 交集收窄——探测本身就是更准的可用性判据（Zen 未在列的模型探针会确定性失败，自然落入 `dead`），无需第二道闸门。
- D6c **触发时机**：与目录同步解耦。探测轮次在「目录已非 `builtin-fallback` **且** 今日尚无探测轮次」时，于首次读目录时**懒启动、fire-and-forget**，不阻塞任何请求（沿用既有懒重验证模式）。
- D6d **两道闸门叠加**：可见 = （目录 ∩ Zen `/models` 在列）且 非 `dead` 判定。探测**只做减法**，绝不把不可见模型加回可见集。
- D6e **`excluded` 语义变更**：`excluded` 由「免费但未提供（deprecated ∪ Zen 未在列）」改为**仅「探测判定 `dead` 的模型名」**，面板灰字据此显示「探测判定不可用」。
  「免费且 active 但 Zen 未在列」者会同时离开 `visible` 与 `excluded`（同「上游整条删除」命运）；这是可接受的——这类模型探测时会得到 404/不再提供 → 落入 `dead` → 重新出现在 `excluded`，可解释性由探测恢复，不靠旧 bucket 兜。
- D7 **结论持久化**：并入现有 catalog 缓存（`version` 保持 1），新增可选字段
  `probes: Record<id, { verdict: "ok" | "dead"; at: number; reason?: string }>`。
  - **只持久化确定性结论**；`inconclusive` **一律不落盘**（否则会与 `dead` 混淆，直接违反 D5）。该模型因此保持「未探测」状态，下一轮自然重测。
  - 字段缺失 = 无历史 = 全集待探。不 bump version（该缓存从未发版）。
- D8 **手动端点**：`POST /dsh-opencode-free/api/probe` → 触发一轮顺序探测、**等待完成**后返回与 `/api/catalog` 同形状的快照。与 `/api/refresh`（同步目录）分开，避免按钮语义含糊。
- D9 **退役**：D2 的「非 deprecated 才显示」规则被 D6 取代；面板的「deprecated 灰字」说明改为「探测判定失败」。

## Cost Statement（显式取代旧决策）

- 每轮 = 目录内模型数次请求，当前 **34**（8 active + 26 deprecated，会随目录变化），**每天一轮** + 手动追加。
- 落在 Zen **匿名額度**（按出口 IP 共用的共享桶）上；推理模型即使提示极短也消耗 reasoning token。
- 本决策**取代** `docs/spec-v0.2.md` 的「不做背景自动刷新（副作用与額度成本）」——该条原本是为省额度而立，此处为准确率显式付费。README 与 ADR 必须如实披露，用户可随时关掉/降频（见 Non-goals 的可配置出口）。
- 顺序发送（不并发）是对共享桶的善意限流：不给上游瞬时并发压力。

## Compatibility Boundary

- `hiddenModels` 语义、volatile、读-改-写保留未知 id、隐藏模型不可 resolve：**全部不变**
- 传输、身份四件套、重试、encrypted-content 重放、compaction、attachment：**不动**
- 探测**不改变**匿名/key 认证路径，只读一次目录做判定
- 首日列表是当前的超集（含 deprecated）；此后按探测结论收窄
- 断网/被闸：inconclusive → 列表保持上一次可用状态

## Testing Decisions（全离线，注入 fetch）

- 探针形状：断言实际请求体含 `read` 与 `bash` 工具名、streaming=true、`max_tokens ≥ 512` —— 这条是 D3 的回归守卫
- 结论分类：`ok` / `dead`（具体 4xx 报文）/ `inconclusive`（403 FreeTierError、5xx、超时）三态各有用例
- **D5 守卫**：全集同时返回 403 FreeTierError 时，可见性**逐字不变**（这条直接钉死"列表被清空"这一失败模式）
- 可见性收敛：未探测全显 → 某模型 `dead` 后消失、其余不变 → 面板灰字含该 id
- 节奏：一天内第二次自动探测被跳过；手动可绕过；同轮并发调用只跑一轮
- 顺序：断言请求按目录顺序逐个发出（无重叠）
- 持久化：`probes` 落盘与回读；字段缺失时视为无历史

## Non-goals

- 并发/分批探测（用户明确选择顺序不分批）
- 自适应退避、按模型 token 预算
- 用探测结果反哺 models.dev（我们不上报）
- 为付费模型探测
- 探测历史上限/压缩（目录规模小，暂不需要）

## Retirement

| 对象 | 处置 |
|---|---|
| D2「非 deprecated 才显示」规则 | 被 D6 取代（`docs/adr/0002` 同节修订） |
| 面板「deprecated 灰字」文案 | 改为「探测判定失败」（`src/client.js` 字典） |
| `docs/spec-v0.2.md`「不做背景自动刷新」 | 标注被本 spec 显式取代 |

## Acceptance（可观测）

1. 面板点「立即探测」→ 顺序跑完全集 → 列表按结论收窄，`dead` 的进灰字
2. `muse-spark-1.2-contributor-free` 探活后**回到可见**；`deepseek-v4-flash-free` 被探死后隐藏
3. 模拟全集 403 FreeTierError → 列表与面板**完全不变**，并提示结论不可信
4. 一天内重复点手动 → 仍可跑（手动不受每日上限约束）；自动一天只跑一轮
5. 探针请求体含 read+bash、streaming、max_tokens≥512（有守卫用例）
6. `hiddenModels` 显隐行为不回归；`pnpm test` 全绿且行为用例不减少

> **Superseded.** 本文件是历史推理，已落地。当前事实见
> [`docs/adr/0002-catalogue-source-of-truth.md`](../../docs/adr/0002-catalogue-source-of-truth.md)
> 与 [`CHANGELOG.md`](../../CHANGELOG.md)；已知矛盾见 [`../README.md`](../README.md)。
