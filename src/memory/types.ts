/**
 * Memory vocabulary shared by every role of the memory capability seam.
 *
 * The model is two layers over one substrate. Layer 0 ({@link MemoryRecord}) keeps
 * fine-grained raw material — a user turn, a tool invocation, an image path, a video
 * URL — with the provenance needed to re-derive it from the session log. Layer 1
 * ({@link MemoryNode}, {@link MemoryEdge}) keeps the coarse-grained graph: nodes are
 * durable subjects such as user traits and preferences, edges are the inference
 * conclusions events induced between them. Every layer-1 item cites the layer-0
 * records that justify it, so a conclusion can always be traced back to evidence.
 *
 * @module dsh-advanced-mem-plugin/src/memory/types
 */

import type { Branded } from '@deepseek-ai/dsh-brand'
import type { JsonValue, SessionId } from '@deepseek-ai/dsh-session'

/** Identity of one layer-0 record. */
export type MemoryRecordId = Branded<'MemoryRecordId'>

/** Identity of one layer-1 node. */
export type MemoryNodeId = Branded<'MemoryNodeId'>

/** Identity of one layer-1 edge. */
export type MemoryEdgeId = Branded<'MemoryEdgeId'>

/**
 * Brand a layer-0 record id.
 * @param id - raw identifier string.
 * @returns the same string, typed as a record id.
 */
export function MemoryRecordId(id: string): MemoryRecordId {
  return id as MemoryRecordId
}

/**
 * Brand a layer-1 node id.
 * @param id - raw identifier string.
 * @returns the same string, typed as a node id.
 */
export function MemoryNodeId(id: string): MemoryNodeId {
  return id as MemoryNodeId
}

/**
 * Brand a layer-1 edge id.
 * @param id - raw identifier string.
 * @returns the same string, typed as an edge id.
 */
export function MemoryEdgeId(id: string): MemoryEdgeId {
  return id as MemoryEdgeId
}

/**
 * Retention reach of one memory. `session` dies with its session, `workspace`
 * follows one project root, and `user` follows the person across every project.
 * Recall reads a chain of scopes, most specific first.
 */
export type MemoryScope =
  | { readonly kind: 'user' }
  | { readonly kind: 'workspace'; readonly workspace: string }
  | { readonly kind: 'session'; readonly sessionId: SessionId }

/** Serialized {@link MemoryScope}; the durable partition key of every stored item. */
export type MemoryScopeKey = Branded<'MemoryScopeKey'>

/**
 * Project a scope onto its durable partition key.
 * @param scope - the retention reach to serialize.
 * @returns the partition key stored on records, nodes, and edges.
 */
export function memoryScopeKey(scope: MemoryScope): MemoryScopeKey {
  switch (scope.kind) {
    case 'user': return 'user' as MemoryScopeKey
    case 'workspace': return `workspace:${scope.workspace}` as MemoryScopeKey
    case 'session': return `session:${scope.sessionId}` as MemoryScopeKey
  }
}

/**
 * What produced one layer-0 record. The kind selects consolidation behavior:
 * `tool-invocation` and `skill-invocation` feed usage-frequency preference
 * mining, `procedure-step` feeds repeated-sequence mining for the automation
 * surfaces, and the message kinds feed semantic distillation.
 */
export type MemoryRecordKind =
  | 'user-message'
  | 'assistant-message'
  | 'tool-invocation'
  | 'skill-invocation'
  | 'procedure-step'
  | 'artifact'
  | 'note'

/**
 * Whether a layer-0 record may be quoted back to the model, or only counted.
 *
 * The two are genuinely different jobs, and conflating them is what makes a
 * memory system read its own output back as if it were evidence about the user.
 * A tool invocation is real evidence that a tool was reached for — it is exactly
 * what usage-frequency mining consumes — but its text is the agent's own
 * machine-shaped output, and surfacing it as a remembered "episode" tells the
 * model what it already did rather than anything about the person it works for.
 *
 * `evidence` records are indexed, ranked, and spread activation into the graph
 * like any other; they are simply never emitted as a cue's text unless a caller
 * asks for them explicitly with {@link MemoryQuery.includeEvidence}.
 */
export type MemoryRecordUse = 'recallable' | 'evidence'

/**
 * The default use for each record kind.
 *
 * The split is by author, not by usefulness: what the *user* produced is
 * quotable, what the *harness* produced about its own activity is not. An
 * assistant message is the model's own prose, and a tool invocation is the
 * model's own call — recalling either invites the model to mistake its previous
 * output for a fact about the user.
 */
export const MEMORY_RECORD_USE: Readonly<Record<MemoryRecordKind, MemoryRecordUse>> = {
  'user-message': 'recallable',
  'skill-invocation': 'recallable',
  artifact: 'recallable',
  note: 'recallable',
  'assistant-message': 'evidence',
  'tool-invocation': 'evidence',
  'procedure-step': 'evidence',
}

/**
 * Classify a record kind's default use.
 * @param kind - the producing kind.
 * @returns whether records of that kind are quotable or evidence-only.
 */
