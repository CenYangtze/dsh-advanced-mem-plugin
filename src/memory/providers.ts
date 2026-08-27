/**
 * The three Service Provider interfaces of the memory seam: the durable store,
 * the embedder, and the distiller. The hub owns none of them — it composes
 * whichever ones an assembly mounted, so a deployment can run memory with a JSON
 * file and no model at all, or with a vector index and a hosted embedding model,
 * without any consumer changing.
 *
 * @module dsh-advanced-mem-plugin/src/memory/providers
 */

import type { JsonValue } from '@deepseek-ai/dsh-session'
import type {
  MemoryEdge,
  MemoryEdgeId,
  MemoryNode,
  MemoryNodeId,
  MemoryNodeType,
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
}

/**
 * Dense-vector producer for semantic retrieval. Optional: without one, recall
 * falls back to lexical ranking and graph activation alone, which is degraded
 * but correct.
 */
export interface MemoryEmbedder {
  /** Provider name, stamped onto every vector so mismatched vectors are never compared. */
  readonly name: string
  /** Length of every vector this provider returns. */
  readonly dimensions: number

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

/** What a distiller is asked to reason over. */
export interface MemoryDistillInput {
  /** Partition the proposals will land in. */
  readonly scope: MemoryScopeKey
  /** The unconsolidated layer-0 window. */
  readonly records: readonly MemoryRecord[]
  /** Layer-1 nodes already active in the scope, so a distiller can propose merges rather than duplicates. */
  readonly existing: readonly MemoryNode[]
  /** Cancellation for the distillation. */
  readonly signal?: AbortSignal
}

/** What a distiller proposes from one window. */
export interface MemoryDistillation {
  /** Proposed nodes. */
  readonly nodes: readonly MemoryCandidateNode[]
  /** Proposed edges, addressing endpoints by label. */
  readonly edges: readonly MemoryCandidateEdge[]
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
   * Propose layer-1 items from a window of layer-0 records.
   * @param input - the window, its scope, and the active graph around it.
   * @returns the proposals; an empty distillation is a valid answer.
   */
  distill(input: MemoryDistillInput): Promise<MemoryDistillation>
}
