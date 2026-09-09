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

## 已完成

- `../dsh-context-cache`：C1 合同与确定性边界测试已提交：`c670e54`、`09588d2`、`3ee91a2`。覆盖确认写入、显式 block/lookup 分类、锁超时、损坏、workspace 隔离、indexFingerprint、淘汰与关闭。
- `../dsh-context`：最小 DTO/parser 修改已提交：`042ae8c`（可选 `indexFingerprint`）与 `c16ccdc`（relation block kind）。全量测试通过。
- 当前包：`0bc744c` 接入可选 cache 查询包装和显式 block 分类；`e8c4c38` 保证 cache 初始化失败降级。默认 `cache.enabled` 为 false；refresh 不缓存；无 cache 查询/source 仍可用。

## 验证

当前包已通过 `pnpm run typecheck`、`pnpm test -- --run`（22 files / 218 tests）、`pnpm run build` 和 `git diff --check`。两个跨包仓库工作树均干净，且各自 C1/full contract tests 已通过。

## 未完成 / 限制

- Host settings namespace schema 与 DSH Web `settings.plugin.item` Code Intelligence 卡片尚未实现。
- 当前插件没有可直接解析的官方 client bundle 依赖：`require.resolve` 对 `@deepseek-ai/dsh-client-ui-settings/client`、`@deepseek-ai/dsh-client-ui-settings-plugins/client`、`@deepseek-ai/dsh-client-ui-slots`、`@deepseek-ai/dsh-client-ui-primitives`、`@deepseek-ai/dsh-client-store`、`react`、`@types/react` 均失败。按用户批准的 unblock 范围，需要仅修改本包 manifest/build 配置并在不改 lockfile、不安装依赖的条件下继续；若 typecheck/build 无法解析则必须保持 BLOCKED。
- C4 专门跨运行时/预算/淘汰回归测试、Host/Web settings client bundle 尚未提交；不宣称 M5、发布、真实仓 gold 或收益。
