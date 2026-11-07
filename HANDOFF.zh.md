# 张旭接手：本次修复与未解决问题

[English](HANDOFF.md) | 中文 | [2026-11-06 更新](UPDATE-20261106.zh.md)

**状态：仅本次修复的干净候选已在 Node 24.19.0 通过完整 `pnpm run check`——22 个文件
/ 410 项测试、build 与 bundle 验证（10 个 patch row、16 个 entry point）。尚未部署
生产。** 交付分支为 `fix/memory-quality-sdk-20261106`；提交与远端状态以 Git 记录为准。本页不是发布批准。

**不在本次范围：** 原有的 `baseline33` 用户/experience 工作不属于本改动集。维护者
会从原始备份隔离，不把它混入本次记忆审查，也不拿它当本次证据。

## 本次改了什么

- **Memory SDK。** `src/memory-embedding-kylin/index.ts` 是薄的真实 SDK 提供者：
  每段文本拉起原生 `memory_embed_runner`，把 SDK 崩溃挡在 Harness 进程外，不静默
  退回 feature hashing，本阶段不加向量缓存。
- **原始记录耐久性。** 先持久化 raw record，再调用 embedding。SDK 失败时文本仍在，
  只是没有向量；召回退回词法并报告固定失败类别。SDK 故障不能丢掉用户原话。
- **版本化进度。** `src/memory-consolidation/*` 与 `src/memory-store-domain/*` 按
  scope、distiller、version、record 存进度（`empty`、`proposed`、`failed`、
  `skipped`）。改 version 会启用新键并重放记录；`forget` 删除引用它的进度行。
  对启用进度的蒸馏器，`promotedTo` 只保留为审计字段，不再判定 pending。
- **保守语义替换。** `src/memory/index.ts` 与
  `src/memory-consolidation/semantic.ts` 仅在模型明确要求替换，且目标为 active、
  有稳定语义键、主体/属性/适用范围匹配、单值、并有可核验用户 quote 时应用替换。
  条件不足时保留为独立事实并标记 `review: "unconfirmed-replacement"`；不批量迁移，
  不自动退休旧节点。
- **安全过滤。** 写入与读取路径统一执行固定、有界的脱敏策略和显式 UTF-16 截断；
  进入外部 embedding/模型前再次过滤。含 redaction placeholder 的 quote 不能作为
  证据。这是最低限度采集策略，不是 PII 分类器。
- **semantic-v4 窄修。** prompt/version 修复只改 6 个文件，冻结源其余 143 个文件
  逐字节不变；未改运行时 validator、attribution、scope、safety 或 experience 代码。
  见 [docs/semantic-preferences.zh.md](docs/semantic-preferences.zh.md)。

## 可引用的证据

以下都是本地实验证据，不是官方榜单成绩。实验目录**不随本仓库 clone 交付**；本页
数字与代码清单就是可带走的交接材料。

### 偏好提取（AI 内容核对，不是人工复核）

- 100 正例 + 50 负候选；三臂全部完成（450 case/store），无 pending。
- A0/B1（semantic off）：项 full **7/143 = 4.9%**；case full **4/100**。
- B2（semantic on，v4）：项 full **23/143 = 16.1%**；case full **18/100**，
  case partial **8/100**，case miss **74/100**。B2 仍有 **115/143** 个 gold 项
  完全漏掉。
- 46 个冻结 true negative 上的 FER：A0/B1 **4/46 = 8.70%**；B2
  **5/46 = 10.87%**。4 个 `needs_review` 不进入 46 分母，也不能悄悄改判成
  true negative。
- 不能把 16.1% 写成 “accuracy”“通过”或“目标达成”。它只是一次内部留出的 AI
  内容核对，长尾和复合偏好仍大量漏。

### 召回与注入（词法，不是 SDK）

- 每臂 470 题；A0/B1 各 470/470，0 error。
- R@10 宏 **75.07%**；真实注入 ID-hit **72.04%**；实际完整注入宏 **71.83%**。
- A0 与 B1 完全相同（paired 差值 0，描述性 CI `[0,0]`）。
- 这是 470 题 LongMemEval 回归集的内部对照，样本此前已曝光；**不是盲测**，不是
  官方分数，也不能证明本次修复提升了召回。

### 耗时（组件级）

- 修后词法 retrieval P95 **36.604 ms**；production hook P95 **32.983 ms**；
  在约 500 turns/qid 规模下两个单项都低于 500 ms。
- ingest P95 **15,910 ms**、total P95 **15,992 ms** 不是 query SLA。
- 30k/50k 单库与 SDK 完整召回链**未测**。

### 麒麟 SDK 稳定性

- 200 条合成调用：200 success、0 error，function P95 **59.156 ms**。
- 资源增长：runtime FD **33→67**、threads **65→266**、runtime→8001 连接
  **1→35**、kytensor 8001 ESTAB **3→71**。
- 约 **218 s** 后没有明显回收。长期稳定仍 **blocked**。不能靠提高 NOFILE 或定时
  重启把问题藏过去。

### Agent 端到端

- 6 条原创合成场景，真实 `AgentLoop`，无工具。
- 原 rubric：no-memory **2/6**、pre **4/6**、post **4/6**。post-hoc sidecar 的
  P/V 都是 **5/6**，不能替代原 rubric。
- 自然语言“别记下来”仍失败：raw record 被存储、召回并在回答中复述（c4）。显式
  `forget`/`memory_forget(erase)` 存在；capture 前的自然语言拒记没有实现。
