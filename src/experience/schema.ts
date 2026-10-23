import { z } from 'zod'
import type { ExperienceEpisodeInput, ExperienceStep } from './types.ts'

const text = z.string().trim().min(1)
const epoch = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const confidence = z.number().min(0).max(1)
const strings = z.array(text)
const environment = z.record(text, text)

export const ExperienceEvidenceQuoteSchema = z.strictObject({
  eventId: text,
  // Quotes retain their exact whitespace for comparison with the committed observation.
  quote: z.string().min(1).refine(value => /\S/u.test(value), 'An evidence quote cannot be blank'),
})

export const ExperienceOutcomeCriterionSchema = z.strictObject({
  requirement: text,
  status: z.enum(['passed', 'failed', 'unknown']),
  evidence: z.array(ExperienceEvidenceQuoteSchema),
})

export const ExperienceOutcomeAssessmentSchema = z.strictObject({
  id: text, assessor: text, confidence, observedAt: epoch,
  requirementsComplete: z.boolean(), criteria: z.array(ExperienceOutcomeCriterionSchema).min(1),
})

export const ExperienceStepEvidenceSchema = z.strictObject({
  id: text, seq: epoch, at: epoch, callId: text,
  role: z.enum(['action', 'check', 'readback', 'unknown']),
  execution: z.enum(['completed', 'failed', 'incomplete']),
  complete: z.boolean(), target: text.optional(),
})

export const ExperienceTaskContextSchema = z.strictObject({
  id: text, revision: epoch, previousEpisodeId: text.optional(),
  kind: z.enum(['initial', 'continuation', 'increment']), latestRequest: text,
  priorCaptureIncomplete: z.boolean().optional(),
  currentEvidenceStartSeq: epoch.optional(),
})

export const ExperienceOutcomeSchema = z.strictObject({
  status: z.enum(['success', 'failure', 'partial', 'unknown']),
  source: z.enum(['verified', 'tool-evidence', 'user', 'model', 'unknown']),
  reason: text,
  evidence: strings,
  assessment: ExperienceOutcomeAssessmentSchema.optional(),
})

/** Capture completeness must also hold; a clipped completed readback is context, never a proof. */
export function experienceStepPreservesTrace(step: ExperienceStep): boolean {
  const proof = step.evidence
  return proof !== undefined && proof.execution !== 'incomplete'
    && (proof.complete || proof.role === 'readback' && proof.execution === 'completed')
}

/** Structural gates also run when loading snapshots, independently of deployment thresholds. */
export function experienceToolOutcomeIssues(episode: ExperienceEpisodeInput): readonly string[] {
  if (episode.outcome.source !== 'tool-evidence') return []
  const issues: string[] = []
  const assessment = episode.outcome.assessment
  if (!assessment) return ['A tool-evidence outcome requires an assessment']
  if (!episode.capture?.complete || episode.capture.end !== 'completed') issues.push('Automatic confirmation requires a complete, normally completed task capture')
  if (!assessment.requirementsComplete || !assessment.criteria.length || assessment.criteria.some(item => item.status === 'unknown')) {
    issues.push('Automatic confirmation requires complete coverage of every task requirement')
  }
  if (episode.steps.some(step => !experienceStepPreservesTrace(step))) {
    issues.push('Automatic confirmation requires complete execution evidence for all captured steps')
  }
  const proofs = new Map(episode.steps.flatMap(step => step.evidence ? [[step.evidence.id, step] as const] : []))
  const lastAction = Math.max(-1, ...episode.steps.filter(step => step.evidence?.role === 'action' || step.evidence?.role === 'unknown')
    .map(step => step.evidence!.seq))
  const cited = new Set<string>()
  const times: number[] = []
  for (const criterion of assessment.criteria) {
    if (!criterion.evidence.length) issues.push('Every decided requirement requires verification evidence')
    for (const quote of criterion.evidence) {
      const step = proofs.get(quote.eventId)
      const proof = step?.evidence
      if (!step || !proof || !step.observation.includes(quote.quote)) {
        issues.push('Assessment evidence must exactly quote a captured tool result')
        continue
      }
      cited.add(proof.id)
      times.push(proof.at)
      const executedAssertionFailure = criterion.status === 'failed' && proof.role === 'check' && proof.execution === 'failed'
      if (!proof.complete || (proof.execution !== 'completed' && !executedAssertionFailure) || !['check', 'readback'].includes(proof.role)) {
        issues.push('Assessment requires a complete executed check or readback; only failed assertions may cite a failed check')
      }
      if (proof.seq <= lastAction) issues.push('Verification must follow the last action or unknown execution')
    }
  }
  if (episode.outcome.evidence.length !== cited.size || episode.outcome.evidence.some(id => !cited.has(id))) {
    issues.push('Outcome evidence must exactly identify its criterion verification events')
  }
  if (!times.length || assessment.observedAt !== Math.max(...times)) issues.push('Assessment time must be the actual latest cited verification event time')
  const boundary = episode.taskContext?.currentEvidenceStartSeq
  if (boundary !== undefined && ![...cited].some(id => proofs.get(id)!.evidence!.seq >= boundary)) {
    issues.push('A new checkpoint must cite verification from its current turn')
  }
  const passed = assessment.criteria.filter(item => item.status === 'passed').length
  const failed = assessment.criteria.filter(item => item.status === 'failed').length
  const expected = failed ? (passed ? 'partial' : 'failure') : 'success'
  if (episode.outcome.status !== expected) issues.push('Outcome status must agree with its verified requirement results')
  return [...new Set(issues)]
}

