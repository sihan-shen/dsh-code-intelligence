# M5 Phase 2 —— 代理对照实验预登记（decision rule）

> 状态：**预登记**。本文件在**任何** Phase 2 对照臂运行之前写成；运行后的结果见
> `node_modules/.cache/m5-eval/reports/agent-comparison.json`，其结果**不得**导致本文件
> 的判定阈值被修改。若必须修改，只能在下一轮以新的预登记版本进行。

## 1. 目的与边界

回答一个可证伪的问题：在**只读检索**这一受限动作空间内，本包的 `context_*` 结构化工具
是否比 DSH 出厂的默认检索面（`read` + `grep` + `glob`）**更好**？

同时回答两个子问题：

- **Q-A（替代）**：`context_*` 能否**替代** `grep`/`glob`（即不暴露 `grep`/`glob`）而不损失正确率？
- **Q-B（叠加）**：在默认检索面之上**叠加** `context_*`，是否在正确率不降的前提下降低总 token 消耗？

**不在本实验范围内**：写代码、跑测试、多文件编辑、bash/子代理/网页/工作流等工具，以及
任何 SWE 任务级成功率。本实验是**检索问答基准**，不是 SWE-bench 类基准。

## 2. 冻结对象

| 对象 | 路径 | sha256 |
| --- | --- | --- |
| 语料锁定 | `eval/m5/corpus.lock.json` | commit `1fb56a5c18c27102dbc92260a4007c7732a0ccca`（zod `v4.4.3`） |
| 冻结 gold | `eval/m5/gold.json` | `cb9b7c90ed06cfd6a1960fdd71d77733265d21213253916d4357651c409d5237` |
| 冻结任务集 | `eval/m5/agent-tasks.json` | `a1f359f1b60f06dbdf13592b2712fdab13da2355466e9db99c1cb4f4c07052f4` |
| Phase 1 探针 | `eval/m5/baseline-grep.patterns.json` | `45d2bd66baaf9a6525089d6fe1905a48c96ed2d743e048f3be937e64f7e75a1f` |

任务集是冻结 gold 的确定性投影（`eval/m5/build-agent-tasks.mjs`），20 条：declaration 8 /
source 6 / relation 6。**所有臂收到逐字节相同的题面**；题面不提及任何工具、参数或检索策略。

被测工具的真实身份（运行时实测，写入报告）：

- `read`：`@deepseek-ai/dsh-tool-fs@0.1.3-alpha.2`
- `grep` / `glob`：`@deepseek-ai/dsh-tool-fs-search@0.1.3-alpha.2`（打包 ripgrep）
- `context_*`：本包 `lib/index.js`（`0.2.1`）

被测 bundle 均从**同一份真实 DSH profile 安装**解析（`.dsh/profiles/node_modules/`），
避免跨 peer 变体混装。

## 3. 三个臂

| 臂 | 暴露工具 | 含义 |
| --- | --- | --- |
| `default` | `read`, `grep`, `glob` | DSH 出厂只读检索面（基线） |
| `additive` | `read`, `grep`, `glob`, `context_*` | 基线 **+** 结构化（Q-B） |
| `replacement` | `read`, `context_*` | 结构化 **替代** 搜索（Q-A） |

三臂共用：同一语料副本、同一 `ToolRuntime`、同一模型、`temperature = 0`、相同的
`maxModelCalls = 8` / `maxToolCalls = 16` / `max_tokens = 1200` 上限。
排除 `write`/`edit` 与 dsh-base 的其余工具（bash、subagent、web、workflow、todo、skill），
理由：它们把动作空间扩大到远超检索，会淹没检索差异。

## 4. 终点定义

**主要终点（正确率）**

- `correct(task)`：程序化判分。`answerSpec.kind`
  - `declarationLocation`：`path` 精确 + `startLine`/`endLine` 精确
  - `pathSet`：集合相等（归一化后）
  - `sourceText`：字符串精确相等
  - `targetNameSet` / `targetStringSet`：集合相等（去重、trim、排序后比较）
- `correctRate(arm) = 通过数 / 运行数`

**共同主要终点（成本）**

- `tokensPerTask(arm)`：provider 上报的 `usage.total_tokens` / 运行数
- 使用**中位数**做判定（对长尾稳健），同时报告均值与总和
- 工具返回字节数 `toolResultBytes` 作为独立证据（不等同于 token）

**次要终点**：`modelCalls`、`toolCalls`、每工具调用分布、分类别（declaration/source/relation）
正确率与 token、墙钟时间 `ms`、冷启动索引时间（单独报告，不计入 token）。

## 5. 预登记判定规则

记 `Δacc = correctRate(additive) − correctRate(default)`，
`R = medianTokensPerTask(additive) / medianTokensPerTask(default)`。

**R1（正确率非劣，δ = 5pp）**

- `additive` 对 `default` **正确率非劣** ⟺ `Δacc ≥ −0.05`
- `Δacc < −0.05` ⟹ **叠加有害**，结论只能写"叠加损害正确率"。

**R2（成本占优，阈值 30%）**

- 在 R1 成立前提下，`additive` **成本占优** ⟺ `R ≤ 0.70`

**R3（综合结论，唯一允许的措辞）**

