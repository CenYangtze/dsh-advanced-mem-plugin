# AGENTS.md

An out-of-tree DeepSeek Harness **bundle**: ten mounted Cordis plugins provide separate factual and experience memory, alongside portable experience and evaluation APIs. Read [README.md](README.md) for installation and use; this file is the working contract for changing it.

## Commands

| Command | What it checks |
|---|---|
| `pnpm run link-harness ../deepseek-harness` | One-time dev setup: junction every `@deepseek-ai/*` peer to a harness checkout. |
| `pnpm run typecheck` | `tsc --noEmit` over `src/`, `tests/`, and the configs. |
| `pnpm run test` | The maintained regression suites for the factual plugins and benchmark harness. |
| `pnpm run build` | `tsdown` → `lib/`. Also the `prepare` script pnpm runs on a git install. |
| `pnpm run verify` | Patch rows resolve through the exports map; each entry point has exactly one plugin shape. |
| `pnpm run check` | All four, in order. Run before pushing — nothing on the server runs them. |
| `pnpm run bench -- --dataset <jsonl>` | Score the stack against a benchmark; see [bench/README.md](bench/README.md). |

## Rules

**One instance of everything the harness owns.** Every `@deepseek-ai/*` package is a `peerDependency`, never a dependency, and `autoInstallPeers: false` keeps pnpm from fetching a second copy. Two cordis instances mean two service registries, and a plugin registered on one is invisible to the other. `deps.neverBundle` in [tsdown.config.ts](tsdown.config.ts) enforces the same thing at build time.

**A module is a service *or* a function plugin, never both.** A service module default-exports its class and nothing else plugin-shaped; a function plugin named-exports `name` / `inject` / `Config` / `apply` and has no default export. Mixing them makes the Loader drop the plugin namespace — silently, at boot. `pnpm run verify` is what catches it.

**No hardcoded tunables.** Every knob is a required `Config` field. The right half-life for a belief depends on the deployment, so a default would be an unsupported choice rather than a convenience; [cordis.patch.yml](cordis.patch.yml) is where this package states a working set, and a user's profile patch layer is where they override it.

**Capture and recall are different questions.** A record's `use` decides whether it may be quoted back, and it is set by *author*, not by usefulness: the agent's own tool calls and prose are `evidence` — indexed, ranked, spreading activation, never read back to the model. Anything that starts storing raw tool arguments, or lifts the evidence filter on a request path, reintroduces the bug where a session opened by telling the model what it had already done.

**A belief is about the user, so its subject must be something the user authored.** The same `use` test gates distillation, not just quoting: `actionOf` refuses every `evidence` record, and the stated-preference miner reads only `user-message` and `note`. The user cannot invoke a tool, so "works through the edit tool" is a fact about the harness wearing the costume of a fact about a person. This rule was applied to recall first and to distillation second, and in the gap between the two a corpus of 2,282 sessions grew 84 tool-affinity nodes that filled every cue slot with `edit is habitually followed by bash`. Apply it in both places or it does not hold.

**One rank-to-score transform, and one only.** Every signal goes through `rankScore`, so a node ranked first and a record ranked first start equal and their priors — confidence, recency, support, activation — do the differentiating. Layer-1 cues once used `1/(1+position)` against fusion's `1/(60+position+1)`, which made a belief worth sixty episodes at the same rank and a belief ranked twentieth worth three of the best episode in the scope. Nothing in the graph was ever competing with the substrate on merit. If you add a cue kind, score it through `rankScore` or it will silently dominate everything else.

**A signal with no information does not merely fail to help.** Unweighted RRF puts an uninformed ranking's first item above an informed one's tenth, so it displaces. `vectorWeight` is how a signal earns its say; measure before raising it.

**Every layer-1 belief cites layer-0 evidence.** A node or edge without supporting records cannot be audited, corrected against its source, or re-derived when the distiller improves. Keep it that way when adding a distiller.

**Nothing is deleted in place** except `forget`. `retract` leaves a tombstone and `supersede` records the replacement as an edge, so a belief's history stays reconstructible — but a user asking for material to be erased gets it erased, not hidden.

