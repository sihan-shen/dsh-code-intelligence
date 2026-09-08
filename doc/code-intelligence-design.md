# DSH Code Intelligence 设计

> 面向 Coding Agent 的有界、结构化代码事实查询层。

`@han_05/dsh-code-intelligence` 的目标是帮助 Agent 更快定位相关代码，减少无效检索和不必要的源码输入，而不是强制用结构化结果替代源码阅读。

核心原则：

- 按检索意图选择 symbol、relationship、lexical 或 source；结构化查询是能力，不是强制通道。
- 区分事实、匹配方式与提取完整性，不把名称候选当成已解析关系。
- 路径边界、内容版本和输出上限是基础合同；成本策略不冒充访问授权。
- 先交付可用查询与可复现评测，再增加跨快照复用、多 Provider 合并和任务编排。

---

## 如何读本文档

| 层级 | 含义 | 权威来源 |
| --- | --- | --- |
| **V1 实现规范** | 当前 `0.2.1` 的行为 | 本包源码与 `dsh-context` / `dsh-context-cache` 类型 |
| **P0 目标合同** | 尚未实现的下一阶段设计 | 本文 §4–§7；实现时同步公共合同 |
| **P1+ 候选方向** | 需要实际使用和评测驱动的扩展 | 本文 §9 |

文档中的草案字段不是当前导出。README 与工具描述不得宣称未接入 runtime 的 LSP、关系查询或刷新能力。当前 README 的 LSP-backed tools 表述与重复 Install 段落属于待修正文档漂移，不作为能力依据。

P0 存在明确的跨包前置：`dsh-context` 公共 DTO / parser、宿主结构化业务失败的模型呈现（§5.6）、`dsh-context-cache` 的写入确认 / 显式读取分类 / 诊断（§6）。先验证这些依赖能履行合同，再并行实现查询与刷新；不能把接口缺口推迟到最终集成。

落地后公共 schema / parser 与合同测试持有输入默认值、错误码及边界行为的权威定义，排序实现与 fixture 持有算法细节；届时用引用替换本文重复细节，保留架构、不变量与阶段取舍，不长期维护多份独立规范。

本文替代此前的以下决策：固定检索梯度、P0 跨快照身份冻结、以 prior projection 作为源码访问许可、拒绝重叠窗口、仅删除分页元数据以实现局部缓存复用。它们不再是 P0 要求。

---

## 0. 现状与下一步

当前 Agent 能问：

```text
code_repo_map / context_repo_map
  → 当前 snapshot 的平铺文件页

code_symbol_query / context_symbol_query
  → 名称全等 / 前缀加分与 term 启发式打分的符号命中（非一般子串搜索）

context_expand_source
  → 从已缓存 projection block 展开 UTF-16 源码窗口
```

当前不能问：

- exact / qualified / kind 过滤；
- 模型可见的 imports / exports / contains / calls 查询；
- definition / references / callers / callees / implementations；
- 显式 snapshot refresh、增量刷新、分层 Repository View、Working Set。

P0 聚焦：

1. 保留 snapshot-local symbol identity，增加可直接使用的符号和关系查询；
2. 提供显式全量 refresh，使编辑后能够继续检索；
3. 统一 Agent 工具面，改善源码位置和有界读取；
4. 保留简单正确的 snapshot-scoped 查询缓存；
5. 用真实仓与公平 baseline 验证收益。

不以跨快照 `symbolKey`、多来源融合、Working Set 或 LSP 为前置条件。

---

## 1. 定位与边界

本包负责：

- 验证 workspace，构建文件 receipt 与不可变索引视图；
- 提取代码事实并记录来源、版本、解析程度与完整性；
- 提供有界 repo map、symbol、relationship 和 source 查询；
- 将结果封装为 `dsh-context` 可消费的 projection / block；
- 管理 session 内 snapshot、index、compiler 的生命周期与刷新。

本包不负责：

- 任务规划、用户指令、transcript 和验证状态；
- 全局模型上下文预算、task-level Working Set 与驱逐；
- 默认执行重命名、格式化或 Code Action 等写操作；
- Provider 认证、模型选择和任意仓库脚本执行。

公共 projection / block DTO 由 `dsh-context` 持有；内部 AST 数据结构不必全部上升为共享 IR。缓存持久化、缓存原子提交、锁和淘汰由 `dsh-context-cache` 持有；session 的 runtime 原子替换与调用引用释放由本包持有。

### 1.1 按意图检索

| 意图 | 合适的起点 |
| --- | --- |
| 已知声明名称 | symbol exact / prefix |
| 不确定名称、报错字符串、配置键、路由 | lexical / filename search |
| 查看已提取的结构关系 | relationship query |
| 理解行为、检查分支、修改函数 | source window |
| 需要语义定义或引用 | 支持相应能力的 type-checker / LSP（P1） |

P0 本包不实现 lexical provider；Agent 仍可使用宿主现有 grep / read 工具。不得在 prompt 中把这些工具描述为违规降级。

显式查询失败时返回真实状态，不偷偷改变该查询的含义。调用方可以选择下一种检索方式；更换检索方式不是编造事实。

---

## 2. 架构

```text
Workspace / Session
  → Snapshot receipts + verified source reads
  → AST extraction
  → snapshot-local Symbol / Relationship Index
  → bounded queries
  → Structured Projection
  → optional Context Block / Cache
  → Agent

Explicit refresh
  → verified reads → receipts + file-local facts
  → finalize snapshotId → assign symbolIds / connect endpoints
  → validate index → compute indexFingerprint
  → atomically replace active runtime
```

P0 主路径只有 TS/JS AST。Provider selector 可以是硬编码，不引入通用编排框架。

构建分两阶段：逐文件从同一份已验证文本生成 receipt 与文件局部事实（offset、临时节点 / 父子引用），不提前生成依赖 snapshotId 的最终 ID；全部 receipts 就绪后计算 snapshotId，再生成 symbolId、连接 contains endpoint、校验索引并计算 indexFingerprint。临时记录是本包内部结构，不新增公共 IR。每个文件解析后可释放文本 / AST，保留紧凑的局部事实，不为分配 ID 再读一次源码。

查询和索引不得依赖 TypeScript AST 节点类型；Provider 内部可用 `supports(file)` 与 `extract(verifiedText, metadata)` 形成简单边界，一次提取符号和关系后返回普通数据。P0 不发布通用四方法 Provider 协议，也不提前冻结多语言 kind 全集。项目级语义分析、嵌入语言与坐标映射待实际接入时验证接口。

Snapshot 是不可变的 receipt / index 视图，**不等于工作区文件系统被原子冻结，也不意味着保存了历史源码副本**。读取工作区源码时仍需核对 hash；扫描期间的并发编辑可能造成读取失败或不同文件采集时间不同。P0 不宣称事务级跨文件语义一致性。

---

## 3. V1 实现规范

本节保留现状，不将 P0 目标写成已实现行为。

### 3.1 Snapshot

```ts
type RepositorySnapshotV1 = {
  schemaVersion: 1
  snapshotId: string
  workspaceFingerprint: string
  revision: string
  files: readonly RepoFileSummaryV1[]
}

type RepoFileSummaryV1 = {
  readonly path: string
  readonly contentHash: string
  readonly byteLength: number
  readonly language: string
}
```

当前身份：

```text
snapshotId = sha256(canonicalJson({
  schemaVersion, workspaceFingerprint, revision, files, policyVersion
}))
workspaceFingerprint = sha256(deploymentRoot)
```

- 换目录即换 workspace identity，不能跨物理路径复用缓存；P0 接受此限制。
- `revision` 是元数据 / lookup hint；源码读取正确性仍需 content hash。由于 revision 也在当前身份公式内，其变化同样可能产生新 snapshotId。
- 文件路径为仓库相对 POSIX path，拒绝 absolute、traversal、NUL 和 symlink escape。
- 硬排除 `.git`、`.dsh`、`.dsh-context-cache`、`node_modules`、`upstream`、`.worktrees`、以 `.env` 开头的名字；私钥与二进制后缀由 `isIndexableFile` 跳过。
- ignore 使用 picomatch，不是 gitignore：不提供 gitignore 的重新纳入、顺序覆盖和目录斜杠语义。当前未禁用 picomatch 自身的否定匹配，`!keep.ts` 会匹配其他名字并将其排除；不能描述为“完全没有否定解释”。P0 修正规则见 §7.1。
- 文件数、目录数、单文件字节、总字节、ignore 字节与 pattern 数均有检查，但当前目录先收集全部 entry 再排序，文件 / ignore 内容也可能先完整读取再检查实际长度；这些不是读取过程的硬资源上限。P0 的过程边界见 §7.1。
- 稳定词法序扫描，不执行 Git hooks、仓库脚本或任意 shell。
- verified read 检查 containment、regular file、size、UTF-8、NUL 和 hash。
- V1 全量构建，不做 receipt diff 或增量刷新。

### 3.2 AST 与内部索引

Runtime 对 `.ts/.tsx/.js/.jsx/.mts/.cts/.mjs/.cjs` 做 TypeScript AST fallback。

`InternalSymbolEntryV1` 包含 `symbolId/path/sourceHash/start/end/kind/name/container/score`。

当前 identity：

```text
symbolId = sha256(canonicalJson([
  snapshotId, path, kind, name, start, end, container ?? null
]))
```

该 ID 是 snapshot-local 句柄，不承诺跨编辑稳定。P0 可沿用；若新增提取规则导致同一 snapshot 内碰撞，再以确定性 AST ordinal 消歧并升级相关合同，不为未来 rebase 预先替换它。

当前内部关系：

| kind | 挂载键 | target | 实际含义 |
| --- | --- | --- | --- |
| imports | `file:{path}` | 模块说明符 | 未解析 |
| exports | `file:{path}` | 导出名 / re-export 说明符 | 未解析 |
| contains | 父 symbolId | 子 name | 同文件结构，非 ID endpoint |
| calls | `file:{path}` | 标识符 / 属性名 | 文件级名字候选，非函数级 callee |

每键最多 256 条，按 `(kind, targetName, targetPath)` 去重。关系未进入模型可见投影；只有挂在 symbolId 上的 contains target name 作为弱排序特征，文件级 imports / exports / calls 不参与当前排序。

索引是不可变排序数组与按 path 分组，查询走 term 打分，不是可增量替换的图。

语法错误文件仍可能产出部分符号。V1 没有完整的 partial extraction 投影合同。

### 3.3 工具、分页与 cache

无 contextCompiler 时只注册 `code_repo_map` / `code_symbol_query`；提供该服务时再注册 `context_repo_map` / `context_symbol_query` / `context_expand_source`。没有 LSP 工具。

