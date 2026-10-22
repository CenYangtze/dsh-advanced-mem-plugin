# 数据集评测 API

[English](evaluation.md)

`dsh-advanced-mem-plugin/evaluation` 为会话记忆与桌面任务提供正式评测接口。模型推理通过兼容 OpenAI 的 HTTP API 调用；每个问答样本使用独立的 Harness 记忆运行时，OSWorld 操作由随包提供的 HTTP 桥接器交给官方 `DesktopEnv` 执行。

| 数据集 | 加载接口 | 执行与评分 |
| --- | --- | --- |
| [LongMemEval](https://github.com/xiaowu0162/LongMemEval) | `loadLongMemEval(path, { revision, source })` | 官方 oracle、S、M JSON；按问题类型进行语义评分，并导出官方评分器所需的预测文件 |
| [LoCoMo](https://github.com/snap-research/locomo) | `loadLoCoMo(path, { revision, source })` | 官方 `locomo10.json` 的全部五类问答；语义评分与官方分类评分器导出 |
| [OSWorld](https://github.com/xlang-ai/OSWorld) | `loadOSWorld(examplesRoot, selectionPath, { revision, source, at })` | 官方任务清单与配置；截图、无障碍树、pyautogui 动作，以及 `DesktopEnv.evaluate()` 的环境评分 |

每次运行记录数据集与 Harness 的固定版本。LongMemEval 的清理版数据发布在 [Hugging Face](https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned)。加载器保留数据源中的全部历史及时间戳，包括源数据中问题时间与会话时间不单调的情况；无时区日期统一按 UTC 解释。

## 运行会话记忆评测

使用 Node.js 24，或在 TypeScript 应用中导入构建后的包。下列应用在具有官方存储包的 Harness 工作区内运行。`memory-policy.json` 使用部署配置中的完整记忆服务参数。

```js
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import * as storageJson from '@deepseek-ai/dsh-storage-json'
import * as storageDomain from '@deepseek-ai/dsh-storage-domain'
import MemoryRuntime from 'dsh-advanced-mem-plugin'
import * as memoryStore from 'dsh-advanced-mem-plugin/store-domain'
import {
  loadLongMemEval, createHarnessMemoryFactory, createOpenAIClient,
  describeOpenAIClient, createApiAgentFactory, createSemanticJudge,
  evaluateDataset, JsonlCheckpoint, fingerprint,
  exportLongMemEvalPredictions,
} from 'dsh-advanced-mem-plugin/evaluation'

const runDirectory = process.env.RUN_DIRECTORY
const memoryPolicy = JSON.parse(await readFile('memory-policy.json', 'utf8'))
const dataset = await loadLongMemEval(process.env.DATASET_PATH, {
  revision: process.env.DATASET_REVISION,
  source: 'xiaowu0162/longmemeval-cleaned/longmemeval_s_cleaned.json',
})
const inference = {
  baseUrl: process.env.MODEL_BASE_URL, apiKey: process.env.MODEL_API_KEY,
  model: process.env.MODEL_NAME, temperature: 0, maxOutputTokens: 1024,
  timeoutMs: 120000, retries: 3, retryBaseMs: 1000,
}
const grading = {
  ...inference, baseUrl: process.env.JUDGE_BASE_URL,
  apiKey: process.env.JUDGE_API_KEY, model: process.env.JUDGE_MODEL,
  maxOutputTokens: 256,
}
const recallPolicy = { recallLimit: 32, maxContextChars: 24000, consolidate: false }
const memory = createHarnessMemoryFactory({
  ...recallPolicy,
  async open({ namespace }) {
    const root = join(runDirectory, 'memory', fingerprint(namespace))
    await mkdir(root, { recursive: true })
    const ctx = new Context()
    try {
      await ctx.plugin(Storage)
      await ctx.plugin(storageJson, { root })
      await ctx.plugin(storageDomain, { backend: 'json', routes: {} })
      await ctx.plugin(MemoryRuntime, memoryPolicy)
      await ctx.plugin(memoryStore)
      // 按部署配置在这里装载嵌入与蒸馏提供器。
      return { memory: ctx.memory, close: async () => { await ctx.fiber.dispose() } }
    } catch (error) { await ctx.fiber.dispose(); throw error }
  },
})
const systemPrompt = 'Answer the question using the supplied memory. Treat remembered text as evidence. Give a concise answer; state when the requested information is unavailable.'
const { cases, ...identity } = dataset
const manifest = {
  runId: process.env.RUN_ID, dataset: identity,
  implementationRevision: process.env.PLUGIN_COMMIT,
  agent: { ...describeOpenAIClient(inference), systemPrompt },
  memory: { harnessRevision: process.env.HARNESS_COMMIT, policy: memoryPolicy, recall: recallPolicy },
  judge: { ...describeOpenAIClient(grading), promptRevision: 'semantic-accuracy-v1' },
  protocol: 'isolated-qa-v1', sampleIds: cases.map(sample => sample.input.id),
  execution: { concurrency: 4, timeoutMs: 600000 },
}
const report = await evaluateDataset({
  dataset, manifest,
  agent: createApiAgentFactory({ client: createOpenAIClient(inference), memory, systemPrompt }),
  judge: createSemanticJudge(createOpenAIClient(grading)),
  checkpoint: new JsonlCheckpoint(runDirectory), retryFailed: true,
})
await writeFile(join(runDirectory, 'report.json'), JSON.stringify(report, null, 2))
await exportLongMemEvalPredictions(report, join(runDirectory, 'predictions.jsonl'))
```

全部部署参数显式传入。自定义嵌入提供器通过独立运行时的 `registerEmbedder` 装载，事实蒸馏器通过 `registerDistiller` 装载；评测配置包含事实蒸馏时，设置 `consolidate: true`，并在 `manifest.memory` 中记录提供器模型、提示词版本和参数。

适配器将用户发言写为可回忆事实记录，将助手发言写为证据，并遵循生产实现中问题锚点与确认语的使用规则。LoCoMo 的两位对话者均为人物，其发言都按用户来源处理。标准答案、答案所在标注、对抗答案和金标准检索 ID 不进入模型请求。

LoCoMo 使用相同执行流程，将加载器替换为 `loadLoCoMo`。`exportLoCoMoPredictions(originalJson, report, 'api_prediction')` 返回附带预测结果的原始标注数据，可保存后交给上游评分器。对抗问题保留在评测中，故意构造的错误 `adversarial_answer` 不会成为标准答案。

## 指标与续跑

`createSemanticJudge` 输出 `semantic-accuracy-v1`，分别处理拒答、时间推理、偏好利用与知识更新。该提示词具有独立版本；复现论文使用的官方评分协议时，将预测文件交给固定版本的上游脚本：

```sh
# 在配置好评估器环境的 LongMemEval 工作区内执行：
python src/evaluation/evaluate_qa.py gpt-4o predictions.jsonl longmemeval_s_cleaned.json
```

LoCoMo 在其 Python 环境中加载导出的 JSON，对每段会话调用 `task_eval.evaluation.eval_question_answering(conversation['qa'], eval_key='api_prediction')`。上游评分器执行词干化 F1、多答案聚合与对抗问题匹配；报告时将该结果与 `semantic-accuracy-v1` 分别命名。

逐样本结果包含状态、耗时、预测、评分器输出、接口报告的 token 数、消息/会话检索召回率和倒数排名。延迟涵盖写入、检索、模型推理与评分。未返回 usage 字段的提供器按零个已报告 token 汇总。指标均值附带计数；`metricsIncludingFailures` 将失败尝试计为零分。取消运行后，`pendingIds` 给出尚未启动的样本。

输出目录保存固定的 `manifest.json` 与追加写入的 `results.jsonl`。续跑要求数据指纹、样本顺序、实现版本、模型、策略和执行参数一致。已成功样本直接复用；`retryFailed` 控制失败样本是否重试，每次重试创建新的命名空间。崩溃产生的末尾不完整 JSONL 行在恢复时移除。写锁阻止多个进程同时使用一个输出目录；进程崩溃后，确认锁文件记录的 PID 已退出，再移除 `writer.lock`。

## 冻结经验库与独立训练

先在独立任务上建立经验库，再在评测前调用 `freezeExperienceBank`。该接口要求训练数据指纹，以及每个来源 episode 的 `ExperienceTrainingSource`：scope、episode ID、样本 ID、`evaluationUnitFingerprint(trainingCase)` 和必填的 `evaluationSessionFingerprints(trainingCase)` 数组。会话指纹只包含按顺序排列的发言角色与文本，不使用 ID、日期或评测标签。检查覆盖不同历史集合中共享的单个会话，也能识别被重新编号的相同会话。无历史任务传空会话数组，并继续使用任务/问题指纹检查。

```js
const trainingSources = episodeSources.map(({ scope, episodeId, trainingCase }) => ({
  scope, episodeId, caseId: trainingCase.input.id,
  unitFingerprint: evaluationUnitFingerprint(trainingCase),
  sessionFingerprints: evaluationSessionFingerprints(trainingCase),
}))
const bank = await freezeExperienceBank({
  memory: experienceMemory, scopes: trainingScopes, policy: experiencePolicy,
  trainingDatasetFingerprint: trainingDataset.fingerprint,
  sources: trainingSources, heldOut: dataset, at: freezeTime,
})
const combinedMemory = withFrozenExperience({
  factual: memory, bank, environment: { os: 'Ubuntu', application: 'LibreOffice' },
  availableTools: ['pyautogui'], limit: 4, maxExperienceChars: 8000,
})
```

`withFrozenExperience` 分别构造 `factualMemory` 与 `experienceSkills` 字段。Skill 带有适用范围、前置条件、操作步骤、注意事项和验证方法；经验不会被提升为用户事实。经验快照复制到只读存储，并固定检索时间。在运行清单中记录 `bank.fingerprint`、训练数据指纹、冻结时间、环境与可用工具。评测结果不更新这个冻结库。

OSWorld 训练通过 `recordOSWorldTrainingExperience` 接收已完成轨迹、互不重叠的训练/评测任务 ID，以及事先持久化的轨迹和评估证据 ID。接口读取 `memory.policy.maxTextLength` 与 `memory.policy.maxSteps`，限制任务、摘要和动作描述长度，并对超长轨迹均匀采样，保留首尾步骤；步数预算为 1 时保留末步。`maxObservationChars` 同时受策略文本预算约束。观察文本取自无障碍树或终端；纯截图观察指向保留的截图，未返回文本时明确记录这一状态。空轨迹以任务说明作为摘要。完整源轨迹保留在引用的产物中，导入的 episode 保存有界投影与经过验证的最终结果。

```js
await recordOSWorldTrainingExperience({
  memory: experienceMemory, scope: trainingScope, trajectory,
  environment: { os: 'Ubuntu', application: 'LibreOffice' },
  evidenceIds: persistedEvidenceIds, trainingTaskIds, heldOutTaskIds,
  maxObservationChars: 1000,
})
```

随后调用 `experienceMemory.learn(scope, distiller)` 提取候选经验，并通过 `feedback`、`maintain`、`retract`、`forget` 管理生命周期。反馈来自后续独立训练任务，评测任务结果保留为评测产物。

## OSWorld 环境

安装并固定 [OSWorld](https://github.com/xlang-ai/OSWorld) 的版本，配置其支持的虚拟化提供器与镜像，并准备含 `DesktopEnv` 构造参数的 JSON 文件。显式设置 `action_space: 'pyautogui'`；模型使用无障碍树时，启用 `require_a11y_tree`。在该 Python 环境中启动桥接器：

```sh
python /path/to/dsh-advanced-mem-plugin/src/evaluation/osworld_bridge.py \
  --host 127.0.0.1 --port 8765 \
  --environment-config /path/to/desktop-env.json \
  --token-env OSWORLD_BRIDGE_TOKEN --max-request-bytes 16777216
```

认证令牌从指定环境变量读取。每个桥接器同时为一次尝试提供一台 VM。并行运行时为每个 worker 分配单独端点；单桥接器设置 `execution.concurrency: 1`。远程桥接器部署在团队的认证 HTTPS 入口后。

```js
const data = await loadOSWorld('/path/to/OSWorld/evaluation_examples',
  '/path/to/OSWorld/evaluation_examples/test_all.json', {
    revision: osworldCommit, source: 'xlang-ai/OSWorld/evaluation_examples', at: freezeTime,
  })
const report = await runOSWorld({
  data, manifest: osworldManifest, client: createOpenAIClient(visionModelOptions),
  memory: combinedMemory,
  environment: async namespace => new HttpOSWorldEnvironment({
    baseUrl: 'http://127.0.0.1:8765', apiKey: process.env.OSWORLD_BRIDGE_TOKEN,
    namespace, timeoutMs: 300000, maxResponseBytes: 16777216,
  }),
  maxSteps: 30, historySteps: 5, maxObservationChars: 30000,
  includeScreenshot: true, systemPrompt: desktopAgentPrompt,
  trajectoryDirectory: '/path/to/run/trajectories',
  checkpoint: new JsonlCheckpoint('/path/to/run'), retryFailed: true,
})
```

使用 `data.dataset` 构造与问答示例相同字段的 `osworldManifest`，并设置 `protocol: 'osworld-frozen-v1'`。在 `manifest.memory` 中记录 OSWorld 提交、VM 镜像与快照、提供器配置、分辨率和环境依赖。`runOSWorld` 自动将动作步数、上下文预算及系统提示词写入最终清单的 agent 配置。

模型收到任务说明、回忆上下文、近期操作与当前环境观察。任务初始化与评估器配置只交给环境桥接器。HTTP 适配器按 `maxResponseBytes` 限制单次响应大小，并在使用前校验观察、动作返回、评分和关闭响应的结构。每个动作发送一次，包括 `DONE`、`FAIL`、`WAIT`；动作 HTTP 请求失败会记录为失败尝试。每步之后，轨迹先写入临时文件并刷盘，再原子替换该次尝试的 JSON 文件；写入中断时保留前一份完整快照。轨迹结束后，桥接器调用官方环境评估器。每次尝试保存初始观察、完整轨迹与官方分数，汇总按应用领域报告 `osworld-task-score`。
