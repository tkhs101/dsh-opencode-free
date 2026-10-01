# Agent Note: 全局 fetch 守卫只在改写失败时回退，绝不重发

Status: implemented

## Problem

`patchGlobalFetchForZen` 的兜底 `catch` 罩住了整个函数体，而内层 `catch` 在记录日志后重新抛出同一个网络错误。rethrow 落进外层 `catch`，于是请求被用**未改写的 `init`** 再发一次：没有 `Authorization`、没有 session。上游以 403 FreeTierError 回答。

后果不是"多发一次"这么简单。2026-09-30 复现：一次用户调用变成两次上游请求，第二次 `auth=null`。于是 Wi-Fi 抖动表现为"匿名层被拒"——而 `TransportRecorder` / `describeTransportCause` / `ZEN_TRANSPORT_GUIDANCE` / `ProbeFailureCode.transport` 这一整套用来区分"网络坏了"和"上游拒绝"的机制，全被这一行 `catch` 抵消。项目花了很大力气建设的诊断能力，在最需要它的那一刻失效。

## Decision

兜底 `catch` 的作用域收窄到**只包住身份改写那一段**。

- 改写抛异常（非法 header 值等）→ 用原始 `init` 调用一次，这是唯一的回退路径。
- 改写成功后的网络失败 → 记录日志后 `throw`，**一次用户调用就是一次上游请求**。

护栏 `enforceAnonymousTools` 的"最后一跳"思路在这里同样适用：能放在最后一跳兜底的事，不要让更外层有机会重复它。

## Alternatives considered

- **保留重试，但给重试补上身份头**。拒绝的原因是它治标不治本：一次网络失败被重发本身就是错的语义（pi-ai 与 DSH 已经在自己的层做重试，`maxRetries` 策略也在那里），守卫层再重试一次是第三层重复决策。
- **删掉兜底 `catch`，改写失败就让它抛**。论据是"日志/兼容逻辑永远不该破坏请求"。否决：旁路调用方（axios/node-fetch 风格）可能传入我们不接受的 header 形状，让它们的请求整个崩掉，比降级更糟。

## Consequences

- **收益**：网络故障重新以 `transport`/`timeout` 呈现，而不是伪装成门控拒绝；共享匿名桶不再为一次抖动付两次。
- **代价与已知上限**：身份改写失败时依然静默降级为无身份请求。信号是上游开始对旁路请求返回 403 而主路径正常——那时应把改写失败也上报，而不是继续降级。

## Verification

`src/zen-provider.ts` `patchGlobalFetchForZen`。一次性脚本注入总是 `ECONNRESET` 的 fetch：修复前 `network attempts: 2`（第二次 `auth=null`），修复后 `network attempts: 1`。
