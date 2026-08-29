# dsh-advanced-mem-plugin

[English](README.md) | 中文

面向 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的跨会话记忆，打包为一个可安装的 **bundle**。用 `dsh plugin add` 装进任意 profile——不必 fork，也不必给 harness 本体打补丁。

智能体会记住它所服务的这个人：偏好什么、排除了什么、习惯调用哪些工具与技能、重复执行哪些步骤序列。这些结论在每个回合开始时自动回到上下文，智能体也可以通过三个工具主动检索、写入与遗忘。

```
┌─ 第 1 层 ── 语义图谱 ─────────────────────────────────────────────────┐
│  节点：person · preference · constraint · project · entity ·          │
│        routine · tool-affinity · skill-affinity · procedure           │
│  边：  某个事件在两个节点之间诱导出的结论                              │
└──────────────────────────┬───────────────────────────────────────────┘
                           │ 每个节点与边都引用支撑自己的证据
┌──────────────────────────┴─── 第 0 层 ── 情景底层 ────────────────────┐
│  记录：用户回合、工具调用、技能调用、产出物                            │
│  各自携带词法词项、可选稠密向量、回指会话日志的溯源，                  │
│  以及指向图像／视频／文档原件的附件 URI                                │
└──────────────────────────────────────────────────────────────────────┘
```

设计取舍——为什么是两层、为什么衰减在读取时施加、为什么按位次融合——记录在 [docs/design.zh.md](docs/design.zh.md)（[English](docs/design.md)）。

## 前置条件

- 一个 `dsh` CLI 已在 `PATH` 上的 DeepSeek Harness 安装。
- 一个 bundle 列表包含 `@deepseek-ai/dsh-web-app` 的 profile。该 bundle 挂载 `ctx.storage.domain`，持久存储需要它。随包发布的 `web` 与 `headless` 两个 profile 都叠加了它。
- Node 22 或更新版本。

没有存储时整个栈依然能加载：`ctx.memory.ready` 保持为 false，采集与回忆静默跳过，三个工具在被使用时明确失败，而不是假装记得。这是降级而非损坏——但你不会得到任何记忆。

## 安装

```sh
dsh plugin --profile web add github:CenYangtze/dsh-advanced-mem-plugin
```

git 安装拉取的是**源码而非构建产物**，因此 pnpm 必须运行本包的 `prepare` 脚本来产出 `lib/`。pnpm ≥10 在你按名字显式放行之前拒绝运行它，所以第一次 `add` 会失败并打印出需要放行的键。把它写进该 profile 的 `pnpm-workspace.yaml`（`$DSH_HOME/profiles/web/pnpm-workspace.yaml`）：

```yaml
allowBuilds:
  dsh-advanced-mem-plugin: true
```

然后重新执行 `add`。请钉住一个 commit，使日后的推送无法悄悄改变在你机器上运行的东西：

```sh
dsh plugin --profile web add github:CenYangtze/dsh-advanced-mem-plugin#<sha>
```

这项放行就是它字面的意思——允许在安装时于你的机器上执行本包的构建脚本，且不在智能体所处的任何沙箱之内。请先读源码，或者改为安装预构建产物：

```sh
pnpm pack                                    # 在本仓库的克隆中执行
dsh plugin --profile web add ./dsh-advanced-mem-plugin-0.1.0.tgz
```

### 验证

```sh
dsh --profile web --dump-config    # 会出现带 8 行的 "# == dsh-advanced-mem-plugin" 层
dsh --profile web
```

`dsh plugin --profile web remove dsh-advanced-mem-plugin` 会同时移除依赖与这一层。

## Bundle 内容

八个插件，一个角色一个，按数据流动的顺序排列。`id` 列是你在自己的 patch 层中要瞄准的目标；`name` 列是该行加载的模块。

