# M5 实施记录

## 进入状态

- 分支：`feat/m5-release-acceptance`。
- 目标：按 E1–E4 完成固定真实仓工程验收与 `0.3.0` 发布准备；M5 不扩展 P0 功能，仅验证、修复和发布。
- 当前授权不包含版本升级、commit、push、跨包修改或 npm 发布。
- 进入 M5 时 M4 已合并；M4 的合同与单元/集成测试结果不是固定真实仓 gold、编辑-refresh smoke 或发布证据。

## G0 待决策项

以下事项尚未冻结，因此不能开始正式 E1 验收或宣称 release-ready：

1. 真实开源 TS/JS corpus 的仓库 URL、许可证、完整 commit SHA、archive/checksum 与准备方式。
2. 独立 gold 的样例类别、数量、匹配规则、`recall@k` 的 `k`、位置容忍及人工/独立复核人。
3. `@han_05/dsh-context` 和 `@han_05/dsh-context-cache` 的可发布版本、发布顺序及本包依赖范围。
4. `dsh-orchestrator`、`dsh-eval` 和既有 profile 的迁移或明确不兼容策略。
5. Node 验证矩阵、registry/dist-tag、版本升级、tag 与 publish 的明确授权。

## G1 最小修复

- 将 `scripts/smoke-m2.mjs` 与 `scripts/benchmark-p0-ancestor-names.mjs` 的构建入口从不存在的 `lib/index.mjs` 修正为实际产物 `lib/index.js`。
- 新增脚本回归，静态拒绝重新引用 `index.mjs`，并在构建后执行 legacy working-tree smoke。长耗时合成 benchmark 不进入常规测试。
- 将公开入口附近的 “M3/no-cache” 与 package-entry 测试中的 “M2 default” 注释改为当前 P0/可选 cache 事实。
- README 仅收敛明确错误的 M5 目标版本和工具标题；`package.json` 仍为 `0.2.1`，本文不宣称 M5 完成或已经发布。

## G1 验证

本轮实际执行并通过：

- `./node_modules/.bin/tsc -b --pretty false`。
- `./node_modules/.bin/tsdown --config tsdown.config.ts`；生成 `lib/index.js`、类型声明和 Web client bundle。
- `./node_modules/.bin/vitest run tests/scripts.spec.ts tests/package-entry.spec.ts`；2 files / 5 tests 通过。
- `node scripts/smoke-m2.mjs`；完成当前工作树的 receipt/source、exact symbol/source、imports 与 contains 检查。该结果仍只属于 legacy local smoke，不是 M5 固定真实仓证据。
- `./node_modules/.bin/vitest run`；27 files / 246 tests 通过（M4 基线 244 + G1 脚本回归 2）。
- `git diff --check` 通过。

以上结果只验收 G1；如后续修改本节，以最终 release candidate 的独立验收报告为准。

## E1–E4 状态