export function recordUseFor(kind: MemoryRecordKind): MemoryRecordUse {
  return MEMORY_RECORD_USE[kind]
}

/**
 * How faithfully the record's `text` reproduces what actually happened.
 * `verbatim` is the original wording, `summary` is a lossy reduction of a known
 * original, and `derived` is a statement no single original makes. Consumers that
 * act on the world (office automation, file edits) set a floor on this so a
 * derived belief cannot silently drive an irreversible action.
 */
export type MemoryFidelity = 'verbatim' | 'summary' | 'derived'

/** Ordering of {@link MemoryFidelity} from most to least faithful; index 0 is strictest. */
export const MEMORY_FIDELITY_ORDER: readonly MemoryFidelity[] = ['verbatim', 'summary', 'derived']

/**
 * Return whether a fidelity class is at least as faithful as a floor.
 * @param fidelity - the record's own fidelity class.
 * @param floor - the least faithful class the caller accepts.
 * @returns whether the record clears the floor.
 */
export function meetsFidelity(fidelity: MemoryFidelity, floor: MemoryFidelity): boolean {
  return MEMORY_FIDELITY_ORDER.indexOf(fidelity) <= MEMORY_FIDELITY_ORDER.indexOf(floor)
}

/**
 * A non-text original referenced by a record. The bytes are never copied into
 * memory: `uri` locates the original (a file path, an https URL, a storage
 * reference) and `digest` lets a later reader detect that the original moved or
 * changed under it. `caption` is the text projection used for retrieval.
 */
export interface MemoryAttachment {
  /** Medium of the referenced original. */
  readonly kind: 'image' | 'video' | 'audio' | 'document' | 'url' | 'blob'
  /** Locator of the original; resolution is the reader's responsibility. */
  readonly uri: string
  /** IANA media type when the producer knew it. */
  readonly mediaType?: string
  /** Size of the original in bytes when the producer knew it. */
  readonly bytes?: number
  /** Content digest of the original, for drift detection and de-duplication. */
  readonly digest?: string
  /** Text projection of the original, indexed for retrieval alongside `text`. */
  readonly caption?: string
}

/**
 * Where a record came from in the durable session log. A record that carries
 * `sessionId` and `eventSeq` can be re-derived from the log, which is what makes
 * a `verbatim` fidelity claim checkable rather than asserted.
 */
export interface MemoryProvenance {
  /** Session that produced the observation. */
  readonly sessionId?: SessionId
  /** Sequence number of the producing session event. */
  readonly eventSeq?: number
  /** Turn the observation belongs to. */
  readonly turn?: number
  /** Tool-call correlation id when a tool produced it. */
  readonly callId?: string
  /** Tool name when a tool produced it. */
  readonly tool?: string
  /** Skill name when a skill invocation produced it. */
  readonly skill?: string
}

/** A dense vector plus the model identity needed to reject cross-model comparison. */
export interface MemoryEmbedding {
  /** Producing embedder's name; vectors from different names are never compared. */
  readonly model: string
  /** Vector length, restated so a malformed durable row fails loud on load. */
  readonly dimensions: number
  /** L2-normalized components, so cosine similarity reduces to a dot product. */
  readonly vector: readonly number[]
}

/** Lifecycle state shared by layer-1 items. Nothing is deleted in place; it is tombstoned. */
export type MemoryStatus = 'active' | 'superseded' | 'retracted'

/** Whether a belief was stated by the user (`asserted`) or concluded by the harness (`inferred`). */
export type MemoryOrigin = 'asserted' | 'inferred'

/**
 * Time-based confidence erosion. `halfLifeMs` is the elapsed time after which an
 * unreinforced belief keeps half its confidence; `null` disables erosion, which
 * is the correct setting for an explicit standing instruction from the user.
 */
export interface MemoryDecay {
  /** Half-life in milliseconds, or `null` for a belief that never erodes. */
  readonly halfLifeMs: number | null
}

/** Accumulated evidence weight behind one layer-1 item, and the window it spans. */
export interface MemorySupport {
  /** Distinct layer-0 records cited as evidence. */
  readonly observations: number
  /** Times the item was re-observed after creation. */
  readonly reinforcements: number
  /** Times an observation argued against the item. */
  readonly contradictions: number
  /** Distinct sessions the evidence spans; a cross-session belief generalizes. */
  readonly sessions: number
  /** Epoch milliseconds of the earliest cited evidence. */
  readonly firstSeenAt: number
  /** Epoch milliseconds of the latest cited evidence; the decay clock reads this. */
  readonly lastSeenAt: number
}

