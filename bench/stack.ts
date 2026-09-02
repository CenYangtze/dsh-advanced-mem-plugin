/**
 * The memory stack under test, with nothing dataset-specific in it.
 *
 * One corpus at a time: boot, write the documents in, ask the questions, tear
 * down. The database lives in process memory, because a retrieval benchmark
 * measures what comes back rather than what survives a restart, and a corpus
 * per question is the only way LongMemEval's 247,000 turns fit anywhere at all.
 *
 * Everything below the seam is the shipped plugin — the hub, the durable store
 * over the storage-domain layer, and the feature-hash embedder. What the runner
 * adds is a document-id map, so a returned cue can be traced back to the corpus
 * item it came from and scored against the dataset's own evidence labels.
 *
 * @module dsh-advanced-mem-plugin/bench/stack
 */

import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import * as storageSqlite from '@deepseek-ai/dsh-storage-sqlite'
import * as storageDomain from '@deepseek-ai/dsh-storage-domain'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import MemoryRuntime from '../src/memory/index.ts'
import type { Config as MemoryConfig, MemoryCue, MemoryScope } from '../src/memory/index.ts'
import * as storeDomain from '../src/memory-store-domain/index.ts'
import * as embeddingHash from '../src/memory-embedding-hash/index.ts'
import { ApiEmbedder } from './embedding-api.ts'
import type { Config as ApiEmbedderConfig } from './embedding-api.ts'
import * as consolidation from '../src/memory-consolidation/index.ts'
import type { BenchDocument } from './suites/types.ts'

/** How a stack is configured for a run. */
export interface StackOptions {
  /** Cues per recall — the answer budget a turn would get. */
  readonly recallLimit: number
  /** Feature-hash width, or `0` to run lexically with no vector signal. */
  readonly dimensions: number
  /**
   * Let `evidence`-use records be quoted back.
   *
   * Off is the shipped behaviour. On these datasets it matters more than it
   * looks: an assistant turn is `evidence` by author, so a benchmark whose gold
   * evidence sits in assistant replies is partly unanswerable with it off. The
   * flag is how that cost gets measured rather than argued about.
   */
  readonly includeEvidence: boolean
  /**
   * Run the behaviour-cycle distiller over the corpus after ingest, so the
   * layer-1 graph participates in retrieval.
   *
   * Off by default, and the default is a measurement decision rather than a
   * shortcut: scoring is by attribution, and a derived node fuses evidence from
   * several documents while the harness can only credit it with one. A run with
   * this on is answering "does the graph help here", not "how precisely is
   * material found".
   */
  readonly consolidate: boolean
  /**
   * Weight of the vector ranking against the lexical one in fusion.
   *
   * Exposed so a run can price the embedder rather than argue about it: the
   * whole difference between a hybrid and a lexical configuration is this
   * number.
   */
  readonly vectorWeight: number
  /**
   * A trained encoder to mount instead of the feature-hash one.
   *
   * The hash provider and the seam it sits in are two different claims. Mounting
   * a real encoder here is how the second one gets tested: same fusion, same
   * ranking, same everything else — only the vector signal changes.
   */
  readonly apiEmbedder?: ApiEmbedderConfig
}

/** One corpus loaded into a live stack. */
export class MemoryStack {
  /** Record id → document id, so a cue can be scored against the dataset's labels. */
  private readonly origin = new Map<string, string>()
  /** Document id -> record id, so a forget request can name the thing to drop. */
  private readonly recordOf = new Map<string, string>()
  private readonly scope: MemoryScope = { kind: 'workspace', workspace: '/bench' }
  private written = 0

  private constructor(
    private readonly ctx: Context,
    private readonly options: StackOptions,
    private readonly embedder?: ApiEmbedder,
  ) {}

  /**
   * Boot a stack over an in-process database.
   * @param options - the run configuration.
   * @returns the mounted stack, ready to ingest one corpus.
   */
  static async create(options: StackOptions): Promise<MemoryStack> {
    const ctx = new Context()
    await ctx.plugin(Storage)
    await ctx.plugin(storageSqlite, { path: ':memory:', journalMode: 'wal' })
    await ctx.plugin(storageDomain, { backend: 'sqlite', routes: {} })
    await ctx.plugin(SessionStore)
    await ctx.plugin(MemoryRuntime, hubConfig(options))
    await ctx.plugin(storeDomain)
    let embedder: ApiEmbedder | undefined
    if (options.apiEmbedder !== undefined) {
      embedder = new ApiEmbedder(options.apiEmbedder)
      ctx.memory.registerEmbedder(embedder)
    } else if (options.dimensions > 0) {
      await ctx.plugin(embeddingHash, { dimensions: options.dimensions })
    }
    if (options.consolidate) {
      await ctx.plugin(consolidation, {
        minObservations: 3,
        observationSaturation: 6,
        maxConfidence: 0.85,
        minSequenceLength: 2,
        maxSequenceLength: 4,
        minSequenceRepeats: 3,
    minStatements: 1,
    minSubjectLength: 3,
    maxSubjectLength: 60,
        // Passes are driven explicitly below; a benchmark has no turns to count.
        consolidateEveryTurns: 1_000_000,
        sweepEveryTurns: 1_000_000,
      })
    }
    return new MemoryStack(ctx, options, embedder)
  }

