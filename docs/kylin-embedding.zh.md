# 银河麒麟 CoreAI embedding 提供者

[English](kylin-embedding.md) | 中文

`dsh-advanced-mem-plugin/embedding-kylin` 是记忆中枢的薄真实 SDK 提供者。它不用
feature hashing 近似语义，而是拉起原生 `memory_embed_runner`：该二进制链接
`libkysdk-coreai-embedding`，经桌面 `kylin-ai-runtime` / `kytensor` 调用 GTE Base
模型，返回一行带向量的 JSON 状态。子进程边界把 SDK 崩溃、ABI 变化或运行时卡死
挡在 Harness 进程之外。

本提供者只负责传输。本阶段不加缓存；SDK 不可用时也不会静默换成
`embedding-hash`。

## 交付状态（2026-11-07）

200 条合成调用返回 200 success、0 error，function 耗时 P95 59.156 ms。但资源没有
保持平稳：runtime FD 33→67、threads 65→266、runtime→8001 连接 1→35、
kytensor 8001 ESTAB 3→71，约 218 s 后没有明显回收。长期稳定 **blocked**；不能靠
提高 NOFILE 或定时重启掩盖。

另外，约 500 turns/qid 的修后词法 run 测得 retrieval P95 36.604 ms、production
hook P95 32.983 ms。这只是组件耗时，不是 SDK 召回链；ingest/total 不是 query SLA，
30k/50k 单库与完整 SDK 链仍未测。

本工作**尚未部署生产**。SDK 清理风险与其他 P0 见
[HANDOFF.zh.md](../HANDOFF.zh.md)。

## 环境要求

- 已安装 `libkysdk-coreai-embedding`、`kylin-ai-runtime`、`kytensor` 和 GTE
  Base embedding 模型的银河麒麟桌面。
- 针对这些库编译好的 `memory_embed_runner`。参考源码位于本仓库工作区的
  `code/kylinOS_Agent/native/memory_embed_runner.c`，不随本包发布。
- Node 24.19.0 是已验证运行时。Node 22.9.0 因 `node:sqlite` 不满足宿主 `^22.19`
  或 `>=24` 要求而失败；请使用 Node 24.19.0，若必须留在 Node 22，至少使用宿主
  支持的 22.19+。

runner 协议为一次进程处理一段文本：

```text
memory_embed_runner "<text>"
{"status":"pass","dim":768,"vector":[...]}
```

失败也返回 JSON 状态行：

```json
{"status":"fail","error":"session_setup_failed"}
```

状态行之前的诊断行会被忽略。没有状态行、状态非 `pass`、维度变化、空向量或出现
非有限分量，都算调用失败，而不是“空 embedding”。

## 配置

所有字段必填。实现不藏默认值，由 profile 明确写出完整部署选择。

| 字段 | 含义 |
|---|---|
| `enabled` | 是否挂载。`false` 跳过 runner 路径解析和注册。 |
| `runnerPath` | `memory_embed_runner` 路径。相对路径按包根目录解析；非空 `KYLIN_EMBED_RUNNER` 会覆盖。 |
| `model` | 模型标识，例如 `gte-base`。 |
| `modelVersion` | 权重或协议版本。与 `model` 一起写入向量身份。 |
| `dimensions` | 要求的向量宽度；官方模型为 `768`。宽度不同视为换模型，不做截断。 |
| `timeoutMs` | 单段文本的子进程超时。 |
| `maxOutputBytes` | 单次调用 stdout/stderr 合计字节上限；超过即杀掉子进程。 |
| `fallback` | 只允许 `lexical`。原始记录保持持久化，召回退回 BM25。该字段必填，使降级策略在 profile 中可见。 |

非空 `KYLIN_EMBED_RUNNER` 优先于 `runnerPath`。两者都会解析为绝对路径；相对值
按包根目录解析。`enabled: true` 且两者都为空是配置错误，不使用隐藏默认值。
二进制缺失时会挂载一个明确的不可用 provider，召回报告 `not-found`，而不是看起来
像主动关闭。

