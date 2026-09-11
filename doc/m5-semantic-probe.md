# M5 语义探针（Phase 3）— 类型信息是否改变答案？

| 项 | 值 |
|---|---|
| 状态 | **完成**（只读诊断，不产出正确率数字，不是评测臂） |
| 脚本 | `eval/m5/semantic-probe.mjs` |
| 报告 | `node_modules/.cache/m5-eval/reports/semantic-probe.json` sha256 `6a27e4c37060bdfa050b95735f19e8d0fe43ff64f01cf1c7c2fc45255b98d5a2` |
| 金标 | `eval/m5/gold.json` sha256 `cb9b7c90ed06cfd6a1960fdd71d77733265d21213253916d4357651c409d5237`（未改动） |
| 语料 | zod `v4.4.3` @ `1fb56a5c18c27102dbc92260a4007c7732a0ccca`，286 文件 / 2,237,613 字节 |
| 依赖 | 已捆绑的 `typescript@5.9.3`。**未新增任何依赖**，无网络，无外部进程 |
| 运行 | `node eval/m5/semantic-probe.mjs`（约 1.2 s 建 Program + ~2.1 s 建索引） |

## 1. 为什么不是"跑一轮 LSP 模式"

被问到"用 LSP 模式再跑一轮测试"。核查后的结论是**该模式在产品里不存在，无法切换**：

| 检查 | 结果 |
|---|---|
| `ReadonlyLspAdapter` 是否接入默认运行时 | **否**。`plugin.ts` / `p0-runtime.ts` / `p0-build.ts` / `p0-snapshot.ts` 对它的引用数为 **0**；它是独立的 V1 类，需外部注入 `LspDeploymentConfigV1` + `SubprocessRuntime` + V1 `RepositorySnapshotStore` |
| 它提供什么语义 | **只发 `textDocument/documentSymbol`**，产出符号表；**零关系输出** |
| 环境是否有语言服务器 | `typescript-language-server` 不在 PATH；`tsserver` 随 `typescript` 捆绑 |

即便接成第 4 臂也无信息量：`declaration` 类别三臂已全部 **24/24**，LSP 臂**必然打平**；`source` 与 `relation` 它**无法服务**。

更根本的障碍：**在 TypeScript 上，"LSP 模式的语义内容" = tsserver = TypeScript compiler API（含 `TypeChecker`）**。LSP/JSON-RPC 只是传输外壳。所以本探针直接用 `ts.createProgram` + `TypeChecker`，得到同一层语义而无需协议与进程管线。

并且：**语义化提取器对当前冻结金标是构造性失败**。金标断言 `resolution: "syntactic"|"heuristic"` 且 `target.kind: "unresolved"`；语义侧产出 `resolved` + 文件/符号目标。因此任何以该金标计算的"正确率"都无法比较语义质量——要公平比较必须**新建一套金标**（独立里程碑，不在本轮范围）。

## 2. 方法

- **启发式侧**：用**真实产品工具** `context_relation_query` 逐文件读回提取层自己的 `calls` 边（不重实现、不猜）。
- **语义侧**：`ts.createProgram` over 全部 286 个源文件，`moduleResolution: NodeNext` + `customConditions: ['@zod/source']`（复现仓库 `exports` 映射里 `zod/v4` → `src/v4/index.ts` 的自引用），逐调用点用 `checker.getSymbolAtLocation` + `getAliasedSymbol` 解析到声明。
- 两侧做 diff。**只读**：语料与 `gold.json` 全程未写。

## 3. 结果

### 3.1 declaration 类别：**无语义分歧**（10/10 精确对应）

金标声明的 span 是**声明节点范围**，其 `kind` 与 `ts.SymbolFlags` 一一对应：

| 金标 `kind` | 语义节点 | `ts.SymbolFlags` |
|---|---|---|
| `variable` | `BindingElement` / `VariableDeclaration` | `BlockScopedVariable` |
| `function` | `FunctionDeclaration` | `Function` |
| `interface` | `InterfaceDeclaration` | `Interface` |
| `type` | `TypeAliasDeclaration` | `TypeAlias` |
| `enum` | `EnumDeclaration` | `RegularEnum` |
| `class` | `ClassDeclaration` | `Class` |
| `method` | `MethodDeclaration` | `Method` |
| `enum-member` | `EnumMember` | `EnumMember` |

**span 匹配 10/10，符号解析 10/10。** 这条直接解释了 Phase 2 里的一个反常观察：`declaration` 类别三臂全部 24/24——因为**这一层不是近似的**，它是 TS 语法树的直接投影，任何检索方式都不可能在它上面更好。

### 3.2 imports：非外部目标上语义严格更强

| 例子 | 启发式 | 语义 |
|---|---|---|
| `rel-01` `zod/v4` | `{kind:"unresolved", specifier:"zod/v4"}` | **`v4/index.ts`**（自引用经 `@zod/source` 条件解析） |
| `rel-01` `vitest` | `{kind:"unresolved", specifier:"vitest"}` | 解析到 pnpm store 的 `vitest/index.d.cts`（`external: true`） |
| `rel-05` | 空集 | 空集（对照样本：该文件无 import） |

金标的 `unresolved` 是**表示选择**：信息在文件系统里是可得的，但工具契约不暴露目标文件身份。

### 3.3 exports：star 导出是数量级差距

`rel-02`（`v4-mini/index.ts`）：启发式给 **2 个目标**（`z` + specifier 字符串 `"../v4/mini/external.js"`）；语义把 star **展开成 249 个具体导出名**（含 `z`、`describe` 等，已抽样核实 `describe` 确为真实导出：`v4/mini/schemas.ts:1813 export const describe = core.describe`）。

`rel-06`（`v3/helpers/typeAliases.ts`）：两侧等价（`Primitive`、`Scalars`）。

