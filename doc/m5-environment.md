# M5 本地环境报告

本报告只覆盖 M5 Task 1 的环境准备，不是正式 acceptance、gold 或发布报告。

## 状态

| 检查项 | 状态 | 证据 |
| --- | --- | --- |
| corpus-ready | ready | Zod v4.4.3 固定 commit，归档与 LICENSE 校验通过；源码 manifest 为 286 files / 2,237,613 bytes |
| Node22-ready | ready | 隔离 Node v22.19.0 可执行；verify、typecheck、build、入口 import、定向测试通过 |
| Node24-ready | ready | 隔离 Node v24.6.0 可执行；verify、typecheck、build、入口 import、定向测试通过 |
| pnpm-ready | ready（本地隔离） | 本地 pnpm.cjs v11.7.0 在 Node22/24 下均输出 `11.7.0` |
| built-entry-ready | ready | `lib/index.js` import 检查和 `tests/package-entry.spec.ts` 通过 |

收益状态仍为 `not-ready`；本报告没有运行 Baseline/C、gold 或正式 M5 acceptance。

## 固定 corpus

- URL：`https://github.com/colinhacks/zod.git`
- tag：`v4.4.3`
- 完整 commit：`1fb56a5c18c27102dbc92260a4007c7732a0ccca`
- 归档 URL：`https://codeload.github.com/colinhacks/zod/tar.gz/1fb56a5c18c27102dbc92260a4007c7732a0ccca`
- 归档 SHA-256：`48e2438edf0294d148b8a06cb5f1954e99aa17ecbb79bef036253cfd2b37f777`
- 官方 LICENSE SHA-256：`3f1189b28e3866e0d979968d466b78f813f76827cfdca1fbb124cc0a5c8841f8`
- 扫描根：`packages/zod/src`
- 准备目录：`node_modules/.cache/m5-eval/corpus/zod-1fb56a5c18c27102dbc92260a4007c7732a0ccca/packages/zod/src`
- manifest：`node_modules/.cache/m5-eval/corpus-manifest.json`
- 规则：保留扫描根下全部 regular files，路径按确定性 POSIX 字典序记录；排除规则记录为 `node_modules`、`dist`、`build`、`.git`、`coverage`。本次没有容量截断。

锁文件为 [`eval/m5/corpus.lock.json`](../eval/m5/corpus.lock.json)，缓存与工具位于已被 `node_modules/` 忽略的目录，不进入提交内容。

## 工具与版本

宿主平台为 Linux x86_64（`Linux 7.2.4-arch1-2 x86_64`）。包 HEAD 为
`86b1e985b6aa7bac43500809d16e2f509e302d24`，分支为
`feat/m5-release-acceptance`。准备开始时已有 dirty 文件：
`scripts/benchmark-p0-ancestor-names.mjs`、`scripts/smoke-m2.mjs`、
`src/index.ts`、`tests/package-entry.spec.ts`、`doc/m5-progress.md`、
`docs/` 和 `tests/scripts.spec.ts`；这些文件未由 Task 1 修改。

本地工具的精确路径和校验如下：

```text
node_modules/.cache/m5-eval/tools/v22.19.0/node/bin/node  v22.19.0
  node-v22.19.0-linux-x64.tar.xz
  c0649af18e6a24f6fe5535a3e86b341dd49a8e71117c8b68bde973ef834f16f2
node_modules/.cache/m5-eval/tools/v24.6.0/node/bin/node  v24.6.0
  node-v24.6.0-linux-x64.tar.xz
  fda6f6a00759eea0a27e34fcdfdd09dc2b0413855edaa7f746246cf81c0186e26
```

两个 SHA-256 均与对应 Node 官方 `SHASUMS256.txt` 相符。系统 `/usr/bin/node`
为 `v26.8.2`，不替代 Node22/24 矩阵。

系统 `/usr/bin/pnpm` 存在，但 `pnpm --version` 退出 1，并报告
`unable to open database file`。未修改全局配置，也未安装全局包。隔离的
`pnpm@11.7.0` 来自 npm registry：

```text
tarball: https://registry.npmjs.org/pnpm/-/pnpm-11.7.0.tgz
dist.integrity: sha512-GcyFLBIMcSV2DyRD7mvgyltA+fUFmN4aCaHxd1A+AQ5Xwjx3ZG4B52HeWb+HT7IqM5jDOrlpH8E+uUa28PTWIA==
```

以实际 registry metadata 为准；归档大小为 4,590,455 bytes，按该
`dist.integrity` 校验通过。pnpm.cjs 位于
`node_modules/.cache/m5-eval/tools/pnpm-11.7.0/package/bin/pnpm.cjs`，两种
Node 直接调用均输出 `11.7.0`。

## 实际检查

准备脚本：

```bash
node scripts/prepare-m5-env.mjs
node scripts/prepare-m5-env.mjs --verify-only
```

首次准备成功后生成 286 个源码文件和 2,237,613 bytes manifest；迁移到
`node_modules/.cache/m5-eval` 后，Node22/24 的 `--verify-only` 均退出 0。

两种 Node 均执行了以下检查并通过（循环中的路径就是本机实际路径）：

```bash
for version in v22.19.0 v24.6.0; do
  node="$PWD/node_modules/.cache/m5-eval/tools/$version/node/bin/node"
  PATH="$PWD/node_modules/.cache/m5-eval/tools/$version/node/bin:$PWD/node_modules/.bin:$PATH" \
    "$node" scripts/prepare-m5-env.mjs --verify-only
  PATH="$PWD/node_modules/.cache/m5-eval/tools/$version/node/bin:$PWD/node_modules/.bin:$PATH" \
    ./node_modules/.bin/tsc -b --pretty false
  PATH="$PWD/node_modules/.cache/m5-eval/tools/$version/node/bin:$PWD/node_modules/.bin:$PATH" \
    ./node_modules/.bin/tsdown --config tsdown.config.ts
  "$node" --input-type=module -e "const m = await import('./lib/index.js'); if (typeof m.buildIndexP0 !== 'function') throw new Error('missing buildIndexP0')"
  "$node" ./node_modules/vitest/vitest.mjs run --testTimeout=30000 \
    tests/package-entry.spec.ts tests/scripts.spec.ts
done
```

两种 Node 的定向 Vitest 结果都是 2 files / 5 tests passed。测试直接使用
`node_modules/.cache/m5-eval` 中的 Node；P0 排除 `node_modules`，因此不需要
再移动缓存目录。

准备脚本还在独立 `/tmp` fixture 中验证了：重复执行前后 lock 与 manifest
字节不变；篡改归档被 checksum 拒绝；篡改源码被 manifest 拒绝；缺失
prepared corpus 时 `--verify-only` 拒绝且不自动解压；已有 corpus 但缺少
manifest 时普通准备拒绝创建新基线。

普通沙箱中运行准备脚本时，Node 创建 `tar` 子进程曾返回 `EPERM`；在受控
执行环境中使用同一命令完成了下载、解压和所有验证。这是本机执行限制，脚本
本身没有绕过 checksum 或路径安全检查。

复现入口和目录说明见 [`eval/m5/README.md`](../eval/m5/README.md)。
