# Agent Note: 同源栅栏必须要求 Host 指向本机

Status: implemented

## Problem

`sameOrigin()` 只做 `new URL(origin).host === host`。对 CSRF 这是**正确**的：浏览器不允许跨源请求伪造 `Origin`，缺 Origin/Referer 一律 403。

但它防不住 DNS rebinding：攻击者页面 `evil.example` 解析到 `127.0.0.1`，浏览器发出的请求里 `Origin: http://evil.example` 与 `Host: evil.example` **同源**，检查通过。用于判定的 Host 头本身就是攻击者可控的。

受影响的是 POST `/probe`——它会启动一整轮探测，34 次真实请求打在按出口 IP 共享的匿名桶上。

## Decision

在原有的 Origin/Host 比对**之前**加一道：Host 必须指名本机。

`LOCAL_HOSTS = {127.0.0.1, localhost, [::1], 0.0.0.0}`；带端口的主机名取冒号前部分，IPv6 取方括号部分，逐项小写比较。

同时给 `tests/model-visibility.test.mjs` 的 `callRoute` 增加可选 headers 参数（此前它硬编码本机头，任何"换个 host 试试"的用例都写不出来），并新增 rebinding 用例。

## Alternatives considered

- **只加 `Sec-Fetch-Site` / `Sec-Fetch-Mode` 头检查**。论据是现代浏览器会发送且不可伪造，比 Origin 更强。否决：非浏览器调用方（curl、测试工具）不发送，会把正常路径一起挡掉；且旧宿主/旧浏览器可能不发送。可以作为纵深防御叠加，但不能替代。
- **要求 `Origin` 存在且不是 `null`**。论据是沙箱 iframe 会发 `Origin: null`。否决：它挡不住 rebinding——攻击者页面不是沙箱的，Origin 是个正常值。

## Consequences

- **收益**：rebinding 无法驱动两条写路由；本机三种回环写法（IPv4 / `localhost` / IPv6）仍然可用。
- **代价与已知上限**：DSH 若将来监听非回环地址（容器、局域网），这两条路由会一律 403。届时的正确做法是让白名单可配置，而不是放宽回本地名比较。判据是本插件目前只面向桌面端 loopback 宿主。

## Verification

`tests/model-visibility.test.mjs` `a same-origin POST must still name this machine (DNS rebinding)`。
变异验证：删掉白名单判定后该用例转红（14/15）。
整改中还暴露一处测试自身的问题：原 `callRoute` 只接受 3 个参数，调用点传的 headers 被**静默忽略**——"换个 host"的用例在写出来之前就会是绿的。
