# Consolidation progress and persistence diagnostics

English | [中文](consolidation-progress.zh.md)

Consolidation used to decide what to inspect with `promotedTo.length === 0`.
That conflates two different facts: "a belief cited this record" and "a distiller
already checked this record and found nothing". An empty result created no
citation, so the next pass read the same record again, forever. This change adds
independent, durable progress without fabricating a layer-1 reference.

## Delivery status (2026-11-07)

The progress table, version keys and retention/replay behavior are implemented
and covered by focused tests. The R3r1 300-case B2 run completed capture with
1,085 calls, known tokens 837,841 minimum, 319 calls with unknown usage and cost
unknown; A0/B1 zero-model prechecks were 300/300 full. That run verifies capture,
isolation and progress plumbing, not extraction quality or accuracy.

The work is **not deployed to production**. The old invalid full run and the
stopped SDK formal-100 run remain separate archives; do not concatenate them
with this run. See [HANDOFF.md](../HANDOFF.md) for the P0 list.

## Progress rows

A progress row is stored per scope, distiller, distiller version and layer-0
record:

```ts
interface MemoryDistillerProgress {
  id: MemoryProgressId
  scope: MemoryScopeKey
  distiller: string
  version: string
  record: MemoryRecordId
  status: 'empty' | 'proposed' | 'failed'
  attempts: number
  updatedAt: number
}
```

- `empty` — the distiller successfully checked the record and proposed nothing.
- `proposed` — the distiller proposed at least one item citing the record.
- `failed` — the distiller or candidate application failed; the record stays
  retryable until `attempts` reaches the configured bound.
- `skipped` — the record was permanently excluded by policy, with a fixed reason
  such as `input-too-large` or `blocked-sensitive` in `skipReason`.

`promotedTo` remains an audit field for records actually cited by a layer-1 item.
It is no longer the pending criterion for distillers that opt into progress.

Forgetting a record removes every progress row that references it, for every
distiller and version, so erasure does not leave orphan progress behind.

The bundled domain store persists progress in a `progress` table. The memory
domain format version is unchanged, so a medium written before this table existed
still loads and simply starts with no progress rows. No bulk migration rewrites
existing records.

## Distiller protocol

The extension is optional, so third-party distillers keep working:

```ts
interface MemoryDistiller {
  name: string
  rank: number
  version?: string
  progress?:
    | { mode: 'record'; maxAttempts: number }
    | { mode: 'window'; maxAttempts: number; lookback: number }
  distill(input: MemoryDistillInput): Promise<MemoryDistillation>
}
```

- A distiller with no `progress` policy keeps the legacy `promotedTo`-empty rule.
- A missing or blank `version` uses the explicit `legacy` progress key.
- Changing `version` starts a new key and replays records under the new
  implementation. Old rows remain readable; there is no automatic migration.
- The bundled `StatedPreferenceDistiller` uses `record` mode.
- The bundled `BehaviorCycleDistiller` uses `window` mode.

## Window mode

A behavior can repeat across several turns. Window mode passes new records plus
up to `lookback` already-processed records before the first new record. Only the
new records advance progress, so the lookback context is read again on the next
pass without being consumed twice. If only one new record arrives, two prior
records can still complete a three-repeat pattern.

The window starts at the first pending record and is bounded by the configured
`behaviorLookbackRecords` before it. The implementation does not contain a
global hidden window size.

## Failure, retry and idempotency

- A successful empty distillation advances progress.
- An exception, cancellation, or candidate application failure does not advance
  success progress.
- Before calling a distiller, after it returns, and before each candidate write,
  the hub checks the abort signal. A distiller that ignores its signal cannot
  apply candidates or advance progress after cancellation.
- Cancellation does not increment the failure attempt count.
- `failed` rows are retried while `attempts < maxAttempts`; after that the pass
  stops rescanning them and the row remains visible for diagnosis.
- Candidate application checks whether the existing node or edge already cites
  all candidate evidence. A retry after a partial write therefore does not
  reinforce the same evidence twice.
- Progress writes and promotion citations run under the scope write lock. If a
  progress write fails after earlier rows were written, those successful rows are
  not converted back into failures; only the remaining records are retried.
- Concurrent `consolidate()` calls for one scope share one in-flight pass. The
  first call owns its `signal` and `onDiagnostic`; later joiners share that pass's
  cancellation and result and cannot cancel it independently. The pass does not
  hold that lock while calling `assert`/`relate`, so the normal per-item write
  locks cannot deadlock.

## Diagnostics

`consolidate()` accepts a small optional callback:

```ts
await ctx.memory.consolidate(scope, {
  onDiagnostic(diagnostic) {
    // counts and timings only
  },
})
```

`MemoryConsolidationDiagnostic` carries scope, distiller, version, mode, pending
count, window size, advanced count, failed count and duration. It never carries
record text, labels, evidence ids or provider output. A throwing callback is
ignored so a diagnostic cannot break maintenance.

## Configuration

The shipped working set adds, explicitly:

```yaml
behaviorLookbackRecords: 20
progressMaxAttempts: 3
```

`behaviorLookbackRecords` is the amount of prior context a behavior pass may
read; `progressMaxAttempts` bounds failure retries for both bundled distillers.
Both are required config fields. A profile override must include them.

## Persistence profiling

The reproducible script lives outside the package at
`experiments/代码修复-20261106/persistence-profile/profile.ts`. It uses the real
JSON storage-domain backend, records 100/500/1000 synthetic entries, and reports
open/load, per-record write, list, get, put, first/second consolidation, reload
and SDK off/on boundaries. It makes no LLM call.

A compatible 0.2.1-rc.2 host was prepared, so the SDK-off profile now runs on
Node 24.19. With 100 / 500 / 1,000 synthetic records:

| records | first pass | second pass | reload |
|---:|---:|---:|---:|
| 100 | 327 ms | 0.15 ms | 24 ms |
| 500 | 2,821 ms | 0.62 ms | 35 ms |
| 1,000 | 7,057 ms | 0.43 ms | 22 ms |

List and get are cheap; the first pass tracks the per-record JSON `put` cost.
The script does not make an LLM call. SDK-on remains unverified because
`KYLIN_EMBED_RUNNER` is not set in this environment; that mode reports `blocked`
rather than fabricating a profile. Real Kylin runtime validation still belongs in
the isolated Kylin directory.