| 条件 | 结论措辞 |
| --- | --- |
| R1 成立且 R2 成立 | `additive` **优于** `default`（正确率非劣 + 每题 token 中位数至少降 30%） |
| R1 成立且 R2 不成立 | `additive` **不劣于** `default`，但**未观测到 ≥30% 的成本优势** |
| R1 不成立 | `additive` **劣于** `default`（正确率下降 > 5pp） |

**R4（替代臂的能力下限）**

- `replacement` 与 `default` 用同一阈值（R1–R3）。
- **能力下限**：若 `replacement` 在 relation 类别的正确率 `≤ 0.50`，则判定
  "**结构化工具无法替代默认检索面**"，即使总体 `Δacc ≥ −0.05` 也不得宣称可替代。
  理由：relation 是结构化工具的表达力主张所在，在该类别塌陷说明替代方案在真实使用中会丢失能力。

**R5（分类别报告，强制）**

- 必须分类别给出正确率与 token；**不得**只报总体。
- 若某类别的臂间 token 差 < 20%，标注"该类别无实质成本差异"。

**R6（证伪条件）**

- 若 `additive` 在正确率非劣的同时 token **更高**（`R > 1.0`），则本包的收益主张被证伪，
  必须明确写出"在代理式使用中结构化工具**增加**了开销"。
- 若三臂 `correctRate` 全部为 `1.0`，则本任务集对正确率**无区分度**，只能就 token/调用数
  下结论，且必须显式声明该局限。

## 6. 样本量与统计口径

- **正式判定要求 `N = 3` 次重复**（同一题、同一臂重复 3 次），报告每臂 60 次运行。
- **`N = 1` 只算 pilot，不得用于判定**；只能在报告中标注为"探索性"。
- 正确率差异以百分点报告；`N = 3 × 20` 下，5pp 阈值对应约 3 个任务翻转，属可观测范围，
  但**不做显著性检验**（样本量不足以支持）；因此结论只能是"**非劣/占优**"而非"显著更优"。
- token 以中位数报告，并给出四分位区间。
- 单次运行的异常（provider 报错、预算耗尽）计入 `failures`，不计入正确率分子分母。

## 7. 有效性与已知威胁

| 威胁 | 处理 |
| --- | --- |
| 稻草人风险（grep 只允许单次固定模式） | **不成立**：两臂都是真实工具循环，模型可多轮迭代 `grep`/`read`，探针模式由模型自行决定 |
| 题面偏袒结构化工具 | 题面只由 gold 请求字段机械派生，不出现 `context_*`、offset、`symbolId` 等工具概念；`build-agent-tasks.mjs` 冻结前可审计 |
| gold 由被测提取器生成 | 不成立：gold 由只读代理构建 + 父代理用原始字节与 TS AST 独立复核，且在被测提取器运行前冻结 |
| 答案可被"抄近路" | 答案必须结构化 JSON（路径/行号/精确文本/集合），无法靠复述题面得分 |
| token 口径不一致 | 统一用 provider `usage.total_tokens`；工具结果字节数另报 |
| 冷启动污染 | 每臂在计时前预热一次结构化索引；冷启动时间单独报告，不计入 token |
| 缓存导致的偏斜 | 同一臂内题目顺序固定、`temperature = 0`；不跨臂复用 provider 缓存结论 |
| 单一语料/单一模型 | 报告显式标注：结论仅适用于 zod `v4.4.3` 语料与该模型/温度 |
| 我（父代理）同时是被测方 | 判分完全程序化、阈值预登记、原始运行明细（每题的调用与 token）落盘可复核 |

## 7.1 试点后的协议修正（v1.1，正式运行之前）

`N = 1` pilot（探索性，不用于判定）暴露了一个与臂无关的机械问题：有运行以"非 JSON 文本"结束，
无法判分（`unparseable-json`）。因此在**正式 `N = 3` 运行之前**对 harness 做了唯一一处修正，
并在此预登记：

- **格式修复轮（JSON repair turn）**：若最终回复不是合法 JSON，最多追加 2 轮，要求模型仅输出
  JSON 对象；这些追加轮**计入 `modelCalls` 与 `total_tokens`**，并在明细中记录 `repairTurns`。
- 该修正对**三个臂完全相同**，不针对任何一臂的结果。

同时记录一条 pilot 发现的**构念效度威胁**（必须在正式结果中重申）：本任务集由 gold 请求字段
派生，因此 task 形状沿用了结构化工具的词汇（offset range、`paddingLines`、`pathPrefix`、
`symbolPrefix`）。这可能**系统性偏袒** `context_*` 臂。缓解措施：题面不出现工具名与工具参数；
但该偏祖无法完全消除，故结论只能表述为"在本冻结任务集上"，不得外推到全部检索场景。

## 8. 运行前声明

本文件写于 Phase 2 首次对照运行之前（`agent-comparison.json` 的 `startedAt` 必须晚于本文件
的提交时间）。运行参数固定为：

```
M5_AGENT_MODEL=deepseek-chat      # 可在报告中记录实际值
temperature=0
M5_REPEATS=3
node eval/m5/agent-baseline.mjs --repeats 3
```

**收益状态仍为 `not-ready`**：即使本实验得出"占优"，也只支持"只读检索问答"这一受限场景，
不足以宣称端到端 coding 收益、成本收益或 ROI。