- **E1 已满足（Task 1–2）**：corpus 固定为 Zod `v4.4.3` @ `1fb56a5c18c27102dbc92260a4007c7732a0ccca`（archive sha256 `48e2438e…`），scan root `packages/zod/src`，286 文件 / 2,237,613 字节；独立只读代理产出 20 条 gold（8 declaration / 6 source / 6 relation），父代理逐条以 raw corpus 字节重算 offset/hash、用 TypeScript 5.9.3 AST 复核 10 条声明 span（`verify-gold-ast.log`，10/10 OK）、并以 compiler 对全 corpus 286 文件做 tree-wide 声明唯一性扫描（`verify-gold-treewide.out.json`，`allowsEval` 恰 3 个、其余各 1 个）并重读全部关系源。冻结 `eval/m5/gold.json` sha256 `cb9b7c90ed06cfd6a1960fdd71d77733265d21213253916d4357651c409d5237`（AI 独立源复核，非人工复核）。
- **E2 已满足（Task 3，host 单次；矩阵与最终候选复跑并入 E4）**：新增隔离 runner `eval/m5/vitest.config.ts` + `eval/m5/acceptance.spec.ts`，仅含验收 spec；缺 corpus/gold 即失败，gold hash 漂移即失败。20/20 gold 在公开入口逐条通过（declaration 含 recall@5=1 与 span snippet 回读、source 含 padding/clamp/多字节/空 range、relation 集合相等且无序）；五个公开工具经真实 ToolRuntime/SessionStore/WorkspaceRegistry 在临时 corpus 副本上完成 receipt→query→source→relation，并覆盖内容修改、插入行位移、新增文件、删除文件、refresh 失败保留旧 runtime、旧 snapshot/旧 source handle 报 stale。报告写入 `node_modules/.cache/m5-eval/reports/acceptance-result.json`。
- **E3 已满足（Task 4）**：`@han_05/dsh-context@0.2.1` 与 `@han_05/dsh-context-cache@0.2.0` 可从 registry 解析；packed tarball `han_05-dsh-code-intelligence-0.2.1.tgz` sha256 `d58b0438…`（8 项，含两份 sourcemap）。在 `/tmp/m5c22`、`/tmp/m5c24` 以隔离 pnpm `--ignore-workspace` 建立**无 workspace 链接、无 tarball override** 的干净 consumer，两版 Node 从公开入口跑通 5 工具链路并确认旧 `code_*` 工具与 `contextCompiler` 服务已不存在；下游兼容策略明确为「V1 消费方显式 `mountCodeIntelligence`/迁移到 `context_*`，orchestrator/eval 可选注入软降级」。详见 `doc/m5-acceptance.md` §4。
- **E4 已满足（Task 5）**：发布候选在 Node `v22.19.0` 与 `v24.6.0` 上复跑 —— `tsc -b`、`tsdown`、全量 `vitest run`（27 files / 246 tests）、真实仓验收 runner（1 file / 5 tests，20/20 gold）全部通过；真实仓首次全量索引 286 文件完整、10,052 symbols / 11,042 relationships，两版 Node 得到相同 snapshotId `sha256:aade882c…`；干净 consumer 安装矩阵通过。本轮修复 F1（补 `lib/index.js.map` 到 `files`）与 F2（built-entry smoke 测试超时）。独立只读代理完成对抗式验证，未发现阻塞项，但提出 4 项证据追溯问题（tree-wide 唯一性脚本含死代码、部分数字无留存产物、验证报告悬空指针、AST 输出未留存）；父代理已逐项修复并留存：全 corpus 286 文件 compiler tree-wide 扫描（8/8 目标计数符合）、`verify-gold-ast.log`、`acceptance-result-host.json`、`independent-verification.md` 与 `independent-verification-addendum.md`。
- **收益状态：`not-ready`**。尚未执行 Baseline/C pilot，不宣称检索、token、成本、时延或 coding-task 收益。

## 附属试点：默认检索（grep）基线（不计入 M5 验收）

为后续收益评估预置基线，额外跑了一轮**无模型**的静态检索对照，预登记探针冻结于
`eval/m5/baseline-grep.patterns.json`（sha256 `45d2bd66baaf9a6525089d6fe1905a48c96ed2d743e048f3be937e64f7e75a1f`）。
真实 `grep`（`@deepseek-ai/dsh-tool-fs-search@0.1.3-alpha.2`，从 DSH profile 已安装副本解析，打包 ripgrep）与本包
`context_*` 在同一真实 `ToolRuntime`、同一临时语料副本上跑同一组探针，仅 subprocess
进程缝为适配臆层。

单次观测（Node v26.8.2，20 样本）：两臂检索面均 20/20，但口径不同 —— 声明臂 grep
返回 143 条命中覆盖 10 个目标、确定性排序 top-1 仅 6/8；source 臂 grep 需再整读
5545 B；relation 臂 grep 只能给出语句行；成本结构相反（grep 零启动 ~15–22 ms/次，
结构化臂冷 repo-map ~1.7–2.7 s 后 ~4–6 ms/次）。

**该试点不是 M5 验收证据，也不构成收益结论**（无模型参与，无任务成功率 / token-to-success /
tool-call / 端到端时延）；收益状态仍为 `not-ready`。结论与边界见
`doc/m5-baseline-grep-pilot.md`，结果见 `node_modules/.cache/m5-eval/reports/baseline-grep.json`。

Phase 2（有模型参与）已完成，见下文「Phase 2：代理对照实验」与 `doc/m5-phase2-results.md`。

**证据修正（2026-09-10，Phase 2 准备期发现）**：早期记录把被测 bundle 记为 `0.1.2-rc.1`（该版本存在于根 store），
但 harness 实际解析并导入的是 DSH profile 中的 `0.1.3-alpha.2`
（`.dsh/profiles/node_modules/@deepseek-ai/dsh-tool-fs-search` → `upstream/deepseek-harness/apps/cli/node_modules/...`）。
现已修正探针文件与报告的版本字段，并在报告 `grepTool.version` 中记录运行时实测版本；因探针文件内容变化，
`probesSha256` 由 `e51b95a4…` 变为 `45d2bd66…`，Phase 1 结果已用修正后的冻结探针重跑（数值不变）。

