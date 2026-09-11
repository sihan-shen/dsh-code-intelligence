# M5 真实仓工程验收报告

- 分支：`feat/m5-release-acceptance`
- 候选：`@han_05/dsh-code-intelligence@0.2.1`（未做版本升级、commit、push 或 npm publish）
- 结论日期：2026-09-10
- 收益状态：`not-ready`（本报告只给工程验收，不给检索/成本/时延/coding-task 收益结论）

## 1. 验证环境

| 项 | 值 |
| --- | --- |
| Node（矩阵） | `v22.19.0`、`v24.6.0`（`node_modules/.cache/m5-eval/tools/` 内隔离二进制） |
| Node（开发 host） | `v26.8.2`（仅 E2 单次 host 运行，非发布依据） |
| 包管理器 | pnpm `11.7.0`（隔离副本） |
| TypeScript | `5.9.3` |
| vitest | `4.0.18` |
| 平台 | linux x64 |

`package.json` 声明 `engines.node: "^22.19.0 || >=24"`，矩阵覆盖两端。

## 2. 身份（可复现锁定）

### 2.1 语料

- 仓库：`https://github.com/colinhacks/zod.git`
- tag / commit：`v4.4.3` / `1fb56a5c18c27102dbc92260a4007c7732a0ccca`（不使用浮动 HEAD、不自动替换 tag）
- archive sha256：`48e2438edf0294d148b8a06cb5f1954e99aa17ecbb79bef036253cfd2b37f777`
- license sha256：`3f1189b28e3866e0d979968d466b78f813f76827cfdca1fbb124cc0a5c8841f8`
- scan root：`packages/zod/src`（绝对路径见 `eval/m5/corpus.lock.json`）
- 规模：286 文件 / 2,237,613 字节

### 2.2 Gold

- 文件：`eval/m5/gold.json`，sha256 `cb9b7c90ed06cfd6a1960fdd71d77733265d21213253916d4357651c409d5237`
- 该哈希同时冻结在 `eval/m5/acceptance.spec.ts` 的 `FROZEN_GOLD_SHA256` 与 `eval/m5/README.md`；runner 在哈希漂移时直接失败。
- 20 条样本：8 declaration / 6 source / 6 relation。
- 独立性：gold 由只读代理产出，父代理**不用被测提取器**、仅以 raw corpus 字节重算 offset/hash，并用 TypeScript 5.9.3 AST 对 10 条声明 span 逐条复核（`verify-gold-ast.log`，10/10 OK），再做全 corpus 286 文件的 tree-wide 声明唯一性扫描（`verify-gold-treewide.out.json`，8/8 目标计数符合预期：`allowsEval` 恰 3 个，其余各 1 个）；gold 在任何一次运行被测提取器之前即已冻结并哈希。
- 属性：**AI 独立源复核，非人工复核**。

### 2.3 产物

- tarball：`node_modules/.cache/m5-eval/artifacts/han_05-dsh-code-intelligence-0.2.1.tgz`
- sha256：`d58b04387bd282f5378c02e13fb6dc11bed25d1756d90b0acc1c46e97c22a846`（连续两次 `pnpm pack` 字节一致）
- 内容：8 项 —— `package.json`、`README.md`、`cordis.patch.yml`、`lib/index.js`、`lib/index.js.map`、`lib/index.d.ts`、`lib/index.d.ts.map`、`lib/client.js`

## 3. 验收结果

### 3.1 20 条 gold（公开入口 `lib/index.js`，非 `src/`）

全部通过，`failures: []`。

- declaration 8/8：唯一目标 top-1 精确命中；同名集合（`allowsEval` 3 处）以预注册集合报告 `recall@5 = 1`，并做完整分页核验。
- source 6/6：含 wholeFile、offsetRange、lineRange+padding、空 range（`87-87`，textLength 0）、多字节（UTF-16 半开区间 `269-428`，textLength 159）、padding 越界 clamp。
- relation 6/6：含 imports / exports / contains / calls（启发式）/ 零边；contains 集合按**无序集合相等**比对（`Red/Green/Blue`）。

