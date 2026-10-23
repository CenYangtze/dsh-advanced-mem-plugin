import { ExperienceError, ExperienceMemory } from '../experience/core.ts'
import {
  EXPERIENCE_OUTCOME_PROMPT, buildExperienceOutcomeRequest, experienceOutcomeEligibility,
  parseExperienceOutcomeAssessment,
} from '../experience/outcome.ts'
import type { ExperienceJsonModel } from '../experience/provider.ts'
import { latestExperienceCheckpoint } from '../experience/trajectory.ts'
import type { ExperienceEpisode, ExperienceSnapshot } from '../experience/types.ts'

export interface ExperienceReassessmentResult {
  readonly episode: ExperienceEpisode
  readonly changed: boolean
  readonly reason: string
}

function currentOutcome(snapshot: ExperienceSnapshot, episodeId: string): ExperienceEpisode {
  const byId = new Map(snapshot.episodes.map(episode => [episode.id, episode]))
  const source = byId.get(episodeId)
  if (!source) throw new ExperienceError('not-found', 'Task episode does not exist in this scope')
  const root = (episode: ExperienceEpisode): string => {
    let current = episode
    while (current.derivedFrom !== undefined) current = byId.get(current.derivedFrom)!
    return current.id
  }
  const family = root(source)
  return snapshot.episodes.reduce((latest, episode) => root(episode) === family && episode.completedAt >= latest.completedAt ? episode : latest, source)
}

/** Reassess committed evidence without changing uncertain records or overriding newer decisions. */
export async function reassessEpisode(
  memory: ExperienceMemory, scope: string, episodeId: string, model: ExperienceJsonModel, signal?: AbortSignal,
): Promise<ExperienceReassessmentResult> {
  signal?.throwIfAborted()
  const snapshot = await memory.snapshot(scope)
  const episode = currentOutcome(snapshot, episodeId)
  const unchanged = (reason: string): ExperienceReassessmentResult => ({ episode, changed: false, reason })
  if (episode.outcome.status !== 'unknown' || !['unknown', 'model'].includes(episode.outcome.source)) {
    return unchanged('This checkpoint already has a user or determined outcome; it was left unchanged.')
  }
  if (episode.taskContext) {
    const checkpoint = latestExperienceCheckpoint(snapshot, episode.taskContext.id)
    if (checkpoint?.taskContext?.revision !== episode.taskContext.revision) {
      return unchanged('A newer task checkpoint is current; reassess that checkpoint instead.')
    }
  }
  const eligibility = [...experienceOutcomeEligibility(episode)]
  if (episode.taskContext?.previousEpisodeId !== undefined) {
    const previous = snapshot.episodes.find(item => item.id === episode.taskContext!.previousEpisodeId)!
    const previousSequence = Math.max(-1, ...previous.steps.flatMap(step => step.evidence ? [step.evidence.seq] : []))
    if (!episode.steps.some(step => step.evidence?.complete && step.evidence.seq > previousSequence
      && (step.evidence.execution === 'completed' && ['check', 'readback'].includes(step.evidence.role)
        || step.evidence.role === 'check' && step.evidence.execution === 'failed'))) {
      eligibility.push('this checkpoint has no fresh validation after its predecessor evidence')
    }
  }
  if (eligibility.length) return unchanged(`Automatic reassessment needs evidence: ${eligibility.join('; ')}`)
  const recalled = (episode.recalledSkills ?? []).flatMap(reference => {
    const skill = snapshot.skills.find(item => item.id === reference.id && item.version === reference.version)
      ?? snapshot.revisions.find(item => item.skillId === reference.id && item.version === reference.version)?.skill
    return skill ? [skill] : []
  })
  const request = buildExperienceOutcomeRequest(episode, recalled, memory.policy)
  const response = await model.complete(EXPERIENCE_OUTCOME_PROMPT, request, signal)
  signal?.throwIfAborted()
  const result = parseExperienceOutcomeAssessment(response, episode, recalled, memory.policy, model.name)
  if (result.outcome.source !== 'tool-evidence') return unchanged(result.outcome.reason)
  const confirmed = await memory.confirmOutcome(scope, episode.id, result.outcome, {
    expectedLatestEpisodeId: episode.id,
    ...(episode.taskContext ? { expectedTaskRevision: episode.taskContext.revision } : {}),
    ...(signal ? { signal } : {}),
  })
  return { episode: confirmed, changed: confirmed.id !== episode.id, reason: confirmed.outcome.reason }
}
