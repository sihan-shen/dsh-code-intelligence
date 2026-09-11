# M5 Phase 2b 结果（公平性修复后的重跑）

> **历史结果说明**：以下数字来自 session/corpus/计数审计增强之前的运行，未因后续 harness
> 修复而重算。旧运行跨题复用了一个 Session source budget、未逐臂验证 corpus 副本，且固定按
> `default → additive → replacement` 和固定 task 顺序整臂运行，provider 时间漂移与 arm 完全混杂；
> 因此这些数字只能作为历史观察，不是修复后 harness 的正式结果。必须另行预注册并重跑，不能用
> 代码修复推算或改写本页数字。
>
> 预注册：`doc/m5-phase2b-preregistration.md`（运行前冻结）。
> 本轮**推翻**了 Phase 2（v1）关于准确率的核心结论。v1 报告保留不覆盖：`agent-comparison.json`。
>
> **宿主一致性补充（不改历史数字）**：事后审计发现该历史运行把本包的
> `dsh-tools`/`dsh-session@0.1.2-rc.1` 与 profile FS `0.1.3-alpha.2` 混装。新 harness
> 已改为让整个宿主使用单一 profile 0.1.3 graph，并将 context bundle 的 DSH externals
> 以内存 ESM bridge 映射到同一 canonical peer identity；启动时不一致即 fail closed。
> 因此本页结果属于旧宿主，不能冒充修复后的复现实验。

| 项 | 值 |
|---|---|
| 任务集 | `eval/m5/agent-tasks.json`（v2 措辞）sha256 `b5d725943640f7fe22ec1509909ed8da2d1a3553ba93a687c77825a1d46e5ff1` |
| gold | 未改，sha256 `cb9b7c90ed06cfd6a1960fdd71d77733265d21213253916d4357651c409d5237` |
| 报告 | `agent-comparison-v2-run1.json`（预注册首轮）、`agent-comparison-v2.json`（复制轮） |
| 规模 | 2 次独立复制 × N=3 × 20 任务 × 3 臂 = **360 次运行**，0 次 harness 失败 |

---

## 1. 头条结论

**v1 观察到的"结构化工具准确率更高"完全是指令措辞造成的假象。**

> **审阅修正（不改上表数字）**："完全是指令措辞"的归因过强。本轮同时启用了三项提示构念修复——
> F1 中性前言、F2 转发产品真实 `systemPrompt` 段、F4 提问措辞去工具化（见
> `doc/m5-phase2b-preregistration.md` §2）——它们都改变模型看到的提示，本轮设计无法拆分各自
> 贡献。准确说法是："v1 的准确率优势主要是**提示构念修复合集**的产物，而非稳定的结构化工具能力
> 优势"。
>
> **主终点口径**：下表 "v2 准确率（360 次运行）" 列是**运行级池化**，而且把两轮复制合并计数；
> 预注册 §5 的主终点是**单轮 N=3 内按任务多数票**，§7 又规定两轮复制不得合并。按冻结的单轮
> 口径分别重算，`agent-comparison-v2.json` 与首轮 `agent-comparison-v2-run1.json` 各自 neutral
> 子集（19 题）三臂均为 **19/19 = 100.0%**；round-2 `default` 的池化 56/57 只来自 `decl-01`
> 在 3 次中失败 1 次（2/3，其任务多数票仍正确，与上表 "任务多数票 20/20" 一致）。修复后的
> `agent-baseline.mjs` 输出 `byVocabulary.neutralMajority` 作为主终点。

把 9 个使用被测工具自用语汇的提问改成普通话术后：

| 臂 | v1 准确率 | **v2 准确率（360 次运行）** | 任务多数票 |
|---|---|---|---|
| `default`（`read`+`grep`+`glob`） | 51/60 = 85.0% | **119/120 = 99.2%** | 20/20 |
| `additive`（+ `context_*`） | 53/60 = 88.3% | **120/120 = 100.0%** | 20/20 |
| `replacement`（`read`+`context_*`） | 59/60 = 98.3% | **120/120 = 100.0%** | 20/20 |

