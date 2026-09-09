# M2 实施记录

## 授权与范围

- 唯一负责人：本次 gpt-6-astra 会话；不启动其他模型。
- 本包分支 `feat/m2-query-source`；不 commit/push/发布，不修改版本或 lockfile。
- 用户已确认：默认切换四个 P0 查询工具，无 cache，不提供 V1 `contextCompiler` 服务，不注册 `code_*`；保留 V1 程序化 API，不新增 legacy 双模式。
- 长期采用跨包迁移；本轮下游仅 README 迁移声明：orchestrator/eval 的 `docs/m2-p0-migration`，主仓 `docs/m2-profile-migration`。不修改其代码/配置，不覆盖主仓既有改动。
- M3 refresh/完整 lease 生命周期、M4 cache/兼容集成、M5 工程发布和收益评测不在本轮完成声明内。
- Native-only：使用 M1 公开 around hook/finalizeContent 桥接，PTC run_code 结构化失败不支持。

## 可执行任务卡

所有任务修改范围限本包，唯一负责人为本会话；共享 DTO/parser/policy 只读复用。下游 README 按上述授权另行更新。

| ID | 目标 / 非目标 | 前置与接口 | 交付物 / 下游 | 验收与测试注入 |
| --- | --- | --- | --- | --- |
| Q1 | 统一归一化、cursor、字节缩页、完整性；不接 cache | F1 shared parsers/policies、F5 BuiltIndexP0 | 查询公共模块；Q2/Q3/Q5 消费 | 固定最大 identity、空页、元数据详情截断、单项超限、cursor 损坏/跨 query/index/limit/policy；真实 build 与确定性 index fixture |
| Q2 | repo map/path receipt、exact/prefix/fuzzy、kind/pathPrefix、symbolId；不做 lexical provider | Q1 | P0 repo/symbol 查询；Q5 消费 | 实际 TS/JS build，JSON 直查、排序、分页、旧 ID 拒绝、混合语言 coverage |
| Q3 | 正向摘要关系、过滤/去重/排序/分页、来源状态；不做语义/反向关系 | Q1、F5 endpoints | P0 relation 查询；Q5 消费 | imports/exports/calls/contains 实际 AST，类型集合、空页/unsupported、partial 来源 |
| Q4 | source 三范围/padding/verified read、Session 原子计费；不做 refresh/cache | F1、F3 reader/line map、F5 runtime | source 模块与 Session 所属账本；Q5 消费 | UTF-16/换行/空窗口、stale/path/hash、序列化转义、并发多 agent、失败不扣费；reader 屏障 |
| Q5 | 四个默认工具与最小 Session 持有器、Native 失败；不引入完整 R1-R4 框架 | F2 bridge、Q2/Q3/Q4 | 默认 plugin、包入口、工具说明、README | 真实 ToolRuntime/WorkspaceRegistry/Session 路径，JSON 闭环、结构化失败呈现、关闭、无 block/cache、包入口/类型/全量测试 |

## 完成状态

Q1–Q5 在本轮批准的 M2 范围内实现并通过本地验收；未发布。计划里程碑标签为 `0.3.0-alpha.2`，本包 manifest 按授权保持 `0.2.1`，不得作为已发布 patch/alpha 解释。

| Task | 交付与证据 |
| --- | --- |
| Q1 完成 | `src/p0-query.ts` 复用共享输入 parser；canonical query、P0 cursor（含实际 indexFingerprint）、元数据独立上限、缩页/前进/单项超限、页内 partial 来源；真实 build 与最大合法 identity/大名称/长 path fixture |
| Q2 完成 | receipt 页和 JSON path 直查；exact/qualified/prefix/fuzzy、kind/目录边界过滤、直接句柄成员校验；固定 fuzzy 分数与分页结果 fixture；真实同 receipts/不同提取结果拒绝旧 cursor |
| Q3 完成 | 实际 AST imports/exports/calls/contains，from 成员校验、types 集合归一化、摘要边去重/排序/分页、空页与 partial/unsupported 状态；长关系页字节缩页与 contains 来源状态 |
| Q4 完成 | `src/p0-source.ts` 可信读取、三范围/padding、统一 line map、代理对/空窗口/stale-source；`SourceBudgetP0` 为 Session 持有，工具序列化成功数据后同步检查扣费，多 agent 并发与重叠重复计费 |
| Q5 完成 | `src/p0-tools.ts` / `src/p0-runtime.ts` / 默认 plugin：四工具、无 V1 服务/别名/cache、真实 registered workspace/Session 初始化与清理；M1 Native bridge 实际接入；包入口实际查询与 registry 失败身份验证 |

