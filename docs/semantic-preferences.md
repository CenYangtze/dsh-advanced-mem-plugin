# Semantic preference extraction

English | [中文](semantic-preferences.zh.md)

The deterministic stated-preference miner stays the offline baseline. This page
describes the optional, evidence-constrained semantic distiller that reads free
wording through the host model. It is **disabled in the shipped profile** and must
be enabled in an independent profile after reviewing the route and budgets.

## Delivery status and quality (2026-11-07)

The `semantic-v4` prompt/version repair touched exactly six files; the other 143
files in the frozen source are byte-identical, and runtime validation is
unchanged: `src/memory-consolidation/semantic.ts`, `cordis.patch.yml`,
`tests/memory-consolidation/{semantic,scheduler}.spec.ts`,
`docs/semantic-preferences{.md,.zh.md}`. The 12-scenario synthetic v4 rerun
reported 10 pass / 1 fail / 1 unjudged. The remaining failure is
`update-same-value` returning `{"candidates":[]}`; the unjudged case was
truncated on both attempts. Total actual calls were 58, with 39,481 known tokens
minimum, 9 calls with unknown usage, and cost unknown.

The second internal preference holdout is AI-reviewed, not human-reviewed and not an
official score; its inputs were previously exposed. On 100 positives and 50
negatives (all 450 case/stores completed):

- A0/B1 (semantic off): item full **7/143 = 4.9%**; case full **4/100**.
- B2 (semantic on, v4): item full **23/143 = 16.1%**; case full **18/100**,
  partial **8/100**, miss **74/100**. B2 still misses **115/143** items.
- FER on 46 frozen true negatives: A0/B1 **4/46 = 8.70%**; B2
  **5/46 = 10.87%**. Four `needs_review` cases are excluded from the 46
  denominator.

Preference extraction is therefore improved on short explicit cases but far from
a passing result. Do not publish **16.1%** as “accuracy”, and do not claim the
target is met. The work is **not deployed to production**; see
[HANDOFF.md](../HANDOFF.md) for P0.

## What it does

`semantic-preference` turns user-authored memory records into structured
`preference` or `constraint` candidates. Candidates carry:

- type, operation (`addition` or `replacement`), subject, attribute,
  applicability, cardinality, value and a normalized summary;
- a verbatim `quote` from a cited record;
- evidence aliases such as `r1`, `r2`;
- attribution (`user` only is accepted);
- durability (`long-term` only is accepted);
- model confidence, capped by `maxConfidence`.

An addition carries `target: ""` (or omits target). A replacement candidate must
name an existing-node alias such as `n1`. The runtime validates the target's
scope, type, subject, attribute, applicability, single-value cardinality and
stable semantic key. If those conditions do not hold, the proposal is retained as
a separate fact marked `review: "unconfirmed-replacement"` and the old node is
not retired.

The fact identity includes subject, attribute, applicability, cardinality and
value. The same value under different applicability or cardinality therefore
stays distinct and is not collapsed by the same-value shortcut.

The `semantic-v4` prompt makes the `operation` distinction explicit in the JSON
shape. An `addition` uses `target: ""` (or omits it); a `replacement` uses an
existing-node alias such as `target: "n1"`. `target` is never the new fact's
subject, attribute, value, or a fact key: it only names the old node being
replaced. The runtime validator is unchanged and still rejects a non-empty
addition target and a replacement target that is not a supplied alias.

The prompt also includes applicability and cardinality in the fact identity.
Existing `semantic-v3` progress rows remain readable; `semantic-v4` replays
records under a new progress key. Plain addition extraction remains compatible.
Nodes written by earlier semantic versions are not rewritten: they stay readable,
and a v4 identity may be added beside an older identity until reviewed. No bulk
migration is performed. Performance snapshots recorded before this prompt revision
remain `semantic-v3` and are reported under that version.

The runtime, not the model, supplies the memory scope. The distiller only reads
records from the session whose route owns the turn. Assistant messages, tool
calls, evidence-only records, notes without a user author, records from another
session and task-local instructions do not become long-term user beliefs.

