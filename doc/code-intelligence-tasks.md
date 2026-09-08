# DSH Code Intelligence P0 任务拆解

> 将 [设计文档](./code-intelligence-design.md) 的 P0 目标拆成可独立验收的里程碑与可并行 Task。

本文负责实施顺序、依赖、交付物与验收分工，不另定义公共字段、错误码、算法或资源上限；这些以设计文档及落地后的共享 schema / policy / fixture 为准。本文不是当前能力清单，也不表示下列 Task 已完成。

## 1. 版本划分

当前版本为 `0.2.1`。本轮公共合同及工具行为变化以 `0.3.0` 为最终交付目标，中间采用预发布版本，不作为现有版本的 patch 静默发布。

| 里程碑 | 建议版本 | 核心目标 | 能力状态 |
| --- | --- | --- | --- |
| M1 | `0.3.0-alpha.1` | 合同与可信构建基础 | 建立新 snapshot/index，尚不切换默认工具 |
| M2 | `0.3.0-alpha.2` | 无 cache 的查询与源码闭环 | 能定位符号、查关系、按路径读源码 |
| M3 | `0.3.0-alpha.3` | 初始化、编辑与 refresh 闭环 | 能编辑后刷新，正确处理并发、取消和旧句柄 |
| M4 | `0.3.0-beta.1` | 可选 cache 与兼容集成 | cache 接入不改变查询正确性与可用性 |
| M5 | `0.3.0` | 真实仓工程验收与正式发布 | P0 工程就绪，收益状态单独报告 |

- 版本顺序按能力完整度验收；开发顺序按 Task 依赖，不必等前一个版本发布才启动下一个版本的工作。
- 这些首先是验收里程碑，不要求每个都发布 npm。M1 可以只是内部 tag；没有完整 Agent 路径时，不暴露半成品工具。
- 共享 context/cache 包及宿主依赖按实际合同迁移独立确定版本，不要求与本包使用相同版本号。
- P1/P2 保留评测驱动，不预排增量刷新、LSP、多 Provider、Working Set 等交付承诺。

## 2. M1：合同与可信构建基础

### 目标

```text
已注册 workspace
  → 有界 verified read
  → receipts + 文件局部事实
  → snapshot-local index
  → indexFingerprint
```

### Task

| ID | 内容与交付物 | 依赖 | 主要归属 |
| --- | --- | --- | --- |
| F1 | **最小合同基线**：公共请求/响应、错误 DTO、output policy；内部 reader/extractor/build/runtime 边界 | 无 | `dsh-context`、本包类型与 policy |
| F2 | **宿主失败桥接验证**：真实 registry 链路保留 code/message/details，包含模型可见内容与输入预校验错误映射 | F1 的错误合同 | 宿主工具包、工具适配层 |
| F3 | **有界扫描与读取**：entry 上限、有界 reader、ignore policy、文件描述符校验、统一 line map | F1 的读取与 policy 边界 | `src/snapshot.ts` 及读取模块 |
| F4 | **AST 文件事实提取**：声明覆盖、关系语法覆盖、完整名称、文件级状态、局部父子引用 | F1 的局部事实 DTO | `src/fallback.ts` 或新 extractor 模块 |
| F5 | **两阶段构建与索引终结**：receipts 定稿、分配 symbolId、连接 endpoint、全局校验、fingerprint | F3、F4 | build/index 模块 |

### 并行方式

```text
F1 固定最小接口
 ├─ F2 宿主失败桥接
 ├─ F3 verified reader / scanner
 └─ F4 AST extractor

F3 + F4 → F5 集成构建
```

F1 按错误、读取、局部事实等边界逐步交付，不要求先冻结所有未来字段。F5 可在接口确定后使用 fixture 开发，但完成验收必须接上真实 F3/F4。

### 退出条件