最小 Session 持有器仅持有一个不可替换 runtime：共享初始化、独立协作式 deadline、等待者取消隔离、失败后新调用重试、release 取消并等待已捕获调用清理、禁止关闭 Session 重建。`SessionHandleP0.done()` 由工具 finally 调用；程序化使用 resolver 的调用方也必须 finally 调用。没有实现 refresh 队列、一次全量采集重试、候选替换、退役 runtime leases 或完整 R1–R4 验收，不将这部分 M2 清理基础标为 M3 完成。

### Native 与下游边界

- `tests/loader.spec.ts` 使用真实 DSH ToolRuntime（显式 Native）、SessionStore，并有真实 WorkspaceRegistry + 内存 storage backend 集成；执行 receipt → JSON source、symbol → contains/file relations → source。
- 实际工具的 shared parser/defineTool 预校验失败、stale-snapshot/currentSnapshotId、stale-symbol-id、invalid-cursor、cache-unavailable、stale-source 与预算错误保留 Native DTO；通过公开 Session event/deriveMessages/replay 验证模型内容。
- 测试已安装 retry hook 内侧的实际工具重试，并保留 M1 的 24 个桥接回归。PTC run_code、完整 AgentLoop/provider、未经迁移的真实 profile 组合未验收，不支持/不宣称。
- 原 loader 测试对 V1 默认服务与五工具组合的断言按授权替换为 P0 默认入口验收；V1 compiler/tools/runtime/projections/fallback 等程序化回归保留并通过。不是保留旧默认组合兼容性。
- 实际写入 `dsh-orchestrator/README.md`、`dsh-eval/README.md`、主仓双语 README、`profiles/v0.2b-readonly/README.md` 和 `profiles/v0.2c-context/README.md`。仅记录检查到的 V1 wrapper/parser/prompt、旧 evaluator 默认挂载及 profile Native 需求；未改下游代码/配置、未跑其迁移后兼容验收。

## 实际测试命令与结果

环境：Linux，Node `v26.8.1`，TypeScript `5.9.3`，Vitest `4.0.18`，tsdown `0.18.0`；宿主 DSH `0.1.2-rc.1` / Cordis `4.0.2`。直接调用已有本地工具，未运行 pnpm install/prepare，避免父 workspace 自动依赖改动。

```sh
node node_modules/typescript/bin/tsc --noEmit --incremental false --composite false --pretty false
node node_modules/tsdown/dist/run.mjs --out-dir lib --external typescript
node node_modules/typescript/bin/tsc --noEmit --strict --skipLibCheck --target ES2022 --module NodeNext --moduleResolution NodeNext --allowImportingTsExtensions src/picomatch.d.ts tests/p0-*.spec.ts tests/loader.spec.ts tests/package-entry.spec.ts
node node_modules/vitest/vitest.mjs run
node node_modules/vitest/vitest.mjs run tests/package-entry.spec.ts tests/loader.spec.ts
node scripts/smoke-m2.mjs
```

| 检查 | 实际结果 |
| --- | --- |
| source noEmit | exit 0 |
| tsdown JS + declarations 构建 | exit 0；built entry 保留正常外部宿主依赖 |
| 全部 P0/loader/package-entry 测试独立 strict 类型检查 | exit 0 |
| 全量 Vitest | exit 0，20 文件、193 测试通过 |
| 独立 built entry + registry loader | exit 0，2 文件、10 测试通过 |
| 本地工作树 smoke | exit 0；66 receipts、3,425 symbols、4,654 relationships；54 eligible complete / 12 unsupported / 0 partial / 0 failed；构建约 368ms（单次观察） |
| 本包、两个下游及主仓授权 README diff whitespace | exit 0 |

Smoke 脚本断言 package.json receipt/source、`repoMapP0` 的实际声明路径及源码、imports 与 contains。工作树随本轮文档/测试变化，不是固定 commit corpus，不是独立 gold，不报告一般性能阈值或检索收益。

实施过程曾发现并修正：repo-map canonical 参数的 TypeScript excess-property 错误；registry 预算测试错误构造 Session header（6/7 通过后修正）；插件公开 inject/provide 的 readonly 类型与 Cordis Plugin 类型不兼容；关系 target union 的测试收窄问题。最终上述命令均通过，不隐瞒早期失败，也不将早期结果替代最终全量结果。

## 支持限制与未完成阶段

