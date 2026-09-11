# M5 Local Acceptance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Track actual completion with checkboxes. The current user authorizes Task 1 only; Tasks 2–5 describe subsequent acceptance work, not permission to publish.

**Goal:** 准备可复现本地环境，随后证明 P0 在一个固定真实仓正确工作且包可独立安装。

**Architecture:** 固定 Zod 源码作为 corpus；独立源码核验的 gold 与被测 extractor 分离。直接结构化查询和真实宿主 refresh 分层验证，发布验证使用干净 consumer，报告分别描述工程状态和收益状态。

**Tech Stack:** Node 22/24、pnpm 11.7.0、TypeScript、Vitest、现有 P0 工具、Git、SHA-256。

**Spec:** `doc/code-intelligence-design.md` §8；`doc/code-intelligence-tasks.md` §6；本会话已确认的 corpus、20 样例和验收规则。

## Global Constraints

- 所有路径以本包根目录为基准；现有未提交修改必须保留。不得 commit、push、升版、publish、改其他包或全局工具配置。
- 本轮仅执行 Task 1 本地环境准备；不创建伪 gold，不把准备 smoke 算成正式 M5 验收。
- Corpus 为 `https://github.com/colinhacks/zod` 的 `v4.4.3`，下载完整源码，扫描根为 `packages/zod/src`；先核实完整 40 位 commit，再固定归档和校验和。不能自动替换 tag 或使用浮动 HEAD。
- 在扫描根内保留源码和原有测试源码；排除 node_modules、构建输出和 Git 元数据；清单明确记录实际规则和容量截断。
- 20 个独立样例：8 声明定位、6 source、6 imports/exports/contains 关系。关系仅验证 P0 语法合同，不把 unresolved 当作已解析调用图。
- 唯一精确目标检查 top-1；同名目标预登记集合，报告 recall@5，并完整分页核对目标集合。多于 5 个目标时 recall@5 不要求为 1；分页后的目标覆盖与所有样例正确性断言必须通过。
- 路径、声明范围和 source evidence 精确核对；不以 symbolId 作为唯一 gold。坐标约定采用实际 P0 合同，gold 保存源码片段和文件 hash 辅助独立校验。
- Gold 由只读代理检查源码建立，父代理逐项复核；不从被测 extractor 生成；报告标注 AI 独立源码复核、未经人工复核。
- 改内容、插入行、增删文件在临时副本执行；故障注入复用确定性测试。首次构建耗时只是观察值。
- Node 22 使用满足 `^22.19.0` 的精确版本，Node 24 使用精确版本；记录平台和架构。Node 26 的检查不替代该矩阵。
- 收益状态维持 `not-ready`；下游迁移、共享包可发布版本、registry/dist-tag 与实际发布仍需后续明确处理。

## File map

| 文件 | 责任 |
| --- | --- |
| `eval/m5/README.md` | 准备、验证、离线重跑命令及目录说明 |
| `eval/m5/corpus.lock.json` | 已核实的 URL/tag/commit/归档 SHA-256/扫描规则/许可证 |
| `scripts/prepare-m5-env.mjs` | 可重复准备、校验 corpus；禁止悄悄重选 revision |
| `node_modules/.cache/m5-eval/`（忽略） | 下载归档、解压 corpus、精确版本工具、临时副本和原始报告 |
| `doc/m5-environment.md` | 本机环境、实际命令/结果、阻塞与复现入口 |
| `eval/m5/gold.json`（Task 2） | 冻结的 20 个独立样例及复核信息 |
| `eval/m5/acceptance.spec.ts`（Task 3） | 固定真实仓查询/source/refresh 验收 |
| `eval/m5/vitest.config.ts`（Task 3） | 单独运行真实仓，不混入默认合成测试 |
| `doc/m5-acceptance.md`（Task 5） | 正式工程验收报告 |

## Task 1: 本地测评环境准备（本轮执行）

**Files:** 新增环境脚本、README、lock 和环境报告；复用已有 node_modules 忽略规则。不要编辑 plan、生产 src、已有测试或根 HANDOFF，后者由父代理维护。

