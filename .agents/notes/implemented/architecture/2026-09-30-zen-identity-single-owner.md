# Agent Note: OpenCode 身份头集合只有一个所有者

Status: implemented

## Problem

上游匿名层的准入**完全**取决于一组请求头，而这组头在仓库里被写了**四次**：`STATIC_ZEN_HEADERS` 常量、`compatRequestOptions()` 的返回对象、`patchGlobalFetchForZen()` 的守卫、`applyZenHeadersToNodeHeaders()`（供 axios/node-fetch 风格调用方）。三处函数体各自列出同样的名字，靠一句注释 "must stay in sync with requestOptions()" 维持一致。

注释能提醒，但不能强制。上游新增一个准入头时，维护者改了主路径、忘了旁路，主路径（绝大多数请求）正常，而**旁路请求静默全部 403**。现象是「同一个模型在对话框里能用，但某个走 axios 的插件里一直报 FreeTierError」，而 `classifyZenFailure` 把它归为 `anon-gated` 并建议「挂 key 也不保证解除拒绝」——一个代码遗漏被引向了错误方向。

## Decision

引入 `ZEN_IDENTITY_HEADERS`（冻结的名字列表）与 `applyZenIdentity(headers, { session, apiKey })`，fetch 守卫与 node:http 补丁都经它盖章。两个 pi-ai 选项路径（`compatRequestOptions`、`applyZenHeadersToNodeHeaders`）保留各自的形状处理，但由同一份列表驱动。

三条必须一致的 id——`x-opencode-session` 与 `x-client-request-id`——由**同一个 `session` 值**产生，不再各自调一次 `sessionHeader()`。

幂等性由构造函数保证：已存在且非空的值一律保留，因此**持有真实 Zen key 的调用方永远不会被降级成匿名层**。

新增测试 `every Zen-bound path sends the same identity header names`，覆盖 `Headers` 形状、`node:http` 的对象与数组两种形状，并断言 `STATIC_ZEN_HEADERS ⊆ ZEN_IDENTITY_HEADERS`。

## Alternatives considered

- **只加一条"三处头名相等"的测试，不改实现**。论据是改动最小，且测试才是缺的。否决：相等的三份副本仍然是三份副本，"改一份忘了另一份"依然可能——那条测试只能在**已经**不一致时才红，而不一致本身仍是每次上游变更的代价。
- **用 `Object.assign` 把静态头 merge 进各路径**。否决：`Headers` / 普通对象 / header 数组是三种形状，各路径的"已有值保留"语义还不一样，强行统一会把 node:http 那条最复杂的路径变成最易错的。

## Consequences

- **收益**：身份头从四处变一处；新增一个头只要改列表与 `applyZenIdentity` 一次。`x-client-request-id` 与 `x-opencode-session` 不再可能不一致。
- **代价与已知上限**：`compatRequestOptions()` 目前仍在自己的 `headers` 字面量里列出这七项（它是 pi-ai `StreamOptions` 的构造，不是 `Headers` 对象，没法直接复用盖章函数）。这半边尚未收敛——列表断言已覆盖它的**名字**，但若将来要统一构造方式，需要先确认 pi-ai 接受 `Headers` 实例。

## Verification

`tests/compatibility.test.mjs`；变异验证：从 `applyZenIdentity` 里去掉 `x-opencode-session` 的盖章后该用例转红（27/28）。