### 3.2 工具级行为（真实 `ToolRuntime`/`SessionStore`/`WorkspaceRegistry`，临时 corpus 副本）

覆盖：内容修改、插入行位移、新增文件、删除文件、refresh 失败保留旧 runtime、旧 snapshot 与旧 source handle 报 stale（实测失败码 `stale-snapshot`）。五个公开工具 `context_repo_map → context_symbol_query → context_relation_query → context_expand_source → context_refresh_snapshot` 全链路通过。

### 3.3 首次全量索引

真实仓首次构建：`buildMs` 2,470–4,606ms（Node24 2470、Node22 2503、host 4606），`286` 文件全部提取完成（`extraction.complete = 286`），10,052 symbols / 11,042 relationships。包自身 `tsdown` 首次构建约 2.2–3.1s。

Node22 与 Node24 最终候选复跑得到**相同 snapshotId** `sha256:aade882c4baecc2ad0fff0610f374e818909c2773e6d3c899f738c9270b8c620`，表明快照对 Node 版本确定。

### 3.4 合同/回归测试矩阵

| 检查 | Node 22.19.0 | Node 24.6.0 |
| --- | --- | --- |
| `tsc -b --pretty false` | pass | pass |
| `tsdown --config tsdown.config.ts` | pass | pass |
| `vitest run`（全量） | 27 files / 246 tests pass | 27 files / 246 tests pass |
| `vitest run --config eval/m5/vitest.config.ts` | 1 file / 5 tests pass | 1 file / 5 tests pass |

### 3.5 干净 consumer 安装矩阵

consumer 位于 `/tmp/m5c22`、`/tmp/m5c24`，用隔离 pnpm `--ignore-workspace` 安装，**无 workspace 链接**、**无 tarball override**：

| 依赖 | 解析版本 | 来源 |
| --- | --- | --- |
| `@han_05/dsh-code-intelligence` | `0.2.1` | packed tarball |
| `@han_05/dsh-context` | `0.2.1` | registry |
| `@han_05/dsh-context-cache` | `0.2.0` | registry |
| `@deepseek-ai/cordis` | `4.0.2` | registry |
| `@deepseek-ai/dsh-tools` | `0.1.2-rc.1` | registry |
| `@deepseek-ai/dsh-llm` | `0.1.2-rc.1` | registry |

两版 Node 从公开入口启动真实工具注册并跑通 5 工具链路，且确认旧合同已不存在：无 `code_repo_map` / `code_symbol_query` 工具，无 `contextCompiler` 服务（`ctx.get('contextCompiler') === undefined`）。

## 4. 下游兼容策略（明确不兼容项）

- 默认 `apply` 只注册 P0 `context_*` 五工具，**不再提供** `contextCompiler` 服务，也不注册 V1 `code_*` 工具。
- V1 消费方须显式使用导出的 `mountCodeIntelligence` / `createContextTools` / `createContextCompiler`，或迁移到 `context_*` 工具。
- `dsh-orchestrator` 对 `contextCompiler` 为可选注入，缺失时优雅降级；`dsh-eval` 已处理其缺失。因此为软降级，非加载失败。
- profile `v0.2b-readonly` / `v0.2c-context` 的配置字段（`maxFileBytes`/`maxFiles`/`maxTotalBytes`/`maxDirectories`/`maxIgnoreBytes`/`nestedCheckoutRoots`）仍被 P0 config schema 接受。
- README 与导出面一致：工具名、V1 程序化 API 说明均与实际产物匹配，未宣称 LSP 能力。

## 5. 本轮修复

| ID | 严重度 | 内容 | 状态 |
| --- | --- | --- | --- |
| F1 | 低 | `lib/index.js` 引用 `index.js.map`，但 `package.json#files` 遗漏该 sourcemap；已补入 `lib/index.js.map` | 已修复 |
| F2 | 低 | `tests/scripts.spec.ts` 的 built-entry smoke 子进程超时为 30s，但 vitest 用默认 5s；Node24 首次运行实测约 5.0s 超时（修复前日志已被复跑覆盖）。已显式设置 30s 测试超时 | 已修复 |

