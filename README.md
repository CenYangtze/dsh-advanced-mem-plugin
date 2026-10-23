# dsh-advanced-mem-plugin

English | [中文](README.zh.md)

Cross-session **factual and experience memory** for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness), distributed as an installable Cordis bundle. It preserves user knowledge, learns reusable procedures from completed tasks, and brings the appropriate memory into the next task. The same experience engine and evaluation interfaces are available as TypeScript APIs.

```mermaid
flowchart LR
  L[Committed session log] --> F[Factual records and graph]
  L --> E[Task episodes and outcomes]
  E --> D[Harness model experience extraction]
  D --> S[Versioned procedure and pitfall skills]
  F --> FR[Factual recall]
  S --> ER[Environment and tool matched recall]
  FR --> T[Next agent turn]
  ER --> T
  V[Evaluator or user confirmation] --> E
  T --> V
```

The factual channel remembers what is known about the user and workspace. The experience channel remembers how to complete a class of tasks, under which conditions, and how to check the result. Separate storage, provenance rules and recall budgets keep these meanings distinct.

## Compatibility and installation

Plugin **0.2.1** supports **DeepSeek Harness `dsh-v0.2.1-rc.2`**, official commit [`687f282e`](https://github.com/deepseek-ai/deepseek-harness/commit/687f282e8625c6b8d11ff58211a90524be2e4317). See the [compatibility report](docs/compatibility.md) for the verified API changes and checks. Use the Node version required by that Harness release. The standard `web` profile supplies the model, storage and agent services used by the bundle.

```sh
npm install -g @deepseek-ai/dsh@0.2.1-rc.2
dsh plugin --profile web add github:CenYangtze/dsh-advanced-mem-plugin#master
dsh --profile web --dump-config
dsh web
```

`dsh web` starts the local GUI and automatically opens an authenticated browser URL containing an access token. The default local address is [http://127.0.0.1:3080](http://127.0.0.1:3080); use the tab opened by the launcher. Configure your provider in Harness and select a model in the conversation. Experience extraction uses that selection and the provider authentication already managed by Harness.

Git installation builds `lib/` with the package's `prepare` script. If pnpm requests build approval, add the package to the profile's `pnpm-workspace.yaml`, then repeat installation:

```yaml
allowBuilds:
  dsh-advanced-mem-plugin: true
```

A prebuilt package can also be installed:

```sh
pnpm run build
pnpm pack
dsh plugin --profile web add ./dsh-advanced-mem-plugin-0.2.1.tgz
```

The shipped patch mounts ten plugin rows. The feature-hash embedding provider is available as an optional entry point; the default factual retrieval uses lexical ranking and graph activation. All Harness packages remain peers and are resolved from the host installation.

## Use factual memory

Factual capture reads committed session events. Direct user messages and explicitly invoked skills can support beliefs about the user; assistant output and tool invocations remain evidence and are excluded from ordinary recall and user-preference mining.

- `memory_search`: retrieve factual knowledge in the current scope chain.
- `memory_write`: record a note or supported belief.
- `memory_forget` with `mode: "erase"`: erase source records and propagate deletion to dependent experience; the default `retract` mode retains history.
- `/memory`, `/memory search <query>`, `/memory stats`: inspect the factual channel.
- `/memory forget <label>`: retract a named belief, preserving its audit history.

The semantic graph keeps source-record citations, confidence, support, decay and supersession. BM25, optional embeddings and graph activation share the same reciprocal-rank transform. Automatic factual recall is appended once per turn and preserves the Harness request-series boundary.

## Learn and use experience

The default `extractionMode: harness` reuses the current conversation's **provider, model and authentication** through the Harness LLM service. Setup requires no additional experience API environment variables. Model selection is read for each extraction, so a model change in the GUI applies to subsequent learning. Sessions without a selected route use the current Harness default model.

Automatic extraction runs after each captured task with the shipped configuration. `/experience learn` starts extraction on demand, and `/experience confirm` records the outcome before triggering learning. These auxiliary requests have their own input, output and timeout budgets and carry no tool permissions.

The observer captures bounded visible actions and results, including nested PTC dispatches. It retains no raw tool arguments or hidden reasoning. A completed Harness turn has an **unknown task outcome**. An application evaluator can submit a verified task via `experience/task-completed`; a person can confirm a captured task:

```text
/experience list
/experience confirm <episode-id> success
/experience learn
/experience show <skill-id>
/experience export <skill-id>
/experience retract <skill-id>
/experience forget episode <episode-id>
/experience forget skill <skill-id>
/experience forget all
/experience maintain
```

Extraction produces structured procedures and pitfalls: applicability, preconditions, ordered steps, cautions, verification, required tools, environment constraints and source episodes. Active skills must meet the configured confidence and independently supported outcome thresholds. Model-generated success claims alone do not activate a skill.

Recall selects active, unexpired skills matching the current task, exact environment constraints and the agent's available tools. It adds a separate experience block once per turn. Recalled procedures guide planning; the host's current instructions, tool permissions and approval policies continue to govern execution. Export produces a Harness-compatible `SKILL.md` with YAML name and description, lifecycle metadata and source references. Save it under `.agents/skills/<exported-name>/SKILL.md` when you choose to install it as a workspace skill.

### Use a separate extraction API

For a dedicated extraction model, set `extractionMode: api` in the profile's `cordis.patch.yml` and define the endpoint, model and key in the shell that starts Harness. `DSH_EXPERIENCE_ENDPOINT` is the complete OpenAI-compatible **chat/completions** URL. A local unauthenticated API may leave the key empty.

Profile patches replace a row's **entire `config`**. Add this complete override for the `experience-harness` row, retaining any deployment values you have customized:

```yaml
- id: experience-harness
  config:
    captureTurns: true
    autoLearn: true
    learnEveryTurns: 1
    maxPendingJobs: 32
    maxRecall: 3
    maxCharacters: 5000
    recallTimeoutMs: 250
    viewLimit: 20
    excludedTools: []
    transportTools: [run_code]
    environment: []
    availableTools: []
    extractionMode: api
    endpointEnv: DSH_EXPERIENCE_ENDPOINT
    modelEnv: DSH_EXPERIENCE_MODEL
    apiKeyEnv: DSH_EXPERIENCE_API_KEY
    temperature: 0
    maxTokens: 4096
    timeoutMs: 60000
    maxResponseBytes: 1048576
    maxExtractionInputChars: 64000
    maxObservationLength: 1000
    promptVersion: experience-v2
```

For PowerShell:

```powershell
$env:DSH_EXPERIENCE_ENDPOINT = 'https://your-provider.example/v1/chat/completions'
$env:DSH_EXPERIENCE_MODEL = 'your-model'
$env:DSH_EXPERIENCE_API_KEY = 'your-api-key'
dsh web
```

For Bash or Zsh:

```sh
export DSH_EXPERIENCE_ENDPOINT=https://your-provider.example/v1/chat/completions
export DSH_EXPERIENCE_MODEL=your-model
export DSH_EXPERIENCE_API_KEY=your-api-key
dsh web
```

The `web` profile patch lives at `$DSH_HOME/profiles/web/cordis.patch.yml`, with `DSH_HOME` defaulting to `~/.dsh`. To return to the conversation model, set `extractionMode: harness` in the complete row config. The standalone TypeScript extraction provider remains available for applications and evaluation runners that supply their own API connection.

## Lifecycle and deployment policy

| Operation | Persistent behavior |
|---|---|
| Deduplicate | Merge new supporting episodes into an equivalent procedure; repeated extraction adds no extra vote. |
| Validate | Record evaluator or user confirmation as an immutable episode; retain the earlier outcome. |
| Apply feedback | Accept feedback from a later independent task; update confidence and isolate repeatedly harmful skills. |
| Replace | Activate an evidence-backed successor and retain the predecessor and version history. |
| Expire | Filter expired skills during retrieval, even before maintenance runs. |
| Retract | Keep a tombstone and audit history. |
| Forget | Erase the selected material and its derived skills, revisions, feedback and confirmation descendants. Forgetting a skill also erases its source episodes and other skills sharing those episodes; use retract to withdraw only one skill. |
| Reach capacity | Reject additional writes explicitly; reclaim space through export and deliberate erasure. |

Every policy value is explicit in [cordis.patch.yml](cordis.patch.yml). Override a row by its `id` in the profile patch and supply its complete `config`; copy the corresponding shipped row before changing individual values. Profile overrides replace that config rather than merging its fields. Configure `environment` entries such as `browser=chromium` and `application=libreoffice-24`; the local OS is added automatically. `availableTools` optionally narrows the current agent's tool registry. Capture and extraction budgets, TTLs, outcome weights and promotion thresholds are deployment settings.

The Harness provider stores complete experience-scope snapshots in a separate `experience` storage domain. The standalone `FileExperienceStore` uses atomic replacement and an exclusive writer lease. Each tenant should have its own runtime/store or explicit scope namespace. [Architecture and design](docs/design.md) describes the storage and consistency contracts.

## Programmatic API and evaluation

```ts
import {
  ExperienceMemory, FileExperienceStore, createOpenAIExperienceDistiller,
} from 'dsh-advanced-mem-plugin/experience/api'
import {
  loadLongMemEval, loadLoCoMo, evaluateDataset,
  createApiAgentFactory, createHarnessMemoryFactory, JsonlCheckpoint,
} from 'dsh-advanced-mem-plugin/evaluation'
```

The experience API supports `record`, `learn`, `propose`, `confirmOutcome`, `recall`, `feedback`, `maintain`, `retract`, `forget`, `snapshot` and `export`. Harness consumers access the same engine through `ctx.experience.memory`.

The evaluation API provides **LongMemEval**, **LoCoMo** and **OSWorld** adapters. QA runs use isolated namespaces and keep references out of agent input. Runs save a manifest, sample results, latency, token usage and resumable checkpoints. OSWorld uses a Python HTTP bridge to the real `DesktopEnv` reset/step/evaluate lifecycle; its official environment evaluator supplies the task score. Frozen experience banks keep learning and held-out evaluation separate.

See [the evaluation guide](docs/evaluation.md) for executable API examples, dataset formats, API configuration, metrics and OSWorld deployment. Evaluation artifacts and model smoke-test helpers belong outside the source tree; the published package contains the runtime and adapters.

## Development

```sh
# Build the supported official Harness checkout first, following its instructions.
pnpm install
pnpm run link-harness ../deepseek-harness
pnpm run check
```

`check` runs type checking, the existing regression suite, the package build and export/plugin-shape verification. The verifier distinguishes service plugins, function plugins and programmatic API libraries. No `@deepseek-ai/*` dependency is bundled.

| Directory | Responsibility |
|---|---|
| `src/memory/` | Factual vocabulary, scoring, providers, retrieval and graph lifecycle |
| `src/memory-store-domain/` | Durable factual records, nodes and edges |
| `src/memory-observer/`, `src/memory-consolidation/` | Event capture and factual distillation |
| `src/memory-recall/`, `src/tool-memory/`, `src/command-memory/` | Factual model and user interfaces |
| `src/experience/` | Portable experience engine, schema, API extraction, file store and skill export |
| `src/experience-store-domain/` | Harness experience persistence |
| `src/experience-harness/` | Task capture, current-model extraction, recall, commands and lifecycle integration |
| `src/evaluation/` | Dataset readers, API clients, runners, checkpoints and OSWorld bridge |
| `bench/` | Existing retrieval-analysis utilities |

## Research basis

[ExpeL](https://arxiv.org/abs/2308.10144) motivates extracting reusable knowledge across task experiences. [ReasoningBank](https://arxiv.org/abs/2509.25140) motivates learning procedures and failure lessons from completed trajectories. This implementation adds explicit outcome provenance, separate factual and procedural stores, versioned lifecycle operations and environment-aware applicability.

## License

MIT. See [LICENSE](LICENSE).
