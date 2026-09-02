/**
 * The system under test: this plugin's memory stack, wired headlessly and given
 * the two operations a memory benchmark needs — ingest a history, answer a
 * question.
 *
 * Everything below the seam is the shipped code. The hub, the durable store, the
 * embedder and the behaviour-cycle distiller are the same plugin bodies a real
 * profile loads, mounted on a real Cordis registry over a temporary storage
 * root; the answer text is produced by the recall plugin's own `renderCue`, so
 * what the judge reads is character-for-character what a model would have been
 * shown. A benchmark that renders its own answers measures the benchmark.
 *
 * What is *not* shipped code is the ingest policy: how a dataset's event chain
 * maps onto record kinds and node types. That mapping is stated here, in one
 * place, because it is the load-bearing assumption of every number this produces.
 *
 * @module dsh-advanced-mem-plugin/bench/adapter
 */

import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import * as storageSqlite from '@deepseek-ai/dsh-storage-sqlite'
import * as storageDomain from '@deepseek-ai/dsh-storage-domain'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import MemoryRuntime from '../src/memory/index.ts'
import type {
  Config as MemoryConfig,
  MemoryCue,
  MemoryNodeId,
  MemoryNodeType,
  MemoryRecordId,
  MemoryScope,
} from '../src/memory/index.ts'
import * as storeDomain from '../src/memory-store-domain/index.ts'
import * as embeddingHash from '../src/memory-embedding-hash/index.ts'
import * as consolidation from '../src/memory-consolidation/index.ts'
import { renderCue } from '../src/memory-recall/index.ts'
import type { KylinGoldMemory, KylinInstance } from './dataset.ts'
import type { KylinQa } from './qa.ts'

/**
 * How much of the pipeline a run exercises.
 *
 * `gold` writes the dataset's distilled memory in as a layer-1 belief and so
 * measures retrieval alone — the ceiling this system can reach on this dataset.
 * `raw` writes only the history events and lets the shipped distiller decide
 * what is worth believing, which is the end-to-end score. `off` writes nothing
 * and is the floor the dataset calls `blank`; any gap above it is what memory
 * is worth.
 */
export type IngestMode = 'gold' | 'raw' | 'off'

/**
 * How many other memories a question has to be answered against.
 *
 * This is the single most consequential knob in the harness. `instance` gives
 * every instance a private scope, so recall picks the right memory out of one —
 * a wiring check, not a score. `repo` matches the dataset's own repo-pair
 * construction: the memory competes with every other memory from that
 * repository. `global` puts every instance in one scope. Report which one ran.
 */
export type Isolation = 'instance' | 'repo' | 'global'

/** How a run is configured. */
export interface BenchOptions {
  readonly mode: IngestMode
  readonly isolation: Isolation
  /** Directory holding the run's SQLite database; removed by the caller. */
  readonly root: string
  /** Cues per recall. The dataset asks one question at a time, so this is the whole answer budget. */
  readonly recallLimit: number
  /** Feature-hash width, or `0` to run lexically with no vector signal. */
  readonly dimensions: number
  /**
   * Let `evidence`-use records be quoted back.
   *
   * Off is the shipped behaviour and the reason this system does not read its
   * own tool calls back to itself. Turning it on is how you price that rule:
   * this dataset's tool events name the files a fix touched, which is exactly
   * what the judge counts, so the delta between the two runs is the benchmark
   * score this system deliberately declines to collect.
   */
  readonly includeEvidence: boolean
  /**
   * Run the distiller after ingest, in `raw` mode.
   *
   * On by default, because a `raw` run is meant to be end to end. Turning it off
   * leaves the layer-0 substrate alone, which is the only way to observe the
   * evidence rule on this dataset: with the behaviour graph present, all eight
   * cue slots go to tool habits and no record of either use reaches the answer.
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
  /** Exposed so the support boost can be priced against lexical rank. */
  readonly supportWeight: number
}

/** What one answered question cost and produced. */
export interface AnswerRecord {
  readonly qa_id: string
  readonly instance_id: string
  readonly dimension: string
  readonly answer: string
  /** Cues returned, before rendering. */
  readonly cues: number
  /** 1-based position of the first cue traceable to this instance, or `null` when none came back. */
  readonly goldRank: number | null
  /** Whether a vector signal participated. */
  readonly semantic: boolean
  /** Wall time of the recall call, in milliseconds. */
  readonly ms: number
}

/**
 * The dataset's memory taxonomy, mapped onto this system's node types.
 *
 * `repo_gotcha` and `env_gotcha` are both rules that constrain how work is done
 * here, `workflow` is a recurring way of working, and a `skill` is a reusable
 * sequence — which is what `procedure` holds. `knowledge_update` becomes an
 * `entity`: it states what a thing in the repository is *now*, and the
 * supersession it implies is an edge, not a type.
 */
