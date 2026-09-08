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
