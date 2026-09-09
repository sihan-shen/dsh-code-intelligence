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
- `3e0119a`：查询 lease 只组合调用方与 Session signal；初始化 deadline 仅用于等待共享初始化，不再泄漏到已发布 runtime 的新查询。新增最小 `ResolverHooksP0` 测试/集成 seam，验证读取竞争只全量重试一次、非读取错误不重试、提交前仅取消不关闭仍不发布、退役 runtime 在最后 lease `done()` 后解除引用，以及 observer/sink 故障不改变提交结果。
- 结构化 `RuntimeEventP0` sink 覆盖排队/开始/重试/成功/失败/提交/退役/引用释放/关闭，携带有界 operation/session 关联、耗时、前后 snapshot/index、提取与扫描摘要；不记录源码、绝对路径或原始异常文本。sink 为程序化可注入接口且故障隔离；默认 plugin 按授权不扩展跨包 `session/event` 合同，因此默认部署接线仍待宿主后续明确。
- 当前 runtime 仅持有内存索引与无长期句柄 reader；退役的真实清理是解除引用，已验证 lease 边界。不存在可失败的 runtime close 操作，故“提交后 close 失败不回滚”对当前资源模型为 N/A；文件描述符由 reader `finally` 关闭，不新增虚假 close。
- 最终主线程验证：全量 22 文件 / 218 测试通过；TypeScript noEmit 类型检查、tsdown 构建、git diff --check 通过。M3 无 cache 主路径与适用于当前资源模型的 R1–R4 验收完成；默认日志接线、M4 cache、M5 独立真实仓 gold/正式 runner、watcher/增量及下游迁移不在该完成声明内。