Model output is untrusted. The parser requires strict JSON, checks the candidate
limit and field lengths, resolves only aliases from the current input window, and
requires the quote to exist in at least one cited record after whitespace
normalization. Quoted, third-party, roleplay, ghostwriting, assistant-attributed
and task-local candidates are rejected.

If every returned candidate is invalid, the pass is a failure, not a successful
empty result. If at least one candidate is valid, invalid siblings are dropped and
the read records are consumed. Invalid JSON, truncation, tool calls, provider
errors, timeouts and output-byte overruns fail the batch.

## Model route

The route is resolved from the session that produced the turn:

1. the session projection's next model selection;
2. the session request header;
3. the agent options;
4. the host default model.

The consolidation scheduler resolves this at `turn/end` and enqueues the pass with
that route and session id. A manual consolidation call must supply `route` and
`sessionId`; without them the semantic distiller fails clearly instead of choosing
an arbitrary workspace or Harness model. Concurrent calls for one scope join the
first in-flight pass and share its route and cancellation.

Credentials stay with Harness. The request uses `ctx.llm.stream()` with
`tools: []`; no API key is read or persisted by this module. The consolidation
plugin itself requires only `memory` and `sessions`; `llm` and `agents` are
optional services obtained when semantic extraction is enabled.

## Limits

The quote check proves that a cited fragment exists in a cited user record. The
attribution and durability checks read the model's own labels. They cannot prove
that the model understood a quotation, roleplay, ghostwriting request or implicit
third-party preference correctly; a model can mislabel them. This distiller is
therefore evidence-constrained but not a substitute for quality evaluation on a
held-out set. Treat its candidates as proposals that still need measurement and
user correction.

## Bounded input and progress

Every knob is a required config field. A pass reads at most
`semanticMaxRecords` records, and a single call's input including JSON framing is
limited by `semanticMaxInputCharacters`. A record that cannot fit alone is marked
`skipped` with reason `input-too-large`; it does not block later records and is not
silently split. Records not selected because of the record or character budget
remain pending for a later pass.

The distiller returns `consumedRecordIds` for the records it actually read. The hub
advances progress only for that subset, so a partial window cannot mark the unread
tail as processed. `skipped` and `failed` records are written separately; failed
records remain retryable within `progressMaxAttempts`.

Progress is keyed by the semantic version plus prompt version, model route and the
relevant numeric controls. A model, prompt or config change therefore replays old
records under a new key. Disabling semantic extraction does not delete existing
progress rows.

## Duplicate and conflict policy

- A candidate whose normalized summary equals an existing node's summary, or whose
  `factKey` matches an existing fact, is a duplicate and is not added again.
- Candidates within one response are deduplicated by the same fact key.
- Semantic candidates use exact-label merging. Different values under the same
  subject and attribute become distinct nodes; topic similarity is not treated as
  the same fact. Supersession is deliberately left to the next plan step.

## Configuration

The shipped working set keeps semantic extraction off and states the bounds:

```yaml
semanticEnabled: false
semanticMaxRecords: 6
semanticMaxInputCharacters: 12000
semanticMaxOutputBytes: 32768
semanticMaxCandidates: 8
semanticMaxExistingNodes: 12
semanticMaxTokens: 1200
semanticTemperature: 0
semanticTimeoutMs: 30000
semanticMaxFieldLength: 160
semanticMaxCallsPerPass: 2
semanticMaxConcurrentCalls: 1
semanticPromptVersion: semantic-v4
```

An independent profile can set `semanticEnabled: true` and adjust the bounds. It
must include every field in the complete `memory-consolidation` config.
`semanticMaxExistingNodes` bounds how many existing preference/constraint nodes
are exposed as replacement aliases; the overall input character budget still
applies. No real paid request is made by the test suite; host streams are mocked.

## Observability

`consolidate()` diagnostics include pending/window/advanced/failed/skipped counts,
duration and optional host token counts. They contain no record text, labels,
evidence ids, provider output or fabricated cost. The scheduler logs fixed count
messages for failures, skips and token usage.