- receipt hash 与事实来自同一份可信文本。
- 提取过程不提前依赖最终 snapshotId。
- partial/failed 与全局构建失败能区分。
- fingerprint 不受遍历顺序影响。
- 宿主错误桥接通过端到端验证；若需上游改动，已经完成，而非留待最终集成。
- 扫描和读取过程落实设计的资源边界，不只验证最终输出大小。

## 3. M2：无 cache 查询与源码闭环

### 目标

```text
发现版本 / 按路径取 receipt
  → symbol / relation
  → 有界 source
```

### Task

| ID | 内容与交付物 | 依赖 |
| --- | --- | --- |
| Q1 | **查询公共机制**：请求归一化、cursor、字节缩页、provenance/extraction 元数据装配 | F1、F5 |
| Q2 | **Repo map 与 Symbol query**：文件页、具体 path 直查、exact/prefix/fuzzy、kind/pathPrefix、symbolId 直查 | Q1 |
| Q3 | **Relation query**：from 校验、types 集合、摘要边去重排序、分页、相关文件状态 | Q1 |
| Q4 | **Source 与 Session 预算**：offset/line/wholeFile/padding、stale-source、最终序列化计费、原子扣费 | F1、F3；接入 F5 的 runtime |
| Q5 | **无 cache 工具集成**：统一四个查询工具、真实 registry 执行、结构化错误、工具说明 | F2、Q2、Q3、Q4 |

### 并行方式

- Q1 的接口确定后，Q2、Q3 并行开发；验收时必须接入真实公共机制。
- Q4 与查询排序、分页无关，可以更早开始；Session 账本使用 F1 确定的归属接口，不在 compiler 或 agent key 上另建账本。
- Q5 可先搭适配骨架，但不能替各查询模块重复实现 parser、预算或输出裁剪。
- 尚未完成 R1 时，通过最小 Session/runtime 持有器接入查询，不另建一套临时生命周期框架；关闭和资源释放仍必须可用。

### 退出条件

一个初始化后的 workspace 能完成：

1. `context_repo_map({ path: 'config.json' })` 获取 receipt。
2. 不依赖 symbol 或关系命中，直接读取该 JSON。
3. symbol 与 relation 查询返回正确的版本和完整性信息。
4. 无 cache 时不返回虚假的 blockId。
5. 最终响应满足字节上限，源码预算在同 Session 多 agent 间共享。

此里程碑可保持 runtime 不可刷新，但必须明确预发布能力边界，不宣称 P0 已完成。

## 4. M3：初始化、refresh 与生命周期闭环

### 目标

```text
查询 → 读源码 → 宿主编辑 → refresh → 重新定位 / 读取
```

### Task

| ID | 内容与交付物 | 依赖 |
| --- | --- | --- |
| R1 | **Session 状态与 lease**：idle/initializing/active/closing/closed、共享初始化、失败重试、查询 lease、关闭 | F1、F5 |
| R2 | **Refresh 构建队列**：有界串行队列、候选构建、一次全量重试、取消/deadline、候选清理 | R1 的提交接口、F5 |
| R3 | **原子提交与工具接入**：refresh 工具、changed、旧请求固定 runtime、新请求 stale、预算不重置 | R1、R2、Q5 |
| R4 | **并发生命周期集成验收**：初始化等待者取消、关闭禁止提交、旧 lease 延迟释放、清理失败不回滚 | R1–R3 |

### 并行方式

R1 不必等 M2 发布，F1/F5 完成后即可与 Q1–Q4 并行。R1 与 R2 先共同确定最小内部职责边界：

```text
captureRuntime()
buildCandidate()
commitCandidate()
releaseLease()
closeSession()
```

上述只是职责示意，不冻结具体命名，也不扩展成通用事务框架。R1 拥有 Session 状态与 lease，R2 拥有构建任务与队列；R3 将已有机制接入工具，不重复实现两套提交逻辑。

### 退出条件

