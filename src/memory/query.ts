/**
 * Retrieval and write request vocabulary: what a caller asks memory for, what it
 * gets back, and what it hands memory to remember.
 *
 * @module dsh-advanced-mem-plugin/src/memory/query
 */

import type { JsonValue } from '@deepseek-ai/dsh-session'
import type {
  MemoryAttachment,
  MemoryEdge,
  MemoryFidelity,
  MemoryNode,
  MemoryNodeId,
  MemoryNodeType,
  MemoryOrigin,
  MemoryProvenance,
  MemoryRecord,
  MemoryRecordId,
  MemoryRecordKind,
  MemoryRelation,
  MemoryScope,
} from './types.ts'

/** One retrieval signal that contributed to a cue's placement. */
export interface MemorySignal {
  /**
   * Which signal fired: `lexical` is BM25 over indexed terms, `vector` is cosine
   * similarity against the query embedding, `graph` is activation spread from a
   * matched node, `recency` and `confidence` are the priors applied after fusion.
   */
  readonly kind: 'lexical' | 'vector' | 'graph' | 'recency' | 'confidence'
  /** Position within that signal's own ranking, when the signal produced one. */
  readonly rank?: number
  /** The signal's raw value, for explaining a result rather than for comparison across kinds. */
  readonly value: number
}

/** One retrieved item with its fused score and the signals behind it. */
export type MemoryCue =
  | {
    readonly kind: 'node'
    /** The retrieved layer-1 node, with decay already applied to `confidence`. */
    readonly node: MemoryNode
    /** Fused relevance; comparable only within one recall. */
    readonly score: number
    /** Signals that placed this cue. */
    readonly signals: readonly MemorySignal[]
  }
  | {
    readonly kind: 'edge'
    /** The retrieved layer-1 edge, with decay already applied to `confidence`. */
    readonly edge: MemoryEdge
    /** Both endpoint nodes, resolved so a consumer can render the claim without a second lookup. */
    readonly endpoints: readonly MemoryNode[]
    /** Fused relevance; comparable only within one recall. */
    readonly score: number
    /** Signals that placed this cue. */
    readonly signals: readonly MemorySignal[]
  }
  | {
    readonly kind: 'record'
    /** The retrieved layer-0 record. */
    readonly record: MemoryRecord
    /** Fused relevance; comparable only within one recall. */
    readonly score: number
    /** Signals that placed this cue. */
    readonly signals: readonly MemorySignal[]
  }

/** A retrieval request against one scope chain. */
export interface MemoryQuery {
  /** Natural-language cue; tokenized for lexical ranking and embedded when an embedder is composed. */
  readonly text: string
  /** Scopes to read, most specific first. Recall never widens this on its own. */
  readonly scopes: readonly MemoryScope[]
  /** Maximum cues to return. Omitted uses the runtime's configured default. */
  readonly limit?: number
  /** Restrict layer-0 cues to these record kinds. Omitted admits every kind. */
  readonly kinds?: readonly MemoryRecordKind[]
  /** Restrict layer-1 cues to these node types. Omitted admits every type. */
  readonly nodeTypes?: readonly MemoryNodeType[]
  /** Drop layer-1 cues whose decayed confidence falls below this. */
  readonly minConfidence?: number
  /** Drop layer-0 cues less faithful than this; see {@link MemoryFidelity}. */
  readonly minFidelity?: MemoryFidelity
  /** Whether layer-0 records may appear as cues at all. Omitted includes them. */
  readonly includeEpisodes?: boolean
  /** Clock reading for decay, so a caller can reproduce a past recall exactly. */
  readonly now?: number
  /** Cancellation for the embedding call this recall may make. */
  readonly signal?: AbortSignal
}

/** The answer to one {@link MemoryQuery}. */
export interface MemoryRecall {
  /** The query text, echoed so a consumer can label the result without holding the request. */
  readonly query: string
  /** Cues in descending fused score order. */
  readonly cues: readonly MemoryCue[]
  /** Whether the limit cut off further qualifying cues. */
  readonly truncated: boolean
  /** Whether a vector signal participated; false means lexical and graph only. */
  readonly semantic: boolean
}

