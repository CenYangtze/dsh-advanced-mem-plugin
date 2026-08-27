/**
 * The behavior-cycle distiller: turns repeated actions in the layer-0 substrate
 * into layer-1 affinities, procedures, and the relations between them.
 *
 * It uses no model. Frequency, recurrence, and adjacency are the whole of its
 * reasoning, which is what makes it deterministic, free to run on every turn
 * boundary, and impossible to hallucinate with. A model-backed distiller mounted
 * beside it proposes the things frequency cannot see — why a preference exists,
 * what a request was really about — and both merge through the same
 * reinforcement path on the hub.
 *
 * @module dsh-advanced-mem-plugin/src/memory-consolidation/distiller
 */

import type {
  MemoryCandidateEdge,
  MemoryCandidateNode,
  MemoryDistillation,
  MemoryDistillInput,
  MemoryDistiller,
  MemoryRecord,
  MemoryRecordId,
} from '../memory/index.ts'

/** Tunables of the frequency miner, all supplied by the plugin configuration. */
export interface DistillerPolicy {
  /** Repeats before a usage becomes a belief rather than a coincidence. */
  readonly minObservations: number
  /** Observation count at which confidence approaches its ceiling. */
  readonly observationSaturation: number
  /** Ceiling for a belief derived from frequency alone; never 1, because counting is not knowing. */
  readonly maxConfidence: number
  /** Shortest action sequence considered a procedure. */
  readonly minSequenceLength: number
  /** Longest action sequence considered a procedure. */
  readonly maxSequenceLength: number
  /** Times a sequence must recur before it is proposed as a procedure. */
  readonly minSequenceRepeats: number
}

/**
 * Map an observation count onto a belief.
 *
 * Saturating exponential: the second observation of a behavior says far more
 * than the twentieth, and no count ever reaches certainty, because frequency
 * evidence cannot rule out that the next interaction contradicts it.
 * @param count - observations supporting the belief.
 * @param policy - saturation rate and ceiling.
 * @returns the belief in the closed unit interval.
 */
export function frequencyConfidence(count: number, policy: DistillerPolicy): number {
  return policy.maxConfidence * (1 - Math.exp(-count / policy.observationSaturation))
}

/** One mined action with the records that witnessed it. */
interface ActionTally {
  /** Distinct records witnessing the action. */
  readonly evidence: MemoryRecordId[]
  /** Sessions the evidence spans; a behavior seen in one session is weaker. */
  readonly sessions: Set<string>
}

/** Accumulate one witnessed action into a tally table. */
function tally(table: Map<string, ActionTally>, key: string, record: MemoryRecord): void {
  let entry = table.get(key)
  if (entry === undefined) {
    entry = { evidence: [], sessions: new Set<string>() }
    table.set(key, entry)
  }
  entry.evidence.push(record.id)
  const sessionId = record.provenance.sessionId
  if (sessionId !== undefined) entry.sessions.add(sessionId)
}

/**
 * The action a record witnessed, or `undefined` when it witnesses none.
 *
 * Tool invocations name their tool in provenance. Skill invocations name their
 * skill when the producer knew it, and otherwise fall back to the first line of
 * the injected body, which is where a skill's own name appears.
 * @param record - the layer-0 record.
 * @returns the action key, prefixed by its kind so a tool and a skill of the same name stay distinct.
 */
export function actionOf(record: MemoryRecord): string | undefined {
  if (record.kind === 'tool-invocation') {
    const tool = record.provenance.tool
    return tool === undefined ? undefined : `tool:${tool}`
  }
  if (record.kind === 'skill-invocation') {
    const skill = record.provenance.skill ?? record.text.split('\n', 1)[0]?.trim()
    return skill === undefined || skill.length === 0 ? undefined : `skill:${skill}`
  }
  return undefined
}

/** Split an action key back into its kind and name. */
function splitAction(key: string): { kind: 'tool' | 'skill'; name: string } {
  const separator = key.indexOf(':')
  const kind = key.slice(0, separator)
  return { kind: kind === 'skill' ? 'skill' : 'tool', name: key.slice(separator + 1) }
}

/**
 * Order the actions of one window into per-turn sequences.
 *
 * A procedure is a thing done in one sitting, so sequences never span turns: a
 * tool used at the end of one turn and another at the start of the next were not
 * a two-step routine, they were two separate decisions.
 * @param records - the layer-0 window, in capture order.
 * @returns one action sequence per turn that produced at least one action.
 */
export function actionSequences(records: readonly MemoryRecord[]): { actions: string[]; records: MemoryRecordId[] }[] {
  const byTurn = new Map<string, { actions: string[]; records: MemoryRecordId[] }>()
  for (const record of records) {
    const action = actionOf(record)
    if (action === undefined) continue
    const key = `${record.provenance.sessionId ?? ''}#${record.provenance.turn ?? -1}`
    let sequence = byTurn.get(key)
    if (sequence === undefined) {
      sequence = { actions: [], records: [] }
      byTurn.set(key, sequence)
    }
    sequence.actions.push(action)
    sequence.records.push(record.id)
  }
  return [...byTurn.values()]
}

