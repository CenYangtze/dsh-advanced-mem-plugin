/**
 * The three Service Provider interfaces of the memory seam: the durable store,
 * the embedder, and the distiller. The hub owns none of them — it composes
 * whichever ones an assembly mounted, so a deployment can run memory with a JSON
 * file and no model at all, or with a vector index and a hosted embedding model,
 * without any consumer changing.
 *
 * @module dsh-advanced-mem-plugin/src/memory/providers
 */

import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type {
  MemoryDistillerProgress,
  MemoryEdge,
  MemoryEdgeId,
  MemoryNode,
  MemoryNodeId,
  MemoryNodeType,
  MemoryOrigin,
  MemoryProgressId,
  MemoryRecord,
  MemoryRecordId,
  MemoryRelation,
  MemoryScopeKey,
} from './types.ts'

/**
 * Durable dual-layer store.
 *
 * Reads are synchronous and writes are asynchronous on purpose. Recall runs on
 * the request path and must not await the medium, so a provider loads its scope
 * into memory at open and serves reads from there; durability is the write
 * path's job. A provider that cannot honor synchronous reads is the wrong shape
 * for this seam and belongs behind a cache that can.
 */
export interface MemoryStore {
  /** Provider name, used in diagnostics and duplicate-registration errors. */
  readonly name: string

  /**
   * Read one layer-0 record.
   * @param id - the record identity.
   * @returns the record, or `undefined` when the id is unknown.
   */
  getRecord(id: MemoryRecordId): MemoryRecord | undefined

  /**
   * Enumerate every layer-0 record in the given scopes, retracted ones included.
   * @param scopes - partition keys to read, in any order.
   * @returns a snapshot iterator; iteration is unaffected by concurrent writes.
   */
  records(scopes: readonly MemoryScopeKey[]): Iterable<MemoryRecord>

  /**
   * Insert or replace one layer-0 record.
   * @param record - the complete record; there is no partial merge.
   * @returns resolution once the write is durable.
   */
  putRecord(record: MemoryRecord): Promise<void>

  /**
   * Read one layer-1 node.
   * @param id - the node identity.
   * @returns the node, or `undefined` when the id is unknown.
   */
  getNode(id: MemoryNodeId): MemoryNode | undefined

  /**
   * Enumerate every layer-1 node in the given scopes, tombstoned ones included.
   * @param scopes - partition keys to read, in any order.
   * @returns a snapshot iterator.
   */
  nodes(scopes: readonly MemoryScopeKey[]): Iterable<MemoryNode>

  /**
   * Insert or replace one layer-1 node.
   * @param node - the complete node; there is no partial merge.
   * @returns resolution once the write is durable.
   */
  putNode(node: MemoryNode): Promise<void>

  /**
   * Read one layer-1 edge.
   * @param id - the edge identity.
   * @returns the edge, or `undefined` when the id is unknown.
   */
  getEdge(id: MemoryEdgeId): MemoryEdge | undefined

  /**
   * Enumerate every layer-1 edge in the given scopes, tombstoned ones included.
   * @param scopes - partition keys to read, in any order.
   * @returns a snapshot iterator.
   */
  edges(scopes: readonly MemoryScopeKey[]): Iterable<MemoryEdge>

  /**
   * Insert or replace one layer-1 edge.
   * @param edge - the complete edge; there is no partial merge.
   * @returns resolution once the write is durable.
   */
  putEdge(edge: MemoryEdge): Promise<void>

  /**
   * Permanently remove one layer-0 record and its evidence citations.
   *
   * Distinct from retraction: retraction tombstones an item so an audit can
   * still see what was once believed, while this erases it because the user
   * asked for the underlying material to be gone.
   * @param id - the record identity.
   * @returns whether a record existed to erase.
   */
  eraseRecord(id: MemoryRecordId): Promise<boolean>
  /** Permanently remove a derived node when its source is erased. */
  eraseNode(id: MemoryNodeId): Promise<boolean>
  /** Permanently remove a derived edge when its source or endpoint is erased. */
  eraseEdge(id: MemoryEdgeId): Promise<boolean>

