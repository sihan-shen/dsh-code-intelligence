# M1 实施进度

范围与验收以 [设计](./code-intelligence-design.md) 和 [任务拆解](./code-intelligence-tasks.md) 为准。本文件记录本地实施证据，不把草案或子进程自报等同于完成。

## 执行约束

- 本包分支：`feat/m1-code-intelligence-foundation`。
- 共享合同分支：`dsh-context` 的 `feat/m1-code-intelligence-contracts`。
- 允许修改本包与 `dsh-context`；不修改宿主工具包、upstream harness 或 node_modules。
- 阶段性本地 commit，不 push、不发布。
- 模型仅使用 `opencodex/gpt-6-astra` 与 `opencodex/gpt-5.6-sol`，不使用 `deepseek/...` 或 `command-code/...`。
- 子任务按文件归属并行，协调者审核、集成、提交；遇设计或宿主能力阻塞先报告，不自行降低验收标准。

## 基线

本包起点：`eae28fb`。

- `pnpm typecheck`：通过。
- `pnpm test`：11 个测试文件、79 个测试通过。
- 两个目标仓库开始时工作区干净；宿主已有未跟踪 `tsx-1000/` 不在本次修改范围。

## Task 状态

| Task | 模型 | 状态 | 备注 |
| --- | --- | --- | --- |
| F1 合同与接口 | gpt-6-astra | 进行中 | 新增 P0 合同，保留 V1 默认能力 |
| F2 宿主失败桥接 | gpt-6-astra | 能力审计中 | 仅检查现有公开扩展点，不修改宿主 |
| F3 有界扫描与读取 | gpt-6-astra | 等待 F1 读取接口 | 安全与资源边界任务 |
| F4 AST 文件事实 | gpt-5.6-sol | 等待 F1 局部事实接口 | 按覆盖表与 fixture 实现 |
| F5 两阶段构建 | gpt-6-astra | 等待 F3/F4 | 身份、endpoint、fingerprint 集成 |

M1 尚未完成；后续在本文件补充具体提交、测试与阻塞证据。