export const ExperienceEpisodeInputSchema = z.strictObject({
  id: text,
  scope: text,
  task: text,
  summary: text,
  steps: z.array(z.strictObject({ action: text, observation: z.string().min(1).refine(value => /\S/u.test(value)), tool: text.optional(), evidence: ExperienceStepEvidenceSchema.optional() })),
  outcome: ExperienceOutcomeSchema,
  environment,
  evidence: strings.min(1),
  startedAt: epoch,
  completedAt: epoch,
  sessionId: text.optional(),
  derivedFrom: text.optional(),
  capture: z.strictObject({ complete: z.boolean(), end: z.enum(['completed', 'incomplete']) }).optional(),
  recalledSkills: z.array(z.strictObject({ id: text, version: z.number().int().positive() })).optional(),
  taskContext: ExperienceTaskContextSchema.optional(),
}).superRefine((episode, ctx) => {
  if (episode.completedAt < episode.startedAt) ctx.addIssue({ code: 'custom', message: 'completedAt precedes startedAt' })
  if (episode.outcome.evidence.some(id => !episode.evidence.includes(id))) {
    ctx.addIssue({ code: 'custom', message: 'Outcome evidence must be included in the episode evidence' })
  }
  if (['verified', 'tool-evidence', 'user'].includes(episode.outcome.source) && !episode.outcome.evidence.length) {
    ctx.addIssue({ code: 'custom', message: 'A trusted outcome must cite evidence' })
  }
  const metadata = episode.steps.flatMap(step => step.evidence ? [step.evidence] : [])
  if (new Set(metadata.map(item => item.id)).size !== metadata.length || new Set(metadata.map(item => item.seq)).size !== metadata.length) {
    ctx.addIssue({ code: 'custom', message: 'Duplicate execution evidence identity or sequence' })
  }
  if (metadata.some(item => !episode.evidence.includes(item.id) || item.at < episode.startedAt || item.at > episode.completedAt)) {
    ctx.addIssue({ code: 'custom', message: 'Execution evidence must belong to this episode and its time interval' })
  }
  if (new Set(episode.recalledSkills?.map(item => item.id)).size !== (episode.recalledSkills?.length ?? 0)) {
    ctx.addIssue({ code: 'custom', message: 'Duplicate recalled skill identity' })
  }
  if (episode.outcome.assessment && episode.outcome.assessment.observedAt > episode.completedAt) {
    ctx.addIssue({ code: 'custom', message: 'Assessment cannot cite a future verification time' })
  }
  if (episode.taskContext) {
    if (episode.taskContext.id !== episode.sessionId) ctx.addIssue({ code: 'custom', message: 'Task context identity must match the episode session' })
    if ((episode.taskContext.kind === 'initial') !== (episode.taskContext.previousEpisodeId === undefined)) {
      ctx.addIssue({ code: 'custom', message: 'Initial checkpoints have no predecessor; continuation and increment checkpoints require one' })
    }
    if (episode.taskContext.previousEpisodeId === episode.id) ctx.addIssue({ code: 'custom', message: 'A task checkpoint cannot depend on itself' })
  }
  for (const message of experienceToolOutcomeIssues(episode)) ctx.addIssue({ code: 'custom', message })
})