  /**
   * Optional durable consolidation-progress capability. A store that does not
   * expose it keeps the legacy `promotedTo`-based pending rule; the bundled
   * domain store provides it so successful empty checks are remembered.
   */
  readonly progressStore?: MemoryProgressStore
}

/**
 * Durable per-distiller/version processing progress. Records are partitioned by
 * scope like the other memory tables and keyed by distiller, version and record.
 */
export interface MemoryProgressStore {
  /**
   * Read one progress row.
   * @param id - the row identity.
   * @returns the row, or `undefined` when absent.
   */
  getProgress(id: MemoryProgressId): MemoryDistillerProgress | undefined

  /**
   * Enumerate progress rows across partitions.
   * @param scopes - the partition keys to read.
   * @returns a snapshot iterable.
   */
  progress(scopes: readonly MemoryScopeKey[]): Iterable<MemoryDistillerProgress>

  /**
   * Insert or replace one progress row.
   * @param progress - the complete row.
   * @returns resolution once the write is durable.
   */
  putProgress(progress: MemoryDistillerProgress): Promise<void>

  /**
   * Permanently remove one progress row.
   * @param id - the row identity.
   * @returns whether a row existed to erase.
   */
  eraseProgress(id: MemoryProgressId): Promise<boolean>
}

/**
 * Stable, non-sensitive categories for an embedder failure. A provider reports
 * one of these instead of transport text, so a recall diagnostic can be logged
 * or shown without leaking a query or a runner's stderr.
 */
export const MEMORY_EMBEDDER_FAILURE_CODES = [
  'timeout',
  'output-limit',
  'not-found',
  'invalid-text',
  'invalid-payload',
  'dimension-mismatch',
  'sdk-failure',
  'aborted',
  'empty-text',
] as const

/** One of {@link MEMORY_EMBEDDER_FAILURE_CODES}. */
export type MemoryEmbedderFailureCode = typeof MEMORY_EMBEDDER_FAILURE_CODES[number]

/** Fixed public text for each failure category; never derived from provider output. */
export const MEMORY_EMBEDDER_FAILURE_REASONS: Readonly<Record<MemoryEmbedderFailureCode, string>> = {
  timeout: 'embedding provider timed out',
  'output-limit': 'embedding provider exceeded its output limit',
  'not-found': 'embedding provider runner is unavailable',
  'invalid-text': 'embedding provider received invalid text',
  'invalid-payload': 'embedding provider returned an invalid vector',
  'dimension-mismatch': 'embedding provider changed vector dimensions',
  'sdk-failure': 'embedding provider reported an SDK failure',
  aborted: 'embedding provider call was aborted',
  'empty-text': 'embedding provider received empty text',
}

/** A classified embedder failure safe to return or log. */
export interface MemoryEmbedderFailure {
  /** Stable category, suitable for counting and branching. */
  readonly code: MemoryEmbedderFailureCode
  /** Fixed human-readable text from {@link MEMORY_EMBEDDER_FAILURE_REASONS}. */
  readonly reason: string
}

/**
 * Provider-thrown failure carrying only a category and fixed text.
 *
 * The constructor deliberately does not accept a message or a cause: raw SDK
 * stderr, payloads and query text must not travel through an error object into
 * logs or a model-visible diagnostic.
 */
export class MemoryEmbedderError extends Error {
  /** Stable category of this failure. */
  readonly code: MemoryEmbedderFailureCode

  /**
   * @param code - the failure category.
   */
  constructor(code: MemoryEmbedderFailureCode) {
    super(MEMORY_EMBEDDER_FAILURE_REASONS[code])
    this.name = 'MemoryEmbedderError'
    this.code = code
  }
}

/**
 * Dense-vector producer for semantic retrieval. Optional: without one, recall
 * falls back to lexical ranking and graph activation alone, which is degraded
 * but correct.
 */
export interface MemoryEmbedder {
  /**
   * Provider name, stamped onto every vector so mismatched vectors are never
   * compared. A provider whose model or weights can change must include the
   * model identity and version in this name; the hub compares only exact names.
   */
  readonly name: string
  /** Length of every vector this provider returns. */
  readonly dimensions: number

  /**
   * Set when the provider is mounted but cannot serve requests, for example a
   * configured runner binary that is missing. Recall reports this as a lexical
   * fallback with a diagnostic instead of looking like an intentionally
   * disabled embedder.
   */
  readonly unavailable?: MemoryEmbedderFailure

