# Explicit and automatic memory updates

English | [中文](memory-updates.zh.md)

This page covers evidence-backed replacement. It does not add a version tree and
does not change how `assert` merges the same label. A replacement creates a new
node identity, retires the old node with a tombstone and records a `supersedes`
edge from the replacement to the target.

## Delivery status (2026-11-07)

Explicit replacement is implemented and covered by focused tests. Automatic
semantic replacement is deliberately conservative; this round's prompt/version
repair is the six-file `semantic-v4` change and does not alter runtime
validation. The 12-scenario synthetic v4 run was 10 pass / 1 fail / 1 unjudged;
the remaining failure returned empty candidates for `update-same-value`, and the
unjudged case was truncated twice. That is not a quality acceptance result.

The conflict suite is complete, but its score is not final:

<!-- CONFLICT-FINAL-REVIEW:START -->
Preliminary status: the current 07 report gives 0/100 natural joint pass and
43/50 controls. It is a character-similarity screening, not an accuracy result.
Final semantic review is pending. Maintainer: replace this block with the
reviewed result before publishing.
<!-- CONFLICT-FINAL-REVIEW:END -->

The six-case Agent check still stored, recalled and repeated a natural-language
“don’t write this down” request (c4), and V c4/c6 failed the semantic stage on
`max-tokens` truncation. Those are open P0 items, not solved by replacement.

This delivery is **not deployed to production**. It is not yet committed;
commit/push are pending and the maintainer will complete them. See
[HANDOFF.md](../HANDOFF.md).

## Explicit replacement

`ctx.memory.replace()` and `memory_write` with `operation: "replace"` use the
same runtime path. The caller supplies:

```ts
{
  scope, target, type, label, summary, origin, evidence, quote
}
```

- `target` is a concrete active node id, never a free-form label.
- The target must be active, in the requested scope and of the requested type.
- Evidence must be active user-authored records with `provenance.author === "user"`
  in the same scope. Agent notes, assistant prose, tool output and legacy records
  without an author are rejected as user evidence. They remain readable; the
  replacement simply does not use them.
- `quote` must exist in at least one cited record after whitespace normalization.
  A quote containing a redaction placeholder is never valid, even when the stored
  text contains that placeholder. An ordinary fragment of a redacted record is
  still valid evidence.
- The new node is written first, then the edge, then the target tombstone. This is
  not an atomic transaction: after an edge-write failure both nodes may be
  active; after a retire failure the edge may exist while both nodes are active.
  Recall and profile can therefore show both values during that intermediate
  state. They are not a claim that the user has one current value.
- Retrying the same request reuses a deterministic replacement id and completes
  the missing step without duplicating the node or edge. The identity canonicalizes
  evidence order and attribute key order, so equivalent retries stay idempotent.
  The final state has one active replacement and one superseded target.
- The old node keeps its original evidence. The replacement keeps the new
  evidence and the supersedes edge retains the relationship.
- Forgetting the replacement erases it and its edge; the old node remains
  auditable as a tombstone.

The existing `assert` behavior is unchanged: writing the same label still updates
that node in place, including its summary. Do not use `assert` same-label calls as
a replacement mechanism. Existing tool `add` calls remain compatible.

## Tool surface

`memory_search` results now include `id` for nodes, edges and records. This lets
an agent pass a real node id and real user record ids into `memory_write`.

`memory_write` adds optional fields:

- `operation`: `add` (default) or `replace`
- `target_id`: active node id to replace
- `evidence_record_ids`: active user record ids
- `quote`: verbatim fragment from one cited record

The output adds the written node `id` and, for replacements, the retired id as
`replaced`. The change is concentrated in one tool-schema and prompt revision.

## Automatic semantic replacement

The semantic distiller now asks for an `operation`, an existing-node alias, an
applicability string and a cardinality. Existing nodes are offered as aliases
under `semanticMaxExistingNodes`, bounded further by the total input character
budget. The fact identity includes subject, attribute, applicability,
cardinality and value, so the same value under work/home or single/multiple
contexts stays distinct.

A replacement is applied only when all of these hold:

- the model explicitly says `operation: "replacement"`;
- the target alias resolves to an active node in the same scope and type;
- the target has a stable semantic key and matching subject, attribute and
  applicability;
- both the target and candidate are single-value (`cardinality: "single"`);
- the new evidence quote exists in the cited user record and passes the same
  placeholder rejection as explicit replacement.

A different value alone never triggers replacement. Multi-value attributes,
different entities, different applicability contexts and legacy nodes without a
stable key keep the old belief and produce a separate fact marked
`review: "unconfirmed-replacement"` when the model proposed a replacement. No
bulk migration or automatic retirement of legacy data is performed.

Same-value candidates are deduplicated by `factKey`, which includes the value.
Different values use exact-label merging and do not topic-merge over the old
value. The supersession step is explicit; conflict resolution beyond that remains
for a later step.

## Limitations

The quote and attribution checks constrain evidence but cannot prove the model
understood a correction correctly. A model can misclassify roleplay, quotation or
third-party wording. A replacement operation is a model semantic judgment backed
by cited text, not a proof that the user meant to replace the old value; no
hardcoded phrase list is used to simulate that proof. Replacement proposals
therefore still require quality evaluation on held-out conversations and user
correction. No paid model run is part of the focused tests.
