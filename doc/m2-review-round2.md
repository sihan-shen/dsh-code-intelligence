# M2 第二轮主线程审查 / debug

## 范围与结论

按用户最新要求，本轮由主线程直接检查，**未启动子进程或其他模型**。在 `feat/m2-query-source` 上保留之前全部未提交改动，不修改下游代码、共享合同、manifest、lockfile 或宿主。

对照设计 §4–§7、共享 parser/policy、M2 任务卡和第一轮报告，检查查询、source、Session holder、默认插件与 Native bridge，并只读检查实际宿主 defineTool/registry 的取消和呈现实现。

确认并修复 **1 个 P2（中等严重度）bug**：第一轮适配器取消修复未覆盖最外层 Native bridge。新增 5 个测试；全量从 200 增至 **205**。未复现其他明确实现缺陷，不代表所有缺陷已排除。

## R2-1 — P2：Native bridge 误认调用方拥有的取消原因

**位置：** `src/p0-tool-errors.ts:80–82`。

第一轮在 source/tool adapter 中正确保留了 signal.reason，但最外层 registerCodeIntelligenceToolsP0 只凭错误类识别业务失败。如果调用方使用 CodeIntelligenceErrorP0 或 ToolArgsError 作为 AbortSignal.reason，真实工具体原样抛出取消原因后，桥接仍添加业务失败 DTO，甚至将宿主 INVALID_ARGS 重写为 invalid-query。这与“取消保持宿主原通道”不符。

### 复现

`tests/p0-tool-errors.spec.ts:290` 新增两种取消原因的参数化测试：

1. 注册相同等待 signal 的工具体，分别经过普通 registry 与本包桥接。
2. 等待工具真正进入后 abort，使用同一个 CodeIntelligenceErrorP0 或 ToolArgsError 实例。
3. 比较两个实际 ToolRuntime 结果，要求装饰器不改变取消错误的路由、meta 和 content。

修复前两项均为断言失败：装饰器返回 codeIntelligenceFailure meta/JSON 内容，而普通 registry 返回原错误的 `Error: ...` 文本；ToolArgsError 路由亦被改写。最终红测命令为：

```sh
node node_modules/vitest/vitest.mjs run tests/p0-tool-errors.spec.ts -t 'does not project a caller-owned'
```

结果 **2 failed / 24 skipped**。临时红测日志在 `/tmp/dsh-m2-round2-red.log`；持久证据为上述回归测试。最初编写测试时曾误用 ToolArgsError 构造签名，查阅宿主公开产物后修正为 violations 数组，再取得两项真正的断言失败；该测试编写错误不计为产品发现。

### 最小修复

桥接捕获业务 DTO 前增加 `!exec.signal.aborted` 条件。取消时仍抛出原错误，不添加本包业务 DTO、不覆盖宿主错误；非取消的业务失败、输入预校验、重试和 policy replacement 继续沿用原路径。

**注意：** 若调用方选择的取消原因本身带业务样式 code，宿主仍可能保留这个原 code。本包不擅自将其改成 TOOL_ABORTED；保证的是与未装饰宿主行为一致、不把取消认作本包业务恢复建议。

### 集成验证

`tests/loader.spec.ts:244` 通过真实默认 apply/Native registry 和确定性 WorkspaceRegistry 屏障复现等待初始化时的同类取消，确认没有业务 DTO。释放屏障后同 Session 新查询成功且 lookup 仍为 1，证明取消没有杀死共享初始化。

## 额外边界测试与审查

- `tests/p0-query.spec.ts:240`：实际 TS fixture 手工构造 48 个期望 imports/exports 摘要 endpoint，包含空 specifier/name、星号、大小写、组合/分解 Unicode、emoji、引号、反斜线和换行。重复 imports 只保留一次；每页 3 条，后续页用显式乱序/重复 types 集合继续省略 types 的首页。独立期望列表逐项验证完整 endpoint/排序、cursor offset、字节边界和 complete 状态；查询前后 canonical index 一致。未复现缺陷。
- `tests/p0-runtime.spec.ts:78`：release/dispose 与同步 abort listener 重入 release 并发，确认所有关闭操作等待 handle.done、期间新请求为 SESSION_CLOSED。验证第一轮 closing Promise 修复，未复现回归。
- 只读核对 source 三种模式、padding/CRLF/代理对端点、receipt/hash/排除校验和最终 JSON 计费；复跑第一轮独立 line oracle 与并发预算测试。本轮没有声称新增了另一套 source oracle。
- 核对 cursor 正规化/限长/跨 query-index-policy 绑定、元数据/事实联合缩页、symbolId 成员关系与关系 source 文件状态；没有修改查询算法或身份 policy。
- 正常 Native 业务错误、schema 预校验、重试、post-policy、已捕获工具卸载和 V1 程序化回归均保持通过。

## 验证命令与结果

使用已安装本地链接依赖，未安装依赖；构建完成后才执行 built entry：

```sh
node node_modules/typescript/bin/tsc --noEmit --incremental false --composite false --pretty false
node node_modules/tsdown/dist/run.mjs --out-dir lib --external typescript
node node_modules/typescript/bin/tsc --noEmit --strict --skipLibCheck --target ES2022 --module NodeNext --moduleResolution NodeNext --allowImportingTsExtensions src/picomatch.d.ts tests/p0-*.spec.ts tests/loader.spec.ts tests/package-entry.spec.ts
node node_modules/vitest/vitest.mjs run
node node_modules/vitest/vitest.mjs run tests/package-entry.spec.ts tests/loader.spec.ts
node scripts/smoke-m2.mjs
git diff --check
```

- source typecheck、JS/声明构建、P0/loader/package-entry strict 类型检查：通过。
- 全量：**20 文件、205 测试通过**。
- 独立 built entry + loader：**2 文件、12 测试通过**。
- 本地工作树 smoke：exit 0；68 receipts、3,530 symbols、4,690 relationships；54 eligible complete / 14 unsupported / 0 partial / 0 failed；构建 369ms（单次观察）。package.json receipt/source、repoMapP0 实际位置/source、imports、contains 通过。
- `git diff --check`：通过；未跟踪的新源码/测试/文档另外检查行尾空白及 EOF，全部通过。报告补写结果仅改变文档 hash，不改变上述计数。

## 保留边界

M2 无 refresh/cache；下游仅迁移声明，未进行迁移后的端到端验收；Native-only，不支持 PTC 结构化失败。不新增 M3/M4 能力。

协作式取消不等于同步 parse/挂起 I/O 的硬终止；没有最大仓容量、峰值 RSS、Windows、恶意祖先路径替换或完整 AgentLoop/provider 验收。本地工作树 smoke 不是固定 commit gold 或收益证据。未变更的依赖范围不证明 npm 上可以独立安装 P0 合同。

本轮没有新的合同决策 BLOCKED；未 commit、push 或发布。第一轮报告保留不覆盖。
