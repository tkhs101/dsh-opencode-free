# Agent Note: 卡片轮询状态必须放进 ref，且 harness 必须能模拟卸载

Status: implemented

## Problem

`ModelsCard` 的三个轮询变量（`pollTimer` / `pollActive` / `awaitingRound`）是**函数体内的 `var`**。每次渲染都产生新的一份，而 `useEffect(..., [])` 的清理函数捕获的是**第一次渲染**的那份。

用户点「立即探测」后关闭详情页：清理函数清掉的是那个恒为 `null` 的变量，真正在跑的定时器毫发无损。于是卡片消失后仍以 800ms 间隔请求 `GET /dsh-opencode-free/api/probe`，最长可达整轮探测结束（34 个模型 × 15s ≈ 17 分钟）。React 18 对已卸载组件的 `setState` 静默丢弃，连警告都没有——它连一个可见症状都没有。

审计中还有一层：**测试根本够不到这个清理函数**。`tests/client-render.test.mjs` 的 `dispose()` 只还原全局桩，从不执行 effect 的 cleanup；而且所有用例都在轮次**结束之后**才 dispose。把 `clearTimeout` 分支改成 `if (false)`，18/18 仍全绿。

## Decision

1. 三个状态合并进一个 `useRef({ timer, active, awaiting })`，所有读写走 `pollRef.current`。
2. harness 增加 `unmount()`：按 React 的方式执行 effect cleanup。`dispose()` 保持原义（只还原全局桩），两者分工明确。
3. `unmount()` **不清空** harness 的定时器表——那会掩盖被测对象。`fireTimers()` 负责排空，而"组件的 cleanup 阻止了**新**条目"才是断言。

## Alternatives considered

- **在 `useEffect` 的 cleanup 里加一个 `mounted` 标志，轮询回调自己检查**。论据是不需要 ref，改动更小。否决：标志本身还得跨渲染存活，绕回同一个问题；而且停止链条需要改的不止一处。
- **让 `dispose()` 直接执行 cleanup，不新增 `unmount()`**。论据是少一个 API。否决：`dispose()` 在 18 处被当作"还原全局桩"使用，让它顺带跑 cleanup 会在 `dispose()` 之后重新安排定时器——审计过程中实际发生了一次挂起：`dispose()` 把真 `setTimeout` 还回去，仍在跑的链于是安排了真实的 800ms 定时器并无限重排，node 进程不退出。

## Consequences

- **收益**：关闭卡片即停止请求；`unmount()` 让整个 harness 第一次能够触及 effect cleanup，后续任何 cleanup 类缺陷都可被测。
- **代价与已知上限**：测试的 React stub 新增 `useRef`，其 cell 跨渲染保留——与 `useState` 的 slot 语义一致，若将来 stub 与真实 React 行为分叉，ref 类测试会一起失真。断言仍以"React 行为"为参照，不检查 ref 自身。

## Verification

`tests/client-render.test.mjs` `unmounting mid-round stops the poll chain`。
变异验证：把 cleanup 改成空操作后该用例转红（19/20），恢复后 20/20。
审计中曾出现一个假绿：`unmount()` 里同时 `timers.clear()`，使变异后测试依然全绿——正是"守卫测试自己的替身"这一类陷阱。
