# Handoff to Zhang Xu: this round's fixes and open issues

English | [中文](HANDOFF.zh.md) | [Update 2026-11-06](UPDATE-20261106.md)

**State: the clean fix-only candidate passed the full `pnpm run check` on Node
24.19.0 — 22 files / 410 tests, build and bundle verification (10 patch rows,
16 entry points). It is not deployed to production.** Delivery branch:
`fix/memory-quality-sdk-20261106`; Git records determine commit and remote status.
Do not treat this page as a release approval.

**Out of scope:** the pre-existing `baseline33` user/experience work is not part
of this change set. The maintainer isolates it from the original backup. Do not
mix it into this memory review or use it as evidence for the changes below.

## What changed

- **Memory SDK.** `src/memory-embedding-kylin/index.ts` is a thin real-SDK
  provider. It calls a native `memory_embed_runner` per text, keeps SDK crashes
  outside the Harness process, never silently falls back to feature hashing and
  adds no vector cache in this phase.
- **Raw durability.** A raw record is persisted before the embedding call. If
  the SDK fails, the text remains durable without a vector and recall reports a
  lexical mode plus a fixed failure category. An SDK outage cannot lose what the
  user said.
- **Versioned progress.** `src/memory-consolidation/*` and
  `src/memory-store-domain/*` store per-scope, per-distiller, per-version,
  per-record progress (`empty`, `proposed`, `failed`, `skipped`). A version
  change starts a new progress key and replays records; `forget` removes the
  referencing progress rows. `promotedTo` remains an audit field, not the
  pending test for distillers that opt into progress.
- **Conservative semantic replacement.** `src/memory/index.ts` and
  `src/memory-consolidation/semantic.ts` apply a replacement only when the model
  explicitly asks for it and the target is an active node with a stable semantic
  key, matching subject/attribute/applicability, single-value cardinality and a
  verified user evidence quote. Anything weaker becomes a separate fact marked
  `review: "unconfirmed-replacement"`; there is no bulk migration or automatic
  retirement of legacy nodes.
- **Safety.** Capture and read paths apply a fixed, bounded redaction policy and
  an explicit UTF-16 truncation budget. External embedding/model payloads are
  filtered again. A quote containing a redaction placeholder is never accepted
  as evidence. This is a minimal capture policy, not a PII classifier.
- **semantic-v4 narrow fix.** The prompt/version repair touched exactly six
  files; the other 143 files in the frozen source are byte-identical. No runtime
  validator, attribution rule, scope rule, safety filter or experience code was
  changed. See [semantic-preferences.md](docs/semantic-preferences.md).

## Evidence that may be cited

All numbers below are local experiment evidence, not official leaderboard
scores. The experiment directories are **not** shipped in a clone of this
repository; the numbers and the source list in this page are the portable
handover.

### Preference extraction (AI content review, not human review)

- 100 positive + 50 negative candidates; all three arms completed (450
  case/stores), no pending cases.
- A0/B1 (semantic off): item full **7/143 = 4.9%**; case full **4/100**.
- B2 (semantic on, v4): item full **23/143 = 16.1%**; case full **18/100**,
  case partial **8/100**, case miss **74/100**. B2 still misses **115/143**
  gold items entirely.
- FER on the 46 frozen true negatives: A0/B1 **4/46 = 8.70%**; B2
  **5/46 = 10.87%**. Four `needs_review` candidates are excluded from the 46
  denominator and are not silently converted to true negatives.
- Do not call 16.1% “accuracy”, “pass” or “the target met”. It is an AI review of
  one internal holdout and the long tail is still largely missed.

### Recall and injection (lexical, not SDK)

- 470 questions per arm; A0/B1 each 470/470, 0 errors.
- R@10 macro **75.07%**; real injected ID-hit **72.04%**; actual
  injected-full macro **71.83%**.
- A0 and B1 are identical (paired difference 0, descriptive CI `[0,0]`).
- This is an internal comparison of the 470-question LongMemEval regression set;
  the samples were previously exposed. It is **not blind**, not an official
  score and not evidence of improvement.

### Timing (component-level)

- Post lexical retrieval P95 **36.604 ms**; production hook P95 **32.983 ms**;
  both individual components are below 500 ms at about 500 turns/qid.
- Ingest P95 **15,910 ms** and total P95 **15,992 ms** are not a query SLA.
- A 30k/50k single store and the complete SDK recall chain were **not tested**.

### Kylin SDK stability

- 200 synthetic calls: 200 success, 0 errors, function P95 **59.156 ms**.
- Resource growth: runtime FD **33→67**, threads **65→266**, runtime→8001
  connections **1→35**, kytensor 8001 ESTAB **3→71**.
- After about **218 s** there was no meaningful reclaim. Long-term stability is
  **blocked**. Do not hide this with a higher NOFILE limit or scheduled restarts.

### Agent end-to-end

- Six original synthetic cases, real `AgentLoop`, no tools.
- Original rubric: no-memory **2/6**, pre **4/6**, post **4/6**. The post-hoc
  sidecar is **5/6** for both P and V and does not replace the original rubric.
- Natural-language “don’t write this down” still failed: the raw record was
  stored, recalled and repeated in the answer (c4). Explicit
  `forget`/`memory_forget(erase)` exists; pre-capture natural-language refusal
  does not.
