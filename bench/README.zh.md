# KylinMem 评测适配层

针对 [KylinMem 开发场景数据集][dataset]（银河麒麟 OS Agent Memory benchmark）的跑分适配层。
它把数据集的历史会话灌进本插件记忆栈的一个真实实例，问出数据集的题目，再把答案交回数据集自己的判分器。

这里的东西不随包发布。`bench/` 不在 package 的 `files` 列表里，也不在 bundle 里；
它存在的意义，是让一个没写过这套系统的人也能跑出一个关于它的数字。

[dataset]: https://github.com/../kylinmem_dev_batch

## 它到底测什么

数据集的立意是**记忆依赖注入**：把一个已解决的 issue 提炼成一条记忆，再出一道
光看题面答不出来的新题。没有这条记忆的 Agent 必须重新踩坑，有的则不必。
两者之差，就是记忆的价值。

因此这是一个**检索**分，不是推理分。判分器数关键词，而本适配层提交的答案，
就是 recall 插件本来会注入进一轮对话的那段文本——由发布版的 `renderCue` 生成，
而不是为跑分另写的渲染。只要正确的记忆被取回来了，关键词就在里面。

## 怎么跑

三条命令。前两条是数据集 README 要求的上下界，第三条才是正式一轮。

```bash
# 1. 用一个活的记忆栈产出答案
pnpm run bench -- --dataset /path/to/kylinmem_dev_batch_real.jsonl \
                  --mode gold --isolation repo

# 2. 先验判分器再信它：oracle 必须 100%，blank 必须 0%
python bench/score.py --mode oracle --qa bench/out/qa-gold-repo.jsonl \
                      --dataset-dir /path/to/kylinmem_dev_batch
python bench/score.py --mode blank  --qa bench/out/qa-gold-repo.jsonl \
                      --dataset-dir /path/to/kylinmem_dev_batch

# 3. 用数据集自己的判分器给这一轮打分
python bench/score.py --qa bench/out/qa-gold-repo.jsonl \
                      --answers bench/out/answers-gold-repo.jsonl \
                      --dataset-dir /path/to/kylinmem_dev_batch
```

`bench/run.ts` 自己也会按同一条判分规则打印一份结果，所以快速迭代不必启动 Python；
`bench/score.py` 的作用，是让对外公布的那个数字属于数据集而不属于我们。
两者按构造一致——`tests/bench` 钉住了这一点。

## 决定这个数字的几个开关

三个都要报。不报这三项的记忆分，和任何东西都不可比。

| 参数 | 取值 | 改变了什么 |
|---|---|---|
| `--mode` | `gold` \| `raw` \| `off` | `gold` 直接写入数据集提炼好的记忆，只测检索——上界。`raw` 只写历史事件，由发布版蒸馏器自行决定该相信什么——端到端分。`off` 什么都不写——数据集所称的 `blank` 下界。 |
| `--isolation` | `instance` \| `repo` \| `global` | 一道题要和多少条别的记忆竞争。`instance` 每条独占一个 scope，是连线检查而非成绩。`repo` 对应数据集自身的 repo-pair 构造。`global` 把全部 2282 条放进同一个 scope。 |
| `--query` | `issue` \| `task` | 问哪一种题。`issue` 复现 `build_qa.py`。`task` 问的是数据集设计了却没写下来的那道更难的题——见下。 |
| `--include-evidence` | 默认关 | `evidence` 用途的记录是否可以被引用回去。见下。 |

`bench/matrix.sh <dataset.jsonl> [limit]` 一次跑完互为上下界的六种配置，
结果应当按这个形状报出。

另有 `--limit N`（按仓库均匀抽样，而非截断前 N 条）、`--recall-limit N`（每答的线索数）、
`--dimensions N`（`0` 表示纯词法，不启用向量信号）。

### `--query task`：数据集设计了、却没写下来的那道题

`build_qa.py` 的四道题，每一道都把历史 issue 原句引回来——
`关于「WCS.all_world2pix failed to converge」这个历史问题…`。
而这句话正是那条记忆自己的标题，于是检索就塌缩成了「按标题查文档」，
任何一个词法索引都能接近上界。它测的是建索引，不是回忆。

