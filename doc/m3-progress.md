# M3 实施记录

## 实施计划（实现前）

- 分支：`feat/m3-refresh-lifecycle`；模型：`opencodex/gpt-5.6-luna high`；仅修改本包，不升级版本、不发布/push、不启动其他模型。
- R1：将 P0 Session holder 扩展为 idle/initializing/active/closing/closed 状态；保留 Session 级 source budget；实现共享初始化、查询 runtime lease、关闭等待与失败重试。
- R2：为每个 Session 建立有界串行 refresh 队列；每个任务独立采集候选，读取竞争最多一次全量重试；在取消/deadline/关闭时协作停止并清理候选，失败不影响旧 runtime。
- R3：增加 `context_refresh_snapshot` 工具与原子提交；查询捕获旧 runtime 后继续完成，新查询校验当前 snapshot；refresh 响应返回 snapshot/indexFingerprint/changed/extraction/scan coverage；预算不随 refresh 重置。
- R4：以确定性注入屏障覆盖初始化等待者取消、初始化期间 refresh 排队重新采集、旧 lease 延迟释放、提交前取消/关闭禁止提交、提交后清理失败不回滚、refresh 失败保留旧 runtime、队列继续执行等场景；运行相关测试、类型检查、构建与 smoke。
- 文档：实现完成后更新本文件实际 commit、测试结果和限制，并收敛 README 的 M3 状态；不宣称 M4 cache/M5 发布或未执行的真实仓验收。

## 实现结果

初轮实现交付了 M3 主路径，但主线程复核发现并发漏洞和 R4 证据不足；不再宣称 R1–R4 完整验收。生产实现主要位于 `src/p0-runtime.ts`、`src/p0-query.ts`、`src/p0-tools.ts`；refresh smoke 已接入 `tests/loader.spec.ts`，并新增 `tests/p0-refresh.spec.ts`。默认入口现在注册五个 P0 工具，仍无 cache/blockId 和 V1 contextCompiler。

- R1：Session 生命周期、共享初始化、失败后重试、查询 lease、旧 runtime 退役保留、关闭等待和 Session 级预算。
- R2：每 Session 有界串行 refresh 队列（16 个在途/排队任务上限）；候选构建独立采集，读取竞争最多进行一次全量重试；失败、取消和关闭不发布候选。
- R3：`context_refresh_snapshot` 返回 `snapshotId/indexFingerprint/changed/extraction/scanCoverage`，提交前检查取消和关闭，提交为同步 runtime 替换；旧查询固定旧 runtime，新查询捕获新 runtime；预算对象不替换。
- R4（部分）：已覆盖编辑后定位、旧 lease 可继续读取、失败保留旧 runtime、刷新取消/关闭、初始化 timeout/cancel/retry，以及真实 Native registry refresh smoke。退役资源释放观察和清理失败不回滚仍缺独立证据。

## 提交

- `7b5b85e` `docs: record M3 refresh lifecycle implementation plan`
- `2c6c4f5` `feat: implement M3 refresh lifecycle and tool`
- `1a2da4a` `docs: record M3 validation and lifecycle limits`
- `49321b6` `docs: align M3 cache and milestone wording`
- `ca2cada` `fix: isolate queued refresh cancellation and close`
- `ac35d97` `test: cover refresh queued during initialization`

## 验证（截至当前）

已通过：

```text
node node_modules/typescript/bin/tsc --noEmit --incremental false --composite false --pretty false
node node_modules/vitest/vitest.mjs run tests/p0-refresh.spec.ts
node node_modules/vitest/vitest.mjs run tests/loader.spec.ts tests/p0-refresh.spec.ts
node node_modules/vitest/vitest.mjs run
node node_modules/tsdown/dist/run.mjs --out-dir lib --external typescript
```

初轮全量结果：21 个测试文件、210 个测试通过（M2 基线 205 + M3 refresh 5）。构建成功。尚未运行/记录独立真实仓 gold/edit-refresh runner；这属于 M5 范围。尚未接入 M4 cache、watcher、增量刷新、跨快照 locator、LSP 或下游迁移。

## 主线程复核修正

- `15abaca`：修复初始化失败后队首 refresh 未登记 initial、普通查询/后续 refresh 可启动竞争构建的问题。所有 refresh 统一进入同一有界队列，idle 首建也计入 16 上限；无 active 的队首构建进入共享初始化。提交异常也恢复初始化状态，关闭先发布清理 Promise 再广播 abort，防止同步监听器重入。
- 新增 `tests/p0-refresh-review.spec.ts` 四个确定性屏障测试：初始化失败后的共享构建、idle 首建过载/真正排队取消、已排队任务在前项失败后继续、仅由关闭取消候选及等待旧 lease。纠正原测试名称与断言不符的表述。
- 主线程验证：全量 22 文件 / 214 测试通过；TypeScript noEmit 类型检查、tsdown 构建、git diff --check 通过。
- 尚未完成：resolver 级读取竞争全量重试次数、提交前屏障、退役释放/清理失败不回滚证据，以及设计 §7.3 要求的生命周期结构化日志。现有 P0 runtime 仅持有内存索引与无长期句柄的 reader；不能把垃圾回收当成已测试的可失败 close 操作。
- 日志接入待确认：当前 plugin/resolver 未提供日志 sink；邻包 telemetry 是 session/event 的被动采集器，未提供任意日志写入服务。不擅自新增遥测框架或变更跨包事件合同。README 已降级为主路径已实现、R4 完整验收待完成。
