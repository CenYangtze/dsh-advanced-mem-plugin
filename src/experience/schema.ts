import { z } from 'zod'

const text = z.string().trim().min(1)
const epoch = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const confidence = z.number().min(0).max(1)
const strings = z.array(text)
const environment = z.record(text, text)

export const ExperienceOutcomeSchema = z.strictObject({
  status: z.enum(['success', 'failure', 'partial', 'unknown']),
  source: z.enum(['verified', 'user', 'model', 'unknown']),
  reason: text,
  evidence: strings,
})

export const ExperienceEpisodeInputSchema = z.strictObject({
  id: text,
  scope: text,
  task: text,
  summary: text,
  steps: z.array(z.strictObject({ action: text, observation: text, tool: text.optional() })),
  outcome: ExperienceOutcomeSchema,
  environment,
  evidence: strings.min(1),
  startedAt: epoch,
  completedAt: epoch,
  sessionId: text.optional(),
  derivedFrom: text.optional(),
}).superRefine((episode, ctx) => {
  if (episode.completedAt < episode.startedAt) ctx.addIssue({ code: 'custom', message: 'completedAt precedes startedAt' })
  if (episode.outcome.evidence.some(id => !episode.evidence.includes(id))) {
    ctx.addIssue({ code: 'custom', message: 'Outcome evidence must be included in the episode evidence' })
  }
  if ((episode.outcome.source === 'verified' || episode.outcome.source === 'user') && !episode.outcome.evidence.length) {
    ctx.addIssue({ code: 'custom', message: 'A trusted outcome must cite evidence' })
  }
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
  if (snapshot.revisions.some(revision => !skillIds.has(revision.skillId)
    || revision.skill.id !== revision.skillId || revision.skill.scope !== snapshot.scope
    || revision.skill.episodeIds.some(id => !ids.has(id)))) {
    ctx.addIssue({ code: 'custom', message: 'Revision has missing or inconsistent provenance' })
  }
})