**Consumes:** 以上固定 corpus 与 Node 矩阵。**Produces:** 已校验源码目录、真实 lock、可复现命令、环境状态报告。

- [x] 记录包 Git HEAD、分支和 dirty 文件列表；检查适用 AGENTS。检查现有 Node、pnpm、git、tar、下载工具和 node_modules，避免重装整个 monorepo。

```bash
git status --short
git rev-parse HEAD
node --version
pnpm --version
git ls-remote https://github.com/colinhacks/zod.git 'refs/tags/v4.4.3' 'refs/tags/v4.4.3^{}'
```

- [x] 对 annotated tag 取 peeled commit；对 lightweight tag 取其 commit。下载 `https://codeload.github.com/colinhacks/zod/tar.gz/<已核实完整commit>`，计算 SHA-256，保存官方 LICENSE。网络失败记录精确失败，不伪造 lock。
- [x] 实现 `node scripts/prepare-m5-env.mjs`：首次固定后写入 lock；后续只按 lock 获取归档并校验，拒绝 checksum 不符；解压前检查成员路径不逃逸目标目录；拒绝覆盖未知已有目录。支持 `--verify-only` 离线校验已准备源码和归档。
- [x] 将下载和解压产物放入 `node_modules/.cache/m5-eval/`，不将完整第三方源码提交到仓库。记录整棵扫描源码的确定性文件/hash 清单，使离线检查也能发现源码修改；编辑测试只能改副本。
- [x] 优先复用已装 Node 22/24。缺失时在 `node_modules/.cache/m5-eval/tools/` 下载官方对应架构二进制并按官方 SHASUMS 校验；不修改系统 PATH 配置。把实际精确版本和可调用绝对路径写入报告。pnpm 同样使用本地隔离目录，禁止升级 package/lockfile。
- [x] 对两个 Node 分别验证版本、构建入口 import 和现有定向测试；缓存保持原位，禁止通过临时搬走工具目录获得通过。构建可使用现有二进制；pnpm 失败时记录原因并使用直接入口，不能冒称 pnpm 命令通过。

```bash
./node_modules/.bin/tsc -b --pretty false
./node_modules/.bin/tsdown --config tsdown.config.ts
./node_modules/.bin/vitest run tests/package-entry.spec.ts tests/scripts.spec.ts
node scripts/prepare-m5-env.mjs --verify-only
```

- [x] 对准备脚本做最小有效验证：首次准备、离线复验、再次执行不改变 lock；在独立测试临时目录中篡改归档或源码后确认校验失败，不破坏主 corpus。脚本路径/校验逻辑有单元测试时仅新增独立测试文件。
- [x] 环境报告分列 corpus-ready、Node22-ready、Node24-ready、pnpm-ready、built-entry-ready；记录每个检查命令/退出码和未完成项。环境全绿也不代表 gold/E2/E3 完成。

**Exit:** corpus 锁定且离线校验通过；两种 Node 能运行本包入口与定向检查；复现文档完整。若网络/工具限制无法解决，交付已完成部分和具体阻塞，不将 Task 1 标为完成。

## Task 2: 独立 gold 冻结（后续）

**Files:** 新增 `eval/m5/gold.json`，补充 README。

- [ ] 只读 gold 代理读取 lock 和 corpus 源码，不调用本包 build/extractor；逐条选择 8/6/6 个样例，覆盖实际存在的同名、重导出、嵌套声明。
- [ ] 每条保存 id/category/query、预期路径/名称/声明范围、允许目标集合、source 片段/hash 或关系类型/evidence、判定模式；父代理直接源码复核全部 20 条并记录复核信息。
- [ ] 先冻结 gold 文件 SHA-256，再执行被测查询。gold 修订必须保留原因和旧 hash，不删除失败样例换取通过。

**Exit:** 20 条可独立核对，查询输入与答案分离，范围/重载等价集合在跑测前冻结。

## Task 3: 真实仓 runner 与编辑-refresh（后续）

**Files:** 新增 `eval/m5/acceptance.spec.ts`、`eval/m5/vitest.config.ts`。