- `code_*` 使用当前 session snapshot；context 查询显式绑定 snapshot。
- 输入拒绝未知字段。
- 查询页 `limit ∈ [1, 50]`，query ≤ 256 UTF-8 bytes，cursor ≤ 1024 bytes。
- JSON 输出 ≤ 65,536 bytes，超限缩页；返回 `truncated/nextCursor`。
- cursor 绑定 kind、snapshotId、queryHash、offset、limit、policyVersion。
- cursor 的普通 SHA-256 digest 只能检测损坏，不是防伪认证。

Compiler 将 projection JSON 写入 Context Block 与 cache。命中仍验证 block kind、workspace、snapshot、adapter/version、policy、sources 与条目 path/hash。

当前 `dependencyHashes` 是全仓文件 hash，block.sources 与 snapshot 全量列表比较。在 snapshot-scoped 缓存内这较粗，但正确；P0 不以跨快照复用为理由破坏分页合同。

### 3.4 Source 与 Session

V1 source 输入：`blockId/path/sourceHash/startOffset/endOffset`，offset 为 UTF-16。

- path/hash 必须曾出现在对应 projection 页中；不绑定具体符号范围。
- symbol 位置为 1-based line / 0-based column，没有公开 offset 换算。
- 当前单 block 的 text 上限 65,536 bytes，source 账本累计上限 262,144 bytes；并非最终响应 JSON 的字节上限。工具传给 compiler 的账本 key 按 agent 对象区分，无 agent 时使用 rootCallId 或共享 key，同一 Session 的多个 agent 不保证共用账本。P0 将改为真正的 Session 统一账本及最终响应计费。
- 重叠窗口拒绝。

这些是当前机制，不代表 P0 应继续把 projection 当作源码许可证。

每个 live session 持有不可变的 snapshot + AST index + compiler。Workspace 经 registry 校验，释放 session 时关闭 compiler/cache，失败的 runtime 不留在 resolver 中。V1 没有显式 refresh 工具。

### 3.5 Experimental LSP

`ReadonlyLspAdapter` 存在但 session runtime 从不调用：

- 构造要求 `networkIsolation: 'enforced'`；
- 固定 argv，不接收 shell string；
- 白名单以 initialize / documentSymbol / shutdown 等为主；
- 对 snapshot 内 JS/TS 一次性 documentSymbol，relations 恒为空；
- 不常驻，不做按符号 lazy definition / references。

它不是生产 lazy enrichment，也不能仅凭 capability 字段宣称 OS isolation。P0 不接入主路径。

---

## 4. P0 事实模型

### 4.1 身份：只承诺单快照

- 查询返回 snapshotId 与 symbolId；关系 endpoint 使用该 snapshot 的 symbolId。
- symbolId 不提供跨 snapshot 认领能力。刷新产生新 snapshotId 后，旧句柄需重新查询。
- P0 不要求 `symbolKey`、重载折叠、匿名容器跨编辑稳定性或锚点确认协议。
- exact query 支持同名多结果，不把“名字相同”解释为同一实体。
- 函数重载可保留多个声明及各自位置；折叠展示不是身份正确性的前提。
- 即使 hash 外形相同，也只按所属 snapshot 与索引成员验证句柄，不从 hash 推断语义。

未来若引入 `symbolKey`，首先将其定义为 best-effort locator。名称、ordinal 或“偏移不超过 64 行”均不能证明跨编辑身份；不可作为安全自动认领条件。

### 4.2 最小 Symbol 投影

P0 在现有字段上增加查询必需信息，而非冻结一个覆盖未来语言的全量 IR：

```text
symbolId, path, sourceHash
name, kind, lexicalQualifiedName?, containerId?
startOffset, endOffset, start, end
provenanceId
```

- `lexicalQualifiedName` 是 AST 容器与名称形成的查询标签，不是语言级 FQN，也不是唯一键。点号、匿名作用域等歧义允许表现为多命中。
- kind 沿用当前可靠分类；未识别值为 unknown，可保留 provider 原分类。新增语言再验证公共分类需求。
- signature、visibility、modifier 等仅在有可靠提取与消费者需求时增加，不作为 P0 退出条件。

#### P0 声明覆盖与容器规则

P0 不沿用 V1「部分顶层声明仅在导出时入索引」的隐式限制。是否导出不影响下表支持声明的收录：

| 声明形态 | P0 收录规则 |
| --- | --- |
| 命名 function / class / interface / type alias / enum / namespace | 收录，包括非导出顶层声明和嵌套声明 |
| 变量声明、参数、类型参数 | 收录变量绑定；参数与类型参数暂不作为独立 symbol |
| 对象 / 数组解构变量声明 | 每个实际声明的标识符绑定一条；忽略空位，不将属性键当作绑定名 |
| 类 / interface 的命名方法、属性、访问器及 enum member | 收录可可靠取得字面名称的成员；重载与 get/set 可分别保留位置 |
| 箭头函数 / 函数表达式 / 类表达式 | 不额外合成 symbol；由变量绑定或命名属性承载可查询名称；其内部受支持的声明仍可收录 |
| 匿名 default function / class、动态 computed name、对象字面量普通成员 | P0 不生成合成名称，不作为独立 symbol |

绑定 symbol 的主体范围是其对应声明节点；解构绑定使用对应绑定元素范围。同范围多绑定仍以名称区分。静态字符串 / 数字成员名使用 AST 字面值；动态表达式不猜名称。P0 不保留 V1 的 CommonJS 赋值合成 symbol 规则；普通 JS 声明仍按此表收录。以后增加该规则时须同步覆盖表、provider policy 与 fixture。

`containerId` 指向最近的**已收录祖先声明**，不是任意语法作用域。contains 与 containerId 使用同一父子规则；未索引的匿名作用域不产生占位 endpoint，顶层 symbol 没有 containerId。lexicalQualifiedName 使用同一祖先链。变量绑定承载函数表达式时，表达式内部声明可归属于该绑定；该映射在文件局部事实阶段建立，不按名字猜测。

上述明确排除的声明形态是 Provider 的能力边界，不逐项标 partial；工具说明必须公开覆盖摘要并指出 complete 不代表所有语言声明均被索引。对承诺支持的形态发生容量截断、异常或无效事实时，按 §4.6 报告不完整。新增 kind 或覆盖规则同步 provider/config identity 和代表性 fixture，不冻结未来语言分类全集。

#### 名称事实与长度

输入长度、事实容量与展示摘要是不同限制，统一由共享 policy 持有。P0 symbol 的必需 name、relationship 的 name / specifier 各最多 4,096 UTF-8 bytes；超过时省略该 symbol 或整条边，文件标 partial / capacity-limit，不将前缀伪装成完整名称，也不沿用 V1 的 `.slice(0, 512)` 事实截断。省略 symbol 后，其后代按最终已收录祖先建立 containerId / contains，不保留悬空 endpoint。去重和身份计算只使用完整事实值。

可选 lexicalQualifiedName 同样最多 4,096 UTF-8 bytes，超长仅省略该查询标签，不使有效 symbol 消失或单独标 partial。查询 name 上限见 §5.2；更长的事实名称仍可通过短 prefix 命中后用 symbolId 直查。展示摘要可以有显式截断，但不参与名称匹配、关系去重或身份计算。单项连同其他必需字段仍超出输出预算时遵循 §5.6，不以截断事实来保证可输出。

### 4.3 位置与源码

- 内部 canonical 坐标使用 UTF-16 offset：start 含、end 不含。
- line 为 1-based，column 为 0-based UTF-16，由同一已验证文本与 line map 派生。
- 不分别维护两套可独立修改的位置；发现不一致属于 provider / contract 错误，不返回错误位置。
- 符号 location 表示声明主体。leading trivia / JSDoc 可作为可选 evidence range，不强制改变主体范围。
- 源码请求必须且只能选择一种模式：`offsetRange { startOffset, endOffset }`、`lineRange { startLine, endLine }` 或 `wholeFile: true`；不传范围不隐式读整文件。
- offsetRange 使用非负整数半开区间，允许 start=end 的空窗口，且 end 不超过文本 UTF-16 长度。lineRange 使用 1-based 整数闭区间，startLine ≤ endLine，包含末行的行终止符（若有）。line map 识别 CRLF（一个终止符）、LF、单独 CR、U+2028 与 U+2029；空文件有一行，末尾任一种换行产生空末行。symbol 位置、lineRange 和 padding 共用此 line map，不将 TypeScript 行号与另一套源码行号混用。
- 显式范围越界或端点拆分代理对时返回 invalid-query，不静默改写范围。line range 统一转换为 canonical offsets 后读取。
- `paddingLines` 是每侧附加的非负整数行数，默认 0、P0 上限 20，仅适用于 offsetRange / lineRange；wholeFile 禁止携带该字段。padding 为 0 时保持原窗口，正值时将窗口扩展到其触及行的完整行范围，再各加对应行数，遇文件边界截断。非空 offsetRange 的末行由 endOffset-1 确定，空窗口以起点所在行计算。
- UTF-8 bytes 只用于最终输出预算，不用作 padding 坐标。不得拆分代理对输出损坏文本。

### 4.4 最小 Relationship 投影

```text
snapshotId, type, source, target, provenanceId, resolution

endpoint:
  symbol { symbolId }
  file { path, sourceHash }
  unresolved { name?, specifier? } // 至少一个字段存在；映射规则见下表
```

P0 支持：

| type | source | target | resolution |
| --- | --- | --- | --- |
| contains | 父 symbol | 子 symbol | syntactic |
| imports | file | unresolved specifier | syntactic |
| exports | file | unresolved name / specifier | syntactic |
| calls | file | unresolved name | heuristic |

AST 遍历时保留父子节点引用，生成 ID 后直接连接 contains endpoint，不先降成 name 再全文件猜匹配。无法形成有效 endpoint 时省略该边，并在提取状态中反映不完整性。

#### P0 关系语法覆盖与 endpoint 映射

| 语法形态 | 摘要边与 unresolved target |
| --- | --- |
| 静态 `import ... from 'm'`、`import 'm'` | imports `{ specifier: 'm' }`；同模块不同绑定合并，不输出本地 alias |
| 文件顶层普通带 export modifier 的命名声明 | exports `{ name: 导出名 }`；支持的声明种类同 §4.2，导出解构变量按实际绑定分别产出 |
| `export default` 声明或表达式，包括匿名 function / class | exports `{ name: 'default' }`；不要求存在对应 symbol，也不额外导出命名 default 声明的本地名字 |
| `export { x as y }` / `export { x as y } from 'm'` | exports `{ name: 'y' }` / `{ name: 'y', specifier: 'm' }`；保留导出名与模块的关联，不声称解析了 x |
| `export * from 'm'` | exports `{ specifier: 'm' }`；不枚举目标模块名字，不合成 `name: '*'` |
| `export * as ns from 'm'` | exports `{ name: 'ns', specifier: 'm' }` |
| type-only 静态 import / export | 按上述相同摘要收录；不区分 type/value，不能据此推断运行时依赖 |
| contains | 使用 §4.2 最终已收录祖先规则；覆盖受支持的嵌套声明，不按名字猜 endpoint |
| 普通 / 可选 CallExpression，callee 为 identifier 或 property access | calls `{ name: 标识符或末级属性名 }`；private identifier 使用 AST 名称文本，省略 receiver 与调用位置 |
| 动态 import、直接 `require(...)`、import-equals、`export =`、CommonJS 导出赋值 | P0 不提取对应 imports / exports；动态 import 与直接 require 调用也不作为 calls 输出 |
| NewExpression、tagged template、element access 或其他复杂 callee | P0 不提取 calls，不猜测被调用名称 |

