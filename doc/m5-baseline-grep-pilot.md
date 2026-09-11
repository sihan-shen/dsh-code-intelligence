# M5 Phase 1 — 默认检索（grep）基线试点

状态：**工程试点（engineering pilot）**。本文不构成收益 / ROI 结论；收益状态仍为
`not-ready`。这里只回答一个工程问题：在冻结语料上，DSH 默认检索工具（`grep`）与
本包的 `context_*` 结构化工具，在**同一探针、同一语料、同一 ToolRuntime** 下各自
能定位到什么、代价是多少。

## 1. 为什么这样做

M5 的 20 条冻结 gold 只证明「结构化抽取结果正确」，不证明「比默认检索更好」。
要谈收益，必须先有一个**未被 gold 调优**的默认检索基线。Phase 1 就是把这个
基线固定下来：不用模型、只做静态检索对比，先把两臂的检索面与代价测清楚。

## 2. 公平性约束（已执行）

| 约束 | 做法 |
| --- | --- |
| 探针不得从答案反推 | 只从任务输入（symbol 名、任务给出的路径 / pathPrefix、关系端点的路径或名字）机械派生 |
| 探针先冻结 | `eval/m5/baseline-grep.patterns.json` 在任何一次运行前写好，sha256 记入报告 |
| grep 不得看 gold | harness 只在**评分阶段**读 gold，构造探针阶段不读 |
| 双方各自在真实产品代码上跑 | `grep` 走 `@deepseek-ai/dsh-tool-fs-search@0.1.3-alpha.2`（打包的 ripgrep）；`context_*` 走 `lib/index.js` |
| 同一运行时 | 二者挂在同一个真实 `ToolRuntime` + `SessionStore` + `WorkspaceRegistry` 上，经由同一个 `ctx.tools.execute` 调用 |
| 不污染锁定语料 | harness 先把语料拷到临时目录，在副本上跑（grep 只读，结构化臂可能写快照） |
| 唯一的替身 | subprocess 进程缝（`node:child_process` 适配 `ctx.subprocess.spawn` 契约）；argv 构造、执行、解析、上限、留白、渲染全部是真实代码 |
| 不新增依赖边 | harness 从本工作区**已安装**的真实产品包（DSH base profile 的传递依赖）解析 `@deepseek-ai/dsh-tool-fs-search` 并导入，不写入共享的 root `pnpm-lock.yaml` |

冻结哈希：

```
probes  sha256:45d2bd66baaf9a6525089d6fe1905a48c96ed2d743e048f3be937e64f7e75a1f
gold    sha256:cb9b7c90ed06cfd6a1960fdd71d77733265d21213253916d4357651c409d5237
```

被测 bundle 版本由运行时实测记录在报告 `grepTool.version`：本工作区解析到的是 DSH profile 中的
`@deepseek-ai/dsh-tool-fs-search@0.1.3-alpha.2`（`.dsh/profiles/node_modules/...` →
`upstream/deepseek-harness/apps/cli/node_modules/...`；根 store 中也存在 `0.1.2-rc.1`，但未被本基线使用）。

## 3. 度量口径

- `located`（检索面）：grep 臂 = 有返回行与 gold 目标 span/文件/端点**行级重叠**；
  结构化臂 = `context_*` 返回的非错误结果与 gold 期望**结构相等**（声明数、source 文本、
  关系条数）。两者的严格程度不同，这一点本身就是结论的一部分，不能把 `20/20` 当成等价。
- `cost`：模型可见的 `ContentBlock` 文本 UTF-8 字节数。
- `tokensEst`：`ceil(bytes / 4)`，不是 provider 分词器。
- 声明臂额外记 `matches` 与 `sortedFirstIsTarget`（按 `(path, lineNumber)` 排序后首条是否命中）。

## 4. 结果（单次观测，Node v26.8.2，20 样本）

| 维度 | grep（默认检索） | `context_*`（本包） |
| --- | --- | --- |
| 检索面 `located` | 20/20 | 20/20 |
| 平均模型可见字节 | 497 B | 1198 B |
| 平均单次耗时 | ~15–22 ms（多次观测） | ~4–6 ms（已建索引） |
| 冷启动 | ~4–6 ms（不建索引） | 冷 repo-map ~1.7–2.7 s（含 286 文件建索引），之后 ~1 ms |
| 声明臂字节 / 返回条数 | 8058 B / **143 条**（gold 目标共 10 个） | 11714 B / 精确匹配 |
| 声明臂 top-1 命中 | **6/8** | 8/8（按构造精确） |
| source 臂字节 | 1213 B + **必须再整读 5545 B** | 2651 B |
| relation 臂字节 | 667 B（只是语句行） | 9604 B（结构化边） |

