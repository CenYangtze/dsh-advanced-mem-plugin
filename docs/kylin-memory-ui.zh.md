# 智忆麒麟视觉记忆 UI

[English](kylin-memory-ui.md) | 中文

智忆麒麟 UI 是建立在该只读 host API 之上的独立呈现插件。本文只记录 host
侧接口及其限制。

## 界面

原创侧栏与首页标识、蓝色操作和克制的紫色记忆强调使用 DSH 扩展槽，不使用麒麟官方图形。对话页头打开只读浮层，支持 profile 列表、真实召回搜索和安全条目详情。它不是 shell 注册的右侧标签页，不提供编辑或擦除操作。保留原有模型设置页面；浏览器标题、favicon 和 shell 原有首页标语未修改。

默认折叠的对话卡片只处理来源为 `memory-recall` 的持久化 `user/message` 事件，展示原始 sections 并保留完整注入文本入口，不猜测召回数或注入数。卡片读取会话记录，而非列表/搜索 API。

## 能力意图
第一版读取**当前会话推导出的 scope 加 user**：

- `list` 返回这些 scope 内的常驻 profile。它是 profile，不是全库列表。
- `search` 对查询执行真实记忆召回，并返回安全 cue。
- host 入口只增加一个 RPC channel：不增加个人记忆 namespace、全局转发层、
  写入路径、storage 改动或工具。

## Scope 与授权
- 客户端只发送 `sessionId`、可选 `query` 和可选 `limit`，不能发送 scope。
- host 要求 `owner` principal，并通过 `ctx.sessions.get` 找到有效 live
  session。
- scope 来自 `sessionScope(session)` 加 `{ kind: 'user' }`。不存在或其他非
  live session 会被拒绝；host 不根据 id 猜 workspace，也不回退去读全库。
- 传输认证是必要条件，但不是充分条件；owner 与 live session 检查属于本入口。

## 协议
Channel：`/kylin-memory-ui`。Endpoint：`list`、`search`。

```text
request  { sessionId: string, query?: string, limit?: number }
success  { ok: true, data: { items: Item[], mode: 'lexical' | 'semantic' | null } }
failure  { ok: false, error: { code: string, message: string } }
```

`Item` 包含 `id`、`kind`（`node` 或 `record`）、`type`、`label`、`summary`、
`status`、`scope`、`createdAt`、可选 `updatedAt` 和 `evidenceCount`。

- node 提供 label、summary、节点类型、evidence 数量和 `updatedAt`。
- record 以安全文本作为 summary；其 kind 同时是 type 和 label。record 不引用
  其他 layer-0 record，因此 `evidenceCount` 为 `0`。
- `list` 固定返回 `mode: null`；挂载 embedder 不等于语义召回实际运行。
  `search` 返回召回实际运行的模式。
- 第一版搜索跳过 edge cue，不把 edge 转成 node，因为那会伪造 store 从未发放
  的 id。
- 只返回 `recallable` record；该 channel 从不设置 `includeEvidence`。

## 结果安全与上限
- 返回结果是投影而非存储行。embedding、内部属性、检索 terms、附件内部信息、
  provider 凭据和原始 evidence 数组都不会穿过该 channel。
- 返回文本已经过记忆安全过滤。
- 未指定 limit 时使用 `defaultLimit: 20`；最大接受值为 `maxLimit: 50`。
  非整数、非正数和超过上限的值都会失败。
- 错误使用固定的非敏感文案；store 与 provider 失败会被收敛，不复制进响应。

## 第一版边界
- host 入口不写入、不强化、不 retract、不 forget，也不提供 forget 操作。
- 当前 `/memory forget` 只 retract 信念，并不是永久 erase。
- 界面本次不解决自然语言“不要记住这个”的拒记问题；捕获策略和用户同意流程
  仍是独立工作。
- `memory/recorded` 表示一条 record 进入了 substrate，不代表偏好已经被提取；
  不得把它呈现为“已提取偏好”。
- 读取是每次请求的快照。该入口不订阅所有后台变化，也不承诺实时刷新全部
  记忆处理结果。

## 证据
```text
pnpm exec vitest run tests/kylin-memory-ui/host.spec.ts   # 7 个测试通过
pnpm run typecheck                                        # host 与 client 两面均通过
```

测试包含真实 Connection composition、兄弟 WebServer 插件和真实 HTTP carrier。最终工作区检查通过 36 个文件、494 项测试、前后端两面类型检查、构建和 bundle 验证。该工作区包含原有 experience 工作；这些数量不能替代此前仅修复候选的证据。

真实 DSH Web scaffold 与本机 Edge 已通过无密钥浏览器检查：品牌、卡片展开/全文、列表、搜索、详情、暗色外观、390px 布局和 Escape 关闭，无页面脚本错误。记忆和注入事件均为合成材料，只证明 UI 集成，不证明模型提取或召回质量。见[验收记录](ui-verification-20261107/README.zh.md)。

排除无关 experience 改动后，单独导出的暂存候选也通过完整检查：24 个文件 / 426 项测试、前后端两面类型检查、构建和 bundle 验证。浏览器证据使用完整工作区构建。
