import { ExperienceSnapshotSchema } from './schema.ts'
import type { ExperienceEpisode, ExperienceRecallHit, ExperienceSnapshot, ExperienceSourceManifest } from './types.ts'

/** Restore the latest task revision and its latest confirmation from durable state. */
export function latestExperienceCheckpoint(snapshot: ExperienceSnapshot, sessionId: string): ExperienceEpisode | undefined {
  const checked = ExperienceSnapshotSchema.parse(snapshot)
  const candidates = checked.episodes.filter(episode => episode.taskContext?.id === sessionId)
  if (!candidates.length) return undefined
  const revision = Math.max(...candidates.map(episode => episode.taskContext!.revision))
  const checkpoint = candidates.filter(episode => episode.taskContext!.revision === revision)
  const superseded = new Set(checkpoint.flatMap(episode => episode.derivedFrom === undefined ? [] : [episode.derivedFrom]))
  const latest = checkpoint.filter(episode => !superseded.has(episode.id))
    .sort((left, right) => right.completedAt - left.completedAt || right.id.localeCompare(left.id))[0]
  return latest === undefined ? undefined : structuredClone(latest)
}

/** A compact provenance index: no trajectory, user text, tool output or event-ID list. */
export function buildExperienceSourceManifest(snapshot: ExperienceSnapshot, skillId: string): ExperienceSourceManifest {
  const checked = ExperienceSnapshotSchema.parse(snapshot)
  const skill = checked.skills.find(item => item.id === skillId)
  if (!skill) throw new Error('Skill does not exist in this scope')
  const byId = new Map(checked.episodes.map(episode => [episode.id, episode]))
  const confirmations = new Map<string, string[]>()
  for (const episode of checked.episodes) {
    if (episode.derivedFrom !== undefined) confirmations.set(episode.derivedFrom, [...(confirmations.get(episode.derivedFrom) ?? []), episode.id])
  }
  const supporting = new Set(skill.episodeIds)
  const feedback = new Set(checked.feedback.filter(item => item.skillId === skillId).map(item => item.episodeId))
  const selected = new Set([...supporting, ...feedback])
  const queue = [...selected]
  for (const id of queue) {
    const episode = byId.get(id)!
    for (const previous of [episode.derivedFrom, episode.taskContext?.previousEpisodeId, ...(confirmations.get(id) ?? [])]) {
      if (previous !== undefined && !selected.has(previous)) { selected.add(previous); queue.push(previous) }
    }
  }
  const groups = new Map<string | null, ExperienceEpisode[]>()
  const allEvidence = new Set<string>()
  for (const id of selected) {
    const episode = byId.get(id)!
    const session = episode.sessionId ?? null
    const group = groups.get(session) ?? []
    group.push(episode)
    groups.set(session, group)
    for (const evidence of episode.evidence) allEvidence.add(evidence)
  }
  return {
    skillId: skill.id, skillVersion: skill.version, scope: checked.scope, evidenceCount: allEvidence.size,
    sessions: [...groups].sort(([left], [right]) => (left ?? '').localeCompare(right ?? '')).map(([sessionId, episodes]) => ({
      sessionId, evidenceCount: new Set(episodes.flatMap(episode => episode.evidence)).size,
      episodes: episodes.sort((left, right) => (left.taskContext?.revision ?? 0) - (right.taskContext?.revision ?? 0)
        || left.completedAt - right.completedAt || left.id.localeCompare(right.id)).map(episode => ({
        id: episode.id, revision: episode.taskContext?.revision ?? null, kind: episode.taskContext?.kind ?? null,
        previousEpisodeId: episode.taskContext?.previousEpisodeId ?? null, derivedFrom: episode.derivedFrom ?? null,
        priorCaptureIncomplete: episode.taskContext?.priorCaptureIncomplete ?? false,
        currentEvidenceStartSeq: episode.taskContext?.currentEvidenceStartSeq ?? null,
        outcome: episode.outcome.status, source: episode.outcome.source, completedAt: episode.completedAt,
        validatedAt: episode.outcome.source === 'tool-evidence' ? episode.outcome.assessment!.observedAt
          : ['user', 'verified'].includes(episode.outcome.source) ? episode.completedAt : null,
        evidenceCount: new Set(episode.evidence).size, supportsSkill: supporting.has(episode.id), providesFeedback: feedback.has(episode.id),
      })),
    })),
  }
}

/** Model-facing summary keeps procedures usable while leaving source expansion on demand. */
export function buildExperienceRecallSummary(hit: ExperienceRecallHit, manifest?: ExperienceSourceManifest): string {
  const skill = hit.skill
  if (manifest && (manifest.skillId !== skill.id || manifest.scope !== skill.scope || manifest.skillVersion !== skill.version)) {
    throw new Error('Source manifest does not match the recalled skill version and scope')
  }
  const sources = manifest
    ? `${manifest.sessions.reduce((sum, session) => sum + session.episodes.length, 0)} episode references in ${manifest.sessions.length} session groups; ${manifest.evidenceCount} evidence references`
    : `${new Set(skill.episodeIds).size} episode references; ${new Set(hit.evidence).size} evidence references`
  return [
    `### ${skill.title} (${skill.id}, v${skill.version})`, skill.description,
    `Applies when: ${skill.applicability.join('; ')}`, `Preconditions: ${skill.preconditions.join('; ')}`,
    ...skill.procedure.map((step, index) => `${index + 1}. ${step}`),
    `Verify: ${skill.verification.join('; ')}`, `Cautions: ${skill.cautions.join('; ')}`,
    `Sources: ${sources}. Expand this skill's source index by its ID when needed.`,
  ].join('\n')
}
