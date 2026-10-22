import type { ExperienceDistillInput } from './types.ts'

/** One projection for extraction and budgeting; provenance is kept, history is omitted. */
export function serializeExperienceDistillation(input: ExperienceDistillInput): string {
  return JSON.stringify({
    scope: input.scope,
    episodes: input.episodes.map(({ learnedBy: _learnedBy, ...episode }) => episode),
    existing: input.existing.map(skill => ({
      id: skill.id, title: skill.title, description: skill.description, kind: skill.kind,
      applicability: skill.applicability, preconditions: skill.preconditions, procedure: skill.procedure,
      cautions: skill.cautions, verification: skill.verification, tags: skill.tags,
      environment: skill.environment, requiredTools: skill.requiredTools, status: skill.status,
    })),
  })
}