/** Propose affinity nodes for actions that cleared the repeat threshold. */
function affinityNodes(
  records: readonly MemoryRecord[],
  policy: DistillerPolicy,
): { nodes: MemoryCandidateNode[]; labels: Map<string, string> } {
  const table = new Map<string, ActionTally>()
  for (const record of records) {
    const action = actionOf(record)
    if (action !== undefined) tally(table, action, record)
  }
  const nodes: MemoryCandidateNode[] = []
  const labels = new Map<string, string>()
  for (const [key, entry] of table) {
    if (entry.evidence.length < policy.minObservations) continue
    const { kind, name } = splitAction(key)
    labels.set(key, name)
    nodes.push({
      type: kind === 'skill' ? 'skill-affinity' : 'tool-affinity',
      label: name,
      summary: kind === 'skill'
        ? `Reaches for the ${name} skill; used ${entry.evidence.length} times across ${entry.sessions.size} sessions.`
        : `Works through the ${name} tool; called ${entry.evidence.length} times across ${entry.sessions.size} sessions.`,
      attributes: { uses: entry.evidence.length, sessions: entry.sessions.size },
      confidence: frequencyConfidence(entry.evidence.length, policy),
      evidence: entry.evidence,
    })
  }
  return { nodes, labels }
}

/** Propose procedure nodes for action sequences that recurred. */
function procedureNodes(
  records: readonly MemoryRecord[],
  policy: DistillerPolicy,
): MemoryCandidateNode[] {
  const sequences = actionSequences(records)
  const grams = new Map<string, { steps: string[]; evidence: Set<MemoryRecordId>; count: number }>()
  for (const sequence of sequences) {
    for (let length = policy.minSequenceLength; length <= policy.maxSequenceLength; length++) {
      for (let start = 0; start + length <= sequence.actions.length; start++) {
        const steps = sequence.actions.slice(start, start + length)
        const key = steps.join(' > ')
        let entry = grams.get(key)
        if (entry === undefined) {
          entry = { steps, evidence: new Set<MemoryRecordId>(), count: 0 }
          grams.set(key, entry)
        }
        entry.count++
        for (const id of sequence.records.slice(start, start + length)) entry.evidence.add(id)
      }
    }
  }
  const nodes: MemoryCandidateNode[] = []
  for (const [key, entry] of grams) {
    if (entry.count < policy.minSequenceRepeats) continue
    const steps = entry.steps.map(step => splitAction(step).name)
    nodes.push({
      type: 'procedure',
      label: key,
      summary: `Repeated routine: ${steps.join(' then ')}. Observed ${entry.count} times.`,
      attributes: { steps, occurrences: entry.count },
      confidence: frequencyConfidence(entry.count, policy),
      evidence: [...entry.evidence],
    })
  }
  return nodes
}

/**
 * Propose the relations the mined nodes imply: each procedure is composed of the
 * actions it runs, and consecutive actions co-occur.
 */
function relationEdges(
  procedures: readonly MemoryCandidateNode[],
  affinityLabels: ReadonlySet<string>,
): MemoryCandidateEdge[] {
  const edges: MemoryCandidateEdge[] = []
  for (const procedure of procedures) {
    const steps = procedure.attributes?.['steps']
    if (!Array.isArray(steps)) continue
    let previous: string | undefined
    for (const step of steps) {
      if (typeof step !== 'string') continue
      if (affinityLabels.has(step)) {
        edges.push({
          from: step,
          to: procedure.label,
          relation: 'part-of',
          claim: `${step} is a step of the routine ${procedure.label}.`,
          confidence: procedure.confidence,
          evidence: procedure.evidence,
        })
      }
      if (previous !== undefined && affinityLabels.has(previous) && affinityLabels.has(step)) {
        edges.push({
          from: previous,
          to: step,
          relation: 'co-occurs',
          claim: `${previous} is habitually followed by ${step}.`,
          confidence: procedure.confidence,
          evidence: procedure.evidence,
        })
      }
      previous = step
    }
  }
  return edges
}

/** The frequency miner as a mountable distiller. */
export class BehaviorCycleDistiller implements MemoryDistiller {
  /** Provider name, attributed on the proposals it makes. */
  readonly name = 'behavior-cycle'

  /**
   * @param rank - ordering among mounted distillers; this one runs first because it is cheap and deterministic.
   * @param policy - the mining thresholds from the plugin configuration.
   */
  constructor(readonly rank: number, private readonly policy: DistillerPolicy) {}

  /**
   * Mine one window of layer-0 records.
   * @param input - the window and the graph around it.
   * @returns the proposed affinities, procedures, and their relations.
   */
  distill(input: MemoryDistillInput): Promise<MemoryDistillation> {
    const affinities = affinityNodes(input.records, this.policy)
    const procedures = procedureNodes(input.records, this.policy)
    const known = new Set(affinities.labels.values())
    // Nodes the graph already holds count as resolvable endpoints, so a routine
    // observed today can attach to an affinity mined last week.
    for (const node of input.existing) known.add(node.label)
    return Promise.resolve({
      nodes: [...affinities.nodes, ...procedures],
      edges: relationEdges(procedures, known),
    })
  }
}