### 3.4 calls：差距不在"答错"，而在**边不可连接**

全语料（261/286 文件有调用边）：

| 指标 | 值 |
|---|---|
| 启发式 `calls` 边总数 | **4,836** |
| 不同 callee 名字 | **703** |
| 解析出的不同声明目标 | **1,162** |
| **名字坍缩因子** | **1.653**（1,162 个真实声明被压成 703 个名字） |
| 边可完整解析 | 4,774 / 4,836 = **98.72%** |
| 边含未解析调用点 | 62 = **1.28%** |
| **单文件内一词多义边** | **72 = 1.49%** |
| 调用点总数 | **32,304** |
| 调用点形态 | identifier 9,342 / propertyAccess 22,962（**71.1% 是成员调用**） |
| 未解析调用点 | 155 = **0.48%** |
| **可连接的调用边** | **0** |

最后一行是最重要的：`p0-extractor.ts` 的 `addUnresolvedRelation` **永远**构造 `{kind:"unresolved"}`，所以 **100% 的调用边都是悬空名字，没有 join key**（而 `contains` 边是 symbol-linked 的）。后果是**反向查询在结构上不可能**——"哪些符号调用了 X"无法回答。

一词多义的具体证据：

```
v3/tests/discriminated-unions.test.ts  "parse" x35 -> v3/types.ts#parse | lib/lib.es5.d.ts#parse
v3/tests/array.test.ts                 "array" x8  -> v3/types.ts#array | v3/types.ts#arrayType
v3/benchmarks/realworld.ts             "array" x3  -> v3/types.ts#arrayType | v3/benchmarks/realworld.ts#array
```

即 **`JSON.parse` 与 `z.parse` 产生完全相同的启发式边**；`array` 与 `arrayType` 无法区分。

### 3.5 `rel-04` 的语义答案

| 启发式 | 语义 |
|---|---|
| `"config"` → unresolved (heuristic) | `"config"` @L11 → **`v4/core/core.ts#config`** |
| `"en"` → unresolved (heuristic) | `"en"` @L11 → **`v4/locales/en.ts#default`** |

两点值得注意：语义目标**不是** `config.ts` 而是 `core.ts`（再导出链被跟随）；`en` 的语义身份是 **`default` 导出**，即启发式记录的名字 `en` 是一个**局部别名**，不是目标的名字。

## 4. 本探针自身的两处错误（已修正，留档）

| # | 错误 | 后果 | 修正 |
|---|---|---|---|
| P1 | v1 用"恰好覆盖金标 span 的 `Identifier`"定位声明 | 5/10 误判为未解析 | 金标 span 是**声明节点范围**；改为按 span 定位节点再解析其名字 → 10/10 |
| P2 | v1 断言未解析调用点源于"语料未装 vitest/@types/node" | **被证伪**：vitest 与 @types/node 都解析成功 | 全部未解析点是 `no-symbol`，出现在**接收者类型未解析的成员调用**上（`Array.push`、`Emitter.on`、`.add`）。这是探针类型环境不完整的产物，**不是提取器缺陷**；调用点级未解析率 **155 / 32,304 = 0.48%** |

## 5. 可以下的结论

**确定的：**

1. **`declaration` 层无语义分歧**（10/10 精确对应）→ 该类别不存在"谁更准"的空间。
2. **`calls` 边不可连接是结构性事实**（0/4,836 有 join key）→ 反向调用查询不可能。
3. **名字坍缩真实存在**：1,162 个声明被压成 703 个名字；单文件内 1.49% 的边一词多义（`JSON.parse` vs `z.parse`）。
4. **star 导出差距是数量级的**：2 个目标 vs 249 个名字。
5. **`imports` 的目标文件身份在当前契约下不可得**，但文件系统里可得。

**不能下的：**

1. 不能给出"语义版正确率更高"的数字——金标按构造即不兼容，且本探针不是评测臂。
2. 不能说未解析调用点是提取器缺陷（见 P2）。
3. 不能把 `calls` 边不可连接当作"grep 更优"——它对**产品自身**同样是限制。
4. 未做全量语义类型检查（checker 惰性解析），故语义侧是**下界**，不是上界。

## 6. 对前面结论的影响

- 强化了 Phase 2 的 `rel-04` 发现，但**改变了它的解释**：真正的差异不是"结构化更聪明"，而是**"我们自己的启发式边携带了 grep 语法上无法产生的信息（节点覆盖），却不携带任何目标身份"**。所以 `rel-04` 衡量的是"能否复现我们的边集合"，这一点在 Phase 2 已被标注为公平性存疑，现在有了机制层面的依据。
- 给出了一条**对产品更有价值的结论**：要把 `calls` 关系变得真正可用，需要的是把边连接成符号（`resolution: "resolved"`），而不是换 LSP。这属于提取层契约变更（新里程碑），且必须配套新建金标。
- `declaration` 的 24/24 平局从"奇怪"变成"预期"，不应再被当作任何一方的优势。

## 7. 复现

```bash
cd packages/dsh-code-intelligence
node eval/m5/semantic-probe.mjs                          # 写 reports/semantic-probe.json
node eval/m5/semantic-probe.mjs --out /tmp/probe.json    # 指定输出
sha256sum eval/m5/gold.json                              # 必须仍是 cb9b7c90…
```

## 8. 边界

- 单一语料（zod `v4.4.3`）、单一语言（TypeScript）。
- 探针的语义侧是**惰性**解析，非全量类型检查，因此未解析率是**上界**、解析成功率是**下界**。
- `getSymbolAtLocation` 对重载/泛型不做实例化推断；同一名字的多个重载声明会被记为多个目标。
- 本探针**不改动**任何冻结产物，也不构成 M5 验收的一部分。
