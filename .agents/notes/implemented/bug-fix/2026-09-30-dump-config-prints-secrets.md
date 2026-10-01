# Agent Note: --dump-config 会打印明文密钥，校验流程不得裸跑它

Status: implemented

## Problem

README 与 AGENTS.md 都把 `dsh --profile web --dump-config` 列为安装校验步骤，而同一份 AGENTS.md 第 10 行写着 "Never print API keys, credential stores, or request bodies"。README 又教用户把 Zen key 写进 profile 的 `cordis.patch.yml` 的 `config.apiKey`。

两条加起来：文档教的配置方式 + 文档教的校验方式 = 明文 key 打到 stdout。

2026-09-30 直接读已安装宿主的实现核实，不是推断：
`@deepseek-ai/dsh/lib/dump-config-BEDI-dNY.js` 中 `collectConfigDumpLayers` 把解析后的 `cordis.patch.yml` 全文压入 layers，`renderConfigDump` 逐行渲染后 `process.stdout.write`；该文件中 `redact` / `REDACT` / `mask` / `***` 的出现次数为 **0**。

定级为 High 而非 Critical：触发它需要用户既已配置 key、又主动执行了文档指定的校验命令，泄露范围限于用户自己的终端，不涉及远端暴露。终端回滚缓冲、录屏、CI 日志，以及把命令输出整段读进上下文的 Agent，都会留下明文。

## Decision

不试图在插件侧修宿主命令（那超出本插件的边界，且 `Config.apiKey` 用的是 schemastery 的普通 `z.string()`，宿主是否支持脱敏渲染未知）。改为**让文档停止把这条命令当作默认校验步骤**：

- README / README.zh-TW 的校验段落只保留 `dsh plugin --profile <name> list dsh-opencode-free --depth 0`，它不碰密钥。
- 需要确认 composed config 时，`--dump-config` 降级为"在**未配置 key 的 profile** 上运行"的显式选择，并就地给出 `> [!WARNING]`。
- AGENTS.md 的 Safety 条目写明该行为，并把不碰密钥的替代命令写在同一行，让 Agent 不会在报告里把两者混用。

## Alternatives considered

- **给 `Config.apiKey` 加 schemastery 的 sensitive 标记，期待宿主渲染时脱敏**。论据是修在根上、且与 README 的能力对齐。否决：无法确认 DSH 的 `renderConfigDump` 是否消费这类标记——宿主产物里脱敏逻辑为零，说明它至少当前不消费；在未验证的机制上押注会把一个确定的文档缺陷换成一个不确定的运行时行为。
- **让 README 只推荐 Desktop 的 `file:` 流程，完全不提校验命令**。否决：校验本身有价值，删掉它会让用户失去唯一的"插件真的进配置了吗"检查点。

## Consequences

- **收益**：照 README 走的用户不会再把 key 打进终端；Agent 不会把"路径不存在"或"key 无效"混为一谈。
- **代价与已知上限**：想确认 composed config 的用户仍需自己判断该不该跑那条命令。若宿主将来支持脱敏渲染，应恢复为默认步骤并撤掉警告——判据是 `renderConfigDump` 出现脱敏逻辑。

## Verification

`tests/compatibility.test.mjs` 与文档同批更新；该警告目前靠人工校对维持。回归检查点：任何再次新增 `--dump-config` 文档段落的改动，都必须同时带脱敏提示。
