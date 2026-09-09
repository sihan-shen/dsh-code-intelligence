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
- Host `code-intelligence` namespace 已通过官方 `settings.register` 接入 settings service：嵌套 `cache.enabled/maxEntries/maxBytes/lockTimeoutMs`，默认关闭，明确 `applies: 'restart'`，并使用 consumer fiber 生命周期；没有自行解析 settings.yaml，也没有使用 `installSection` 替代注册语义。
- Web client bundle 已接入 `settings.plugin.item`，使用 rc.1 官方 slot/settings/locale surface；按方案 A，启用项是正确绑定 label/checked/disabled/onChange 的原生可访问 checkbox（不混入 alpha.2 或伪造官方 Switch），数字字段支持草稿、校验、恢复默认、放弃、revision-fenced 原子保存和中英文重启提示。

## 验证

当前包已通过直接调用 `./node_modules/.bin/tsc -b --pretty false`、`./node_modules/.bin/tsdown --config tsdown.config.ts`、`./node_modules/.bin/vitest run`（26 files / 244 tests；含 C4 cache acceptance、blockId 输出预算回归、Web controller、Host settings、package-entry、Native loader/client bundle 覆盖）和 `git diff --check`。两个跨包仓库工作树均干净，且各自 C1/full contract tests 已通过。

## 主线程复核修正

- `context_expand_source` 显式 `blockId` 不再把接近输出预算的合法源码读取转为 `budget-exceeded`：此前无条件回填 `blockId`，在源码结果字节数位于 `(maxOutputBytes - blockId, maxOutputBytes]` 区间时由适配器判定超预算；现在与查询缓存一致，仅在回填后不超过共享上限时才附加，否则保留直接读取结果。`src/p0-tools.ts`。
- 候选 runtime 的 cache 在 `beforeCommit` 屏障抛错时也会关闭：此前只有 `commit` 失败才 `closeRuntime(candidate)`，屏障抛错会遗漏清理（测试注入 seam，生产 `beforeCommit` 为空）。`startInitial` 与 `enqueueRefresh` 两处统一把 `beforeCommit` 与 `commit` 纳入同一个 try/catch。`src/p0-runtime.ts`。
- 新增 `tests/p0-cache.spec.ts` 回归：逐字节构造近上限（`//`+65187 个 `x`）的 wholeFile 源码，先断言基础结果 ≤ `maxOutputBytes` 而回填 `blockId` 后超限，再经 `createToolsP0` 调用 `context_expand_source` 断言不抛 `budget-exceeded` 且不再附加 `blockId`；无修复时该测试在 `outputBudgetP0` 处失败。

## 未完成 / 限制

- 下游 V1 compiler consumers 尚未迁移；不宣称 M5、发布、真实仓 gold 或性能收益。
- Web card intentionally uses a native accessible checkbox because the locked rc.1 primitives surface does not export `Switch`; no alpha package or copied component is used。
- 根 lockfile 由主线程使用 filtered `pnpm install --lockfile-only --filter @han_05/dsh-code-intelligence...` 生成并在父仓独立分支提交；pnpm 因将共享 `dsh-settings` 从旧的 `0.1.1-rc.2` 对齐到当前 `0.1.2-rc.1`，同步更新了受该 peer 影响的既有 snapshot keys。没有混入 `0.1.3-alpha.2`。