export const ExperienceEpisodeSchema = ExperienceEpisodeInputSchema.safeExtend({ learnedBy: strings })

const content = {
  title: text,
  description: text,
  kind: z.enum(['procedure', 'pitfall']),
  applicability: strings.min(1),
  preconditions: strings,
  procedure: strings.min(1),
  cautions: strings,
  verification: strings.min(1),
  tags: strings,
  environment,
  requiredTools: strings,
} as const

export const ExperienceCandidateSchema = z.strictObject({
  ...content,
  confidence,
  episodeIds: strings.min(1),
  supersedes: text.optional(),
})

export const ExperienceSkillSchema = z.strictObject({
  ...content,
  id: text,
  scope: text,
  version: z.number().int().positive(),
  status: z.enum(['candidate', 'active', 'quarantined', 'deprecated', 'expired', 'retracted']),
  confidence,
  proposedConfidence: confidence,
  episodeIds: strings.min(1),
  conflictsWith: strings,
  supersedes: text.optional(),
  supersededBy: text.optional(),
  createdAt: epoch,
  updatedAt: epoch,
  lastValidatedAt: epoch.nullable(),
  expiresAt: epoch,
})

export const ExperienceFeedbackInputSchema = z.strictObject({
  id: text,
  skillId: text,
  episodeId: text,
  verdict: z.enum(['helpful', 'harmful', 'irrelevant']),
  reason: text,
  attribution: z.strictObject({
    skillVersion: z.number().int().positive(), assessmentId: text,
    actionEvidence: z.array(ExperienceEvidenceQuoteSchema).min(1),
    verificationEvidence: z.array(ExperienceEvidenceQuoteSchema).min(1),
  }).optional(),
})

