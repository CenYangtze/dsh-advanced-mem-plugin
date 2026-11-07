# Kylin visual memory UI

English | [中文](kylin-memory-ui.zh.md)

The 智忆麒麟 UI is a separate presentation plugin over this read-only host API.
This page records the host API and its limitations.

## Interface

Original sidebar and hero marks, blue actions and restrained purple memory accents use DSH extension slots, not official Kylin artwork. The conversation header opens a read-only overlay with profile listing, real recall search and safe item details. It is not a registered shell right-side tab and has no edit or erase action. Existing model settings remain available; title/favicon and the shell's original hero slogan are unchanged.

A default-collapsed conversation card handles only durable `user/message` events whose source kind is `memory-recall`. It shows persisted sections and retains access to the full injected text, without inventing recall or injection counts. It reads the transcript, not the list/search API.

## Capability intent
The first version reads the **current session's derived scope plus the user**:
- `list` returns the standing profile for those scopes. It is a profile, not a
  global store listing.
- `search` runs real memory recall for a query and returns safe cues.
- The host entry adds one RPC channel only: no personal-memory namespace, global
  forwarding layer, write path, storage change, or tool.

## Scope and authorization
- The client sends only `sessionId`, an optional `query`, and an optional
  `limit`. It cannot send a scope.
- The host requires an `owner` principal and a live session found through
  `ctx.sessions.get`.
- Scopes come from `sessionScope(session)` plus `{ kind: 'user' }`. A missing or
  otherwise non-live session is rejected; the host does not guess a workspace
  from an id or fall back to a full-store read.
- Transport authentication is necessary but not sufficient; the owner and
  live-session checks belong to this entry.

## Protocol
Channel: `/kylin-memory-ui`. Endpoints: `list` and `search`.
```text
request  { sessionId: string, query?: string, limit?: number }
success  { ok: true, data: { items: Item[], mode: 'lexical' | 'semantic' | null } }
failure  { ok: false, error: { code: string, message: string } }
```

`Item` carries `id`, `kind` (`node` or `record`), `type`, `label`, `summary`,
`status`, `scope`, `createdAt`, optional `updatedAt`, and `evidenceCount`.

- A node supplies its label, summary, node type, evidence count, and `updatedAt`.
- A record supplies safe text as its summary; its kind is the type and label. It
  cites no layer-0 records, so `evidenceCount` is `0`.
- `list` always reports `mode: null`; a mounted embedder is not proof that
  semantic retrieval ran. `search` reports the mode recall actually ran.
- Search skips edge cues in this version. An edge is not promoted to a node,
  because that would invent an identity the store never issued.
- Only `recallable` records are returned; this channel never sets
  `includeEvidence`.

## Result safety and bounds
- Results are projections, not stored rows. Embeddings, internal attributes,
  retrieval terms, attachment internals, provider credentials, and raw evidence
  arrays do not cross the channel.
- Returned text has already passed the memory safety filter.
- A request without a limit uses `defaultLimit: 20`; the largest accepted value
  is `maxLimit: 50`. Non-integer, non-positive, and above-maximum values fail.
- Errors use fixed, non-sensitive messages; store and provider failures are
  contained instead of being copied into the response.

## First-version boundaries
- The host entry does not write, reinforce, retract, or forget, and exposes no
  forget operation.
- Today `/memory forget` only retracts a belief; it is not permanent erasure.
- The surface does not solve natural-language "do not remember this" refusal;
  capture policy and consent handling remain separate work.
- `memory/recorded` means a record entered the substrate. It does not prove that
  a preference was extracted, and must not be presented as extracted preference.
- Reads are snapshots per request. The entry does not subscribe to every
  background change or promise real-time refresh of all memory work.

## Evidence
```text
pnpm exec vitest run tests/kylin-memory-ui/host.spec.ts   # 7 tests passed
pnpm run typecheck                                        # host and client faces passed
```

The suite includes a real Connection composition with a sibling WebServer plugin and the real HTTP carrier. The final working-tree check passed 494 tests in 36 files, both compiler faces, build and bundle verification. That tree includes pre-existing experience work; these totals do not replace the earlier fix-only candidate's evidence.

A real DSH Web scaffold and local Edge passed a keyless browser check for branding, card expansion/full text, list, search, details, dark appearance, 390px layout and Escape dismissal, with no page errors. Memory and the injected event were synthetic: this verifies UI integration, not model-driven extraction or recall quality. See the [verification record](ui-verification-20261107/README.md).

The separately exported staged candidate, excluding unrelated experience edits, also passed the full check: 24 files / 426 tests, both compiler faces, build and bundle verification. Browser evidence used the full working-tree build.
