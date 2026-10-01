# Agent Note: 探测轮必须等热读落地，否则它对着空探针表下判断

Status: implemented

## Problem

`runProbeRound` 要读 `state.probes` 两次：一次决定哪些模型已经settled、这次不用再问，一次填 `priorVerdict` —— 而 `priorVerdict` 是全插件**唯一**能区分「本轮刚下架」和「复核了早就下架的模型」的东西。`state.models` 同理，决定这轮问谁。

这些数据都随热读（`warmStart()` 里的 `readCache` + `adopt`）进入内存，而热读是刻意的 fire-and-forget：容器必须能同步作答。于是**一轮探测可以在热读落地之前开跑**，此时 `state.probes` 是空的：

- 每个既有结论都读成「未知」，于是已经知道答案的模型被重新问一遍（真实消耗共享额度）；
- `priorVerdict !== 'dead'` 恒真，于是几小时前就离开列表的模型被记成「本轮下架」。

2026-10-01 在 Linux CI 上暴露：`re-confirming an old death` 那条测试约 3/8 的失败率，且只在 Node 24 上出现。诊断插桩显示失败轮次 `done: 7 / total: 6`、通过轮次 `done: 8`，而 `big-pickle` 那一行的 `removed` 在两轮之间从 `true` 变成 `false` —— 同一个模型、同一份数据，只是热读有没有赶上。

`sync()` 早就在等同一个 promise，理由写在它自己的注释里（不能让同步和热读交错）。探测轮漏了这一道。

## Decision

`runProbeRound` 开头也等 `deps.warm`，用 `Promise.race` 卡上 `warmReadTimeoutMs`（与 `sync()` 同一上限），之后才取 `deps.now()` 并做任何判断。

放在 `runProbeRound` 而不是 `forceProbes` / `runProbes`：

- 真正读 `state.probes` 的是它，所有入口自动受益；
- `forceProbes` 里那道 5 分钟地板读的也是 `state.lastProbeAt`，热读没落地时它是 `0`，于是地板被绕过、轮次照跑。把等待放进 `runProbeRound` 之后，`priorVerdict` 与「这轮问谁」看到的是同一份内存。

顺带修掉那条测试：它从来没驱动过自己那一轮。冻结时钟下地板恒成立，`forceProbes()` 直接返回，读到的是热启动那轮 fire-and-forget 的报告——读到哪一份全看时序。改用既有的 `pastProbeFloor(clock)`（别的要第二轮的测试都这么做），它现在判断的是自己要判断的那一轮。

## Alternatives considered

- **在 `forceProbes` / `runProbes` 里等** —— 能挡住地板被绕过，但 `runProbeRound` 是导出给测试直接驱动的接缝，绕过工厂直接调用时仍无保护；而且入口一多就容易再漏一个。否决。
- **无条件等，不设超时** —— 一个卡住的文件系统会让「Probe now」永远转圈。`sync()` 已经有 2s 上限，复用它而不是发明第二个。
- **把 `adopt` 改成同步** —— 热读读的是几 MB 的缓存文件，容器必须同步作答，正是热读被设计成异步的原因。不否决整条设计，只补上缺失的一道闸。

## Consequences

- 探测轮与目录同步现在共用同一条「热读已落地或已超时」的保证。
- 热读超时（文件系统卡住）时轮次照常开跑——退化成修复前的行为，而不是挂死。
- **新增的守护测不住工厂路径**：热读是否先落地取决于本地文件系统时序，把这道等待删掉，其余测试全绿（已实测 0/10 失败）。因此在 `runProbeRound` 这个接缝上加了一条自带 `warm` 的用例，直接控制热读何时settle——删掉等待即刻失败（已实测）。