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

import { randomUUID } from 'node:crypto'
import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Session } from '@deepseek-ai/dsh-session'
import { MemoryError } from './errors.ts'
import {
  bm25Rank,
  clampConfidence,
  cosineSimilarity,
  decayedConfidence,
  reciprocalRankFusion,
  reinforcedConfidence,
  tokenize,
  weakenedConfidence,
} from './scoring.ts'
import type { ScoredItem } from './scoring.ts'
import {
  MemoryEdgeId,
  MemoryNodeId,
  MemoryRecordId,
  meetsFidelity,
  memoryScopeKey,
} from './types.ts'
import type {
  MemoryDecay,
  MemoryEdge,
  MemoryNode,
  MemoryOrigin,
  MemoryRecord,
  MemoryRef,
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
  MemoryRelationInput,
  MemorySignal,
} from './query.ts'
import type {
  MemoryCandidateEdge,
  MemoryCandidateNode,
  MemoryDistiller,
  MemoryEmbedder,
  MemoryStore,
} from './providers.ts'

export { MemoryError } from './errors.ts'
export type { MemoryErrorCode } from './errors.ts'
export {
  bm25Rank,
  clampConfidence,
  cosineSimilarity,
  decayedConfidence,
  normalizeVector,
  reciprocalRankFusion,
  reinforcedConfidence,
  tokenize,
  weakenedConfidence,
} from './scoring.ts'
export type { LexicalDocument, ScoredItem } from './scoring.ts'
export {
  MEMORY_FIDELITY_ORDER,
  MemoryEdgeId,
  MemoryNodeId,
  MemoryRecordId,
  meetsFidelity,
  memoryScopeKey,
} from './types.ts'
export type {
  MemoryAttachment,
  MemoryDecay,
  MemoryEdge,
  MemoryEmbedding,
  MemoryFidelity,
  MemoryNode,
  MemoryNodeType,
  MemoryOrigin,
  MemoryProvenance,
  MemoryRecord,
  MemoryRecordKind,
  MemoryRef,
  MemoryRelation,
  MemoryScope,
  MemoryScopeKey,
  MemoryStatus,
  MemorySupport,
} from './types.ts'
export type {
  MemoryAssertion,
  MemoryCue,
  MemoryMaintenanceReport,
  MemoryObservation,
  MemoryProfile,
  MemoryQuery,
  MemoryRecall,
  MemoryRelationInput,
  MemorySignal,
} from './query.ts'
export type {
  MemoryCandidateEdge,
  MemoryCandidateNode,
  MemoryDistillation,
  MemoryDistillInput,
  MemoryDistiller,
  MemoryEmbedder,
  MemoryStore,
} from './providers.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    memory: MemoryRuntime
  }

  interface Events {
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
  })

  private storeProvider: MemoryStore | undefined
  private embedderProvider: MemoryEmbedder | undefined
  private readonly distillerProviders = new Set<MemoryDistiller>()

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
   * Append one layer-0 record and index it for retrieval. When an embedder is
   * mounted the record is embedded before it is stored, so a later recall never
   * has to backfill vectors on the request path.
   * @param observation - the raw material to keep.
   * @returns the stored record.
   * @throws `invalid-input` when the text is blank, or `no-store` when nothing is mounted.
   */
  async remember(observation: MemoryObservation): Promise<MemoryRecord> {
    const text = observation.text.trim()
    if (text.length === 0) {
      throw new MemoryError('invalid-input', 'a memory observation needs non-empty text')
    }
    const attachments = observation.attachments ?? []
    const captions = attachments.map(attachment => attachment.caption ?? '').join(' ')
    const embedder = this.embedderProvider
    const vector = embedder === undefined
      ? undefined
      : (await embedder.embed([`${text} ${captions}`.trim()]))[0]
    const record: MemoryRecord = {
      id: MemoryRecordId(`mem-r-${randomUUID()}`),
      scope: memoryScopeKey(observation.scope),
      kind: observation.kind,
      text,
      fidelity: observation.fidelity,
      terms: tokenize(`${text} ${captions}`),
      attachments,
      provenance: observation.provenance ?? {},
      createdAt: observation.at ?? Date.now(),
      ...vector === undefined || embedder === undefined
        ? {}
        : { embedding: { model: embedder.name, dimensions: embedder.dimensions, vector: [...vector] } },
      promotedTo: [],
      status: 'active',
    }
    await this.store.putRecord(record)
    this.ctx.emit('memory/recorded', record)
    return record
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
  async assert(assertion: MemoryAssertion): Promise<MemoryNode> {
    const label = assertion.label.trim()
    const summary = assertion.summary.trim()
    if (label.length === 0 || summary.length === 0) {
      throw new MemoryError('invalid-input', 'a memory assertion needs a non-empty label and summary')
    }
    const scope = memoryScopeKey(assertion.scope)
    const at = assertion.at ?? Date.now()
    const evidence = assertion.evidence ?? []
    const existing = this.findNode(scope, assertion.type, label)
    if (existing !== undefined) {
      const merged = mergeEvidence(existing.evidence, evidence)
      const origin = assertion.origin === 'asserted' ? 'asserted' : existing.origin
      const next: MemoryNode = {
        ...existing,
        summary,
        attributes: { ...existing.attributes, ...assertion.attributes },
        confidence: clampConfidence(reinforcedConfidence(existing.confidence, this.config.reinforcementRate)),
        decay: this.decayFor(origin, assertion.halfLifeMs),
        support: reinforceSupport(existing.support, at, merged.addedCount, merged.addedCount === 0 ? 0 : 1),
        evidence: merged.evidence,
        origin,
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
      label,
      summary,
      attributes: assertion.attributes ?? {},
      confidence: clampConfidence(assertion.confidence ?? this.confidenceFor(assertion.origin)),
      decay: this.decayFor(assertion.origin, assertion.halfLifeMs),
      support: initialSupport(at, evidence.length, evidence.length === 0 ? 0 : 1),
      evidence: [...evidence],
      origin: assertion.origin,
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
  async relate(input: MemoryRelationInput): Promise<MemoryEdge> {
    const claim = input.claim.trim()
    if (claim.length === 0) {
      throw new MemoryError('invalid-input', 'a memory relation needs a non-empty claim')
    }
    for (const endpoint of [input.from, input.to]) {
      if (this.store.getNode(endpoint) === undefined) {
        throw new MemoryError('unknown-item', `memory node '${endpoint}' does not exist`)
      }
    }
    const scope = memoryScopeKey(input.scope)
    const at = input.at ?? Date.now()
    const evidence = input.evidence ?? []
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
      status: 'active',
      createdAt: at,
      updatedAt: at,
    }
    await this.store.putEdge(edge)
    this.ctx.emit('memory/edge-changed', edge, undefined)
    return edge
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
   * out of recall without any expiry pass having run.
   * @param query - the cue, scope chain, and filters.
   * @returns the ranked cues.
   * @throws `no-store` when nothing is mounted.
   */
  async recall(query: MemoryQuery): Promise<MemoryRecall> {
    const store = this.store
    const now = query.now ?? Date.now()
    const limit = query.limit ?? this.config.recallLimit
    const scopes = scopeKeys(query.scopes)
    const terms = tokenize(query.text)

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
    const lexicalRecords = bm25Rank(terms, records.map(record => ({ item: record, terms: record.terms })))

    const vectorRecords = await this.vectorRank(query, records)
    const fusedRecords = reciprocalRankFusion<MemoryRecord>(
      [lexicalRecords.map(entry => entry.item), vectorRecords.map(entry => entry.item)],
      record => record.id,
    )
    const activation = this.spreadActivation(lexicalNodes, fusedRecords, edges, nodeById)

    const lexicalNodePositions = rankPositions(lexicalNodes, node => node.id)
    const lexicalEdgePositions = rankPositions(lexicalEdges, edge => edge.id)
    const lexicalRecordPositions = rankPositions(lexicalRecords, record => record.id)
    const vectorPositions = rankPositions(vectorRecords, record => record.id)

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
      const base = lexicalPosition === undefined ? 0 : 1 / (1 + lexicalPosition)
      cues.push({ kind: 'node', node, score: (base + activated) * (0.5 + 0.5 * node.confidence), signals })
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
      const base = lexicalPosition === undefined ? 0 : 1 / (1 + lexicalPosition)
      const endpoints = [nodeById.get(edge.from), nodeById.get(edge.to)].filter(
        (node): node is MemoryNode => node !== undefined,
      )
      cues.push({
        kind: 'edge',
        edge,
        endpoints,
        score: (base + endpointActivation * this.config.activationFalloff) * (0.5 + 0.5 * edge.confidence),
        signals,
      })
    }
    for (const fused of fusedRecords) {
      const record = fused.item
      const signals: MemorySignal[] = []
      const lexicalPosition = lexicalRecordPositions.get(record.id)
      if (lexicalPosition !== undefined) {
        signals.push({ kind: 'lexical', rank: lexicalPosition, value: lexicalRecords[lexicalPosition]?.score ?? 0 })
      }
      const vectorPosition = vectorPositions.get(record.id)
      if (vectorPosition !== undefined) {
        signals.push({ kind: 'vector', rank: vectorPosition, value: vectorRecords[vectorPosition]?.score ?? 0 })
      }
      // Layer-0 records carry no belief, so recency stands in for confidence:
      // an old episode is not wrong, only less likely to be what was meant.
      const recency = decayedConfidence(1, this.config.inferredHalfLifeMs, record.createdAt, now)
      signals.push({ kind: 'recency', value: recency })
      cues.push({ kind: 'record', record, score: fused.score * (0.5 + 0.5 * recency), signals })
    }

    cues.sort((left, right) => right.score - left.score)
    const recall: MemoryRecall = {
      query: query.text,
      cues: cues.slice(0, limit),
      truncated: cues.length > limit,
      semantic: vectorRecords.length > 0,
    }
    this.ctx.emit('memory/recalled', recall, query)
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
    const nodes = ranked.slice(0, limit)
    const included = new Set(nodes.map(node => node.id))
    const edges = [...store.edges(keys)]
      .filter(edge => edge.status === 'active' && included.has(edge.from) && included.has(edge.to))
      .map(edge => this.applyDecayEdge(edge, now))
    return { nodes, edges, total: ranked.length }
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
    const store = this.store
    const previous = store.getNode(outdated)
    const next = store.getNode(replacement)
    if (previous === undefined || next === undefined) {
      throw new MemoryError('unknown-item', `memory supersession needs two existing nodes, got '${outdated}' and '${replacement}'`)
    }
    const at = Date.now()
    const tombstoned: MemoryNode = { ...previous, status: 'superseded', supersededBy: replacement, updatedAt: at }
    await store.putNode(tombstoned)
    this.ctx.emit('memory/node-changed', tombstoned, previous)
    await this.relate({
      scope: { kind: 'user' },
      from: replacement,
      to: outdated,
      relation: 'supersedes',
      claim: `${next.label} replaces the earlier belief ${previous.label}`,
      origin: 'inferred',
      at,
    })
  }

  /**
   * Erase one layer-0 record and drop every citation of it.
   *
   * Unlike retraction this is irreversible, which is the point: it exists so a
   * user asking for material to be deleted gets deletion rather than a hidden
   * copy. Layer-1 items keep their belief but lose that piece of evidence; a
   * later sweep retires whatever no longer stands up.
   * @param id - the record to erase.
   * @returns whether a record existed to erase.
   */
  async forget(id: MemoryRecord['id']): Promise<boolean> {
    const store = this.store
    const record = store.getRecord(id)
    if (record === undefined) return false
    for (const node of store.nodes([record.scope])) {
      if (!node.evidence.includes(id)) continue
      await store.putNode({ ...node, evidence: node.evidence.filter(cited => cited !== id) })
    }
    for (const edge of store.edges([record.scope])) {
      if (!edge.evidence.includes(id)) continue
      await store.putEdge({ ...edge, evidence: edge.evidence.filter(cited => cited !== id) })
    }
    return store.eraseRecord(id)
  }

  /**
   * Run every mounted distiller over the unconsolidated layer-0 window of one
   * scope and merge their proposals into the graph.
   *
   * Proposals are merged, never appended: a node whose label already exists is
   * reinforced, which is what turns a repeated behavior into a confident belief
   * instead of a pile of duplicates. A record is marked promoted once a proposal
   * cites it, so the next pass reads only what is new.
   * @param scope - the partition to consolidate.
   * @param options - optional clock reading and cancellation.
   * @returns what the pass changed.
   * @throws `no-store` when nothing is mounted.
   */
  async consolidate(
    scope: MemoryScope,
    options?: { now?: number; signal?: AbortSignal },
  ): Promise<MemoryMaintenanceReport> {
    const store = this.store
    const key = memoryScopeKey(scope)
    const at = options?.now ?? Date.now()
    const pending = [...store.records([key])].filter(
      record => record.status === 'active' && record.promotedTo.length === 0,
    )
    let nodesCreated = 0
    let nodesReinforced = 0
    let edgesCreated = 0
    let edgesReinforced = 0
    if (pending.length === 0) {
      return { examined: 0, nodesCreated, nodesReinforced, edgesCreated, edgesReinforced, retired: 0, evicted: 0 }
    }
    const distillers = [...this.distillerProviders].sort((left, right) => left.rank - right.rank)
    const cited = new Set<string>()
    for (const distiller of distillers) {
      const existing = [...store.nodes([key])].filter(node => node.status === 'active')
      const distillation = await distiller.distill({
        scope: key,
        records: pending,
        existing,
        ...options?.signal === undefined ? {} : { signal: options.signal },
      })
      const byLabel = new Map<string, MemoryNode>()
      for (const candidate of distillation.nodes) {
        const merged = await this.mergeCandidateNode(scope, candidate, at)
        byLabel.set(candidate.label, merged.node)
        if (merged.created) nodesCreated++
        else nodesReinforced++
        for (const evidence of candidate.evidence) cited.add(evidence)
      }
      for (const candidate of distillation.edges) {
        const merged = await this.mergeCandidateEdge(scope, candidate, byLabel, key, at)
        if (merged === undefined) continue
        if (merged.created) edgesCreated++
        else edgesReinforced++
        for (const evidence of candidate.evidence) cited.add(evidence)
      }
    }
    for (const record of pending) {
      if (!cited.has(record.id)) continue
      await store.putRecord({ ...record, promotedTo: [...record.promotedTo, 'consolidated'] })
    }
    return {
      examined: pending.length,
      nodesCreated,
      nodesReinforced,
      edgesCreated,
      edgesReinforced,
      retired: 0,
      evicted: 0,
    }
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
    const store = this.store
    const keys = scopeKeys(scopes)
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

  /** Rank records by cosine similarity against the query embedding, when an embedder is mounted. */
  private async vectorRank(query: MemoryQuery, records: readonly MemoryRecord[]): Promise<ScoredItem<MemoryRecord>[]> {
    const embedder = this.embedderProvider
    if (embedder === undefined || query.text.trim().length === 0) return []
    const comparable = records.filter(
      record => record.embedding !== undefined && record.embedding.model === embedder.name,
    )
    if (comparable.length === 0) return []
    const embedded = await embedder.embed(
      [query.text],
      query.signal === undefined ? undefined : { signal: query.signal },
    )
    const vector = embedded[0]
    if (vector === undefined) return []
    const ranked: ScoredItem<MemoryRecord>[] = []
    for (const record of comparable) {
      const stored = record.embedding
      if (stored === undefined) continue
      const score = cosineSimilarity([...vector], stored.vector)
      if (score > 0) ranked.push({ item: record, score })
    }
    ranked.sort((left, right) => right.score - left.score)
    return ranked
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
      if (entry !== undefined) seed(entry.item.id, 1 / (1 + index))
    }
    const citedRecords = new Set(fusedRecords.slice(0, 10).map(entry => entry.item.id))
    for (const node of nodeById.values()) {
      if (node.evidence.some(id => citedRecords.has(id))) seed(node.id, this.config.activationFalloff)
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
  ): Promise<{ node: MemoryNode; created: boolean }> {
    if (candidate.evidence.length === 0) {
      throw new MemoryError('invalid-input', `distilled node '${candidate.label}' cites no evidence`)
    }
    const existed = this.findNode(memoryScopeKey(scope), candidate.type, candidate.label.trim()) !== undefined
    const node = await this.assert({
      scope,
      type: candidate.type,
      label: candidate.label,
      summary: candidate.summary,
      origin: 'inferred',
      confidence: candidate.confidence,
      evidence: candidate.evidence,
      at,
      ...candidate.attributes === undefined ? {} : { attributes: candidate.attributes },
    })
    return { node, created: !existed }
  }

  /** Merge one proposed edge, resolving endpoints by label first among this pass's nodes. */
  private async mergeCandidateEdge(
    scope: MemoryScope,
    candidate: MemoryCandidateEdge,
    byLabel: ReadonlyMap<string, MemoryNode>,
    key: MemoryScopeKey,
    at: number,
  ): Promise<{ created: boolean } | undefined> {
    const from = byLabel.get(candidate.from) ?? this.findNodeByLabel(key, candidate.from)
    const to = byLabel.get(candidate.to) ?? this.findNodeByLabel(key, candidate.to)
    // A distiller may name an endpoint it did not also propose. Skipping keeps a
    // partially-grounded distillation useful instead of failing the whole pass.
    if (from === undefined || to === undefined) return undefined
    const existed = this.findEdge(key, from.id, to.id, candidate.relation) !== undefined
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
    return { created: !existed }
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