本包**不新增任何依赖边**：harness 从本工作区已安装的真实产品包（DSH base profile 的传递依赖，通常为 `../../.dsh/profiles/node_modules/@deepseek-ai/dsh-tool-fs-search`）解析并导入该 bundle，因此运行基线不会改写共享的 root `pnpm-lock.yaml`（可用 `DSH_FS_SEARCH_ENTRY` 覆盖）。

### Phase 2：代理对照实验（`default` vs `additive` vs `replacement`）

在 Phase 1 基础上，补上"有模型参与"的一环：冻结任务集
`eval/m5/agent-tasks.json`（sha256 `a1f359f1b60f06dbdf13592b2712fdab13da2355466e9db99c1cb4f4c07052f4`，
20 题，由冻结 gold 确定性投影）、预登记规则 `doc/m5-phase2-preregistration.md`（v1.1）、
harness `eval/m5/agent-baseline.mjs`。三臂共用同一真实 `ToolRuntime`、同一模型（`deepseek-chat`，
用户自有官方 API，`temperature 0`）、相同预算上限；仅暴露只读检索工具（`read`/`grep`/`glob` + `context_*`）。

`N = 3`（每臂 60 次运行，0 失败）：

| 臂 | 正确率 | 每题 token 中位数 | R = 中位数比值 |
| --- | --- | --- | --- |
| `default`（`read`+`grep`+`glob`） | 51/60 = 85.0% | 3,471 | 1.00 |
| `additive`（+`context_*`） | 53/60 = 88.3% | 10,742 | 3.09 |
| `replacement`（`context_*` 替代搜索） | 59/60 = 98.3% | 16,039 | 4.62 |

按预登记规则：R1（正确率非劣）两臂均成立；R2（成本占优，R ≤ 0.70）**均不成立**；
R6 **被触发** —— 必须写明"代理式使用中结构化工具**增加**开销"；R4 能力下限未触发
（`replacement` 在 relation 上 18/18）。`additive` 被 `replacement` 支配（更贵、更不准），
工程含义是**应替代而非叠加**。

**收益状态仍为 `not-ready`**：正确率提升为真，但无成本优势，且证据仅覆盖只读检索问答
（非 SWE 任务）。结论、分类别数据、敏感性检验与限制见 `doc/m5-phase2-results.md`，
原始数据 `node_modules/.cache/m5-eval/reports/agent-comparison.json`。

锁文件说明（可追溯）：root `pnpm-lock.yaml` 在本轮开始前已有未提交改动 —— `node_modules/.pnpm/react@18.3.1`、`@deepseek-ai+dsh-settings@0.1.2-rc.1` 的安装时间戳为 2026-09-09（早于本轮），且 root HEAD 的 lockfile 仍为 `dsh-settings@0.1.1-rc.2`，与已提交的各子包 `package.json` 不一致。本轮曾用 `pnpm add -D` 试装 `@deepseek-ai/dsh-tool-fs-search`，产生跨包 peer 标识符后缀 churn（版本未变）；随后已回退：`packages/dsh-code-intelligence/package.json` 不再声明该依赖，lockfile 中本包 importer 也不再包含该条目，并用 `pnpm install --offline --frozen-lockfile` 同步 node_modules（已确认本包 `node_modules` 下不再有该链接）。净结果：本包未新增依赖边，lockfile 仅为既有的规范化未提交状态。

## E2 证据（host 运行，2026-09-10）

- 构建：`buildIndexP0` 首次全量索引 286 文件 / 10,052 symbols / 11,042 relationships，`extraction.complete = 286`。
- `./node_modules/.bin/vitest run --config eval/m5/vitest.config.ts` → 1 file / 5 tests 通过（Node host `v26.8.2`）；工具级 refresh 场景总耗时约 20s。
- 说明：以上为开发期 host 结果；正式 E4 已在 Node `v22.19.0` 与 `v24.6.0` 上对冻结候选复跑并记录，见 `doc/m5-acceptance.md`。

## E4 证据（Node 矩阵，2026-09-10）

