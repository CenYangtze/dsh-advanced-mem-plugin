# DeepSeek Harness 兼容性

[English](compatibility.md) | 中文

本修订支持 **DeepSeek Harness `0.2.1-rc.2`**。截至 **2026-10-23**，官方 `master` 分支指向 [`687f282e8625c6b8d11ff58211a90524be2e4317`](https://github.com/deepseek-ai/deepseek-harness/commit/687f282e8625c6b8d11ff58211a90524be2e4317)，对应发布标签 [`dsh-v0.2.1-rc.2`](https://github.com/deepseek-ai/deepseek-harness/tree/dsh-v0.2.1-rc.2)。

## 宿主接口

插件通过 peer dependencies 使用宿主的 Cordis 实例与服务注册表，并已适配最新版的接口变化：

| 接口 | 接入方式 |
|---|---|
| Agent pre-step 决策 | 追加记忆消息时保留原决策的全部字段，包括 `startsRequestSeries`。 |
| 消息来源 | 通过宿主可扩展的 `MessageSourceMap` 声明 `memory-recall` 与 `experience-memory`；事实捕获仅接纳明确的用户消息与技能调用来源。 |
| PTC 工具执行 | 事实证据观察 `tool/ptc-dispatch-start`，经验结果观察已完成的 `tool/ptc-dispatch`。 |
| 通用 JSON 类型 | 从 `@deepseek-ai/dsh-util-values` 导入 `JsonValue`。 |
| 会话历史 | 从已提交的 `session/event` 增量捕获任务经验，无需同步读取完整历史。 |
| 记忆辅助请求 | 要求合并、结果评估与提炼通过 `ctx.llm.stream()` 使用宿主认证且不携带工具；会话模型选择与宿主默认模型提供继承路由。 |
| 多轮任务 | 保存带版本的 `taskContext` 和前驱关系，从经验快照恢复最新检查点。 |
| 结果验证 | 将评估引用与已提交的检查/回读事件匹配，并要求晚于最终动作和前驱检查点的新验证。 |
| 按需查看 | 通过宿主工具服务注册 `experience_inspect`，提供当前作用域内有预算限制的 Skill、来源和验证视图。 |
| 记忆模型 GUI | 通过宿主客户端 slots 与带版本校验的配置表单注册 bundle 配置页。 |
| 凭据 | API 密钥由宿主凭据服务持久化，插件设置只保存凭据引用。 |
| 可选不变量插件 | 通过结构化协议对接宿主提供的 `invariants` 服务；标准 bundle 不挂载该扩展。 |

对应的官方接口见 [Agent 运行时类型](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/core/agent/src/runtime-types.ts)、[PTC 事件类型](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/core/tools/src/types.ts)及[会话读取规范](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/.agents/notes/implemented/architecture/2026-09-09-deprecate-synchronous-session-event-reads.md)。

## Profile 与存储

官方 `acp`、`web`、`headless`、`sdk` 模板均包含 `@deepseek-ai/dsh-base`，由其提供存储服务、JSON 后端和 domain 层。事实记忆使用 `memory` 域，经验记忆使用独立的 `experience` 域；两者均遵循 domain 层的默认后端，无需为 `experience` 额外配置路由。定制部署可以分别指定已注册的其他 KV 后端。对应配置见[官方 profile 模板](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/boot/app-boot/src/profile.ts)、[基础存储配置](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/bundle/base/cordis.patch.yml)和 [domain 路由实现](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/storage/storage-domain/src/index.ts)。

最小 SDK profile 需要自行组合存储及相关服务。Desktop 的保留 profile 由 Electron 应用管理。

最新版 CLI 支持以下安装与检查命令：

```sh
npm install -g @deepseek-ai/dsh@0.2.1-rc.2
dsh plugin --profile web add ./dsh-advanced-mem-plugin-0.3.0.tgz
dsh --profile web --dump-config
dsh web
```

通过 Git 安装时，应按 [README](../README.zh.md) 在 profile 的 `pnpm-workspace.yaml` 中用 `allowBuilds` 允许本包运行 `prepare`。命令依据为官方 [CLI 参数解析器](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/apps/cli/src/args.ts)和[插件安装器](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/apps/cli/src/plugin.ts)。

## 0.3.0 处理约定

默认模型选择跟随当前会话。插件配置页可为任务理解、评估与提炼指定另一组 Harness 提供商/模型，或独立 API。设置变化应用于后续请求，凭据查询由宿主管理；继承部署策略时保留显式环境变量 API 配置。

自动采集从未知结果开始。模型将多轮要求合并与结果评估分开执行，接受的 `tool-evidence` 结果必须引用覆盖当前任务的新独立检查。待完成工作通过 `/experience pending` 查看；`/experience assess` 重审已有证据，符合条件的服务或响应异常由维护周期执行有数量上限的重试。实质性不确定结果通过新的验证或明确用户确认处理，并保留外部评估器入口。自动反馈引用准确 Skill 版本的实际使用动作，以及后续独立任务中的相关验证。维护在记录工作后执行，并按配置周期处理近期使用的作用域。

常规经验召回提供完整流程与精简来源计数。`experience_inspect` 按需展开按会话分组的来源索引或指定验证原文，原始来源历史保留在经验存储与任务前驱链中。

## 验证结果

验证在 Windows、Node `24.14.0` 上完成，使用上述官方源码及已安装的官方 CLI 包。本机插件与宿主共享 Cordis、Agent 和 LLM 实例。

| 检查 | 结果 |
|---|---|
| 基于官方 peer 类型声明的 TypeScript 检查 | 通过 |
| 回归套件 | 13 个文件，255 项通过 |
| 构建与导出检查 | 10 个配置行、15 个公开入口通过，包含浏览器配置组件 |
| 官方 Cordis Loader 接入 | 10 个配置行全部进入 active 状态 |
| 记忆注入 | 事实记忆成功追加，请求序列边界完整保留 |
| 持久化重载 | 销毁上下文并重新启动 Loader 后，仍能检索 JSON 后端中的事实记忆 |
| 自动经验捕获 | 工具结果与回合完成事件生成结果为 unknown 的任务轨迹，原始工具参数未进入经验存储 |
| 捕获期间删除 | 删除来源记录后，进行中的回合被失效，后续结束事件不会重新生成经验 |
| 经验持久化与删除 | 经验可跨重启保留；删除事实来源后，其派生经验被清除，再次重启仍保持删除结果 |
| 本机 Web GUI | 在真实界面完成事实写入与搜索、任务采集、结果确认、模型提炼及活跃 Skill 查看 |
| GUI 多轮自动成果确认 | 同一任务经历规划、实施与增量要求后，由新验证覆盖 10 项验收条件，自动形成 `tool-evidence / success` 并将经验晋升为活跃 Skill，全程未使用人工确认 |
| GUI 跨会话召回 | 重启运行时后，新会话在不调用工具、不读取文件的情况下答出已保存事实和准确 Skill ID；持久事件分别包含 `memory-recall` 与 `experience-memory` 消息 |
| 原生提炼生命周期 | 流结束、取消、模型切换、可信结果置信度重评、重复提炼稳定性和连续 Skill 替代均已验证 |
| 记忆模型配置 GUI | 在真实配置页展示独立 API 控件，保存 Harness 模型覆盖并恢复默认继承 |
| GUI 按需证据查看 | `experience_inspect` 返回来源会话、任务修订号与准确验证原文，无需读取工作区文件 |
| 多轮证据控制 | 已验证当前轮边界、延续与增量前驱链、原文引用匹配，以及本地裁剪回读仅作为背景的处理 |

Loader 验证组合了官方真实的 session、agent、tools、commands、system-prompt 和 storage 服务，两类记忆域均通过官方 domain 层打开。日常开发继续使用标准质量门禁：

```sh
pnpm run link-harness /path/to/deepseek-harness
pnpm run check
```

连接源码检出前，先构建宿主的 peer 包，使其导出文件和类型声明可用。

本机 GUI 验证使用插件 `0.3.0` 和 Harness 已配置的 DeepSeek-V4.1-Flash，推理强度为 High。任务合并、结果评估与提炼均继承该路由，无需单独配置经验 API 环境变量。验证任务覆盖源数据保留、CSV 规范化与去重，以及 summary JSON 交叉检查；最终验证脚本 22 项通过，实际退出码为零。新会话未调用工具或读取文件，直接召回已保存的项目事实、报告格式和新晋活跃 Skill 的准确版本。较早的 `0.2.1` GUI 验证还覆盖了事实写入与搜索。截图、会话证据和临时验证适配器均保存在源码树之外。

## 事实数据生命周期

主动写入记忆时，会保留仅供证据使用的断言记录，并标明作者为 Agent 或 API 调用方。调用方提供的来源引用必须指向同一作用域中的有效记录。两个事实蒸馏器均遵循记录实际的 `use` 字段，生成的断言文本不会再次被当作用户偏好挖掘。

删除来源时，会同步清除其派生节点摘要、关联边陈述，以及包含该材料的生成式断言记录。`forgetNode()` 同时支持清除旧版本中缺少证据引用的节点。存储接口新增 `eraseNode()` 与 `eraseEdge()`，自定义 provider 需与 `eraseRecord()` 一同实现。domain provider 执行持久删除，关闭并重新打开后已验证材料保持清除。同一作用域内的信念变更与删除按序执行，替代关系边保留在端点所属作用域中。