const NODE_TYPE: Readonly<Record<KylinGoldMemory['type'], MemoryNodeType>> = {
  preference: 'preference',
  workflow: 'routine',
  repo_gotcha: 'constraint',
  env_gotcha: 'constraint',
  skill: 'procedure',
  knowledge_update: 'entity',
}

/** Take the first line of an issue body as the belief's canonical label. */
function labelOf(instance: KylinInstance): string {
  const first = instance.history_session.issue.split('\n')[0]?.trim() ?? ''
  const label = first.length > 0 ? first : instance.instance_id
  return label.length <= 80 ? label : `${label.slice(0, 80)}...`
}

/** Identify a cue for attribution, whatever layer it came from. */
function cueId(cue: MemoryCue): string {
  switch (cue.kind) {
    case 'node': return cue.node.id
    case 'edge': return cue.edge.id
    case 'record': return cue.record.id
  }
}

/** The memory stack under test, with one instance ingested per call. */
export class MemorySystemUnderTest {
  /** Every id this run wrote on behalf of an instance, for ranking attribution. */
  private readonly attribution = new Map<string, Set<string>>()
  /** Scopes touched, so a `raw` run knows what to consolidate. */
  private readonly scopes = new Map<string, MemoryScope>()
  /** Instances whose asserted belief merged into an earlier one, reported rather than hidden. */
  readonly collisions: string[] = []
  /** Layer-0 records written, counted here because the store exposes no total. */
  private recordsWritten = 0

  private constructor(
    private readonly ctx: Context,
    private readonly options: BenchOptions,
  ) {}

  /**
   * Boot the stack.
   * @param options - the run configuration.
   * @returns a mounted system, ready to ingest.
   */
  static async create(options: BenchOptions): Promise<MemorySystemUnderTest> {
    const ctx = new Context()
    await ctx.plugin(Storage)
    // SQLite rather than the JSON backend: the JSON unit republishes the whole
    // file on every write, which turns a 9,000-record ingest into quadratic
    // work. The store above it is the shipped one either way.
    await ctx.plugin(storageSqlite, { path: join(options.root, 'memory.db'), journalMode: 'wal' })
    await ctx.plugin(storageDomain, { backend: 'sqlite', routes: {} })
    await ctx.plugin(SessionStore)
    await ctx.plugin(MemoryRuntime, memoryConfig(options))
    await ctx.plugin(storeDomain)
    if (options.dimensions > 0) await ctx.plugin(embeddingHash, { dimensions: options.dimensions })
    // Mounted for its distiller registration; passes are driven explicitly by
    // `consolidate()` rather than by the turn counter, because a benchmark has
    // no turns to count.
    if (options.mode === 'raw' && options.consolidate) await ctx.plugin(consolidation, distillerConfig())
    return new MemorySystemUnderTest(ctx, options)
  }

  /** The scope an instance's memory lives in, per the run's isolation setting. */
  scopeOf(instance: KylinInstance): MemoryScope {
    const workspace = this.options.isolation === 'instance'
      ? `/kylin/${instance.instance_id}`
      : this.options.isolation === 'repo' ? `/kylin/${instance.repo}` : '/kylin'
    return { kind: 'workspace', workspace }
  }

  /**
   * Write one instance's history into memory.
   *
   * The event chain maps by author, which is the rule the shipped observer uses:
   * the issue text is what a person brought to the agent, so it is a quotable
   * `user-message`; every `tool_call` is the agent's own action, so it is a
   * `tool-invocation` — indexed and ranked, never read back. That second half is
   * why a `raw` run scores below what its tool events would allow: the file
   * paths the judge counts sit inside evidence this system will not quote.
   * @param instance - the instance to ingest.
   */
  async ingest(instance: KylinInstance): Promise<void> {
    if (this.options.mode === 'off') return
    const scope = this.scopeOf(instance)
    this.scopes.set(JSON.stringify(scope), scope)
    const ids = new Set<string>()
    const evidence: MemoryRecordId[] = []
    for (const event of instance.history_session.events) {
      const isTool = event.type === 'tool_call'
      const text = isTool
        ? `${event.tool ?? 'tool'} — ${event.tool_input ?? ''}`.trim()
        : event.content
      if (text.length === 0) continue
      const record = await this.ctx.memory.remember({
        scope,
        kind: isTool ? 'tool-invocation' : 'user-message',
        text: text.slice(0, 4000),
        fidelity: isTool ? 'derived' : 'verbatim',
        // The distiller keys frequency mining on `provenance.tool` and groups
        // sequences by session and turn, so omitting this leaves it nothing to
        // read and `raw` mode silently degrades into layer-0 recall. One
        // instance is one session, and its whole event chain is one sitting:
        // the agent edited and then tested without stopping, which is exactly
        // the unit a procedure is mined from.
        provenance: {
          sessionId: SessionId(instance.instance_id),
          turn: 1,
          eventSeq: event.step,
          ...(isTool && event.tool !== undefined ? { tool: event.tool } : {}),
        },
      })
      ids.add(record.id)
      evidence.push(record.id)
      this.recordsWritten += 1
    }
    if (this.options.mode === 'gold') {
      const node = await this.ctx.memory.assert({
        scope,
        type: NODE_TYPE[instance.gold_memory.type],
        label: labelOf(instance),
        summary: instance.gold_memory.content,
        // The dataset states these as settled repository knowledge, and a decay
        // curve would make the score a function of ingest order rather than of
        // retrieval. `asserted` holds confidence still so the run measures one
        // thing at a time.
        origin: 'asserted',
        evidence,
      })
      if (this.claimed(node.id)) this.collisions.push(instance.instance_id)
      ids.add(node.id)
    }
    this.attribution.set(instance.instance_id, ids)
  }

