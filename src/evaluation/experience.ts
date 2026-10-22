import { ExperienceMemory } from '../experience/core.ts'
import type { ExperienceEnvironment, ExperiencePolicy, ExperienceRecallHit, ExperienceSnapshot } from '../experience/types.ts'
import { fingerprint } from './datasets.ts'
import { positiveInteger } from './http.ts'
import type { EvaluationCase, EvaluationDataset, EvaluationMemoryFactory } from './types.ts'
import type { OSWorldTrajectory } from './osworld.ts'

/** Conversation identity prevents related questions from straddling train and evaluation. */
export function evaluationUnitFingerprint(sample: EvaluationCase): string {
  return fingerprint(sample.history.length ? sample.history : sample.input.question.trim().toLowerCase())
}

/** Content-only session identities also match histories repackaged with different IDs or dates. */
export function evaluationSessionFingerprints(sample: Pick<EvaluationCase, 'history'>): readonly string[] {
  const sessions = new Map<string, { role: 'user' | 'assistant'; text: string }[]>()
  for (const message of sample.history) {
    const turns = sessions.get(message.sessionId) ?? []
    turns.push({ role: message.role, text: message.text })
    sessions.set(message.sessionId, turns)
  }
  return [...new Set([...sessions.values()].map(fingerprint))]
}

export interface ExperienceTrainingSource {
  readonly scope: string
  readonly episodeId: string
  readonly caseId: string
  readonly unitFingerprint: string
  readonly sessionFingerprints: readonly string[]
}
export interface FrozenExperienceBank {
  readonly fingerprint: string
  readonly trainingDatasetFingerprint: string
  readonly heldOutDatasetFingerprint: string
  readonly at: number
  recall(text: string, environment: ExperienceEnvironment, availableTools: readonly string[], limit: number): Promise<readonly ExperienceRecallHit[]>
}

/** Freeze a provenance-complete training bank before any held-out question is run. */
export async function freezeExperienceBank(options: {
  readonly memory: Pick<ExperienceMemory, 'snapshot'>
  readonly scopes: readonly string[]
  readonly policy: ExperiencePolicy
  readonly trainingDatasetFingerprint: string
  readonly sources: readonly ExperienceTrainingSource[]
  readonly heldOut: EvaluationDataset
  readonly at: number
}): Promise<FrozenExperienceBank> {
  if (!Number.isFinite(options.at) || !options.trainingDatasetFingerprint || options.trainingDatasetFingerprint === options.heldOut.fingerprint) throw new Error('Experience training requires an independent dataset and a fixed clock')
  const heldOutIds = new Set(options.heldOut.cases.map(sample => sample.input.id))
  const heldOutUnits = new Set(options.heldOut.cases.map(evaluationUnitFingerprint))
  const heldOutSessions = new Set(options.heldOut.cases.flatMap(evaluationSessionFingerprints))
  const key = (scope: string, episodeId: string) => JSON.stringify([scope, episodeId])
  const sources = new Map(options.sources.map(source => [key(source.scope, source.episodeId), source]))
  if (sources.size !== options.sources.length) throw new Error('Duplicate experience provenance entry')
  for (const source of options.sources) {
    if (!Array.isArray(source.sessionFingerprints) || source.sessionFingerprints.some(value => typeof value !== 'string' || !value)) throw new Error(`Missing session-content provenance for ${source.caseId}`)
    if (!source.unitFingerprint || heldOutIds.has(source.caseId) || heldOutUnits.has(source.unitFingerprint)) throw new Error(`Experience training overlaps evaluation: ${source.caseId}`)
    if (source.sessionFingerprints.some(value => heldOutSessions.has(value))) throw new Error(`Experience training shares a history session with evaluation: ${source.caseId}`)
  }
  const snapshots = new Map<string, ExperienceSnapshot>()
  for (const scope of options.scopes) {
    const snapshot = structuredClone(await options.memory.snapshot(scope))
    for (const episode of snapshot.episodes) {
      if (!sources.has(key(scope, episode.id))) throw new Error(`Missing training provenance for episode ${episode.id}`)
      if (episode.completedAt > options.at) throw new Error('Experience bank contains an episode after its freeze time')
    }
    if (snapshot.skills.some(skill => skill.updatedAt > options.at)
      || snapshot.revisions.some(revision => revision.at > options.at)
      || snapshot.feedback.some(feedback => feedback.createdAt > options.at)) throw new Error('Experience bank contains a revision after its freeze time')
    snapshots.set(scope, snapshot)
  }
  const memory = new ExperienceMemory({
    get: async scope => snapshots.has(scope) ? structuredClone(snapshots.get(scope)!) : undefined,
    put: async () => { throw new Error('Frozen experience bank is read-only') },
    delete: async () => { throw new Error('Frozen experience bank is read-only') },
  }, options.policy)
  return { fingerprint: fingerprint({ snapshots: [...snapshots], sources: options.sources, policy: options.policy, at: options.at }),
    trainingDatasetFingerprint: options.trainingDatasetFingerprint, heldOutDatasetFingerprint: options.heldOut.fingerprint, at: options.at,
    recall: (text, environment, availableTools, limit) => memory.recall({ scopes: [...snapshots.keys()], text, environment, availableTools, limit, now: options.at }) }
}