提供者名称为 `kylin-coreai:<model>@<modelVersion>`。中枢只把同名向量与查询向量
比较，因此换模型或换版本不会混用不兼容的向量空间。

空向量、全零向量、非有限分量、宽度变化或范数溢出的向量都算调用失败，不会作为
成功 embedding 写入。

## 独立 profile 示例

出厂 `cordis.patch.yml` 刻意不挂 embedding 行。请在独立 profile 中启用，不要改
生产 profile 或出厂 patch 块：

```yaml
# $DSH_HOME/profiles/kylin-memory/cordis.patch.yml
- id: memory-embedding
  name: dsh-advanced-mem-plugin/embedding-kylin
  config:
    enabled: true
    runnerPath: /opt/kylin-memory/native/build/memory_embed_runner
    model: gte-base
    modelVersion: "2026-09"
    dimensions: 768
    timeoutMs: 30000
    maxOutputBytes: 1048576
    fallback: lexical
```

二进制不在 profile 包根目录下时设置 `KYLIN_EMBED_RUNNER`。二进制缺失时 profile
仍可启动，但会挂载不可用 provider，召回报告 `not-found`，不会静默换成
feature hashing。

提高 `memory.vectorWeight` 前先测检索质量。出厂值是对“真实嵌入器”的声明，不是
本 SDK 在某个语料上更好的证据。

## 失败行为

写入和召回的责任不同：

- **写入。** `remember()` 先持久化原始记录，再调用 SDK。embedding 失败时，已落盘
  的记录保留下来，只是没有向量。SDK 故障不能丢掉用户原话。
- **召回。** 查询 embedding 失败会被捕获，词法排序继续运行，返回结果报告实际模式
  和固定失败类别：

```ts
const recall = await ctx.memory.recall({ text, scopes })
if (recall.mode === 'lexical') {
  // semantic === false，本条由 BM25 与图激活产生
}
recall.embeddingFailure // provider 失败时为 { provider, code, reason }
```

`mode: 'semantic'` 与 `semantic: true` 要求至少有一条可用库向量与可用查询向量
完成排序。仅挂载提供者不算语义召回；零方向或格式错误的向量也不计入。

reason 是固定类别之一：`timeout`、`output-limit`、`not-found`、`invalid-text`、
`invalid-payload`、`dimension-mismatch`、`sdk-failure`、`aborted` 或
`empty-text`。原始 stderr、payload JSON、查询文本和通用 provider 的 error
message 不会进入诊断。

## 缓存

本阶段不加缓存。正确缓存需要容量上限、包含模型与版本的键，以及 `forget` 删除
传播；缺少任何一项，命中都可能越过被删除的原文或跨模型空间。在这项工作经过测量
之前，每次 embedding 都是真实 runner 调用。

单次 `embed()` 调用内按顺序逐段处理，避免一个大 batch 同时展开。并发 `embed()`
调用没有全局上限：本阶段没有共享队列或容量调度器。并发写入很多时可能同时启动多个
runner；这是已知限制，不是缓存或调度器。

## 验证

普通 CI 使用 fake runner 与 fake response，不依赖麒麟实机：

```sh
pnpm exec vitest run tests/memory-embedding-kylin tests/memory
```

测试覆盖成功、非零退出、超时、格式错误、空向量与非有限向量、维度变化、零向量/
范数溢出、关闭模式、词法降级、不可用 provider 诊断和模型版本隔离。

在麒麟实机上把 runner 探针与完整检索分开报告：

```sh
KYLIN_EMBED_RUNNER=/path/to/memory_embed_runner \
  "$KYLIN_EMBED_RUNNER" "Kylin embedding probe"
```

runner 探针、首次查询、重复查询和完整召回分别记录。SDK 探针通过不等于检索质量
达标。
