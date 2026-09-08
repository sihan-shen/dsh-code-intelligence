# M1 实施进度

范围与验收以 [设计](./code-intelligence-design.md) 和 [任务拆解](./code-intelligence-tasks.md) 为准。本文件记录本地实施证据，不把草案或子进程自报等同于完成。

## 执行约束

- 本包分支：`feat/m1-code-intelligence-foundation`。
- 共享合同分支：`dsh-context` 的 `feat/m1-code-intelligence-contracts`。
- 允许修改本包与 `dsh-context`；不修改宿主工具包或 upstream harness 源码，不手工 patch node_modules；正常依赖安装及其工具链影响见下文。
- 阶段性本地 commit，不 push、不发布。
- 模型仅使用 `opencodex/gpt-6-astra` 与 `opencodex/gpt-5.6-sol`，不使用 `deepseek/...` 或 `command-code/...`。
- 子任务按文件归属并行，协调者审核、集成、提交；遇设计或宿主能力阻塞先报告，不自行降低验收标准。

## 基线

本包起点：`eae28fb`。

- `pnpm typecheck`：通过。
- `pnpm test`：11 个测试文件、79 个测试通过。
- `dsh-context` 基线 `eaa284c`：`pnpm build` 通过，3 个测试文件、19 个测试通过。
- 两个目标仓库开始时工作区干净；宿主已有未跟踪 `tsx-1000/` 不在本次修改范围。

## Task 状态

| Task | 模型 | 状态 | 备注 |
| --- | --- | --- | --- |
| F1 合同与接口 | gpt-6-astra；sol 复核/修正 | 完成 | context `fd4b8b7` + `8ce8b6b`；本包接口 `ed444cf`；V1 保留 |
| F2 宿主失败桥接 | gpt-6-astra | 完成（Native-only） | `5558134`；用户确认范围；24 个新测试 |
| F3 有界扫描与读取 | gpt-6-astra | 完成 | `ca09dc5`；27 个新测试 |
| F4 AST 文件事实 | gpt-5.6-sol | 完成 | `bec8ce3` + `061632e`；12 个新测试，已修正辅助遍历越过资源上限 |
| F5 两阶段构建 | gpt-6-astra | 完成 | `bc748ad`；15 个新测试，含真实 extractor 集成 |

## 已确认的验收边界

- F2 使用宿主公开 `tools/execute` 与 `finalizeContent`，Native 下保留失败 envelope、namespaced meta 与同一模型可见 DTO；PTC `run_code` 暂不承诺结构化失败。该范围已获用户确认。
- F2 测试执行真实 registry，并使用公开 Session 事件、deriveMessages 和 replay 验证投影；不是完整 AgentLoop/provider 端到端测试。
- 失败桥接需包在重试 around hook 外侧；注册时使用公开 prepend 选项，不支持事后在其外侧 prepend 重试器并仍宣称相同保证。
- P0 foundation 是附加 API，不切换默认 V1 工具；M2 查询执行、M3 refresh/lifecycle 尚未交付。

## 工具链与进度保存

- 新增对宿主 `@deepseek-ai/dsh-llm@0.1.2-rc.1` 的 peer/dev 声明，通过正常公共根导入共享 HarnessError 身份。
- pnpm 依赖状态检查曾触发父 workspace 自动安装/prepare。已改为直接运行本地 node/tsc/vitest，恢复可确认的父仓 lockfile 自动增量；未修改宿主源码。不把其他仓已有未跟踪内容纳入提交。
- Node 类型解析恢复后，移除 context 中两条失效的导入 ts-expect-error（`311156c`），shared build 通过。
- 本地 commit 仅位于功能分支；未 push 或发布。

## 最终验收

在上述批准范围内，M1 foundation 工程验收通过。仅为本地完成状态，不代表已发布 `0.3.0-alpha.1`，也不代表 M2–M5 或一般检索收益已通过。

| 检查 | 结果 |
| --- | --- |
| `dsh-context` 强制 TypeScript build | 通过 |
| `dsh-context` 全量 Vitest | 4 文件，34 测试通过（新增 15） |
| 本包 source TypeScript noEmit | 通过 |
| 新增 P0 测试与包入口测试独立严格类型检查 | 通过，显式包含现有 picomatch 声明 |
| tsdown 构建及 built package entry | 通过；HarnessError 保持正常外部依赖 |
| 本包全量 Vitest | 17 文件，157 测试通过（新增 78） |
| 两仓 diff whitespace 检查 | 通过 |
| 本地工作树构建 smoke | 56 receipts、2,824 symbols、3,855 relationships；45 complete / 11 unsupported / 0 partial / 0 failed；约 376ms，仅观察值 |

Smoke 使用当时本包工作树，不是固定独立真实仓 corpus/gold，不作为 M5 或收益证据。测试与生产入口均调用实际 F3 reader → F4 extractor → F5 finalizer；默认 V1 注册测试仍通过。入口导出提交为 `9a5c6f6`。

