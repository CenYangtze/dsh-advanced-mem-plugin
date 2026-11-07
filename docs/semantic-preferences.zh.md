# 语义偏好提取

[English](semantic-preferences.md) | 中文

固定句式的 stated-preference 蒸馏器继续作为离线基线。本页说明可选的、受证据
约束的语义蒸馏器：它通过宿主模型读取自由表达。该功能**默认关闭**，需要审阅模型
路由与预算后在独立 profile 中启用。

## 交付状态与质量（2026-11-07）

`semantic-v4` prompt/version 修复恰好改动 6 个文件，冻结源其余 143 个文件逐字节
不变，运行时校验未改：`src/memory-consolidation/semantic.ts`、`cordis.patch.yml`、
`tests/memory-consolidation/{semantic,scheduler}.spec.ts`、
`docs/semantic-preferences{.md,.zh.md}`。12 条合成场景的 v4 复测为 10 pass /
1 fail / 1 unjudged。剩余失败是 `update-same-value` 返回 `{"candidates":[]}`；
unjudged 两次均被截断。实际总调用 58 次，已知 token 最少 39,481，9 calls usage
unknown，费用 unknown。

第二次内部偏好留出是 AI 内容核对，不是人工复核，也不是官方分数，且输入此前已曝光。
100 正例 + 50 负候选（450 case/store 全部完成）：

- A0/B1（semantic off）：项 full **7/143 = 4.9%**；case full **4/100**。
- B2（semantic on，v4）：项 full **23/143 = 16.1%**；case full **18/100**，
  partial **8/100**，miss **74/100**。B2 仍有 **115/143** 项完全漏。
- 46 个冻结 true negative 上的 FER：A0/B1 **4/46 = 8.70%**；B2
  **5/46 = 10.87%**。4 个 `needs_review` 不进入 46 分母。

因此短、显式偏好有提升，但远未达到通过结果。不能把 **16.1%** 发布为
“accuracy”，也不能声称目标已达成。本工作**尚未部署生产**；P0 见
[HANDOFF.zh.md](../HANDOFF.zh.md)。

## 功能

`semantic-preference` 把用户作者来源的记忆记录转换为结构化的 `preference` 或
`constraint` 候选。候选包含：

- 类型、operation（`addition` 或 `replacement`）、主体、属性、适用范围、
  cardinality、值和规范化摘要；
- 来自被引用记录的原文 `quote`；
- `r1`、`r2` 形式的证据别名；
- attribution（只接受 `user`）；
- durability（只接受 `long-term`）；
- 模型置信度，受 `maxConfidence` 上限约束。

addition 候选使用 `target: ""`（或省略 target）；replacement 候选必须引用 `n1`
形式的已有节点别名。运行时会校验目标的 scope、类型、主体、属性、适用范围、单值
cardinality 和稳定语义键。条件不成立时，提案会保留为独立事实并标记
`review: "unconfirmed-replacement"`，旧节点不退休。

事实身份包含主体、属性、适用范围、cardinality 和 value。同一 value 在不同适用范围或
不同 cardinality 下保持独立，不会被同值快捷路径合并。

`semantic-v4` prompt 在 JSON 形状中明确区分 `operation`：`addition` 使用
`target: ""`（或省略）；`replacement` 使用输入中已有节点的别名，例如
`target: "n1"`。`target` 绝不是新增事实的 subject、attribute、value 或 fact key，
它只命名被替换的旧节点。运行时 validator 不变，仍拒绝非空 addition target 和不存在的
replacement 别名。

prompt 也把 applicability 与 cardinality 纳入事实身份。已有 `semantic-v3` 进度行仍可
读；`semantic-v4` 在新进度键下重放记录。纯 addition 提取保持兼容。旧语义版本写下的
节点不会被重写：它们仍可读，v4 身份可能与旧身份并存，直到人工审阅；不做批量迁移。
本次 prompt 修订前记录的 performance snapshot 仍按 `semantic-v3` 版本报告。

scope 由运行时提供，模型无权选择。蒸馏器只读取当前 turn 路由所属 session 的
用户作者记录。assistant 消息、工具调用、evidence-only 记录、无用户作者的 note、
其他 session 的记录和 task-local 指令不会成为长期用户信念。