/** Shared by file and Harness-domain stores; malformed media fail before use. */
export const ExperienceSnapshotSchema = z.strictObject({
  schemaVersion: z.literal(1),
  scope: text,
  episodes: z.array(ExperienceEpisodeSchema),
  skills: z.array(ExperienceSkillSchema),
  revisions: z.array(z.strictObject({
    id: text,
    skillId: text,
    version: z.number().int().positive(),
    at: epoch,
    reason: text,
    skill: ExperienceSkillSchema,
  })),
  feedback: z.array(ExperienceFeedbackInputSchema.extend({ createdAt: epoch })),
}).superRefine((snapshot, ctx) => {
  const ids = new Set(snapshot.episodes.map(episode => episode.id))
  const skillIds = new Set(snapshot.skills.map(skill => skill.id))
  const byId = new Map(snapshot.episodes.map(episode => [episode.id, episode]))
  if (ids.size !== snapshot.episodes.length || skillIds.size !== snapshot.skills.length) {
    ctx.addIssue({ code: 'custom', message: 'Duplicate episode or skill identity' })
  }
  if (snapshot.episodes.some(episode => episode.scope !== snapshot.scope)
    || snapshot.skills.some(skill => skill.scope !== snapshot.scope)) {
    ctx.addIssue({ code: 'custom', message: 'Snapshot contains an item from another scope' })
  }
  if (snapshot.episodes.some(episode => episode.derivedFrom !== undefined && !ids.has(episode.derivedFrom))) {
    ctx.addIssue({ code: 'custom', message: 'Confirmation cites a missing episode' })
  }
  const checkpointRoots = new Map<string, string>()
  for (const episode of snapshot.episodes) {
    const context = episode.taskContext
    if (context?.previousEpisodeId !== undefined) {
      const previous = byId.get(context.previousEpisodeId)
      if (!previous || previous.scope !== episode.scope || previous.taskContext?.id !== context.id
        || previous.taskContext.revision >= context.revision) {
        ctx.addIssue({ code: 'custom', message: 'Task predecessor must be an earlier checkpoint in this scope and session' })
      }
      if (previous?.taskContext?.currentEvidenceStartSeq !== undefined && context.currentEvidenceStartSeq !== undefined
        && context.currentEvidenceStartSeq <= previous.taskContext.currentEvidenceStartSeq) {
        ctx.addIssue({ code: 'custom', message: 'A task checkpoint must start after its predecessor turn boundary' })
      }
      if (previous && episode.outcome.source === 'tool-evidence') {
        const previousSequence = Math.max(-1, ...previous.steps.flatMap(step => step.evidence ? [step.evidence.seq] : []))
        if (!episode.steps.some(step => step.evidence !== undefined && episode.outcome.evidence.includes(step.evidence.id)
          && step.evidence.seq > previousSequence && ['check', 'readback'].includes(step.evidence.role))) {
          ctx.addIssue({ code: 'custom', message: 'A new task checkpoint requires fresh verification after its predecessor evidence' })
        }
      }
    }
    if (episode.derivedFrom !== undefined) {
      const source = byId.get(episode.derivedFrom)
      if (source && (context || source.taskContext)
        && (context?.id !== source.taskContext?.id || context?.revision !== source.taskContext?.revision
          || context?.previousEpisodeId !== source.taskContext?.previousEpisodeId || context?.kind !== source.taskContext?.kind
          || context?.latestRequest !== source.taskContext?.latestRequest || context?.priorCaptureIncomplete !== source.taskContext?.priorCaptureIncomplete
          || context?.currentEvidenceStartSeq !== source.taskContext?.currentEvidenceStartSeq)) {
        ctx.addIssue({ code: 'custom', message: 'Outcome confirmations must preserve their task checkpoint context' })
      }
    } else if (context) {
      const key = JSON.stringify([context.id, context.revision])
      if (checkpointRoots.has(key)) ctx.addIssue({ code: 'custom', message: 'A task revision has more than one checkpoint root' })
      checkpointRoots.set(key, episode.id)
    }
  }
  const checked = new Set<string>()
  for (const episode of snapshot.episodes) {
    const seen = new Set<string>()
    let current: typeof episode | undefined = episode
    while (current && !checked.has(current.id)) {
      if (seen.has(current.id)) {
        ctx.addIssue({ code: 'custom', message: 'Cyclic episode provenance' })
        break
      }
      seen.add(current.id)
      current = current.derivedFrom === undefined ? undefined : byId.get(current.derivedFrom)
    }
    for (const id of seen) checked.add(id)
  }
  if (snapshot.skills.some(skill => skill.episodeIds.some(id => !ids.has(id)))) {
    ctx.addIssue({ code: 'custom', message: 'Skill cites a missing episode' })
  }
  if (snapshot.skills.some(skill => skill.conflictsWith.some(id => id === skill.id || !skillIds.has(id))
    || (skill.supersedes !== undefined && (skill.supersedes === skill.id || !skillIds.has(skill.supersedes)))
    || (skill.supersededBy !== undefined && (skill.supersededBy === skill.id || !skillIds.has(skill.supersededBy))))) {
    ctx.addIssue({ code: 'custom', message: 'Invalid skill lifecycle reference' })
  }
  if (new Set(snapshot.feedback.map(item => item.id)).size !== snapshot.feedback.length
    || new Set(snapshot.revisions.map(item => item.id)).size !== snapshot.revisions.length) {
    ctx.addIssue({ code: 'custom', message: 'Duplicate feedback or revision identity' })
  }
  if (snapshot.feedback.some(feedback => !ids.has(feedback.episodeId) || !skillIds.has(feedback.skillId))) {
    ctx.addIssue({ code: 'custom', message: 'Feedback has missing provenance' })
  }
  for (const feedback of snapshot.feedback) {
    if (!feedback.attribution) continue
    const episode = byId.get(feedback.episodeId)
    if (!episode || episode.outcome.assessment?.id !== feedback.attribution.assessmentId
      || !episode.recalledSkills?.some(skill => skill.id === feedback.skillId && skill.version === feedback.attribution!.skillVersion)) {
      ctx.addIssue({ code: 'custom', message: 'Automatic feedback has missing assessment or recall attribution' })
      continue
    }
    for (const quote of [...feedback.attribution.actionEvidence, ...feedback.attribution.verificationEvidence]) {
      if (!episode.steps.some(step => step.evidence?.id === quote.eventId && step.observation.includes(quote.quote))) {
        ctx.addIssue({ code: 'custom', message: 'Automatic feedback has an invalid evidence quote' })
      }
    }
  }
  if (snapshot.revisions.some(revision => !skillIds.has(revision.skillId)
    || revision.skill.id !== revision.skillId || revision.skill.scope !== snapshot.scope
    || revision.skill.episodeIds.some(id => !ids.has(id)))) {
    ctx.addIssue({ code: 'custom', message: 'Revision has missing or inconsistent provenance' })
  }
})
