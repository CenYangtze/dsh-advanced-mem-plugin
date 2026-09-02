# AGENTS.md

An out-of-tree DeepSeek Harness **bundle**: eight Cordis plugins that give the agent cross-session memory. Read [README.md](README.md) for what it does and how a user installs it; this file is the working contract for changing it.

## Commands

| Command | What it checks |
|---|---|
| `pnpm run link-harness ../deepseek-harness` | One-time dev setup: junction every `@deepseek-ai/*` peer to a harness checkout. |
| `pnpm run typecheck` | `tsc --noEmit` over `src/`, `tests/`, and the configs. |
| `pnpm run test` | 198 tests, one suite per plugin plus the benchmark harness. |
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

**Model-facing changes are the expensive kind.** The three tool schemas and the memory protocol section sit in every request's prefix. Adding a field or reordering a schema invalidates provider cache reuse for every session. Recall is injected once per *turn*, appended after the claimed input — keep it that way.

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
tests/<plugin>/             suites drive the real plugin bodies on real registries
bench/                      benchmark harness (4 datasets); dev-only, never published
docs/design.md              why the subsystem is shaped this way (+ .zh.md)
```

Docs are bilingual: an English page and its `.zh.md` translation change together.

## Upstream

Developed against the DeepSeek Harness tree and repackaged standalone. Plugin bodies are unchanged from upstream; only module identities and cross-package imports differ. When porting a change back, the harness equivalents live under `packages/memory/*` with scoped names (`@deepseek-ai/dsh-memory`, `@deepseek-ai/dsh-tool-memory`, …) and per-package manifests.