  /**
   * Embed a batch of texts.
   * @param texts - the texts to embed, in order.
   * @param options - optional cancellation for the batch.
   * @returns one L2-normalized vector per input text, in the same order.
   */
  embed(
    texts: readonly string[],
    options?: { readonly signal?: AbortSignal },
  ): Promise<readonly (readonly number[])[]>
}

/** A layer-1 node a distiller proposes; the hub assigns identity and merges it. */
export interface MemoryCandidateNode {
  /** Proposed subject class. */
  readonly type: MemoryNodeType
  /** Proposed canonical label; the merge key within a scope and type. */
  readonly label: string
  /** One-sentence statement of the belief. */
  readonly summary: string
  /** Type-specific structured detail. */
  readonly attributes?: Readonly<Record<string, JsonValue>>
  /** The distiller's own belief in the closed unit interval. */
  readonly confidence: number
  /** Layer-0 records that justify the proposal; an empty list is rejected. */
  readonly evidence: readonly MemoryRecordId[]
  /**
   * Merge behavior. Omitted preserves near-duplicate reinforcement. `exact`
   * merges only the same label, so a semantic fact with a different value does
   * not overwrite an existing belief through topic similarity.
   */
  readonly merge?: 'exact' | 'similar'
}

/** A layer-1 edge a distiller proposes, addressing its endpoints by label. */
export interface MemoryCandidateEdge {
  /** Label of the source node, resolved against candidates first and then the store. */
  readonly from: string
  /** Label of the target node, resolved the same way. */
  readonly to: string
  /** The inference the edge encodes. */
  readonly relation: MemoryRelation
  /** The conclusion in one sentence, as it will be shown to the model. */
  readonly claim: string
  /** The distiller's own belief in the closed unit interval. */
  readonly confidence: number
  /** Layer-0 records that justify the proposal; an empty list is rejected. */
  readonly evidence: readonly MemoryRecordId[]
}

/** Model route a semantic distiller may use; credentials remain with the host. */
export interface MemoryModelRoute {
  /** Provider configured in the host. */
  readonly provider: string
  /** Model configured in the host. */
  readonly model: string
  /** Optional host reasoning effort. */
  readonly reasoningEffort?: string
}

/** Context available when deciding whether a distiller accepts one record. */
export interface MemoryDistillAcceptContext {
  /** Session whose route drives this pass, when one is known. */
  readonly sessionId?: string
}

/** What a distiller is asked to reason over. */
export interface MemoryDistillInput {
  /** Partition the proposals will land in. */
  readonly scope: MemoryScopeKey
  /** The unconsolidated layer-0 window. */
  readonly records: readonly MemoryRecord[]
  /** Layer-1 nodes already active in the scope, so a distiller can propose merges rather than duplicates. */
  readonly existing: readonly MemoryNode[]
  /** Host model route for this pass, resolved from the owning session or an explicit caller. */
  readonly route?: MemoryModelRoute
  /** Session whose records and route this pass is allowed to use. */
  readonly sessionId?: string
  /** Cancellation for the distillation. */
  readonly signal?: AbortSignal
}

/** Fixed reason a record was permanently skipped by a distiller. */
export type MemoryDistillationSkipReason = 'input-too-large' | 'blocked-sensitive'

/** Fixed reason one model-backed pass failed. */
export type MemoryDistillationFailureReason =
  | 'timeout'
  | 'provider-failed'
  | 'invalid-output'
  | 'output-limit'

/** A record the distiller permanently skipped, with a non-sensitive reason. */
export interface MemoryDistillationSkip {
  /** The skipped input record. */
  readonly record: MemoryRecordId
  /** Fixed reason. */
  readonly reason: MemoryDistillationSkipReason
}

/** A record whose processing failed and should be retried within its bound. */
export interface MemoryDistillationFailure {
  /** The failed input record. */
  readonly record: MemoryRecordId
  /** Fixed reason; no provider text. */
  readonly reason: MemoryDistillationFailureReason
}

/** Token counts the host actually returned, never estimated or priced. */
export interface MemoryDistillationUsage {
  /** Uncached input tokens. */
  readonly inputTokens: number
  /** Output tokens. */
  readonly outputTokens: number
}

