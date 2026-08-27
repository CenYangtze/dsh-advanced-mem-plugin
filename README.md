# dsh-advanced-mem-plugin

English | [中文](README.zh.md)

Cross-session memory for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness), packaged as an installable **bundle**. Drop it into any profile with `dsh plugin add` — no fork, no patch to the harness itself.

The agent remembers the person it works with: what they prefer, what they have ruled out, which tools and skills they reach for, and which sequences of steps they repeat. Those conclusions come back automatically at the start of a turn, and the agent can also search, write, and forget them deliberately through three tools.

```
┌─ layer 1 ── semantic graph ──────────────────────────────────────────┐
│  nodes: person · preference · constraint · project · entity ·        │
│         routine · tool-affinity · skill-affinity · procedure         │
│  edges: the conclusion an event induced between two nodes            │
└──────────────────────────┬───────────────────────────────────────────┘
                           │ every node and edge cites its evidence
┌──────────────────────────┴─── layer 0 ── episodic substrate ─────────┐
│  records: user turns, tool calls, skill invocations, artifacts       │
│  each with lexical terms, an optional dense vector, provenance back  │
│  into the session log, and attachment URIs for images/video/docs     │
└──────────────────────────────────────────────────────────────────────┘
```

Design rationale — why two layers, why decay is applied at read time, why fusion is by rank — is in [docs/design.md](docs/design.md) ([中文](docs/design.zh.md)).

## Requirements

- A DeepSeek Harness installation with the `dsh` CLI on `PATH`.
- A profile whose bundle list includes `@deepseek-ai/dsh-web-app`. That bundle mounts `ctx.storage.domain`, which the durable store needs. The shipped `web` and `headless` profiles both stack it.
- Node 22 or newer.

Without a store the stack still loads: `ctx.memory.ready` stays false, capture and recall skip silently, and the three tools fail loud rather than pretending to remember. That is degradation, not breakage — but you get no memory.

## Install

```sh
dsh plugin --profile web add github:CenYangtze/dsh-advanced-mem-plugin
```

A git install fetches **sources, not built artifacts**, so pnpm must run this package's `prepare` script to produce `lib/`. pnpm ≥10 refuses to do that until you allow it by name, so the first `add` fails and prints the key to allow. Add it to the profile's `pnpm-workspace.yaml` (`$DSH_HOME/profiles/web/pnpm-workspace.yaml`):

```yaml
allowBuilds:
  dsh-advanced-mem-plugin: true
```

then re-run the `add`. Pin a commit so a later push cannot silently change what runs on your machine:

```sh
dsh plugin --profile web add github:CenYangtze/dsh-advanced-mem-plugin#<sha>
```

That allowance is what it sounds like — permission to execute this package's build script on your machine at install time, outside any sandbox the agent runs under. Read the source first, or install a prebuilt tarball instead:

```sh
pnpm pack                                    # in a clone of this repo
dsh plugin --profile web add ./dsh-advanced-mem-plugin-0.1.0.tgz
```

### Verify

```sh
dsh --profile web --dump-config    # shows a "# == dsh-advanced-mem-plugin" layer with 7 rows
dsh --profile web
```

`dsh plugin --profile web remove dsh-advanced-mem-plugin` removes the dependency and the layer together.

## What's in the bundle

Seven plugins, one per role, ordered as the data flows. The `id` column is what you target from your own patch layer; the `name` column is the module the row loads.

| id | name | Role |
|---|---|---|
| `memory` | `dsh-advanced-mem-plugin` | **Service Definition** — `ctx.memory`: vocabulary, provider registries, retrieval, belief update laws. No IO, no model. |
| `memory-store` | `…/store-domain` | **Service Provider** — durable store over `ctx.storage.domain`. |
| `memory-embedding` | `…/embedding-hash` | **Service Provider** — keyless deterministic embedder (signed feature hashing). No network, no API key. |
| `memory-observer` | `…/observer` | **Passive capture** — reads the append-only `session/event` log. |
| `memory-consolidation` | `…/consolidation` | **Service Provider + scheduler** — mines behaviour cycles into graph nodes; runs maintenance sweeps. |
| `memory-recall` | `…/recall` | **Consumer** — retrieves and injects relevant memory once per turn on `agent/pre-step`. |
| `tool-memory` | `…/tool` | **Consumer** — three model-facing tools plus the memory protocol prompt section. |

