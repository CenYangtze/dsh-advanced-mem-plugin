# DeepSeek Harness compatibility

English | [中文](compatibility.zh.md)

This revision supports **DeepSeek Harness `0.2.1-rc.2`**, the official `master` head checked on **2026-10-23**: [`687f282e8625c6b8d11ff58211a90524be2e4317`](https://github.com/deepseek-ai/deepseek-harness/commit/687f282e8625c6b8d11ff58211a90524be2e4317). The release tag is [`dsh-v0.2.1-rc.2`](https://github.com/deepseek-ai/deepseek-harness/tree/dsh-v0.2.1-rc.2).

## Host integration

The bundle uses the host's Cordis instance and registries through peer dependencies. The latest host changes are incorporated at the integration boundaries:

| Boundary | Integration |
|---|---|
| Agent pre-step decisions | Preserve all admitted decision fields, including `startsRequestSeries`, while appending memory messages. |
| Message provenance | Declare the `memory-recall` and `experience-memory` sources through the host's extensible `MessageSourceMap`. Factual capture accepts only explicit user and skill-invocation sources. |
| PTC tool execution | Observe `tool/ptc-dispatch-start` for factual evidence and completed `tool/ptc-dispatch` events for experience outcomes. |
| Shared JSON types | Import `JsonValue` from `@deepseek-ai/dsh-util-values`. |
| Session history | Capture experience incrementally from committed `session/event` events; no synchronous historical Session reader is required. |
| Experience extraction | Resolve the session's next model selection and call `ctx.llm.stream()` with host-managed authentication; the optional host default-model service supplies the fallback. |
| Optional invariant companion | Use a structural registry protocol for hosts providing an `invariants` service. The standard bundle does not mount this companion. |

The corresponding host contracts are in [agent runtime types](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/core/agent/src/runtime-types.ts), [PTC event types](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/core/tools/src/types.ts), and the [Session read policy](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/.agents/notes/implemented/architecture/2026-09-09-deprecate-synchronous-session-event-reads.md).

## Profiles and storage

The official `acp`, `web`, `headless`, and `sdk` profile templates include `@deepseek-ai/dsh-base`. That bundle supplies the storage hub, JSON backend, and domain facility. Factual memory opens the `memory` domain; experience memory opens a separate `experience` domain. Both follow the facility's default backend, so an additional route for `experience` is unnecessary. A custom deployment may route either domain to another registered KV backend. See the host's [profile templates](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/boot/app-boot/src/profile.ts), [base storage configuration](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/bundle/base/cordis.patch.yml), and [domain routing](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/storage/storage-domain/src/index.ts).

The minimal SDK profile requires its own storage and service composition. Desktop owns its reserved profile through the Electron application.

The current CLI accepts these installation and inspection commands:

```sh
dsh plugin --profile web add github:CenYangtze/dsh-advanced-mem-plugin#<commit>
dsh --profile web --dump-config
dsh --profile web
```

For a Git installation, allow this package's `prepare` script under `allowBuilds` in the profile's `pnpm-workspace.yaml`, as described in the [README](../README.md). These commands follow the official [CLI parser](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/apps/cli/src/args.ts) and [plugin installer](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/apps/cli/src/plugin.ts).

## Verification

Compatibility was checked on Windows with Node `24.14.0`, using an independent checkout of the pinned official revision and its compiled peer packages.

| Check | Result |
|---|---|
| TypeScript against official peer declarations | Passed |
| Regression suite | 13 files, 255 tests passed |
| Package build and export verification | 10 configured rows, 14 public entry points passed |
| Official Cordis Loader integration | All 10 configured rows reached the active state |
| Memory injection | Recalled factual memory was appended and the request-series boundary was preserved |
| Durable reload | JSON-backed factual memory remained retrievable after disposal and a fresh Loader boot |
| Automatic experience capture | A completed tool result and turn produced an episode with an unknown outcome; raw tool arguments were absent |
| Erasure during capture | Erasing a source invalidated the active turn; its later completion did not recreate an episode |
| Experience persistence and erasure | Episodes survived a fresh boot; erasing a factual source removed its dependent episode, including after another restart |
| Installed Web GUI | Factual writes and searches, task capture, outcome confirmation, model-backed extraction and active-skill inspection passed through the real interface |
| Cross-session GUI recall | After a runtime restart, a fresh session answered with the stored fact and exact Skill ID without tools or file reads; durable events contained distinct `memory-recall` and `experience-memory` messages |
| Native extraction lifecycle | Verified stream completion, cancellation, model selection changes, trusted-outcome confidence reassessment, duplicate stability and successive skill replacement |

The Loader verification composed the real host session, agent, tools, commands, system-prompt, and storage services. Both memory domains opened through the official domain facility. The standard development gate remains:

```sh
pnpm run link-harness /path/to/deepseek-harness
pnpm run check
```

Build the host's peer packages before linking a source checkout, so its package export targets and declarations are available.

The installed-GUI verification used plugin `0.2.1` and the Harness-configured DeepSeek-V4.1-Flash model. Auxiliary extraction used the same provider route without separate experience API variables. Runtime package resolution was checked to share the host's Cordis, Agent and LLM instances.

## Factual data lifecycle

Explicit memory writes now retain an evidence-only assertion ledger with agent or API authorship. Supplied source references must resolve to active records in the same scope. Both factual distillers respect each record's effective `use`, keeping generated assertion text out of user-preference mining.

Erasure removes a source and its derived graph summaries, incident claims, and generated ledgers containing that material. `forgetNode()` also handles older beliefs without evidence links. The store provider contract includes `eraseNode()` and `eraseEdge()`; custom providers implement these alongside `eraseRecord()`. The domain provider performs durable deletion, verified across close and reopen. Belief mutations and erasure are serialized within each scope, and supersession edges remain in their endpoints' scope.
