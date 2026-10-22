# Dataset evaluation API

[中文](evaluation.zh.md)

The `dsh-advanced-mem-plugin/evaluation` entry point evaluates the production memory implementation against conversational memory and desktop tasks. Model inference uses an OpenAI-compatible HTTP API. Every QA attempt opens an isolated Harness memory runtime; OSWorld actions execute in the official `DesktopEnv` through the included HTTP bridge.

| Dataset | Loader | Execution and scoring |
| --- | --- | --- |
| [LongMemEval](https://github.com/xiaowu0162/LongMemEval) | `loadLongMemEval(path, { revision, source })` | Official oracle, S, or M JSON; category-aware semantic judge and export for the official scorer |
| [LoCoMo](https://github.com/snap-research/locomo) | `loadLoCoMo(path, { revision, source })` | Official `locomo10.json`, all five QA categories; semantic judge and export for the official category-specific scorer |
| [OSWorld](https://github.com/xlang-ai/OSWorld) | `loadOSWorld(examplesRoot, selectionPath, { revision, source, at })` | Official task selection/configuration; screenshot and accessibility observations, pyautogui actions, and `DesktopEnv.evaluate()` |

Pin dataset and Harness revisions in each run. LongMemEval publishes its cleaned data on [Hugging Face](https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned). The loaders preserve supplied history timestamps, including the source dataset's non-monotonic question/session times. Dates without a timezone are interpreted as UTC.

## Run conversational evaluation

Use Node.js 24 or a TypeScript application importing the built package. The following application runs inside a Harness workspace with its storage packages available. `memory-policy.json` contains the complete memory service configuration from the deployment profile; no evaluation-specific memory policy is substituted.

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
      // Mount the deployment's embedding/distillation providers here when enabled.
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

All deployment knobs are explicit. A custom embedding provider can be mounted on the isolated runtime using `registerEmbedder`; a custom factual distiller uses `registerDistiller`. Set `consolidate: true` when that provider is part of the evaluated system. Include its model, prompt revision, and settings in `manifest.memory`.

The adapter ingests user messages as recallable factual records and assistant messages as evidence. It preserves the production rules for supporting question/confirmation context. LoCoMo's two speakers are people, so both are ingested as user-authored statements. A case's reference, answer-bearing annotations, adversarial answer, and gold retrieval IDs are excluded from the model request.

Use `loadLoCoMo` in the same flow. `exportLoCoMoPredictions(originalJson, report, 'api_prediction')` returns the original annotated data with predictions added. Save that returned object for the upstream scorer. It preserves adversarial questions and does not turn the deliberately incorrect `adversarial_answer` into a gold answer.

## Scores and continuation

`createSemanticJudge` produces `semantic-accuracy-v1`, with explicit abstention, temporal, preference, and knowledge-update rules. Its prompt is versioned separately from the official dataset prompts. To reproduce published scoring protocols, run the pinned upstream scripts on the exported predictions:

```sh
# From the pinned LongMemEval checkout, with its evaluator environment configured:
python src/evaluation/evaluate_qa.py gpt-4o predictions.jsonl longmemeval_s_cleaned.json
```

For LoCoMo, load the exported JSON in its Python environment and call `task_eval.evaluation.eval_question_answering(conversation['qa'], eval_key='api_prediction')` for each conversation. The upstream scorer applies stemmed F1, multi-answer aggregation, and its adversarial matching rule. Keep these results under their own metric name when comparing with `semantic-accuracy-v1`.

Each result records status, elapsed time, prediction, judge response, reported token use, and retrieval message/session recall and reciprocal rank. Summary latency covers ingestion, retrieval, inference, and grading. API providers that omit usage fields contribute zero reported tokens. Metric means include their observation counts; `metricsIncludingFailures` assigns zero to failed attempts. `pendingIds` identifies cases not started before cancellation.

The run directory contains a fixed `manifest.json` and append-only `results.jsonl`. Resume requires the same dataset fingerprint, sample order, implementation revision, models, policies, and execution settings. Successful cases are reused; `retryFailed` controls failed-case retries, each with a fresh namespace. An interrupted final JSONL line is removed on recovery. A writer lock prevents concurrent use of the same output directory; after a process crash, verify the recorded PID is no longer running before removing `writer.lock`.

## Frozen experience and independent training

Train the experience bank on separate tasks, then call `freezeExperienceBank` before evaluation. The API requires a training dataset fingerprint and an `ExperienceTrainingSource` entry for every source episode. Each entry supplies its scope, episode ID, case ID, `evaluationUnitFingerprint(trainingCase)`, and the required `evaluationSessionFingerprints(trainingCase)` array. Session fingerprints contain ordered message roles and text, excluding IDs, dates, and evaluation labels. The split check catches shared individual sessions across different history collections, including sessions renamed by a different dataset export. Tasks without history use an empty session array and retain the task/question fingerprint check.

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

`withFrozenExperience` creates separate `factualMemory` and `experienceSkills` fields. A skill carries applicability, preconditions, procedure, cautions, and verification; it does not become a user fact. The bank is copied into a read-only store and uses a fixed recall clock. Put `bank.fingerprint`, the training dataset fingerprint, freeze time, environment, and tool inventory into the run manifest. Evaluation outcomes do not update this bank.

For OSWorld training, `recordOSWorldTrainingExperience` accepts a completed trajectory, declared disjoint training/held-out task IDs, and IDs of already persisted trajectory/evaluator evidence. It reads `memory.policy.maxTextLength` and `memory.policy.maxSteps`: task/summary/action text is bounded, and longer trajectories are sampled evenly while retaining the first and final steps (a one-step budget retains the final step). `maxObservationChars` is also capped by the policy's text budget. Observation text uses the accessibility tree or terminal; screenshot-only observations point to the retained screenshot, and absent text is identified explicitly. Empty trajectories use the task instruction as their summary. The complete source trajectory remains in the cited artifact; the imported episode stores a bounded projection and the verified terminal outcome.

```js
await recordOSWorldTrainingExperience({
  memory: experienceMemory, scope: trainingScope, trajectory,
  environment: { os: 'Ubuntu', application: 'LibreOffice' },
  evidenceIds: persistedEvidenceIds, trainingTaskIds, heldOutTaskIds,
  maxObservationChars: 1000,
})
```

Call `experienceMemory.learn(scope, distiller)` to extract candidates, and use `feedback`, `maintain`, `retract`, and `forget` for the normal lifecycle. Feedback comes from later independent training tasks; held-out task outcomes remain evaluation artifacts.

## OSWorld environment

Install and pin [OSWorld](https://github.com/xlang-ai/OSWorld), configure its supported virtualization provider and image, and prepare a JSON file containing its `DesktopEnv` constructor settings. Explicitly set `action_space` to `pyautogui` and enable `require_a11y_tree` when the agent uses accessibility observations. Start the bridge in that Python environment:

```sh
python /path/to/dsh-advanced-mem-plugin/src/evaluation/osworld_bridge.py \
  --host 127.0.0.1 --port 8765 \
  --environment-config /path/to/desktop-env.json \
  --token-env OSWORLD_BRIDGE_TOKEN --max-request-bytes 16777216
```

The token is read from the named environment variable. A bridge leases one VM to one attempt. Use one endpoint per concurrent worker; a single bridge uses `execution.concurrency: 1`. Keep remotely hosted bridges behind the team's authenticated HTTPS ingress.

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

Construct `osworldManifest` from `data.dataset` using the same fields as the QA manifest, with `protocol: 'osworld-frozen-v1'`. Record the OSWorld commit, VM image/snapshot, provider configuration, resolution, and environment dependencies in `manifest.memory`. `runOSWorld` adds action/context budgets and the system prompt to the persisted agent configuration.

The model receives the instruction, recalled context, recent actions, and current observation. Task setup and evaluator configuration travel only to the environment bridge. The HTTP adapter bounds each response by `maxResponseBytes` and validates observation, step, score, and close responses before use. Actions are sent once, including `DONE`, `FAIL`, and `WAIT`; a failed HTTP action request is accounted as a failed attempt. After each step, the trajectory is written to a temporary file, flushed, and atomically renamed over the attempt's JSON file. An interrupted update preserves the preceding complete snapshot. The bridge calls the official evaluator after the trajectory ends. Every attempt saves its initial observation, trajectory, and official score; the run summary reports `osworld-task-score` by application domain.