复核修正包括：页内 path/hash 与单 relation source 一致性、问题文件/结果文件联合计数、stale-source/budget 恢复详情、扫描跳过计数，以及解构绑定 / re-export 辅助遍历的 node/depth 上限。解构 initializer 内部声明正确挂到实际 binding 祖先。

### 后续集成注意

- 本地开发依赖 `dsh-context` 功能分支构建后的链接产物；当前 npm 的 `0.2.0` 尚无 P0 导出，不能直接发布本包并假定旧范围足够。发布前应先发布共享合同并更新本包依赖范围；本轮未 bump 或发布。
- F2 重试 hook 顺序、真实宿主 profile 的 Native 配置及完整 AgentLoop 组合留在 M2 实际工具集成检查，不宣称已跑这些组合。
- Linux 读取保护与普通并发编辑已测试；不宣称 Windows 或恶意祖先路径替换隔离验证。
- 正式任务日志保留在本文件与提交中；子进程临时日志/报告位于 `/tmp/dsh-ci-m1`，不作为持久验收文档的唯一来源。
- 本轮子进程已结束；仅允许的两仓有提交。父仓 submodule 指针尚未提交，既有其他仓未跟踪内容及宿主 `tsx-1000/` 保留不动。

## 追加复核：M1 debug

本节为后续复核证据，不覆盖上文原始验收记录。取消 / ignore 修复仅修改本包；用户另批准长祖先名称方案 2 后，修改范围增加 `dsh-context`，`dsh-context-cache` 仅做兼容回归、未修改。修复验证时尚未提交、push 或发布；用户随后授权提交与共享包推送，执行结果见本节末。没有改变 Native-only 或默认 V1 工具边界。

### 已修复

- `src/p0-reader.ts` / `src/p0-snapshot.ts`：取消原因可由调用方指定，带有 `ENOENT` / `EACCES` 等字段时，原实现会误按 I/O 分类为 stale-source / access-denied。错误映射前先检查 signal/deadline，保留原始取消原因。
- `src/p0-reader.ts`：关闭文件描述符期间收到取消后，原实现仍可能兑现已准备的成功结果；清理完成后增加控制检查，不返回源码。
- 新增 8 个确定性回归用例，修复前全部失败，修复后全部通过；同时验证描述符关闭与取消后的重新扫描。

### Ignore 边界：用户确认方案 A 后已修复

- 原问题：`.gitignore` 第一次可信读取用于规则，之后若增长超过 `maxFileBytes`，第二次作为 receipt 候选时会被正常跳过，仍以旧规则构建。
- 用户选择 A：复用首次可信读取的文本、hash、line map 和 receipt；在遍历其他文件前完成该文件提取，不保留每层目录的源码等待二次处理。读取完成后的编辑由下次构建采集，不修改已采集事实；读取过程中检测到的竞争仍拒绝。
- receipt 的排除策略、采集字节对应的单文件大小、候选数、总字节，以及独立 ignore 字节 / pattern 限制继续生效，跳过 / 收录仅计数一次。
- 替换旧二次读取测试，增加根目录 / 子目录下编辑、增长、删除的单读回归，以及容量 / 排除策略测试；其中 7 个用例在修复前失败。另加真实 reader → AST → finalizer 集成：采集后修改 ignore，本次 snapshotId / indexFingerprint / 事实 / coverage 与未编辑基线相同，下次构建采用新规则并产生新版本。测试总数净增 8。

### 长祖先名称风险：初始复现

- finalizer 对每个后代保留完整 qualified label，即使公共可选字段已经因超长而省略。合成文件由 60 层 namespace（每层名称为 4,000 个 `N`）、500 个短变量声明组成，源文件 248,729 bytes、560 symbols，初次观察约 2.1s、RSS 328MB（Node 26.8.1，384MiB heap 上限）。未发生 OOM，不作为性能阈值或一般仓库结论。用户随后批准下方方案 2。

### 方案 A 修复后验证

- 本包 source noEmit 与 P0 测试独立严格类型检查：通过。
- tsdown 构建与全量测试（含 built package entry）：方案 A 修复后 17 文件、173 测试通过（此前取消修复后为 165）。
- `dsh-context` 全量测试：4 文件、34 测试通过；本轮未改共享包。
- 取消修复后的本包工作树构建 smoke：56 receipts、2,836 symbols、3,856 relationships；45 complete / 11 unsupported / 0 partial / 0 failed；约 460ms，仅观察值。方案 A 另以确定性真实构建集成测试验收。
- diff whitespace 检查：通过。

### 长祖先名称：用户确认方案 2 后已修复

