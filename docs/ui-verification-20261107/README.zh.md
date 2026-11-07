# UI 验收 — 2026-11-07

[English](README.md) | 中文

环境为 Node 24.19.0、官方 DSH 0.2.1-rc.2 和本机 Microsoft Edge，未使用模型 API 密钥或生产 profile。原始日志与临时浏览器用例保留在操作者的仓库外 `Temp/opencode/kylin-ui-browser` 目录；完整检查日志位于 `Temp/opencode/kylin-ui-final-check.log`。

## 结果

- `pnpm run check`：前后端两面类型检查、36 个测试文件 / 494 项测试、构建和 bundle 验证通过（11 个 patch row / 17 个 entry point）。工作区包含原有 experience 改动，不是 UI 独立候选或仅修复候选的结果。
- 另将暂存候选导出，排除无关 experience 改动后，通过 `pnpm run check`：前后端两面类型检查、24 个文件 / 426 项测试、构建、11 个 patch row 和 17 个 entry point。依赖复用已链接的 harness，不是 fresh install；原始日志为 `Temp/opencode/kylin-ui-staged-check.log`。上述浏览器检查使用完整工作区构建，并非此导出候选。
- 真实 `launchWebScaffold` 浏览器检查：1 项通过，无插件激活警告或页面脚本错误。验证了侧栏品牌、记忆卡片默认折叠、sections 展开、完整注入文本、profile 列表、真实搜索、条目详情、暗色外观、390px 面板边界和 Escape 关闭。
- store 偏好和持久化召回事件均为刻意构造的合成材料，不测量提取质量、模型实际使用、召回准确率或规模性能。
- 首次完整检查因嵌套调用的 `pnpm` 不在 PATH 而失败；使用临时 Corepack shim 修复命令解析，未关闭产品代码或测试断言。

## 截图

- [桌面搜索与记忆卡片](desktop.png)
- [展开卡片及完整注入文本](recall-card.png)
- [暗色外观](dark.png)
- [390px 布局](mobile.png)

## 保留限制

面板是只读浮层，不是 shell 右侧标签页；无编辑/擦除或后台实时订阅。浏览器标题、favicon 和原有首页标语未修改。自然语言拒记、提取质量、SDK 资源积累和未测的大库延迟仍是独立未解决问题。