| id | name | 角色 |
|---|---|---|
| `memory` | `dsh-advanced-mem-plugin` | **Service Definition**——`ctx.memory`：词汇表、提供方注册表、检索、信念更新法则。不做 IO，不用模型。 |
| `memory-store` | `…/store-domain` | **Service Provider**——基于 `ctx.storage.domain` 的持久存储。 |
| `memory-embedding` | `…/embedding-hash` | **Service Provider**——免密钥确定性嵌入器（带符号的特征哈希）。无网络、无 API key。 |
| `memory-observer` | `…/observer` | **被动采集**——读取只追加的 `session/event` 日志。 |
| `memory-consolidation` | `…/consolidation` | **Service Provider 兼调度方**——把行为周期挖掘为图谱节点；执行维护扫描。 |
| `memory-recall` | `…/recall` | **Consumer**——在 `agent/pre-step` 上每回合一次地检索并注入相关记忆。 |
| `tool-memory` | `…/tool` | **Consumer**——三个面向模型的工具，外加记忆协议提示词分节。 |
| `command-memory` | `…/command` | **Consumer**——`/memory` 命令，唯一面向人而非面向模型的界面。 |

### 记忆闭环的三个部分

**被动。** 观察者从会话日志中采集用户回合与工具／技能调用——它从不拦截智能体循环，因此无法改变模型所见，而失效的存储只会削弱记忆，不会拖住一个回合。每隔若干回合，巩固器挖掘累积下来的素材：使用得足够频繁的动作成为 `tool-affinity` 或 `skill-affinity` 节点；在回合内重复出现的动作序列成为 `procedure` 节点。这正是*"用户总在用这个技能，那么下次就积极尝试它"*的那条路径，而且它**不使用模型**——频次、复现与相邻关系就是它推理的全部，这让它便宜、确定，并且不可能产生幻觉。

**主动。** `memory_search`、`memory_write` 与 `memory_forget`，外加一段点名"何时应当主动检索"的固定提示词分节——这样宽泛的工具在没有它时会被稳定地忽略。这段分节同时承载了整个设计所依赖的校准规则：**被回忆起的记忆是先验，而不是指令。**

| 工具 | 用途 |
|---|---|
| `memory_search` | 用一条自然语言线索查询图谱与情景底层。 |
| `memory_write` | 创建或强化一个信念，可选地把它链接到一个已有信念。 |
| `memory_forget` | 撤回一个信念，或抹除其背后的素材。 |

`memory_write` 只接受模型可以诚实断言的主体类别——`preference`、`constraint`、`project`、`entity`、`routine`、`person`。亲和度与流程类别被保留：那些是被观察行为的证据，让模型断言它们等于让它自己的猜测伪装成使用计数。

**属于你的那一部分。** `/memory` 回答面向模型的那两部分回答不了的问题：*你以为你知道我什么*，以及*我怎么让你别这样*。

| 输入 | 作用 |
|---|---|
| `/memory` | 记忆的信念，每行都带置信度与来源，随后是它建议接着做什么。 |
| `/memory search <query>` | 与自动回忆相同的混合检索。 |
| `/memory stats` | 按层与节点类型计数，并给出有多少素材是仅作证据的。 |
| `/memory forget <label>` | 撤回携带该标签的每一个活跃信念。 |

建议来自 `ctx.memory.suggest()`，它只接受 `project`、`routine` 与 `procedure` 节点——偏好说的是*怎么*做，而不是*做什么*。当记忆里没有这些时，命令会直说，而不是凑数。

## 配置

每一个可调项都是**必填**的配置字段。一条偏好的合适半衰期取决于你的部署怎么被使用，因此在这里给默认值是一个没有依据的选择，而不是一份便利。本 bundle 自带的 [`cordis.patch.yml`](cordis.patch.yml) 给出了一整套可用取值；在 `$DSH_HOME/profiles/web/cordis.patch.yml` 中覆盖任意一行：

```yaml
- id: memory
  config:
    recallLimit: 12
    profileLimit: 12
    inferredConfidence: 0.4
    assertedConfidence: 0.9
    inferredHalfLifeMs: 5184000000   # 未被强化的推断在 60 天后减半
    assertedHalfLifeMs: 0            # 0 = 永不衰减：这是用户说的
    reinforcementRate: 0.25
    contradictionRate: 0.5
    retirementFloor: 0.05
    activationHops: 2
    activationFalloff: 0.45
    recordBudget: 5000
```

一个 patch 替换该行的**整个** `config`，而不是逐键深合并，所以请重述每一个字段，而不只是你要改的那个。

有两个旋钮值得在动其余部分之前先理解：

