# Agent Note: 探测轮报告只有一个写入者，且必须同时更新内存与磁盘

Status: implemented

## Problem

`CatalogCacheRecord.lastRound`（面板的"上一轮战报"）被两个写入者分别写到**同一个文件**：探测轮 `runProbeRound` 和目录同步 `sync`。两份代码各自算出要带哪些字段，结果：

1. `sync` 的 304 分支用 `cache = { ...cache, fetchedAt }` 展开旧对象，**保留了** `lastRound`；
2. `sync` 的全量下载分支用对象字面量**重建** `cache`，字段表里没有 `lastRound`，紧接的 `lastRound: cache?.lastRound` 读到 `undefined`，`writeCacheAtomic` 于是跳过该字段——报告被删除。
3. 更深一层：`runProbeRound` 写盘后**没有回写内存里的 `cache`**，所以即使同步分支修好，它携带的仍是上一轮（或 `undefined`）。

2026-09-30 复现：全量同步 → 探测轮 → 再次全量同步，落盘 `lastRound` 消失。面板表现是"探测显示不见了"，正如该字段注释所写。

仓库里那条守护它的测试是三重假绿：标题泛化到"a revalidation"，但 `scriptedFetch` 只返回 304；且不传 `ttlMs`（默认 24h）却只推进时钟 6h01m，`stale()` 恒为 false——**它一次同步都没发起**。删掉被守护的代码后 88/88 仍全绿。

## Decision

确立"探测轮报告单一写入者 + 双写内存/磁盘"：

- `runProbeRound` 算出 `report` 后，`writeCacheAtomic(...)` 与 `cache = { ...cache, lastRound: report }` 在同一处完成。
- `sync` 的全量分支改为显式携带 `previousRound`，与 304 分支对称；注释改成事实描述。
- 守它的测试改为**表驱动覆盖 `ok` 与 `not-modified` 两种结果**，显式传 `ttlMs: 60_000`，并在断言落盘内容**之前**先断言 `fetchImpl.calls.length === 2`——证明重验证真的发生了。

## Alternatives considered

- **把 `lastRound` 移出缓存文件，改为独立文件**。论据是两个写入者本来就不该共享一个文件。否决：它把一次字段丢失换成一次 schema 迁移，代价远大于收益，而且报告本来就要和判决一起原子落盘。
- **在 `writeCacheAtomic` 里对已存在记录做字段级合并**。论据是从根上消灭"谁忘了带哪个字段"。否决：合并语义要求读-改-写，与"一次原子写"的现有契约冲突，且会掩盖真正的调用方 bug。

## Consequences

- **收益**：任一同步路径都不再删除报告；那条测试从空转断言变成真守卫（变异验证：删掉携带行 → 87/88，该测试变红）。
- **代价与已知上限**：`cache` 现在被 `runProbeRound` 重新赋值，未来若有闭包缓存了旧 `cache` 引用会读到过期对象。当前 `sync` 每次都从 `cache` 重新取值，暂无此类持有者；若新增，需重新审视。