逐样本明细见 `node_modules/.cache/m5-eval/reports/baseline-grep.json`。

## 5. 观察

**O1. 「能定位」不等于「能回答」。** 两臂都能在 20 个样本上「找到东西」，
但 grep 返回的是**行**，不是**结构**。声明臂 grep 返回 143 条命中去覆盖 10 个 gold
目标；关系臂 grep 只能给出 `import`/`export`/调用形态的语句行，无法直接给出边。
把两臂都写成 `20/20` 会抹掉这个差别，因此报告把 grep 的 `located` 明确定义为
「检索面命中」而非「结构等价」。

**O2. 歧义是默认检索的主要成本。** 声明臂 grep 的信噪比最低到 `1/100`
（`$ZSF` 在 `v4/core` 下 100 条命中，只有 1 个是目标）；按确定性排序后首条命中目标的
只有 **6/8**（`$ZSFObjectProperties`、`Red` 两条首条不是目标）。这意味着模型还要做
消歧，而每消歧一次候选通常要再读一次文件。

**O3. grep 无法表达范围与类型语义。** `src` 样本要求精确字节范围（含 padding 语义），
grep 给不出范围，只能把整个文件读回来 —— 报告把这次**必然的整读 5545 B** 单独列出，
因为它是默认检索在 source 场景下的真实代价。零边关系（`rel-05`）grep 只能靠「没有匹配」
来回答正确；它没有正向证据，也没有边类型。

**O4. 两臂的成本结构相反。** grep 零启动、按次付费（~19 ms/次，字节少但歧义大）；
结构化臂一次性建索引（本次 2727 ms / 286 文件），之后每次查询 ~5 ms、字节更多但确定。
在「一次会话里大量查询同一仓库」的场景，索引摊薄后结构化臂更省；在「一次性单点查询」
的场景，grep 更省。**当前数据不足以给出交叉点，Phase 1 不声称任何一侧更优。**

**O5. grep 的返回顺序不稳定。** 同一次探针多次运行，首个命中即目标的样本在 5/8
与 6/8 之间摆动（ripgrep 并行遍历）。因此 `grepTop1` 仅供参考，报告同时给出按
`(path, lineNumber)` 排序的确定性指标 `grepSortedTop1 = 6/8`。

## 6. 这批数据**不能**得出的结论

- 不能得出「本包比 grep 有收益」：没有模型参与，没有任务成功率、tokens-to-success、
  tool-call 数或端到端时延。
- 不能外推到其它仓库或语言：只有 Zod 一个仓库、只有 `.ts`。
- 不能作为定价 / ROI 依据：收益状态仍为 `not-ready`。
- 不能把 `20/20 vs 20/20` 当等价：见 O1，两者判定口径不同。
- 不能给出「索引建好后摊薄到多少查询才划算」的交叉点。

## 7. 复现

```bash
# 前置：M5 环境与冻结 gold 已就绪
node scripts/prepare-m5-env.mjs --verify-only

# 结构化臂需要构建产物（imports lib/index.js）
./node_modules/.bin/tsdown --config tsdown.config.ts

# 运行 Phase 1（会写 reports/baseline-grep.json）
node eval/m5/grep-baseline.mjs
```

`grep` 臂需要真实产品包已在本工作区安装；harness 会依次尝试包内
`node_modules`、monorepo `.dsh/profiles/node_modules/`、root `.pnpm` store，
可用 `DSH_FS_SEARCH_ENTRY=<abs path to lib/index.js>` 显式指定。找不到时会以
明确错误退出。报告里的 `grepTool.entry` 记录了实际使用的 bundle 路径。

harness 会在临时目录拷贝语料，跑完删除；锁定语料与 `gold.json` 均不被修改。
探针文件被改动时，报告里的 `probesSha256` 会与之不一致，结果即失效。

## 8. 产物

| 路径 | 内容 |
| --- | --- |
| `eval/m5/baseline-grep.patterns.json` | 预登记探针（冻结） |
| `eval/m5/grep-baseline.mjs` | Phase 1 harness（不新增依赖边） |
| `node_modules/.cache/m5-eval/reports/baseline-grep.json` | 机器可读结果 |

## 9. 下一步（Phase 2，未开始）

Phase 1 只做静态检索。要谈收益，还需要有模型参与的对照实验：

- 基线臂 = `grep` / `glob`（+ 必要时 `read`）；处理臂 = `context_*`；
- 同一模型、同一 system prompt、同一任务集、同一 tool/token 预算、同一 revision、同一 Node；
- 每格重复 ≥3 次，指标：任务成功率、tokens-to-success、tool-call 数、端到端时延、
  返回字节数；
- 任务集需**独立于 gold** 另行准备，且不得用本包抽取器生成。

Phase 2 未获授权，本文件与 harness 都不实现它。
