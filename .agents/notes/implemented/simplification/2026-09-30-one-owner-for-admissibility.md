# Agent Note: 闸门准入判定只剩一个实现

Status: implemented

## Problem

"这份 Zen 回答能不能收窄闸门"这条判定被写了**两遍**：一遍在 `refreshGate()`，一遍在 `applyZenGate()`。两份都是 null / 非数组 / 空 / 全不相交这四层。

今天只有第一份被执行——宿主从不调用 `provider.refreshModels`（`zen-provider.ts` 里有 2026-09-30 的核实记录）。也就是说，两份实现里只有一份被验证过，而另一份随时可能被误改却不会暴露。这正是"改一份忘了另一份"会静默积累的形状，直到某个假想的宿主真的调用了 `refreshModels`——那正是它最不该失败的时候。

同批清理的还有两处防御性冗余：
- `resolveApiKey` 包了一层 `catch { throw AUTH_FAILED }`，但函数体只有 `config ?? env ?? "public"`，不可能抛；
- `toTranscript<T>(context: T): T` 声明返回调用方自己的类型，运行时却返回 `TranscriptContext`——请求路径入口处唯一一处签名与运行时形状不一致的地方。

## Decision

- 抽出纯函数 `admissibleGate(raw)`，四层判定写一次，`refreshGate()` 与 `applyZenGate()` 都调它。判定依赖当前持有的模型集合，所以它定义在 `createCatalog` 闭包内而不是模块级。
- 删掉 `resolveApiKey` 不可达的 `catch`，并移除随之无用的 `LlmError` 导入。
- `toTranscript` 返回 `T | TranscriptContext`（后者导出为类型别名），三个调用点随之下游使用；**运行时行为一字未改**。
- `refreshModels` 透传**保留**并补上原因注释：它是 pi-ai `Provider` 接口要求的成员，不是有用的实现。

## Alternatives considered

- **直接删掉 `applyZenGate` 与那层透传**。论据是死代码。否决：`refreshModels` 是接口成员，删掉会让 provider 不满足接口；而 `applyZenGate` 是它唯一的落点。判据应是"无测试能区分它有无"——本条笔记固化的是这个判据，而不是"删了更干净"。
- **`toTranscript` 用 `@ts-expect-error` 保留原签名**。论据是改动更小。否决：那把类型谎言从"编译器被骗"变成"编译器被骗且被禁止解释"，下一个读代码的人仍然看不懂为什么有这行。

## Consequences

- **收益**：四层判定一份实现、两处调用；`tsc` 现在会拦住"把 `toTranscript` 结果当 `Context` 用"这类写法。
- **代价与已知上限**：`toTranscript` 的返回类型变成联合类型，调用点若要访问字段需要先收窄——当前三个调用点都整体传给 `swapCompactionPrompt`，无需收窄。若将来有调用点要读具体字段，必须处理联合类型。
