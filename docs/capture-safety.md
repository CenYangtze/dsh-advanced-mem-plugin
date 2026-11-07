# Capture safety and minimal filtering

English | [中文](capture-safety.zh.md)

This is a minimal, explainable capture policy, not a PII classification system.
It targets high-confidence credential material at the memory write boundary and
re-applies the same policy before external embedding or model requests. It does
not claim to recognize every secret or every piece of personal data.

## Delivery status (2026-11-07)

The focused safety suite passes 40/40 in the latest run: 20 synthetic positive
credential samples and 20 ordinary-text negatives, plus nested attributes,
unsafe JSON keys, attachment omission, read-view projections and truncation
boundaries. These are synthetic fixtures, not a PII benchmark.

This delivery is **not deployed to production**. It is not yet committed;
commit/push are pending and the maintainer will complete them.

The policy does not implement natural-language refusal to store. In the six-case
Agent check, “don’t write this down” was still captured, recalled and repeated
(c4); explicit `forget`/`memory_forget(erase)` exists, but routing a refusal
before capture does not. Do not cite this page as proof that the c4 gap is
closed. No real user conversation, credential or machine-account password is
copied into this repository.

## Policy

`memory.safety` is required in the working profile:

```yaml
safety:
  redactPrivateKeys: true
  redactProviderTokens: true
  redactBearerTokens: true
  redactSecretAssignments: true
  rejectSensitivePatterns: false
  blockedLiterals: []
```

- The four `redact*` switches cover fixed, high-confidence patterns: PEM private
  key blocks (including an unterminated begin block), AWS/OpenAI/GitHub-style
  provider tokens, `Bearer` authorization values, and explicit
  password/api_key/secret/token assignments.
- `rejectSensitivePatterns: false` redacts a match with a fixed placeholder.
  `true` rejects the whole text input with the `blocked-input` error; an unsafe
  attachment reference is omitted with `attachment-dropped` instead.
- Each `redact*` switch is independent. In particular, when
  `redactSecretAssignments: false`, ordinary `token`/`password` keys and values
  remain plain JSON unless another enabled pattern matches their contents.
- `blockedLiterals` is a deployment-owned list of literal substrings that must
  never be stored. Matching is case-insensitive. Empty entries are ignored.
- There is no arbitrary deployment-supplied regular expression, so a profile
  cannot introduce a catastrophic backtracking pattern. This also means the
  policy cannot recognize every unusual credential format. The assignment
  pattern can also over-redact ordinary text such as `token=100`; that false
  positive is deliberate, bounded, and visible in redaction metadata.

## Write boundary

The runtime applies the policy centrally, so a tool cannot bypass it:

- `remember` filters text and every string field of an attachment before
  persistence and before the embedding call. If the URI, media type, digest or
  caption contains a blocked literal or a redaction, the whole attachment
  reference is omitted and counted as `attachment-dropped`; a redacted URI is
  never presented as a usable resource. Only the declared attachment fields are
  persisted, so an unrecognized kind or unknown nested metadata is dropped
  rather than stored. The original file is not modified.
- `assert` filters label, summary and every string key and value in nested
  `attributes`. An unsafe key is rejected rather than sent through as a plain
  key; the filtered object is built without a prototype so `__proto__` cannot
  become an assignment.
- `relate` filters the claim.
- `replace` filters label, summary, attributes and claim. A quote that only
  matched before redaction is rejected; a placeholder is not treated as the
  original quote, even when the placeholder appears in stored text.
- `memory_write` direct adds, `memory_search` queries and semantic candidates all
  pass through these same runtime methods.
- Assistant and tool records remain `evidence`; filtering does not promote them
  to user-authored material.

Redacted content is replaced by a fixed placeholder such as
`[redacted:secret-assignment]`. The removed original text is never stored in
metadata or logs.

## Metadata

Records carry optional `capture` metadata:

```ts
{
  originalLength: number
  retainedLength: number
  truncated: boolean
  lengthUnit: 'utf16-code-units'
  truncation?: 'tail-removed'
  blocked: false
  redactions: [{ category, count, replacement }]
}
```

Layer-1 nodes and edges carry optional `safety` metadata with the same
`blocked`/`redactions` shape for filtered summaries, claims and attributes.
Metadata contains counts, lengths and fixed placeholders only. Attachment
omission is counted as `attachment-dropped`; it never records the removed URI or
the underlying file content.

`maxTextLength` remains the observer's explicit capture budget. Truncation keeps
at most that many UTF-16 code units, never splits a surrogate pair, marks
`truncated: true`, records the original and retained lengths, and marks
`truncation: 'tail-removed'`. A preference in the missing tail is not captured;
the record does not claim the tail was read. The implementation does not silently
raise the limit or invent segmentation.

## External requests and history

- `recall` filters its query before lexical or vector work, so a secret in a
  query is not sent to the embedder. The returned query and `safety` metadata
  reflect the filtered form.
- The runtime also builds a safe read view for `recall`, `profile` and `suggest`.
  This is the common projection used by the real pre-step injection,
  `memory_search` and the `/memory` command, including its search echo and
  forget summaries. Node labels, summaries and
  attributes, edge claims and endpoints, record text, anchors, confirmations,
  attachment captions and derived index terms are filtered or omitted on the way
  out. A cue or profile row blocked
  by the policy is dropped rather than rendered; ids and ranking order stay the
  same for rows that remain.
- These filters affect only the read view. Stored records, nodes and edges are
  not rewritten, migrated or deleted, and no embedding or model cache is added
  in this phase.
- The semantic distiller re-filters record text and existing-node attributes
  before building a model payload, using the same JSON policy as the write
  boundary rather than a separate string-only path. A historical record blocked
  by the policy is skipped with `blocked-sensitive`; a redacted record is sent
  only in filtered form.
- Old records remain readable. A placeholder or a quote containing a placeholder
  is not valid evidence for a new addition or replacement, even if that
  placeholder exists in the stored text. If a quote contains both an ordinary
  fragment and a placeholder, it is rejected conservatively.

## Error and logging behavior

A rejected write throws `MemoryError` with code `blocked-input` and a fixed
message. The observer logs only that capture failed, without the rejected text or
the original error message. Filter metadata is counts and categories; it never
contains the removed original.

## Verification

The focused suite includes 20 synthetic positive credential samples and 20
ordinary-text negatives, plus nested attributes, unsafe JSON keys, prototype-free
filtered objects, all switches off, attachment omission, legacy-store recall and
profile projections, the real pre-step hook, `memory_search`, historical semantic
payload filtering, placeholder quote rejection, truncation and surrogate
boundaries. The raw 20/20 run and fixed scoring script are kept outside the
package at
`experiments/代码修复-20261106/safety-check/`; the current run is 40/40 passed.
The first raw file stays fixed, and later runs append labelled rows to a separate
runs file instead of overwriting or mixing with it.

Passing these fixtures does not establish complete PII protection. The patterns
are deliberately narrow and can both miss unusual secrets and over-redact
ordinary text that resembles an assignment.
