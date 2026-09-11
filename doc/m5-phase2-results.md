# M5 Phase 2 —— 代理对照实验结果（历史 v1，已撤销）

> **当前状态**：v1 准确率结论不可引用。v2 提示审计已证明原始差异受构念/措辞影响；修复后的 harness 另行输出 ITT、protocol、三层任务、category macro、task-majority、token median/IQR 与三臂 pairwise bootstrap。

> **历史结果说明**：本页数字来自 session/corpus/计数审计增强之前的 harness。旧运行跨题复用
> 一个 Session source budget，未逐臂验证 corpus 副本，也未逐模型调用记录 schema 是否发送；
> arm/task 顺序还固定不变，使 provider 时间漂移与 arm 混杂。数字保留用于审计，不能视为修复后
> harness 的正式结果；不得根据代码修复伪造或调整数字。
>
> ⚠️ **本文件全部准确率/泛化结论已撤销，请勿单独引用；历史数字仅作审计追溯。****
>
> v1 的 9 个任务使用了被测工具自用的语汇（UTF-16 半开偏移、`paddingLines`/夹取、`` `calls` relation ``），
> 因此把"能否照抄工具的请求模型"混入了"能否找到事实"。Phase 2b 只改问法、不动任何答案，重跑后
> `default` 从 85.0% 升到 **99.2%**，`replacement` 为 **100.0%**，v1 的四个判别任务全部由失败翻为 3/3。
>
> **仍然有效的部分**：成本测量（token/tool-call 数量级）、基线等价性分析、以及
> `rel-04` 的循环性说明——这些不依赖措辞。修订后的核心结论是"准确率无可检测差异，默认面便宜 2.1–4.0 倍"。


> **性质**：附属评估，**不是** M5 验收证据，也不构成 ROI / coding 收益结论。
> 判定阈值在运行前预登记于 `doc/m5-phase2-preregistration.md`（v1.1），本文件只**套用**该规则、
> 不修改它。原始数据：`node_modules/.cache/m5-eval/reports/agent-comparison.json`
> （探索性 `N = 1` pilot 同期留存为 `agent-comparison-pilot-n1.json`）。

## 1. 一句话结论

在本冻结任务集上，`context_*` **显著提升正确率**（`replacement` 98.3% vs `default` 85.0%），
但**每题 token 中位数升到 3.1–4.6 倍**，因此按预登记规则 **R2 不成立**，且触发 **R6 证伪**：
在代理式使用中，结构化工具**增加**而非降低模型侧开销。

**收益状态仍为 `not-ready`**：正确率提升是真实的，但没有成本优势，且证据只覆盖只读检索问答。

## 2. 运行配置

| 项 | 值 |
| --- | --- |
| 模型 / 温度 | `deepseek-chat` / `0` |
| provider | 用户自有 DeepSeek 官方 API（凭据仅读入进程内存，报告中只记录来源，不记录值） |
| 重复数 | `N = 3`（每臂 60 次运行；`N = 1` 只作 pilot） |
| 上限 | `maxModelCalls = 8`、`maxToolCalls = 16`、`max_tokens = 1200`（三臂相同） |
| 任务集 | `eval/m5/agent-tasks.json` sha256 `a1f359f1…`（20 题：declaration 8 / source 6 / relation 6） |
| gold | sha256 `cb9b7c90…`（未改动） |
| 语料 | zod `v4.4.3` @ `1fb56a5c…`（每臂独立临时副本） |
| 被测包 | `read` `dsh-tool-fs@0.1.3-alpha.2`；`grep`/`glob` `dsh-tool-fs-search@0.1.3-alpha.2`；`context_*` 本包 `0.2.1` |
| 失败运行 | `0` |

## 3. 主要结果

### 3.1 正确率（主要终点，60 次运行/臂）

| 臂 | 正确 | 正确率 | Wilson 95% CI | 相对 `default` |
| --- | --- | --- | --- | --- |
| `default`（`read`+`grep`+`glob`） | 51/60 | **85.0%** | 73.9%–91.9% | — |
| `additive`（`+context_*`） | 53/60 | **88.3%** | 77.8%–94.2% | **+3.3 pp** |
| `replacement`（`context_*` 替代搜索） | 59/60 | **98.3%** | 91.1%–99.7% | **+13.3 pp** |

`N = 3 × 20` 不足以做显著性检验；`default` 与 `additive` 的置信区间大幅重叠，
**两者的正确率差异不可判定**。`replacement` 与 `default` 的差异更大，但仍不做显著性声称。

### 3.2 成本（共同主要终点）

| 臂 | token 总量 | 每题中位数 | IQR（P25–P75） | 均值 | 工具调用 | 模型调用 | 工具返回字节 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `default` | 219,563 | **3,471** | 2,213–4,046 | 3,659 | 138 | 169 | 80,599 |
| `additive` | 730,344 | **10,742** | 7,565–17,909 | 12,172 | 152 | 188 | 246,020 |
| `replacement` | 902,121 | **16,039** | 11,289–16,833 | 15,035 | 170 | 219 | 397,268 |

单次工具调用平均返回字节：`default` 584 B、`additive` 1,619 B、`replacement` 2,337 B。
结构化工具单次返回体量约为 `grep` 的 **4 倍**，且模型还要多花一轮（先 `context_symbol_query`
解析 `symbolId`，再 `context_relation_query`）。

