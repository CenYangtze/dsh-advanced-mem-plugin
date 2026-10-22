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
| 可选不变量插件 | 通过结构化协议对接宿主提供的 `invariants` 服务；标准 bundle 不挂载该扩展。 |

对应的官方接口见 [Agent 运行时类型](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/core/agent/src/runtime-types.ts)、[PTC 事件类型](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/core/tools/src/types.ts)及[会话读取规范](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/.agents/notes/implemented/architecture/2026-09-09-deprecate-synchronous-session-event-reads.md)。

## Profile 与存储

官方 `acp`、`web`、`headless`、`sdk` 模板均包含 `@deepseek-ai/dsh-base`，由其提供存储服务、JSON 后端和 domain 层。事实记忆使用 `memory` 域，经验记忆使用独立的 `experience` 域；两者均遵循 domain 层的默认后端，无需为 `experience` 额外配置路由。定制部署可以分别指定已注册的其他 KV 后端。对应配置见[官方 profile 模板](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/boot/app-boot/src/profile.ts)、[基础存储配置](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/bundle/base/cordis.patch.yml)和 [domain 路由实现](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/storage/storage-domain/src/index.ts)。

最小 SDK profile 需要自行组合存储及相关服务。Desktop 的保留 profile 由 Electron 应用管理。

最新版 CLI 支持以下安装与检查命令：

```sh
dsh plugin --profile web add github:CenYangtze/dsh-advanced-mem-plugin#<commit>
dsh --profile web --dump-config
dsh --profile web
```

通过 Git 安装时，应按 [README](../README.zh.md) 在 profile 的 `pnpm-workspace.yaml` 中用 `allowBuilds` 允许本包运行 `prepare`。命令依据为官方 [CLI 参数解析器](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/apps/cli/src/args.ts)和[插件安装器](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/apps/cli/src/plugin.ts)。

## 验证结果

验证在 Windows、Node `24.14.0` 上完成，依赖来自独立检出的上述官方版本及其编译产物。

| 检查 | 结果 |
|---|---|
| 基于官方 peer 类型声明的 TypeScript 检查 | 通过 |
| 回归套件 | 13 个文件，255 项通过 |
| 构建与导出检查 | 10 个配置行、14 个公开入口通过 |
| 官方 Cordis Loader 接入 | 10 个配置行全部进入 active 状态 |
| 记忆注入 | 事实记忆成功追加，请求序列边界完整保留 |
| 持久化重载 | 销毁上下文并重新启动 Loader 后，仍能检索 JSON 后端中的事实记忆 |
| 自动经验捕获 | 工具结果与回合完成事件生成结果为 unknown 的任务轨迹，原始工具参数未进入经验存储 |
| 捕获期间删除 | 删除来源记录后，进行中的回合被失效，后续结束事件不会重新生成经验 |
| 经验持久化与删除 | 经验可跨重启保留；删除事实来源后，其派生经验被清除，再次重启仍保持删除结果 |

Loader 验证组合了官方真实的 session、agent、tools、commands、system-prompt 和 storage 服务，两类记忆域均通过官方 domain 层打开。日常开发继续使用标准质量门禁：

```sh
pnpm run link-harness /path/to/deepseek-harness
pnpm run check
```

连接源码检出前，先构建宿主的 peer 包，使其导出文件和类型声明可用。

## 事实数据生命周期

主动写入记忆时，会保留仅供证据使用的断言记录，并标明作者为 Agent 或 API 调用方。调用方提供的来源引用必须指向同一作用域中的有效记录。两个事实蒸馏器均遵循记录实际的 `use` 字段，生成的断言文本不会再次被当作用户偏好挖掘。

删除来源时，会同步清除其派生节点摘要、关联边陈述，以及包含该材料的生成式断言记录。`forgetNode()` 同时支持清除旧版本中缺少证据引用的节点。存储接口新增 `eraseNode()` 与 `eraseEdge()`，自定义 provider 需与 `eraseRecord()` 一同实现。domain provider 执行持久删除，关闭并重新打开后已验证材料保持清除。同一作用域内的信念变更与删除按序执行，替代关系边保留在端点所属作用域中。