- refresh 构建期间查询不等待新版本。
- 旧查询能完成，新请求不能误用旧句柄。
- 初始化失败可恢复，单个等待者取消不破坏共享初始化。
- 初始化期间排队的 refresh 必须自行重新采集，不能复用到达前已开始的构建。
- refresh 失败保留旧 runtime。
- 关闭后不再发布候选、不重新创建同一 Session。
- refresh 不重置源码预算。

到此应具备可用的无 cache P0 主路径。

## 5. M4：可选 cache 与兼容集成

### 目标

缓存仅作为可选加速与 block 关联，不成为主路径的必要前置。

### Task

| ID | 内容与交付物 | 依赖 |
| --- | --- | --- |
| C1 | **Cache 最小合同升级**：写入确认、显式读取分类、原因诊断、indexFingerprint 边界 | F1 |
| C2 | **查询页缓存包装**：canonical lookup、命中验证、miss 重算、不可用降级、确认写入后返回 blockId | C1、Q1–Q3 |
| C3 | **显式 block 关联**：stale/missing/unavailable 分类；索引 block 与纯 source block 的不同版本依赖 | C1、Q4、R3 |
| C4 | **缓存故障与跨版本集成**：同 snapshot 不同 index、锁超时、损坏、淘汰、无 cache/有 cache 合同一致性 | C2、C3 |

### 并行方式

- C1 在 M1 的合同确定后即可启动，不需要等 M3。
- C2 与 C3 满足各自依赖后并行。
- C4 负责跨模块场景，C1–C3 仍须各自带单元测试，不能把所有测试留给 C4。
- cache 包拥有锁、持久化确认、记录读取分类与淘汰；本包包装层拥有查询边界校验和业务错误映射，不另写缓存扫描器。

### 退出条件

- 未确认写入，不返回 blockId。
- 显式引用能够区分 stale-block、not-found、cache-unavailable。
- 内部缓存失败不导致无 cache 可完成的查询失败。
- 同 snapshot 不同 index 的旧索引 block 被拒绝。
- 纯 source block 不因无关 index 改变而 stale。
- 模型看到的查询事实不因缓存是否启用而改变；可选持久化引用可以不同。

### 非目标

- 跨快照页面复用。
- dependencyHashes 大规模去冗余迁移。
- 直接 source 查询结果缓存的收益优化。
- 新的多进程缓存框架。

## 6. M5：真实仓工程验收与正式发布

### 目标

不继续扩功能，只验证、修复和发布。

### Task

| ID | 内容与交付物 | 启动条件 |
| --- | --- | --- |
| E1 | **Corpus 与独立 gold**：固定真实仓 commit、人工或独立核验样例、可复现准备脚本 | M1 即可开始 |
| E2 | **真实仓 runner 与编辑 smoke**：检索/source/编辑/refresh、定位结果、首次构建耗时 | M2 接入查询，M3 补 refresh |
| E3 | **发布兼容与文档收敛**：依赖版本、包入口、工具注册、旧合同失效、README、设计引用收敛 | beta 阶段完成，可提前准备 |
| E4 | **工程验收报告**：汇总合同测试与真实仓结果，记录限制、已知问题、收益状态 | M4、E1–E3 |

### 退出条件

- 设计约定的 P0 合同通过测试。
- 至少一个真实仓的独立 gold 和编辑刷新 smoke 可复现。
- 包入口、工具说明与实际导出一致。
- 不再宣称未接入的 LSP 能力，README 重复安装说明已清理。
- 报告明确区分工程状态与收益状态；没有收益评测时不宣称成本改善。

Baseline/C pilot 可以独立并行推进，不作为 `0.3.0` 工程发布 gate。A/B 消融、多仓确认及真实 Agent 评测遵循设计文档的证据要求，不隐式加入本轮工程任务。

## 7. 整体并行依赖

