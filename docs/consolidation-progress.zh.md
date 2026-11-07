# 蒸馏处理进度与持久化诊断

[English](consolidation-progress.md) | 中文

此前的蒸馏用 `promotedTo.length === 0` 判断待处理。这混用了两件事：“某条 L1
引用过这条记录”和“某个蒸馏器已经检查过这条记录但没有产出”。空结果不会产生引用，
于是下一轮又读到同一条记录，永久重复。本次增加独立可持久化进度，不伪造 L1 引用。

## 交付状态（2026-11-07）

progress 表、版本键和保留/重放行为已实现并有 focused tests 覆盖。R3r1 的 300 例
B2 运行采集完成：1,085 calls，已知 token 最少 837,841，319 calls usage unknown，
费用 unknown；A0/B1 零模型预检均 300/300 完整。该运行验证采集、隔离和进度管线，
不证明提取质量或准确率。

本工作**尚未部署生产**。旧 invalid full 与 stopped 的 SDK formal-100 仍是独立归档，
不能和本次运行拼接。P0 见 [HANDOFF.zh.md](../HANDOFF.zh.md)。

## 进度行

进度按 scope、蒸馏器、蒸馏器版本和 layer-0 记录存储：

```ts
interface MemoryDistillerProgress {
  id: MemoryProgressId
  scope: MemoryScopeKey
  distiller: string
  version: string
  record: MemoryRecordId
  status: 'empty' | 'proposed' | 'failed'
  attempts: number
  updatedAt: number
}
```

- `empty`：蒸馏器成功检查，但没有产出。
- `proposed`：蒸馏器产出的候选中至少有一条引用了该记录。
- `failed`：蒸馏或候选应用失败；在 `attempts` 达到上限前保留重试。
- `skipped`：记录被策略永久排除，`skipReason` 给出固定原因，例如
  `input-too-large` 或 `blocked-sensitive`。

`promotedTo` 仍作为“确实被 L1 引用”的审计字段保留；对启用进度的蒸馏器，它不再
决定 pending。

遗忘一条记录会删除引用它的所有进度行，覆盖所有 distiller 与 version，避免删除后
留下无限增长的孤儿进度。

内置 domain store 在 `progress` 表持久化进度。memory domain 格式版本不变，旧介质
仍可加载，只是初始没有进度行。不会批量迁移或重写已有记录。

## 蒸馏器协议

扩展是可选字段，第三方蒸馏器仍可工作：

```ts
interface MemoryDistiller {
  name: string
  rank: number
  version?: string
  progress?:
    | { mode: 'record'; maxAttempts: number }
    | { mode: 'window'; maxAttempts: number; lookback: number }
  distill(input: MemoryDistillInput): Promise<MemoryDistillation>
}
```

- 不声明 `progress` 的蒸馏器继续使用旧 `promotedTo` 判据。
- `version` 缺失或为空使用明确的 `legacy` 进度键。
- 修改 `version` 会启用新键并显式回放记录；旧行仍可读，不做自动迁移。
- 内置 `StatedPreferenceDistiller` 使用 `record` 模式。
- 内置 `BehaviorCycleDistiller` 使用 `window` 模式。

## Window 模式

行为模式可能跨多轮重复。window 模式把新记录，加上第一条新记录之前最多
`lookback` 条已处理记录，一起交给蒸馏器。只有新记录推进进度，lookback 上下文下轮
仍可再次读取，不会重复消费。即使只来了 1 条新记录，之前的 2 条仍可凑成三次重复。

窗口从第一条 pending 记录开始，向前最多读取配置的 `behaviorLookbackRecords`。实现
不包含全局隐藏窗口大小。

## 失败、重试与幂等

- 成功空输出会推进进度。
- 异常、取消或候选应用失败不推进成功进度。
- 调用蒸馏器前、返回后、以及每个候选写入前都会检查 abort signal。即使第三方蒸馏器
  不响应 signal，取消后也不能应用候选或推进进度。
- 取消不增加失败重试次数。
- `failed` 行在 `attempts < maxAttempts` 时重试；达到上限后不再反复扫描，但行仍留
  作诊断。
- 候选应用会检查已有 node/edge 是否已经引用全部候选证据。部分写入后重试不会对同一
  证据重复增强。
- 进度写入与 promotion 引用在同一 scope 写锁内执行。若前几行进度已写成功后写入失败，
  已成功消费的行不会被退回失败状态；只重试剩余记录。
- 同 scope 的并发 `consolidate()` 共享同一个进行中的 pass。第一次调用拥有自己的
  `signal` 与 `onDiagnostic`；后续 join 共享该 pass 的取消与结果，不能独立取消。
  该 pass 在调用 `assert`/`relate` 时不持有该锁，因此不会与逐条写锁互相死锁。

## 诊断

`consolidate()` 接受一个小型可选回调：

```ts
await ctx.memory.consolidate(scope, {
  onDiagnostic(diagnostic) {
    // 只有计数与耗时
  },
})
```

`MemoryConsolidationDiagnostic` 包含 scope、distiller、version、mode、pending 数、
window 大小、advanced 数、failed 数和耗时。不包含记录原文、label、证据 id 或
provider 输出。回调抛错会被忽略，诊断不能破坏维护流程。

## 配置

出厂 working set 精确新增：

```yaml
behaviorLookbackRecords: 20
progressMaxAttempts: 3
```

`behaviorLookbackRecords` 是行为蒸馏可读取的先前上下文条数；
`progressMaxAttempts` 限制两个内置蒸馏器的失败重试。两者都是必填配置。profile
覆盖时必须包含。

## 持久化 profile

可复现脚本位于包外
`experiments/代码修复-20261106/persistence-profile/profile.ts`。它使用真实 JSON
storage-domain 后端，写入 100/500/1000 条合成记录，报告打开/加载、逐条写入、列举、
get、put、首次/第二次蒸馏、重载以及 SDK off/on 边界。不调用 LLM。

兼容 0.2.1-rc.2 宿主已准备好，SDK off profile 已在 Node 24.19 跑通。
100 / 500 / 1,000 条合成记录：

| 条数 | 首次 pass | 第二次 pass | 重载 |
|---:|---:|---:|---:|
| 100 | 327 ms | 0.15 ms | 24 ms |
| 500 | 2,821 ms | 0.62 ms | 35 ms |
| 1,000 | 7,057 ms | 0.43 ms | 22 ms |

list/get 很轻；首次 pass 与逐条 JSON `put` 成本一致。脚本不调用 LLM。
SDK on 尚未验证，因为当前环境未设置 `KYLIN_EMBED_RUNNER`；该模式输出 `blocked`，
不伪造 profile。真实麒麟 SDK 验证仍应在隔离目录完成。
