# M5 Phase 2b 预注册（公平性修复后重跑）

> 本文件在**任何模型调用之前**写就并冻结。任何在此之后的改动都必须作为新的版本追加，不能回改本节。

| 项 | 值 |
|---|---|
| 目的 | 消除 Phase 2（v1）中已识别的三处**构念效度威胁**，在**同一份冻结 gold** 上重跑三臂对比 |
| 轮次 | Phase 2b（v2 措辞）。**v1 结果保留不覆盖** |
| N | 3 次重复 × 20 任务 × 3 臂 = 180 次运行 |
| 模型 | `deepseek-chat`，`temperature 0`，`https://api.deepseek.com`（用户自有 token） |
| 主终点 | **neutral 子集准确率**（19/20 任务） |
| 次终点 | tool-shaped 子集（1/20）作为诊断，**不并入主数字** |

---

## 1. 为什么要重跑

Phase 2（v1）的四个判别性任务里，有三个的**提问措辞本身就是被测工具的请求模型**：

| 任务 | v1 措辞片段 | 问题 |
|---|---|---|
| `src-02` | "half-open UTF-16 code-unit range [13, 81)" | 偏移量是 `context_expand_source` 的参数模型；grep 侧必须自己算 UTF-16 偏移 |
| `src-03` / `src-06` | "plus N line(s) of padding on each side, clamped to the file bounds" | `paddingLines` 参数及其夹取语义 |
| `rel-04` | "List every ``calls`` relation whose source is the file X" | 既用了工具的关系类型名，其 gold 又**就是抽取器自己的启发式输出** |

外加两处非措辞性偏差：手写 system prompt 里有一句 "if a tool can give you the exact text, **line range, or relation**, get it"（更贴合结构化工具），以及 harness 把产品的 `systemPrompt` 段**整个 stub 掉**。

**这些偏差会同时抬高结构化臂、压低 grep 臂**，因此 v1 的 85.0 / 88.3 / 98.3 不能区分"能力差异"与"措辞迎合"。

---

## 2. 本轮改了什么（三处，全部已冻结）

### 修复 F4 — 提问措辞去工具化（只改 `question`）

`eval/m5/build-agent-tasks.mjs` 增加 `QUESTION_V2` 覆盖表，改写 **9 个**任务的问法：

```
src-02  → "the declaration of the exported constant `version`, excluding the leading
           `export const ` and excluding the trailing semicolon"
src-03  → "lines 4 through 7 (1-based, inclusive), including the line terminator"
src-06  → "the complete source text of the file ..., including the final line terminator"
rel-01  → "the module specifier of every module that the file imports from"
rel-02  → "what the file exports to its consumers: ... module specifier ... exported name"
rel-03  → "the enum ... list the name of every member it declares"
rel-04  → "ignore every import/export declaration; for the remaining executable
           statements, list the name of every function that is called there"
rel-05  → "the module specifier of every module that the file imports from. If the file
           imports nothing at all, return an empty array"
rel-06  → "the name of every declaration that the file exports, including type-only exports"
```

**答案零改动。** 三个改写都经语料字节复核与原 gold 逐字节相等：

| 任务 | 改写后的独立判定 | 与原 gold |
|---|---|---|
| `src-02` | `versions.ts` 去掉 `export const ` 前缀与结尾 `;` | **IDENTICAL** |
| `src-03` | `config.ts` 第 4–7 行含各行的换行符 | **IDENTICAL** |
| `src-06` | `versions.ts` 全文 | **IDENTICAL** |
| `rel-04` | `v4/classic/external.ts:11` 的 `config(en());` → `config`, `en`（可从原始字节直接判读） | 与 gold 集合相等 |

生成器内建断言 `--verify-against eval/m5/agent-tasks.v1.json`，校验 **20/20 个 `answerSpec` 逐字节不变、无任务增删**；已通过。

### 修复 F1 — system prompt 去偏

删除 "if a tool can give you the exact text, line range, or relation, get it"，改为不点名任何工具/类别的四句中性前言。

### 修复 F2 — 转发产品真实的 `systemPrompt` 段

harness 的 `systemPrompt.section()` 由 **no-op 改为收集**，并按"该工具是否真的暴露"过滤后拼进 prompt（`tool:<name>` 约定，`order` 升序）。dry-run 实测：

| 臂 | 注册的段 | 实际转发 |
|---|---|---|
| `default` | read/write/edit/glob/grep | read, glob, grep（999 字符） |
| `additive` | 同上 | read, glob, grep（999 字符） |
| `replacement` | 同上 | read（476 字符） |

这样"暴露面上没有的工具，也不会在提示里被要求使用"。

### 顺带修复 F7 — 保留完整原始作答

`detail[].finalText` 现在保存**完整**回复（原先只有 200 字符预览），使事后复核不必重跑模型。

---

## 3. 本轮**没有**改什么（保证可比性）