imports / exports 仅收录直接属于 SourceFile 的静态语句 / 声明；namespace / ambient module 内部的 import / export 不冒充文件自身的导入导出，P0 不提取这些局部模块边。calls 仍遍历文件内受限 AST 范围。静态说明符和字面名称使用 AST 解码后的完整值，不做路径解析、大小写 / Unicode 归一化。未用的 endpoint 字段必须省略；模块-only target 只有 specifier，名字-only target 只有 name，re-export 可同时有二者。空字面值可以保留，字段存在性不等于字符串非空；语法诊断仍按 §4.6 标 partial。此摘要不保留本地 alias、type/value 或调用次数，不承诺重建全部语法。

明确排除的形态属于能力边界，不逐项标 partial；承诺覆盖的形态因异常、容量或无效事实丢失时才传播不完整状态。complete 仅表示完成此覆盖表，而非完整模块依赖图或 call graph。工具描述提供覆盖摘要，规则与代表性 fixture 一起版本化。

calls 仅表示文件内候选，不提供函数级 callers / callees。P0 不预留 tested-by 等无 Provider 产出的关系。

P0 不要求关系 ID，摘要边的去重、排序和分页单位统一见 §5.3；调用位置 evidence 不属于 P0 输出。未来若增加记录 ID 或 evidence，应一起版本化，不承诺跨 Provider 或跨编辑稳定。

### 4.5 来源、解析程度、匹配与完整性

这些维度分开：

| 维度 | 回答的问题 | P0 表达 |
| --- | --- | --- |
| provenance | 谁、以哪个版本提取 | 投影头来源表 + provenanceId |
| resolution | 关系是否语义解析 | syntactic / heuristic；resolved 留待语义 Provider |
| match | 为什么命中此查询 | exact / prefix / fuzzy，及确定性排序 |
| extraction status | 提取是否完整 | 文件级 complete / partial / unsupported / failed，有界诊断与原因摘要 |

fuzzy 找到的 AST 声明仍是 AST 声明，不因匹配模糊而降低事实可靠度。文件有语法诊断时标 partial，不一律否定其中所有声明。内部容量截断也必须反映为 partial，不能仅用分页 truncated 掩盖索引本身不完整。

来源表至少绑定 providerId/version、提取配置版本、TypeScript 版本及 snapshot。每条事实已有 path/hash，不再为每条复制全仓 hash。

P0 只有一个 AST Provider，不做字段级合并、最高 confidence 聚合、modifiers 并集或 merge-conflict 协议。不同 Provider 的实体对齐与冲突策略待真实第二来源接入后另行设计。

### 4.6 提取状态的粒度与传播

P0 只维护文件级状态与有界原因集合，不要求对 symbols、imports、exports、contains、calls 分别维护状态机，也不在每个 symbol / relationship 上复制 `extractionStatus`。文件 partial 不意味着每条已返回事实无效；complete 只表示按当前规则完成提取，不保证语言语义分析完备。只有实际消费者需要区分各类事实覆盖时，才扩展集合级状态。

| 场景 | 文件状态 | 输出规则 |
| --- | --- | --- |
| 提取成功且没有已知遗漏 | complete | 返回已提取事实 |
| 存在语法诊断，但 AST 可用 | partial，记录 diagnosticsCount | 保留位置和 endpoint 可验证的事实，不声称精确定位了诊断影响 |
| 某类事实达到提取容量上限 | partial，reason 为 capacity-limit | 已返回事实仍可用；不得把内部截断只标成分页 truncated |
| 单文件 AST 提取异常，无法形成有效结果 | 文件 failed，reason 为 extraction-failed | 丢弃该文件本轮事实；其他文件可用，snapshot 提取汇总标为不完整 |
| 文件没有对应语言 / 事实能力 | unsupported | 不解释为零声明或零关系 |
| 个别事实的位置或 endpoint 无法验证 | partial，reason 为 invalid-fact | 省略无效事实，不输出悬空关系 |

失败级别按可隔离边界决定，不按异常数量猜测：可确定来源文件且可独立删除的位置 / endpoint 无效事实，省略并标该文件 partial；单文件提取异常且无法保留可靠结果时，丢弃该文件事实并标 failed。顶层输出 schema 损坏、事实无法归属文件、最终身份碰撞或全局索引不变量破坏属于整体合同错误，返回 provider-failed，构建阶段则 refresh-failed，不发布候选索引。局部校验后必须再次验证全局 endpoint 与身份不变量；不能通过吞掉任意异常将整体损坏降为 partial。

覆盖范围分为三个集合，不将扫描覆盖与提取完整性混为一谈：

- Scan Universe：snapshot policy 所界定的扫描范围；实际收录文件以 receipts 为准，扫描中观察到的排除 / 跳过计数由 scanCoverage 单独报告，不假设已枚举被剪枝目录内的文件。
- Provider Universe：receipts 中按当前 provider/config 的静态能力规则 `supports(file)` 承诺提取的文件。P0 为支持扩展名的 TS/JS 文件；该集合在提取前确定，解析异常、容量截断或 failed 不得使文件退出此集合。
- Query Coverage：查询文件作用域与 Provider Universe 的交集。它表示当前 Provider 承诺覆盖的范围，不表示全仓语言覆盖。

README / JSON 等已收录但不受 AST Provider 支持的文本可保留文件级 unsupported 状态，但不进入 TS/JS 查询的完整性分母；它们也不因此成为扫描 unsupported-format。扫描层的格式跳过、策略排除和容量跳过仍只由 scanCoverage 表达。

查询成功响应在 `extraction` 元数据中分开携带：

- 查询作用域汇总及有界问题文件详情：跨文件 symbol 查询先按 snapshot 文件集合与 pathPrefix 确定作用域，再与 Provider Universe 取交集；name/kind 只过滤已提取事实，不能从覆盖集合排除可能含遗漏命中的 partial / failed 文件。汇总提供 scopeFileCount、eligibleFileCount、unsupportedFileCount 及覆盖集合内 complete / partial / failed 计数，前三者满足 scopeFileCount = eligibleFileCount + unsupportedFileCount。unsupportedFileCount 不使汇总降为 partial。repo map 的文件页仍包含其范围内所有 receipts，仅 AST 派生信息按上述交集汇总，不把 unsupported 文件的 symbol 数量解释为零。不能只按命中页统计覆盖。详情截断单独标明，不改变结果分页的 truncated。
- 当 eligibleFileCount > 0 时，覆盖集合全 complete 才汇总为 complete，否则为 partial（具体 failed 数量另报）；eligibleFileCount = 0 且 scopeFileCount > 0 时汇总为 unsupported；scopeFileCount = 0 时汇总为 complete 并返回零计数，明确表示空作用域，不是全仓没有符号。单文件关系查询直接报告该文件状态，故非 TS/JS 文件仍可返回 unsupported；直接 symbolId 查询报告其来源文件。
- `resultFiles`：仅列出本页命中事实的 **非 complete** 提取源文件，按 path/sourceHash 关联，包含文件状态及有界原因。symbol 用自身 path/hash 关联；relationship 用 source 的 file endpoint 或 source symbol 所属文件关联，不把 target 文件状态误当成该边的提取状态。对本页提取来源，未列出表示 complete；此约定不适用于任意页外文件。全部命中来源 complete 时可省略此表。

`resultFiles` 不得遗漏本页非 complete 来源，也不得随问题详情列表截断；与事实一起计入字节预算，放不下时缩小结果页。它不复制全仓状态，也不在每条事实上增加 status。文件 partial 仅提示可能遗漏事实，不表示命中的声明一定错误。状态来自索引构建记录，不要求每页重新解析文件。

策略排除、二进制格式跳过属于扫描覆盖信息，见 §7.1，不映射成每条事实的 partial。

---

## 5. P0 工具与刷新合同

以下是目标工具面，不是当前已导出 schema。公共 DTO / parser / policy 的版本变更需同步 `dsh-context`。

### 5.1 单一 Agent 工具面

默认仅暴露一套工具：

```text
context_repo_map
context_symbol_query
context_relation_query
context_expand_source
context_refresh_snapshot
```

前四支是查询，refresh 是显式重建派生数据，不修改仓库源码。`code_*` 可保留为内部无 block 包装，但不与同义 context 工具同时暴露给 Agent。

`context_repo_map` 的 snapshotId 可省略：省略时捕获当前 active runtime，显式提供时验证版本。它同时是首次发现和重新获取当前版本的入口，不为发现版本执行 refresh。其他索引查询与 source 必须显式提交 snapshotId；refresh 无需提交 snapshotId。所有成功响应提供所用 snapshotId，stale-snapshot 的有界 details 提供 currentSnapshotId；该值只是错误检查时的版本，后续并发 refresh 仍可能使其失效。宿主可在初始化时注入当前版本，但不能以此代替工具发现路径。

#### Repo map：分页发现与具体文件查找

`context_repo_map` 接受两种互斥分支，二者的 snapshotId 均可省略：

- 文件页：不传 path，接受 limit / cursor，按 canonical path 词法序列出 receipts；默认值见 §5.2，P0 不增加目录分层或其他过滤。
- 具体文件：传 canonical 相对 `path`，与 cursor 和显式 limit 互斥，不补分页默认字段；返回相同 items 页结构中的一条 receipt（至少含 path/sourceHash），`truncated: false`，无 nextCursor。合法 path 不在 receipts 中返回 not-found。此分支只查询捕获的 snapshot，不读文件系统，也不通过当前文件是否存在来改变旧 receipt 事实。

具体文件查找支持全部 receipts，包括 JSON、README、无 symbol 或无关系文件，extraction 作用域仅为该文件，unsupported 不阻止返回 receipt。两个分支均遵守 §6 的索引版本边界。已知路径的标准闭环是 `repo_map({ path }) → snapshotId/path/sourceHash → expand_source`；编辑后先 refresh，再按路径取新 receipt，不必遍历全仓文件页。

