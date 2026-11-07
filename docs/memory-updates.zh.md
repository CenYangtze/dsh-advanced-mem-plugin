# 显式与自动记忆更新

[English](memory-updates.md) | 中文

本页说明受证据约束的替换。它不新增完整版本树，也不改变 `assert` 对相同 label 的合并
行为。替换会创建新的节点身份、用墓碑退休旧节点，并写入从新节点指向旧节点的
`supersedes` 边。

## 交付状态（2026-11-07）

显式替换已实现并有 focused tests 覆盖。自动语义替换刻意保守；本轮 prompt/version
修复就是 6 文件的 `semantic-v4` 变更，不改运行时校验。12 条合成场景的 v4 复测为
10 pass / 1 fail / 1 unjudged；剩余失败是 `update-same-value` 返回空候选，unjudged
则两次都被截断。这不是质量验收结论。

冲突套件已跑完，但分数不是最终结果：

<!-- CONFLICT-FINAL-REVIEW:START -->
初步状态：当前 07 报告为 natural joint 0/100、controls 43/50。这只是字符相似度
初筛，不是准确率。最终语义复核待完成。维护者发布前请用复核后的结果替换本块。
<!-- CONFLICT-FINAL-REVIEW:END -->

6 条 Agent 检查中，自然语言“别记下来”仍被存储、召回并复述（c4）；V c4/c6 的
semantic stage 因 `max-tokens` 截断失败。这些是未关闭的 P0，替换机制并没有解决。

本交付**尚未部署生产**。本次尚未提交，commit/push 待维护者完成。见
[HANDOFF.zh.md](../HANDOFF.zh.md)。

## 显式替换

`ctx.memory.replace()` 与 `memory_write` 的 `operation: "replace"` 走同一运行时路径。
调用方提供：

```ts
{
  scope, target, type, label, summary, origin, evidence, quote
}
```

- `target` 是明确的 active 节点 ID，不是自由 label。
- 目标必须 active、位于请求 scope、类型一致。
- 新证据必须是同 scope 的 active 用户作者记录，且 `provenance.author === "user"`。
  agent note、assistant 文本、工具输出，以及缺 author 的 legacy 记录都不能冒充用户
  证据；它们仍可读，只是不能用于替换。
- `quote` 必须在至少一条被引用记录中经空白归一化后存在。包含 redaction placeholder
  的 quote 永远无效，即使存储文本中确实有该 placeholder；被脱敏记录中的普通片段仍
  可作为有效证据。
- 写入顺序是新节点 → 替代边 → 旧节点墓碑。这不是原子事务：边写失败时两个节点可能
  都 active；退休失败时边可能已存在而两个节点仍 active。此中间态下 recall/profile
  可能同时看到两个值，不能宣称用户只有一个当前值。
- 相同请求重试复用确定性的 replacement id，补齐缺失步骤，不重复节点或边。身份键会
  规范化证据顺序和 attributes key 顺序，因此等价重试保持幂等。最终状态是一个新节点
  active、旧节点 superseded。
- 旧节点保留原证据；新节点保留新证据；替代关系由边保留。
- 遗忘新节点会删除它和边；旧节点仍作为可审计墓碑保留。

现有 `assert` 行为不变：同 label 写入仍会原地更新该节点，包括 summary。不要把
`assert` 同 label 调用当作替换机制。现有工具 `add` 调用保持兼容。

## 工具表面

`memory_search` 的节点、边和记录结果现在都包含 `id`，agent 可把真实节点 ID 与真实
用户记录 ID 传给 `memory_write`。

`memory_write` 新增可选字段：

- `operation`：`add`（默认）或 `replace`
- `target_id`：要替换的 active 节点 ID
- `evidence_record_ids`：active 用户记录 ID
- `quote`：来自被引用记录的原文片段

输出新增写入节点 `id`，替换时还返回被退休的 `replaced` id。工具 schema 与提示协议的
变更集中一次完成。

## 自动语义替换

语义蒸馏器现在要求 `operation`、已有节点别名、适用范围和 cardinality。已有节点以
`semanticMaxExistingNodes` 为上限提供别名，并继续受总输入字符预算约束。事实身份包含
主体、属性、适用范围、cardinality 和 value，因此同一 value 在 work/home 或
single/multiple 场景下保持不同事实。

只有同时满足以下条件才会应用替换：

- 模型明确输出 `operation: "replacement"`；
- 目标别名解析为同 scope、同类型的 active 节点；
- 目标拥有稳定语义键，且主体、属性、适用范围匹配；
- 目标与候选都是单值（`cardinality: "single"`）；
- 新证据 quote 存在于被引用的用户记录，并通过与显式替换相同的 placeholder 拒绝。

仅 value 不同绝不触发替换。多值属性、不同实体、不同适用范围，以及没有稳定键的旧
数据都保留旧值；模型若提出替换，会改为独立事实并标记
`review: "unconfirmed-replacement"`。不批量迁移或自动退休旧数据。

同值候选通过包含 value 的 `factKey` 去重。不同 value 使用 exact-label 合并，不会因
topic 相似抹掉旧值。supersede 是显式步骤，更进一步的冲突处理留待后续。

## 限制

quote 与 attribution 校验只能约束证据，不能证明模型正确理解了改口。模型仍可能误判
角色扮演、引文或第三方措辞。replacement operation 是模型基于引用文本做出的语义判断，
不是“用户确实想替换旧值”的代码证明；实现没有用硬编码词表冒充这种证明。替换提案仍需
在留出对话集上做质量评测和用户纠正。focused tests 不包含任何付费模型调用。