- 机器可读汇总：`node_modules/.cache/m5-eval/reports/task5-matrix.json`、`task4-package-install.json`、`acceptance-result-node22.json`、`acceptance-result-node24.json`。
- Node 22.19.0 / 24.6.0：`tsc -b` pass、`tsdown` pass、全量 `vitest run` 27 files / 246 tests pass、验收 runner 1 file / 5 tests pass，`failures: []`。
- tarball sha256 `d58b04387bd282f5378c02e13fb6dc11bed25d1756d90b0acc1c46e97c22a846`，连续两次 pack 字节一致。
- consumer `/tmp/m5c22`、`/tmp/m5c24`：五工具链路 pass、旧工具/旧服务 absent、依赖全部 registry 解析。
- 独立验证：`independent-verification.md` + `independent-verification-addendum.md`（无阻塞；P2 证据追溯问题已修复）；gold 复核产物 `verify-gold-treewide.out.json`、`verify-gold-ast.log`；host 报告 `acceptance-result-host.json`（buildMs 4606）。

## E5 证据（Phase 3 语义探针，只读诊断）

- 脚本 `eval/m5/semantic-probe.mjs`；报告 `node_modules/.cache/m5-eval/reports/semantic-probe.json` sha256 `6a27e4c37060bdfa050b95735f19e8d0fe43ff64f01cf1c7c2fc45255b98d5a2`；文档 `doc/m5-semantic-probe.md`。
- 起因：询问"用 LSP 模式再跑一轮测试"。核查确认该模式在产品里不存在，无法切换 —— `ReadonlyLspAdapter` 在 `plugin.ts`/`p0-runtime.ts`/`p0-build.ts`/`p0-snapshot.ts` 中引用数为 0，且只发 `textDocument/documentSymbol`（零关系输出）；即便接成第 4 臂，`declaration` 必然打平、`source`/`relation` 无法服务。故改为**语义探针**：启发式侧用真实产品工具，语义侧用已捆绑的 `typescript@5.9.3`（`ts.createProgram` + `TypeChecker`），**未新增任何依赖**。
- 结果：declaration 层**零语义分歧**（span 10/10，符号 10/10，`kind` ↔ `ts.SymbolFlags` 一一对应）；`zod/v4` 解析到 `v4/index.ts`；`rel-02` star 导出由 2 个目标展开为 **249 个具体名字**；`calls` 共 4,836 边 / 703 名字 / 1,162 声明（坍缩因子 **1.653**），**可连接边 0**（`addUnresolvedRelation` 永远产出 `{kind:"unresolved"}`），单文件内一词多义 72 边（1.49%，如 `JSON.parse` 与 `z.parse` 同边），未解析调用点 155/32,304 = 0.48%。
- 探针自身两处错误已修正并留档：P1（金标 span 是声明节点范围，非标识符范围，曾误判 5/10）；P2（"未解析源于语料缺 vitest/@types/node" 被证伪，实为接收者类型未解析的成员调用）。
- 对既有结论的影响：`declaration` 三臂 24/24 从"反常"变为"预期"（该层是语法树直接投影，无可改进空间）；`rel-04` 的差异获得机制依据，但同时也暴露出**产品自身的调用边不可连接**，这不能算作对 grep 的优势。
- 边界：单一语料/单一语言；语义侧惰性解析，是下界；**不构成 M5 验收的一部分**，收益状态仍为 `not-ready`。

## E6 证据（工具面对账，只读）

