# M2 独立代码审查与 debug 报告

## 结论与执行边界

本轮对未提交的 M2 Q1–Q5 实现进行独立审查，确认并修复 **3 个中等严重度（P2）控制流 bug**。未发现已复现的 P0/P1 严重问题；这不是“绝对无 bug”结论。查询与源码边界另加独立验证，没有仅以复跑原测试代替审查。

- 分支：`feat/m2-query-source`；保留进入时所有未提交改动。
- 环境确认：`PI_PROVIDER=opencodex`、`PI_MODEL=gpt-6-astra`。没有启动其他模型。
- 本轮代码修改仅在本包 `src/p0-runtime.ts`、`src/p0-tools.ts`；新增/加强 query、source、runtime、loader 回归，更新本报告、M2 进度和 README。
- 不修改公共 DTO/parser/policy、manifest/version、lockfile、宿主或兄弟包代码；下游及主仓/profile 仅只读核对已有迁移声明。没有 commit/push/publish，也未安装依赖。
- M3 refresh/完整 lease 与 M4 cache 是已批准非目标，不列为实现缺陷、不扩范围。网络 502 是会话传输中断，不记为代码 bug；没有修改 TLS 校验。

## 审查方法与范围

先完整阅读 `doc/code-intelligence-design.md`（含工具输出截断后续读）、`doc/code-intelligence-tasks.md`、`doc/m1-progress.md`、`doc/m2-progress.md` 和 `README.md`；核对 git diff，包括 loader 默认入口测试被替换的内容及新增未跟踪文件。随后逐项对照共享 `dsh-context/src/p0-policy.ts` / `p0-validate.ts` 与本包 reader、line-map、finalizer、Native bridge。

| 范围 | 检查与验证 | 结论 |
| --- | --- | --- |
| Q1 cursor/缩页 | canonical defaults、目录尾斜杠、types 集合、query/snapshot/index/provider/policy/limit 绑定；损坏和过长输入；缩页 offset 前进、单项超限、必需 metadata 与 resultFiles 计费 | 未复现缺陷；另加 JSON 转义事实缩页与可选/显式 snapshot 续页验证 |
| Q2 repo/symbol | 路径词法序、receipt 直查不读当前 FS、exact/qualified/prefix、fuzzy term/camel/repeated terms、过滤先于排序分页、symbolId 成员检查 | 未复现缺陷；另加实际 pre-v2 公式 ID 和同 receipts 不同实际提取结果中已消失 ID 的 symbol/relation 双路径拒绝 |
| Q3 relation | imports/exports/calls/contains 实际 AST fixture；完整 endpoint 去重与排序；from 与 types；partial/failed/unsupported、无命中范围及来源文件关联 | 未复现缺陷；calls 保持 heuristic，不伪装 resolved/反向图 |
| Q4 source | receipt 与实际 hash、缺失/排除、UTF-16/代理对、CRLF/LF/CR/U+2028/U+2029、空末行、padding、最终 JSON 字节、失败不扣费、重叠重复、同 Session 并发预算 | 范围/预算未复现缺陷；适配器取消异常转换发现 R3 |
| Q5 runtime/tools | 默认四工具、无 V1 service/code 别名/cache/block；共享初始化、失败重试、等待者取消隔离、关闭清理、Native registry schema/business/host 错误路径 | 发现 R1/R2/R3，已修复 |
| 兼容隔离 | `src/index.ts`/`plugin.ts`、built entry、现有 V1 compiler/tools/runtime/fallback/projection 回归；orchestrator/eval/profile 迁移文档与代码只读核对 | 默认切换属已授权 breaking branch 行为，不宣称旧消费者兼容 |

### 新增的独立边界证据

- `tests/p0-query.spec.ts:69`：用旧 P0 实际公式生成合法 sha256 ID；再通过真实 extractor 单文件失败构建同 snapshot、不同 fingerprint 索引，证明旧成员不因 hash 外形或 receipts 相同而被认领。
- `tests/p0-query.spec.ts:159`：真实 TS 字符串成员名包含大量 JSON 引号转义，逐页断言预算、完整名称、排序及 offset 前进，最终每个成员恰好出现一次。
- `tests/p0-source.spec.ts:37`：独立正则换行 oracle，而不是调用被测 line-map 计算期望值；遍历 BOM/emoji/所有终止符 fixture 的全部有效半开 offset 组合，分别验证 padding 0/1/20、位置、文本、CRLF 内部 offset 与空 EOF。
- 原有确定性 source reader 屏障证明两个并发 agent 争用仅够一次输出的余额时只有一个成功；真实 registry 另验证三个 agent、两个 Session 的最终 JSON 计费与隔离。输出不含宿主 framing/post-policy 成本，沿用已批准的适配器提交边界。