  /** Whether a node id already belongs to an earlier instance. */
  private claimed(id: MemoryNodeId): boolean {
    for (const ids of this.attribution.values()) if (ids.has(id)) return true
    return false
  }

  /**
   * Run the shipped distiller over everything ingested so far.
   *
   * Only meaningful in `raw` mode: the layer-1 graph such a run is scored on is
   * whatever these passes produce.
   * @returns how many nodes and edges the passes created.
   */
  async consolidate(): Promise<{ nodes: number; edges: number }> {
    let nodes = 0
    let edges = 0
    for (const scope of this.scopes.values()) {
      const report = await this.ctx.memory.consolidate(scope)
      nodes += report.nodesCreated
      edges += report.edgesCreated
      // A derived node cites the records it came from; attribute it to whichever
      // instance wrote those records, so ranking stays measurable in `raw` mode.
      for (const node of this.ctx.memory.profile([scope], { limit: Number.MAX_SAFE_INTEGER }).nodes) {
        for (const ids of this.attribution.values()) {
          if (node.evidence.some(id => ids.has(id))) ids.add(node.id)
        }
      }
    }
    return { nodes, edges }
  }

  /**
   * Answer one question the way a turn would see it.
   * @param qa - the question.
   * @param instance - the instance it was generated from, for scope and attribution.
   * @returns the rendered answer and its retrieval diagnostics.
   */
  async answer(qa: KylinQa, instance: KylinInstance): Promise<AnswerRecord> {
    const started = performance.now()
    const recall = await this.ctx.memory.recall({
      text: qa.question,
      scopes: [this.scopeOf(instance)],
      limit: this.options.recallLimit,
      ...(this.options.includeEvidence ? { includeEvidence: true } : {}),
    })
    const ms = performance.now() - started
    const own = this.attribution.get(qa.instance_id) ?? new Set<string>()
    const position = recall.cues.findIndex(cue => own.has(cueId(cue)))
    return {
      qa_id: qa.qa_id,
      instance_id: qa.instance_id,
      dimension: qa.dimension,
      answer: recall.cues.map(renderCue).join('\n'),
      cues: recall.cues.length,
      goldRank: position < 0 ? null : position + 1,
      semantic: recall.semantic,
      ms,
    }
  }

  /** How much material the run wrote, for the report's header. */
  counts(): { records: number; nodes: number } {
    let nodes = 0
    for (const scope of this.scopes.values()) nodes += this.ctx.memory.profile([scope], { limit: 0 }).total
    return { records: this.recordsWritten, nodes }
  }

  /** Tear the registry down so the storage root can be removed. */
  async dispose(): Promise<void> {
    await this.ctx.fiber.dispose()
  }
}

/**
 * The hub configuration a run uses.
 *
 * These are the shipped bundle's values with two changes, both to stop the
 * runtime from editing the corpus mid-run: no confidence erosion, and a record
 * budget above the largest scope the dataset can produce. A sweep that evicted
 * records would make the score depend on ingest order.
 * @param options - the run configuration.
 * @returns the hub config.
 */
function memoryConfig(options: BenchOptions): MemoryConfig {
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
    supportWeight: options.supportWeight,
    duplicateThreshold: 0.8,
    diversityThreshold: 0.7,
    vectorWeight: options.vectorWeight,
  }
}

/** The shipped distiller policy, with scheduling left inert. */
function distillerConfig(): consolidation.Config {
  return {
    minObservations: 3,
    observationSaturation: 6,
    maxConfidence: 0.85,
    minSequenceLength: 2,
    maxSequenceLength: 4,
    minSequenceRepeats: 3,
    minStatements: 1,
    minSubjectLength: 3,
    maxSubjectLength: 60,
    consolidateEveryTurns: 1_000_000,
    sweepEveryTurns: 1_000_000,
  }
}