- 脚本 `eval/m5/audit-tool-surface.mjs`；文档 `doc/m5-tool-surface-audit.md`。
- 暴露面实证：`default` = `glob,grep,read`；`additive` = 上述 + 5 个 `context_*`；`replacement` = `read` + 5 个 `context_*`（无 grep/glob）。与冻结报告标签完全一致。
- "read-only" 与 "read+rg+glob" 分属两个层面：沙箱策略为 `read-only`（harness 硬编码，本实验设定），而暴露的检索工具面是 `read` + `grep` + `glob`；`grep`/`glob` 后端是打包的 **ripgrep 15.0.0**（`@vscode/ripgrep`，`rg --json` / `rg --files`）。`write`/`edit` 由臂过滤丢弃且沙箱本就禁止（双重排除）；`read_image` 未注册（可选依赖 `attachments` 未挂载）。
- 保真度核查：`tool-fs` 配置与插件默认**逐项相等**；`sampleOverCapGlobResults = false` 与真产品 `dsh-base/cordis.patch.yml` **一致**；fs-search caps 直接引用插件导出常量。唯一偏差是沙箱模式（产品预设含 `workspace-write`/`danger-full-access`，本实验固定 `read-only`）。
- **插件侧不规定优先使用**：`src/` 中 `systemPrompt` 引用数 = 0；`plugin.ts` 仅 `inject: ['tools']`；`context_symbol_query` 描述原文含 "Host grep/read remain valid alternatives."；bundle `cordis.patch.yml` 为裸 `insert`，无 prompt/priority 字段；仓库 `AGENTS.md`/`CLAUDE.md` 均未提及 `context_*`。
- 新增不对称发现：`context_*` 5 个工具占 **6,363** 字符（description+params），是 `read+grep+glob`（1,987）的 3.2 倍；工具 schema 每次请求重发，估算 `additive` 的额外 schema 开销为 **299,108 tok ≈ 其总 token 增量的 58.6%**，`replacement` 为 261,048 tok ≈ 38.2%。**扣掉全部 schema 开销后**，R 由 3.09/4.62 降为 **1.54/2.42** —— R2 仍失败、R6 仍触发，判决方向不变、量级显著变小。成本优化的最大单项抓手是精简工具描述（尤其 `scope` 前缀里的内部里程碑代号 `M4`/`PTC`/`native transport`）。
- 另一处保真度偏差：harness 把 `systemPrompt` stub 为空，真产品的 5 段 `tool:read/write/edit/glob/grep` 提示全部被丢弃；但它们都是"别用 shell"类指令，而**没有任何臂暴露 shell**，属对称缺失。

## E7 证据（Phase 2b：公平性修复后重跑，推翻 v1 准确率结论）

- 预注册 `doc/m5-phase2b-preregistration.md`（运行前冻结）；结果 `doc/m5-phase2b-results.md`。
- **修复 3 处**：(F4) 9 个 `source`/`relation` 提问去掉被测工具自用语汇（UTF-16 半开偏移、`paddingLines`/夹取、`` `calls` relation ``），**答案零改动**，由 `build-agent-tasks.mjs --verify-against agent-tasks.v1.json` 断言 20/20 `answerSpec` 逐字节不变；(F1) system prompt 删除偏向结构化工具的那句；(F2) 产品的 `systemPrompt` 段由 no-op 改为收集并按"工具是否暴露"过滤后转发。
- 任务集 v2 sha256 `b5d725943640f7fe22ec1509909ed8da2d1a3553ba93a687c77825a1d46e5ff1`；v1 存档 `eval/m5/agent-tasks.v1.json` sha256 `a1f359f1b60f06db…`；gold 未改 `cb9b7c90…`。
- **结果（2 次独立复制 × N=3 × 20 任务 × 3 臂 = 360 次运行，0 失败）**：`default` **119/120 = 99.2%**、`additive` **120/120**、`replacement` **120/120**；三臂任务多数票均 **20/20**。全部 360 次运行只剩 **1** 个非一致格子（`default`/`decl-01` 5/6）。唯一判别对的精确 McNemar **p = 1.0**。
- **v1 的四个判别任务全部翻盘**：`src-02` 1/3→3/3、`src-03` 2/3→3/3、`src-06` 0/3→3/3、`rel-04` 0/3→3/3（`default` 臂），无一格变差。`default` 85.0%→99.2%。**预注册 §5 的证伪条件命中 → Phase 2 v1 的准确率结论作废**（`doc/m5-phase2-results.md` 已加推翻横幅，文件保留不覆盖）。
- **成本结论反而更锐利**：准确率打平下，`default` 456,603 tok，`additive` 976,188（**R=2.138**），`replacement` 1,820,567（**R=3.987**）；结构化臂另需 ~2s 索引冷启动。
- **成本分解**：工具 schema 占总 token `default` 33.9% / `additive` **66.7%** / `replacement` 40.4%。扣除 schema 开销后 **R_adj = 1.000 / 1.075 / 3.590** —— `additive` 的劣势几乎全部来自描述体量，精简描述后可近似免费；`replacement` 的劣势来自真实检索行为（`context_repo_map` 157 次、`context_expand_source` 92 次）。
- `additive` 臂里模型只用了 18 次 `context_*` vs 228 次 grep/read/glob —— 有得选时它选了 grep，独立佐证无能力落差。
- **新局限**：v2 下三臂均已饱和（20/20 多数票），**这套 20 样本不再具备区分能力**；只能说"在此样本上检测不到差异"，不能断言"能力等价"。
- 未改动产品源码，故 M5 Task 1–5 验收、tarball、Phase 1、Phase 3 结论均不受影响。
