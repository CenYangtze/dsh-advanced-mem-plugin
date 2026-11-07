/**
 * The memory hub (`ctx.memory`): the Service Definition of the memory capability
 * seam plus the graph semantics every role shares.
 *
 * The hub performs no IO and reasons with no model. It owns the vocabulary, the
 * provider registries, the retrieval algorithm, and the belief update laws;
 * where memories are stored, how text becomes a vector, and which conclusions are
 * worth drawing all belong to providers mounted beside it.
 *
 * Two layers, one substrate. `remember()` appends fine-grained raw material to
 * layer 0 with the provenance needed to re-derive it from the session log.
 * `assert()` and `relate()` maintain the coarse-grained layer-1 graph, where
 * nodes are durable subjects — the person, their preferences, the skills they
 * reach for — and edges are the conclusions events induced between them. Every
 * layer-1 item cites the layer-0 records that justify it, so `recall()` can
 * always answer with the evidence as well as the belief.
 *
 * @module dsh-advanced-mem-plugin
 */

import { createHash, randomUUID } from 'node:crypto'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Session } from '@deepseek-ai/dsh-session'
import { MemoryError } from './errors.ts'
import {
  bm25Rank,
  clampConfidence,
  cosineSimilarity,
  decayedConfidence,
  isCorrection,
  rankScore,
  reciprocalRankFusion,
  reinforcedConfidence,
  similarity,
  splitCue,
  tokenize,
  topicTerms,
  weakenedConfidence,
} from './scoring.ts'
import type { ScoredItem } from './scoring.ts'
import {
  MemoryEdgeId,
  MemoryNodeId,
  MemoryProgressId,
  MemoryRecordId,
  meetsFidelity,
  memoryScopeKey,
  recordUseFor,
} from './types.ts'
import type {
  MemoryAttachment,
  MemoryCaptureMetadata,
  MemoryDecay,
  MemoryDistillerProgress,
  MemoryEdge,
  MemoryNode,
  MemoryOrigin,
  MemoryRecord,
  MemoryRef,
  MemoryFilterResult,
  MemoryRedaction,
  MemorySafetyConfig,
  MemorySafetyMetadata,
  MemoryScope,
  MemoryScopeKey,
  MemorySupport,
} from './types.ts'
import type {
  MemoryCue,
  MemoryMaintenanceReport,
  MemoryProfile,
  MemoryQuery,
  MemoryRecall,
  MemoryAssertion,
  MemoryObservation,
  MemorySuggestion,
  MemoryRelationInput,
  MemoryReplacementRequest,
  MemoryReplacementResult,
  MemorySignal,
} from './query.ts'
import type {
  MemoryCandidateEdge,
  MemoryCandidateNode,
  MemoryDistillationFailureReason,
  MemoryDistillationSkipReason,
  MemoryDistillationUsage,
  MemoryDistiller,
  MemoryDistillerProgressPolicy,
  MemoryModelRoute,
  MemoryProgressStore,
  MemoryReplacementCandidate,
  MemoryEmbedder,
  MemoryEmbedderFailure,
  MemoryEmbedderFailureCode,
  MemoryStore,
} from './providers.ts'
import {
  MEMORY_EMBEDDER_FAILURE_CODES,
  MEMORY_EMBEDDER_FAILURE_REASONS,
} from './providers.ts'

export { MemoryError } from './errors.ts'
export type { MemoryErrorCode } from './errors.ts'
export {
  MEMORY_EMBEDDER_FAILURE_CODES,
  MEMORY_EMBEDDER_FAILURE_REASONS,
  MemoryEmbedderError,
} from './providers.ts'
export type {
  MemoryEmbedderFailure,
  MemoryEmbedderFailureCode,
} from './providers.ts'
export {
  bm25Rank,
  clampConfidence,
  cosineSimilarity,
  decayedConfidence,
  normalizeVector,
  reciprocalRankFusion,
  reinforcedConfidence,
  similarity,
  tokenize,
  weakenedConfidence,
} from './scoring.ts'
export type { LexicalDocument, ScoredItem } from './scoring.ts'
export {
  MEMORY_FIDELITY_ORDER,
  MEMORY_RECORD_USE,
  MemoryEdgeId,
  MemoryNodeId,
  MemoryProgressId,
  MemoryRecordId,
  meetsFidelity,
  memoryScopeKey,
  recordUseFor,
} from './types.ts'
export type {
  MemoryAttachment,
  MemoryCaptureInput,
  MemoryCaptureMetadata,
  MemoryDecay,
  MemoryDistillerProgress,
  MemoryEdge,
  MemoryEmbedding,
  MemoryFidelity,
  MemoryFilterResult,
  MemoryNode,
  MemoryNodeType,
  MemoryOrigin,
  MemoryProvenance,
  MemoryRecord,
  MemoryRecordKind,
  MemoryRecordUse,
  MemoryRedaction,
  MemoryRef,
  MemoryRelation,
  MemorySafetyConfig,
  MemorySafetyMetadata,
  MemoryScope,
  MemoryScopeKey,
  MemoryStatus,
  MemorySupport,
} from './types.ts'
export type {
  MemoryAssertion,
  MemoryCue,
  MemoryEmbeddingFailure,
  MemoryMaintenanceReport,
  MemoryObservation,
  MemoryProfile,
  MemoryQuery,
  MemoryRecall,
  MemorySuggestion,
  MemoryRelationInput,
  MemoryReplacementRequest,
  MemoryReplacementResult,
  MemorySignal,
} from './query.ts'
export type {
  MemoryCandidateEdge,
  MemoryCandidateNode,
  MemoryDistillation,
  MemoryDistillationFailure,
  MemoryDistillationFailureReason,
  MemoryDistillationSkip,
  MemoryDistillationSkipReason,
  MemoryDistillationUsage,
  MemoryDistillAcceptContext,
  MemoryDistillInput,
  MemoryDistiller,
  MemoryDistillerProgressPolicy,
  MemoryEmbedder,
  MemoryModelRoute,
  MemoryProgressStore,
  MemoryReplacementCandidate,
  MemoryStore,
} from './providers.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    memory: MemoryRuntime
  }

  interface Events {
    /** Await dependent experience erasure before deleting its factual source. */
    'memory/before-forget'(record: MemoryRecord): Promise<void>
    /**
     * A layer-0 record entered the substrate.
     * @param record - the durable record as stored.
     * @mode emit
     */
    'memory/recorded'(record: MemoryRecord): void
    /**
     * A layer-1 node was created, reinforced, weakened, or tombstoned.
     * @param node - the node after the change.
     * @param previous - the node before the change, absent on creation.
     * @mode emit
     */
    'memory/node-changed'(node: MemoryNode, previous: MemoryNode | undefined): void
    /**
     * A layer-1 edge was created, reinforced, weakened, or tombstoned.
     * @param edge - the edge after the change.
     * @param previous - the edge before the change, absent on creation.
     * @mode emit
     */
    'memory/edge-changed'(edge: MemoryEdge, previous: MemoryEdge | undefined): void
    /**
     * A recall completed. Carries the answer and the request that produced it so
     * an observer can measure retrieval quality without re-running the query.
     * @param recall - the returned cues.
     * @param query - the request, including its scope chain and filters.
     * @mode emit
     */
    'memory/recalled'(recall: MemoryRecall, query: MemoryQuery): void
  }
}

/**
 * One safe consolidation diagnostic. It carries counts and timings only: no
 * record text, labels, evidence ids or provider output.
 */
export interface MemoryConsolidationDiagnostic {
  /** Partition the pass ran in. */
  readonly scope: MemoryScopeKey
  /** Distiller name. */
  readonly distiller: string
  /** Distiller version used for the progress key. */
  readonly version: string
  /** Progress mode the distiller declared. */
  readonly mode: 'record' | 'window'
  /** New records that drove this distiller this pass. */
  readonly pending: number
  /** Records actually passed to the distiller, including bounded lookback. */
  readonly window: number
  /** Records whose progress advanced after a successful apply. */
  readonly advanced: number
  /** Records marked failed and left retryable. */
  readonly failed: number
  /** Records permanently skipped by policy. */
  readonly skipped: number
  /** Host-reported token counts, when available; never estimated or priced. */
  readonly usage?: MemoryDistillationUsage
  /** Wall-clock time spent in this distiller for this pass. */
  readonly durationMs: number
}

/**
 * Records that may support a fact about the user. Tool and assistant output are
 * evidence of harness activity, not a user statement, even when a caller cites
 * them as proof of a preference.
 */
function userStatementRecord(record: MemoryRecord): boolean {
  if (record.use !== 'recallable') return false
  if (record.provenance.author !== 'user') return false
  return record.kind === 'user-message' || record.kind === 'note'
}