**Capture reads the session log; it never intercepts the loop.** The observer sees exactly what was durably recorded and cannot change what the model sees. Writes are serialized on one chain and never awaited by the log, so a failing store degrades memory instead of stalling a turn.

**Model-facing changes are the expensive kind.** The factual tool schemas, `experience_inspect` schema and memory protocol section sit in every request's prefix. Adding a field or reordering a schema invalidates provider cache reuse for every session. Recall is injected once per *turn*, appended after the claimed input — keep it that way.

**Experience is a separate channel.** Task outcomes and agent procedures belong in the experience domain, never in the user-preference graph. A turn ending starts with an unknown outcome. An independent assessor can propose `tool-evidence` outcomes only from exact committed check/readback quotations; runtime gates enforce coverage, freshness and confidence. Active skills require supported outcomes, applicable environments and available tools. Assistant claims and model confidence alone do not activate them.

**Task lineage follows the user objective.** Save planning and execution checkpoints with the original latest request, increasing revision and predecessor ID. Use the configured model to resolve continuation, corrections and increments; outcome status cannot substitute for requirement interpretation. Each new checkpoint needs fresh final verification. Preserve historical capture gaps through `priorCaptureIncomplete` when current artifact revalidation becomes possible.

**Provenance expands on demand.** Ordinary recall contains complete procedures and compact source counts. `experience_inspect` exposes scoped, paginated source indexes and audited verification quotes. Keep raw trajectories and long event lists out of automatic recall.

**Memory models use host configuration.** Default auxiliary calls follow the current session through `ctx.llm.stream()` without tools. Optional Harness-model or API overrides use the plugin configuration page. Store API secrets through the host credential service and persist only credential references in settings; resolve credentials for each request. Profile row overrides include the complete `config`.

**Feedback needs attribution.** Automatic feedback cites actual application of the exact recalled skill version and relevant final verification from a later independent task. A retrieved skill or an overall task result alone is insufficient. Keep unresolved outcomes visible through `/experience pending`. `/experience assess` re-examines existing evidence; bounded maintenance retries address service/response failures, while substantive uncertainty retains fresh verification and explicit user confirmation.

**Lifecycle operations preserve provenance.** Ordinary deduplication must not revive withdrawn, expired or quarantined skills. Supersession creates an explicit successor. Forget erases dependent revisions and feedback, invalidates in-flight capture and checks evidence again after external extraction.

**Evaluation labels stay with the evaluator.** Use isolated attempt namespaces, frozen training experience and held-out identities. Production model access uses APIs. Keep downloaded datasets, credentials, run outputs and temporary CLI smoke adapters outside the source tree.

## Layout

```
src/memory/                 hub: types, scoring, errors, providers, query, service, invariants
src/memory-store-domain/    durable store over ctx.storage.domain + zod schemas
src/memory-embedding-hash/  FNV-1a feature-hashing embedder
src/memory-observer/        session/event capture
src/memory-consolidation/   behaviour-cycle distiller + turn scheduler
src/memory-recall/          agent/pre-step retrieval and injection
src/tool-memory/            memory_search / memory_write / memory_forget + prompt section
src/command-memory/         the /memory command: the surface addressed to the person
src/experience/             task/skill engine, outcome proofs, lineage, source manifests, file store
src/experience-store-domain/ independent experience persistence for Harness
src/experience-harness/     capture, task composition, assessment, recall, inspection and model settings
src/experience-harness/client/ bundle GUI for memory models and host credential controls
src/evaluation/             API dataset runners, checkpoints and real OSWorld bridge
tests/<plugin>/             suites drive the real plugin bodies on real registries
bench/                      benchmark harness (4 datasets); dev-only, never published
docs/design.md              why the subsystem is shaped this way (+ .zh.md)
```

Docs are bilingual: an English page and its `.zh.md` translation change together.

## Upstream

The integration is verified against official DeepSeek Harness `dsh-v0.2.1-rc.2` (`687f282e8625c6b8d11ff58211a90524be2e4317`). The bundle owns its memory implementations and consumes the host's service contracts. Preserve producer-specific message sources, PTC event names and complete pre-step decision metadata when updating the adapter. See `docs/compatibility.md` and its Chinese translation for the validation record.