v1 的四个"判别性任务"在两轮 v2 中的逐格变化：

| 任务 | v1 `default` / `additive` / `replacement` | v2（两轮一致） |
|---|---|---|
| `src-02` | 1/3 · 2/3 · 2/3 | **3/3 · 3/3 · 3/3** |
| `src-03` | 2/3 · 0/3 · 3/3 | **3/3 · 3/3 · 3/3** |
| `src-06` | 0/3 · 0/3 · 3/3 | **3/3 · 3/3 · 3/3** |
| `rel-04` | 0/3 · 3/3 · 3/3 | **3/3 · 3/3 · 3/3** |

**每一个曾经失败的格子都变成了 3/3，且没有任何格子变差。** 全部 360 次运行里只剩 **1 个**非一致格子：`default` 在 `decl-01-variable-same-name-set` 上 5/6（漏掉 `v4/classic/tests/jitless-allows-eval.test.ts`——该样本要求在**同名多文件**里找齐，本就是唯一的困难样本）。

对那唯一的判别对做精确 McNemar：只有 1 个不一致对 → **p = 1.0**。**准确率上检测不到任何差异。**

---

## 2. 成本：结论不但没变，反而更锐利

既然准确率打平，成本就是唯一的差异来源。两次复制合计：

| 臂 | 总 token | modelCalls | toolCalls | R = 该臂/默认 | 冷启动 |
|---|---|---|---|---|---|
| `default` | 456,603 | 311 | 230 | **1.000** | 0 ms |
| `additive` | 976,188 | 312 | 246 | **2.138** | ~1.93 s |
| `replacement` | 1,820,567 | 436 | 338 | **3.987** | ~2.07 s |

**在准确率相同的条件下，默认检索面比 `additive` 便宜 2.1 倍、比 `replacement` 便宜 4.0 倍**，并且不需要 ~2 秒的索引冷启动。

### 2.1 成本分解：`additive` 的劣势几乎全是工具描述体量

当次请求携带工具定义时，工具 schema 会重发（见 `doc/m5-tool-surface-audit.md`）。旧报告没有
逐调用保存该标志，且旧 JSON repair 请求不带 schema，因此下表按全部 `modelCalls` 推算的 schema
合计会高估 repair turn 的 schema 开销；保留原数字仅供历史复核，不应作为精确校正值：

| 臂 | schema token/请求 | schema 合计 | 占总 token | 扣除 schema 后的 token | **R_adj** |
|---|---|---|---|---|---|
| `default` | 497 | 154,567 | 33.9% | 302,036 | 1.000 |
| `additive` | 2,088 | 651,456 | **66.7%** | 324,732 | **1.075** |
| `replacement` | 1,689 | 736,404 | 40.4% | 1,084,163 | **3.590** |

`additive` 有 **三分之二**的 token 花在重复发送它自己的工具定义上。**如果把描述精简掉，`additive` 几乎与默认等价（1.075×）。** 相反，`replacement` 即便免除 schema 开销仍有 **3.59×** —— 它的成本来自真实检索行为（`context_repo_map` 157 次、`context_expand_source` 92 次），不是描述长度。

这是一条**可执行的**产品结论：`additive` 路线是可行且近乎免费的，前提是把 `context_*` 的描述从 6,363 字符压下来；`replacement` 路线在成本上不划算。

### 2.2 工具使用分布（两次复制合计）

```
default      grep 71 · read 131 · glob 28
additive     grep 62 · read 126 · glob 40 · context_repo_map 9 · context_symbol_query 6 · context_expand_source 3
replacement  context_repo_map 157 · context_expand_source 92 · context_symbol_query 60 · read 21 · context_relation_query 8
```

值得注意的是：`additive` 臂里模型**几乎不用** `context_*`（18 次 vs 228 次 grep/read/glob）——它有得选，然后选了 grep。这独立佐证了"不存在能力落差"。

---

## 3. 判决表（对照预注册 §5）

