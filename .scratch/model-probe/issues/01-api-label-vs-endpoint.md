Status: resolved

# `api` 标签与实际端点并没有对调——是我的量测方法错了

## 原报告（已作废）

曾断言：`api: "openai-responses"` 落到 `/chat/completions`，`api: "openai-completions"`
落到 `/responses`，因此怀疑存在传输层交换，并推论「每个模型每轮都在多花一次注定失败
的请求」。

## 为什么不成立

**量测方法错在只记录了最后一次 fetch。** 那个脚本用 `last = {...}` 覆盖式赋值，
于是读到的是 `probeModel` 通道扫描的**第二次**调用，而不是第一次。

`probeModel`（`src/zen-provider.ts`）本来就按顺序问两条通道，且有短路：

```js
if (outcome.kind === "ok" || isCallerScoped(outcome)) return outcome;
```

所以健康模型**只发一次**。改成追加记录后，第一次调用的落点是正确的：

| model.api | 第一次调用 |
|---|---|
| `openai-responses`（muse-spark-1.2/1.3） | `POST /zen/v1/responses` |
| `openai-completions`（其余 5 个内建记录） | `POST /zen/v1/chat/completions` |

pi-ai 侧也确认：派发是 `apiFor = (model) => byApi?.[model.api]` 的精确匹配，
`openai-responses` 调 `client.responses.create` → `POST '/responses'`；
`patchCompatDirectTransport` 原样传 `model`，不交换传输层。

**两次判断都错在同一处**：我提出"每个模型每轮多花一次请求"，也是同一个方法错误的
推论——短路让第二个调用在健康路径上根本不发生。

## 教训（比结论重要）

**用一个会覆盖的单变量去记录可能发生多次调用的路径，读到的必然是最后一次。** 通道
扫描让「一次探测 = 一次请求」这个前提本来就不成立，而我没有在记录时就质疑它。

正确的量测形状是**追加**而不是覆盖，并且在断言前先问「这个量在本次运行里出现
几次」。第二版用 `calls.push(...)` 之后，两个结论一起翻了。

## 顺带确认的事实

- `muse-spark-*` 走 `/zen/v1/responses`，与 `opencode2pi-desktop` 的说法一致，无矛盾。
- 探针在**传输失败**时会扫第二条通道（`isCallerScoped` 不含 `transport`）。
  这是一次失败后的额外请求，不影响健康路径的成本叙事。
- `space-bunny-free` 不在 pi-ai 内建表，走第二层推断：models.dev 对它同时发布
  `interleaved` 与 `reasoning_options[type=effort]`，`channelFor` 的 `interleaved`
  优先，因此判为 `openai-completions`。这是全项目**唯一一处靠优先级而非唯一信号**
  做判定的地方，比其他层脆弱，值得单独验证。