无 cache 宿主使用相同公开工具和 projection 数据合同。责任分为三层：查询核心生成已验证 projection；可选 compiler/cache 包装负责持久化和 block 关联；工具适配器负责宿主 envelope、最终序列化与一次预算扣费。runtime 的 compiler/cache 包装可缺省，不再以成功打开 cache 为查询前置。未显式引用 blockId 时，无 cache 或可恢复的缓存读写失败返回相同 projection，省略可选 blockId / 持久化引用，不伪造可解析的 block；其他字段语义不变。显式引用不能验证时按 §6 分类返回错误，不静默忽略该输入。只有成功持久化后才返回 blockId，其可解析期受 session 和缓存淘汰约束，不承诺长期存在。显式引用缺失 block 仍返回 not-found；省略 blockId 的直接源码读取不受影响。源码缓存不得绕过 verified read 或预算检查。P0 不以直接 source 查询结果缓存为交付要求；可以仅在兼容 block 消费者需要时生成纯 source block。可选缓存接入必须满足 §6 的写入确认、显式读取分类与降级诊断，不能以未抛错等同于已持久化。

### 5.2 Symbol query

- name 模式为 exact / prefix / fuzzy；提供 name 时默认 exact，未知名称仍可显式 fuzzy 或使用宿主 lexical search。
- exact 匹配 name 或 lexicalQualifiedName，不把路径子串作为名称命中。
- 可选 kind、path prefix 过滤。path prefix 的输入和匹配规则见下文，不使用任意字符串前缀匹配。
- 接受当前 snapshot 的 symbolId 直接查条目；该方式与 name、mode、kind、pathPrefix、cursor 及显式 limit 互斥，返回统一页结构中的单条结果，不分页。
- exact/prefix 按 `(path, startOffset, symbolId)` 排序；fuzzy 按 `(score desc, path, startOffset, symbolId)` 排序。
- 数组顺序是排序权威；不强制冗余 rank 字段。
- 普通集合查询无命中返回成功空页；按具体 symbolId 查询且句柄不属于当前索引时返回 stale-symbol-id。

P0 不提供跨快照 key re-resolve。刷新后调用方按已知名称、路径或重新检索选择当前声明。

#### 输入默认值与互斥

- 集合查询必须提供非空白 name，最多 256 UTF-8 bytes；不支持省略 name 的全符号枚举。仅 mode / kind / pathPrefix 不构成有效查询。所有查询的 cursor 输入最多 1,024 UTF-8 bytes；超长输入返回 invalid-query，而合法长度内损坏的编码按 §5.6 返回 invalid-cursor。
- 集合查询的 mode 默认 exact，limit 默认 20，允许 1–50；repo map 文件页与 relation 查询使用同一 limit 默认值和范围。symbolId 与 repo map path 直查不补互斥的分页默认字段。
- kind 为单个分类字符串，合法集合由共享 schema 与 P0 提取 policy 明确列出，未知值返回 invalid-query；过滤无结果返回成功空页。
- exact 与 prefix 均匹配 name 或可用的 lexicalQualifiedName；同一 symbol 命中两个标签只返回一次。
- 除 repo map 的 snapshotId 可省略外，版本输入遵循 §5.1。relation 的 from 必须且只能含 symbolId 或 path；path 是 snapshot 内具体文件的 canonical 相对路径，不接受目录前缀。
- parser 先判定查询分支，再补该分支默认值；非法组合不通过忽略字段来兼容。

#### 默认匹配规则

- `pathPrefix` 是仓库相对 POSIX 目录前缀：省略或空字符串表示全仓；允许多级目录及一个可选末尾 `/`，canonical 形式不含末尾 `/`。拒绝 absolute、反斜杠、NUL、空中间段、`.` 和 `..`，不通过路径归一化接受 traversal。匹配 `prefix === '' || path.startsWith(prefix + '/')`；它不是单文件 exact filter。按 snapshot 路径字符串大小写敏感比较，不随宿主文件系统改变语义，也不做 Unicode 或空白归一化。
- `lexicalQualifiedName` 用已命名祖先容器与声明 name 按外到内以 `.` 拼接，例如 `Namespace.Class.method`；匿名容器不合成稳定名字，省略其命名段，因此允许多命中。源码名称含点时不进行语义消歧。取 AST 提取器实际支持的容器，不承诺涵盖所有语言作用域。标签过长时省略可选 qualified 字段，缺省即表示该标签不可用，不另增状态字段，也不截成另一个可精确匹配的名字；相关长度 / AST 遍历资源限制由提取 policy 定义，不静默裁掉祖先层级。
- exact / prefix 使用大小写敏感的原始名称，不 trim、不改写 Unicode。fuzzy 是显式候选模式，P0 默认沿用 `src/projections.ts` 的 term 打分而非引入编辑距离：在小写字母或数字到大写字母的边界拆词，再按非 Unicode 字母 / 数字拆分并转小写；查询 term 保留重复次数。name 与 trim 后转小写的 query 全等加 1000，前缀命中加 500；每个 query term 命中 name/path/contains target-name 的 term 集合分别加 100/40/20，分数累加，仅保留 score > 0。fuzzy 的 path 弱特征不改变 exact / prefix 的名称语义。
- 过滤先于排序和分页；fuzzy 保留当前拆词对大小写边界的影响，不把原 query 全部转小写后再拆词。空白查询或 fuzzy 无任何有效 term 时返回 invalid-query，不把空串前缀视为全仓命中。
- 上述是 P0 参考算法而非永久排序 ABI；相同 snapshot、index、query、policy 下排序必须确定。实现需以固定查询 / 排序 fixture 验证，改变规则需更新 compiler / query policy 并使旧 cursor 与缓存失效。工具说明注明结果按当前策略排序，名次不是身份或语义置信度；调用方可以用它决定检查顺序，但不能把第一名当作正确性保证。工具 schema 写清输入规则，完整算法保留在实现与测试，不塞入冗长工具描述。

### 5.3 Relation query

```text
input:
  snapshotId
  from: { symbolId } | { path }
  types?, limit?, cursor?

output:
  relationships, provenance, extraction status, truncated, nextCursor?
```

- from.symbolId 查询 contains；from.path 查询 imports / exports / calls。
- 只返回真实提取的正向边，未知 type 返回 invalid-query；已知 type 是过滤条件，即使当前 from 不产出此类边也不拒绝整个请求，无匹配即为空。不能据此将未实现的语义能力宣称为已支持。
- 缺省 types 为 P0 四种合法类型；显式空数组匹配零条。工具说明列出各类 source 实际产出的边，不要求调用方先掌握组合矩阵。
- 无边是成功空页，但必须保留 relevant extraction status，区分“完整提取后没有边”和“未支持 / 部分提取”。
- 调用候选不能标成 resolved callee，未解析 import 不伪装成模块依赖图。
- P0 关系以去重后的摘要边为分页单位：按 type 与完整 source/target endpoint 去重，不输出调用位置 evidence 列表；symbol / file 的来源信息仍可用于源码核验。输入类型集合先过滤，再按 `(type, canonicalJson(source), canonicalJson(target))` 的大小写敏感词法序排序，最后分页。相同摘要边多次出现不影响页成员。未来增加 evidence 时另行定义有界证据集合及分页语义并升级 policy，不静默丢弃承诺返回的位置证据。

P0 有意不提供通用反向关系查询。已知子 symbol 可通过可选 containerId 查看直接父容器，不必为此建设反向图。查“可能导入 / 调用某名称的文件”可使用宿主 lexical 搜索缩小范围，再查正向关系与源码核验；它仅提供候选，不等价于 find usages / callers。不同文件的 import specifier 可指向同一模块，相同名字也可指向不同符号，不能把字符串反转索引冒充 resolved 反向导航。

### 5.4 Source query：版本验证，不是 projection 授权

P0 源码读取直接绑定 `snapshotId/path/sourceHash` 与有界范围。先捕获 runtime 并校验请求 snapshotId，再验证路径访问策略及 receipt 成员关系：path 必须属于该 snapshot，sourceHash 必须等于该 receipt.contentHash，实际 verified read 的 hash 也必须等于该 receipt.contentHash。合法但未被 snapshot 收录的 path 返回 not-found；请求 hash 与 receipt 不符、或实际内容 hash 与 receipt 不符均返回 stale-source，以有界 reason 区分 receipt-hash-mismatch / content-hash-mismatch。snapshot 外新建文件不能仅凭调用方提供的正确 hash 被归入旧 snapshot；receipt 存在但当前文件已消失时返回 stale-source，reason 为 current-file-missing；读取过程中发生删除或可确认的版本变化也返回 stale-source。not-found 在路径查询中仅表示合法 path 不属于请求 snapshot 的 receipts，不用于已收录文件的当前版本缺失。权限 / containment 错误仍返回 access-denied，其他无法归类的 I/O 异常走宿主内部错误通道，不一律推断为版本变化，绝不返回部分文本。

`blockId` 是仅为现有消费者保留的可选证据关联，不作为访问许可证；若显式提供，确认缺失 / 损坏时返回 not-found，版本 / path/hash 关联不一致时返回 stale-block，存储不可用而无法验证时返回 cache-unavailable；无 cache 配置下显式 blockId 同样返回 cache-unavailable，不伪装为确认缺失；若引用的是索引派生 block，还必须按 §6 验证 indexFingerprint，不因请求仅用于源码关联而跳过该检查。无 block 的直接请求是推荐主路径，不新增 block 访问许可状态。

安全许可来自 workspace、path 与文件排除策略。content hash 保证读取对应版本。source window、整文件读取与 session budget 属于成本策略：

- 窗口、whole-file 和 padding 的输入语义统一见 §4.3；工具建议优先使用有界窗口，整文件必须显式请求。
- 任一源码模式无法在单次输出上限或剩余 session 预算内完整返回时，统一返回 budget-exceeded，不返回部分源码、不偷偷改写范围。message 提示缩小显式范围；有界 details 给出实际触发的限制及可确定的字节值（例如 requestedOutputBytes、maxOutputBytes 或 remainingSessionBytes）。不要求生成任务相关的推荐范围。
- 允许重叠窗口与重试，不维护 `(blockId, path)` 的累计访问许可。
- P0 将预算归属改为真实 Session：同一 Session 的全部 agent / root call 共用一个账本，不沿用 V1 的 agent-key 分账。账本独立于可替换 runtime / compiler；refresh 不清零，session 释放才丢弃。默认 source 成功响应累计上限沿用 262,144 bytes，可由宿主配置关闭；单次输出上限仍生效。
- 计费单位统一为工具适配器序列化后的成功响应数据 UTF-8 字节（含源码与本包元数据，不含宿主传输 framing），重复输出与 cache hit 同样计费。它衡量工具输出成本，不是唯一源码披露量或全局模型 token 成本。
- 返回成功前对最终字节数执行原子的余额检查与扣减，并发请求不得各自读取旧余额后超额输出；只有检查通过才提交成功响应。校验、序列化或预算检查失败不扣费，错误响应不计入此 source 成功响应账本；成功交付宿主后不因客户端取消而追踪退款。无需跨进程配额或复杂预留状态机。
- 预算耗尽返回 budget-exceeded，不描述为越权。全局模型输入预算仍由 Orchestrator 管理。
- 读取发现 hash 不匹配返回 stale-source，并提示 refresh，不返回未经验证的部分文本。