/** A replacement a distiller proposes for one existing active node. */
export interface MemoryReplacementCandidate {
  /** Active node to retire, resolved from an alias in the distiller input. */
  readonly target: MemoryNodeId
  /** Subject class; must match the target. */
  readonly type: MemoryNodeType
  /** Canonical label for the new node identity. */
  readonly label: string
  /** One-sentence statement of the new belief. */
  readonly summary: string
  /** Type-specific structured detail. */
  readonly attributes?: Readonly<Record<string, JsonValue>>
  /** The distiller's own belief in the closed unit interval. */
  readonly confidence: number
  /** New layer-0 records that justify the replacement. */
  readonly evidence: readonly MemoryRecordId[]
  /** Verbatim fragment from one cited new record. */
  readonly quote: string
  /** Whether the user stated the replacement or the harness inferred it. */
  readonly origin: MemoryOrigin
}

/** What a distiller proposes from one window. */
export interface MemoryDistillation {
  /** Proposed nodes. */
  readonly nodes: readonly MemoryCandidateNode[]
  /** Proposed edges, addressing endpoints by label. */
  readonly edges: readonly MemoryCandidateEdge[]
  /** Proposed replacements; each creates a new node identity and retires the target. */
  readonly replacements?: readonly MemoryReplacementCandidate[]
  /**
   * Records actually consumed by this pass. Omitted keeps the legacy behavior:
   * every pending record advances. A model-backed distiller that can read only
   * part of a window must list the subset it actually inspected, and every id
   * must be one of the input records.
   */
  readonly consumedRecordIds?: readonly MemoryRecordId[]
  /** Records permanently skipped by policy, for example a single oversized input. */
  readonly skipped?: readonly MemoryDistillationSkip[]
  /** Records whose pass failed and should be retried within the progress bound. */
  readonly failed?: readonly MemoryDistillationFailure[]
  /** Host-reported token usage for this pass, when the host returned one. */
  readonly usage?: MemoryDistillationUsage
}

/** How a distiller consumes records and bounds retries for durable progress. */
export type MemoryDistillerProgressPolicy =
  | {
    /** Each unprocessed record is inspected on its own. */
    readonly mode: 'record'
    /** Failed records are retried at most this many times. */
    readonly maxAttempts: number
  }
  | {
    /** Each pass inspects new records plus bounded prior context. */
    readonly mode: 'window'
    /** Failed records are retried at most this many times. */
    readonly maxAttempts: number
    /** Prior processed records included before the first new record. */
    readonly lookback: number
  }

/**
 * Turns a window of layer-0 records into layer-1 proposals. Several may be
 * composed at once: a frequency miner that needs no model runs beside a
 * model-backed semantic extractor, and the hub merges both outputs through the
 * same reinforcement path.
 */
export interface MemoryDistiller {
  /** Provider name, used in diagnostics and to attribute proposals. */
  readonly name: string
  /** Lower runs first; a cheap deterministic miner should precede a model call. */
  readonly rank: number
  /**
   * Implementation or policy version. Progress is keyed by this value, so a
   * bump replays records under the new version without a migration pass. An
   * omitted version uses the explicit `legacy` key.
   */
  readonly version?: string
  /**
   * Opt in to durable per-record progress. Omitted keeps the legacy
   * `promotedTo`-empty pending rule for third-party distillers.
   */
  readonly progress?: MemoryDistillerProgressPolicy
  /**
   * Version used for this pass's progress key. Static `version` is enough for a
   * local miner; a model-backed distiller includes prompt, model and config so a
   * route change replays records instead of mixing spaces.
   */
  readonly progressVersion?: (route?: MemoryModelRoute) => string
  /**
   * Whether this distiller should even consider a record. Used to keep
   * model-backed extraction to user-authored records in the selected session.
   */
  readonly accepts?: (record: MemoryRecord, context: MemoryDistillAcceptContext) => boolean

  /**
   * Propose layer-1 items from a window of layer-0 records.
   * @param input - the window, its scope, and the active graph around it.
   * @returns the proposals; an empty distillation is a valid answer.
   */
  distill(input: MemoryDistillInput): Promise<MemoryDistillation>
}