- [ ] 独立 Vitest config 的 include 只含本目录 acceptance.spec.ts；缺 corpus 或 gold 时失败并提示准备命令，不能 skip 后报成功。
- [ ] 沿用 `scripts/smoke-m2.mjs` 的公开入口：`buildIndexP0`、`parseSnapshotConfigP0`、`repoMapP0`、`symbolQueryP0`、`relationQueryP0`、`expandSourceP0`、`createVerifiedReaderP0`。deploymentRoot 为锁定扫描根，revision 使用 corpus commit。确认相对路径以扫描根为基准。
- [ ] 在首次无 cache 完整构建前后计时，记录文件数、extraction summary、截断/失败和 Node 版本；每个 gold 独立报告 actual/expected，不借 grep 补救结构化结果。
- [ ] 唯一目标检查首项；同名集合记录前5召回并遍历 cursor 检查全量；source 比较冻结片段/范围；关系检查方向、类型、resolution 和证据。
- [ ] 参考 `tests/loader.spec.ts` 的真实 ToolRuntime/Session/WorkspaceRegistry 接线调用五个公开工具。在 corpus 临时副本逐次改内容、插行、加文件、删文件，每次 refresh 后核对新查询、source 和旧句柄错误；保留 golden corpus 不变。
- [ ] 运行已有 refresh/错误边界测试，不将挂起 I/O 等同步无法保证的行为虚报为硬终止。

```bash
./node_modules/.bin/vitest run --config eval/m5/vitest.config.ts
./node_modules/.bin/vitest run tests/p0-refresh.spec.ts tests/p0-refresh-review.spec.ts tests/p0-tool-errors.spec.ts
```

**Exit:** 所有必过样例和编辑状态断言通过，机器可读结果含 corpus/gold hash、失败信息、版本和构建耗时。

## Task 4: 干净安装与兼容（后续）

**Files:** 报告写入 `node_modules/.cache/m5-eval/reports/`，结论进入最终报告；不自动改其他包。

- [ ] 检查 context/context-cache 所需 P0 导出与可获取发布版本；确认下游 V1 consumer/profile 迁移或明确不兼容策略。不可用即记录发布阻塞。
- [ ] 执行 `pnpm pack --pack-destination node_modules/.cache/m5-eval/artifacts`，检查 tarball 列表、package exports、类型入口、client 和 patch 文件。
- [ ] Node22/24 分别使用无 workspace 链接的临时 consumer 安装 tarball。正常解析声明依赖和 peer 依赖；若临时使用共享包 tarball override，单列为本地兼容证据，不能宣称 registry-ready。
- [ ] consumer 从安装包公开入口启动实际工具注册并完成 repo-map → symbol → relation → source → refresh；检查旧工具/旧 compiler 合同按当前设计失效。生产入口参考 `tests/package-entry.spec.ts`，不能用 src 导入替代 tarball。
- [ ] 核对 README、导出与实际工具说明一致，不宣称未接入 LSP；完整记录兼容限制。实际 publish 不在本计划授权内。

## Task 5: 最终回归与报告（后续）

- [ ] 在最终 candidate 运行 `typecheck`、`build`、全包 `vitest run`、独立真实仓 runner 和 Node22/24 consumer 检查；检查最终 diff。
- [ ] 写 `doc/m5-acceptance.md`：环境、源码/corpus/gold 身份、样例结果、refresh、合同测试、安装矩阵、首次构建耗时、已知问题、工程 verdict 与收益 `not-ready`。
- [ ] 更新 `doc/m5-progress.md` 和根 HANDOFF，只依据实际证据勾选 E1–E4；工程 gate 未通过时明确阻塞，不能以准备完成替代。

## 环境布局修订依据

首次准备发现包根 `.m5-local` 中的 Node 二进制会被 legacy working-tree smoke 扫描，导致容量超限。因此缓存固定为已有扫描排除规则覆盖的 `node_modules/.cache/m5-eval/`；不修改生产扫描器或既有 smoke 来迁就测评环境。

## 本轮交付与后续边界

本轮交付此计划以及 Task 1 的实际准备结果。Task 2–5 尚未执行，不做版本变更、commit、push、publish 或 Baseline/C pilot。
