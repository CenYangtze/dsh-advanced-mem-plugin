import type { ExperienceDistillInput } from './types.ts'

/** One projection for extraction and budgeting; only this batch exposes citable episode identities. */
export function serializeExperienceDistillation(input: ExperienceDistillInput): string {
  return JSON.stringify({
    scope: input.scope,
    allowedEpisodeIds: input.episodes.map((_, index) => `e${index + 1}`),
    episodes: input.episodes.map((episode, index) => ({
      id: `e${index + 1}`, task: episode.task, summary: episode.summary,
      steps: episode.steps.map(step => ({ action: step.action, observation: step.observation, tool: step.tool,
        ...(step.evidence ? { evidence: { seq: step.evidence.seq, role: step.evidence.role,
          execution: step.evidence.execution, complete: step.evidence.complete } } : {}),
      })),
      outcome: { status: episode.outcome.status, source: episode.outcome.source, reason: episode.outcome.reason,
        ...(episode.outcome.assessment ? { assessment: {
          confidence: episode.outcome.assessment.confidence, requirementsComplete: episode.outcome.assessment.requirementsComplete,
          criteria: episode.outcome.assessment.criteria.map(criterion => ({ requirement: criterion.requirement, status: criterion.status })),
        } } : {}),
      },
      environment: episode.environment, startedAt: episode.startedAt, completedAt: episode.completedAt,
      capture: episode.capture,
      ...(episode.taskContext ? { taskContext: { kind: episode.taskContext.kind, revision: episode.taskContext.revision,
        latestRequest: episode.taskContext.latestRequest, priorCaptureIncomplete: episode.taskContext.priorCaptureIncomplete,
        currentEvidenceStartSeq: episode.taskContext.currentEvidenceStartSeq } } : {}),
    })),
    existing: input.existing.map(skill => ({
      id: skill.id, version: skill.version, title: skill.title, description: skill.description, kind: skill.kind,
      applicability: skill.applicability, preconditions: skill.preconditions, procedure: skill.procedure,
      cautions: skill.cautions, verification: skill.verification, tags: skill.tags,
      environment: skill.environment, requiredTools: skill.requiredTools, status: skill.status, confidence: skill.confidence,
    })),
  })
}
