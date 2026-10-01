# Agent Note: 会话 id 哈希加每进程盐

Status: implemented

## Problem

`sessionHeader()` 用**无盐** SHA-256 把 DSH 会话 id 映射成 OpenCode 的 `ses_` 格式，随每次请求发往第三方（`x-opencode-session` 与 `x-client-request-id`）。无盐 = 确定性：任何能猜到或枚举 DSH 会话 id 形态的人，都可以用同一函数验证「这两个请求属于同一个会话」。

上游还把这个头用于粘性后端路由（`docs/reverse-engineering.md` 记录），因此这个可链接性可以进一步推出用户的会话边界与活跃时段——在设计本来就接受的「按出口 IP 共享」之上又多了一层。

## Decision

引入模块加载时生成的 `SESSION_SALT = randomBytes(32)`，混入摘要输入；不落盘、不导出。

**重启后 id 全部改变是预期行为**，不是回归：上游亲和性只在单个 DSH 会话内有意义，而插件本来就把重启当冷启动处理（Zen 闸门每次启动重新询问，探测判决按模型 id 存，与会话无关）。

## Alternatives considered

- **用 `HMAC(sha256, 进程内随机密钥, …)`**。论据是"用哈希做认证"的正统写法。否决：HMAC 与"预加盐的 SHA-256"在这个场景下等价——威胁模型是**离线枚举会话 id**而非伪造摘要消息，而两者对枚举攻击的抵抗力相同。多一个构造不值得。
- **用会话 id 的时间戳**（更早的设计，ADR 0001 否决过）。否决：会牺牲同会话内的亲和性稳定性，那正是这个头的用途。
- **保持无盐，只在文档里说明**。否决：文档不是技术控制。

## Consequences

- **收益**：第三方即使看到全部请求头，也无法把请求归并到 DSH 会话，除非它同时知道进程内的盐。
- **代价与已知上限**：DSH 重启后粘性后端亲和性失效，同一会话的前后两次运行可能落到不同后端。考虑到加密重放本身已有 `withEncryptedContentFallback` 兜底（400 + 剥离陈旧 reasoning 重试），这个代价比无盐小得多。

## Verification

`tests/compatibility.test.mjs` `session/request headers are structurally valid OpenCode ids` 仍然通过（结构不变）；`every Zen-bound path sends the same identity header names` 断言两条亲和性头取自同一值。