/**
 * A standing digest of the highest-value layer-1 beliefs in a scope chain,
 * independent of any query. This is what a prompt consumer injects at the top of
 * a session so the agent starts already knowing who it is working with.
 */
export interface MemoryProfile {
  /** Nodes in descending decayed confidence order. */
  readonly nodes: readonly MemoryNode[]
  /** Edges whose endpoints are all present in `nodes`. */
  readonly edges: readonly MemoryEdge[]
  /** Total active nodes in the scope chain, so a consumer can say what it left out. */
  readonly total: number
}

/** A new layer-0 observation handed to the runtime. */
export interface MemoryObservation {
  /** Where the observation should live. */
  readonly scope: MemoryScope
  /** What produced it. */
  readonly kind: MemoryRecordKind
  /** Indexed text; the original wording for a `verbatim` observation. */
  readonly text: string
  /** How faithfully `text` reproduces the original. */
  readonly fidelity: MemoryFidelity
  /** References to non-text originals. */
  readonly attachments?: readonly MemoryAttachment[]
  /** Where it came from in the session log. */
  readonly provenance?: MemoryProvenance
  /** Capture time; omitted uses the current clock. */
  readonly at?: number
}

/** A layer-1 node to create or reinforce, addressed by its label within a scope and type. */
export interface MemoryAssertion {
  /** Where the belief should live. */
  readonly scope: MemoryScope
  /** Subject class. */
  readonly type: MemoryNodeType
  /** Canonical label; an existing active node with the same scope, type, and label is reinforced instead of duplicated. */
  readonly label: string
  /** One-sentence statement of the belief. */
  readonly summary: string
  /** Type-specific structured detail. */
  readonly attributes?: Readonly<Record<string, JsonValue>>
  /** Whether the user stated this or the harness concluded it. */
  readonly origin: MemoryOrigin
  /** Initial belief; omitted uses the runtime default for the origin. */
  readonly confidence?: number
  /** Erosion half-life; omitted uses the runtime default for the origin. */
  readonly halfLifeMs?: number | null
  /** Layer-0 records justifying the belief. */
  readonly evidence?: readonly MemoryRecordId[]
  /** Assertion time; omitted uses the current clock. */
  readonly at?: number
}

/** A layer-1 edge to create or reinforce between two existing nodes. */
export interface MemoryRelationInput {
  /** Where the conclusion should live. */
  readonly scope: MemoryScope
  /** Source node. */
  readonly from: MemoryNodeId
  /** Target node. */
  readonly to: MemoryNodeId
  /** The inference the edge encodes. */
  readonly relation: MemoryRelation
  /** The conclusion in one sentence. */
  readonly claim: string
  /** Whether the user stated this or the harness concluded it. */
  readonly origin: MemoryOrigin
  /** Initial belief; omitted uses the runtime default for the origin. */
  readonly confidence?: number
  /** Erosion half-life; omitted uses the runtime default for the origin. */
  readonly halfLifeMs?: number | null
  /** Layer-0 records justifying the conclusion. */
  readonly evidence?: readonly MemoryRecordId[]
  /** Relation time; omitted uses the current clock. */
  readonly at?: number
}

/** What one consolidation pass changed. */
export interface MemoryMaintenanceReport {
  /** Layer-0 records the pass read. */
  readonly examined: number
  /** Layer-1 nodes created. */
  readonly nodesCreated: number
  /** Layer-1 nodes reinforced rather than duplicated. */
  readonly nodesReinforced: number
  /** Layer-1 edges created. */
  readonly edgesCreated: number
  /** Layer-1 edges reinforced. */
  readonly edgesReinforced: number
  /** Items tombstoned because their decayed confidence fell below the retirement floor. */
  readonly retired: number
  /** Layer-0 records erased because the scope exceeded its record budget. */
  readonly evicted: number
}