/** Normalize only whitespace for quote matching; no paraphrase is accepted. */
function normalizedQuote(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

/** Stable JSON for idempotency keys: object keys are sorted at every depth. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(item => canonicalJson(item)).join(',')}]`
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>
    return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

/** Stable replacement identity, so a retry after partial persistence reuses one node. */
function replacementNodeId(request: MemoryReplacementRequest): MemoryNodeId {
  const digest = createHash('sha256').update([
    memoryScopeKey(request.scope),
    request.target,
    request.type,
    request.label.trim(),
    request.summary.trim(),
    canonicalJson(request.attributes ?? null),
    [...new Set(request.evidence)].sort().join(','),
    normalizedQuote(request.quote),
  ].join('\n')).digest('hex').slice(0, 32)
  return MemoryNodeId(`mem-n-replace-${digest}`)
}

const PRIVATE_KEY_BLOCK = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/gi
const PRIVATE_KEY_OPEN = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*/gi
const PROVIDER_TOKEN = /\b(?:AKIA[0-9A-Z]{16}|ASIA[0-9A-Z]{16}|sk-[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{20,})\b/g
const BEARER_TOKEN = /\bBearer\s+[A-Za-z0-9._~+\/=-]{6,}\b/gi
const SECRET_ASSIGNMENT = /(?<![A-Za-z0-9_])["']?(?:password|passwd|pwd|api[_-]?key|secret(?:[_-]?key)?|client[_-]?secret|token|authorization)["']?\s*[:=]\s*["']?[^\s"',;]{6,}/gi
const REDACTION_PLACEHOLDER = /\[redacted:[a-z-]+\]/i
const ATTACHMENT_KINDS = ['image', 'video', 'audio', 'document', 'url', 'blob'] as const

function isAttachmentKind(value: string): value is MemoryAttachment['kind'] {
  return (ATTACHMENT_KINDS as readonly string[]).includes(value)
}

function mergeRedactions(target: MemoryRedaction[], added: readonly MemoryRedaction[]): void {
  for (const redaction of added) {
    const existing = target.find(item => item.category === redaction.category && item.replacement === redaction.replacement)
    if (existing === undefined) target.push(redaction)
    else target[target.indexOf(existing)] = { ...existing, count: existing.count + redaction.count }
  }
}

/**
 * Apply the deployment's minimal capture policy to one text.
 *
 * Patterns are fixed and high-confidence; deployments switch them on or off and
 * may add literal rejections, but cannot supply arbitrary regular expressions.
 * The returned metadata carries counts and fixed placeholders only.
 */
function filterText(text: string, safety: MemorySafetyConfig): MemoryFilterResult {
  const redactions: MemoryRedaction[] = []
  let out = text
  let blocked = false
  for (const literal of safety.blockedLiterals) {
    const needle = literal.trim()
    if (needle.length === 0) continue
    if (out.toLowerCase().includes(needle.toLowerCase())) {
      blocked = true
      redactions.push({ category: 'blocked-literal', count: 1, replacement: '' })
      break
    }
  }
  const apply = (pattern: RegExp, category: MemoryRedaction['category'], replacement: string): void => {
    let count = 0
    out = out.replace(pattern, () => {
      count++
      return replacement
    })
    if (count === 0) return
    redactions.push({ category, count, replacement })
    if (safety.rejectSensitivePatterns) blocked = true
  }
  if (safety.redactPrivateKeys) {
    apply(PRIVATE_KEY_BLOCK, 'private-key', '[redacted:private-key]')
    apply(PRIVATE_KEY_OPEN, 'private-key', '[redacted:private-key]')
  }
  if (safety.redactProviderTokens) apply(PROVIDER_TOKEN, 'provider-token', '[redacted:provider-token]')
  if (safety.redactBearerTokens) apply(BEARER_TOKEN, 'bearer-token', '[redacted:bearer-token]')
  if (safety.redactSecretAssignments) apply(SECRET_ASSIGNMENT, 'secret-assignment', '[redacted:secret-assignment]')
  if (blocked) out = ''
  return {
    text: out,
    metadata: {
      originalLength: text.length,
      retainedLength: out.length,
      blocked,
      redactions,
    },
  }
}

function isSensitiveKey(key: string): boolean {
  return /^(?:password|passwd|pwd|api[_-]?key|secret(?:[_-]?key)?|client[_-]?secret|token|authorization)$/i.test(key)
}

function filterJson(
  value: JsonValue,
  safety: MemorySafetyConfig,
  redactions: MemoryRedaction[],
): { value: JsonValue; blocked: boolean } {
  if (typeof value === 'string') {
    const filtered = filterText(value, safety)
    mergeRedactions(redactions, filtered.metadata.redactions)
    return { value: filtered.text, blocked: filtered.metadata.blocked }
  }
  if (Array.isArray(value)) {
    const out: JsonValue[] = []
    for (const item of value) {
      const filtered = filterJson(item, safety, redactions)
      if (filtered.blocked) return { value: null, blocked: true }
      out.push(filtered.value)
    }
    return { value: out, blocked: false }
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, JsonValue> = Object.create(null) as Record<string, JsonValue>
    for (const [key, item] of Object.entries(value)) {
      const safeKey = filterText(key, safety)
      if (safeKey.metadata.blocked || safeKey.metadata.redactions.length > 0) {
        mergeRedactions(redactions, safeKey.metadata.redactions)
        return { value: null, blocked: true }
      }
      if (safety.redactSecretAssignments && isSensitiveKey(key)) {
        redactions.push({ category: 'secret-assignment', count: 1, replacement: '[redacted:secret-assignment]' })
        if (safety.rejectSensitivePatterns) return { value: null, blocked: true }
        out[key] = '[redacted:secret-assignment]'
        continue
      }
      const filtered = filterJson(item, safety, redactions)
      if (filtered.blocked) return { value: null, blocked: true }
      out[key] = filtered.value
    }
    return { value: out, blocked: false }
  }
  return { value, blocked: false }
}

/**
 * Deployment policy for belief dynamics and retrieval breadth. Every field is
 * required: the right half-life for a preference and the right record budget for
 * a workspace both depend on how the deployment is used, and a default here would
 * be an unsupported choice rather than a convenience.
 */
export interface Config {
  /** Cues returned by a recall that does not state its own limit. */
  recallLimit: number
  /** Nodes returned by a profile that does not state its own limit. */
  profileLimit: number
  /** Initial belief for a conclusion the harness drew itself. */
  inferredConfidence: number
  /** Initial belief for a statement the user made. */
  assertedConfidence: number
  /** Half-life in milliseconds of an unreinforced inferred belief. */
  inferredHalfLifeMs: number
  /**
   * Half-life in milliseconds of an unreinforced asserted belief. Zero disables
   * erosion entirely, which is the usual choice: the user said it, so only the
   * user unsays it.
   */
  assertedHalfLifeMs: number
  /** Fraction of the remaining distance to certainty closed by one reinforcement. */
  reinforcementRate: number
  /** Fraction of the current belief removed by one contradiction. */
  contradictionRate: number
  /** Decayed confidence below which a sweep tombstones an inferred belief. */
  retirementFloor: number
  /** Hops that activation spreads from a directly matched node across active edges. */
  activationHops: number
  /** Weight multiplier applied per activation hop; below 1 so distant nodes matter less. */
  activationFalloff: number
  /** Layer-0 records retained per scope; a sweep erases the lowest-value overflow. */
  recordBudget: number
  /**
   * How much accumulated support lifts a belief in recall.
   *
   * Confidence says how much the belief is trusted; support says how often it
   * has been seen, and they are different claims. But this is the wrong place to
   * act on the second one, and the number says so: at 0.15 it costs 19 points of
   * rank-1 accuracy on a node-dense corpus and 5 on a sparse one, because the
   * rank curve is flat — rank 1 and rank 20 differ by a factor of 1.3 — so a
   * multiplier of 1.5 outweighs twenty places of lexical evidence. Frequency
   * belongs where nothing is competing with a query: `profile` and `suggest`
   * already rank on `confidence × log1p(support)`, and those are untouched.
   *
   * Shipped at 0. Raise it only with a measurement, and only on a deployment
   * whose corpus is smaller than the ones this was swept on.
   */
  supportWeight: number
  /**
   * Label similarity above which a newly distilled belief is merged into one the
   * scope already holds instead of being added beside it.
   *
   * Applies to distillation only. An explicit `assert` keeps exact-label
   * semantics, because a caller naming a label means that label — and because
   * `/memory forget <label>` has to stay predictable. 1 disables merging, which
   * is what leaves a scope holding six spellings of one preference.
   */
  duplicateThreshold: number
  /**
   * Cue similarity above which a cue is dropped from a recall as redundant with
   * one already selected.
   *
   * The budget is small and the cost of spending it on restatements is total:
   * eight near-identical cues crowd out everything else the turn needed. 1
   * disables the filter and returns a pure score ordering.
   */
  diversityThreshold: number
  /**
   * How much the vector ranking counts against the lexical one in fusion.
   *
   * 1 weighs them equally, which is only right when the embedder knows something
   * the term index does not. The shipped feature-hash embedder does not: it is a
   * random projection of token hashes, so its cosine similarity is a noisier
   * restatement of term overlap. Measured across LoCoMo, LongMemEval and both
   * halves of PerLTQA, weighing it equally cost up to 8.8 points of recall and
   * 0.155 of MRR against dropping it entirely. Raise it for an embedder with
   * real semantics behind it; 0 removes the signal without unmounting the
   * provider.
   */
  vectorWeight: number
  /** Minimal explainable filtering applied at every write and external-request boundary. */
  safety: MemorySafetyConfig
}

/**
 * Merge rankings by seat: every list's first, then every list's second, and so
 * on, keeping the first appearance of each item.
 * @param rankings - the lists, in priority order for ties at the same seat.
 * @param identify - the identity an item is deduplicated on.
 * @returns one list in which each source's top entry sits ahead of any source's next.
 */
function interleave<T>(rankings: readonly (readonly T[])[], identify: (item: T) => string): T[] {
  const out: T[] = []
  const seen = new Set<string>()
  const longest = Math.max(0, ...rankings.map(ranking => ranking.length))
  for (let seat = 0; seat < longest; seat += 1) {
    for (const ranking of rankings) {
      const item = ranking[seat]
      if (item === undefined) continue
      const key = identify(item)
      if (seen.has(key)) continue
      seen.add(key)
      out.push(item)
    }
  }
  return out
}

/** Progress key used when a distiller does not declare a version. */
const LEGACY_DISTILLER_VERSION = 'legacy'

/**
 * Version used for a distiller's progress key. A dynamic `progressVersion`
 * carries prompt/model/config identity for model-backed extraction; otherwise an
 * omitted or blank static version is the explicit legacy key.
 */
function distillerVersion(distiller: MemoryDistiller, route?: MemoryModelRoute): string {
  const dynamic = distiller.progressVersion?.(route)
  const version = (dynamic ?? distiller.version)?.trim()
  return version === undefined || version.length === 0 ? LEGACY_DISTILLER_VERSION : version
}

/**
 * Stable progress-row identity. Only scope, distiller name, version and record id
 * are encoded; no record text enters the durable key.
 */
function progressId(
  scope: MemoryScopeKey,
  distiller: string,
  version: string,
  record: MemoryRecordId,
): MemoryProgressId {
  return MemoryProgressId(`${scope}\n${distiller}\n${version}\n${record}`)
}

/**
 * Reject an aborted consolidation before any further read, candidate write or
 * progress write. The fixed message carries no session or record text.
 */
function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error('memory consolidation aborted')
}

/**
 * Reject a distiller progress policy that cannot bound retries or window size.
 * @param policy - the distiller's declared policy.
 * @param distiller - name used in the error, never record text.
 */
function validateProgressPolicy(policy: MemoryDistillerProgressPolicy, distiller: string): void {
  if (!Number.isSafeInteger(policy.maxAttempts) || policy.maxAttempts < 1) {
    throw new TypeError(
      `memory consolidation: distiller '${distiller}' maxAttempts must be a positive safe integer`,
    )
  }
  if (policy.mode === 'window' && (!Number.isSafeInteger(policy.lookback) || policy.lookback < 0)) {
    throw new TypeError(
      `memory consolidation: distiller '${distiller}' lookback must be a non-negative safe integer`,
    )
  }
}

/**
 * Include up to `lookback` processed records before the first new record, then
 * the new records themselves. Only the new records advance progress, so the
 * context is read again on the next pass without being consumed twice.
 */
function windowWithLookback(
  records: readonly MemoryRecord[],
  pending: readonly MemoryRecord[],
  lookback: number,
): MemoryRecord[] {
  if (pending.length === 0) return []
  const pendingIds = new Set(pending.map(record => record.id))
  let first = -1
  let last = -1
  for (let index = 0; index < records.length; index++) {
    const record = records[index]
    if (record === undefined || !pendingIds.has(record.id)) continue
    if (first === -1) first = index
    last = index
  }
  if (first === -1) return [...pending]
  const start = Math.max(0, first - lookback)
  return records.slice(start, last + 1)
}

/** Empty accumulated support for a layer-1 item created from one observation moment. */
function initialSupport(at: number, observations: number, sessions: number): MemorySupport {
  return {
    observations,
    reinforcements: 0,
    contradictions: 0,
    sessions,
    firstSeenAt: at,
    lastSeenAt: at,
  }
}

/**
 * Whether a provider result is a vector the hub can compare: right width,
 * finite components, non-zero direction, and a norm that does not overflow.
 * A malformed or zero vector is a failed call, not a zero-scored signal.
 * @param vector - the candidate from an embedder.
 * @param dimensions - the provider's declared width.
 * @returns whether the vector is usable as-is.
 */
function usableVector(vector: readonly number[] | undefined, dimensions: number): boolean {
  if (vector === undefined || vector.length !== dimensions) return false
  let norm = 0
  let nonZero = false
  for (const component of vector) {
    if (!Number.isFinite(component)) return false
    if (component !== 0) nonZero = true
    norm += component * component
    if (!Number.isFinite(norm)) return false
  }
  return nonZero
}

/**
 * Whether an arbitrary value is one of the fixed failure categories.
 * @param value - a provider's `code` property.
 * @returns whether the code can be exposed safely.
 */
function isEmbedderFailureCode(value: unknown): value is MemoryEmbedderFailureCode {
  return typeof value === 'string'
    && (MEMORY_EMBEDDER_FAILURE_CODES as readonly string[]).includes(value)
}

/**
 * Convert any embedder error into a fixed, non-sensitive diagnostic. A generic
 * provider's message is never copied: a message can contain query text or SDK
 * output. Unknown errors become `sdk-failure`.
 * @param error - whatever an embedder threw.
 * @returns a safe category and fixed reason.
 */
function embedderFailureFrom(error: unknown): MemoryEmbedderFailure {
  const code = isEmbedderFailureCode((error as { code?: unknown } | undefined)?.code)
    ? (error as { code: MemoryEmbedderFailureCode }).code
    : 'sdk-failure'
  return { code, reason: MEMORY_EMBEDDER_FAILURE_REASONS[code] }
}

/**
 * Merge accumulated support after a repeat observation.
 * @param support - the item's current support.
 * @param at - epoch milliseconds of the new observation.
 * @param addedObservations - distinct new evidence records.
 * @param addedSessions - distinct new sessions the evidence spans.
 * @returns the updated support.
 */
function reinforceSupport(
  support: MemorySupport,
  at: number,
  addedObservations: number,
  addedSessions: number,
): MemorySupport {
  return {
    observations: support.observations + addedObservations,
    reinforcements: support.reinforcements + 1,
    contradictions: support.contradictions,
    sessions: support.sessions + addedSessions,
    firstSeenAt: Math.min(support.firstSeenAt, at),
    lastSeenAt: Math.max(support.lastSeenAt, at),
  }
}

/**
 * Union two evidence lists without duplicates, preserving first-citation order.
 * @param current - evidence already cited.
 * @param added - newly cited evidence.
 * @returns the merged list and how many citations were new.
 */
function mergeEvidence<T extends string>(
  current: readonly T[],
  added: readonly T[],
): { evidence: T[]; addedCount: number } {
  const evidence = [...current]
  const seen = new Set<string>(current)
  let addedCount = 0
  for (const id of added) {
    if (seen.has(id)) continue
    seen.add(id)
    evidence.push(id)
    addedCount++
  }
  return { evidence, addedCount }
}

/**
 * Resolve the scope a session's memories belong to.
 *
 * A workspace when the session has a working directory, the user scope
 * otherwise. Session scope is deliberately not the default: a memory that dies
 * with the session it was learned in can never be recalled, which is the one
 * outcome that makes a memory system pointless. Callers wanting session-local
 * memory pass that scope explicitly.
 * @param session - the session whose memories are being addressed.
 * @returns the scope for its records and beliefs.
 */
export function sessionScope(session: Session): MemoryScope {
  const cwd = session.header.cwd
  return cwd === undefined ? { kind: 'user' } : { kind: 'workspace', workspace: cwd }
}

/** Deduplicate a scope chain into partition keys, preserving caller order. */
function scopeKeys(scopes: readonly MemoryScope[]): MemoryScopeKey[] {
  const keys: MemoryScopeKey[] = []
  const seen = new Set<string>()
  for (const scope of scopes) {
    const key = memoryScopeKey(scope)
    if (seen.has(key)) continue
    seen.add(key)
    keys.push(key)
  }
  return keys
}

function scopeOfKey(key: MemoryScopeKey): MemoryScope {
  if (key === 'user') return { kind: 'user' }
  if (key.startsWith('workspace:')) return { kind: 'workspace', workspace: key.slice(10) }
  return { kind: 'session', sessionId: key.slice(8) as Session['id'] }
}

/**
 * The text a cue would put in front of the model, for comparing one cue to
 * another.
 *
 * A node contributes its label and summary rather than the summary alone: two
 * beliefs can be worded differently and still be the same claim about the same
 * subject, and the label is where the subject lives.
 * @param cue - the retrieved cue.
 * @returns the text to compare.
 */
function cueText(cue: MemoryCue): string {
  switch (cue.kind) {
    case 'node': return `${cue.node.label} ${cue.node.summary}`
    case 'edge': return cue.edge.claim
    case 'record': return cue.record.text
  }
}

/** Positions in a ranking, so a fused cue can report where each signal placed it. */
function rankPositions<T>(ranked: readonly ScoredItem<T>[], identify: (item: T) => string): Map<string, number> {
  const positions = new Map<string, number>()
  for (let index = 0; index < ranked.length; index++) {
    const entry = ranked[index]
    if (entry !== undefined) positions.set(identify(entry.item), index)
  }
  return positions
}

/**
 * The memory runtime. It coordinates providers, executes hybrid retrieval, and
 * applies the belief update laws; it never touches a medium or a model itself.
 */
export class MemoryRuntime extends Service {
  /** Schemastery validation for the plugin's configuration row. */
  static Config: z<Config> = z.object({
    recallLimit: z.number().required(),
    profileLimit: z.number().required(),
    inferredConfidence: z.number().required(),
    assertedConfidence: z.number().required(),
    inferredHalfLifeMs: z.number().required(),
    assertedHalfLifeMs: z.number().required(),
    reinforcementRate: z.number().required(),
    contradictionRate: z.number().required(),
    retirementFloor: z.number().required(),
    activationHops: z.number().required(),
    activationFalloff: z.number().required(),
    recordBudget: z.number().required(),
    supportWeight: z.number().required(),
    duplicateThreshold: z.number().required(),
    diversityThreshold: z.number().required(),
    vectorWeight: z.number().required(),
    safety: z.object({
      redactPrivateKeys: z.boolean().required(),
      redactProviderTokens: z.boolean().required(),
      redactBearerTokens: z.boolean().required(),
      redactSecretAssignments: z.boolean().required(),
      rejectSensitivePatterns: z.boolean().required(),
      blockedLiterals: z.array(z.string()).required(),
    }).required(),
  })

  private storeProvider: MemoryStore | undefined
  private embedderProvider: MemoryEmbedder | undefined
  private readonly distillerProviders = new Set<MemoryDistiller>()
  private readonly writes = new Map<MemoryScopeKey, Promise<unknown>>()
  private readonly consolidations = new Map<MemoryScopeKey, Promise<MemoryMaintenanceReport>>()

  private serialize<T>(scope: MemoryScopeKey, work: () => Promise<T>): Promise<T> {
    const next = (this.writes.get(scope) ?? Promise.resolve()).then(work, work)
    this.writes.set(scope, next)
    const done = (): void => { if (this.writes.get(scope) === next) this.writes.delete(scope) }
    void next.then(done, done)
    return next
  }

  /**
   * @param ctx - the registrant context; provider registrations unwind with it.
   * @param config - validated belief and retrieval policy.
   */
  constructor(ctx: Context, private readonly config: Config) {
    super(ctx, 'memory')
  }

  /**
   * Mount the single durable store. Registration is an effect.
   * @param store - the provider to mount.
   * @returns the disposer that unmounts it.
   * @throws `duplicate-provider` when a store is already mounted.
   */
  registerStore(store: MemoryStore): () => void {
    if (this.storeProvider !== undefined) {
      throw new MemoryError(
        'duplicate-provider',
        `memory store '${this.storeProvider.name}' is already mounted; '${store.name}' cannot replace it`,
      )
    }
    this.storeProvider = store
    return () => {
      if (this.storeProvider === store) this.storeProvider = undefined
    }
  }

  /**
   * Mount the single embedder. Registration is an effect.
   * @param embedder - the provider to mount.
   * @returns the disposer that unmounts it.
   * @throws `duplicate-provider` when an embedder is already mounted.
   */
  registerEmbedder(embedder: MemoryEmbedder): () => void {
    if (this.embedderProvider !== undefined) {
      throw new MemoryError(
        'duplicate-provider',
        `memory embedder '${this.embedderProvider.name}' is already mounted; '${embedder.name}' cannot replace it`,
      )
    }
    this.embedderProvider = embedder
    return () => {
      if (this.embedderProvider === embedder) this.embedderProvider = undefined
    }
  }

  /**
   * Add one distiller. Several may run together; `rank` orders them.
   * @param distiller - the provider to add.
   * @returns the disposer that removes it.
   */
  registerDistiller(distiller: MemoryDistiller): () => void {
    this.distillerProviders.add(distiller)
    return () => {
      this.distillerProviders.delete(distiller)
    }
  }

  /** The mounted embedder, or `undefined` when recall must run lexically. */
  get embedder(): MemoryEmbedder | undefined {
    return this.embedderProvider
  }

  /**
   * The mounted store.
   * @returns the store provider.
   * @throws `no-store` when no store is mounted.
   */
  get store(): MemoryStore {
    if (this.storeProvider === undefined) {
      throw new MemoryError('no-store', 'no memory store is mounted; compose a memory store provider')
    }
    return this.storeProvider
  }

  /** Whether a store is mounted, for consumers that must degrade rather than fail. */
  get ready(): boolean {
    return this.storeProvider !== undefined
  }

  /**
   * Filter text before it leaves the process for embedding or an auxiliary model.
   * This re-applies the current policy to historical records; it does not rewrite
   * the stored record.
   * @param text - the text about to be sent externally.
   * @returns filtered text and non-sensitive metadata.
   */
  filterExternalText(text: string): MemoryFilterResult {
    return filterText(text, this.config.safety)
  }

  /**
   * Filter one JSON value before it leaves the process. String keys and values
   * use the same policy as text; a blocked value or unsafe key is reported so a
   * caller can omit the request rather than send a partially redacted object.
   * @param value - the JSON value about to be sent externally.
   * @returns safe value, blocked flag and non-sensitive redaction counts.
   */
  filterExternalJson(value: JsonValue): { value: JsonValue; blocked: boolean; redactions: MemoryRedaction[] } {
    const redactions: MemoryRedaction[] = []
    const filtered = filterJson(value, this.config.safety, redactions)
    return { ...filtered, redactions }
  }

  private filterWriteText(text: string): MemoryFilterResult {
    const filtered = filterText(text, this.config.safety)
    if (filtered.metadata.blocked) {
      throw new MemoryError('blocked-input', 'memory input rejected by capture policy')
    }
    return filtered
  }

  private filterWriteAttributes(
    attributes: Readonly<Record<string, JsonValue>> | undefined,
  ): { attributes: Readonly<Record<string, JsonValue>> | undefined; redactions: MemoryRedaction[] } {
    if (attributes === undefined) return { attributes: undefined, redactions: [] }
    const redactions: MemoryRedaction[] = []
    const filtered = filterJson(attributes, this.config.safety, redactions)
    if (filtered.blocked) {
      throw new MemoryError('blocked-input', 'memory input rejected by capture policy')
    }
    return { attributes: filtered.value as Readonly<Record<string, JsonValue>>, redactions }
  }

  /** Build a safe read view of a node without mutating the stored row. */
  private safeNodeView(node: MemoryNode): { node: MemoryNode; blocked: boolean; redactions: MemoryRedaction[] } {
    const redactions: MemoryRedaction[] = []
    const label = filterText(node.label, this.config.safety)
    const summary = filterText(node.summary, this.config.safety)
    const attributes = filterJson(node.attributes as JsonValue, this.config.safety, redactions)
    mergeRedactions(redactions, label.metadata.redactions)
    mergeRedactions(redactions, summary.metadata.redactions)
    if (label.metadata.blocked || summary.metadata.blocked || attributes.blocked) {
      return { node, blocked: true, redactions }
    }
    const originalLength = node.label.length + node.summary.length + JSON.stringify(node.attributes).length
    const retainedLength = label.text.length + summary.text.length + JSON.stringify(attributes.value).length
    return {
      blocked: false,
      redactions,
      node: {
        ...node,
        label: label.text,
        summary: summary.text,
        attributes: attributes.value as Readonly<Record<string, JsonValue>>,
        ...(redactions.length === 0 ? {} : {
          safety: { originalLength, retainedLength, blocked: false, redactions },
        }),
      },
    }
  }

  /** Build a safe read view of an edge without mutating the stored row. */
  private safeEdgeView(edge: MemoryEdge): { edge: MemoryEdge; blocked: boolean; redactions: MemoryRedaction[] } {
    const claim = filterText(edge.claim, this.config.safety)
    if (claim.metadata.blocked) return { edge, blocked: true, redactions: [...claim.metadata.redactions] }
    return {
      blocked: false,
      redactions: [...claim.metadata.redactions],
      edge: {
        ...edge,
        claim: claim.text,
        ...(claim.metadata.redactions.length === 0 ? {} : {
          safety: {
            originalLength: edge.claim.length,
            retainedLength: claim.text.length,
            blocked: false,
            redactions: claim.metadata.redactions,
          },
        }),
      },
    }
  }

  /** Build a safe read view of a record and its attachment references. */
  private safeRecordView(record: MemoryRecord): { record: MemoryRecord; blocked: boolean; redactions: MemoryRedaction[] } {
    const redactions: MemoryRedaction[] = []
    const text = filterText(record.text, this.config.safety)
    mergeRedactions(redactions, text.metadata.redactions)
    if (text.metadata.blocked) return { record, blocked: true, redactions }
    const attachments: MemoryAttachment[] = []
    for (const attachment of record.attachments) {
      if (!isAttachmentKind(attachment.kind)) {
        redactions.push({ category: 'attachment-dropped', count: 1, replacement: '' })
        continue
      }
      if (attachment.bytes !== undefined
        && (typeof attachment.bytes !== 'number' || !Number.isFinite(attachment.bytes) || attachment.bytes < 0)) {
        redactions.push({ category: 'attachment-dropped', count: 1, replacement: '' })
        continue
      }
      const uri = filterText(attachment.uri, this.config.safety)
      const mediaType = attachment.mediaType === undefined ? undefined : filterText(attachment.mediaType, this.config.safety)
      const digest = attachment.digest === undefined ? undefined : filterText(attachment.digest, this.config.safety)
      const caption = attachment.caption === undefined ? undefined : filterText(attachment.caption, this.config.safety)
      const blocked = uri.metadata.blocked || uri.metadata.redactions.length > 0
        || (mediaType !== undefined && (mediaType.metadata.blocked || mediaType.metadata.redactions.length > 0))
        || (digest !== undefined && (digest.metadata.blocked || digest.metadata.redactions.length > 0))
        || caption?.metadata.blocked === true
      if (blocked) {
        redactions.push({ category: 'attachment-dropped', count: 1, replacement: '' })
        continue
      }
      if (mediaType !== undefined) mergeRedactions(redactions, mediaType.metadata.redactions)
      if (digest !== undefined) mergeRedactions(redactions, digest.metadata.redactions)
      if (caption !== undefined) mergeRedactions(redactions, caption.metadata.redactions)
      attachments.push({
        kind: attachment.kind,
        uri: uri.text,
        ...(mediaType === undefined ? {} : { mediaType: mediaType.text }),
        ...(attachment.bytes === undefined ? {} : { bytes: attachment.bytes }),
        ...(digest === undefined ? {} : { digest: digest.text }),
        ...(caption === undefined ? {} : { caption: caption.text }),
      })
    }
    const retainedLength = text.text.length
    return {
      blocked: false,
      redactions,
      record: {
        ...record,
        text: text.text,
        terms: [],
        attachments,
        ...(redactions.length === 0 ? {} : {
          capture: {
            originalLength: record.text.length,
            retainedLength,
            truncated: record.capture?.truncated ?? false,
            lengthUnit: 'utf16-code-units',
            ...(record.capture?.truncation === undefined ? {} : { truncation: record.capture.truncation }),
            blocked: false,
            redactions,
          },
        }),
      },
    }
  }

  /** Project one selected cue onto safe text for any external consumer. */
  private safeCue(cue: MemoryCue): MemoryCue | undefined {
    if (cue.kind === 'node') {
      const node = this.safeNodeView(cue.node)
      if (node.blocked) return undefined
      return { ...cue, node: node.node, ...(node.redactions.length === 0 ? {} : {
        safety: { originalLength: cue.node.label.length + cue.node.summary.length, retainedLength: node.node.label.length + node.node.summary.length, blocked: false, redactions: node.redactions },
      }) }
    }
    if (cue.kind === 'edge') {
      const edge = this.safeEdgeView(cue.edge)
      if (edge.blocked) return undefined
      const endpoints: MemoryNode[] = []
      const redactions = [...edge.redactions]
      for (const endpoint of cue.endpoints) {
        const safe = this.safeNodeView(endpoint)
        if (safe.blocked) return undefined
        endpoints.push(safe.node)
        mergeRedactions(redactions, safe.redactions)
      }
      return { ...cue, edge: edge.edge, endpoints, ...(redactions.length === 0 ? {} : {
        safety: { originalLength: cue.edge.claim.length, retainedLength: edge.edge.claim.length, blocked: false, redactions },
      }) }
    }
    const record = this.safeRecordView(cue.record)
    if (record.blocked) return undefined
    const anchor = cue.anchor === undefined ? undefined : this.safeRecordView(cue.anchor)
    if (anchor?.blocked === true) return undefined
    const confirmation = cue.confirmation === undefined ? undefined : this.safeRecordView(cue.confirmation)
    if (confirmation?.blocked === true) return undefined
    const redactions = [...record.redactions]
    if (anchor !== undefined) mergeRedactions(redactions, anchor.redactions)
    if (confirmation !== undefined) mergeRedactions(redactions, confirmation.redactions)
    return {
      ...cue,
      record: record.record,
      ...(anchor === undefined ? {} : { anchor: anchor.record }),
      ...(confirmation === undefined ? {} : { confirmation: confirmation.record }),
      ...(redactions.length === 0 ? {} : {
        safety: { originalLength: cue.record.text.length, retainedLength: record.record.text.length, blocked: false, redactions },
      }),
    }
  }

  /** Project one stored node onto safe text for a command or other external view. */
  safeNode(node: MemoryNode): MemoryNode | undefined {
    const view = this.safeNodeView(node)
    return view.blocked ? undefined : view.node
  }

  /**
   * Append one layer-0 record and index it for retrieval.
   *
   * The raw record is persisted before an embedder is called: an SDK outage must
   * never lose what the user said. A vector is written later under the scope's
   * write lock, so a concurrent retract or erase wins and a late vector cannot
   * resurrect a deleted record. Only the embedder call is caught; a store write
   * failure propagates.
   * @param observation - the raw material to keep.
   * @returns the stored record, with a vector when embedding succeeded.
   * @throws `invalid-input` when the text is blank, or `no-store` when nothing is mounted.
   */
  async remember(observation: MemoryObservation): Promise<MemoryRecord> {
    return this.rememberInternal(observation, false)
  }

  /**
   * Shared capture path. `scopeLocked` is true only when the caller already
   * holds this scope's serialization, which avoids re-entering the same lock in
   * the assertion ledger path.
   */
  private async rememberInternal(
    observation: MemoryObservation,
    scopeLocked: boolean,
  ): Promise<MemoryRecord> {
    const rawText = observation.text.trim()
    if (rawText.length === 0) {
      throw new MemoryError('invalid-input', 'a memory observation needs non-empty text')
    }
    const filteredText = this.filterWriteText(rawText)
    const text = filteredText.text
    const redactions = [...filteredText.metadata.redactions]
    const attachments: MemoryAttachment[] = []
    for (const attachment of observation.attachments ?? []) {
      if (!isAttachmentKind(attachment.kind)) {
        redactions.push({ category: 'attachment-dropped', count: 1, replacement: '' })
        continue
      }
      if (attachment.bytes !== undefined
        && (typeof attachment.bytes !== 'number' || !Number.isFinite(attachment.bytes) || attachment.bytes < 0)) {
        redactions.push({ category: 'attachment-dropped', count: 1, replacement: '' })
        continue
      }
      const uri = filterText(attachment.uri, this.config.safety)
      const mediaType = attachment.mediaType === undefined
        ? undefined
        : filterText(attachment.mediaType, this.config.safety)
      const digest = attachment.digest === undefined ? undefined : filterText(attachment.digest, this.config.safety)
      const caption = attachment.caption === undefined ? undefined : filterText(attachment.caption, this.config.safety)
      const unsafe = uri.metadata.blocked || uri.metadata.redactions.length > 0
        || (mediaType !== undefined && (mediaType.metadata.blocked || mediaType.metadata.redactions.length > 0))
        || (digest !== undefined && (digest.metadata.blocked || digest.metadata.redactions.length > 0))
        || caption?.metadata.blocked === true
      if (unsafe) {
        redactions.push({ category: 'attachment-dropped', count: 1, replacement: '' })
        continue
      }
      if (caption !== undefined) mergeRedactions(redactions, caption.metadata.redactions)
      attachments.push({
        kind: attachment.kind,
        uri: uri.text,
        ...(mediaType === undefined ? {} : { mediaType: mediaType.text }),
        ...(attachment.bytes === undefined ? {} : { bytes: attachment.bytes }),
        ...(digest === undefined ? {} : { digest: digest.text }),
        ...(caption === undefined ? {} : { caption: caption.text }),
      })
    }
    const captions = attachments.map(attachment => attachment.caption ?? '').join(' ')
    const capture: MemoryCaptureMetadata = {
      originalLength: observation.capture?.originalLength ?? rawText.length,
      retainedLength: text.length,
      truncated: observation.capture?.truncated ?? false,
      lengthUnit: 'utf16-code-units',
      ...(observation.capture?.truncated === true ? { truncation: 'tail-removed' as const } : {}),
      blocked: false,
      redactions,
    }
    const record: MemoryRecord = {
      id: MemoryRecordId(`mem-r-${randomUUID()}`),
      scope: memoryScopeKey(observation.scope),
      kind: observation.kind,
      text,
      fidelity: observation.fidelity,
      use: observation.use ?? recordUseFor(observation.kind),
      terms: tokenize(`${text} ${captions}`),
      attachments,
      provenance: observation.provenance ?? {},
      capture,
      createdAt: observation.at ?? Date.now(),
      promotedTo: [],
      status: 'active',
    }
    await this.store.putRecord(record)

    const embedder = this.embedderProvider
    let vector: readonly number[] | undefined
    if (embedder !== undefined && embedder.unavailable === undefined) {
      try {
        const [candidate] = await embedder.embed([`${text} ${captions}`.trim()])
        if (candidate !== undefined && usableVector(candidate, embedder.dimensions)) vector = candidate
      } catch {
        // Only an embedding outage reaches here. The record above is already
        // durable; the vector write below is not attempted. Store failures are
        // outside this try and remain observable.
      }
    }

    const finalize = async (): Promise<MemoryRecord | undefined> => {
      const current = this.store.getRecord(record.id)
      if (current === undefined) return undefined
      if (current.status !== 'active') return current
      let next = current
      if (vector !== undefined && embedder !== undefined) {
        next = {
          ...current,
          embedding: { model: embedder.name, dimensions: embedder.dimensions, vector: [...vector] },
        }
        await this.store.putRecord(next)
      }
      this.ctx.emit('memory/recorded', next)
      if (next.use === 'recallable' && isCorrection(text)) await this.linkCorrection(next)
      return next
    }
    const stored = scopeLocked ? await finalize() : await this.serialize(record.scope, finalize)
    // A concurrent forget can remove the record while the SDK call is in
    // flight; return the durable observation the caller supplied, but never
    // emit or link it as an active record.
    return stored ?? record
  }

  /**
   * Point the message a correction overrides at the correction.
   *
   * The signal is deliberately narrow: the new message must open as a
   * correction, and the candidate must be the most recent earlier quotable
   * message in the scope that shares at least two topical terms with it. That
   * is enough to pair "track duration as a plain number" with "actually, switch
   * duration to minutes", and not enough to pair it with anything that merely
   * mentions the file. A miss costs nothing — recall still orders by date; a
   * false link only mislabels, never hides.
   * @param correction - the record just written.
   */
  private async linkCorrection(correction: MemoryRecord): Promise<void> {
    const topic = topicTerms(correction.terms)
    if (topic.size < 2) return
    let best: MemoryRecord | undefined
    let bestShared = 0
    for (const candidate of this.store.records([correction.scope])) {
      if (candidate.id === correction.id || candidate.status !== 'active') continue
      if (candidate.use !== 'recallable' || candidate.createdAt > correction.createdAt) continue
      if (candidate.supersededBy !== undefined) continue
      let shared = 0
      for (const term of topicTerms(candidate.terms)) if (topic.has(term)) shared += 1
      if (shared < 2) continue
      if (shared > bestShared || (shared === bestShared && best !== undefined && candidate.createdAt > best.createdAt)) {
        best = candidate
        bestShared = shared
      }
    }
    if (best === undefined) return
    const superseded: MemoryRecord = { ...best, supersededBy: correction.id }
    await this.store.putRecord(superseded)
    this.ctx.emit('memory/recorded', superseded)
  }

  /**
   * Create or reinforce one layer-1 node.
   *
   * An active node with the same scope, type, and label is reinforced rather
   * than duplicated: its belief rises, its evidence grows, and its decay clock
   * resets. A first assertion by the user upgrades an inferred node's origin, so
   * a guess the user later confirms stops eroding.
   * @param assertion - the belief to record.
   * @returns the stored node, created or reinforced.
   * @throws `invalid-input` when the label or summary is blank.
   */
  assert(assertion: MemoryAssertion): Promise<MemoryNode> {
    return this.serialize(memoryScopeKey(assertion.scope), () => this.assertNow(assertion))
  }

  private async assertNow(assertion: MemoryAssertion): Promise<MemoryNode> {
    const rawLabel = assertion.label.trim()
    const rawSummary = assertion.summary.trim()
    if (rawLabel.length === 0 || rawSummary.length === 0) {
      throw new MemoryError('invalid-input', 'a memory assertion needs a non-empty label and summary')
    }
    const redactions: MemoryRedaction[] = []
    const label = this.filterWriteText(rawLabel)
    mergeRedactions(redactions, label.metadata.redactions)
    const summary = this.filterWriteText(rawSummary)
    mergeRedactions(redactions, summary.metadata.redactions)
    const attributes = this.filterWriteAttributes(assertion.attributes)
    mergeRedactions(redactions, attributes.redactions)
    const safety: MemorySafetyMetadata | undefined = redactions.length === 0
      ? undefined
      : {
        originalLength: rawLabel.length + rawSummary.length,
        retainedLength: label.text.length + summary.text.length,
        blocked: false,
        redactions,
      }
    const scope = memoryScopeKey(assertion.scope)
    const at = assertion.at ?? Date.now()
    const evidence = await this.assertionEvidence(assertion.scope, assertion.evidence, summary.text, at)
    const existing = this.findNode(scope, assertion.type, label.text)
    if (existing !== undefined) {
      const merged = mergeEvidence(existing.evidence, evidence)
      const origin = assertion.origin === 'asserted' ? 'asserted' : existing.origin
      const next: MemoryNode = {
        ...existing,
        summary: summary.text,
        attributes: { ...existing.attributes, ...(attributes.attributes ?? {}) },
        confidence: clampConfidence(reinforcedConfidence(existing.confidence, this.config.reinforcementRate)),
        decay: this.decayFor(origin, assertion.halfLifeMs),
        support: reinforceSupport(existing.support, at, merged.addedCount, merged.addedCount === 0 ? 0 : 1),
        evidence: merged.evidence,
        origin,
        ...(safety === undefined ? {} : { safety }),
        updatedAt: at,
      }
      await this.store.putNode(next)
      this.ctx.emit('memory/node-changed', next, existing)
      return next
    }
    const node: MemoryNode = {
      id: MemoryNodeId(`mem-n-${randomUUID()}`),
      scope,
      type: assertion.type,
      label: label.text,
      summary: summary.text,
      attributes: attributes.attributes ?? {},
      confidence: clampConfidence(assertion.confidence ?? this.confidenceFor(assertion.origin)),
      decay: this.decayFor(assertion.origin, assertion.halfLifeMs),
      support: initialSupport(at, evidence.length, evidence.length === 0 ? 0 : 1),
      evidence: [...evidence],
      origin: assertion.origin,
      ...(safety === undefined ? {} : { safety }),
      status: 'active',
      createdAt: at,
      updatedAt: at,
    }
    await this.store.putNode(node)
    this.ctx.emit('memory/node-changed', node, undefined)
    return node
  }

  /**
   * Create or reinforce one layer-1 edge between two existing nodes.
   * @param input - the conclusion to record.
   * @returns the stored edge, created or reinforced.
   * @throws `unknown-item` when an endpoint does not exist, `invalid-input` when the claim is blank.
   */
  relate(input: MemoryRelationInput): Promise<MemoryEdge> {
    return this.serialize(memoryScopeKey(input.scope), () => this.relateNow(input))
  }

  private async relateNow(input: MemoryRelationInput): Promise<MemoryEdge> {
    const rawClaim = input.claim.trim()
    if (rawClaim.length === 0) {
      throw new MemoryError('invalid-input', 'a memory relation needs a non-empty claim')
    }
    const filteredClaim = this.filterWriteText(rawClaim)
    const claim = filteredClaim.text
    const safety: MemorySafetyMetadata | undefined = filteredClaim.metadata.redactions.length === 0
      ? undefined
      : {
        originalLength: rawClaim.length,
        retainedLength: claim.length,
        blocked: false,
        redactions: filteredClaim.metadata.redactions,
      }
    const scope = memoryScopeKey(input.scope)
    for (const endpoint of [input.from, input.to]) {
      const node = this.store.getNode(endpoint)
      if (node === undefined) {
        throw new MemoryError('unknown-item', `memory node '${endpoint}' does not exist`)
      }
      if (node.scope !== scope) throw new MemoryError('invalid-input', 'memory relation endpoints must belong to its scope')
    }
    const at = input.at ?? Date.now()
    const evidence = await this.assertionEvidence(input.scope, input.evidence, claim, at)
    const existing = this.findEdge(scope, input.from, input.to, input.relation)
    if (existing !== undefined) {
      const merged = mergeEvidence(existing.evidence, evidence)
      const origin = input.origin === 'asserted' ? 'asserted' : existing.origin
      const next: MemoryEdge = {
        ...existing,
        claim,
        confidence: clampConfidence(reinforcedConfidence(existing.confidence, this.config.reinforcementRate)),
        decay: this.decayFor(origin, input.halfLifeMs),
        support: reinforceSupport(existing.support, at, merged.addedCount, merged.addedCount === 0 ? 0 : 1),
        evidence: merged.evidence,
        origin,
        ...(safety === undefined ? {} : { safety }),
        updatedAt: at,
      }
      await this.store.putEdge(next)
      this.ctx.emit('memory/edge-changed', next, existing)
      return next
    }
    const edge: MemoryEdge = {
      id: MemoryEdgeId(`mem-e-${randomUUID()}`),
      scope,
      from: input.from,
      to: input.to,
      relation: input.relation,
      claim,
      confidence: clampConfidence(input.confidence ?? this.confidenceFor(input.origin)),
      decay: this.decayFor(input.origin, input.halfLifeMs),
      support: initialSupport(at, evidence.length, evidence.length === 0 ? 0 : 1),
      evidence: [...evidence],
      origin: input.origin,
      ...(safety === undefined ? {} : { safety }),
      status: 'active',
      createdAt: at,
      updatedAt: at,
    }
    await this.store.putEdge(edge)
    this.ctx.emit('memory/edge-changed', edge, undefined)
    return edge
  }

  /** Explicit API assertions leave an evidence-only ledger when no source was supplied. */
  private async assertionEvidence(scope: MemoryScope, evidence: readonly MemoryRecordId[] | undefined, text: string, at: number): Promise<MemoryRecordId[]> {
    if (evidence?.length) {
      const ids = [...new Set(evidence)]
      for (const id of ids) {
        const record = this.store.getRecord(id)
        if (!record || record.status !== 'active' || record.scope !== memoryScopeKey(scope)) {
          throw new MemoryError('invalid-input', `memory evidence '${id}' must be an active record in the same scope`)
        }
      }
      return ids
    }
    const record = await this.rememberInternal({
      scope, kind: 'note', text, fidelity: 'derived', use: 'evidence',
      provenance: { author: 'api' }, at,
    }, true)
    await this.store.putRecord({ ...record, promotedTo: ['assertion-ledger'] })
    return [record.id]
  }

  /**
   * Retrieve the memories most relevant to a cue.
   *
   * Three signals run independently and are fused by reciprocal rank: BM25 over
   * indexed terms, cosine similarity against the query embedding when an
   * embedder is mounted, and activation spreading outward from directly matched
   * nodes across active edges. Fusion consumes only positions, so the lexical and
   * vector scales never need calibrating against each other. Decayed confidence
   * is applied before filtering, so a belief that stopped being observed fades
   * out of recall without any expiry pass having run. A failed query embedding
   * degrades to the lexical and graph signals and is reported on the answer
   * instead of throwing; `mode` says what actually ran.
   * @param query - the cue, scope chain, and filters.
   * @returns the ranked cues and the mode/diagnostic that produced them.
   * @throws `no-store` when nothing is mounted.
   */
  async recall(query: MemoryQuery): Promise<MemoryRecall> {
    const store = this.store
    const now = query.now ?? Date.now()
    const limit = query.limit ?? this.config.recallLimit
    const scopes = scopeKeys(query.scopes)
    const filteredQuery = this.filterExternalText(query.text)
    const queryText = filteredQuery.text
    const terms = tokenize(queryText)

    const nodes = [...store.nodes(scopes)]
      .filter(node => node.status === 'active')
      .filter(node => query.nodeTypes === undefined || query.nodeTypes.includes(node.type))
      .map(node => this.applyDecay(node, now))
      .filter(node => node.confidence >= (query.minConfidence ?? 0))
    const nodeById = new Map(nodes.map(node => [node.id, node]))
    const edges = [...store.edges(scopes)]
      .filter(edge => edge.status === 'active')
      .filter(edge => nodeById.has(edge.from) && nodeById.has(edge.to))
      .map(edge => this.applyDecayEdge(edge, now))
      .filter(edge => edge.confidence >= (query.minConfidence ?? 0))
    const records = query.includeEpisodes === false
      ? []
      : [...store.records(scopes)]
        .filter(record => record.status === 'active')
        .filter(record => query.kinds === undefined || query.kinds.includes(record.kind))
        .filter(record => query.minFidelity === undefined || meetsFidelity(record.fidelity, query.minFidelity))

    const lexicalNodes = bm25Rank(terms, nodes.map(node => ({
      item: node,
      terms: tokenize(`${node.label} ${node.summary}`),
    })))
    const lexicalEdges = bm25Rank(terms, edges.map(edge => ({ item: edge, terms: tokenize(edge.claim) })))
    const lexicalDocuments = records.map(record => ({ item: record, terms: record.terms }))
    const wholeLexical = bm25Rank(terms, lexicalDocuments)
    // A multi-part cue is served part by part: each part's best record takes a
    // seat before any part's second, so the part with the fewest distinctive
    // terms is not starved by the one with the most. Rank fusion would not do
    // this — a topic that dominates two lists outscores the single best answer
    // to a third — so the lists are interleaved, whole first, and the fused
    // score below follows from the seat.
    const partRankings = splitCue(queryText)
      .map(part => bm25Rank(tokenize(part), lexicalDocuments))
      .filter(ranking => ranking.length > 0)
    const lexicalRecords = partRankings.length === 0
      ? wholeLexical
      : interleave([wholeLexical, ...partRankings], entry => entry.item.id)

    const vector = await this.vectorRank({ ...query, text: queryText }, records)
    const fusedRecords = reciprocalRankFusion<MemoryRecord>(
      [lexicalRecords.map(entry => entry.item), vector.records.map(entry => entry.item)],
      record => record.id,
      [1, this.config.vectorWeight],
    )
    // With evidence quoted outright, an anchor would print the same turn twice.
    const { anchors, confirmations } = query.includeEvidence === true
      ? { anchors: new Map<MemoryRecordId, MemoryRecord>(), confirmations: new Map<MemoryRecordId, MemoryRecord>() }
      : this.companionsFor(records)
    const activation = this.spreadActivation(lexicalNodes, fusedRecords, edges, nodeById)

    const lexicalNodePositions = rankPositions(lexicalNodes, node => node.id)
    const lexicalEdgePositions = rankPositions(lexicalEdges, edge => edge.id)
    const lexicalRecordPositions = rankPositions(lexicalRecords, record => record.id)
    const vectorPositions = rankPositions(vector.records, record => record.id)

    const cues: MemoryCue[] = []
    for (const node of nodes) {
      const lexicalPosition = lexicalNodePositions.get(node.id)
      const activated = activation.get(node.id) ?? 0
      if (lexicalPosition === undefined && activated === 0) continue
      const signals: MemorySignal[] = []
      if (lexicalPosition !== undefined) {
        signals.push({ kind: 'lexical', rank: lexicalPosition, value: lexicalNodes[lexicalPosition]?.score ?? 0 })
      }
      if (activated > 0) signals.push({ kind: 'graph', value: activated })
      signals.push({ kind: 'confidence', value: node.confidence })
      const base = rankScore(lexicalPosition)
      cues.push({
        kind: 'node',
        node,
        score: (base + activated) * (0.5 + 0.5 * node.confidence) * this.supportBoost(node.support),
        signals,
      })
    }
    for (const edge of edges) {
      const lexicalPosition = lexicalEdgePositions.get(edge.id)
      const endpointActivation = (activation.get(edge.from) ?? 0) + (activation.get(edge.to) ?? 0)
      if (lexicalPosition === undefined && endpointActivation === 0) continue
      const signals: MemorySignal[] = []
      if (lexicalPosition !== undefined) {
        signals.push({ kind: 'lexical', rank: lexicalPosition, value: lexicalEdges[lexicalPosition]?.score ?? 0 })
      }
      if (endpointActivation > 0) signals.push({ kind: 'graph', value: endpointActivation })
      signals.push({ kind: 'confidence', value: edge.confidence })
      const base = rankScore(lexicalPosition)
      const endpoints = [nodeById.get(edge.from), nodeById.get(edge.to)].filter(
        (node): node is MemoryNode => node !== undefined,
      )
      cues.push({
        kind: 'edge',
        edge,
        endpoints,
        score: (base + endpointActivation * this.config.activationFalloff)
          * (0.5 + 0.5 * edge.confidence) * this.supportBoost(edge.support),
        signals,
      })
    }
    for (const fused of fusedRecords) {
      const record = fused.item
      // Evidence-use records earned their place in the ranking and have already
      // fed activation above; what they must not do is come back as quoted text.
      // Skipping them here rather than at the candidate filter is deliberate:
      // dropping them earlier would also drop the graph signal they carry.
      if (record.use === 'evidence' && query.includeEvidence !== true) continue
      const signals: MemorySignal[] = []
      const lexicalPosition = lexicalRecordPositions.get(record.id)
      if (lexicalPosition !== undefined) {
        signals.push({ kind: 'lexical', rank: lexicalPosition, value: lexicalRecords[lexicalPosition]?.score ?? 0 })
      }
      const vectorPosition = vectorPositions.get(record.id)
      if (vectorPosition !== undefined) {
        signals.push({ kind: 'vector', rank: vectorPosition, value: vector.records[vectorPosition]?.score ?? 0 })
      }
      // Layer-0 records carry no belief, so recency stands in for confidence:
      // an old episode is not wrong, only less likely to be what was meant.
      const recency = decayedConfidence(1, this.config.inferredHalfLifeMs, record.createdAt, now)
      signals.push({ kind: 'recency', value: recency })
      // A corrected instruction ranks on relevance like any other: it is marked,
      // not demoted. Demoting it was measured and it cost more than it saved —
      // the message a correction overrides usually carries the data the
      // correction acts on ("track it in hours: 3.6, 3.5" -> "actually, in
      // minutes"), and a reader handed only the correction cannot apply it.
      const anchor = anchors.get(record.id)
      const confirmation = confirmations.get(record.id)
      cues.push({
        kind: 'record',
        record,
        ...(anchor === undefined ? {} : { anchor }),
        ...(confirmation === undefined ? {} : { confirmation }),
        score: fused.score * (0.5 + 0.5 * recency),
        signals,
      })
    }

    cues.sort((left, right) => right.score - left.score)
    const selected = this.diversify(cues, limit)
      .map(cue => this.safeCue(cue))
      .filter((cue): cue is MemoryCue => cue !== undefined)
    const cueRedactions: MemoryRedaction[] = []
    for (const cue of selected) {
      if (cue.safety !== undefined) mergeRedactions(cueRedactions, cue.safety.redactions)
    }
    const safetyRedactions = [...filteredQuery.metadata.redactions]
    mergeRedactions(safetyRedactions, cueRedactions)
    const semantic = vector.records.length > 0
    const recall: MemoryRecall = {
      query: queryText,
      cues: selected,
      truncated: cues.length > selected.length,
      semantic,
      mode: semantic ? 'semantic' : 'lexical',
      ...(safetyRedactions.length === 0 && !filteredQuery.metadata.blocked
        ? {}
        : {
          safety: {
            originalLength: filteredQuery.metadata.originalLength,
            retainedLength: filteredQuery.metadata.retainedLength,
            blocked: filteredQuery.metadata.blocked,
            redactions: safetyRedactions,
          },
        }),
      ...(vector.failure === undefined ? {} : { embeddingFailure: vector.failure }),
    }
    this.ctx.emit('memory/recalled', recall, { ...query, text: queryText })
    return recall
  }

  /**
   * The standing digest of a scope chain: the layer-1 beliefs worth stating
   * before any query exists. Ranked by decayed confidence weighted by how much
   * evidence stands behind the belief, so a strongly supported preference
   * outranks a single confident guess.
   * @param scopes - the scope chain to read, most specific first.
   * @param options - optional cap and clock reading.
   * @returns the digest.
   * @throws `no-store` when nothing is mounted.
   */
  profile(scopes: readonly MemoryScope[], options?: { limit?: number; now?: number }): MemoryProfile {
    const store = this.store
    const now = options?.now ?? Date.now()
    const limit = options?.limit ?? this.config.profileLimit
    const keys = scopeKeys(scopes)
    const ranked = [...store.nodes(keys)]
      .filter(node => node.status === 'active')
      .map(node => this.applyDecay(node, now))
      .sort((left, right) =>
        right.confidence * Math.log1p(right.support.observations + right.support.reinforcements)
        - left.confidence * Math.log1p(left.support.observations + left.support.reinforcements))
    const nodeRedactions: MemoryRedaction[] = []
    const nodes = ranked.slice(0, limit)
      .map(node => this.safeNodeView(node))
      .filter((view): view is { node: MemoryNode; blocked: boolean; redactions: MemoryRedaction[] } => !view.blocked)
      .map(view => {
        mergeRedactions(nodeRedactions, view.redactions)
        return view.node
      })
    const included = new Set(nodes.map(node => node.id))
    const edgeRedactions: MemoryRedaction[] = []
    const edges = [...store.edges(keys)]
      .filter(edge => edge.status === 'active' && included.has(edge.from) && included.has(edge.to))
      .map(edge => this.safeEdgeView(this.applyDecayEdge(edge, now)))
      .filter((view): view is { edge: MemoryEdge; blocked: boolean; redactions: MemoryRedaction[] } => !view.blocked)
      .map(view => {
        mergeRedactions(edgeRedactions, view.redactions)
        return view.edge
      })
    return {
      nodes,
      edges,
      total: ranked.length,
      ...(nodeRedactions.length === 0 && edgeRedactions.length === 0 ? {} : {
        safety: {
          originalLength: 0,
          retainedLength: 0,
          blocked: false,
          redactions: [...nodeRedactions, ...edgeRedactions],
        },
      }),
    }
  }

  /**
   * What this person is likely to want to pick up, from what memory holds.
   *
   * Ranked the same way the profile is — decayed confidence weighted by the
   * evidence behind it — but restricted to the node types that name work rather
   * than describe how it should be done. A surface with no query yet (a fresh
   * session, an empty composer) has nothing else to go on, and this is the one
   * derivation that turns a memory graph into an opening move.
   *
   * Deriving it here rather than in a UI is deliberate: the ranking, the decay,
   * and the choice of which types qualify are memory's judgments, and a second
   * surface reimplementing them would drift from this one.
   * @param scopes - the scope chain to read, most specific first.
   * @param options - optional cap and clock reading.
   * @returns suggestions, most worth offering first; empty when memory holds no work.
   */
  suggest(scopes: readonly MemoryScope[], options?: { limit?: number; now?: number }): MemorySuggestion[] {
    const now = options?.now ?? Date.now()
    const limit = options?.limit ?? this.config.profileLimit
    // Read the whole chain rather than the profile's top slice: a project can
    // sit below a dozen preferences in the profile and still be the only thing
    // here worth starting from.
    const kinds: Readonly<Record<string, MemorySuggestion['kind']>> = {
      project: 'project', routine: 'routine', procedure: 'procedure',
    }
    return [...this.store.nodes(scopeKeys(scopes))]
      .filter(node => node.status === 'active' && Object.hasOwn(kinds, node.type))
      .map(node => this.applyDecay(node, now))
      .filter(node => node.confidence >= this.config.retirementFloor)
      .sort((left, right) =>
        right.confidence * Math.log1p(right.support.observations + right.support.reinforcements)
        - left.confidence * Math.log1p(left.support.observations + left.support.reinforcements))
      .slice(0, limit)
      .map(node => this.safeNodeView(node))
      .filter((view): view is { node: MemoryNode; blocked: boolean; redactions: MemoryRedaction[] } => !view.blocked)
      .map(view => ({
        /* v8 ignore next -- the filter above admits only the three mapped types */
        kind: kinds[view.node.type] ?? 'project',
        subject: view.node.label,
        reason: view.node.summary,
        confidence: view.node.confidence,
        node: view.node,
      }))
  }

  /**
   * Raise the belief behind one layer-1 item and reset its decay clock.
   * @param ref - the node or edge to reinforce; a record reference is rejected.
   * @param at - epoch milliseconds of the supporting observation.
   * @returns resolution after the write lands.
   * @throws `unknown-item`, `retracted`, or `invalid-input` for a record reference.
   */
  async reinforce(ref: MemoryRef, at: number = Date.now()): Promise<void> {
    await this.adjust(ref, at, confidence => reinforcedConfidence(confidence, this.config.reinforcementRate), true)
  }

  /**
   * Lower the belief behind one layer-1 item after a contradicting observation.
   * @param ref - the node or edge to weaken; a record reference is rejected.
   * @param at - epoch milliseconds of the contradicting observation.
   * @returns resolution after the write lands.
   * @throws `unknown-item`, `retracted`, or `invalid-input` for a record reference.
   */
  async contradict(ref: MemoryRef, at: number = Date.now()): Promise<void> {
    await this.adjust(ref, at, confidence => weakenedConfidence(confidence, this.config.contradictionRate), false)
  }

  /**
   * Tombstone one item so it stops reaching recall while staying auditable.
   *
   * This is the safe half of forgetting. Use it when a belief turned out to be
   * wrong; use {@link MemoryRuntime.forget} when the underlying material itself
   * must be gone.
   * @param ref - the record, node, or edge to tombstone.
   * @returns resolution after the write lands.
   * @throws `unknown-item` when the id addresses nothing.
   */
  async retract(ref: MemoryRef): Promise<void> {
    const item = ref.kind === 'record' ? this.store.getRecord(ref.id)
      : ref.kind === 'node' ? this.store.getNode(ref.id) : this.store.getEdge(ref.id)
    if (!item) throw new MemoryError('unknown-item', `memory ${ref.kind} '${ref.id}' does not exist`)
    return this.serialize(item.scope, () => this.retractNow(ref))
  }

  private async retractNow(ref: MemoryRef): Promise<void> {
    const store = this.store
    if (ref.kind === 'record') {
      const record = store.getRecord(ref.id)
      if (record === undefined) throw new MemoryError('unknown-item', `memory record '${ref.id}' does not exist`)
      await store.putRecord({ ...record, status: 'retracted' })
      return
    }
    if (ref.kind === 'node') {
      const node = store.getNode(ref.id)
      if (node === undefined) throw new MemoryError('unknown-item', `memory node '${ref.id}' does not exist`)
      const next: MemoryNode = { ...node, status: 'retracted', updatedAt: Date.now() }
      await store.putNode(next)
      this.ctx.emit('memory/node-changed', next, node)
      return
    }
    const edge = store.getEdge(ref.id)
    if (edge === undefined) throw new MemoryError('unknown-item', `memory edge '${ref.id}' does not exist`)
    const next: MemoryEdge = { ...edge, status: 'retracted', updatedAt: Date.now() }
    await store.putEdge(next)
    this.ctx.emit('memory/edge-changed', next, edge)
  }

  /**
   * Mark one node replaced by another and record the supersession as an edge, so
   * the graph keeps why the belief changed rather than only what it changed to.
   * @param outdated - the node being replaced.
   * @param replacement - the node that replaces it.
   * @returns resolution after both writes land.
   * @throws `unknown-item` when either node does not exist.
   */
  async supersede(outdated: MemoryNode['id'], replacement: MemoryNode['id']): Promise<void> {
    const previous = this.store.getNode(outdated)
    if (!previous) throw new MemoryError('unknown-item', `memory node '${outdated}' does not exist`)
    return this.serialize(previous.scope, () => this.supersedeNow(outdated, replacement))
  }

  private async supersedeNow(outdated: MemoryNodeId, replacement: MemoryNodeId): Promise<void> {
    const store = this.store
    const previous = store.getNode(outdated)
    const next = store.getNode(replacement)
    if (previous === undefined || next === undefined) {
      throw new MemoryError('unknown-item', `memory supersession needs two existing nodes, got '${outdated}' and '${replacement}'`)
    }
    if (previous.scope !== next.scope) throw new MemoryError('invalid-input', 'memory supersession must remain in one scope')
    const at = Date.now()
    const tombstoned: MemoryNode = { ...previous, status: 'superseded', supersededBy: replacement, updatedAt: at }
    await store.putNode(tombstoned)
    this.ctx.emit('memory/node-changed', tombstoned, previous)
    await this.relateNow({
      scope: scopeOfKey(previous.scope),
      from: replacement,
      to: outdated,
      relation: 'supersedes',
      claim: `${next.label} replaces the earlier belief ${previous.label}`,
      origin: 'inferred',
      evidence: [...new Set([...previous.evidence, ...next.evidence])],
      at,
    })
  }

  /**
   * Replace one active belief with a new node identity.
   *
   * The target must be active and in the same scope, the evidence must be active
   * user-authored records containing the quote, and the new node is written
   * before the supersession edge and the target tombstone. A failed edge write
   * therefore leaves the old belief active and retryable; a retry uses the same
   * deterministic replacement id and completes the missing step instead of
   * creating a duplicate or retiring a node without an edge.
   * @param request - target, new belief, evidence and quote.
   * @returns the retired target, replacement node and supersession edge.
   * @throws `unknown-item`/`invalid-input`/`retracted` for an unusable target or evidence.
   */
  replace(request: MemoryReplacementRequest): Promise<MemoryReplacementResult> {
    return this.serialize(memoryScopeKey(request.scope), () => this.replaceNow(request))
  }

  private async replaceNow(request: MemoryReplacementRequest): Promise<MemoryReplacementResult> {
    const store = this.store
    const key = memoryScopeKey(request.scope)
    const at = request.at ?? Date.now()
    const rawLabel = request.label.trim()
    const rawSummary = request.summary.trim()
    const rawQuote = normalizedQuote(request.quote)
    if (rawLabel.length === 0 || rawSummary.length === 0 || rawQuote.length === 0) {
      throw new MemoryError('invalid-input', 'a memory replacement needs a non-empty label, summary and quote')
    }
    const redactions: MemoryRedaction[] = []
    const labelFiltered = this.filterWriteText(rawLabel)
    mergeRedactions(redactions, labelFiltered.metadata.redactions)
    const summaryFiltered = this.filterWriteText(rawSummary)
    mergeRedactions(redactions, summaryFiltered.metadata.redactions)
    const quoteFiltered = this.filterExternalText(rawQuote)
    if (REDACTION_PLACEHOLDER.test(rawQuote) || quoteFiltered.metadata.blocked || quoteFiltered.metadata.redactions.length > 0) {
      throw new MemoryError('invalid-input', 'memory replacement quote is not present in the cited evidence')
    }
    const attributesFiltered = this.filterWriteAttributes(request.attributes)
    mergeRedactions(redactions, attributesFiltered.redactions)
    const label = labelFiltered.text
    const summary = summaryFiltered.text
    const quote = rawQuote
    const safety: MemorySafetyMetadata | undefined = redactions.length === 0
      ? undefined
      : {
        originalLength: rawLabel.length + rawSummary.length + rawQuote.length,
        retainedLength: label.length + summary.length + quote.length,
        blocked: false,
        redactions,
      }
    const target = store.getNode(request.target)
    if (target === undefined) {
      throw new MemoryError('unknown-item', `memory replacement target '${request.target}' does not exist`)
    }
    if (target.scope !== key) {
      throw new MemoryError('invalid-input', 'memory replacement target must be in the request scope')
    }
    if (target.type !== request.type) {
      throw new MemoryError('invalid-input', 'memory replacement type must match the target')
    }
    const replacementId = replacementNodeId({
      ...request,
      label,
      summary,
      ...(attributesFiltered.attributes === undefined ? {} : { attributes: attributesFiltered.attributes }),
      quote,
    })
    if (target.status === 'retracted') {
      throw new MemoryError('retracted', `memory replacement target '${target.id}' is retracted`)
    }
    if (target.status === 'superseded' && target.supersededBy !== replacementId) {
      throw new MemoryError('invalid-input', 'memory replacement target is no longer active')
    }
    const evidenceIds = [...new Set(request.evidence)]
    if (evidenceIds.length === 0) {
      throw new MemoryError('invalid-input', 'a memory replacement needs at least one evidence record')
    }
    const evidence: MemoryRecord[] = []
    const evidenceText: string[] = []
    for (const id of evidenceIds) {
      const record = store.getRecord(id)
      if (record === undefined || record.status !== 'active' || record.scope !== key) {
        throw new MemoryError('invalid-input', `memory replacement evidence '${id}' must be an active record in the same scope`)
      }
      if (!userStatementRecord(record)) {
        throw new MemoryError('invalid-input', `memory replacement evidence '${id}' is not user-authored`)
      }
      const filtered = this.filterWriteText(record.text)
      evidence.push(record)
      evidenceText.push(normalizedQuote(filtered.text))
    }
    if (!evidenceText.some(text => text.includes(quote))) {
      throw new MemoryError('invalid-input', 'memory replacement quote is not present in the cited evidence')
    }

    let replacement = store.getNode(replacementId)
    if (replacement === undefined) {
      const sessions = new Set<string>()
      for (const record of evidence) {
        if (record.provenance.sessionId !== undefined) sessions.add(record.provenance.sessionId)
      }
      replacement = {
        id: replacementId,
        scope: key,
        type: request.type,
        label,
        summary,
        attributes: { ...(attributesFiltered.attributes ?? {}), quote },
        confidence: clampConfidence(request.confidence ?? this.confidenceFor(request.origin)),
        decay: this.decayFor(request.origin, request.halfLifeMs),
        support: initialSupport(at, evidence.length, sessions.size),
        evidence: evidenceIds,
        origin: request.origin,
        ...(safety === undefined ? {} : { safety }),
        status: 'active',
        createdAt: at,
        updatedAt: at,
      }
      await store.putNode(replacement)
      this.ctx.emit('memory/node-changed', replacement, undefined)
    } else if (replacement.status !== 'active') {
      throw new MemoryError('invalid-input', 'the replacement node is no longer active')
    }

    const claim = this.filterWriteText(
      request.claim?.trim() || (label + ' replaces the earlier belief ' + target.label),
    ).text
    const existing = this.findEdge(key, replacementId, target.id, 'supersedes')
    let edge = existing
    if (existing === undefined) {
      edge = await this.relateNow({
        scope: request.scope,
        from: replacementId,
        to: target.id,
        relation: 'supersedes',
        claim,
        origin: request.origin,
        confidence: replacement.confidence,
        evidence: evidenceIds,
        at,
      })
    } else if (evidenceIds.some(id => !existing.evidence.includes(id))) {
      const merged = mergeEvidence(existing.evidence, evidenceIds)
      edge = { ...existing, evidence: merged.evidence, updatedAt: at }
      await store.putEdge(edge)
      this.ctx.emit('memory/edge-changed', edge, existing)
    }

    if (target.status === 'active') {
      const retired: MemoryNode = {
        ...target,
        status: 'superseded',
        supersededBy: replacementId,
        updatedAt: at,
      }
      await store.putNode(retired)
      this.ctx.emit('memory/node-changed', retired, target)
    }
    return { replaced: target.id, replacement, edge: edge! }
  }

  /**
   * Erase a source record and every graph item derived from it.
   *
   * Unlike retraction this is irreversible, which is the point: it exists so a
   * user asking for material to be deleted gets deletion rather than a hidden
   * copy. Derived summaries, claims and connected edges are removed as well.
   * @param id - the record to erase.
   * @returns whether a record existed to erase.
   */
  async forget(id: MemoryRecord['id']): Promise<boolean> {
    const record = this.store.getRecord(id)
    if (record === undefined) return false
    return this.serialize(record.scope, async () => {
      if (!this.store.getRecord(id)) return false
      await this.eraseClosure(record.scope, new Set([id]), new Set())
      return true
    })
  }

  /** Erase a belief, its supporting material and incident claims, including legacy uncited beliefs. */
  async forgetNode(id: MemoryNodeId): Promise<number> {
    const node = this.store.getNode(id)
    if (!node) return 0
    return this.serialize(node.scope, () => {
      const current = this.store.getNode(id)
      return current ? this.eraseClosure(current.scope, new Set(current.evidence), new Set([id])) : Promise.resolve(0)
    })
  }

  private async eraseClosure(scope: MemoryScopeKey, records: Set<MemoryRecordId>, nodes: Set<MemoryNodeId>): Promise<number> {
    const store = this.store
    const nodeRows = [...store.nodes([scope])]
    // Earlier releases stored supersession edges in user scope even when both
    // endpoints belonged to a workspace. Include that partition for erasure.
    const edgeRows = [...store.edges([...new Set([scope, memoryScopeKey({ kind: 'user' })])])]
    const edges = new Set<MemoryEdgeId>()
    // A generated assertion ledger can repeat the erased material. Follow these
    // records too, while retaining independently authored source records.
    const addLedgers = (ids: readonly MemoryRecordId[]): void => {
      for (const id of ids) {
        const record = store.getRecord(id)
        if (record?.kind === 'note' && record.use === 'evidence'
          && (record.provenance.author === 'agent' || record.provenance.author === 'api')) records.add(id)
      }
    }
    let previous = -1
    while (previous !== records.size + nodes.size + edges.size) {
      previous = records.size + nodes.size + edges.size
      for (const node of nodeRows) {
        if (!nodes.has(node.id) && !node.evidence.some(id => records.has(id))) continue
        nodes.add(node.id); addLedgers(node.evidence)
      }
      for (const edge of edgeRows) {
        if (!edges.has(edge.id) && !nodes.has(edge.from) && !nodes.has(edge.to)
          && !edge.evidence.some(id => records.has(id))) continue
        edges.add(edge.id); addLedgers(edge.evidence)
      }
    }
    for (const id of records) {
      const record = store.getRecord(id)
      if (record) await this.ctx.parallel('memory/before-forget', record)
    }
    for (const id of edges) await store.eraseEdge(id)
    for (const id of nodes) await store.eraseNode(id)
    let erased = 0
    for (const id of records) if (await store.eraseRecord(id)) erased++
    const removed = new Set<string>([...records, ...nodes, ...edges])
    for (const record of store.records([scope])) {
      const promotedTo = record.promotedTo.filter(id => !removed.has(id))
      if (promotedTo.length !== record.promotedTo.length || (record.supersededBy && records.has(record.supersededBy))) {
        const { supersededBy, ...rest } = record
        await store.putRecord({ ...rest, promotedTo, ...(supersededBy && !records.has(supersededBy) ? { supersededBy } : {}) })
      }
    }
    for (const node of store.nodes([scope])) {
      if (node.supersededBy && nodes.has(node.supersededBy)) {
        const { supersededBy: _removed, ...rest } = node
        await store.putNode(rest)
      }
    }
    return erased
  }

  /**
   * Run every mounted distiller over the records each one has not successfully
   * inspected in this scope, and merge their proposals into the graph.
   *
   * Distillers that declare a {@link MemoryDistiller.progress} policy get durable
   * per-record progress keyed by distiller version. A successful empty result
   * advances progress without inventing a citation; a failed or cancelled pass
   * leaves the records pending, bounded by the policy's attempt count. Window
   * mode reads bounded prior context but advances only the new records, so a
   * behavior seen across several turns still reaches its repeat threshold.
   *
   * Legacy distillers without a progress policy keep the old
   * `promotedTo.length === 0` pending rule. Candidate application is idempotent:
   * re-applying a proposal whose evidence is already cited does not reinforce it
   * twice, which makes a retry after a partial write safe.
   *
   * Concurrent calls for one scope join the in-flight pass. The first call owns
   * its `signal` and `onDiagnostic`; later joiners share that pass's cancellation
   * and result and cannot cancel it independently.
   * @param scope - the partition to consolidate.
   * @param options - optional clock, cancellation and a diagnostic callback.
   * @returns what the pass changed.
   * @throws `no-store` when nothing is mounted, or a distiller/apply/persistence error.
   */
  async consolidate(
    scope: MemoryScope,
    options?: {
      now?: number
      signal?: AbortSignal
      route?: MemoryModelRoute
      sessionId?: string
      onDiagnostic?: (diagnostic: MemoryConsolidationDiagnostic) => void
    },
  ): Promise<MemoryMaintenanceReport> {
    const key = memoryScopeKey(scope)
    const running = this.consolidations.get(key)
    if (running !== undefined) return running
    const run = this.consolidateNow(scope, options)
    this.consolidations.set(key, run)
    const done = (): void => { if (this.consolidations.get(key) === run) this.consolidations.delete(key) }
    void run.then(done, done)
    return run
  }

  private async consolidateNow(
    scope: MemoryScope,
    options?: {
      now?: number
      signal?: AbortSignal
      route?: MemoryModelRoute
      sessionId?: string
      onDiagnostic?: (diagnostic: MemoryConsolidationDiagnostic) => void
    },
  ): Promise<MemoryMaintenanceReport> {
    const store = this.store
    const key = memoryScopeKey(scope)
    const at = options?.now ?? Date.now()
    throwIfAborted(options?.signal)
    let nodesCreated = 0
    let nodesReinforced = 0
    let edgesCreated = 0
    let edgesReinforced = 0
    let replaced = 0
    const empty = (): MemoryMaintenanceReport => ({
      examined: 0,
      nodesCreated,
      nodesReinforced,
      edgesCreated,
      edgesReinforced,
      replaced,
      retired: 0,
      evicted: 0,
    })
    const distillers = [...this.distillerProviders].sort((left, right) => left.rank - right.rank)
    const records = [...store.records([key])]
      .filter(record => record.status === 'active')
      .sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id))
    if (distillers.length === 0 || records.length === 0) return empty()

    const progressStore = store.progressStore
    const examined = new Set<string>()
    for (const distiller of distillers) {
      throwIfAborted(options?.signal)
      const version = distillerVersion(distiller, options?.route)
      const policy = distiller.progress
      const accepted = distiller.accepts === undefined
        ? records
        : records.filter(record => distiller.accepts!(record, {
          ...(options?.sessionId === undefined ? {} : { sessionId: options.sessionId }),
        }))
      let previous = new Map<MemoryRecordId, MemoryDistillerProgress>()
      if (progressStore !== undefined && policy !== undefined) {
        previous = new Map(
          [...progressStore.progress([key])]
            .filter(row => row.distiller === distiller.name && row.version === version)
            .map(row => [row.record, row]),
        )
      }

      let pending: MemoryRecord[]
      if (progressStore !== undefined && policy !== undefined) {
        validateProgressPolicy(policy, distiller.name)
        pending = accepted.filter((record) => {
          const row = previous.get(record.id)
          return row === undefined || (row.status === 'failed' && row.attempts < policy.maxAttempts)
        })
      } else {
        pending = accepted.filter(record => record.promotedTo.length === 0)
      }
      if (pending.length === 0) continue
      for (const record of pending) examined.add(record.id)

      const window = policy?.mode === 'window'
        ? windowWithLookback(records, pending, policy.lookback)
        : pending
      const started = Date.now()
      const cited = new Set<string>()
      let advanced = 0
      let failed = 0
      let skipped = 0
      let usage: MemoryDistillationUsage | undefined
      let outcome: {
        consumed: ReadonlySet<MemoryRecordId>
        skipped: ReadonlyMap<MemoryRecordId, MemoryDistillationSkipReason>
        failed: ReadonlyMap<MemoryRecordId, MemoryDistillationFailureReason>
      } | undefined
      try {
        throwIfAborted(options?.signal)
        const existing = [...store.nodes([key])].filter(node => node.status === 'active')
        const distillation = await distiller.distill({
          scope: key,
          records: window,
          existing,
          ...(options?.route === undefined ? {} : { route: options.route }),
          ...(options?.sessionId === undefined ? {} : { sessionId: options.sessionId }),
          ...options?.signal === undefined ? {} : { signal: options.signal },
        })
        throwIfAborted(options?.signal)
        const windowIds = new Set(window.map(record => record.id))
        const pendingIds = new Set(pending.map(record => record.id))
        const skippedRows = new Map<MemoryRecordId, MemoryDistillationSkipReason>()
        for (const row of distillation.skipped ?? []) {
          if (!windowIds.has(row.record)) {
            throw new MemoryError('invalid-input', 'distiller skipped a record outside its input window')
          }
          skippedRows.set(row.record, row.reason)
        }
        const failedRows = new Map<MemoryRecordId, MemoryDistillationFailureReason>()
        for (const row of distillation.failed ?? []) {
          if (!windowIds.has(row.record)) {
            throw new MemoryError('invalid-input', 'distiller failed a record outside its input window')
          }
          failedRows.set(row.record, row.reason)
        }
        for (const id of skippedRows.keys()) {
          if (!pendingIds.has(id)) throw new MemoryError('invalid-input', 'distiller skipped a non-pending record')
        }
        for (const id of failedRows.keys()) {
          if (!pendingIds.has(id)) throw new MemoryError('invalid-input', 'distiller failed a non-pending record')
        }
        const consumed = new Set(distillation.consumedRecordIds ?? [...pendingIds].filter(
          id => !skippedRows.has(id) && !failedRows.has(id),
        ))
        for (const id of consumed) {
          if (!windowIds.has(id)) throw new MemoryError('invalid-input', 'distiller consumed a record outside its input window')
          if (skippedRows.has(id) || failedRows.has(id)) {
            throw new MemoryError('invalid-input', 'distiller consumed a record it also skipped or failed')
          }
        }
        outcome = { consumed, skipped: skippedRows, failed: failedRows }
        usage = distillation.usage
        const byLabel = new Map<string, MemoryNode>()
        for (const candidate of distillation.nodes) {
          throwIfAborted(options?.signal)
          const merged = await this.mergeCandidateNode(scope, candidate, at)
          byLabel.set(candidate.label, merged.node)
          if (merged.created) nodesCreated++
          else if (merged.changed) nodesReinforced++
          for (const evidence of candidate.evidence) cited.add(evidence)
        }
        for (const candidate of distillation.edges) {
          throwIfAborted(options?.signal)
          const merged = await this.mergeCandidateEdge(scope, candidate, byLabel, key, at)
          if (merged === undefined) continue
          if (merged.created) edgesCreated++
          else if (merged.changed) edgesReinforced++
          for (const evidence of candidate.evidence) cited.add(evidence)
        }
        for (const replacement of distillation.replacements ?? []) {
          throwIfAborted(options?.signal)
          await this.replace({
            scope,
            target: replacement.target,
            type: replacement.type,
            label: replacement.label,
            summary: replacement.summary,
            ...(replacement.attributes === undefined ? {} : { attributes: replacement.attributes }),
            origin: replacement.origin,
            confidence: replacement.confidence,
            evidence: replacement.evidence,
            quote: replacement.quote,
            at,
          })
          replaced++
        }
        throwIfAborted(options?.signal)
      } catch (error) {
        if (progressStore !== undefined && policy !== undefined && !options?.signal?.aborted) {
          failed = await this.failProgress(key, distiller, version, pending, previous, at)
        }
        this.emitConsolidationDiagnostic(options, {
          scope: key,
          distiller: distiller.name,
          version,
          mode: policy?.mode ?? 'record',
          pending: pending.length,
          window: window.length,
          advanced: 0,
          failed,
          skipped: 0,
          durationMs: Date.now() - started,
        })
        throw error
      }

      // Progress writes happen outside the failure catch: a persistence failure
      // after some rows were written must not turn those already-consumed rows
      // back into bounded failures and rescan them forever.
      throwIfAborted(options?.signal)
      if (progressStore !== undefined && policy !== undefined) {
        const progress = await this.advanceProgress(
          key, distiller, version, pending, previous, cited, at, options?.signal, outcome,
        )
        advanced = progress.advanced
        failed = progress.failed
        skipped = progress.skipped
      } else {
        if ((outcome?.failed.size ?? 0) > 0) {
          throw new MemoryError('invalid-input', 'distiller failure requires a progress-capable store')
        }
        await this.markPromoted(key, cited)
      }

      this.emitConsolidationDiagnostic(options, {
        scope: key,
        distiller: distiller.name,
        version,
        mode: policy?.mode ?? 'record',
        pending: pending.length,
        window: window.length,
        advanced,
        failed,
        skipped,
        ...(usage === undefined ? {} : { usage }),
        durationMs: Date.now() - started,
      })
    }
    return {
      examined: examined.size,
      nodesCreated,
      nodesReinforced,
      edgesCreated,
      edgesReinforced,
      replaced,
      retired: 0,
      evicted: 0,
    }
  }

  /** Emit a diagnostic without letting an observer break a maintenance pass. */
  private emitConsolidationDiagnostic(
    options: { onDiagnostic?: (diagnostic: MemoryConsolidationDiagnostic) => void } | undefined,
    diagnostic: MemoryConsolidationDiagnostic,
  ): void {
    try {
      options?.onDiagnostic?.(diagnostic)
    } catch {
      // Diagnostics are observational; a failing callback must not change memory.
    }
  }

  /**
   * Write success progress and promotion citations under the scope lock. Only
   * pending records advance; lookback records may gain a citation but are not
   * consumed again.
   */
  private async advanceProgress(
    key: MemoryScopeKey,
    distiller: MemoryDistiller,
    version: string,
    pending: readonly MemoryRecord[],
    previous: ReadonlyMap<MemoryRecordId, MemoryDistillerProgress>,
    cited: ReadonlySet<string>,
    at: number,
    signal?: AbortSignal,
    outcome?: {
      readonly consumed: ReadonlySet<MemoryRecordId>
      readonly skipped: ReadonlyMap<MemoryRecordId, MemoryDistillationSkipReason>
      readonly failed: ReadonlyMap<MemoryRecordId, MemoryDistillationFailureReason>
    },
  ): Promise<{ advanced: number; failed: number; skipped: number }> {
    const progressStore = this.store.progressStore
    if (progressStore === undefined) return { advanced: 0, failed: 0, skipped: 0 }
    return this.serialize(key, async () => {
      let advanced = 0
      let failed = 0
      let skipped = 0
      for (const record of pending) {
        throwIfAborted(signal)
        const current = this.store.getRecord(record.id)
        if (current === undefined || current.status !== 'active') continue
        const skipReason = outcome?.skipped.get(record.id)
        const failureReason = outcome?.failed.get(record.id)
        if (skipReason !== undefined) {
          await progressStore.putProgress({
            id: progressId(key, distiller.name, version, record.id),
            scope: key,
            distiller: distiller.name,
            version,
            record: record.id,
            status: 'skipped',
            skipReason,
            attempts: (previous.get(record.id)?.attempts ?? 0) + 1,
            updatedAt: at,
          })
          skipped++
          continue
        }
        if (failureReason !== undefined) {
          await progressStore.putProgress({
            id: progressId(key, distiller.name, version, record.id),
            scope: key,
            distiller: distiller.name,
            version,
            record: record.id,
            status: 'failed',
            attempts: (previous.get(record.id)?.attempts ?? 0) + 1,
            updatedAt: at,
          })
          failed++
          continue
        }
        if (outcome !== undefined && !outcome.consumed.has(record.id)) continue
        await progressStore.putProgress({
          id: progressId(key, distiller.name, version, record.id),
          scope: key,
          distiller: distiller.name,
          version,
          record: record.id,
          status: cited.has(record.id) ? 'proposed' : 'empty',
          attempts: (previous.get(record.id)?.attempts ?? 0) + 1,
          updatedAt: at,
        })
        advanced++
      }
      throwIfAborted(signal)
      for (const id of cited) {
        const current = this.store.getRecord(MemoryRecordId(id))
        if (current === undefined || current.status !== 'active') continue
        if (current.promotedTo.includes('consolidated')) continue
        await this.store.putRecord({ ...current, promotedTo: [...current.promotedTo, 'consolidated'] })
      }
      return { advanced, failed, skipped }
    })
  }

  /** Mark cited records for audit without treating an empty check as a citation. */
  private async markPromoted(key: MemoryScopeKey, cited: ReadonlySet<string>): Promise<void> {
    if (cited.size === 0) return
    await this.serialize(key, async () => {
      for (const id of cited) {
        const current = this.store.getRecord(MemoryRecordId(id))
        if (current === undefined || current.status !== 'active') continue
        if (current.promotedTo.includes('consolidated')) continue
        await this.store.putRecord({ ...current, promotedTo: [...current.promotedTo, 'consolidated'] })
      }
    })
  }

  /**
   * Record a bounded failure for each pending record. A later pass retries only
   * while attempts remain below the distiller policy's bound.
   */
  private async failProgress(
    key: MemoryScopeKey,
    distiller: MemoryDistiller,
    version: string,
    pending: readonly MemoryRecord[],
    previous: ReadonlyMap<MemoryRecordId, MemoryDistillerProgress>,
    at: number,
  ): Promise<number> {
    const progressStore = this.store.progressStore
    if (progressStore === undefined) return 0
    return this.serialize(key, async () => {
      let failed = 0
      for (const record of pending) {
        const current = this.store.getRecord(record.id)
        if (current === undefined || current.status !== 'active') continue
        const prior = previous.get(record.id)
        await progressStore.putProgress({
          id: progressId(key, distiller.name, version, record.id),
          scope: key,
          distiller: distiller.name,
          version,
          record: record.id,
          status: 'failed',
          attempts: (prior?.status === 'failed' ? prior.attempts : 0) + 1,
          updatedAt: at,
        })
        failed++
      }
      return failed
    })
  }

  /**
   * Retire faded beliefs and evict overflowing raw material.
   *
   * This is what keeps a memory usable over months rather than merely large. An
   * inferred belief whose decayed confidence has fallen below the retirement
   * floor is tombstoned; asserted beliefs are never retired, because the user
   * said them and only the user unsays them. Layer-0 records beyond the scope's
   * budget are erased oldest-first, but only when nothing cites them, so erasing
   * raw material can never orphan a conclusion.
   * @param scopes - the scope chain to sweep.
   * @param now - clock reading for decay.
   * @returns what the sweep changed.
   * @throws `no-store` when nothing is mounted.
   */
  async sweep(scopes: readonly MemoryScope[], now: number = Date.now()): Promise<MemoryMaintenanceReport> {
    const report: MemoryMaintenanceReport = {
      examined: 0, nodesCreated: 0, nodesReinforced: 0, edgesCreated: 0, edgesReinforced: 0, retired: 0, evicted: 0,
    }
    let retired = 0
    let evicted = 0
    for (const key of scopeKeys(scopes)) {
      const result = await this.serialize(key, () => this.sweepScope(key, now))
      retired += result.retired; evicted += result.evicted
    }
    return { ...report, retired, evicted }
  }

  private async sweepScope(key: MemoryScopeKey, now: number): Promise<MemoryMaintenanceReport> {
    const store = this.store
    const keys = [key]
    let retired = 0
    for (const node of [...store.nodes(keys)]) {
      if (node.status !== 'active' || node.origin === 'asserted') continue
      if (decayedConfidence(node.confidence, node.decay.halfLifeMs, node.support.lastSeenAt, now) >= this.config.retirementFloor) continue
      const next: MemoryNode = { ...node, status: 'superseded', updatedAt: now }
      await store.putNode(next)
      this.ctx.emit('memory/node-changed', next, node)
      retired++
    }
    for (const edge of [...store.edges(keys)]) {
      if (edge.status !== 'active' || edge.origin === 'asserted') continue
      if (decayedConfidence(edge.confidence, edge.decay.halfLifeMs, edge.support.lastSeenAt, now) >= this.config.retirementFloor) continue
      const next: MemoryEdge = { ...edge, status: 'superseded', updatedAt: now }
      await store.putEdge(next)
      this.ctx.emit('memory/edge-changed', next, edge)
      retired++
    }
    let evicted = 0
    for (const key of keys) {
      const records = [...store.records([key])].sort((left, right) => left.createdAt - right.createdAt)
      const overflow = records.length - this.config.recordBudget
      if (overflow <= 0) continue
      const protectedIds = new Set<string>()
      for (const node of store.nodes([key])) for (const id of node.evidence) protectedIds.add(id)
      for (const edge of store.edges([key])) for (const id of edge.evidence) protectedIds.add(id)
      for (const record of records) {
        if (evicted >= overflow) break
        if (protectedIds.has(record.id)) continue
        if (await store.eraseRecord(record.id)) evicted++
      }
    }
    return {
      examined: 0,
      nodesCreated: 0,
      nodesReinforced: 0,
      edgesCreated: 0,
      edgesReinforced: 0,
      retired,
      evicted,
    }
  }

  /** Resolve the initial belief for an origin. */
  private confidenceFor(origin: MemoryOrigin): number {
    return origin === 'asserted' ? this.config.assertedConfidence : this.config.inferredConfidence
  }

  /** Resolve the erosion policy for an origin, honoring an explicit override. */
  private decayFor(origin: MemoryOrigin, halfLifeMs: number | null | undefined): MemoryDecay {
    if (halfLifeMs !== undefined) return { halfLifeMs }
    if (origin !== 'asserted') return { halfLifeMs: this.config.inferredHalfLifeMs }
    // Zero is the configured way to say "never erodes"; the durable
    // representation states that as null so a reader needs no threshold rule.
    return { halfLifeMs: this.config.assertedHalfLifeMs > 0 ? this.config.assertedHalfLifeMs : null }
  }

  /** Project a node's stored belief through its decay law. */
  private applyDecay(node: MemoryNode, now: number): MemoryNode {
    return {
      ...node,
      confidence: decayedConfidence(node.confidence, node.decay.halfLifeMs, node.support.lastSeenAt, now),
    }
  }

  /** Project an edge's stored belief through its decay law. */
  private applyDecayEdge(edge: MemoryEdge, now: number): MemoryEdge {
    return {
      ...edge,
      confidence: decayedConfidence(edge.confidence, edge.decay.halfLifeMs, edge.support.lastSeenAt, now),
    }
  }

  /** The active node addressed by a scope, type, and label, when one exists. */
  /**
   * How much a belief's accumulated support lifts it in recall.
   *
   * Logarithmic, so a belief seen twice gains most of what it will ever gain and
   * a belief seen two hundred times cannot bury everything else. Reinforcements
   * count alongside observations because a preference restated in a new session
   * is new evidence, not a duplicate of the old.
   * @param support - the item's accumulated support.
   * @returns a multiplier at or above 1.
   */
  private supportBoost(support: MemorySupport): number {
    if (this.config.supportWeight <= 0) return 1
    return 1 + this.config.supportWeight * Math.log1p(support.observations + support.reinforcements)
  }

  /**
   * Take the highest-scoring cues, skipping any that restate one already taken.
   *
   * Ranking alone answers "what is most relevant" and never "what does this turn
   * still not know". With a budget of eight cues those come apart badly: a scope
   * holding a cluster of near-identical beliefs spends the whole budget on the
   * cluster and returns nothing else, which is how a graph of tool habits once
   * filled every slot with restatements of one fact. Comparing each candidate
   * against what is already selected costs O(limit²) on a limit of ten.
   *
   * Redundant cues are skipped rather than truncating the list, so the budget
   * fills with distinct material instead of being spent short.
   * @param cues - all qualifying cues, already in descending score order.
   * @param limit - how many to return.
   * @returns the selected cues, still in score order.
   */
  /**
   * Pair each quotable record with the evidence turns that give it its meaning.
   *
   * Two pairings, both within one session and both one turn apart:
   *
   *   anchor        the assistant turn *before* a reply that cannot stand alone
   *                 — a question, or anything a user answered in under a dozen
   *                 terms. "1 to 3, yes" needs "so values run 1 to 3 from now on?".
   *   confirmation  the assistant turn *after* an instruction, when it is short,
   *                 is not a question, and the user's next turn did not correct
   *                 it. "Understood - converting to minutes, header 'Duration
   *                 (min)'" restates the instruction more plainly than the
   *                 instruction did, and the user's silence ratified it.
   *
   * Neither turn is ever a cue on its own: that is the self-quotation the use
   * split exists to prevent. Attached to the user's words they are context,
   * not claims.
   * @param records - the candidate records of this recall.
   * @returns the companions of each record that has any, by record id.
   */
  private companionsFor(records: readonly MemoryRecord[]): {
    anchors: Map<MemoryRecordId, MemoryRecord>
    confirmations: Map<MemoryRecordId, MemoryRecord>
  } {
    const bySession = new Map<string, Map<number, MemoryRecord>>()
    for (const record of records) {
      const { sessionId, turn } = record.provenance
      if (sessionId === undefined || turn === undefined) continue
      let turns = bySession.get(sessionId)
      if (turns === undefined) {
        turns = new Map()
        bySession.set(sessionId, turns)
      }
      turns.set(turn, record)
    }
    const anchors = new Map<MemoryRecordId, MemoryRecord>()
    const confirmations = new Map<MemoryRecordId, MemoryRecord>()
    for (const record of records) {
      if (record.use !== 'recallable') continue
      const { sessionId, turn } = record.provenance
      if (sessionId === undefined || turn === undefined) continue
      const turns = bySession.get(sessionId)
      const previous = turns?.get(turn - 1)
      if (previous !== undefined && previous.use === 'evidence'
        && (previous.text.trimEnd().endsWith('?') || record.terms.length < 12)) {
        anchors.set(record.id, previous)
      }
      const next = turns?.get(turn + 1)
      const afterNext = turns?.get(turn + 2)
      if (next !== undefined && next.use === 'evidence' && next.terms.length <= 30
        && !next.text.trimEnd().endsWith('?')
        && (afterNext === undefined || !isCorrection(afterNext.text))) {
        confirmations.set(record.id, next)
      }
    }
    return { anchors, confirmations }
  }

  private diversify(cues: readonly MemoryCue[], limit: number): MemoryCue[] {
    if (this.config.diversityThreshold >= 1) return cues.slice(0, limit)
    const selected: MemoryCue[] = []
    const texts: string[] = []
    for (const cue of cues) {
      if (selected.length >= limit) break
      const text = cueText(cue)
      if (texts.some(taken => similarity(taken, text) >= this.config.diversityThreshold)) continue
      selected.push(cue)
      texts.push(text)
    }
    return selected
  }

  /**
   * An active node of the same type whose label restates the candidate's.
   *
   * Distillation only; see {@link Config.duplicateThreshold}. The best match
   * wins rather than the first, so a scope holding several near-duplicates
   * converges on one rather than oscillating between them.
   * @param scope - the partition to search.
   * @param type - the candidate's subject class; a preference never merges into a constraint.
   * @param label - the candidate's label.
   * @returns the node to merge into, or `undefined` when the candidate is new.
   */
  private findSimilarNode(
    scope: MemoryScopeKey,
    type: MemoryNode['type'],
    label: string,
  ): MemoryNode | undefined {
    if (this.config.duplicateThreshold >= 1) return undefined
    let best: MemoryNode | undefined
    let bestScore = this.config.duplicateThreshold
    for (const node of this.store.nodes([scope])) {
      if (node.status !== 'active' || node.type !== type) continue
      const score = similarity(node.label, label)
      if (score < bestScore) continue
      best = node
      bestScore = score
    }
    return best
  }

  private findNode(scope: MemoryScopeKey, type: MemoryNode['type'], label: string): MemoryNode | undefined {
    for (const node of this.store.nodes([scope])) {
      if (node.status === 'active' && node.type === type && node.label === label) return node
    }
    return undefined
  }

  /** The active edge addressed by a scope, endpoint pair, and relation, when one exists. */
  private findEdge(
    scope: MemoryScopeKey,
    from: MemoryNode['id'],
    to: MemoryNode['id'],
    relation: MemoryEdge['relation'],
  ): MemoryEdge | undefined {
    for (const edge of this.store.edges([scope])) {
      if (edge.status === 'active' && edge.from === from && edge.to === to && edge.relation === relation) return edge
    }
    return undefined
  }

  /**
   * Rank records by cosine similarity against the query embedding, when an
   * embedder is mounted and the vector signal is actually weighted.
   *
   * Provider failures are returned as diagnostics rather than thrown: query-time
   * SDK unavailability degrades this path to lexical retrieval, while capture
   * records remain durable. Cancellation still propagates.
   */
  private async vectorRank(
    query: MemoryQuery,
    records: readonly MemoryRecord[],
  ): Promise<{
    records: ScoredItem<MemoryRecord>[]
    failure?: MemoryRecall['embeddingFailure']
  }> {
    const embedder = this.embedderProvider
    if (
      embedder === undefined
      || this.config.vectorWeight <= 0
      || query.text.trim().length === 0
    ) return { records: [] }
    if (embedder.unavailable !== undefined) {
      const code = isEmbedderFailureCode(embedder.unavailable.code) ? embedder.unavailable.code : 'sdk-failure'
      return {
        records: [],
        failure: { provider: embedder.name, code, reason: MEMORY_EMBEDDER_FAILURE_REASONS[code] },
      }
    }
    const comparable = records.filter(record =>
      record.embedding !== undefined
      && record.embedding.model === embedder.name
      && record.embedding.dimensions === embedder.dimensions
      && usableVector(record.embedding.vector, record.embedding.dimensions))
    if (comparable.length === 0) return { records: [] }
    try {
      const embedded = await embedder.embed(
        [query.text],
        query.signal === undefined ? undefined : { signal: query.signal },
      )
      const vector = embedded[0]
      if (vector === undefined) {
        return {
          records: [],
          failure: {
            provider: embedder.name,
            code: 'sdk-failure',
            reason: MEMORY_EMBEDDER_FAILURE_REASONS['sdk-failure'],
          },
        }
      }
      if (!usableVector(vector, embedder.dimensions)) {
        return {
          records: [],
          failure: {
            provider: embedder.name,
            code: 'invalid-payload',
            reason: MEMORY_EMBEDDER_FAILURE_REASONS['invalid-payload'],
          },
        }
      }
      const ranked: ScoredItem<MemoryRecord>[] = []
      for (const record of comparable) {
        const stored = record.embedding
        if (stored === undefined) continue
        const score = cosineSimilarity([...vector], stored.vector)
        if (score > 0) ranked.push({ item: record, score })
      }
      ranked.sort((left, right) => right.score - left.score)
      return { records: ranked }
    } catch (error) {
      if (query.signal?.aborted) throw error
      return { records: [], failure: { provider: embedder.name, ...embedderFailureFrom(error) } }
    }
  }

  /**
   * Spread activation from directly matched nodes and from the nodes cited by
   * top-ranked records, so a query that only matches raw material still surfaces
   * the conclusions drawn from it.
   */
  private spreadActivation(
    lexicalNodes: readonly ScoredItem<MemoryNode>[],
    fusedRecords: readonly ScoredItem<MemoryRecord>[],
    edges: readonly MemoryEdge[],
    nodeById: ReadonlyMap<MemoryNode['id'], MemoryNode>,
  ): Map<MemoryNode['id'], number> {
    const activation = new Map<MemoryNode['id'], number>()
    const seed = (id: MemoryNode['id'], weight: number): void => {
      if (!nodeById.has(id)) return
      activation.set(id, (activation.get(id) ?? 0) + weight)
    }
    for (let index = 0; index < lexicalNodes.length; index++) {
      const entry = lexicalNodes[index]
      // The same transform the cue scores use, so activation arriving at a node
      // is commensurate with the lexical evidence for it rather than sixty times
      // larger than the best episode in the scope.
      if (entry !== undefined) seed(entry.item.id, rankScore(index))
    }
    const citedRecords = new Set(fusedRecords.slice(0, 10).map(entry => entry.item.id))
    for (const node of nodeById.values()) {
      // A belief whose evidence was retrieved is activated as strongly as a
      // belief matched at the top of the lexical ranking, damped by one hop.
      if (node.evidence.some(id => citedRecords.has(id))) {
        seed(node.id, rankScore(0) * this.config.activationFalloff)
      }
    }
    let frontier = new Map(activation)
    for (let hop = 0; hop < this.config.activationHops; hop++) {
      const next = new Map<MemoryNode['id'], number>()
      for (const edge of edges) {
        for (const [source, target] of [[edge.from, edge.to], [edge.to, edge.from]] as const) {
          const weight = frontier.get(source)
          if (weight === undefined || weight === 0) continue
          const spread = weight * this.config.activationFalloff * edge.confidence
          if (spread <= 0) continue
          next.set(target, (next.get(target) ?? 0) + spread)
        }
      }
      if (next.size === 0) break
      for (const [id, weight] of next) activation.set(id, (activation.get(id) ?? 0) + weight)
      frontier = next
    }
    return activation
  }

  /** Merge one proposed node into the graph, reporting whether it was created. */
  private async mergeCandidateNode(
    scope: MemoryScope,
    candidate: MemoryCandidateNode,
    at: number,
  ): Promise<{ node: MemoryNode; created: boolean; changed: boolean }> {
    if (candidate.evidence.length === 0) {
      throw new MemoryError('invalid-input', `distilled node '${candidate.label}' cites no evidence`)
    }
    const key = memoryScopeKey(scope)
    const label = candidate.label.trim()
    // Exact first, then near-duplicate: a candidate restating a belief the scope
    // already holds reinforces it under the label it already has, so the graph
    // accumulates support rather than synonyms.
    const exact = this.findNode(key, candidate.type, label)
    const similar = candidate.merge === 'exact'
      ? exact
      : exact ?? this.findSimilarNode(key, candidate.type, label)
    if (similar !== undefined && candidate.evidence.every(id => similar.evidence.includes(id))) {
      // Re-applying the same proposal after a partial pass must not add another
      // reinforcement. A version bump is the explicit way to re-derive it.
      return { node: similar, created: false, changed: false }
    }
    const node = await this.assert({
      scope,
      type: candidate.type,
      label: similar?.label ?? candidate.label,
      summary: candidate.summary,
      origin: 'inferred',
      confidence: candidate.confidence,
      evidence: candidate.evidence,
      at,
      ...candidate.attributes === undefined ? {} : { attributes: candidate.attributes },
    })
    return { node, created: similar === undefined, changed: true }
  }

  /** Merge one proposed edge, resolving endpoints by label first among this pass's nodes. */
  private async mergeCandidateEdge(
    scope: MemoryScope,
    candidate: MemoryCandidateEdge,
    byLabel: ReadonlyMap<string, MemoryNode>,
    key: MemoryScopeKey,
    at: number,
  ): Promise<{ created: boolean; changed: boolean } | undefined> {
    const from = byLabel.get(candidate.from) ?? this.findNodeByLabel(key, candidate.from)
    const to = byLabel.get(candidate.to) ?? this.findNodeByLabel(key, candidate.to)
    // A distiller may name an endpoint it did not also propose. Skipping keeps a
    // partially-grounded distillation useful instead of failing the whole pass.
    if (from === undefined || to === undefined) return undefined
    const existing = this.findEdge(key, from.id, to.id, candidate.relation)
    if (existing !== undefined && candidate.evidence.every(id => existing.evidence.includes(id))) {
      return { created: false, changed: false }
    }
    const existed = existing !== undefined
    await this.relate({
      scope,
      from: from.id,
      to: to.id,
      relation: candidate.relation,
      claim: candidate.claim,
      origin: 'inferred',
      confidence: candidate.confidence,
      evidence: candidate.evidence,
      at,
    })
    return { created: !existed, changed: true }
  }

  /** The first active node with a given label in a scope, regardless of type. */
  private findNodeByLabel(scope: MemoryScopeKey, label: string): MemoryNode | undefined {
    const wanted = label.trim()
    for (const node of this.store.nodes([scope])) {
      if (node.status === 'active' && node.label === wanted) return node
    }
    return undefined
  }

  /** Shared belief-adjustment path for reinforcement and contradiction. */
  private async adjust(
    ref: MemoryRef,
    at: number,
    update: (confidence: number) => number,
    reinforcing: boolean,
  ): Promise<void> {
    if (ref.kind === 'record') throw new MemoryError('invalid-input', 'layer-0 records carry no belief to adjust')
    const item = ref.kind === 'node' ? this.store.getNode(ref.id) : this.store.getEdge(ref.id)
    if (!item) throw new MemoryError('unknown-item', `memory ${ref.kind} '${ref.id}' does not exist`)
    return this.serialize(item.scope, () => this.adjustNow(ref, at, update, reinforcing))
  }

  private async adjustNow(
    ref: MemoryRef, at: number, update: (confidence: number) => number, reinforcing: boolean,
  ): Promise<void> {
    if (ref.kind === 'record') {
      throw new MemoryError('invalid-input', 'layer-0 records carry no belief to adjust')
    }
    const store = this.store
    if (ref.kind === 'node') {
      const node = store.getNode(ref.id)
      if (node === undefined) throw new MemoryError('unknown-item', `memory node '${ref.id}' does not exist`)
      if (node.status === 'retracted') {
        throw new MemoryError('retracted', `memory node '${ref.id}' is retracted`)
      }
      const next: MemoryNode = {
        ...node,
        confidence: clampConfidence(update(node.confidence)),
        support: reinforcing
          ? reinforceSupport(node.support, at, 0, 0)
          : { ...node.support, contradictions: node.support.contradictions + 1 },
        updatedAt: at,
      }
      await store.putNode(next)
      this.ctx.emit('memory/node-changed', next, node)
      return
    }
    const edge = store.getEdge(ref.id)
    if (edge === undefined) throw new MemoryError('unknown-item', `memory edge '${ref.id}' does not exist`)
    if (edge.status === 'retracted') {
      throw new MemoryError('retracted', `memory edge '${ref.id}' is retracted`)
    }
    const next: MemoryEdge = {
      ...edge,
      confidence: clampConfidence(update(edge.confidence)),
      support: reinforcing
        ? reinforceSupport(edge.support, at, 0, 0)
        : { ...edge.support, contradictions: edge.support.contradictions + 1 },
      updatedAt: at,
    }
    await store.putEdge(next)
    this.ctx.emit('memory/edge-changed', next, edge)
  }
}

// Service packages default-export their service class and nothing else
// plugin-shaped: mixing a default export with a
// function-plugin `apply` makes the Loader drop the plugin namespace.
export default MemoryRuntime