- `src/p0-build.ts`：P0 ID 改为 `sha256(canonicalJson([INDEX_POLICY_P0.symbolIdVersion, snapshotId, path, kind, name, startOffset, endOffset, containerId ?? null]))`，父节点先终结。身份不依赖名称标签或临时 localId。
- 只保留 ≤ 4,096 UTF-8 bytes 的完整 lexicalQualifiedName；超限前先检查长度，不分配完整长祖先字符串。父标签省略后，所有后代标签继续省略，不伪装成顶层标签；有效 symbols / contains 保留，不降低 extraction 完整性。
- `dsh-context/src/p0-policy.ts` 新增独立 `INDEX_POLICY_P0`（`dsh-index-p0-v2` / `dsh-symbol-p0-v2`）；fingerprint canonical schema 升至 `dsh-index-fingerprint-v2` 并纳入该 policy。自定义 provider、无事实与空索引也明确隔离，AST 覆盖和 snapshot receipt policy 不变。
- `dsh-context/src/canonical.ts` 改用 Node 内置 SHA-256，UTF-8、`sha256:` 前缀与 canonicalJson 不变。16 个新测试验证修改前冻结的摘要向量（含 SHA padding 边界、百万字符、BOM、多字节、单独代理项、控制字符）与非法输入；已有 V1 block 测试增加修改前冻结的 blockId。
- 本包增加 6 个测试，覆盖空索引版本变化、UTF-8 标签边界与空名称、同标签不同实际父节点、父身份变化向后代传播及 256 层长名称。原身份测试更新为 v2，同时验证旧 P0 ID 不在新索引中；V1 fallback 增加旧公式断言，原有顺序无关、祖先省略重接、碰撞与 contains 校验继续通过。
- 旧 P0 ID 明确失效；snapshotId 可以不变，indexFingerprint 换代。M2/M4 的句柄、cursor、cache 版本拒绝仍是后续集成责任，本轮不冒充查询或缓存已实现。本次不迁移已发布 V1 缓存格式。

可复现诊断脚本：`scripts/benchmark-p0-ancestor-names.mjs`。先构建共享包与本包，然后运行 `node scripts/benchmark-p0-ancestor-names.mjs 384 500`；脚本在独立受限 heap 子进程构建真实 reader → AST → finalizer，并断言符号数、contains endpoint 和 complete 状态。60 层 / 每层 4,000 字符 / 500 变量（248,729 bytes、560 symbols、559 contains）的同机单次观察如下：

| 实现 | heap 上限 | 构建耗时 | 峰值 RSS（KiB） |
| --- | --- | --- | --- |
| 原祖先 ID + 原纯 JS SHA | 384MiB | 2,052ms | 316,252 |
| 原祖先 ID + 原生 SHA（中间对照） | 384MiB | 231ms | 309,516 |
| 父 ID + 有界标签 + 原生 SHA | 384MiB | 59ms | 145,124 |
| 父 ID + 有界标签 + 原生 SHA | 128MiB | 55ms | 144,824 |
| 同上，扩至 3,000 变量（3,060 symbols） | 128MiB | 208ms | 170,892 |

heap 限制不是 RSS 限制；峰值 RSS 含 Node/TypeScript/模块加载，不能全部归因于索引。以上不是多次统计、一般仓性能或硬墙钟承诺；原版未跑低 heap OOM 对照，不宣称已观察到该 OOM。

方案 2 最终验证：

- 本包 source noEmit、P0/V1 fallback 测试独立严格类型检查、tsdown 及 built package entry：通过。
- 本包全量：17 文件、179 测试通过。
- built entry 工作树 smoke：57 receipts、2,895 symbols、3,901 relationships；46 complete / 11 unsupported / 0 partial / 0 failed；约 342ms，仅观察值。
- `dsh-context` 强制 build、新增/修改的哈希与 block 测试严格类型检查、全量测试：5 文件、50 测试通过。
- `dsh-context-cache` noEmit 与全量回归：1 文件、43 测试通过；未修改缓存包。
- 两个修改仓库 diff whitespace：通过。

本次已消除重复展开祖先字符串这一具体风险；仍需全索引驻留，且 fingerprint 的 canonicalJson 仍会分配整体序列化结果。不宣称全仓峰值内存已完成压测或所有 M1 问题已排除。

### 用户授权提交 / 推送

- 用户随后要求 commit，并推送 `dsh-context` 与 `dsh-context-cache`；该授权覆盖上文原执行阶段的“不 push”限制，不包含 npm 发布或合并 master。
- `dsh-context`：`41b5746`（native SHA-256 + P0 parent-based identity policy）已推送至 `origin/feat/m1-code-intelligence-contracts`，并设置 upstream；之前的 M1 合同提交随该分支一并推送。
- `dsh-context-cache`：无工作树改动或待推送提交，`git push origin HEAD:refs/heads/master` 返回 `Everything up-to-date`，未创建空提交。
- 本包 debug 修复与本记录纳入 `feat/m1-code-intelligence-foundation` 的本地提交；按本次指定范围不推送本包，不修改父仓 submodule 指针，不发布 npm。
