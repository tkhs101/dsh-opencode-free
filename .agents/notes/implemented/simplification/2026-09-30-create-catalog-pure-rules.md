# Agent Note: createCatalog 的纯规则上移，不动它的编排

Status: implemented

## Problem

`createCatalog` 是一个约 570 行、内部 8 个闭包共享十余个可变变量的工厂函数：缓存的加载与采用、目录抓取与条件 GET、TTL 自适应、Zen 闸门刷新与准入判定、探测轮的调度与判决、原子落盘、对外快照的组装，全在一处。

两个具体代价，都已经兑现过：

- **规则被埋住。**「一次探测的结果怎么变成面板那一行」这条规则——`ok` 之外必须带 `code`，`http: 0` 表示"从未收到状态"，而**重新确认一个旧判决不算本轮移除**——曾经夹在轮次循环的传输代码中间，肉眼扫不出来。
- **无法单独测试。**上面每条规则要测，都得建一个 Catalog、驱动一轮、再读结果。代价高，且够不到那些尴尬的输入。

## Decision

**只把纯规则上移，编排一行不动。** 617 → 504 行；每上移一条就跑一次测试，失败即回滚。

上移到模块级（各自成为纯函数，导出以便直接测）：

| 函数 | 它是什么 |
|---|---|
| `probedToday(lastProbeAt, now)` | 本地日历日闸门，不是滚动 24 小时 |
| `effectiveTtl(pinned, fallback, wasNotModified)` | 保守 24h 与被 304 挣来的 6h |
| `catalogueIsStale` / `gateIsStale` | 两条独立的过期轴 |
| `effectiveList(models, zenIds, probes)` | 闸门与判决的复合过滤 |
| `unknownFree(models, zenIds)` | 盲区只报名字，永不参与成员判定 |
| `planRound(models, live, served, probes, hidden)` | 这一轮会**问**什么 / Zen 已经**下架**什么 |
| `probeRowFor(outcome, elapsed, priorVerdict)` | 一次结论如何变成面板那一行 |

`admissibleGate` 此前已在 #29 中上移，`readCache`/`writeCacheAtomic` 本来就是模块级。

上移之后，`createCatalog` 内保留三个一行别名（`currentTtl` / `stale` / `gateStale`），让调用点继续读成问题而不是表达式。

## Alternatives considered

- **把 `runProbeRound` 整个抽出去。**论据是它还有 125 行。否决：它需要 `probeRun`、`probes`、`lastProbeAt`、`probeUntrusted`、`cache`、`path`、`now`、`probe`、`listZenIds`、`hidden` 十个闭包变量，抽成模块函数意味着十个参数——那是把"函数太长"换成"参数太多"，两个方向都在往耦合上走。状态性的编排留在闭包里是对的。
- **把返回的 API 对象（87 行）也拆开。**否决：那是 `Catalog` 接口的实现，天然住在一个地方；每个方法本来就短，拆开只会让读者在四个文件之间跳。
- **连同类型一起重构成 class。**否决：那不是"更干净"，是换一种写法做同一件事，而本次没有第二种写法的收益。

## Consequences

- **收益**：七条规则各自可直测。新增 `tests/catalog.test.mjs` 末尾的纯函数组直接覆盖了容器测不到的输入——本地日历日闸门的午夜跨界、"从未问过"按定义过期、重新确认不构成移除、既已判决又被下架的模型两个桶都不进。写这些测试时我自己有两条期望写错（`notListed` 的语义、以及一个 fixture 的 probe 键与模型 id 不匹配），是代码对、测试错。
- **代价与已知上限**：`createCatalog` 仍有 504 行，超过 100 行的阈值。要再降就得动编排本身——把状态收进一个显式的 `CatalogState` 对象、或者拆成可组合的小对象。那是**行为可见**的改动（模块边界变了），不是本次"纯机械"范围内的东西，应当单独一次决策、单独评审。
- 每条上移的规则都做了变异验证：删掉对应实现后测试必须变红。七条全部成立。

## Verification

`tests/catalog.test.mjs` 99 条（新增 5 条纯函数测试），全套 162 条。
变异验证（删掉实现 → 期望转红）：`planRound` 的 targets 过滤 95/99、`probeRowFor` 的 removed 标志 97/99、`probedToday` 的本地日比较 96/99。
`pnpm run check` 全绿。