## 按严重程度分类的发现

### R1 — P2：协作式初始化 deadline 丢失宿主 timeout 路由（已修复）

**位置：** `src/p0-runtime.ts:73,92–121`；回归 `tests/p0-runtime.spec.ts:47,55`、`tests/loader.spec.ts:226`。

**原因：** 初始化 timer 使用 `HarnessError(..., 'TOOL_TIMEOUT')`，但同步工作超过 deadline、timer 尚未获得事件循环机会时，`checkBuildControlP0` 抛出原始 `DOMException('TimeoutError')`。原 runtime 直接透传。实际宿主只为 `HarnessError` 提取 `error.info`，导致相同 timeout 因调度时机不同而失去稳定路由 code。

**修复前复现：** mock `Date.now` 首次为 1000、后续为 2000，配置初始化期限 1000ms；resolver 实际抛 `TimeoutError: Build deadline exceeded`，而非 `code: TOOL_TIMEOUT`。

**修复：** runtime 专用 timeout 工厂；构建 catch 先保留已取消 signal，再检查自身 deadline，将到期统一映射到宿主 `TOOL_TIMEOUT`，不更改共享 reader/programmatic build 合同，不把任意 TimeoutError 都归类成本包 timeout。

**验证：** 定向测试由红转绿；真实 Native registry 返回 `isError: true`、`error.info.code: TOOL_TIMEOUT` 与宿主错误文本，不附 `codeIntelligenceFailure`。额外 fake timer/registry gate 测试验证两个等待者均退出、构建清理后新调用可重新初始化。

### R2 — P2：并发重复 release 提前确认关闭完成（已修复）

**位置：** `src/p0-runtime.ts:63,123–134,162–170`；回归 `tests/p0-runtime.spec.ts:78`。

**原因：** 第一次 `release(session)` 在等待已捕获调用 `done()` 之前就从 WeakMap 删除状态；第二次 release 查不到状态立即完成。调用方 await 第二个 release 后可能误以为清理已完成，违反 M2 已承诺的 release 等待清理边界。

**修复前复现：** 捕获一个 handle 不调用 done，连续发起两次 release，经过一次 `setImmediate`，第一个未完成、第二个已完成。

**修复：** SessionState 持有共享 closing Promise，先发布该 Promise 再发出 abort（覆盖同步 abort listener 重入）；清理完成后才从 sessions 删除。并发 release/dispose 等待同一清理，released 标记仍同步阻止新调用，无 refresh/退役 runtime 框架扩展。

**验证：** 两个 release 均等待 handle.done；signal 立即取消，重复 done 幂等，关闭后禁止同 Session 重建的原测试保持通过。

### R3 — P2：工具适配器将调用方取消原因误转为业务失败（已修复）

**位置：** `src/p0-tools.ts:46–49`，同类防护 `src/p0-runtime.ts:118`；回归 `tests/p0-source.spec.ts:101`。

**原因：** reader 已正确保留任意 `AbortSignal.reason`，但工具 catch 无条件调用 `translateP0`。如果调用方以 `P0ReadError`（或内部构建错误）作为取消原因，外层又将其转换为新的 `CodeIntelligenceErrorP0`，抹掉取消身份、错误地暴露 stale-source 等业务恢复建议。

**修复前复现：** 真实 reader 返回前执行 `controller.abort(new P0ReadError('stale-source', 'changed-during-read'))`；工具拒绝值变成新的 `CodeIntelligenceErrorP0`，不是调用方传入的同一对象。

**修复：** 适配器业务转换前先 `signal.throwIfAborted()`；runtime 构建转换前同样优先 session signal。未取消的 reader/build 错误仍沿用既有业务分类。

**验证：** 拒绝值严格等于原取消对象，`done()` 执行，budget.spent 保持 0；原有 unknown reader error、stale-source 和预算错误测试继续通过。

## 验证命令与实际结果

环境：Linux、Node `v26.8.1`、TypeScript `5.9.3`、Vitest `4.0.18`、tsdown `0.18.0`；使用现有本地链接依赖。命令应按下面顺序执行，尤其 build 完成后才能检查自引用 built package entry：

