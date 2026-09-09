# M3 实施记录

## 实施计划（实现前）

- 分支：`feat/m3-refresh-lifecycle`；模型：`opencodex/gpt-5.6-luna high`；仅修改本包，不升级版本、不发布/push、不启动其他模型。
- R1：将 P0 Session holder 扩展为 idle/initializing/active/closing/closed 状态；保留 Session 级 source budget；实现共享初始化、查询 runtime lease、关闭等待与失败重试。
- R2：为每个 Session 建立有界串行 refresh 队列；每个任务独立采集候选，读取竞争最多一次全量重试；在取消/deadline/关闭时协作停止并清理候选，失败不影响旧 runtime。
- R3：增加 `context_refresh_snapshot` 工具与原子提交；查询捕获旧 runtime 后继续完成，新查询校验当前 snapshot；refresh 响应返回 snapshot/indexFingerprint/changed/extraction/scan coverage；预算不随 refresh 重置。
- R4：以确定性注入屏障覆盖初始化等待者取消、初始化期间 refresh 排队重新采集、旧 lease 延迟释放、提交前取消/关闭禁止提交、提交后清理失败不回滚、refresh 失败保留旧 runtime、队列继续执行等场景；运行相关测试、类型检查、构建与 smoke。
- 文档：实现完成后更新本文件实际 commit、测试结果和限制，并收敛 README 的 M3 状态；不宣称 M4 cache/M5 发布或未执行的真实仓验收。

## 实现结果

R1–R4 已实现，生产实现主要位于 `src/p0-runtime.ts`、`src/p0-query.ts`、`src/p0-tools.ts`；refresh smoke 已接入 `tests/loader.spec.ts`，并新增 `tests/p0-refresh.spec.ts`。默认入口现在注册五个 P0 工具，仍无 cache/blockId 和 V1 contextCompiler。

- R1：Session 生命周期、共享初始化、失败后重试、查询 lease、旧 runtime 退役保留、关闭等待和 Session 级预算。
- R2：每 Session 有界串行 refresh 队列（16 个在途/排队任务上限）；候选构建独立采集，读取竞争最多进行一次全量重试；失败、取消和关闭不发布候选。
- R3：`context_refresh_snapshot` 返回 `snapshotId/indexFingerprint/changed/extraction/scanCoverage`，提交前检查取消和关闭，提交为同步 runtime 替换；旧查询固定旧 runtime，新查询捕获新 runtime；预算对象不替换。
- R4：测试覆盖编辑后定位、旧 lease 延迟释放、失败保留旧 runtime、刷新取消/关闭、初始化 timeout/cancel/retry，以及真实 Native registry refresh smoke。

## 提交

- `7b5b85e` `docs: record M3 refresh lifecycle implementation plan`
- （待最终实现测试通过后提交生产代码、测试与文档）

## 验证（截至当前）

已通过：

```text
node node_modules/typescript/bin/tsc --noEmit --incremental false --composite false --pretty false
node node_modules/vitest/vitest.mjs run tests/p0-refresh.spec.ts
node node_modules/vitest/vitest.mjs run tests/loader.spec.ts tests/p0-refresh.spec.ts
node node_modules/vitest/vitest.mjs run
node node_modules/tsdown/dist/run.mjs --out-dir lib --external typescript
```

当前全量结果：20 个测试文件、209 个测试通过（M2 基线 205 + M3 refresh 4）。构建成功。尚未运行/记录独立真实仓 gold/edit-refresh runner；这属于 M5 范围。尚未接入 M4 cache、watcher、增量刷新、跨快照 locator、LSP 或下游迁移。