数据集自己的 `memory_dependency.memory_on_expected` 描述的是更难的事，且写得很明白：
*先检索 m1（仓库经验）→ 复用套路 → 直接修 B*。B 是目标任务，它与历史几乎没有共同措辞。
`--query task` 问的就是这一句，其余一律不变：参考答案仍是 gold memory，
判分器与它的 oracle 检查都不受影响。预期分数会低很多，
也预期真正有信息量的是检索一栏而非准确率。

### 唯一一个属于设计问题的开关

这个数据集的历史事件长这样：`edit — apply gold_patch hunk →
astropy/wcs/wcsapi/fitswcs.py`。这个文件路径，正是判分器要数的关键词。
它同时也是**模型自己的一次工具调用**——本系统会索引它、排序它，但拒绝把它引用回去。
正是这条规则，避免了一次会话以「告诉模型它自己刚做过什么」开场。

所以 `--include-evidence` 不是一个调优旋钮，而是一张价签：两轮之差，
就是本系统主动放弃的那部分分数。要引就成对地引，别只挑好看的那一半。

## 产出什么

`bench/out/` 下每种配置三个文件：

- `qa-<mode>-<isolation>.jsonl` —— 题目，用数据集公布的 QA schema，便于它自己的工具读取。
- `answers-<mode>-<isolation>.jsonl` —— `{qa_id, answer}`，即接缝所在。
- `report-<mode>-<isolation>.json` —— 按维度 / 记忆类型 / 仓库拆解的准确率，外加检索诊断与耗时。

其中最该先看的是检索一栏：`hit@1`、`hit@5`、`hit@k`、`MRR`，统计的是
**被提问那条实例自己的**记忆到底有没有被取回来。关键词准确率告诉你分数是多少，
这几个告诉你为什么是这个分数。

同一栏里的 `unattributed_passes`，是向外报准确率之前必须先看的一项。
同一仓库里相邻的记忆会提到重叠的文件，所以关键词命中并不能证明取回来的是对的那条；
这一项统计的就是有多少比例的通过是被**别的**实例的记忆抬上去的。
在 transfer 一轮上，它曾高到足以解释大部分分数。

## 一次完整跑分看到了什么

下表每一行都是全部 2282 条实例，由数据集自己的 `evaluate.py` 判分
（上下界：oracle 100%，blank 0%）。

| 配置 | 准确率 | hit@1 | MRR | 归因不明的通过 |
|---|---|---|---|---|
| `gold` / `repo` / `issue` | 98.8% | 98.0% | 0.983 | 0.1% |
| `gold` / `global` / `issue` | 98.6% | 98.0% | 0.983 | 0.0% |
| `gold` / `repo` / **`task`** | 23.6% | **0.4%** | 0.019 | **76.0%** |
| `raw` / `repo` / `issue` | 1.9% | 76.1% | 0.791 | 0.0% |
| `raw` / `repo` / `issue`，`--no-consolidate` | 4.4% | 88.6% | 0.919 | 0.7% |
| 同上，加 `--include-evidence` | 14.1% | 87.8% | 0.910 | 2.4% |
| `off` / `repo` / `issue` | 0.0% | 0.0% | 0.000 | — |

四点值得带走的结论，其中三点是关于数据集的：

**瓶颈不在检索，而这些题也证明不了它在。** 竞争者从约 850 条涨到 2263 条，
只掉了 0.2 个点——这不是鲁棒性结论，而是“题面直接引了记忆自己的标题”的必然结果。
它测的是建索引。

**transfer 一轮处于随机水平。** hit@1 只有 0.4%，且 76% 的通过来自邻居记忆而非对的那条。
这是配对方式的性质，不是任何检索器的问题：全批上，历史 issue 与目标任务的
词项 Jaccard 仅 0.029，而目标题面提到历史修复所动文件的比例只有 2.1%。
A 里根本没有可供 B 检索的东西。改用“共享子系统”而非“相邻实例号”来配对，可以修好它。