### The two halves of the loop

**Passive.** The observer captures user turns and tool/skill invocations from the session log — it never intercepts the agent loop, so it cannot change what the model sees, and a failing store degrades memory instead of stalling a turn. Every few turns the consolidator mines what accumulated: an action used often enough becomes a `tool-affinity` or `skill-affinity` node; a sequence of actions repeated within turns becomes a `procedure` node. This is the *"the user keeps reaching for this skill, so try it next time"* path, and it uses **no model** — frequency, recurrence, and adjacency are the whole of its reasoning, which makes it cheap, deterministic, and impossible to hallucinate with.

**Active.** `memory_search`, `memory_write`, and `memory_forget`, plus a fixed prompt section that names the situations which should trigger a deliberate search — tools this general are reliably ignored without one. The section also carries the calibration rule the whole design rests on: **recalled memory is a prior, not an instruction.**

| Tool | Purpose |
|---|---|
| `memory_search` | Query the graph and the episodic substrate with a natural-language cue. |
| `memory_write` | Create or reinforce a belief, optionally linking it to an existing one. |
| `memory_forget` | Retract a belief, or erase the material behind it. |

`memory_write` accepts only the subject types a model can honestly assert — `preference`, `constraint`, `project`, `entity`, `routine`, `person`. The affinity and procedure types are withheld: those are evidence of observed behaviour, and letting a model assert them would dress its own guesses up as usage counts.

## Configuration

Every tunable is a **required** config field. The right half-life for a preference depends on how your deployment is used, so a default here would be an unsupported choice rather than a convenience. The bundle's own [`cordis.patch.yml`](cordis.patch.yml) states a complete working set; override any row from your profile's patch layer at `$DSH_HOME/profiles/web/cordis.patch.yml`:

```yaml
- id: memory
  config:
    recallLimit: 12
    profileLimit: 12
    inferredConfidence: 0.4
    assertedConfidence: 0.9
    inferredHalfLifeMs: 5184000000   # an unreinforced inference halves in 60 days
    assertedHalfLifeMs: 0            # 0 = never erodes: the user said it
    reinforcementRate: 0.25
    contradictionRate: 0.5
    retirementFloor: 0.05
    activationHops: 2
    activationFalloff: 0.45
    recordBudget: 5000
```

A patch replaces a row's **entire** `config` rather than deep-merging keys, so restate every field, not just the one you are changing.

Two knobs worth understanding before you touch the rest:

- **`assertedHalfLifeMs: 0`** is how "never decays" is spelled in configuration. What the user stated outright does not erode and is never swept; only the user unsays it. Everything inferred halves on `inferredHalfLifeMs`.
- **`recordBudget`** bounds retrieval cost. Recall materializes and ranks the requested scope chain in process, so this is load-bearing rather than advisory. A deployment far past it wants a store provider with a real index — the seam permits one; this package does not ship one.

To capture assistant messages too, or to keep a noisy tool out of the substrate:

```yaml
- id: memory-observer
  config:
    captureUserMessages: true
    captureAssistantMessages: true
    captureToolCalls: true
    maxTextLength: 4000
    excludedTools: [bash]
```

## How retrieval works

Three independent signals, fused by reciprocal rank:

1. **Lexical** — Okapi BM25 over indexed terms. The tokenizer emits lowercase word runs plus overlapping character bigrams for scripts written without spaces, so Chinese and Japanese queries hit without a segmentation dictionary.
2. **Vector** — cosine similarity against the query embedding, over records whose stored vector came from the currently mounted embedder. Vectors from different embedders are never compared.
3. **Graph activation** — spreading outward from directly matched nodes across active edges, `activationHops` deep with `activationFalloff` per hop. This is what surfaces a conclusion when the query only matches the raw material behind it.

Fusion consumes only positions, so a BM25 score and a cosine similarity combine with no calibration step between them — which is what lets the embedder be swapped without retuning retrieval. Decay is applied *before* filtering, so a belief nobody reinforces fades out of recall on its own, with no expiry job that has to have run for the result to be correct.