默认字节上限可沿用 V1，但新的范围模式、padding、预算与响应行为必须通过工具 schema 和测试确定，不散落为多个互相矛盾的限制。

### 5.5 显式全量 refresh

P0 必须支持编辑后的继续检索，不要求增量实现：

1. `context_refresh_snapshot` 使用已注册 workspace；不接受任意新的仓库根路径。
2. 构建新的 snapshot + AST index + compiler runtime，构建期间不发布半成品。
3. 完成后原子替换 active runtime，返回 snapshotId、changed 标志与提取状态。`changed` 精确定义为本次成功提交的 snapshotId 与构建开始时 active snapshotId 不同；构建开始时没有 active runtime 则为 true。文件集合 / hash、revision 等身份输入变化均可能使其为 true，不仅指源码内容变化。
4. 相同内容及身份输入未变化时允许返回同一 snapshotId，changed 为 false；它只表示 snapshot 身份未变，不保证提取状态与索引字节未变。提取配置或完整性变化仍可替换 index，缓存隔离见 §6。
5. 新 snapshotId 生效后，新请求使用旧 snapshot/block/cursor/symbol 句柄时返回相应 stale 状态，不自动认领同名声明。
6. 已开始且未取消的查询固定在所捕获 runtime 上完成；索引查询输出 snapshotId 和只读 indexFingerprint，refresh 成功也返回两者。旧 runtime 资源在该批请求结束后释放，session 预算账本不随之释放。不同 snapshot 的事实不得冒充同一源码版本；同 snapshot 不同 index 的声明证据可以并存，但旧完整性、计数和无命中结论不能当作当前索引结论。
7. 构建失败保留旧 runtime 并明确报告 refresh-failed。旧索引只是旧版本事实，不证明工作区仍与之相同；源码读取仍校验 hash。
8. 同 session refresh 按接收顺序逐个采集 / 提交，不合并请求，不让较早构建覆盖较晚构建；请求不能由其到达前已经开始的采集满足。队列沿用宿主有界并发限制及过载 / 取消通道；若宿主不提供有界队列，适配器必须设置有限队列上限并使用宿主过载通道拒绝超额调用。失败请求结束后后续请求仍可继续。
9. refresh 期间，查询立即捕获当时 active runtime，不等待新构建；没有 active runtime 时按下文初始化规则等待，不观察候选 runtime。

snapshotId 表示文件 receipt 版本，indexFingerprint 表示实际提取结果版本；后者仅作响应来源与内部 cache/cursor 边界，不要求 Agent 在普通查询中提交。`changed` 只比较 snapshotId，不比较 indexFingerprint。P0 不要求 changedFiles，也不承诺 changed=false 时所有派生数据完全相同。调用方可持有自己编辑的路径并定向重查，无需全仓重新搜索；但新 snapshot 下旧 symbolId 仍失效。文件 diff 不属于 P0，候选方向见 §9.1。

#### 关闭、取消与资源归属

Session 的基本生命周期为 idle / initializing / active / closing / closed。idle 表示已创建 session 所属状态但尚无 runtime；初始化失败回到 idle，不缓存失败 Promise，也不后台无限重试。refresh 在 active 中是串行构建任务，不改变查询可用状态。预算账本和 active 指针属于 session；候选 runtime 在提交前属于构建任务。

| 起始状态 / 事件 | 转移与归属 |
| --- | --- |
| idle 收到普通查询 | 发起一次 session 拥有的共享初始化，进入 initializing；并发查询只等待该任务 |
| initializing 成功 / 失败 | 成功进入 active；失败在清理候选后回到 idle，现有等待者收到本次失败，不在同一次调用内无限重启；后续新调用可以重试 |
| 初始化等待者取消 / timeout | 仅移除该等待者，不取消其他请求共享的 session 初始化；共享任务使用 session signal 与单独配置的协作式构建 deadline，而非首个请求的 signal / deadline |
| idle 收到队首 refresh | 进入 initializing，由该请求自己采集并建立首个 runtime，成功 changed=true；任务受该 refresh 与 session 的取消约束，普通查询可等待它，失败 / 取消清理后回到 idle |
| initializing 期间收到 refresh | 进入有界串行队列；当前构建清理 / 提交后再进行该 refresh 自己的采集，不能用到达前已开始的初始化满足它；前一次失败不阻止队列继续 |
| active 收到 refresh | 保持 active，按序构建 / 提交；失败保留旧 runtime |
| 任意未关闭状态收到 release | 进入 closing，停止接收任务，取消 session 拥有的初始化及活动请求，清理完成后 closed；该 Session 不再被 resolver 重新创建 |

初次构建使用与 refresh 相同的读取、校验、重试与清理原语，但不新增初始化工具。可预期的初次构建失败也使用 refresh-failed，details 标明 `phase: initialization`；workspace 授权错误、取消、timeout 等保留各自通道。session 初始化需要独立构建 deadline / 取消控制；宿主若没有此能力，由本包设置有界配置并接入 session release，不假定首个工具请求 timeout 会自动管理共享任务。没有等待者时 session 初始化仍可完成并发布，直到其自身 deadline 或 session 关闭；这不是被取消的 refresh 迟到提交。

- 进入 closing 后拒绝新调用、终止排队 refresh，并禁止首次初始化或候选 refresh 再发布。释放与提交的状态检查在同一同步临界段完成，不能在检查与替换之间 await。
- 查询在取得已发布 runtime 时获取 lease，并在 finally 释放；初始化等待者尚无 runtime lease，取消时只释放自己的等待关联。已获取 lease 的取消请求走同一释放路径。旧 runtime 只在退出 active 且 lease 清零后关闭。session 关闭请求取消活动任务并等待其清理，不提前关闭仍在使用的资源。
- 取消 / timeout 的提交截止点是 active 指针替换前的最后一次状态与 signal 检查：此前已观察到取消则不提交；提交之后取消不回滚已发布版本。调用方未收到响应时可用 repo map 重新发现当前版本。
- 未提交候选在构建失败、取消或 session 关闭后由构建任务清理；清理失败记录运行日志，不掩盖原始错误。提交后旧 runtime 清理失败同样单独记录，不将已提交 refresh 改报为 refresh-failed，也不重新发布旧 runtime。
- abort、timeout、session-closed 和队列过载沿用宿主控制流 / 错误通道，不伪装成业务查询空页或 Provider 失败。公共错误码表只定义本包业务失败。

取消是协作式的：在文件读取 / 提取之间、分阶段校验及提交前检查 signal；AST 遍历设置有限节点数与深度上限，达到限制标该文件 partial / capacity-limit。TypeScript 单次同步 parse 不能被普通 Promise timeout 或 AbortSignal 硬中断；P0 不承诺单次解析或整个构建的硬墙钟截止。宿主 timeout 必须同时通知本包取消，不能仅停止等待；适配器在每个检查点同时检查 signal 与已知 deadline。已运行的同步工作须结束并在下一检查点停止，不能迟到发布。若实测需要可强制终止的解析 deadline，再引入 worker，而不是现在建设通用进程框架。

#### 构建期间的文件变化与失败

- 因已定义策略排除、格式不支持或单文件过大（file-too-large）而跳过文件，是正常扫描结果，记录有界覆盖摘要；不将其作为 AST 提取失败。文件数、目录数、枚举 entry 数、全仓总字节、ignore 字节 / pattern 上限耗尽均为整体构建失败，不能以正常跳过后继续发布来绕过。计数与读取过程上限见 §7.1。
- 优先从同一次已验证读取的文本生成 receipt hash 与 AST，可逐文件读取 / 提取，不必同时驻留全仓源码。若分次读取，后一次必须核对 receipt hash。文件采集完成后发生的新编辑不要求本次构建追赶；发布结果属于已采集版本，后续 source read 仍需核对当前内容。
- 对明确的读取竞争（文件在读取期间消失或版本不匹配），P0 允许在同一 refresh 内最多重试一次全量采集与构建，第一次候选结果整体丢弃；宿主 timeout 的取消语义按上文协作式边界执行，不保证中断正在进行的同步解析。第二次仍失败则返回 refresh-failed，不无限追赶活跃写入。权限 / containment 失败、意外目录遍历错误和全仓硬上限耗尽直接失败，不以重试绕过策略。
- 无法得到可信输入时保留旧 runtime，不静默发布缺文件的替代 snapshot，也不将读取失败改标 extraction-failed。`refresh-failed` 的有界 details 可记录 `changed-during-read` / `read-failed` 等原因及允许展示的相对路径。P0 不引入 incomplete snapshot 模式。
- 单文件 AST 提取失败不同于文件读取失败：已验证 receipt 仍有效时，可按 §4.6 发布带 failed 提取状态的索引。refresh 成功响应分别携带扫描覆盖和 extraction 汇总。
- 成功只保证已采集文件的 hash / 事实绑定，不保证跨文件同一时间点。未检测到变化不代表未发生并发编辑；不提供暗示完整检测能力的 `inconsistentFiles` 清单。

没有 watcher 时不会自动发现所有改动。Agent 自己修改源码后应显式 refresh；外部修改在 verified read 时可被发现，但未读取文件的修改不保证立即检测到。工具描述必须说明这一限制。

### 5.6 分页与失败语义

查询页沿用 50 条 / 65,536 bytes 等有界原则，事实与 provenance / extraction / cursor 等必需元数据共同计入上限。保留模型可见 `truncated/nextCursor`。有剩余候选时，成功页必须至少消费一个候选，nextCursor 的 offset 必须前进；不能返回带相同 cursor 的空页。若单项与必需元数据已超限，返回 budget-exceeded，不静默跳过该项。无候选时允许空页，且无 nextCursor。P0 默认省略 `totalMatches`，是否续页以 nextCursor 为准。未来提供时只能表示当前索引查询集合的精确命中数，不是全仓覆盖承诺或估算值；实现及测试需同步更新。

输出 policy 为固定元数据预留独立上限：provenance、extraction 汇总及可选问题详情序列化后合计最多 8,192 bytes，详情至多 10 个文件、每文件至多 4 个原因及 256 UTF-8 bytes 的诊断摘要。刷新 coverage 仅返回固定原因枚举的计数，不返回路径列表。先删除 / 截断可选诊断详情并标明详情截断，再缩事实页；snapshot/index 标识、必要来源 identity、状态计数及分页字段不可删除。resultFiles 按 §4.6 与事实一起缩页，不受问题详情条数截断。policy 必须通过最大合法标识与空结果 fixture 验证固定必需元数据能在单次上限内返回；不允许发布连空页都无法表达的配置。错误 details 至多 2,048 bytes，不回显任意原始异常。所有这些上限由一处共享 output policy 持有，不在 renderer 和 compiler 分别维护。