| 项 | 状态 |
|---|---|
| `eval/m5/gold.json` | 未改，sha256 仍为 `cb9b7c90ed06cfd6a1960fdd71d77733265d21213253916d4357651c409d5237` |
| 语料 | 未改（同 commit、同 286 文件） |
| 三臂定义、`read`/`grep`/`glob` 挂载方式、`write`/`edit` 排除 | 未改 |
| 判分逻辑（全等/集合全等、无部分分、大小写敏感） | 未改 |
| 预算（8 model calls / 16 tool calls / 1200 output tokens） | 未改 |
| JSON 修复轮（v1.1 预注册） | 未改，仍对各臂一致 |

**已知仍未修复项（本轮不覆盖）**：`context_*` 的工具描述体量（6,363 字符）仍是三臂间固定开销差；削减它会改动已通过 M5 验收的产品源码与 tarball，属产品决策，不在本轮范围内。该项已在 `doc/m5-tool-surface-audit.md` 量化并做敏感性分析（扣除后 R 1.54 / 2.42）。

---

## 4. 冻结哈希（运行前）

| 产物 | sha256 |
|---|---|
| `eval/m5/gold.json` | `cb9b7c90ed06cfd6a1960fdd71d77733265d21213253916d4357651c409d5237` |
| `eval/m5/agent-tasks.v1.json`（存档） | `a1f359f1b60f06dbdf13592b2712fdab13da2355466e9db99c1cb4f4c07052f4` |
| `eval/m5/agent-tasks.json`（v2，本轮使用） | `b5d725943640f7fe22ec1509909ed8da2d1a3553ba93a687c77825a1d46e5ff1` |

## 4.1 运行后追加（不改上文）

- 完成时间：见报告 `startedAt`/`finishedAt`。
- 实际运行 **2 次独立复制**（首轮 + 为修正报告字段命名而重跑的一轮），合计 360 次运行，0 次 harness 失败。预注册只要求 1 轮 N=3；第 2 轮作为免费重复性证据，两轮结论一致。
- 报告：`agent-comparison-v2-run1.json`、`agent-comparison-v2.json`。
- 结果与解读：`doc/m5-phase2b-results.md`。

---

## 5. 假设与判决规则（运行前冻结）

主终点 = **neutral 子集**（19 任务）准确率；按任务做多数票聚合后再比较（聚类感知），不用运行级池化。

| # | 假设 | 判决规则 | 结果 |
|---|---|---|---|
| **H1** | 措辞去偏后，替换臂仍不劣于默认臂 | `replacement_neutral ≥ default_neutral − 5pp` | ✅ 成立：100.0% vs 99.2% |
| **H2** | v1 的差距**部分**来自措辞迎合 | 在 9 个被改写任务上，`default` 的 v2 准确率 **高于** v1；`replacement` 不再 ≥ `default` + 20pp | ✅ 成立且强于预期：4 个判别任务全部翻为 3/3 |
| **H3** | 成本劣势不因措辞消失 | `R = replacementTokens / defaultTokens > 0.70` 仍成立 | ✅ 成立：R = 3.987（additive 2.138） |
| **H4** | v1 的支配关系结论稳定 | `additive` 的 neutral 准确率仍不优于 `replacement`（差 ≤ 5pp） | ✅ 成立：两者均 100% |

> 上表**结果**列为运行后填写；假设、判决规则与证伪条件在本文件冻结时已写定，未作修改。

**证伪条件**：若 H2 成立且四个原判别任务（`src-02/03/06`、`rel-04`）在 `default` 臂上从 v1 的 1/3、2/3、0/3、0/3 显著上升到 ≥ 3/3，则 v1 的"结构化工具能力优势"应被判定为**主要是措辞人为产物**，Phase 2 的能力结论作废。若这些任务在 v2 下仍失败，则差距是真实的能力/成本差异。

**不因本轮改动而改变的上游结论**：gold、M5 验收（Task 1–5）、Task 4 tarball、Phase 1 grep 基线、Phase 3 语义探针。收益状态继续为 `not-ready`。

---

## 6. 复现

```bash
cd packages/dsh-code-intelligence
node eval/m5/build-agent-tasks.mjs --verify-against eval/m5/agent-tasks.v1.json
sha256sum eval/m5/agent-tasks.json   # 必须是 b5d72594…
node eval/m5/agent-baseline.mjs --dry-run
node eval/m5/agent-baseline.mjs --repeats 3 \
  --out node_modules/.cache/m5-eval/reports/agent-comparison-v2.json
```

`--out` 默认写 `agent-comparison.json`；本轮显式写 `agent-comparison-v2.json`，**不覆盖** v1 报告。

---

## 7. 边界

- v2 与 v1 是**两次不同实验**。两轮的任务文本不同，跨轮比较只能用于 H2 的方向性判断，不能相加或合并统计。
- 剩余构念威胁仍在：任务由 gold 派生，因此"要找什么"仍由 gold 的字段决定；`read` 工具的挂载方式比真产品更宽松（沙箱固定 `read-only`，无 `workspace-write` 预设）。
- 主终点仍是"检索 QA"，不是 SWE 任务；不测改代码能力。
- 收益状态：`not-ready`。本轮**不构成** M5 验收证据。