- V c4/c6 semantic stage 因 `max-tokens` 截断失败。这是管线失败，不能因此把回答
  记 0，也不能把 post-hoc 数字当主分。

### 300 例采集运行

- R3r1：A0/B1 零模型预检 300/300 完整；B2 真实模型 300/300 采集完成（不代表语义
  提取零失败）。
- B2 共 **1,085 calls**，已知 token **最少 837,841**，**319 calls usage unknown**，
  费用 **unknown**。缺失 usage 不能当作 0。
- 这次运行证明采集/隔离/进度管线完整，**不证明**提取质量或准确率；准确率由验收侧
  独立评分。

### 冲突处理（仅初筛）

- 100 条自然冲突 + 50 controls 已完成。
- 冲突与自然更新的最终结论统一维护在
  [docs/memory-updates.zh.md](docs/memory-updates.zh.md)；根文档不复制初筛分数。

## 不能拼进正式结果的材料

- 旧 invalid full：A0 291 full + 9 partial；B1 15 full + 4 partial + 281 zero；
  B2 11 full + 1 partial + 288 zero。保留为 invalid，不评分、不与 R3r1 拼接。
- 旧 B2 gate 失败（11 calls）与旧 invalid R2 full（71 completed）是独立历史失败。
- SDK formal-100 在 900 s scope 超时后只完成 **9/100**。不能与 200-call 探针或
  470 词法 run 拼接。
- 本次仅修复的干净候选已在 tree `7bdc1078d44427e3b6e1f57e518ed200faaaa220`、
  Node 24.19.0 上通过完整检查。历史 **477 tests**、**68 SDK integration** 报告包含
  原有 experience WIP，范围不同，不能与本次修复拼接。依赖通过 `node_modules`
  junction 复用，不是 fresh install 证明。

## 张旭的 P0

1. **偏好漏提与自然更新验证不足。** 仍有 74/100 case、115/143 项完全漏；自然更新
   冲突结论仍待语义复核；B2 项 full 仅 16.1%，远未达标。V c4/c6 还会在
   `max-tokens` 截断。先在留出数据上修复/测量，再谈提取质量。
2. **SDK 清理风险。** FD/thread/连接在约 218 s 后没有回落，长期运行 blocked；
   如实记录失败，不要靠重启服务把 run 洗成成功。
3. **自然语言拒记缺失。** “别记下来”没有在 capture 前路由，c4 仍存储、注入并
   复述了隐私文本。

## P1

- 召回**没有测到改善**；30k/50k 单库和完整 SDK 链仍未测。
- 本交付尚未部署生产。部署、profile 变更和服务重启仍由维护者决定。

## 代码入口

| 范围 | 路径 |
|---|---|
| 运行时、召回、替换、安全 | `src/memory/index.ts` |
| 类型、provider、query、errors | `src/memory/{types,providers,query,errors}.ts` |
| 持久化 store 与 progress 表 | `src/memory-store-domain/{index,spec}.ts` |
| 采集、截断、安全 metadata | `src/memory-observer/index.ts` |
| 蒸馏与进度 | `src/memory-consolidation/{index,distiller,stated}.ts` |
| 语义蒸馏与 v4 prompt | `src/memory-consolidation/{semantic,model}.ts` |
| 召回注入 | `src/memory-recall/index.ts` |
| 工具 schema 与 prompt | `src/tool-memory/{index,prompt}.ts` |
| 麒麟 SDK 提供者 | `src/memory-embedding-kylin/index.ts` |
| 出厂 profile | `cordis.patch.yml` |

focused tests：`tests/memory/{safety,replacement,consolidation-progress,semantic-progress}.spec.ts`、
`tests/memory-consolidation/{semantic,scheduler,model}.spec.ts`、
`tests/memory-embedding-kylin/embedding-kylin.spec.ts`。

## 本地复现

```sh
# 在 code/dsh-advanced-mem-plugin 下
pnpm run typecheck
pnpm exec vitest run \
  tests/memory/safety.spec.ts \
  tests/memory/replacement.spec.ts \
  tests/memory/consolidation-progress.spec.ts \
  tests/memory/semantic-progress.spec.ts \
  tests/memory-consolidation/semantic.spec.ts \
  tests/memory-consolidation/scheduler.spec.ts \
  tests/memory-embedding-kylin

# 干净候选完整检查已在 Node 24.19.0 通过：
pnpm run check
```

干净候选的完整检查已经完成。此后只补交付文档，未改源码与测试，文档-only 更新
不需要重复 full suite。Node 24.19.0 是已验证运行时；Node 22.9.0 因 `node:sqlite`
不满足宿主 `^22.19` 或 `>=24` 要求而失败，请使用 Node 24.19.0；若必须留在 Node 22，
至少使用宿主支持的 22.19+。

## 交付与隐私边界

- 双语交付 README 与 `verification.json` 位于
  [docs/delivery-20261107/README.zh.md](docs/delivery-20261107/README.zh.md)；
  `verification.json` 记录干净候选检查。七章说明书快照已包含在该目录。不要假设
  raw 数据集或全部实验文件会远程可见。
- 本仓库与本文档不复制 licensed gold、用户长对话、credential 或机器账户密码。
  示例均为合成、无个人数据。一个合成的替换形状如下：

```json
{
  "operation": "replace",
  "target_id": "<active-node-id>",
  "evidence_record_ids": ["<user-record-id>"],
  "quote": "I switched to decaf."
}
```
