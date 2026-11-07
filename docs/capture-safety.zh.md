# 采集安全与最低限度过滤

[English](capture-safety.md) | 中文

这是最低限度、可解释的采集策略，不是 PII 分类系统。它只在记忆写入边界处理高置信
凭据材料，并在进入外部 embedding/模型请求前再次应用同一策略。它不声称能识别所有
secret 或所有个人数据。

## 交付状态（2026-11-07）

focused safety suite 最近一次 40/40 通过：20 条合成凭据正例、20 条普通文本反例，
另含嵌套 attributes、不安全 JSON key、附件省略、读取视图投影和截断边界。这些是
合成 fixture，不是 PII 基准。

本交付**尚未部署生产**。本次尚未提交，commit/push 待维护者完成。

本策略没有实现自然语言拒记。6 条 Agent 检查中，“别记下来”仍被采集、召回并复述
（c4）；显式 `forget`/`memory_forget(erase)` 存在，但 capture 前的拒记路由不存在。
不能拿本页证明 c4 缺口已关闭。本仓库不复制真实用户对话、credential 或机器账户密码。

## 策略

`memory.safety` 在 working profile 中必填：

```yaml
safety:
  redactPrivateKeys: true
  redactProviderTokens: true
  redactBearerTokens: true
  redactSecretAssignments: true
  rejectSensitivePatterns: false
  blockedLiterals: []
```

- 四个 `redact*` 开关覆盖固定高置信模式：PEM private key block（包括未闭合的 begin
  block）、AWS/OpenAI/GitHub 风格 provider token、`Bearer` authorization 值和明确的
  password/api_key/secret/token 赋值。
- `rejectSensitivePatterns: false` 用固定 placeholder 遮蔽；`true` 则整段文本输入以
  `blocked-input` 错误拒绝；不安全的附件引用改为以 `attachment-dropped` 省略。
- 每个 `redact*` 开关独立生效。尤其是 `redactSecretAssignments: false` 时，普通
  `token`/`password` 键和值会保持原样，除非内容命中其他已启用模式。
- `blockedLiterals` 是部署自己的 literal 子串列表，匹配大小写不敏感，空项忽略。
- 不接受部署任意正则，避免引入灾难性回溯；因此也无法识别所有异常格式凭据。赋值
  模式也可能误伤 `token=100` 这类普通文本；该误伤是有意收窄且会体现在 redaction
  metadata 中。

## 写入边界

运行时统一执行策略，工具不能绕过：

- `remember` 在持久化和 embedding 之前过滤文本与附件的每个字符串字段。URI、media
  type、digest 或 caption 命中 blocked literal 或发生脱敏时，整条附件引用会被省略并
  记为 `attachment-dropped`；脱敏后的 URI 不会被伪装成可用资源。只持久化声明过的
  附件字段，未知 kind 或未知嵌套 metadata 会被丢弃而不是落库。原文件内容不改。
- `assert` 过滤 label、summary 以及嵌套 `attributes` 中的每个字符串键和值。不安全
  的键会被拒绝，不会以普通键落库；过滤结果使用无原型对象，避免 `__proto__` 变成
  赋值。
- `relate` 过滤 claim。
- `replace` 过滤 label、summary、attributes 和 claim。只在脱敏前存在的 quote 会被
  拒绝；placeholder 不会被当成原文 quote，即使存储文本中确实出现该 placeholder。
- `memory_write` 直接写入、`memory_search` 查询和 semantic 候选都走同一 runtime。
- assistant/tool 记录仍是 `evidence`，过滤不会把它们提权成用户作者材料。

被遮蔽内容替换为固定 placeholder，例如 `[redacted:secret-assignment]`。被删原文不
写入 metadata 或日志。

## Metadata

记录带可选 `capture`：

```ts
{
  originalLength: number
  retainedLength: number
  truncated: boolean
  lengthUnit: 'utf16-code-units'
  truncation?: 'tail-removed'
  blocked: false
  redactions: [{ category, count, replacement }]
}
```

Layer-1 node/edge 带可选 `safety`，包含过滤 summary、claim、attributes 后的
`blocked`/`redactions`。metadata 只有计数、长度和固定 placeholder。附件省略记为
`attachment-dropped`，不会记录被删 URI 或底层文件内容。

`maxTextLength` 仍是 observer 的显式采集上限。截断保留至多该数量的 UTF-16 code
units，不拆分 surrogate pair，标记 `truncated: true`，记录原始长度与保留长度，并标记
`truncation: 'tail-removed'`。落在缺失尾部的偏好不会被捕获，记录也不声称读过尾部。
实现不会悄悄上调上限或自行分段。

## 外部请求与历史

- `recall` 在词法/向量之前过滤查询，secret 不会进入 embedder；返回的 query 和
  `safety` metadata 反映过滤后的形式。
- runtime 还会为 `recall`、`profile` 和 `suggest` 生成安全读取视图。真实 pre-step
  注入、`memory_search` 和 `/memory` 命令（包括搜索回显与 forget 摘要）都使用同一
  投影：node 的 label、summary、attributes，edge 的 claim 与端点，record 的 text、
  anchor、confirmation、附件 caption 与派生索引词都会过滤或省略。被策略拒绝的
  cue/profile 行直接不输出；保留行的 id 和
  排序身份不变。
- 这些过滤只影响读取视图。已存 record/node/edge 不会被改写、迁移或删除；本阶段也
  不新增 embedding/model 缓存。
- semantic distiller 在构造模型 payload 前重新过滤记录文本和已有节点 attributes，
  复用写入边界的同一 JSON 策略，而不是另走仅字符串路径。被策略拒绝的历史记录以
  `blocked-sensitive` 跳过；被遮蔽记录只以过滤后形式发送。
- 旧记录仍可读。placeholder 或包含 placeholder 的 quote，即使存储文本里确实存在，
  也不能作为新增或替换的有效证据；若 quote 同时含普通片段和 placeholder，则保守
  拒绝。

## 错误与日志

被拒写入抛出 `MemoryError`，code 为 `blocked-input`，message 固定。observer 只记录
capture failed，不写被拒文本或原始 error 内容。过滤 metadata 只有计数和分类，不含
被删原文。

## 验证

focused suite 包含 20 条合成 secret 正例、20 条普通文本反例，以及嵌套 attributes、
不安全 JSON key、无原型过滤对象、全部开关关闭、附件省略、旧 store 的 recall/profile
投影、真实 pre-step hook、`memory_search`、历史 semantic payload 过滤、placeholder
quote 拒绝、截断和 surrogate 边界。原始 20/20 结果与固定评分脚本位于包外
`experiments/代码修复-20261106/safety-check/`；本次运行 40/40 通过。第一次原始结果
保持不变，后续运行追加到单独的 runs 文件并带标签，不覆盖也不与原始文件混杂。

这些 fixture 通过不等于完整 PII 防护。模式刻意收窄，既可能漏掉少见 secret，也可能
误伤看起来像赋值的普通文本。