- **`assertedHalfLifeMs: 0`** 是配置层面表达"永不衰减"的写法。用户明确说出的内容不会侵蚀，也从不被扫描；只有用户能收回它。一切被推断出来的东西都按 `inferredHalfLifeMs` 减半。
- **`recordBudget`** 限定检索开销。回忆在进程内物化并排序所请求的作用域链，因此这个值是承重的而非建议性的。远超该预算的部署需要一个带真实索引的存储提供方——能力缝允许这样做，但本包并未提供。

想同时采集助手消息，或把某个嘈杂的工具挡在底层之外：

```yaml
- id: memory-observer
  config:
    captureUserMessages: true
    captureAssistantMessages: true
    captureToolCalls: true
    maxTextLength: 4000
    excludedTools: [bash]
    captureCodeDispatches: true
    transportTools: [run_code]
    maxToolDigestLength: 120
```

## 什么会被采集，什么会被读回

这是两个不同的问题，而把它们混为一谈，正是本插件第二次迭代所修复的那个缺陷。工具调用**是**被采集的——你的智能体调用某个工具的频次，正是使用挖掘所消费的东西——但工具调用的文本是智能体自己的机器化输出。早期版本存下了原始参数 JSON 并让回忆把它引述回去，于是一个会话会以"告诉模型它已经做过什么"开场，而且是整段 `run_code` 程序。

因此记录在保真度之外还携带一个**用途（use）**：

| 用途 | 种类 | 建索引 | 扩散激活 | 被引述给模型 |
|---|---|---|---|---|
| `recallable` | `user-message`、`skill-invocation`、`artifact`、`note` | 是 | 是 | 是 |
| `evidence` | `tool-invocation`、`assistant-message`、`procedure-step` | 是 | 是 | **否** |

这个划分依据的是作者，而不是有用性。证据依然参与排序、依然点亮图谱——当查询命中背后的那些调用时，亲和度节点会浮现——它只是永远不会成为线索的文本。`MemoryQuery.includeEvidence` 可以为审计界面解除这一限制；请求路径上没有任何东西会设置它。在这个字段存在之前采集的记录会按其种类的默认值读回，因此既有存储在第一次读取时自行更正，无需迁移。

采集时随之而来的有两点：

- **一次工具调用被存为标签，而不是转录。** 工具名加上第一个描述性参数（`description`、`query`、`pattern`、`command`、`file_path`……），以 `maxToolDigestLength` 为界：`grep — find the config`，而绝不是参数对象。原始参数作为索引素材是有害的——任何提到某个路径的查询，都会命中一次恰好包含它的无关调用。
- **理解 Code Mode。** 在 Code Mode 下，模型调用一个传输工具，并在程序内部驱动每一个真实工具，因此挖掘外层调用学到的是一个没人表达过的"偏好 `run_code`"。传输工具在 `transportTools` 中被点名，它们自身的调用被跳过，转而采集 `tool/code-dispatch-start`——那才是说明哪些工具真正被使用的分发。

## 检索如何工作

三路独立信号，以倒数排名融合：

1. **词法**——对已建索引词项做 Okapi BM25。分词器输出小写词段，并对无空格书写的文字额外输出重叠的字符双字组，因此中文与日文查询无需分词词典也能命中。
2. **向量**——与查询嵌入做余弦相似度，仅覆盖所存向量来自当前挂载嵌入器的记录。来自不同嵌入器的向量从不相互比较。
3. **图谱激活**——从直接命中的节点沿活跃边向外扩散，深度为 `activationHops`，每跳带 `activationFalloff` 衰减。这正是当查询只命中背后原始素材时仍能浮出结论的机制。

融合只消费位次，因此 BM25 分数与余弦相似度无需任何标定步骤即可结合——这正是嵌入器可以更换而无需重调检索的原因。衰减在过滤*之前*施加，于是无人强化的信念自行淡出回忆，不需要任何"必须跑过才正确"的过期任务。

## 保真度、维护与更新

一旦记忆开始驱动真实世界的动作，下面三套机制就是关键：

