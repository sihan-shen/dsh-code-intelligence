# M5 工具面对账（插件侧 vs 测试侧）

回答三个问题，全部以**实证**为准（不靠标签、不靠注释）：

1. 每个臂**实际**向模型暴露了什么工具？
2. **插件侧是否规定优先使用** `context_*`？
3. 到底是 "Read-Only" 还是 "read + rg + glob"？

| 项 | 值 |
|---|---|
| 脚本 | `eval/m5/audit-tool-surface.mjs`（只读；语料挂载到临时目录后删除） |
| 运行 | `node eval/m5/audit-tool-surface.mjs [--json]` |
| 被测插件版本 | `dsh-tool-fs 0.1.3-alpha.2`、`dsh-tool-fs-search 0.1.3-alpha.2`、`dsh-fs-sandbox 0.1.3-alpha.2` |
| 评测报告 | `node_modules/.cache/m5-eval/reports/agent-comparison.json`（未改动） |

---

## 1. 实际暴露的工具面（从 `ctx.tools.schemas()` 读回）

| 臂 | 暴露给模型的工具 | 与标签一致？ |
|---|---|---|
| `default` | `glob`, `grep`, `read` | ✅ |
| `additive` | `context_expand_source`, `context_refresh_snapshot`, `context_relation_query`, `context_repo_map`, `context_symbol_query`, `glob`, `grep`, `read` | ✅ |
| `replacement` | `context_expand_source`, `context_refresh_snapshot`, `context_relation_query`, `context_repo_map`, `context_symbol_query`, `read`（**无 grep/glob**） | ✅ |

与冻结报告的 `armLabels` 完全一致。**没有标签与实际不符的情况。**

---

## 2. 插件侧**没有**规定优先使用 —— 三条证据

| # | 检查 | 结果 |
|---|---|---|
| 1 | 本包 `src/` 中 `systemPrompt` / `promptSection` / `instructions` 引用数 | **0** |
| 2 | `src/plugin.ts` 的 `inject` | 仅 `['tools']` —— 不参与提示词组装 |
| 3 | 工具描述是否劝导优先使用 | **反向**：`context_symbol_query` 描述原文含 **"Host grep/read remain valid alternatives."** |

附加证据：

- `dsh-code-intelligence` 作为 bundle 的 `cordis.patch.yml` 只有一行裸 `insert`，**没有任何 prompt/priority 指令**。
- 真 profile `cordis.patch.yml` 里 `dsh-code-intelligence` 的条目**只有 `config` 块**，没有 `priority` / `required` / `prefer` 字段。
- 仓库内 `AGENTS.md` / `CLAUDE.md` **没有一处**提到 `context_*` 或"优先用插件"。

因此 Phase 2 中结构化工具被使用，是**模型自主选择**的结果，不是提示词驱动的。

**但描述文本另有一个副作用**（见 §4）：它极其冗长且夹带内部术语。

---

## 3. "Read-Only" 与 "read + rg + glob" **两个层面都对**，不矛盾

| 层面 | 事实 | 值 |
|---|---|---|
| 沙箱策略 | `SandboxPolicyService({ mode: 'read-only', workspaceRoot })` | **read-only**（harness 硬编码，是本实验设定） |
| FS 后端 | 挂 `SandboxedFileSystem`（**而非** `LocalFileSystem`） | 继承只读 |
| `dsh-tool-fs` 注册的工具 | 4 个 | `read` / `write` / `edit` / `read_image` |
| `dsh-tool-fs-search` 注册的工具 | 2 个，**ripgrep 后端** | `grep` → `rg --json`；`glob` → `rg --files` |
| 臂级过滤（`agent-baseline.mjs`） | 丢弃 `write` / `edit` | — |
| **实际暴露的检索面** | 报告实证 | **`read` + `grep` + `glob`** |

**"read-only" 描述文件系统权限；"read + rg + glob" 描述暴露的检索工具面。** 写工具是"注册了，但被臂过滤 **且** 沙箱本来就禁止"的双重排除（`read_image` 未注册，因为可选依赖 `attachments` 未挂载）。

**`grep`/`glob` 确实是 ripgrep**：`dsh-tool-fs-search` 依赖 `@vscode/ripgrep@^1.18.0`，实测解析到