/** One layer-0 record: fine-grained raw material with its provenance and retrieval keys. */
export interface MemoryRecord {
  /** Stable record identity. */
  readonly id: MemoryRecordId
  /** Durable partition key from {@link memoryScopeKey}. */
  readonly scope: MemoryScopeKey
  /** What produced the record. */
  readonly kind: MemoryRecordKind
  /** Indexed text: the original for `verbatim`, a reduction otherwise. */
  readonly text: string
  /** How faithfully `text` reproduces the original. */
  readonly fidelity: MemoryFidelity
  /**
   * Whether this record may be quoted back as recalled text. Defaults from
   * {@link recordUseFor}; a record captured before this field existed reads back
   * as its kind's default, so an existing store needs no migration pass.
   */
  readonly use: MemoryRecordUse
  /** Lexical retrieval keys extracted at capture time. */
  readonly terms: readonly string[]
  /** References to non-text originals; never inlined bytes. */
  readonly attachments: readonly MemoryAttachment[]
  /** Where the record came from in the session log. */
  readonly provenance: MemoryProvenance
  /** Epoch milliseconds of capture. */
  readonly createdAt: number
  /** Dense vector when an embedder was composed at capture time. */
  readonly embedding?: MemoryEmbedding
  /** Layer-1 items already citing this record; consolidation skips re-promotion. */
  readonly promotedTo: readonly string[]
  /** A `retracted` record stays on the medium for audit but never reaches recall. */
  readonly status: 'active' | 'retracted'
}

/**
 * Subject class of a layer-1 node. `preference`, `skill-affinity`, and
 * `tool-affinity` are the behavior-cycle conclusions the observer and
 * consolidation engine mine; `procedure` holds a repeated action sequence that a
 * future automation surface can replay.
 */
export type MemoryNodeType =
  | 'person'
  | 'preference'
  | 'skill-affinity'
  | 'tool-affinity'
  | 'entity'
  | 'project'
  | 'routine'
  | 'procedure'
  | 'constraint'

/** The inference an edge encodes between two nodes. */
export type MemoryRelation =
  | 'prefers'
  | 'avoids'
  | 'uses'
  | 'works-on'
  | 'part-of'
  | 'caused-by'
  | 'co-occurs'
  | 'contradicts'
  | 'supersedes'

/** One layer-1 node: a coarse-grained subject with its belief state and evidence. */
export interface MemoryNode {
  /** Stable node identity. */
  readonly id: MemoryNodeId
  /** Durable partition key from {@link memoryScopeKey}. */
  readonly scope: MemoryScopeKey
  /** Subject class. */
  readonly type: MemoryNodeType
  /** Short canonical name; unique per scope and type after merging. */
  readonly label: string
  /** One-sentence statement of what is believed about the subject. */
  readonly summary: string
  /** Type-specific structured detail, JSON-serializable for the durable medium. */
  readonly attributes: Readonly<Record<string, JsonValue>>
  /** Stored belief in the closed unit interval, before decay is applied at read time. */
  readonly confidence: number
  /** How the stored belief erodes while unreinforced. */
  readonly decay: MemoryDecay
  /** Accumulated evidence weight. */
  readonly support: MemorySupport
  /** Layer-0 records justifying the belief. */
  readonly evidence: readonly MemoryRecordId[]
  /** Whether the user stated this or the harness concluded it. */
  readonly origin: MemoryOrigin
  /** Lifecycle state. */
  readonly status: MemoryStatus
  /** Node that replaced this one, set when `status` is `superseded`. */
  readonly supersededBy?: MemoryNodeId
  /** Epoch milliseconds of creation. */
  readonly createdAt: number
  /** Epoch milliseconds of the last belief change. */
  readonly updatedAt: number
}

/** One layer-1 edge: an event-induced conclusion linking two nodes. */
export interface MemoryEdge {
  /** Stable edge identity. */
  readonly id: MemoryEdgeId
  /** Durable partition key from {@link memoryScopeKey}. */
  readonly scope: MemoryScopeKey
  /** Source node. */
  readonly from: MemoryNodeId
  /** Target node. */
  readonly to: MemoryNodeId
  /** The inference this edge encodes. */
  readonly relation: MemoryRelation
  /** The conclusion in one sentence, as it will be shown to the model. */
  readonly claim: string
  /** Stored belief in the closed unit interval, before decay is applied at read time. */
  readonly confidence: number
  /** How the stored belief erodes while unreinforced. */
  readonly decay: MemoryDecay
  /** Accumulated evidence weight. */
  readonly support: MemorySupport
  /** Layer-0 records justifying the conclusion. */
  readonly evidence: readonly MemoryRecordId[]
  /** Whether the user stated this or the harness concluded it. */
  readonly origin: MemoryOrigin
  /** Lifecycle state. */
  readonly status: MemoryStatus
  /** Edge that replaced this one, set when `status` is `superseded`. */
  readonly supersededBy?: MemoryEdgeId
  /** Epoch milliseconds of creation. */
  readonly createdAt: number
  /** Epoch milliseconds of the last belief change. */
  readonly updatedAt: number
}

/** Reference to any addressable memory item, used by reinforcement and retraction. */
export type MemoryRef =
  | { readonly kind: 'record'; readonly id: MemoryRecordId }
  | { readonly kind: 'node'; readonly id: MemoryNodeId }
  | { readonly kind: 'edge'; readonly id: MemoryEdgeId }
