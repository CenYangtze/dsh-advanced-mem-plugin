/**
 * Retrieval and write request vocabulary: what a caller asks memory for, what it
 * gets back, and what it hands memory to remember.
 *
 * @module dsh-advanced-mem-plugin/src/memory/query
 */

import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type { MemoryEmbedderFailure } from './providers.ts'
import type {
  MemoryAttachment,
  MemoryCaptureInput,
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
  MemoryRecordUse,
  MemoryRelation,
  MemorySafetyMetadata,
  MemoryScope,
  MemoryScopeKey,
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
    /** Redaction metadata for the safe view. */
    readonly safety?: MemorySafetyMetadata
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
    /** Redaction metadata for the safe view. */
    readonly safety?: MemorySafetyMetadata
  }
  | {
    readonly kind: 'record'
    /** The retrieved layer-0 record. */
    readonly record: MemoryRecord
    /**
     * The turn this record answers, when it is a reply that cannot stand alone.
     *
     * "1 to 3, yes" means nothing without the question it ratified. The
     * question was the assistant's, so it is `evidence`-use and never quoted on
     * its own; the user's reply is what makes it worth reading, and it travels
     * here rather than as a cue of its own.
     */
    readonly anchor?: MemoryRecord
    /**
     * The assistant's restatement of this record, when the user let it stand.
     *
     * "Understood - converting to minutes, header 'Duration (min)'" is the
     * harness's own prose and so never a cue of its own; but said straight
     * after the instruction and not corrected by the user's next turn, it is
     * the instruction in its clearest form. It travels with the record it
     * confirms, never alone.
     */
    readonly confirmation?: MemoryRecord
    /** Fused relevance; comparable only within one recall. */
    readonly score: number
    /** Signals that placed this cue. */
    readonly signals: readonly MemorySignal[]
    /** Redaction metadata for the safe view. */
    readonly safety?: MemorySafetyMetadata
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
  /**
   * Whether `evidence`-use records may appear as cues; see {@link MemoryRecordUse}.
   * Omitted excludes them, which is what keeps the agent's own tool calls and
   * prose out of what gets read back to it. They still rank and still spread
   * activation into the graph either way — this decides only whether their text
   * is quoted. Set it for an audit or debugging surface, not for a request path.
   */
  readonly includeEvidence?: boolean
  /** Clock reading for decay, so a caller can reproduce a past recall exactly. */
  readonly now?: number
  /** Cancellation for the embedding call this recall may make. */
  readonly signal?: AbortSignal
}

/** A query-time embedding failure, reported rather than hidden by a lexical fallback. */
export interface MemoryEmbeddingFailure extends MemoryEmbedderFailure {
  /** Provider that failed, including its model and version identity. */
  readonly provider: string
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
  /**
   * Retrieval mode that actually ran, not merely which providers are mounted.
   * `semantic` requires at least one usable stored vector ranked against a
   * usable query vector; a provider that is present but fails or has nothing to
   * compare is still `lexical`.
   */
  readonly mode: 'lexical' | 'semantic'
  /** Set when a mounted embedder is unavailable or its query call failed; recall still returned. */
  readonly embeddingFailure?: MemoryEmbeddingFailure
  /** Redaction metadata for the externally used query, when filtering changed it. */
  readonly safety?: MemorySafetyMetadata
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
  /** Redaction metadata for the safe view when any text was filtered or dropped. */
  readonly safety?: MemorySafetyMetadata
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
  /**
   * Override the kind's default use; see {@link MemoryRecordUse}. Omitted takes
   * {@link recordUseFor}, which is the right answer for every shipped capture
   * path — pass it only when a producer knows its material is unlike its kind.
   */
  readonly use?: MemoryRecordUse
  /** References to non-text originals. */
  readonly attachments?: readonly MemoryAttachment[]
  /** Where it came from in the session log. */
  readonly provenance?: MemoryProvenance
  /** Capture length and truncation facts supplied by the observer. */
  readonly capture?: MemoryCaptureInput
  /** Capture time; omitted uses the current clock. */
  readonly at?: number
}

/**
 * One thing worth starting from, derived from what memory already holds.
 *
 * This is the standing profile turned toward the future rather than the past:
 * the projects, routines, and procedures a person keeps returning to are the
 * work they are most likely to want next, and a fresh session has no other way
 * to know them. Only those three node types qualify — a preference or a
 * constraint says *how* to work, not *what* to work on, and suggesting one back
 * as an opening move would be noise.
 */
export interface MemorySuggestion {
  /** The node type this came from; the caller may group or label by it. */
  readonly kind: 'project' | 'routine' | 'procedure'
  /** The subject to pick up, verbatim from the node's label. */
  readonly subject: string
  /** What memory knows about it, for showing why this is being offered. */
  readonly reason: string
  /** Decayed confidence, so a surface can present a faded suggestion differently. */
  readonly confidence: number
  /** The node behind the suggestion, for a caller that wants its evidence. */
  readonly node: MemoryNode
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
  /** Layer-0 source records; omission creates an evidence-only API assertion ledger. */
  readonly evidence?: readonly MemoryRecordId[]
  /** Assertion time; omitted uses the current clock. */
  readonly at?: number
}

/**
 * Replace one active belief with a new node identity.
 *
 * The target is addressed by id, never by a free-form label. New evidence must
 * be active user-authored records in the same scope and must contain `quote`.
 * The old node stays as a tombstone and a `supersedes` edge retains history.
 */
export interface MemoryReplacementRequest {
  /** Scope shared by the target, evidence and replacement. */
  readonly scope: MemoryScope
  /** Active node being retired. */
  readonly target: MemoryNodeId
  /** Subject class; must match the target. */
  readonly type: MemoryNodeType
  /** Canonical label for the new node identity. */
  readonly label: string
  /** One-sentence statement of the new belief. */
  readonly summary: string
  /** Type-specific structured detail for the new node. */
  readonly attributes?: Readonly<Record<string, JsonValue>>
  /** Whether the user stated the replacement or the harness inferred it. */
  readonly origin: MemoryOrigin
  /** Initial belief; omitted uses the runtime default for the origin. */
  readonly confidence?: number
  /** Erosion half-life; omitted uses the runtime default for the origin. */
  readonly halfLifeMs?: number | null
  /** Active user-authored records that justify the replacement. */
  readonly evidence: readonly MemoryRecordId[]
  /** Verbatim fragment from one cited record; whitespace-normalized matching. */
  readonly quote: string
  /** One-sentence claim for the supersession edge; omitted derives it. */
  readonly claim?: string
  /** Replacement time; omitted uses the current clock. */
  readonly at?: number
}

/** What one replacement created or replayed. */
export interface MemoryReplacementResult {
  /** The retired target. */
  readonly replaced: MemoryNodeId
  /** The new node identity, stable across retries of the same request. */
  readonly replacement: MemoryNode
  /** The `supersedes` edge from replacement to target. */
  readonly edge: MemoryEdge
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
  /** Layer-0 source records; omission creates an evidence-only API assertion ledger. */
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
  /** Active nodes retired by a replacement in this pass. */
  readonly replaced?: number
  /** Items tombstoned because their decayed confidence fell below the retirement floor. */
  readonly retired: number
  /** Layer-0 records erased because the scope exceeded its record budget. */
  readonly evicted: number
}