### 3.3 分类别（R5：强制分类别报告）

| 类别 | `default` | `additive` | `replacement` |
| --- | --- | --- | --- |
| declaration | 24/24，中位 3,818 tok | 24/24，中位 8,956 tok | 24/24，中位 11,273 tok |
| source | **12/18**，中位 2,043 tok | **11/18**，中位 5,324 tok | **17/18**，中位 16,451 tok |
| relation | **15/18**，中位 3,544 tok | **18/18**，中位 18,809 tok | **18/18**，中位 16,771 tok |

- **表达力差异所在**：`relation` 与 `source`。`rel-04-calls-heuristic` 上 `default` 是 **0/3**
  （`grep` 无法从文本稳定恢复调用边），`src-06-padding-clamped` 上 `default` 是 **0/3**。
- **declaration 类别无正确率区分度**：三臂均 24/24，只有成本差异（R6 的"无区分度"情形在该类别成立）。
- **`additive` 被支配**：它付出结构化成本（中位 10,742 tok），却比 `replacement` 正确率更低
  （88.3% vs 98.3%），且在 `src-03` 上比 `default` **更差**（0/3 vs 2/3）。
  可解释为同时暴露两套检索面让模型在两条路径间摇摆。
  **工程含义：若要采用 `context_*`，应"替代"而非"叠加"。**

## 4. 预登记规则套用

| 规则 | 判定 | 依据 |
| --- | --- | --- |
| R1 `additive` 正确率非劣（δ = 5pp） | **成立** | Δacc = +3.3 pp ≥ −5 pp |
| R2 `additive` 成本占优（R ≤ 0.70） | **不成立** | R = 10,742 / 3,471 = **3.09** |
| R3 措辞 | 「`additive` **不劣于** `default`，但**未观测到 ≥30% 的成本优势**」 | |
| R1 `replacement` 正确率非劣 | **成立** | Δacc = +13.3 pp |
| R2 `replacement` 成本占优 | **不成立** | R = 16,039 / 3,471 = **4.62** |
| R4 `replacement` 能力下限（relation ≤ 50% 即判定不可替代） | **未触发** | relation 18/18 = 100% |
| R6 证伪条件（R > 1.0 即须写明"增加开销"） | **触发（两臂）** | R = 3.09 与 4.62 |

**唯一允许的总结措辞**：在本冻结任务集上，`context_*` 提升正确率、但不降低成本；替代臂在能力上
足以覆盖默认检索面（R4 未触发），代价是每题约 4.6 倍 token。

## 5. 冷启动

结构化臂首次调用前需建索引：`additive` 2,071 ms、`replacement` 2,118 ms（286 文件）。
该开销与题目数无关，题目越多摊薄越明显；上表 token 数字**不含**索引时间。`default` 无冷启动。

## 6. 构念效度与限制（必须随结论一起引用）

1. **任务集由 gold 请求字段派生**，因此形状沿用了结构化工具的词汇（offset range、
   `paddingLines`、`pathPrefix`、`symbolPrefix`）。这可能**系统性偏袒** `context_*`。
   - **敏感性检验（去掉两个 offset 形状的 source 题 `src-02`/`src-04`）**：
     `default` 47/54 = 87.0%，`additive` 48/54 = 88.9%，`replacement` 54/54 = 100.0% —— 结论不变。
   - **敏感性检验（去掉全部 source 题）**：`default` 39/42 = 92.9%，`additive` 42/42 = 100%，
     `replacement` 42/42 = 100% —— `default` 在 relation 上仍失分，结论方向不变。
2. **只读检索问答基准，不是 SWE 任务基准**：不测改代码、跑测试、多文件编辑。
3. **单一语料（zod `v4.4.3`）、单一模型（`deepseek-chat`）、单一温度（0）**：
   不得外推到其他仓库、模型或温度。
4. **动作空间被刻意收窄**：三臂都不暴露 bash / 子代理 / 网页 / 工作流。真实 DSH 默认面更宽，
   真实会话中模型可能用 bash 直接完成同样的检索，本实验**没有**度量那条路径。
5. **`N = 3` 只能支持"非劣 / 不劣"级结论**，不支持"显著更优"。
6. **不测缓存命中、并发、多会话复用索引**；冷启动只测量一次。

## 7. 反驳的假设

本实验**证伪**了"结构化检索能在代理式使用中省 token"这一朴素预期：数据方向相反。
它**支持**一个较窄的主张：结构化检索在 `relation`（尤其调用边）与精确文本切片上**扩展了能力**，
且其成本在"只读检索问答"口径下无法被 token 收益抵消。

## 8. 复现

```bash
# 冻结任务集（确定性投影；不应改变哈希）
node eval/m5/build-agent-tasks.mjs

# 不调用模型，只打印三臂工具面与来源
node eval/m5/agent-baseline.mjs --dry-run

# 单题冒烟
node eval/m5/agent-baseline.mjs --arm default --task decl-02-function-unique

# 正式运行（需要 DeepSeek 官方 API 凭据；绝不写入产物）
node eval/m5/agent-baseline.mjs --repeats 3
```

凭据来源：`DEEPSEEK_API_KEY` 环境变量，或 `.dsh/.credentials.yaml` 的
`refs.DEEPSEEK_API_KEY`（报告中只记录 `provider.apiKeySource`，不记录密钥值）。