Cursor 沿用 §3.3 的 payload + digest 编码方式，绑定 kind、snapshotId、normalized query hash、offset、limit、policyVersion，并在 P0 升级 payload schema 加入 §6 的 indexFingerprint（适用于索引查询）；跨查询 / 快照 / 索引版本 / 策略复用时拒绝。普通 digest 不是认证措施，不增加新的签名协议。

#### 统一返回约定（P0 目标）

复用宿主已有工具成功 / 失败 envelope，不再套第二层通用 Result 框架。公共工具适配器将下列逻辑字段映射到宿主 envelope，具体类型和 parser 在落地时统一放入现有共享合同。此处包含尚待完成的宿主集成前置，不是现有抛错机制已经提供的能力：

- 成功数据：查询结果及 snapshotId，索引查询另含只读 indexFingerprint；`extraction` 承载 §4.6 的提取状态，`truncated/nextCursor/totalMatches?` 承载分页。直接源码响应不要求 indexFingerprint。refresh 另含 indexFingerprint 与扫描覆盖摘要。
- 失败数据：稳定的 `code`、面向调用方的 `message`、可选且有界的 `details`；不携带可被当作成功页消费的半成品。调用方按 code 分支，不解析 message。
- partial / unsupported / 单文件 failed 是 extraction 状态，不进入错误码枚举；truncated 是分页状态。Provider 整体失败才是工具错误。
- cache corruption 通常是内部 miss / 重算事件，不直接成为模型可见错误；重算失败再报告实际失败原因。

#### 宿主失败桥接前置

**当前批准的传输范围：** P0 / M1 的结构化失败按 Native 工具调用验收。现有宿主 `run_code`（PTC）会将子调用失败降为 message-only，本阶段不修改宿主，不承诺 PTC 下保留 code/details。宿主须为采用本合同的 Agent 配置 Native 工具呈现；本包不伪造单工具 Native 开关，不把结构化 JSON 塞进 message 绕过 PTC 限制。以后支持 PTC 需单独确认公开传输合同与端到端证据。

当前宿主 `ToolFailure` 只有 message 与可选 `info: { name, code }`，仅为 HarnessError 保留 code；默认模型内容是 `Error: ${message}`，不会自动传递本包 details。因此 P0 必须通过宿主正式扩展点完成以下最小桥接；若当前版本无此扩展点，则先升级宿主合同，不在本包返回伪成功的错误对象，也不把 JSON 塞进 message 后要求调用方解析：

- 本包业务失败保留宿主 `isError: true`、稳定 code 与有界 details；模型可见失败内容序列化为同一 `code/message/details` 数据，不只在内部日志保留 code。Native 适配使用已有 `tools/execute` around hook 和 definition-owned `finalizeContent`：宿主路由字段为 `error.info.code` / `error.message`，完整已验证 DTO 放在受支持的 namespaced meta 中并呈现到 content，不向不支持的 `error.details` 属性强行扩展。只有本包实际拥有的工具和已识别业务失败可转换，取消、其他宿主错误与 policy replacement 保持原语义。
- 共享 parser 验证本包业务失败 DTO；宿主桥接拥有 failure envelope / 呈现，本包适配器拥有业务码和 details。取消、timeout、关闭、过载和未知异常继续走宿主原通道。
- 工具输入的宿主预校验不能悄悄丢失统一 invalid-query 语义；确认其结构化错误映射，避免只测试绕过 registry 的 execute 函数。
- 在并行实现前，以真实工具注册 / 执行 / 模型呈现链路验证 invalid-query 与 stale-snapshot，后者必须保留 `details.currentSnapshotId`。只构造本包 Error 或只断言 message 不算完成。

| 错误码 | 触发条件 | 调用方建议 |
| --- | --- | --- |
| invalid-query | 字段、范围、类型组合无效 | 修改参数后重试 |
| invalid-cursor | cursor 无法解码、digest 无效或 payload 不合法 | 丢弃 cursor，从首页查询 |
| stale-cursor | cursor 与查询、snapshot、indexFingerprint、limit 或 policy 不匹配 | 使用当前参数从首页查询 |
| stale-snapshot | 请求 snapshot 非当前版本 | 使用已公开的当前 snapshot；需要采集新编辑时 refresh |
| stale-symbol-id | symbol 句柄不在当前 snapshot 索引中 | 按名称 / 路径重新查询，不自动认领 |
| stale-block | 显式引用 block 的版本或关联边界不匹配 | 重新生成对应 projection 或使用合法的直接源码请求 |
| stale-source | 请求 hash 与 receipt 不符，或已收录文件的当前内容变化 / 消失 | refresh 后获取新 path/hash 与范围 |
| provider-failed | Provider 整体不可用或输出合同损坏 | 查看原因后重试或换检索工具，不当作空结果 |
| refresh-failed | 初次或刷新 runtime 构建失败 | 已有旧版本则保留旧版本认知；排除写入竞争 / 读取问题后重试 |
| cache-unavailable | 显式 block 引用因存储不可用而无法验证，不能确定缺失或版本 | 去掉可选 blockId，使用合法的直接源码请求，或待缓存恢复后重试 |
| budget-exceeded | 本次输出将超出预算 | 缩小输出或调整计划，不原样无限重试 |
| not-found | 请求的具体 path / block 等资源不存在 | 重新获取资源；cache 淘汰也可能导致 block 缺失 |
| access-denied | workspace 未授权或路径违反访问策略 | 使用已授权范围，不通过 refresh 绕过策略 |

上述表是 P0 业务错误码清单；取消、超时、关闭及过载遵循 §5.5 的宿主通道。新增可预期业务错误需同步共享 parser、工具说明与测试。未预期异常由宿主既有内部错误通道处理，不强行归为 not-found。集合查询无命中始终使用成功空页。

---

## 6. P0 缓存策略

P0 只保证 snapshot-scoped 查询页 / block 缓存：

```text
workspace + snapshotId + indexFingerprint + normalized query + cursor/page
  + provider/config identity + compiler policy
  → projection / block
```

- 保留完整页内容及分页状态，不为局部依赖假设删除 DTO 字段。
- 所有索引派生 projection / block 必须携带 snapshotId 与 indexFingerprint，并在 cache 命中及显式 blockId 解析时验证二者。P0 的 symbol、relation 和含 AST 派生元数据的 repo map 均属于此类；P0 repo map 统一按索引查询处理，不额外拆纯 receipt 页合同。同 snapshot 下 indexFingerprint 不同的旧索引 block 显式引用返回 stale-block，内部 cache lookup 则按 miss 重算。校验对照请求捕获的 runtime，而不是完成时可能已被 refresh 替换的 active 指针。
- 纯 source block 仅绑定 snapshot、path/sourceHash、范围与实际内容，不因无关 AST index 变化而 stale。以索引 block 为入口生成 source block 时，入口关联先通过当前请求 runtime 的索引版本校验；生成后的纯 source block 不继承无关的 indexFingerprint 依赖。历史响应仍是其声明版本的事实，不因新索引发布而被改写，但不能将旧 block 显式引用视为当前索引结论。
- 同 snapshotId、同 policy 下重试提取也可能使 failed/partial 变为 complete；因此 projection / cursor 必须绑定实际索引内容版本 `indexFingerprint`，不能仅靠 policyVersion。其计算规则见下文。提取结果或状态不同则旧查询页 miss、旧 cursor stale；不得仅凭文件 hash 重用旧 partial 页。源码 block 只依赖其真实内容与关联边界，不要求无关 AST 变化使直接源码读取失效。
- 实现前审计共享 cache 合同：若可低成本移除全仓 dependencyHashes 冗余则清理；若需要独立跨包迁移，P0 允许保留并记录技术债。保留时在构建期计算一次并复用，不在每次查询重算全仓列表。它与 snapshotId 部分冗余，但与实际提取结果版本不是同一维度。
- 任意 snapshotId 变化允许全局 miss，包括未来采用增量构建时。
- 命中验证 contract、boundary、identity 与 path/hash；不需要重新跑 AST 才能证明缓存有效。
- 损坏或不匹配按 miss 处理并重算；cache 不可用时，在宿主合同允许的情况下直接返回验证后的查询结果，不让持久化成为必要前置。

#### 可选 cache 接入的最小跨包合同

当前 cache 的 `putBlock(): Promise<void>` 可能在关闭 / 锁超时后未写入而正常返回；`getBlock(id, boundary)` 将缺失和边界不匹配折叠为 undefined，部分损坏与读取故障也在内部消化。P0 不据此猜测成功、stale 或降级原因。启用 cache 包装前由 `dsh-context-cache` 提供以下内部能力，具体命名由共享类型持有，不新增 Agent 状态协议：

- **写入确认**：区分已确认保存（或已存在同身份有效记录）与跳过 / 不可用。仅确认保存后返回 blockId；持久化与淘汰可能紧邻发生，确认不是 pin 或未来可读保证。未确认时省略 blockId，返回同一验证后 projection。
- **显式引用分类**：在获准 workspace 的缓存命名空间内，区分有效命中、确认缺失 / 损坏、已有有效记录但版本边界不匹配、存储不可用。本包将它们分别处理为继续关联校验、not-found、stale-block、cache-unavailable；不同 workspace 的条目不得通过此分类泄露存在性，也不提供不受控的全缓存读取接口。
- **内部查询 lookup**：上述失配 / 缺失 / 损坏按 miss 重算，不可用则无 cache 降级。不能把内部 miss 规则直接复用于显式引用的业务错误。
- **原因可观测**：通过宿主可接入的有界原因事件或操作结果提供 normal-miss、corrupt、boundary-mismatch、unavailable / write-skipped 等分类；不回传原始异常、源码或绝对路径。本包关联 request/session 并按 §7.3 记录。

缓存锁、原子文件提交与淘汰仍由 cache 包持有，本包不另写一份缓存扫描器，也不通过查询后再查一次的竞态推断写入成功。此最小接口迁移与 indexFingerprint 边界升级是 cache 接入前置；全仓 dependencyHashes 去冗余仍可独立延期。无 cache 主路径不依赖这些能力，但不得在接口未完成时宣称可选 cache 路径已满足 P0。

### 6.1 indexFingerprint 与查询归一化

`indexFingerprint` 在 AST 提取完成、事实与 endpoint 校验通过后计算一次，与 runtime 原子发布：

```text
sha256(canonicalJson({
  schema: 'dsh-index-fingerprint-v1',
  providerConfigIdentity,
  normalizedFacts,
  fileExtractionStates
}))
```

事实使用索引实际用于查询 / 投影的确定性字段，不含查询态 score；按固定键稳定排序，状态按 path/hash 排序，原因集合去重排序。包含模型可见的完整性、Provider Universe 成员 / 能力边界与诊断数量；不包含时间戳、耗时、原始异常文本等非确定性运行信息。文件数或 policy 版本号不能替代事实校验和。具体 canonical DTO 由实现与 fixture 测试共同维护，测试覆盖输入遍历顺序不影响 fingerprint，以及相同 receipts 下提取状态变化会改变 fingerprint。它是缓存 / cursor 边界及只读响应来源字段，不新增 Agent 需要提交或管理的查询句柄。