模型输出按不可信数据处理。解析器要求严格 JSON，检查候选数量与字段长度，只解析
当前输入窗口内的别名，并要求 quote 在至少一条被引用记录中经空白归一化后存在。
quoted、third-party、roleplay、ghostwriting、assistant 归属和 task-local 候选都会被
拒绝。

如果返回的候选全部无效，本次 pass 记为失败，而不是成功空结果；如果至少一条有效，
无效的同批候选被丢弃，已读取记录正常消费。非法 JSON、截断、tool call、provider
错误、超时和输出字节超限都会使该批次失败。

## 模型路由

路由从产生该 turn 的 session 解析：

1. session projection 的 next model；
2. session request header；
3. agent options；
4. 宿主默认模型。

consolidation 调度器在 `turn/end` 解析路由，并把该路由和 session id 入队。手工触发
consolidation 时必须显式提供 `route` 与 `sessionId`；缺失时语义蒸馏器清晰失败，不会
随便选择 workspace 或 Harness 模型。同 scope 并发调用共享第一个进行中的 pass，并
共享其路由与取消。

凭据仍由 Harness 管理。请求通过 `ctx.llm.stream()` 且 `tools: []`；本模块不读取或
持久化 API key。consolidation 插件本身只要求 `memory` 与 `sessions`；启用语义提取时
才通过可选服务获取 `llm` 与 `agents`。

## 限制

quote 校验只能证明被引用片段确实存在于被引用的用户记录中；attribution 与
durability 校验读取的是模型自己的标签。它们不能证明模型正确理解了引文、角色扮演、
代写请求或隐式第三方偏好；模型可能误标。因此该蒸馏器是受证据约束的，但不能替代
留出集上的质量评测。候选仍应视为需要测量与用户纠正的建议。

## 有界输入与进度

所有参数都是必填配置。每次 pass 最多读取 `semanticMaxRecords` 条；单次调用输入
（含 JSON framing）受 `semanticMaxInputCharacters` 限制。单条记录自身放不下时，标记
`skipped`，原因 `input-too-large`；它不阻塞后续记录，也不会被悄悄拆分。因记录数或
字符预算未选中的记录保持 pending，留给后续 pass。

蒸馏器返回实际读取的 `consumedRecordIds`。中枢只推进该子集的进度，因此部分窗口不会
把未读尾部标为 processed。`skipped` 与 `failed` 分别写入；失败记录在
`progressMaxAttempts` 内继续重试。

进度键包含语义实现版本、prompt 版本、模型路由和相关数值控制。模型、prompt 或配置
变化会在新键下重放旧记录。关闭语义提取不会删除已有进度行。

## 去重与冲突策略

- 候选的规范化 summary 等于已有节点 summary，或 `factKey` 与已有事实相同，视为重复，
  不再添加。
- 同一次响应内的候选按同一 fact key 去重。
- 语义候选使用 exact-label 合并。相同主体/属性下的不同 value 会成为不同节点；topic
  相似不被当作同一事实。替换/合并明确留给下一步。

## 配置

出厂 working set 关闭语义提取并写明边界：

```yaml
semanticEnabled: false
semanticMaxRecords: 6
semanticMaxInputCharacters: 12000
semanticMaxOutputBytes: 32768
semanticMaxCandidates: 8
semanticMaxExistingNodes: 12
semanticMaxTokens: 1200
semanticTemperature: 0
semanticTimeoutMs: 30000
semanticMaxFieldLength: 160
semanticMaxCallsPerPass: 2
semanticMaxConcurrentCalls: 1
semanticPromptVersion: semantic-v4
```

独立 profile 可设置 `semanticEnabled: true` 并调整边界；必须写全
`memory-consolidation` 的完整配置。`semanticMaxExistingNodes` 限制暴露为替换别名的
已有 preference/constraint 节点数，整体输入字符预算仍然生效。测试不发起真实付费
请求，宿主流由 mock 提供。

## 可观测性

`consolidate()` 诊断包含 pending/window/advanced/failed/skipped 计数、耗时和可选的
宿主 token 计数。不包含记录原文、label、证据 id、provider 输出，也不编造费用。
调度器只记录固定计数信息。