- V c4/c6 semantic stage failed on `max-tokens` truncation. This is a pipeline
  failure, not a reason to score the answer as zero or to publish the post-hoc
  number as the main score.

### 300-case capture run

- R3r1: A0/B1 zero-model prechecks are 300/300 full; the B2 real-model run is
  300/300 completed capture (this does not mean zero semantic extraction
  failures).
- B2 used **1,085 calls**, known tokens **837,841 minimum**, **319 calls with
  unknown usage**, cost **unknown**. Missing usage is not zero.
- This run proves capture/isolation/progress plumbing. It does **not** prove
  extraction quality or accuracy; accuracy is assessed separately by the
  acceptance side.

### Conflict handling (preliminary only)

- 100 natural conflict cases and 50 controls completed.
- The final conflict and natural-update conclusion is maintained in
  [docs/memory-updates.md](docs/memory-updates.md). This root page does not copy
  the preliminary screening scores.

## Do not merge into a formal result

- The old invalid full run: A0 291 full + 9 partial; B1 15 full + 4 partial +
  281 zero-capture; B2 11 full + 1 partial + 288 zero-capture. Preserve it as
  invalid; never score it or concatenate it with R3r1.
- The old failed B2 gate (11 calls) and the old invalid R2 full run (71
  completed) are separate historical failures.
- The SDK formal-100 run stopped at **9/100** after the 900 s scope timeout. Do
  not merge it with the 200-call probe or the 470 lexical run.
- The clean fix-only candidate for this repair passed the full check on tree
  `7bdc1078d44427e3b6e1f57e518ed200faaaa220` on Node 24.19.0. Earlier **477-test**
  and **68 SDK integration** reports include the original experience WIP and
  cover a different scope; do not combine them with this repair. Dependencies
  were reused through a `node_modules` junction, so this is not a fresh-install
  proof.

## P0 for Zhang Xu

1. **Preference recall and natural-update validation are insufficient.** 74/100
   cases and 115/143 items are still missed; the natural-update conflict
   conclusion is still pending semantic review; B2 is 16.1% item full, not a
   passing result. V c4/c6 also truncate at `max-tokens`. Fix/measure on
   held-out data before claiming extraction quality.
2. **SDK cleanup is a risk.** FD/thread/connection growth did not return after
   ~218 s. Long-term operation is blocked; document the failure rather than
   restarting the service to make a run look clean.
3. **Natural-language refusal to store is missing.** “Don’t remember this” is
   not routed before capture; c4 stored, injected and repeated the private text.

## P1

- Recall showed **no measured improvement**; the 30k/50k single-store case and
  the full SDK chain remain untested.
- Nothing here is deployed to production. Deployment, profile changes and
  service restarts remain the maintainer’s decision.

## Code entry points

| Area | Path |
|---|---|
| Runtime, recall, replace, safety | `src/memory/index.ts` |
| Types, providers, query, errors | `src/memory/{types,providers,query,errors}.ts` |
| Durable store and progress table | `src/memory-store-domain/{index,spec}.ts` |
| Capture, truncation, safety metadata | `src/memory-observer/index.ts` |
| Consolidation and progress | `src/memory-consolidation/{index,distiller,stated}.ts` |
| Semantic distiller and v4 prompt | `src/memory-consolidation/{semantic,model}.ts` |
| Recall injection | `src/memory-recall/index.ts` |
| Tool schema and prompt | `src/tool-memory/{index,prompt}.ts` |
| Kylin SDK provider | `src/memory-embedding-kylin/index.ts` |
| Working profile | `cordis.patch.yml` |

Focused tests: `tests/memory/{safety,replacement,consolidation-progress,semantic-progress}.spec.ts`,
`tests/memory-consolidation/{semantic,scheduler,model}.spec.ts`,
`tests/memory-embedding-kylin/embedding-kylin.spec.ts`.

## Reproduce locally

```sh
# From code/dsh-advanced-mem-plugin
pnpm run typecheck
pnpm exec vitest run \
  tests/memory/safety.spec.ts \
  tests/memory/replacement.spec.ts \
  tests/memory/consolidation-progress.spec.ts \
  tests/memory/semantic-progress.spec.ts \
  tests/memory-consolidation/semantic.spec.ts \
  tests/memory-consolidation/scheduler.spec.ts \
  tests/memory-embedding-kylin

# The full clean-candidate check already passed on Node 24.19.0:
pnpm run check
```

The full check is complete for the clean candidate. After that check, only
delivery documentation is being added; source and tests are unchanged, so do
not repeat the full suite for documentation-only updates. Node 24.19.0 is the
validated runtime. Node 22.9.0 failed because `node:sqlite` does not satisfy the
host's `^22.19` or `>=24` requirement; use Node 24.19.0, or a host-supported
22.19+ if staying on Node 22.

## Delivery and privacy boundaries

- The bilingual delivery README and `verification.json` are in
  [docs/delivery-20261107/README.md](docs/delivery-20261107/README.md);
  `verification.json` records the clean-candidate check. The seven-chapter
  manual snapshot is included in that directory. Do not assume raw
  datasets or all experiment files will be visible remotely.
- No licensed gold, full user conversation, credential or machine-account
  password is copied into this repository or these documents. Examples are
  synthetic and contain no personal data. One synthetic replacement shape:

```json
{
  "operation": "replace",
  "target_id": "<active-node-id>",
  "evidence_record_ids": ["<user-record-id>"],
  "quote": "I switched to decaf."
}
```