  /**
   * Write one corpus in.
   *
   * Documents arrive already classified by the suite, because who authored a
   * line is a property of the dataset and not something this layer should guess.
   * @param documents - the corpus, in the order it happened.
   */
  async ingest(documents: readonly BenchDocument[]): Promise<void> {
    // The hub embeds one record at a time inside `remember`. Filling the cache
    // for the whole corpus first turns that into a map lookup; without it a
    // corpus costs one HTTP round trip per document.
    await this.embedder?.prewarm(documents.map(document => document.text.slice(0, 4000)))
    for (const document of documents) {
      if (document.text.trim().length === 0) continue
      const record = await this.ctx.memory.remember({
        scope: this.scope,
        kind: document.kind,
        text: document.text.slice(0, 4000),
        fidelity: 'verbatim',
        provenance: {
          sessionId: SessionId(document.session ?? 'corpus'),
          turn: document.turn ?? 1,
        },
        ...(document.at === undefined ? {} : { at: document.at }),
      })
      this.origin.set(record.id, document.id)
      this.recordOf.set(document.id, record.id)
      this.written += 1
    }
  }

  /**
   * Ask one question and report which corpus documents came back, in order.
   * @param query - the question text.
   * @param now - clock reading for decay, so a dated corpus ranks reproducibly.
   * @returns the document ids behind the returned cues, best first, deduplicated.
   */
  async retrieve(query: string, now?: number): Promise<{ documents: string[]; ms: number; semantic: boolean }> {
    const started = performance.now()
    const recall = await this.ctx.memory.recall({
      text: query,
      scopes: [this.scope],
      limit: this.options.recallLimit,
      ...(this.options.includeEvidence ? { includeEvidence: true } : {}),
      ...(now === undefined ? {} : { now }),
    })
    const ms = performance.now() - started
    const documents: string[] = []
    const seen = new Set<string>()
    for (const cue of recall.cues) {
      const id = this.documentOf(cue)
      if (id === undefined || seen.has(id)) continue
      seen.add(id)
      documents.push(id)
    }
    return { documents, ms, semantic: recall.semantic }
  }

  /** Trace a cue back to the corpus document behind it, when there is one. */
  private documentOf(cue: MemoryCue): string | undefined {
    if (cue.kind === 'record') return this.origin.get(cue.record.id)
    // A layer-1 cue stands for the records it cites; credit the first, since a
    // node retrieved on behalf of its evidence did retrieve that evidence.
    const evidence = cue.kind === 'node' ? cue.node.evidence : []
    for (const id of evidence) {
      const document = this.origin.get(id)
      if (document !== undefined) return document
    }
    return undefined
  }

  /**
   * Run the distiller over everything ingested, when the run asked for it.
   * @returns how many layer-1 nodes and edges the passes created.
   */
  async distil(): Promise<{ nodes: number; edges: number }> {
    if (!this.options.consolidate) return { nodes: 0, edges: 0 }
    const report = await this.ctx.memory.consolidate(this.scope)
    return { nodes: report.nodesCreated, edges: report.edgesCreated }
  }

  /**
   * Drop one ingested document from memory, by the corpus id it was written under.
   *
   * This is the plugin's own `forget` path, not a filter bolted onto the harness:
   * a benchmark that scores forgetting has to exercise the retraction the system
   * actually ships, or it is measuring whether the retriever happened to miss the
   * record instead of whether the system honoured the request.
   * @param documentId - the corpus id to retract.
   * @returns whether a record was removed.
   */
  async forgetDocument(documentId: string): Promise<boolean> {
    const record = this.recordOf.get(documentId)
    if (record === undefined) return false
    return this.ctx.memory.forget(record as Parameters<typeof this.ctx.memory.forget>[0])
  }

  /**
   * Fill the vector cache for texts the run will embed later — the questions.
   *
   * Recall embeds its query text one call at a time, so without this a run pays
   * one round trip per question on top of one per document.
   * @param texts - the query texts.
   */
  async prewarm(texts: readonly string[]): Promise<void> {
    await this.embedder?.prewarm(texts)
  }

  /** Requests and texts the embedder spent, when one is mounted. */
  get embedderStats(): { requests: number; texts: number; cached: number } | undefined {
    return this.embedder?.stats
  }

  /** How many records the corpus produced. */
  get records(): number {
    return this.written
  }

  /** Tear the registry down. */
  async dispose(): Promise<void> {
    await this.ctx.fiber.dispose()
  }
}

/**
 * The hub configuration a retrieval run uses.
 *
 * The shipped bundle's values with erosion switched off and the record budget
 * raised past any corpus here. Both exist to stop the runtime editing the corpus
 * mid-run: a sweep that retired or evicted anything would make the score depend
 * on ingest order rather than on retrieval.
 * @param options - the run configuration.
 * @returns the hub config.
 */
function hubConfig(options: StackOptions): MemoryConfig {
  return {
    recallLimit: options.recallLimit,
    profileLimit: 12,
    inferredConfidence: 0.4,
    assertedConfidence: 0.9,
    inferredHalfLifeMs: 0,
    assertedHalfLifeMs: 0,
    reinforcementRate: 0.25,
    contradictionRate: 0.5,
    retirementFloor: 0.05,
    activationHops: 2,
    activationFalloff: 0.45,
    recordBudget: 1_000_000,
    supportWeight: 0,
    duplicateThreshold: 0.8,
    diversityThreshold: 0.7,
    vectorWeight: options.vectorWeight,
  }
}