查询归一化规则：

先校验，再将请求转成默认值已补全的 canonical 对象；查询执行、cursor queryHash 和缓存 lookup 共用该对象，不能各自实现一套归一化。

- 纳入所有影响输出的字段：tool/projection kind 与查询分支、repo map 的具体 path、name 或 symbolId、mode、kind filter、canonical pathPrefix、relation from/types、适用分支的 limit，以及当前 snapshot/index/provider/policy 边界。可选输出字段开关若未来增加，也必须纳入。
- 使用 canonical JSON 的对象键顺序；对象传参顺序不影响 identity。relation types 是集合，去重后稳定排序；省略时展开为 §5.3 的四种合法类型默认集合。其他数组只有合同明确是集合时才排序。
- 集合查询的 mode 与 limit 补 schema 默认值，symbolId 与 repo map path 直查不补互斥字段；无 pathPrefix 与空字符串统一，末尾 `/` 按 §5.2 去除。name、kind、path 大小写保持语义原样。fuzzy 只可去除不影响既定打分的首尾空白，不在 canonical query 中 lowercase query，以免改变 camel 拆词。
- cursor 先解码并验证绑定；base queryHash 不包含 cursor 本身，避免循环。页 lookup 另纳入验证后的 offset 与 limit，而非仅按 cursor 原始字符串区分。
- 若实现可选 source lookup，纳入 path/hash、范围模式、规范化范围、padding、whole-file 与显式 block 关联；状态性预算检查在返回结果时执行，不因 cache hit 绕过。refresh 不作为查询结果缓存。
- provider 或提取 / 排序规则变更必须更新配置 / policy identity。归一化只合并合同证明语义相同的请求，不追求不安全的“最大缓存命中率”。

### 6.2 为什么页内 hash 不足

按路径排序的第一页原为 `b.ts/foo, c.ts/foo`；新增 `a.ts/foo` 后，b/c 内容未变但第一页已变化。计数、cursor **以及页成员本身**都依赖查询候选集合。

删除 total/truncated 不能实现正确的跨快照页面复用。增量 snapshot 构建也不意味着 snapshotId 稳定。

### 6.3 P1 优先复用文件事实，而非页面

首先尝试：

```text
language + file content hash + provider/config identity
  → file-local facts with local offsets / node references
```

挂载到新 snapshot 时补 path、snapshot-local ID 与 endpoint；共享缓存的 workspace / policy 边界须独立明确。之后重新执行查询决定页成员，再编译当前 snapshot 的 projection。

跨快照页复用若确有收益，另行设计候选集版本或查询依赖；不得仅验证旧页内文件。语义 Provider 的跨文件依赖也不能套用 AST 文件级失效规则。

---

## 7. 信任与成本边界

### 7.1 必要正确性

- canonical workspace、路径 containment、文件排除策略；
- 有界扫描和输出；
- snapshot / source hash / provider/config 版本绑定；
- 未解析关系、部分提取和不支持能力的明确标记；
- 确定性排序、有效分页和缓存完整性；
- 不把旧快照事实冒充当前工作区状态。

hash 与 provenance 提供版本和来源可追溯性，**不证明提取器没有 bug，也不保证语义事实正确**。正确性仍需要测试与独立评测。

**本组件不是 DLP 或秘密检测器，不做通用内容级敏感信息识别。** Workspace 授权、路径验证、内容版本验证和输出上限是实际保证；获准读取 workspace 不等于其中所有内容都适合发送给模型。上层系统仍负责模型输入的数据授权与必要的内容过滤。

`.env*`、已知私钥后缀和二进制排除只是已知类型策略，不能识别任意命名文件中的凭据或其他敏感内容。具体规则以现有扫描 policy 与 `isIndexableFile` 为权威，不在文档中另维护完整后缀表。

扫描覆盖摘要区分 `excluded-by-policy`、`unsupported-format`、`file-too-large` 等正常跳过原因；`max-files-exceeded`、`max-directories-exceeded`、`max-scan-entries-exceeded`、`max-total-bytes-exceeded` 和 ignore 上限耗尽为构建失败，不复用模糊的 file-limit 名称。意外 read-failed 按 §5.5 使 refresh 失败，不混为正常跳过。私钥排除和二进制跳过不进入符号 / 关系 extractionStatus，也不代表这些文件不存在。目录被整体剪枝时只报告已观察到的排除计数，不额外遍历以获得“精确排除文件数”。

模型默认获得有界原因计数；具体排除路径按调试需求和授权决定是否展示，避免通过诊断泄露不必要的敏感文件名。

#### 扫描与读取过程的有界性

P0 在现有 output policy 之外补齐扫描 / 读取过程的资源限制，配置默认值、最大值和错误原因由单一 snapshot policy 持有：

- 新增有限 `maxScanEntries`，枚举每个已打开目录返回的 entry 时先计数、检查 signal / deadline，再进入有界排序缓冲；达到全仓 entry 上限即失败。计数包括观察到的被排除 / 非 regular entry，不遍历已剪枝目录来计数。不能等全目录读完后才检查。
- maxDirectories 统计实际打开扫描的目录（含根）；maxFiles 统计通过静态路径 / regular file / 初始 size 策略、准备读取的候选文件，之后发现 UTF-8 / NUL 格式不支持也不退回次数，避免扫描工作无界。receipt 数单独报告，不把候选数称作已收录文件数。maxTotalBytes 统计可信 receipts 的原始内容字节，ignore 内容受独立累计字节 / pattern 上限约束。
- source、构建源码与 ignore 内容均使用有界 reader，最多取得该次允许字节数加一个检测字节，不先 readFile 全量分配再判定超限；读取循环检查取消。初始检查已知单文件过大可正常跳过，打开后增长 / 身份变化是读取竞争，不伪装成正常跳过。ignore 读取也需 regular file、路径与版本检查，不能作为未验证输入旁路。
- 打开后以文件描述符 fstat 验证 regular file、size 和身份，并在读取后复核描述符与路径身份；读取可信文本与 hash 来源必须是同一个打开的对象。已知平台支持时使用 no-follow 等打开保护；非 regular 替换不可进入可能无界等待的普通读取路径。

**文件系统威胁模型：** P0 支持普通并发编辑，拒绝检测到的 symlink escape、非 regular 文件或路径替换；不承诺抵抗拥有同一 workspace 写权限的恶意进程持续替换祖先目录 / 文件。前后 realpath/lstat/fstat 不能构成这种对手下的原子 containment 证明。需要该保证的部署必须由宿主提供受隔离的可信读取边界或平台支持的 root-relative 安全打开能力；本包不能仅凭校验标记宣称已隔离。不具备该宿主边界时，不支持该威胁模型下的部署。普通竞争下无法验证的读取按 §5.5 失败，不返回部分内容。

#### P0 ignore policy

P0 继续使用有限 picomatch 模式集合，不实现完整 gitignore。忽略空行 / 注释后，拒绝以 `!` 开头的 pattern（包括 extglob 否定写法），匹配器显式禁用顶层 negate 解释；不把不支持的重新纳入语法变成“排除其余所有文件”，也不静默跳过该规则。遇到不支持规则使构建失败，refresh-failed details 使用 `unsupported-ignore-pattern` 与允许展示的相对 ignore 文件位置，提示修改规则，不回显任意 pattern。此限制属于已公开的兼容性取舍，不是访问授权结论。

其余 picomatch 行为、前导 `/` 的既有处理和没有 gitignore 顺序覆盖 / 目录斜杠语义均写入 snapshot policy 与代表性 fixture。此行为变更升级 snapshot policy，使旧 snapshot / cache 不被静默复用；不支持 gitignore negation 的仓库需先调整规则，P0 不宣称开箱支持所有真实仓。

### 7.2 成本策略

单次字节上限与 session 输出预算属于可配置成本策略。P0 不设置隐式窗口或隐式整文件读取，范围必须按 §4.3 显式提供。它们不能证明权限隔离，也不应阻止有明确需求的合理源码阅读。

不因 provenance 不够丰富而一律禁止使用事实；区分缺少必需版本绑定与缺少可选 enrichment。安全边界不确定时拒绝，普通能力不足时明确返回状态。

### 7.3 最小运行可观测性

复用宿主现有结构化日志，不新增 telemetry 框架。每次初始化 / refresh 记录开始、提交 / 失败 / 取消、排队与构建耗时、前后 snapshotId/indexFingerprint、文件提取状态计数以及重试原因，无前版本时明确为空；cache 通过 §6 的原因接口区分正常 miss、损坏重算和存储不可用降级，后两者记录原因码，不从 undefined 推断原因；候选 / 旧 runtime 清理失败单独记录。事件携带宿主 request/session 关联标识，计时数据不进入 indexFingerprint 或缓存 identity。

默认不记录源码、原始异常文本或绝对路径；相对路径仅在已有授权调试通道按需提供。无需逐符号日志，也不要求 P0 建监控面板。日志用于区分扫描、提取、提交和清理失败，不用模型可见诊断承担运维日志职责。

### 7.4 Cache 与 LSP hardening

缓存仍需受控目录、原子提交、内容校验、容量限制和并发写入一致性；复杂多进程锁、长期 quarantine 运维按部署需要验证。

LSP 未接入 P0。P1 experimental 接入必须明确进程、环境、协议、超时和清理边界；生产部署再提供 OS 网络隔离、凭据剥离、可信 executable、多平台进程树清理等证据。安全标记不能替代实际隔离。

---

## 8. 评测：区分查表能力与 Agent 收益

本包尚无可复现的真实仓 corpus / runner。`dsh-eval` 的 `fixtures/v0.2a` 是合成 fixture，只能作为确定性回归；历史 token reduction 或 recall 数字不作为本包证据。

### 8.1 公平 baseline 与消融

下表是可复用的评测变体，不要求 P0 工程验收跑齐。首轮收益 pilot 只跑 Baseline 与 C；A/B 用于后续归因，按需要运行，不阻塞交付。所有实际对比组使用相同源码读取能力、输出预算与任务输入：

| Variant | 检索能力 | Source |
| --- | --- | --- |
| Baseline | grep / filename search | bounded read，可显式 full read |
| A | Baseline + Symbol query | 同上 |
| B | A + Repo Map | 同上 |
| C | B + Relations | 同上 |

另可保留 `grep + full-file-only` 历史对照，但不能作为证明结构化检索收益的唯一 baseline。

同时报告结构化工具单独的 retrieval 测试，防止组合组借助 grep 掩盖坏掉的符号 / 关系能力。所有组的策略、停止条件和 query budget 固定并记录。

### 8.2 查询集与独立 gold

P0 工程验收至少使用 1 个固定 commit 的真实开源 TS/JS 仓库，包含独立核验的检索样例、源码读取与编辑刷新 smoke；合成 fixture 继续覆盖难以稳定复现的错误场景。首轮 pilot 可复用该仓，但只能报告有限样例结果。