```sh
node node_modules/typescript/bin/tsc --noEmit --incremental false --composite false --pretty false
node node_modules/tsdown/dist/run.mjs --out-dir lib --external typescript
node node_modules/typescript/bin/tsc --noEmit --strict --skipLibCheck --target ES2022 --module NodeNext --moduleResolution NodeNext --allowImportingTsExtensions src/picomatch.d.ts tests/p0-*.spec.ts tests/loader.spec.ts tests/package-entry.spec.ts
node node_modules/vitest/vitest.mjs run
node node_modules/vitest/vitest.mjs run tests/package-entry.spec.ts tests/loader.spec.ts
node scripts/smoke-m2.mjs
git diff --check
```

- 修复前新增疑点复现：runtime/source 两文件 **3 失败、7 通过**，三个失败分别对应 R1/R2/R3。
- 修复后 source noEmit、JS/declarations build、P0/loader/package-entry 独立 strict 类型检查：均 exit 0。
- 全量 Vitest：**20 文件、200 测试通过**（审查前记录为 193；新增 7 个 it，另加强一个既有 release 用例）。包括原有 24 个 Native bridge 回归及 V1 程序化 API 回归。
- 独立 built package-entry/loader：**2 文件、11 测试通过**，exit 0。
- 本地工作树 smoke：exit 0；**67 receipts、3,487 symbols、4,675 relationships**；54 eligible complete / 13 unsupported / 0 partial / 0 failed；构建 **374ms**（单次观察，不是性能门槛）。package.json receipt/source、repoMapP0 实际声明位置/source、imports、contains 断言均通过。报告文本后续补入本结果仅改变文档 hash，不改变这些计数；不是固定 commit gold 或收益证据。
- `git diff --check`：exit 0；新增未跟踪源码/测试/文档另检查行尾空白与 EOF。最终 git status 保留既有本包 M2、下游 README、主仓 README/profile、lock/submodule 和 adaptive-scheduler 改动，没有纳入提交。

验证过程的非产品失败也保留说明：新增 Native 测试一度对 undefined meta 使用 toHaveProperty；fake timer 重试测试一度只等一个 event-loop turn、未等真实 FS 清理，后改为确定性 registry 返回分支；两项测试修正后通过。另曾误将 strict built-entry 类型检查与清理 lib 的 build 并行，短暂报 TS2307；构建完成后原命令 exit 0。以上不算额外产品缺陷，也不隐藏最初三项 red 证据。临时日志 `/tmp/dsh-m2-review-red.log`、`/tmp/dsh-m2-review-full.log` 仅辅助，本报告及回归测试是持久证据。

## 尚存风险与未验收边界

- 仅审查 M2；M3 refresh/队列/退役 lease/全量重试、M4 cache 和 M5 固定真实仓 gold、编辑-refresh、收益评测仍未实现或未运行，不因本轮测试通过宣称完成。
- 初始化 deadline/取消仍是协作式；同步 TS parse 不能硬中断，WorkspaceRegistry.resolveByPath 没有取消参数，挂起的宿主 lookup/底层 I/O 清理不能被本包强制终止。timeout 可使等待者退出，但 release 仍等待底层清理；此轮未扩建宿主取消框架。
- 内存仍驻留整个索引，查询会扫描/分配候选和排序数组；未做最大仓容量/峰值 RSS 压测。元数据/最终输出有界不等于查询 CPU 和所有临时分配均已压测。
- Linux 普通并发编辑边界；没有 Windows 或恶意祖先目录替换隔离验证，hash 不证明 AST 无误，不是 DLP。
- 无 cache 分支下显式 blockId 仍为 cache-unavailable；Native-only，PTC/run_code 不承诺结构化失败，未跑完整 AgentLoop/provider。任意宿主 post-policy 改写不属于本包最终 JSON 计费范围。
- 下游核对：orchestrator 的 V1 Context Block/parser/source prompt、eval 的轻量默认 apply 挂载、两个 profile 未显式配置 Native，均与其已有迁移声明一致。没有修改或运行其迁移后的代码验收，不宣称兼容。
- 当前未变更的 npm 版本/依赖范围不能证明远端 P0 合同可安装；只验收本地链接的 M1 v2 合同。发布迁移另行授权。
- 本轮未遇到需要新增公共合同或用户选择的歧义；不存在待决 BLOCKED 项。上述是验证限制，不是“已排除所有缺陷”。