```text
F1 合同基线
 ├─ F2 宿主错误桥接 ─────────────────────────┐
 ├─ F3 有界读取 ──┬─ Q4 Source / 预算 ──────┤
 ├─ F4 AST 提取 ──┴─ F5 构建 / 索引         │
 │                    ├─ Q1 公共查询机制     │
 │                    │   ├─ Q2 Repo/Symbol ┤
 │                    │   └─ Q3 Relation ───┤
 │                    │                    └─ Q5 查询工具集成
 │                    └─ R1 Session/lease       │
 │                         └─ R2 Refresh ───────┴─ R3 → R4
 │
 └─ C1 Cache 合同
      ├─ C2 查询缓存 ← Q1/Q2/Q3
      └─ C3 Block 关联 ← Q4/R3
           └─ C4 故障与版本集成（同时依赖 C2）

E1 Corpus/gold：从第一阶段持续并行
E2 Runner：随 Q5、R3 逐步接入
E3/E4：最终收敛与发布
```

图为主要依赖示意，完整依赖以各 Task 表为准。满足接口依赖可以开始开发；满足真实实现与验收依赖才能标记完成。

四条主要工作线：

1. **事实构建线**：reader → extractor → index。
2. **查询与源码线**：query → source → tools。
3. **生命周期线**：session → refresh → 并发集成。
4. **依赖与验证线**：宿主/cache 升级、corpus/gold。

并行任务数由这些职责边界决定，不按工具数量机械分配开发者，也不要求同一工作线必须由同一个人串行执行。

## 8. Task 执行约定

### 8.1 Task 卡模板

下发执行前，每个 Task 至少补齐：

```text
ID / 所属里程碑
目标与非目标
前置依赖：具体到接口或 Task
交付物：模块、类型、工具行为
修改范围与唯一负责人
验收场景
测试方式 / 所需注入点
下游消费者
```

本拆解包含 22 个主 Task：F1–F5、Q1–Q5、R1–R4、C1–C4、E1–E4。若执行中需要拆 PR，保留主 Task 的完整验收，不将每个函数或错误码另立任务。

### 8.2 实现与本模块测试属于同一个 Task

不拆成“开发所有功能”和“最后统一补测试”。仅跨模块、真实宿主、真实仓测试单独拆出；R4/C4/E2 不替代前置 Task 的自身测试。

并发测试复用设计约定的 verified reader、extractor 和提交前屏障，不依赖随机 sleep，不穷举工具 × 状态 × cache × refresh 全组合。

### 8.3 高频冲突文件设置一个集成负责人

重点包括：

- `src/types.ts`
- `src/tools.ts`
- `src/plugin.ts`
- `src/session-runtime.ts`
- 共享 parser / policy

其他 Task 提供模块接口，由负责人接入。必要时按职责拆文件，不让多个并行分支长期修改同一个大文件。内部模块可按本包需求拆分，不发布无消费者的通用框架。

### 8.4 按完整职责拆分

- “实现 Relation query”可作为一个 Task，不按 imports/exports 分别拆排序任务。
- Source 与预算若确需进一步拆分，按“范围解析/读取”和“Session 账本”拆，不按每种范围模式分别建立实现。
- 合同变更由 F1 负责人协调更新下游 Task，不允许各任务各自维护一套默认值、错误映射或归一化。

### 8.5 每个里程碑独立验收

查询正确性不依赖未来 cache 接入才能证明，reader 正确性不依赖真实 Agent 评测才能证明。使用稳定接口与最小 fixture 独立验证，最终通过真实集成检查接口之间的不变量。

## 9. 第一批启动建议

先将以下任务写成可执行 Task 卡：

- F1：最小合同基线。
- F2：宿主失败桥接。
- F3：有界扫描与读取。
- F4：AST 文件事实提取。
- E1：真实仓 corpus 与独立 gold。

F1 先交付各最小边界，F2/F3/F4 随对应接口确定逐步启动；E1 独立准备，不从被测 extractor 自动生成唯一 gold。C1 可在 cache 边界确定后提前启动，避免将跨包依赖拖到 M4。

暂不把 P1/P2 细拆成开发任务，以免将候选方向变成隐性的交付承诺。