宣称一般性检索收益前，使用至少 3 个不同规模 / 结构的真实开源 TS/JS 仓库，含 monorepo 或 layered 仓库，固定 commit、corpus 版本和脚本，并保留独立确认集。仓库数量只是覆盖下限，不替代任务分布、样例数量和不确定性分析。下列任务类别逐步扩充，不要求首个 smoke corpus 覆盖所有类别。

任务分组：

- 已知符号名：衡量声明检索能力，不外推为未知任务定位能力；
- 名称未知的线索：错误字符串、文件线索或任务描述；不得向优化组泄露 gold 名称；
- imports / exports / contains 与源码 evidence；不把 unresolved calls 当作 gold call graph；
- 编辑后 refresh：改内容、插入行、增删文件、刷新失败及旧句柄行为。

Gold 独立记录固定 commit 下人工或独立方法核验的 path、声明位置、名称、所需 evidence 与允许的等价目标集合。不得仅由被测 AST 提取器生成 gold。symbolId/key 可以作为辅助字段，不是唯一正确性判据。

固定 commit 使用独立 range / declaration 匹配规则；规则与位置容忍在运行前冻结。重载明确标记目标声明或可接受集合。跨编辑身份稳定性若未来实现，另设变换测试，不混入普通 recall。

### 8.3 指标与报告

按阶段区分必需指标与可选诊断，不将完整指标套件变成 P0 开发前置：

| 阶段 | 必需报告 |
| --- | --- |
| P0 工程验收 | 合同测试结果；独立 gold 的定位正确性 / recall@k 与样例数量；首次完整构建耗时作为观察值，不设未经验证的性能硬阈值 |
| 收益 pilot（Baseline/C） | 两组相同任务上的定位 / evidence 质量、总模型可见 token estimate、工具调用数、cold 端到端耗时；源码 token 单列，披露失败和负收益任务 |
| 多仓确认 / 后续 Agent 评测 | 预先登记的质量与成本指标，按任务类别分组；真实 Agent 另报任务成功与验证结果 |

precision、MRR、峰值内存、warm latency、refresh 耗时细分、files opened、full reads 和重试次数作为按需诊断，不阻塞 P0；大仓或内存故障出现时应补对应测量，不能因“尚未优化”而忽略可用性瓶颈。

统计 token 时固定 tokenizer 与版本，总输入包含源码、projection、provenance、分页和错误输出。若接入现有 `PromotionReportV1`，继续按其字段定义统计 source_token_estimate；总输入作为独立指标，不偷偷替换已有字段语义。

Deterministic retrieval 能证明检索与脚本成本，不证明真实 coding-task success。后续真实 Agent 评测另报模型、prompt、工具策略、任务成功率、验证通过率与成本。

### 8.4 P0 判定

不在无首跑证据时设任意折扣阈值，也不跑完再调阈值并用同一数据宣称通过。

P0 工程退出条件：

- 查询、源码、refresh、分页、partial / stale 合同通过测试；已定义 stale 测试全部拒绝错误版本；覆盖语法诊断、容量截断、单文件提取失败、读取竞争、刷新失败保留旧 runtime、计数与分页进展、源码范围 / 空 pathPrefix 边界、并发预算扣费及刷新不重置预算、统一错误映射。选择典型路径与关键边界，不要求工具 × 状态 × 缓存 × refresh 全组合穷举；
- 至少一个固定真实仓的检索、source、编辑 refresh smoke 可复现，独立 gold 样例通过；记录样例数量、定位结果与首次构建耗时；
- 报告分别给出工程就绪与收益验证状态。单仓小样本正确不等于收益成立。

Baseline/C pilot 不阻塞上述工程退出；A/B 消融、多仓确认和真实 Agent 评测也不作为 P0 工程 gate。若 pilot 尚未运行，收益状态明确为 not-ready。

根据 pilot 的任务分布与方差，在独立确认集运行前登记质量容忍、成本收益和性能预算；确认集未运行或未达标时，收益状态为 `not-ready` / `not-demonstrated`，不宣称“少读源码且定位不降”。不得用只减少 source tokens 而总输入或成功率恶化的结果宣称整体胜出。

---

## 9. P1+：有证据再扩展

### 9.1 增量刷新

测量全量 refresh 的实际成本后，优先按文件事实缓存与增量索引替换，保留新 snapshot 身份，再决定 watcher、反向依赖闭包与并发复杂度。若提供文件 diff，只比较已提交 receipts，输出 added / removed / modified 的有界列表及独立 diff 截断标记；它不是 watcher 事件或语义影响集合，也不授权跨 snapshot 页面复用。

AST 文件级提取可按文件失效；type-checker / LSP 必须明确配置和跨文件依赖，依赖未知时保守重算。

### 9.2 语义导航、反向关系与多 Provider

反向关系索引与查询是明确的 P1 优先级评估项：衡量 usages / callers 等任务频率后决定先实现哪些边。resolved imports / calls 需要先解决模块 / 符号 endpoint；存储层反转已有边只能解决查找方向，不能补齐语义解析。索引需承担额外内存、按源文件删除旧边与更新反向条目的一致性成本；针对实际规模也可先用有界扫描验证需求，不预先要求通用图数据库。

根据实际任务增加 definition / references / implementations，按需启动或复用 LSP，结果绑定版本与来源。不把 AST 同名候选冒充语义引用。

先保留独立来源结果，再决定是否需要实体对齐与字段合并。若要合并，必须定义 Provider 间身份映射、字段级来源、冲突表示及确定性规则；不得取最高字段置信度代表整个对象，也不得无条件并集 modifiers。

### 9.3 跨快照 locator 与 Working Set

只有消费者确实需要跨编辑续接时再设计 locator。重命名、移动、同名声明增删、匿名作用域变化都是显式测试场景。可用文件 diff、作用域和声明特征形成候选，但不声称启发式匹配提供身份保证。

Working Set 生命周期归 Orchestrator。本包提供查询与必要的版本信息，不提前实现 delta / merge / rebase 状态机；其接口由真实调用流程共同决定。

### 9.4 Repository View、Lexical 与 Semantic

- Repo Map 是否分层由大型仓使用证据决定；npm package、目录或 tsconfig 都只是可选分组，不先冻结统一 Module 语义。
- 若宿主 grep 不满足有界查询与统一结果需求，再提供本包 lexical provider。
- Semantic retrieval 只有在更便宜的工具不足且评测有收益时引入。
- 自然语言“模块职责”不是 AST 事实，应与代码提取结果分开标注来源。
- 独立 renderer / projection 双身份只有出现多个 renderer 或真实复用需求时再拆。

---

## 10. Roadmap 与成功标准

### P0：可用查询与编辑闭环

- snapshot-local ID，exact / prefix / 显式 fuzzy，kind/path filter；
- 正向 AST 关系与明确的 unresolved / partial 状态；
- 一套 Agent 工具面、结构化失败与当前 snapshot / 具体文件 receipt 发现方式；
- canonical source 坐标、有界读、允许重叠与显式 full read；
- 有界扫描 / 读取、明确的初始化失败恢复、全量 refresh 与原子 runtime 替换；
- snapshot-scoped 缓存，不改造跨快照分页依赖；
- 一个固定真实仓的检索 / source / refresh smoke 与工程报告；Baseline/C pilot 可并行推进，不阻塞工程验收。

实施顺序与依赖：

1. 先固定共享输入 / 输出 schema、名称与关系覆盖 / endpoint 映射、默认值、资源 policy、初始化任务归属 / runtime lease / 提交接口和真实 Session 预算。完成宿主结构化失败桥接的端到端验证；明确 cache 包的确认 / 分类 / 诊断接口与 indexFingerprint 迁移。这些是跨包前置，不发布通用框架，也不把宿主 / cache 不支持的能力视为已经存在。
2. 在上述边界上并行实现 repo map 文件直查、symbol / relation 查询、source 与预算、有界读取及初始化 / 全量 refresh；corpus / 独立 gold 可从第一步并行准备。先打通无 cache 主路径，cache 包装在共享接口验证通过后接入。
3. 集成单一工具面、结构化失败、已知 path 的 receipt 发现与旧合同失效规则，完成真实仓编辑闭环，再出工程与收益分离的报告。同步清理 README 的重复安装说明和未接入 LSP 的能力宣称；不要将文档漂移带入新版工具说明。

并发测试通过最小内部注入点控制 verified reader、file extractor 和提交前屏障，不依赖随机 sleep 或真实文件竞争碰运气。覆盖关闭期间禁止提交、提交前取消清理候选、旧查询 lease 延迟释放、提交后清理失败不回滚，以及无 cache 查询 / cache 降级；另覆盖混合语言仓中 unsupported 文件不降低 TS/JS 查询完整性、Provider 范围内 failed 不被排除、无 eligible 文件与空作用域的区分、receipt 文件删除返回 stale-source，以及同 snapshot 不同 index 的旧索引 block 被拒绝而纯 source block 不因该变化失效。只测代表性交叉边界，不穷举组合。

本轮补齐合同采用少量代表性测试，不扩展为全组合矩阵：真实 registry 链路保留 code/details；cache 锁超时未写入不返回 blockId、显式 stale/missing/unavailable 分类；已知 JSON path 在 refresh 后无需扫页即可获取新 hash 并读源码；初始化失败重试、单等待者取消不影响共享初始化、初始化中排队 refresh 必须重新采集；同 Session 多 agent 共用预算；entry 上限与打开后增长的有界读取；普通 export modifier / re-export / type-only / 排除语法；U+2028/U+2029 坐标一致；超长事实名称不被截断改名；ignore 否定规则明确失败。测试注入点沿用上述 reader / extractor / 提交屏障，不为这些场景新增通用测试框架。

公共合同变更按需升级版本，旧 block/cursor 不静默兼容。实现落地后，将本文输入边界和算法的重复描述替换为共享 schema / output policy / fixture 引用；架构、阶段范围与不变量仍保留。

### P1：针对瓶颈扩展

按实测需求选择文件事实复用 / 增量刷新、语义导航、反向关系、宿主 lexical 集成、Agent benchmark。不是要求一次交付全部编排愿景。

### P2：扩展语言与生产部署

第二语言、多平台进程管理、大仓压测、复杂缓存并发及可选 semantic / renderer。每项新增复杂度需有消费者或收益证据。

### 最终标准

- 事实来源、版本与局限清楚，不把候选当确定关系；
- Agent 能定位、读源码、编辑并刷新继续工作；
- 安全检查守住真正的文件与版本边界，不用访问障碍代替成本优化；
- 输出有界，缓存正确，失败可理解且可恢复；
- 在质量不显著退化的前提下，减少总检索成本，而不仅减少某一种 token 计数。

目标是让每次检索得到**足够、相关、可验证的代码证据**，而不是让 Agent 为遵守检索协议付出更多工作。
