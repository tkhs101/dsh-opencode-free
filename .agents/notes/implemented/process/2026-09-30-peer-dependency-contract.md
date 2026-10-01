# Agent Note: 被源码顶层 import 的包不能声明为可选 peer

Status: implemented

## Problem

`package.json` 把四个 peer 依赖全部标为 `optional: true`，而 `src/index.ts` 与 `src/zen-provider.ts` 对它们全部是顶层无条件 `import`。包管理器据此不安装它们，也不告警——用户装上后在 `import { createModels } from "@earendil-works/pi-ai"` 处得到 `ERR_MODULE_NOT_FOUND`。

同一时刻 README:53 与 AGENTS.md:19 都写着「不要忽略 peer dependency 警告」。警告根本不会出现，于是这句话无从遵守；AGENTS.md 又声明「不要把 `peers check` 当作完成测试」，形成"警告不可见 + 唯一检查工具被否决"的闭环。

更麻烦的是 `tests/compatibility.test.mjs:86` 有一条**强制**断言把这个状态锁死：

```js
assert.equal(pkg.peerDependenciesMeta[name]?.optional, true, name)
```

于是"元数据与代码矛盾"被测试保护成了一个不变式。维护者（2026-09-30 仓库所有者）确认真实意图是"缺包必然崩"，选择了翻转。

## Decision

删除 `peerDependenciesMeta` 整节，四个 peer 全部为必需；断言从"必须 optional"改为**不变量**：

> `src/` 顶层 import 的包，不得声明为 optional peer。

这条写法比"必须非 optional"更耐用：将来新增依赖时，它检查的是代码与元数据是否一致，而不是某个一次性状态。

## Alternatives considered

- **保留 `optional`，在 README 解释"缺包即崩，所以请自行确认"**。论据是 `optional` 原本可能为了避免自动装进宿主 bundle。否决：无论意图如何，让安装器对一个必然崩的组合保持沉默，是把检测成本转嫁给用户；而 README 已经承诺 DSH 提供这四个包。
- **保留 `optional` 但删掉那条锁死断言**。论据是最小改动。否决：只去掉守卫不改状态，等于把一个已知错误留给下一个读代码的人。

## Consequences

- **收益**：安装期就能看见 peer 缺失/版本不匹配；`tests/compatibility.test.mjs` 从固化错误状态变为检查一致性。
- **代价与已知上限**：宿主若因故未提供其中之一，现在会在安装期报冲突而不是运行时崩——这正是想要的顺序。若将来真的需要降级（例如某天在 `src/` 里改成动态 import），应在新笔记里写明并同步翻转断言，不要原地改这一条。

## Verification

`tests/compatibility.test.mjs` `targets the DSH 0.2.0-rc.2 contracts`：遍历 `peerDependencies`，断言 `peerDependenciesMeta[name].optional !== true`。