## Fidelity, maintenance, and updates

The three mechanisms that matter once memory starts driving real-world actions:

- **Fidelity is a first-class field.** `verbatim` / `summary` / `derived` classifies how faithfully a record reproduces what happened, and `MemoryQuery.minFidelity` lets a consumer refuse anything below a floor. Truncating a prompt downgrades it rather than leaving a claim it no longer earns. Non-text originals are referenced by `uri` + `mediaType` + `digest`, never copied — so an image or video stays authoritative at its source.
- **Nothing is deleted in place.** `retract` leaves a tombstone, `supersede` records the replacement as an edge, and only `forget` erases — because a user who asks for material to be deleted must get it deleted, not hidden.
- **Confidence moves under three laws.** Reinforcement closes a fraction of the remaining distance to 1, so repeated agreement has diminishing returns and no finite number of observations manufactures certainty from inference alone. Contradiction is multiplicative, so a well-evidenced belief survives one disagreement and a thin one collapses. Decay is exponential in time since last support.

## Developing

The tests drive the real plugin bodies on real Cordis registries, so they need the harness packages resolvable. Clone the harness beside this repo, then:

```sh
git clone https://github.com/deepseek-ai/deepseek-harness
git clone https://github.com/CenYangtze/dsh-advanced-mem-plugin
cd deepseek-harness && pnpm install && pnpm run build:lib:host && cd ..

cd dsh-advanced-mem-plugin
pnpm install
pnpm run link-harness ../deepseek-harness   # junctions the @deepseek-ai/* peers
pnpm run check                              # typecheck → 127 tests → build → verify
```

`link-harness` reproduces locally what a profile does at runtime: it points every `@deepseek-ai/*` peer at one harness installation. That single-instance property is load-bearing — two copies of cordis mean two service registries, and a plugin registered on one is invisible to the other. It is why every harness package is a **peer** dependency here and why `autoInstallPeers: false` is set.

`pnpm run verify` checks the things that otherwise fail at boot: that every `name:` in `cordis.patch.yml` resolves through the exports map, and that each entry point has exactly one plugin shape. A module carrying both a default export and a function-plugin `apply` makes the Cordis Loader drop the plugin namespace — silently.

### Layout

```
src/memory/               the hub: types, scoring, providers, query, service
src/memory-store-domain/  durable store + zod record schemas
src/memory-embedding-hash/  FNV-1a feature-hashing embedder
src/memory-observer/      session-log capture
src/memory-consolidation/ behaviour-cycle distiller + scheduler
src/memory-recall/        pre-step retrieval and injection
src/tool-memory/          three tools + the memory protocol prompt
tests/                    127 tests, one suite per plugin
```

## Known limitations

- **No stemming or lemmatization** in lexical matching — `install` does not match `installs`. Mounting the embedder covers most of the gap; a stemming tokenizer needs per-language rules this package does not own.
- **Recall materializes the whole scope chain per query.** See `recordBudget` above.
- **Vectors are only compared within one embedder.** Swapping embedders silently drops the vector signal for every record written before the change; those records stay lexically reachable but are not re-embedded in a batch.
- **Nothing captures tool *results*.** Consolidation therefore learns habits, not what worked. That is the gap most worth closing before memory drives real-world actions, and the distiller seam is where an outcome-learning provider would attach.
- **Contradiction is caller-driven.** Nothing notices that two active nodes disagree; the graph does not police its own consistency.
- **Computer Use, MCP application adapters, and action execution are not implemented.** What memory already owes them is in place — fidelity floors at the query interface, attachment references rather than copies, `procedure` nodes carrying ordered steps, provenance back into the session log, supersession over deletion, scope partitioning. What is missing is outcome capture and a confirmation policy for irreversible steps.

## Relationship to upstream

These sources were developed against the DeepSeek Harness tree and repackaged here as a standalone bundle so they can be installed without forking the harness. The plugin bodies are unchanged; only module identities and cross-package imports differ. Upstream conventions this package follows — the capability-seam split, `Model-visible ⟺ logged`, no hardcoded tunables, the plugin-shape rule — are documented in the harness's own `AGENTS.md`.

## License

MIT. See [LICENSE](LICENSE).
