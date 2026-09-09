# M4 实施记录

## 执行计划（实现前）

- 分支：`feat/m4-optional-cache`；模型：`opencodex/gpt-5.6-luna high`。
- 仅修改当前 `dsh-code-intelligence`、合同确需变更的 `../dsh-context-cache` 与 `../dsh-context`；不修改其他仓库，不安装依赖、不升级版本、不 push/发布。
- C1：先在 `dsh-context` 最小补充 Context Block 的可选 `indexFingerprint` 关联（若缓存合同需要表达索引派生 block），再在 `dsh-context-cache` 增加写入确认、显式 block 读取分类、内部 lookup 分类/有界原因、索引 fingerprint 边界；锁、原子写和淘汰继续由 cache 包持有。保持旧 API 可用，避免 V1 消费者被无意切换。
- C2：在当前包实现可选 cache 包装。查询请求归一化对象同时驱动执行、cursor 与 cache lookup；命中完整校验 snapshot/indexFingerprint、projection、sources/path/hash，miss/corrupt/mismatch 重算，unavailable 返回无 cache 的同一验证 projection；仅 cache 明确确认写入后附加 blockId。refresh 不进入 cache。
- C3：扩展 `context_expand_source` 的显式 blockId 分类：cache miss/corrupt 为 `not-found`，边界不符为 `stale-block`，不可用为 `cache-unavailable`；无 blockId 永远走 verified read 和 Session budget。索引 block 绑定 snapshot/indexFingerprint，纯 source block 仅绑定 snapshot/path/hash/range/content。
- C4：加入确定性 hooks/fixtures，覆盖锁超时未确认、损坏重算、不可用降级、显式分类、淘汰、同 snapshot 不同 index、旧 runtime、新 runtime、cache parity、预算、关闭/清理；不使用随机 sleep。
- 接入前审计默认 plugin 的 cache 获取方式。当前 P0 默认 resolver 没有 cache 注入服务，Cordis 中也没有现成 cache service；因此在确认 cache 启用开关、目录和配置前不擅自设计默认服务协议或默认启用行为。若现有接口不足，暂停并报告具体合同问题。
- 每个跨包合同先在所属仓库完成测试与提交，再在本包接入；最后运行各受影响仓库的 typecheck/build、全量 Vitest、diff-check，并更新 README/本记录。

## 当前阶段

计划提交后开始 C1 合同实施。任何公共 DTO、cache 注入或默认配置歧义按任务要求立即停止，不以猜测替代合同。

## 验证与提交

待实施后按仓库分别记录命令、结果、commit 和未完成限制；不宣称 M5、发布、真实仓 gold 或收益。