- M2 无 cache；显式 blockId 一律 cache-unavailable；不触碰 M4 的确认写入/stale/missing 存储合同。旧 V1 程序化 API 仍有其原缓存行为。
- 无 refresh/watcher；编辑后新的 Session 重建。旧 receipt 保持旧事实，实际 source 内容变化/消失拒绝。
- 仅 TS/JS AST 覆盖；complete 不代表全部声明/语义分析。calls 为文件级 heuristic，imports/exports 未解析，无函数级 callee/caller/反向导航；LSP 不接主路径。
- 默认输出与预算遵循 shared policy；不是访问许可/DLP，也不是宿主 framing、post-policy 内容或全局模型 token 计量。同步 parse 不能硬中断。
- 本地链接的 context P0 合同含 INDEX_POLICY_P0 v2；其 manifest `0.2.1` 和本包未改的 `^0.2.0` 依赖范围都不能证明 npm 具备本分支合同。没有发布/独立安装保证。
- M3/M4/M5 均未完成；真实仓固定 gold/编辑-refresh 验收未运行，收益状态 not-ready。

## 独立 M2 review / debug 追加记录

详细证据见 [m2-review.md](./m2-review.md)。保持本文件此前 193 测试的初次实施记录，不以追加结果覆盖历史。

- 独立同模型审查先完整阅读指定文档、diff、新实现与共享 parser/policy，再新增确定性用例；修复前 runtime/source 回归为 **3 失败、7 通过**。
- 修复 3 个 P2：协作式初始化 deadline 与 timer 统一走 `TOOL_TIMEOUT`；并发重复 release 共享清理 Promise、都等待 done；工具适配器在业务转换前保留取消 signal 的原始 reason。
- 新增 actual pre-v2/同 receipts 旧索引成员拒绝、JSON 转义事实缩页、独立 line/offset/padding oracle、timer 等待者退出与清理后重试、真实 Native timeout 路由验证；不更改共享合同或 M3/M4 范围。
- source noEmit、tsdown JS/declarations、P0/loader/package-entry strict 类型检查均 exit 0；全量 **20 文件、200 测试通过**。独立 entry/loader、最终 smoke 与 diff 检查见详细报告收尾结果。
- 文档同步 release/timeout/取消实际行为。审查未修改下游/主仓/profile 文件，保留所有原有改动；未 commit/push/publish/install，未调整 TLS。网络 502 不属于代码发现。

## 第二轮主线程 review / debug

按用户最新要求由主线程直接检查，未启动子进程。详细证据见 [m2-review-round2.md](./m2-review-round2.md)。

- 修复 1 个 P2：最外层 Native bridge 将 CodeIntelligenceErrorP0 / ToolArgsError 类型的调用方取消原因误投影为业务失败；捕获 DTO 前检查 signal，保留原宿主结果。两个真实 registry 对照回归先红后绿。
- 新增默认插件共享初始化等待取消、48 个手工期望 Unicode/空值/转义关系 endpoint 与分页、release/dispose/同步 abort listener 重入清理测试；共新增 5 个测试。
- source typecheck、JS/declarations build、P0/loader/package-entry strict 类型检查通过；全量 **20 文件、205 测试通过**，独立 entry/loader **2 文件、12 测试通过**。
- 本轮生产代码仅改 `src/p0-tool-errors.ts`，测试改动在 bridge/loader/query/runtime；更新 README 与本节，保留第一轮历史。M3/M4/下游范围不变，未 commit/push/发布。

## 修改范围与保护

本包修改：README、M2 本记录、`src/index.ts`、`src/plugin.ts`、新增 `src/p0-query.ts` / `p0-source.ts` / `p0-runtime.ts` / `p0-tools.ts`、loader/package-entry 测试、新增三个 P0 query/source/runtime 测试和 `scripts/smoke-m2.mjs`。

两个下游只改各自 README；主仓只改双语 README 并新增两个 profile README。主仓原有 adaptive-scheduler 未跟踪内容、code-intelligence/context submodule 变化、pnpm-lock.yaml 改动均保留；没有更新/提交 submodule 指针。包版本、package.json、lockfile、profile 配置、宿主及其他兄弟包未修改。未启动其他模型；上述实施与审查阶段未 commit/push/发布。

## 用户授权提交

两轮审查后用户要求 commit，授权将本包 M2 实现、回归测试、README/进度/审查报告，以及两个下游和主仓/profile 的迁移文档分别提交到各自现有独立分支。该授权覆盖此前执行阶段的“不 commit”，不包含 push、发布、版本/lockfile 或主仓 submodule 指针更新。只显式暂存本次文件，其他已有改动保留。
