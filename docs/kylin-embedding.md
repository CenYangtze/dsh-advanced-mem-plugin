# 银河麒麟 CoreAI embedding provider

English | [中文](kylin-embedding.zh.md)

`dsh-advanced-mem-plugin/embedding-kylin` is the thin, real-SDK provider for the
memory hub. It does not approximate semantics with feature hashing. It spawns a
native `memory_embed_runner`, which links `libkysdk-coreai-embedding`, talks to
the desktop `kylin-ai-runtime` / `kytensor` stack, and returns one JSON status
line with a model vector. The process boundary keeps an SDK crash, an ABI change
or a wedged runtime away from the Harness process.

The provider is transport-only. It does not cache vectors in this phase, and it
does not silently substitute `embedding-hash` when the SDK is unavailable.

## Delivery status (2026-11-07)

A 200-call synthetic probe returned 200 successes and 0 errors, with function
elapsed P95 59.156 ms. It did not stay resource-flat: runtime FD 33→67, threads
65→266, runtime→8001 connections 1→35 and kytensor 8001 ESTAB 3→71, with no
meaningful reclaim after about 218 s. Long-term stability is **blocked**; do not
hide it with a higher NOFILE limit or scheduled restarts.

Separately, the post lexical run at about 500 turns/qid measured retrieval P95
36.604 ms and production hook P95 32.983 ms. Those are component timings, not the
SDK recall chain; ingest/total are not a query SLA, and a 30k/50k single store
and the full SDK chain remain untested.

This work is **not deployed to production**. See [HANDOFF.md](../HANDOFF.md) for
the SDK cleanup risk and other P0 items.

## Requirements

- A 银河麒麟 desktop with `libkysdk-coreai-embedding`, `kylin-ai-runtime`,
  `kytensor` and the GTE Base embedding model installed.
- The `memory_embed_runner` binary built against those libraries. The reference
  source lives in `code/kylinOS_Agent/native/memory_embed_runner.c` in this
  repository's workspace; it is not bundled into this package.
- Node 24.19.0 is the validated runtime. Node 22.9.0 fails because `node:sqlite`
  does not satisfy the host's `^22.19` or `>=24` requirement; use Node 24.19.0,
  or a host-supported 22.19+ if staying on Node 22.

The runner protocol is one text per process:

```text
memory_embed_runner "<text>"
{"status":"pass","dim":768,"vector":[...]}
```

A failure is a JSON status line too:

```json
{"status":"fail","error":"session_setup_failed"}
```

Diagnostic lines before the status line are ignored. A missing status line, a
non-`pass` status, a dimension change, an empty vector, or a non-finite
component is a failed call, not an empty embedding.

## Configuration

Every field is required. There are no defaults in the implementation; the
profile states the complete deployment choice.

| Field | Meaning |
|---|---|
| `enabled` | Mount the provider at all. `false` skips runner resolution and registration. |
| `runnerPath` | Path to `memory_embed_runner`. Relative paths resolve from the package root. `KYLIN_EMBED_RUNNER` overrides a non-empty value. |
| `model` | Model identity, for example `gte-base`. |
| `modelVersion` | Weights or protocol revision. Stamped into the vector identity together with `model`. |
| `dimensions` | Required vector width; the official model is `768`. A different width is a model change, not a truncation. |
| `timeoutMs` | Per-text subprocess timeout. |
| `maxOutputBytes` | Combined stdout/stderr byte cap for one call. Exceeding it kills the child. |
| `fallback` | Only `lexical`. Raw records stay durable and recall degrades to BM25. The field is required so the policy is visible in the profile. |

`KYLIN_EMBED_RUNNER` wins over `runnerPath` when non-empty. Both values are
resolved to an absolute path; a relative value is taken from the package root.
`enabled: true` with both values empty is a configuration error, not a hidden
default. A missing binary mounts an explicit unavailable provider, so recall
reports `not-found` instead of looking like an intentionally disabled embedder.

The provider name is `kylin-coreai:<model>@<modelVersion>`. The hub only compares
a stored vector with a query vector from the same name, so a model or version
change cannot mix incompatible spaces.

A vector that is empty, all zero, non-finite, has a changed width, or whose norm
overflows is a failed call. It is never stored as a successful embedding.

## Independent profile example

The shipped `cordis.patch.yml` intentionally has no embedding row. Enable the
provider in a separate profile instead of changing the production profile or
the shipped patch block:

```yaml
# $DSH_HOME/profiles/kylin-memory/cordis.patch.yml
- id: memory-embedding
  name: dsh-advanced-mem-plugin/embedding-kylin
  config:
    enabled: true
    runnerPath: /opt/kylin-memory/native/build/memory_embed_runner
    model: gte-base
    modelVersion: "2026-09"
    dimensions: 768
    timeoutMs: 30000
    maxOutputBytes: 1048576
    fallback: lexical
```

Set `KYLIN_EMBED_RUNNER` when the binary lives outside the profile's package
root. A missing binary keeps the profile running, mounts an unavailable provider
and makes recall report `not-found`; it does not silently switch to feature
hashing.

Measure retrieval quality before raising `memory.vectorWeight`. The shipped
value is a statement about a real embedder, not evidence that this SDK is
better on any particular corpus.

## Failure behavior

Capture and recall have different jobs:

- **Capture.** `remember()` persists the raw record before it calls the SDK. If
  embedding fails, the durable record remains without a vector. An SDK outage
  cannot lose what the user said.
- **Recall.** A query embedding failure is caught, the lexical ranking still
  runs, and the answer reports the actual mode and a fixed failure category:

```ts
const recall = await ctx.memory.recall({ text, scopes })
if (recall.mode === 'lexical') {
  // semantic === false; BM25 and graph activation produced this answer
}
recall.embeddingFailure // { provider, code, reason } when the provider failed
```

`mode: 'semantic'` and `semantic: true` require at least one usable stored
vector ranked against a usable query vector. A mounted provider alone does not
make a recall semantic, and a zero-direction or malformed vector does not count.

The reason is one of the fixed categories `timeout`, `output-limit`,
`not-found`, `invalid-text`, `invalid-payload`, `dimension-mismatch`,
`sdk-failure`, `aborted` or `empty-text`. Raw stderr, payload JSON, query text
and a generic provider's error message are never copied into the diagnostic.

## Caching

This phase adds no cache. A correct cache needs bounded capacity, a key that
includes the model and version, and propagation of `forget` erasure; without
those, a hit can outlive the material it represents or cross model spaces. Until
that work is measured, each embedding is a real runner call.

Within one `embed()` call, input is processed one text at a time in order, so a
large batch does not fan out. Concurrent `embed()` calls are not globally
bounded: the provider has no shared queue or capacity limiter in this phase.
Callers that issue many captures concurrently can therefore start more than one
runner; that is a known limit, not a cache or a scheduler.

## Verification

Ordinary CI uses fake runners and responses; it does not need a Kylin machine:

```sh
pnpm exec vitest run tests/memory-embedding-kylin tests/memory
```

The suite covers success, non-zero exit, timeout, malformed output, empty and
non-finite vectors, dimension changes, zero/overflow vectors, disabled mode,
lexical fallback, unavailable-provider diagnostics and model-version isolation.

On a real Kylin machine, probe the runner separately from the full retrieval
path:

```sh
KYLIN_EMBED_RUNNER=/path/to/memory_embed_runner \
  "$KYLIN_EMBED_RUNNER" "Kylin embedding probe"
```

Report the runner probe, first query, repeated query and full recall separately.
An SDK probe passing is not a retrieval-quality result.