/** Keep factual context and procedural guidance in separate named prompt fields. */
export function withFrozenExperience(options: {
  readonly factual: EvaluationMemoryFactory
  readonly bank: FrozenExperienceBank
  readonly environment: ExperienceEnvironment
  readonly availableTools: readonly string[]
  readonly limit: number
  readonly maxExperienceChars: number
}): EvaluationMemoryFactory {
  positiveInteger(options.limit, 'experience limit')
  positiveInteger(options.maxExperienceChars, 'maxExperienceChars')
  return async input => {
    const factual = await options.factual(input)
    return { async recall(question, signal) {
      const context = await factual.recall(question, signal)
      signal.throwIfAborted()
      const hits = await options.bank.recall(question.question, options.environment, options.availableTools, options.limit)
      const skills: unknown[] = []
      let size = 0
      for (const { skill } of hits) {
        const item = { id: skill.id, version: skill.version, kind: skill.kind, title: skill.title, applicability: skill.applicability,
          preconditions: skill.preconditions, procedure: skill.procedure, cautions: skill.cautions, verification: skill.verification }
        const length = JSON.stringify(item).length
        if (size + length > options.maxExperienceChars) continue
        skills.push(item); size += length
      }
      return { ...context, text: JSON.stringify({ factualMemory: context.text, experienceSkills: skills }) }
    }, close: () => factual.close() }
  }
}

/** Record a completed training trajectory; callers persist the cited substrate first. */
export async function recordOSWorldTrainingExperience(options: {
  readonly memory: Pick<ExperienceMemory, 'record' | 'policy'>
  readonly scope: string
  readonly trajectory: OSWorldTrajectory
  readonly environment: ExperienceEnvironment
  readonly evidenceIds: readonly string[]
  readonly trainingTaskIds: readonly string[]
  readonly heldOutTaskIds: readonly string[]
  readonly maxObservationChars: number
}) {
  positiveInteger(options.maxObservationChars, 'maxObservationChars')
  const { trajectory } = options
  if (options.trainingTaskIds.some(id => options.heldOutTaskIds.includes(id)) || !options.trainingTaskIds.includes(trajectory.taskId)) throw new Error('OSWorld training and evaluation tasks must be disjoint')
  if (!options.evidenceIds.length) throw new Error('Training experience requires persisted trajectory/evaluator evidence')
  if (!Number.isFinite(trajectory.score) || trajectory.score < 0 || trajectory.score > 1) throw new Error('Invalid training outcome score')
  const { maxTextLength, maxSteps } = options.memory.policy
  const observationLimit = Math.min(options.maxObservationChars, maxTextLength)
  // Sample the whole trajectory, retaining its endpoints; the cited source remains complete.
  const selected = trajectory.steps.length <= maxSteps ? trajectory.steps
    : maxSteps === 1 ? trajectory.steps.slice(-1)
      : Array.from({ length: maxSteps }, (_, index) => trajectory.steps[Math.floor(index * (trajectory.steps.length - 1) / (maxSteps - 1))]!)
  return options.memory.record({ id: `osworld:${trajectory.taskId}:${fingerprint(trajectory)}`, scope: options.scope, task: trajectory.instruction.slice(0, maxTextLength),
    summary: (trajectory.steps.map(step => step.summary.trim()).filter(Boolean).join('\n') || trajectory.instruction).slice(0, maxTextLength),
    steps: selected.map(step => ({ action: (step.summary.trim() || 'Executed action retained in the cited trajectory').slice(0, maxTextLength),
      observation: (step.observation.accessibilityTree.trim() || step.observation.terminal.trim()
        || (step.observation.screenshot ? 'Screenshot observation retained in the cited trajectory' : 'No textual observation returned')).slice(0, observationLimit), tool: 'pyautogui' })),
    outcome: { status: trajectory.score === 1 ? 'success' : trajectory.score > 0 ? 'partial' : 'failure', source: 'verified', reason: `OSWorld environment score: ${trajectory.score}`, evidence: options.evidenceIds },
    evidence: options.evidenceIds, environment: options.environment, startedAt: trajectory.startedAt, completedAt: trajectory.completedAt,
    sessionId: `osworld:${trajectory.taskId}` })
}