**行为类信念会挤掉其他一切。** 开启蒸馏后，八个线索位全部被工具习惯占满——
`edit is habitually followed by bash`——任何用途的情景记录都进不了答案。
这就是为什么 evidence 对照必须用 `--no-consolidate` 来测；
而这件事在跑分之外同样值得记住：
一张只知道智能体怎么干活的图，就只会向模型讲智能体自己。

**本系统的缺口在蒸馏，不在召回。** `gold` 98.8% 对 `raw` 1.9%：
把对的信念交给它，它找得到；但它还不会自己**形成**那条信念。
`BehaviorCycleDistiller` 挖的是行为周期，而这个数据集要的是领域事实——
一次历史修复动了什么、一个仓库要求什么。在行为蒸馏器旁边再放一个内容蒸馏器，
才是能拉动 `raw` 一列的东西。

## 数据集目前还测不了的两件事

这两点写在这里而不是被悄悄绕过，因为它们界定了本适配层任何一个数字的含义。

**题目是重新生成的，不是随包给的。** 公布的批次只有实例，没有 QA 文件，
而数据集的 `build_qa.py` 读的 `seed_sources.json` 并未随之分发。
`bench/qa.ts` 从实例重新生成那四个维度，逐个模板对齐 `build_qa.py`。
唯一无法照搬的是关键词表 `secret_tokens`——它在实例拼接阶段被丢掉了：
这里改用「一次修复动过的源文件」作为关键词。这些文件名只在记忆里出现过，
在两种参考答案里都存在，而且说得出其中一个，正是这个 benchmark 声称要测的仓库知识。
oracle 检查就是用来保证这次替换是诚实的。

**第二层还不存在。** 数据集自己的 README 就是这么说的，公布的批次也印证了：
没有 `base_commit`，没有 `gold_patch`，没有 `test_patch`。
更进一步，`evaluator.fail_to_pass` 和 `pass_to_pass` 是以 JSON **字符串**而非列表落盘的——
某个流水线环节把字符串当序列迭代了——于是 `["astropy/…"]` 读回来变成 `["[", "\"", "a", …]`。
`dataset.ts` 在加载时修复它并报出修了多少行，但修回来的仍然只是测试**名**。
在摄入流水线补上 commit 与 patch 之前，ΔP（有记忆减无记忆的通过率）算不出来，
本适配层给出的每一个数字都只是第一层：正确的记忆有没有回来。

## 其他数据集

`bench/` 还以检索口径跑三个公开记忆 benchmark——LongMemEval、LoCoMo、PerLTQA，
共用同一套栈、同一组指标、同一个 runner。它们各自测出了什么见
[RESULTS.zh.md](RESULTS.zh.md)，跑法：

```bash
bench/retrieval-matrix.sh /path/to/data-dir          # 全部数据集加两组消融
pnpm exec node --experimental-transform-types bench/retrieval.ts   --suite locomo --dataset /path/to/locomo10.json    # 单个数据集
```

| 文件 | 是什么 |
|---|---|
| `bench/retrieval.ts` | runner：一份语料一轮，启动、灌入、提问、拆除 |
| `bench/stack.ts` | 被测栈，里面没有任何数据集相关的东西 |
| `bench/metrics.ts` | Recall@k、hit@k、MRR、nDCG |
| `bench/suites/*.ts` | 每个数据集一个文件，把它归约成语料、文档与标准答案 id |

## 目录

```
bench/dataset.ts   读取并修复实例文件
bench/qa.ts        重新生成四维题目与判分规则
bench/adapter.ts   被测系统：启动、灌入、作答
bench/run.ts       命令行
bench/matrix.sh    互为上下界的六种配置
bench/score.py     把答案交给数据集的 evaluate.py
bench/retrieval.ts 另外三个数据集，检索口径
bench/RESULTS.md   每个数据集测出了什么（另有 .zh.md）
tests/bench/       钉住上面这些的纯函数部分
```

`bench/adapter.ts` 里放着唯一一处不属于发布代码的东西：把数据集的事件链
映射到记录 kind 与节点 type 的那份策略。引用任何数字之前值得先读它，
因为每一个数字都依赖于它。
