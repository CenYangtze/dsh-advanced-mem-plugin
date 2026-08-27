# Memory

English | [中文](design.zh.md)

Cross-session memory of the person the agent works with. The [package map](../README.md#whats-in-the-bundle) lists the seven plugins; this document records why the subsystem is shaped the way it is.

## The problem

An agent that forgets everything between sessions makes the same user repeat themselves forever. The naive fix — append every transcript to a file and paste it back — fails for three reasons that get worse with use. Raw transcripts grow without bound and crowd out the request. Everything in them looks equally true, so a passing remark and a standing instruction carry the same weight. And nothing in them ages, so a preference the user abandoned last month still argues for itself today.

A usable memory has to do three things the transcript cannot: **compress** raw material into durable conclusions, **rank** those conclusions by how much evidence stands behind them, and **let them fade** when the evidence stops arriving. It also has to stay honest about which is which, because an agent acting on a stale guess with the confidence of a stated fact is worse than an agent that forgot.

## The shape: two layers over one substrate

```text
                     ┌─────────────────────────────────────────────┐
   layer 1           │  nodes: person, preference, constraint,     │
   semantic graph    │         project, entity, routine,           │
   coarse-grained    │         tool-affinity, skill-affinity,      │
                     │         procedure                           │
                     │  edges: prefers, avoids, uses, works-on,    │
                     │         part-of, caused-by, co-occurs,      │
                     │         contradicts, supersedes             │
                     └───────────────────┬─────────────────────────┘
                                         │ evidence (every item cites records)
                     ┌───────────────────▼─────────────────────────┐
   layer 0           │  records: user-message, assistant-message,  │
   episodic substrate│           tool-invocation, skill-invocation,│
   fine-grained      │           procedure-step, artifact, note    │
                     │  each carrying terms, an optional vector,   │
                     │  provenance into the session log, and       │
                     │  attachment references to originals         │
                     └─────────────────────────────────────────────┘
```

**Layer 0 keeps the material.** One record per interesting interaction: the user's own words, a tool call and its arguments, an invoked skill, an artifact. Text is indexed lexically and, when an embedder is mounted, embedded at capture time. Non-text originals — an image, a video URL, a document — are referenced by locator, media type, size, and digest. The bytes stay where their owner put them; memory never re-encodes an original, because a copy it made is a copy it can be wrong about.

**Layer 1 keeps the conclusions.** Nodes are the durable subjects worth naming: who the person is, what they prefer, what constraints they hold, which projects they work on, which tools and skills they reach for, which routines they repeat. Edges are the conclusions events induced between subjects, each stated as a `claim` a model can read directly.

**Every layer-1 item cites the layer-0 records that justify it.** That single rule is what makes the graph auditable: a belief can always be traced to evidence, evidence can always be traced to a session and a sequence number, and a user asking "why do you think that" gets an answer rather than an assertion.

## Fidelity

Every layer-0 record declares how faithfully its text reproduces what happened:

| Class | Meaning |
|---|---|
| `verbatim` | The original wording, reproducible from the session log at the recorded sequence number. |
| `summary` | A lossy reduction of a known original — for example a prompt cut at the capture budget. |
| `derived` | A statement no single original makes, such as a tool call rendered as indexable text. |

This is not decoration. `MemoryQuery.minFidelity` lets a consumer refuse anything below a floor, which is what lets a future automation surface act on `verbatim` material while treating a `derived` belief as advisory. Truncating a prompt downgrades it to `summary` rather than leaving a `verbatim` claim it no longer earns.

## Scope

Memories are partitioned by reach: `session`, `workspace`, or `user`. Recall reads a chain, most specific first, and never widens it on its own.

Capture writes to the workspace when the session has a working directory and the user scope otherwise. Session scope is deliberately never the default — a memory that dies with the session it was learned in can never be recalled, which is the one outcome that makes the whole subsystem pointless.

## The write path

```text
session/event ──▶ memory-observer ──▶ ctx.memory.remember() ──▶ layer 0
     turn/end ──▶ memory-consolidation ──▶ ctx.memory.consolidate() ──▶ layer 1
                                       └─▶ ctx.memory.sweep()      ──▶ retirement + eviction
   tool call  ──▶ memory_write ────────▶ ctx.memory.assert()/relate() ──▶ layer 1
```

Capture **reads the log** rather than intercepting the loop. It therefore observes exactly what was durably recorded and cannot change what the model sees — capture is an observer of the harness, never a participant in it. Writes are serialized on one chain and never awaited by the log, so a slow or failing medium degrades memory instead of stalling a turn.

Messages sourced by a plugin, the model, or a tool are skipped. Those are the harness talking to itself; capturing them would feed the graph its own output as if it were evidence about the user — including, circularly, the memory block that recall just injected.

## Consolidation: from behavior to belief

Consolidation is where "the user keeps doing X" becomes "the user prefers X". The shipped distiller uses no model at all — frequency, recurrence, and adjacency are the whole of its reasoning — which makes it deterministic, cheap enough to run at every turn boundary, and impossible to hallucinate with.

- A tool or skill used at least `minObservations` times becomes an affinity node carrying its use count and the number of sessions it spans.
- An action sequence recurring at least `minSequenceRepeats` times within single turns becomes a `procedure` node carrying its ordered steps.
- Steps get `part-of` edges to their procedure and `co-occurs` edges to what habitually follows them.

Confidence from frequency is a saturating exponential of the count: the second observation of a behavior says far more than the twentieth, and no count reaches the ceiling, because counting cannot rule out that the next interaction contradicts it.

The distiller is a **seam**, not a fixed component. Several may be mounted; the hub runs them in rank order and merges every proposal through the same reinforcement path. A model-backed distiller that extracts *why* a preference exists slots in beside the frequency miner without either one knowing about the other.

Merging, not appending, is what makes this work. A proposed node whose label already exists in its scope and type is reinforced: its belief rises, its evidence grows, its decay clock resets. That is what turns a repeated behavior into a confident belief instead of a pile of duplicates.

## The read path

`ctx.memory.recall()` runs three independent signals and fuses them by reciprocal rank:

1. **Lexical** — Okapi BM25 over indexed terms. The tokenizer emits lowercased word runs and, for space-free scripts, overlapping character bigrams, so a Chinese or Japanese query matches a longer phrase it appears inside without a segmentation dictionary.
2. **Vector** — cosine similarity against the query embedding, restricted to records whose stored vector came from the currently mounted embedder. Vectors from different embedders are never compared.
3. **Graph activation** — spreading outward from directly matched nodes, and from the nodes cited by top-ranked records, across active edges for a configured number of hops with a falloff per hop.

Reciprocal rank fusion consumes only positions, so a BM25 score and a cosine similarity combine without any calibration step between them — which is precisely why hybrid retrieval is robust to swapping the embedder.

The third signal is the one the graph buys. A query that matches only raw material still surfaces the conclusions drawn from it, and a query that matches one preference surfaces the routine that preference belongs to. Every returned cue carries the signals that placed it, so retrieval quality is inspectable rather than a black box.

`ctx.memory.profile()` answers the query-free question instead: what is worth stating before anything has been asked. It ranks active nodes by decayed confidence weighted by accumulated evidence, so a strongly supported preference outranks a single confident guess.

## Belief lifecycle

| Operation | Effect |
|---|---|
| Reinforce | `c ← c + α(1 − c)`; support and decay clock advance. Diminishing returns; never reaches 1. |
| Contradict | `c ← c(1 − β)`; contradiction counter advances. A well-supported belief survives one disagreement. |
| Decay (at read) | `c ← c · 2^(−Δt / halfLife)`. `null` half-life never erodes. |
| Retract | Tombstoned: out of recall, still auditable. |
| Supersede | Old node marked superseded, and a `supersedes` edge records the replacement. |
| Forget | The layer-0 record is erased and every citation of it dropped. Irreversible. |

Decay is applied **at read time**, not by a background pass. That is the design's quiet advantage: staleness becomes a continuous property rather than an expiry flag, a belief that stops being observed fades out of recall on its own, and one reinforcement restores it. The maintenance sweep only tombstones what has already faded past the retirement floor, so a missed sweep costs storage, never correctness.

Asserted beliefs — the ones the user stated outright — do not erode and are never retired by a sweep. The user said it; only the user unsays it.

Nothing is deleted in place except by `forget`, which exists precisely so that a user asking for material to be gone gets deletion rather than a hidden copy. Layer-0 eviction under the record budget skips anything a layer-1 item cites, so erasing raw material can never orphan a conclusion.

## Active memory: the protocol

Automatic recall answers what memory already thought was relevant. It cannot answer what the agent itself realizes mid-task. So the tool package registers a fixed prompt section that names the four situations worth a deliberate search — choosing an approach, picking a tool or library, repeating possibly-done work, asking a possibly-answered question — and states what is worth writing and what is not.

The section exists because tools this general are reliably ignored without one. It also carries the calibration rule the rest of the design depends on: recalled memory is a **prior, not an instruction**. Act on a high-confidence memory; verify a low-confidence one; verify anything before an action a mistake would be costly to undo.

The model may assert `preference`, `constraint`, `project`, `entity`, `routine`, and `person`. It may not assert affinities or procedures — those are mined from observed behavior, and letting the model write them would let its own guesses masquerade as usage evidence.

## Composition

```text
ctx.storage ──▶ ctx.storage.domain ──▶ memory-store-domain ──┐
                                    memory-embedding-hash ───┼──▶ ctx.memory
                                                             │
      session/event ──▶ memory-observer ──────────────────────┤
          turn/end ──▶ memory-consolidation ──────────────────┤
    agent/pre-step ──▶ memory-recall ───────────────────────  ┤
         ctx.tools ◀── tool-memory ────────────────────────── ┘
```

The full stack mounts from this package's [bundle layer](../cordis.patch.yml), which expects a profile that already stacks `@deepseek-ai/dsh-web-app` — that is where the storage hub and domain layer live. An assembly without a store still loads: `ctx.memory.ready` is false, capture and recall skip silently, and the tools fail loud on use rather than pretending to remember.

Every tunable is a required `Config` field — half-lives, thresholds, budgets, injection limits. The right half-life for a preference depends on how the deployment is used, so a default here would be an unsupported choice rather than a convenience.

## Cost

Automatic recall is bounded by two decisions. It runs once per **turn**, not once per step, so a long tool-calling turn pays for it once. And it is a plain user message appended after the claimed input, so it extends the request prefix rather than rewriting it, leaving provider cache reuse of the system prompt, tool schemas, and prior turns intact. Over the character budget, whole lines are dropped rather than one line truncated — half a remembered preference is a different preference.

## Toward memory-assisted automation

The next surfaces for this subsystem are ones that act on the world rather than only talking about it: Computer Use, MCP-connected applications, office documents, data analysis. None of that is implemented here. What is implemented is what those surfaces will need from memory, and each piece is load-bearing for a specific reason:

- **Fidelity classes and `minFidelity`** — an automation step that edits a spreadsheet must be able to demand `verbatim` grounding and refuse to act on a `derived` belief. The floor exists at the query interface, so the refusal is a filter, not a convention.
- **Attachment references rather than copies** — a document memory points at the document. An automation surface resolves the current original, or reports that it moved; it never works from a stale copy memory made.
- **`procedure` nodes** — repeated action sequences are already mined into ordered steps with their own evidence. That is the shape a replayable routine needs, and mining it from behavior is what makes "do that thing I always do" answerable.
- **Provenance into the session log** — an automation that went wrong can be traced back to the exact turn whose memory suggested it.
- **Supersession over deletion** — an automated action taken on an outdated belief stays explainable after the belief is corrected.
- **Scope partitioning** — a document convention learned in one workspace does not silently drive an action in another.

What is genuinely missing, and deliberately so: no application adapters, no action execution, no confirmation policy for irreversible steps, and no distiller that learns from an action's *outcome* rather than its occurrence. The last is the most interesting gap — the seam accepts such a distiller, but nothing captures tool results today, so there is no outcome signal to learn from.

<!-- The generated Cordis API surface lives in the harness docs; this package ships the design rationale only. -->

## Known limitations

Per-package limitations live in each package README. The subsystem-level ones:

- **Recall materializes the scope chain per query.** Every active item in the requested scopes is read and ranked in process. `recordBudget` bounds this; a deployment far past it needs a store provider with a real index, which the seam permits but no shipped provider offers.
- **Consistency is caller-driven.** Nothing detects that two active nodes disagree. `contradict` and `supersede` must be called by something that noticed.
- **No outcome signal.** Capture records that a tool was called, never what it returned. Consolidation therefore learns habits, not what worked.
- **No redaction.** A prompt containing a credential is captured like any other; a deployment handling secrets in prompts needs a filter in front of the observer.