```
…/@vscode+ripgrep-linux-x64@1.18.0/…/bin/rg
ripgrep 15.0.0 (rev 3a612f88b8)  features:+pcre2  simd(compile):+SSE2,-SSSE3,-AVX2
```

所以"default 臂 = read + rg + `rg --files`"是**字面准确**的。

### 3.1 保真度核查：测试侧是否忠实复现产品默认面

| 配置项 | 真产品（`dsh-base/cordis.patch.yml`） | harness | 一致？ |
|---|---|---|---|
| `tool-fs` 配置 | **不设** → 用插件默认 | `TOOL_FS_DEFAULTS` = 插件默认（`READ_LIMIT` 2000 / `READ_MAX_LINE_LENGTH` 2000 / `READ_MAX_BYTES` 50 KiB / `STREAM_MIN_SIZE` 10 MiB） | ✅ 逐项相等 |
| `tool-fs-search` 的 `sampleOverCapGlobResults` | **`false`**（显式写死） | `false` | ✅ |
| fs-search 各 cap | 用插件默认 | 直接引用插件导出的 `GLOB_MAX_RESULTS=100` 等常量 | ✅ |
| 沙箱模式 | 产品权限预设含 `read-only` / `workspace-write` / `danger-full-access` | 硬编码 `read-only` | ⚠️ **本实验设定**，非产品默认 |

（`sampleOverCapGlobResults` 在 fs-search 的 Config 里是 `.required()` 无默认值，所以值得单独核对——结论是**两边都是 `false`**，`glob` 超上限时都返回 mtime 序前 100 条，保真。）

---

## 4. 一处**真实的不对称**：提示词面上的工具描述体量

工具的 `description + parameters` 会在**每一次** chat-completions 请求里重发，因此是**与检索质量无关的固定开销**。

| 臂 | 检索面字符 | 结构化面字符 | 结构化占比 | 合计字符 |
|---|---|---|---|---|
| `default` | 1,987 | 0 | 0.0% | **1,987** |
| `additive` | 1,987 | 6,363 | **76.2%** | **8,350** |
| `replacement` | 392 | 6,363 | **94.2%** | **6,755** |

逐工具（description / parameters 字符数）：

```
read                      56 /  336      context_expand_source     905 / 716
grep                     269 /  450      context_symbol_query      839 / 785
glob                     407 /  469      context_relation_query    693 / 704
edit                      59 /  967      context_repo_map          683 / 518
write                     42 /  686      context_refresh_snapshot  487 /  33
```

按 `/4` 字符≈token 估算（预注册的同一估法）：

| 臂 | modelCalls | promptTokens | schema tok/次请求 | schema tok 合计 | 占 promptTokens |
|---|---|---|---|---|---|
| `default` | 169 | 207,191 | 497 | 83,993 | 40.5% |
| `additive` | 188 | 715,201 | 2,088 | 392,544 | 54.9% |
| `replacement` | 219 | 881,066 | 1,689 | 369,891 | 42.0% |

**相对于 default 的纯 schema 增量：**

| 臂 | 额外 schema tok | 占该臂总 token 增量的比例 |
|---|---|---|
| `additive` | **299,108** | **58.6%** |
| `replacement` | **261,048** | **38.2%** |

即：**`additive` 臂超过一半的成本劣势，来自工具定义文本本身，而非检索行为。**

### 4.1 这对 R2 判决的影响（敏感性分析，结论不变）

把 schema 开销**完全扣掉**后的下界：

| 臂 | 实测总 token | 扣除 schema 后 | R = 该值 / default |
|---|---|---|---|
| `default` | 219,563 | 219,563 | 1.00 |
| `additive` | 730,344 | 337,800 | **1.54** |
| `replacement` | 902,121 | 532,230 | **2.42** |

**R2（`R ≤ 0.70`）仍然失败，R6（`R > 1.0` 即证伪）仍然触发。判决方向不变，量级显著变小。**

> 该分解已在 Phase 2b 重跑中复算并成为核心结论：扣除 schema 开销后 `additive` 的 R 从 **2.138 降到 1.075**（近乎免费），而 `replacement` 仍有 **3.590**。见 `doc/m5-phase2b-results.md` §2.1。

### 4.2 描述文本里的可清理内容

`scope` 前缀被拼进**每个** `context_*` 描述：

> `M4: optional cache with immutable runtime leases. Refresh does not modify workspace source and is never cached. Native transport required; PTC structured failures unsupported.`