- **保真度是一等字段。** `verbatim` / `summary` / `derived` 划分一条记录对所发生之事的还原程度，`MemoryQuery.minFidelity` 让消费方拒绝低于某个下限的一切。截断一条提示会将其降级，而不是保留一个它已不再配得上的声明。非文本原件以 `uri` + `mediaType` + `digest` 引用而从不复制——于是图像或视频在其来源处保持权威。
- **没有任何东西被就地删除。** `retract` 立墓碑，`supersede` 以一条边记录替代关系，只有 `forget` 会抹除——因为要求删除素材的用户必须真的得到删除，而不是一份隐藏的副本。
- **置信度遵循三条法则。** 强化每次闭合到 1 的剩余距离的一部分，因此重复认同收益递减，任何有限次观察都无法仅凭推断制造确定性。反驳是乘性的，于是证据充分的信念能扛过一次分歧，薄弱的则崩塌。衰减对"距上次被支撑的时间"呈指数。

## 开发

测试在真实的 Cordis 注册表上驱动真实的插件体，因此需要 harness 的包可被解析。把 harness 克隆在本仓库旁边，然后：

```sh
git clone https://github.com/deepseek-ai/deepseek-harness
git clone https://github.com/CenYangtze/dsh-advanced-mem-plugin
cd deepseek-harness && pnpm install && pnpm run build:lib:host && cd ..

cd dsh-advanced-mem-plugin
pnpm install
pnpm run link-harness ../deepseek-harness   # 为 @deepseek-ai/* 各个 peer 建立 junction
pnpm run check                              # 类型检查 → 154 个测试 → 构建 → 校验
```

`link-harness` 在本地复现 profile 在运行时所做的事：把每一个 `@deepseek-ai/*` peer 指向同一个 harness 安装。这条"单实例"性质是承重的——两份 cordis 意味着两个服务注册表，注册在其中之一上的插件对另一个不可见。这也是本包把每个 harness 包都声明为 **peer** 依赖、并设置 `autoInstallPeers: false` 的原因。

`pnpm run verify` 检查那些否则只会在启动时才暴露的问题：`cordis.patch.yml` 中每一个 `name:` 都能通过 exports 表解析，且每个入口点恰好只有一种插件形态。同时带有 default 导出与函数插件 `apply` 的模块会让 Cordis Loader 丢弃插件命名空间——而且是静默地丢弃。

### 目录结构

```
src/memory/               中枢：类型、打分、提供方、查询、服务
src/memory-store-domain/  持久存储 + zod 记录 schema
src/memory-embedding-hash/  FNV-1a 特征哈希嵌入器
src/memory-observer/      会话日志采集、工具摘要、Code Mode 分发
src/memory-consolidation/ 行为周期蒸馏器 + 调度
src/memory-recall/        步前检索与注入
src/tool-memory/          三个工具 + 记忆协议提示词
src/command-memory/       /memory 命令
tests/                    154 个测试，每个插件一个套件
```

## 已知局限

- **词法匹配没有词干化或词形还原**——`install` 匹配不到 `installs`。挂载嵌入器可以覆盖大部分缺口；词干分词器需要本包并不拥有的分语言规则。
- **回忆按查询物化整条作用域链。** 见上文 `recordBudget`。
- **向量只在同一个嵌入器内部比较。** 更换嵌入器会静默丢弃变更之前写入的每条记录的向量信号；这些记录仍可通过词法检索命中，但不会被批量重新嵌入。
- **没有任何东西采集工具*结果*。** 因此巩固学到的是习惯，而不是什么真正奏效。这是在记忆驱动真实世界动作之前最值得填补的缺口，而蒸馏器能力缝正是一个从结果学习的提供方该接入的位置。
- **反驳是调用方驱动的。** 没有任何东西会察觉两个活跃节点彼此矛盾；图谱不会自我监管一致性。
- **Computer Use、MCP 应用适配器与动作执行均未实现。** 记忆本就欠它们的部分已经就位——查询接口上的保真度下限、引用而非复制附件、携带有序步骤的 `procedure` 节点、回指会话日志的溯源、以取代代替删除、作用域分区。缺失的是对结果的采集，以及针对不可逆步骤的确认策略。

## 与上游的关系

这些源码是在 DeepSeek Harness 树中开发的，此处被重新打包为一个独立 bundle，以便无需 fork harness 即可安装。插件本体未作改动；不同的只是模块标识与跨包 import。本包遵循的上游约定——能力缝划分、`Model-visible ⟺ logged`、不硬编码可调项、插件形态规则——记录在 harness 自己的 `AGENTS.md` 中。

## 许可

MIT。见 [LICENSE](LICENSE)。
