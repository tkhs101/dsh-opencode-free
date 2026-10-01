# Agent Note: 目录状态改由单一所有者持有（部分实施）

Status: implemented

## Problem

`createCatalog` 用十四个独立的 `let` 绑定，被工厂闭包捕获。这让「谁拥有状态」是隐式的，也让任何一段逻辑只能通过「建整个 Catalog → 驱动一轮 → 读结果」来测。

2026-09-30 已经把七条**纯规则**上移到模块级（`probedToday`、`effectiveTtl`、`catalogueIsStale`、`gateIsStale`、`effectiveList`、`unknownFree`、`planRound`、`probeRowFor`），`createCatalog` 从 617 降到 520 行。剩下的部分里最难测的是 `runProbeRound`：125 行，闭包捕获十余个变量。

## Decision

**给状态一个显式的所有者，并把依赖它的函数全部搬出来。**

引入 `interface CatalogState`（十四个可变字段）与 `interface CatalogDeps`（外部世界的九项），工厂里变成 `const state = initialState(builtinBaseline)` 一句，随后 139 处闭包引用改写为 `state.x`。

函数上移在同一天续做完成，见文末的续记。

## Alternatives considered

- **脚本化搬运函数**（原计划）。否决的理由不是"太慢"，而是**它反复在错误的位置切开文件**。连续四次失败，每次是同一类错误的不同变体：对象字面量简写 `{ x }` 被当成值引用改写（JS 简写不接受成员表达式）；块边界按"下一个声明"取时吞掉了中间的所有声明；按"文档注释结尾"取时对一个没有文档注释的函数失效；以及**脚本里硬编码的行号**在它上方加了两行之后静默切错。所有这些都发生在决定用户能看到哪些模型的代码上。
- **手工一次搬完四个函数。**论据是脚本的失败都源于自动切分，人工不会。否决：单次改动面太大，一次失手就要回滚整段——而脚本方式的每一步都能单独验证。
- **什么都不做。**否决：`state` 这一步已经把 139 处隐式捕获变成显式访问，且改动是可验证的（见下）。

## Consequences

- **收益**：状态所有权从「闭包隐式」变成「一行声明 + 136 处 `state.x`」；`CatalogDeps` 把「不属于状态的字段」这条边界写了下来。`createCatalog` 520 → 498 行。
- **代价与已知上限**：`createCatalog` 仍有 202 行，刚过 100 行阈值；再降就要动接口实现本身，那个收益远小于改动面，暂不做。

## Verification

- `tsc --noEmit` 通过（139 处改写中，误伤对象键 5 处、简写属性 11 处，均由编译器精确定位后逐个修复，没有靠正则猜测）。
- 162 个测试通过；`pnpm run check` 退出码 0。
- **六条变异守卫全部仍会红**（逐条删除对应实现后）：`gateInflight` 单飞 98/99、`runSingle` 单飞 98/99、原子 `rename` 82/99、`readProbes` 校验 98/99、`readLastRound` 校验 98/99、`swept` 标记 95/99。一个悄悄解除武装的重构比一个跑挂测试的重构更糟，所以这一条是硬门槛。

## 给下一步的教训

**不要用脚本搬运跨越语法边界的代码。** 若仍要上移函数，一次只搬一个，手工改它内部的那几处引用，跑测试确认，再搬下一个。单函数作用域内的人工改动是可靠且可 review 的；跨整个工厂的正则替换不是——四次失败里有三次是同一种误伤的不同变体，第四次是硬编码行号的静默失效。
## 2026-10-01 续：函数上移完成

上面的"部分实施"是**当天的中间状态**，同日续做完成。`adopt` / `refreshGate` / `admissibleGate` / `sync` / `runSingle` / `runProbeSingle` / `runProbeRound` 七个函数全部离开闭包，签名为 `(state, deps)`。`createCatalog` **520 → 202 行**，现在只剩：解构 options → 建 `state` → 暖读管道 → 建 `deps` → 返回 `Catalog` 接口实现。

方法与上面记的教训一致：**一次搬一个，手工改它内部那几处引用，跑测试确认，再搬下一个。** 顺序有依赖：`adopt` 必须先于 `sync`（后者调用前者）。每步都以 `tsc` 为准——不再写正则守卫，编译器就是裁判。

搬完后 `runProbeRound`、`CatalogState`、`CatalogDeps`、`initialState` 被导出，这不是为了"为了测试而导出"的坏味道，而是这次搬迁**存在的理由**：一轮探测现在可以用两个普通对象驱动，没有工厂、没有临时目录、没有网络。新增的三条测试就是这么写的（`a round can be driven with two plain objects` 等），它们覆盖了隐藏模型不花请求、被 Zen 下架与被闸门拒绝的区别、以及"什么都没学到时不动选择器"。

写这三条时我自己有两条期望写错（隐藏模型**不在**本轮范围内，而不只是不被问；`notListed` 的语义），都是代码对、测试错——这两处错误此前无法被快速发现，因为旧写法要建整个工厂才能跑到那儿。

最终验证：165 个测试通过；`pnpm run check` 退出码 0；`verify-audit-fixes` 51/51；**八条变异守卫逐条仍会红**（新增了「adopt 空目录护栏」与「同步携带 lastRound」两条，覆盖本次搬动最密的两个分支）。