这是内部里程碑代号与内部术语（`M4`、`PTC`、`native transport`），对模型选择工具**无信息价值**，却按每次请求重复计费。`coverage` 前缀（AST 覆盖说明）**有**信息价值，应保留。

---

## 5. systemPrompt 保真度（已修复）

**初始状态（Phase 2 v1）**：`eval/m5/lib/harness.mjs` 把 `systemPrompt` 服务 **stub 成空实现**，真产品要注入的 5 段因此全部被丢弃；同时脚本里手写的 `SYSTEM_PROMPT` 含一句轻微倾向性：

> "Never guess: if a tool can give you the exact text, **line range, or relation**, get it."

"exact line range / relation" 恰好是 `context_*` 的强项——文本各臂相同，但对结构化工具的匹配度更高。

**修复后（Phase 2b）**：

1. 倾向性那句被删除，改为不点名任何工具/类别的四句中之前言。
2. `systemPrompt.section()` 由 no-op 改为**收集**，并按"该工具是否真的暴露"过滤后拼进 prompt（约定 `tool:<name>`，按 `order` 升序）。暴露面上没有的工具，也不会在提示里被要求使用。

真产品的 5 段（已逐字校验存在于已发布的 bundle 中，且 harness 收集到的文本与之逐字节相等）：

| 段 | order | 原文要点 | default/additive 是否转发 | replacement |
|---|---|---|---|---|
| `tool:read` | 100 | "Use the read tool — not shell commands like cat" | ✅ | ✅ |
| `tool:write` | 101 | 写文件规矩 | ❌（工具已过滤） | ❌ |
| `tool:edit` | 102 | 编辑规矩 | ❌（工具已过滤） | ❌ |
| `tool:glob` | 103 | "Use the glob tool — not shell find" | ✅ | ❌（工具已过滤） |
| `tool:grep` | 104 | "Use the grep tool — **not shell grep or rg**" | ✅ | ❌（工具已过滤） |

实测转发矩阵（`reports/tool-surface.json`，独立于模型运行）：

```
default      tool:read,tool:glob,tool:grep   999 字符
additive     tool:read,tool:glob,tool:grep   999 字符
replacement  tool:read                       476 字符
```

由于没有任何臂暴露 bash/shell，被转发的 3 段都是"别用 shell"类指令，**对模型行为是空转的**；旧版把它们丢弃属"对称缺失"，不偏袒任一臂，但已按保真度要求修复。

---

## 6. 对 Phase 2 结论的影响

> **本节结论已被 Phase 2b 重跑取代**（`doc/m5-phase2b-results.md`）。审计发现的三处偏差（工具描述体量、提示词倾向、systemPrompt 被丢弃）已全部修复，重跑后三臂准确率打平，成本差距扩大。下面保留原始敏感性分析作为方法记录。

**不改变结论方向**：R1 仍满足、R2 仍失败、R6 仍触发、`additive` 仍被 `replacement` 支配。

**新增两条可行动结论**：

1. **成本优化的最大单项抓手是工具描述精简，而不是检索算法。** 仅删掉 `scope` 内部术语前缀与 `context_refresh_snapshot`（对纯检索 agent 无用，占 520 字符）就能削掉可观比例；扣掉全部 schema 开销后 `additive` 的 R 从 3.09 降到 1.54。
2. **"插件侧强制优先使用" 这一质疑可以排除**：插件零提示词注入，且工具描述明写 "Host grep/read remain valid alternatives."。Phase 2 观察到的结构化工具使用是模型自选。

---

## 7. 复现

```bash
cd packages/dsh-code-intelligence
node eval/m5/audit-tool-surface.mjs          # 人类可读
node eval/m5/audit-tool-surface.mjs --json   # 机器可读
sha256sum eval/m5/gold.json                  # 必须仍是 cb9b7c90…
```

## 8. 边界

- schema→token 用 `/4` 估算，是**估算**，不是分词器实测；比例结论对此不敏感（即使按 `/3` 或 `/5` 缩放，`additive` 的 schema 占比仍在 45–60% 区间）。
- 本对账**不改动**任何冻结产物，**不构成** M5 验收的一部分；`doc/m5-phase2-results.md` 的判决不因 §4.1 而改写（R2 仍失败）。
- 只核对了 `web` profile（本机唯一启用该插件的 profile）。
