# M3 实施记录

## 实施计划（实现前）

- 分支：`feat/m3-refresh-lifecycle`；模型：`opencodex/gpt-5.6-luna high`；仅修改本包，不升级版本、不发布/push、不启动其他模型。
- R1：将 P0 Session holder 扩展为 idle/initializing/active/closing/closed 状态；保留 Session 级 source budget；实现共享初始化、查询 runtime lease、关闭等待与失败重试。
- R2：为每个 Session 建立有界串行 refresh 队列；每个任务独立采集候选，读取竞争最多一次全量重试；在取消/deadline/关闭时协作停止并清理候选，失败不影响旧 runtime。
- R3：增加 `context_refresh_snapshot` 工具与原子提交；查询捕获旧 runtime 后继续完成，新查询校验当前 snapshot；refresh 响应返回 snapshot/indexFingerprint/changed/extraction/scan coverage；预算不随 refresh 重置。
- R4：以确定性注入屏障覆盖初始化等待者取消、初始化期间 refresh 排队重新采集、旧 lease 延迟释放、提交前取消/关闭禁止提交、提交后清理失败不回滚、refresh 失败保留旧 runtime、队列继续执行等场景；运行相关测试、类型检查、构建与 smoke。
- 文档：实现完成后更新本文件实际 commit、测试结果和限制，并收敛 README 的 M3 状态；不宣称 M4 cache/M5 发布或未执行的真实仓验收。

## 当前状态

计划已记录，待实现。