| # | 假设 | 判决 | 说明 |
|---|---|---|---|
| **H1** | 去偏后 `replacement` 仍不劣于 `default` − 5pp | ✅ **成立** | 100.0% vs 99.2%，差 0.8pp，p=1.0 |
| **H2** | v1 的差距部分来自措辞迎合 | ✅ **成立（比预期更强）** | 4 个判别任务全部由失败翻为 3/3；`default` 85.0%→99.2% |
| **H3** | 成本劣势不因措辞消失 | ✅ **成立** | R = 2.138 / 3.987，均 ≫ 0.70 |
| **H4** | `additive` 仍不优于 `replacement` | ✅ **成立** | 两者均 100%，平手 |

**预注册 §5 的证伪条件命中了。** 原文：

> 若 H2 成立且四个原判别任务在 `default` 臂上从 v1 的 1/3、2/3、0/3、0/3 显著上升到 ≥ 3/3，则 v1 的"结构化工具能力优势"应被判定为**主要是措辞人为产物**，Phase 2 的能力结论作废。

实测正是 3/3、3/3、3/3、3/3。**因此 Phase 2（v1）的准确率结论作废。**

---

## 4. 对既有结论的影响

| 结论 | 状态 |
|---|---|
| "`replacement` 比 `default` 准 13.3pp / 高 5.1 倍胜率" | ❌ **撤回**，措辞人为产物 |
| "`additive` 比 `default` 准 3.3pp" | ❌ **撤回**，同上 |
| "三臂在公平提问下准确率不可区分" | ✅ **新增**（99.2% vs 100%，p=1.0） |
| "结构化工具在公平条件下带来 2.1–4.0× token 成本，无准确率回报" | ✅ **新增（核心结论）** |
| "`additive` 的成本几乎全是工具描述体量，精简后近似免费" | ✅ **新增** |
| Phase 3 语义探针结论（声明层零分歧、`calls` 边 100% 不可 join、星号导出 2→249） | ✅ 不受影响（不同实验） |
| M5 Task 1–5 验收、tarball、Phase 1 grep 基线 | ✅ 不受影响（未改产品源码） |

---

## 5. 局限（必须随结论一起读）

1. **天花板效应**：v2 下三臂都是 20/20（任务多数票），**这套 20 样本已经饱和，不再具备区分能力**。因此本轮**不能**断言两者"能力等价"，只能说"在这 20 个样本上检测不到差异"。
2. **样本量**：全部 360 次运行只出现 1 个不一致格子。要把 0.8pp 的差距做成统计显著，需要的工作量在数量级上不可行；正确表述是"无可检测差异"。
3. **任务由 gold 派生**："要找什么"仍由 gold 字段决定，只是措辞改为中立。这不是任意用户提问的分布。
4. **`src-04` 仍是 tool-shaped**：零宽范围没有自然语言对应物（"第 1 行末尾与第 2 行开头之间"在普通话术下会读成换行符，而 gold 是空串）。它保留为诊断项，**不计入主数字**；因为三臂都 3/3，不影响结论。
5. **沙箱比真产品宽松**：固定 `read-only`，无 `workspace-write`/`danger-full-access` 预设。
6. **未测**：模型是否会在真实（非 benchmark）多轮任务中改变工具选择偏好；`additive` 的 18 次 `context_*` 调用是在"有退路"下发生的。
7. 收益状态仍为 **`not-ready`**。本文件是工程证据，**不是** M5 验收的一部分。

---

## 6. 复现

```bash
cd packages/dsh-code-intelligence
node eval/m5/build-agent-tasks.mjs --verify-against eval/m5/agent-tasks.v1.json
node eval/m5/agent-baseline.mjs --dry-run
node eval/m5/agent-baseline.mjs --repeats 3 --out node_modules/.cache/m5-eval/reports/agent-comparison-v2.json
node eval/m5/audit-tool-surface.mjs
```

两轮复制均以 `temperature 0`、同一模型、同一冻结任务集运行；报告内 `provider.apiKeySource` 只记录凭据来源路径，**从不写入 token 本身**。