## 6. 已知限制 / 未覆盖

- gold 为 AI 独立源复核，非人工复核；20 条样本覆盖 declaration / source / relation 三类主路径，未覆盖 P2 稀疏场景：property / namespace 声明、prefix/fuzzy 模式、CRLF、负向提取、`blockId`。
- 未执行 Baseline/C pilot，收益指标（检索命中、token、成本、时延、coding-task 质量）无证据，状态保持 `not-ready`。
- 未做版本升级、tag、publish；发布顺序与 dist-tag 决策不在本轮授权内。
- 本报告不构成 registry release-ready 之外的承诺；`@han_05/dsh-context@0.2.1` / `dsh-context-cache@0.2.0` 已可从 registry 解析，但正式发布顺序仍需单独确认。

## 7. 机器可读证据

- `node_modules/.cache/m5-eval/reports/acceptance-result-node22.json`
- `node_modules/.cache/m5-eval/reports/acceptance-result-node24.json`
- `node_modules/.cache/m5-eval/reports/acceptance-result-host.json`
- `node_modules/.cache/m5-eval/reports/task4-package-install.json`
- `node_modules/.cache/m5-eval/reports/task5-matrix.json`
- `node_modules/.cache/m5-eval/reports/verify-gold.out.json`、`verify-gold-treewide.out.json`、`verify-gold-ast.log`（gold 独立复核）
- `node_modules/.cache/m5-eval/reports/independent-verification.md`（独立验证代理）+ `independent-verification-addendum.md`（父代理执行确认）
- `node_modules/.cache/m5-eval/reports/logs/`（各步原始日志）

## 8. 结论

工程验收维度：E1–E4 的证据均已收敛（详见 `doc/m5-progress.md`），冻结候选在 Node22/24 上全量测试、真实仓验收、干净 consumer 安装与五工具链路均通过。独立只读验证代理未发现阻塞项，其提出的 4 项证据追溯问题（tree-wide 唯一性脚本、未留存数字、悬空指针、AST 输出）已由父代理逐项补齐并留存于 `independent-verification.md` 与 `independent-verification-addendum.md`。收益维度：`not-ready`，不得据此宣称任何效果收益。

## 9. 附属：默认检索基线试点（不计入 M5 验收）

为后续收益评估预置基线，另跑了一轮**无模型**的静态检索对照：真实 `grep`
（`@deepseek-ai/dsh-tool-fs-search`，打包 ripgrep）与本包 `context_*`，在同一真实
`ToolRuntime`、同一临时语料副本上跑同一组**预登记并冻结**的探针。探针只从任务输入
派生，grep 不接触 gold。

结论与边界见 `doc/m5-baseline-grep-pilot.md`，结果见
`node_modules/.cache/m5-eval/reports/baseline-grep.json`。

该试点**不是 M5 验收证据**，不改变本文第 8 节任何结论，也不构成收益结论：没有模型
参与，因此没有任务成功率、tokens-to-success、tool-call 数或端到端时延。收益维度仍为
`not-ready`。

Phase 2 在该试点之上补上\"有模型参与\"的一环（预登记判定规则 +
冻结任务集，三臂对照，`N = 3`），结论为：正确率提升为真（85.0% → 98.3%），
但每题 token 中位数升到 1.00 → 4.62 倍，预登记规则 R2 不成立且 R6 证伪子句被触发。
详见 `doc/m5-phase2-preregistration.md` 与 `doc/m5-phase2-results.md`；
原始数据 `node_modules/.cache/m5-eval/reports/agent-comparison.json`。
该实验同样**不是 M5 验收证据**，只覆盖只读检索问答，不改变本文第 8 节任何结论，
收益维度仍为 `not-ready`。
