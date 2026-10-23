/** Portable, JSON-serializable contracts for task experience memory. */
export type ExperienceOutcomeStatus = 'success' | 'failure' | 'partial' | 'unknown'
export type ExperienceOutcomeSource = 'verified' | 'tool-evidence' | 'user' | 'model' | 'unknown'
export type ExperienceSkillStatus = 'candidate' | 'active' | 'quarantined' | 'deprecated' | 'expired' | 'retracted'

export interface ExperienceOutcome {
  readonly status: ExperienceOutcomeStatus
  /** `verified` identifies an environment evaluator or executed check. */
  readonly source: ExperienceOutcomeSource
  readonly reason: string
  readonly evidence: readonly string[]
  readonly assessment?: ExperienceOutcomeAssessment | undefined
}

export interface ExperienceEvidenceQuote {
  readonly eventId: string
  readonly quote: string
}

export interface ExperienceOutcomeCriterion {
  readonly requirement: string
  readonly status: 'passed' | 'failed' | 'unknown'
  readonly evidence: readonly ExperienceEvidenceQuote[]
}

/** Auditable external assessment; observedAt is the actual tool event time. */
export interface ExperienceOutcomeAssessment {
  readonly id: string
  readonly assessor: string
  readonly confidence: number
  readonly observedAt: number
  readonly requirementsComplete: boolean
  readonly criteria: readonly ExperienceOutcomeCriterion[]
}

/** Host-owned projection of a committed execution, never model-generated metadata. */
export interface ExperienceStepEvidence {
  readonly id: string
  readonly seq: number
  readonly at: number
  readonly callId: string
  readonly role: 'action' | 'check' | 'readback' | 'unknown'
  readonly execution: 'completed' | 'failed' | 'incomplete'
  readonly complete: boolean
  readonly target?: string | undefined
}

/** Observable actions and their results; hidden reasoning and raw tool arguments are excluded. */
export interface ExperienceStep {
  readonly action: string
  readonly observation: string
  readonly tool?: string | undefined
  readonly evidence?: ExperienceStepEvidence | undefined
}

/** Exact environment constraints. Missing query values never satisfy a constraint. */
export type ExperienceEnvironment = Readonly<Record<string, string>>

/** One immutable checkpoint in a session's evolving task; confirmations keep its revision. */
export interface ExperienceTaskContext {
  readonly id: string
  readonly revision: number
  readonly previousEpisodeId?: string | undefined
  readonly kind: 'initial' | 'continuation' | 'increment'
  readonly latestRequest: string
  /** Earlier execution detail was incomplete; fresh artifact checks do not prove past conduct. */
  readonly priorCaptureIncomplete?: boolean | undefined
  /** Host-owned session sequence where this checkpoint's current turn begins. */
  readonly currentEvidenceStartSeq?: number | undefined
}

export interface ExperienceEpisodeInput {
  /** Stable caller-provided identity makes retries idempotent within the scope. */
  readonly id: string
  readonly scope: string
  readonly task: string
  readonly summary: string
  readonly steps: readonly ExperienceStep[]
  readonly outcome: ExperienceOutcome
  readonly environment: ExperienceEnvironment
  /** Layer-0 record IDs, kept as references instead of copied raw records. */
  readonly evidence: readonly string[]
  readonly startedAt: number
  readonly completedAt: number
  readonly sessionId?: string | undefined
  /** Immutable outcome confirmation; retained as a provenance edge. */
  readonly derivedFrom?: string | undefined
  readonly capture?: { readonly complete: boolean; readonly end: 'completed' | 'incomplete' } | undefined
  readonly recalledSkills?: readonly { readonly id: string; readonly version: number }[] | undefined
  readonly taskContext?: ExperienceTaskContext | undefined
}

export interface ExperienceEpisode extends ExperienceEpisodeInput {
  readonly learnedBy: readonly string[]
}

export interface ExperienceSkillContent {
  readonly title: string
  readonly description: string
  readonly kind: 'procedure' | 'pitfall'
  readonly applicability: readonly string[]
  readonly preconditions: readonly string[]
  readonly procedure: readonly string[]
  readonly cautions: readonly string[]
  readonly verification: readonly string[]
  readonly tags: readonly string[]
  readonly environment: ExperienceEnvironment
  /** Exact tool names required to apply this procedure. */
  readonly requiredTools: readonly string[]
}

export interface ExperienceCandidate extends ExperienceSkillContent {
  readonly confidence: number
  /** Every skill must cite existing episodes in this exact scope. */
  readonly episodeIds: readonly string[]
  /** Explicitly propose a replacement; activation is a separate decision. */
  readonly supersedes?: string | undefined
}

export interface ExperienceSkill extends ExperienceSkillContent {
  readonly id: string
  readonly scope: string
  readonly version: number
  readonly status: ExperienceSkillStatus
  readonly confidence: number
  /** The extractor's estimate, kept separate from evidence-weighted confidence. */
  readonly proposedConfidence: number
  readonly episodeIds: readonly string[]
  readonly conflictsWith: readonly string[]
  readonly supersedes?: string | undefined
  readonly supersededBy?: string | undefined
  readonly createdAt: number
  readonly updatedAt: number
  readonly lastValidatedAt: number | null
  readonly expiresAt: number
}

export interface ExperienceRevision {
  readonly id: string
  readonly skillId: string
  readonly version: number
  readonly at: number
  readonly reason: string
  readonly skill: ExperienceSkill
}

export interface ExperienceFeedbackInput {
  readonly id: string
  readonly skillId: string
  /** A later, independently recorded task on which this skill was used. */
  readonly episodeId: string
  readonly verdict: 'helpful' | 'harmful' | 'irrelevant'
  readonly reason: string
  readonly attribution?: {
    readonly skillVersion: number
    readonly assessmentId: string
    readonly actionEvidence: readonly ExperienceEvidenceQuote[]
    readonly verificationEvidence: readonly ExperienceEvidenceQuote[]
  } | undefined
}

export interface ExperienceFeedback extends ExperienceFeedbackInput {
  readonly createdAt: number
}

export interface ExperienceSnapshot {
  readonly schemaVersion: 1
  readonly scope: string
  readonly episodes: readonly ExperienceEpisode[]
  readonly skills: readonly ExperienceSkill[]
  readonly revisions: readonly ExperienceRevision[]
  readonly feedback: readonly ExperienceFeedback[]
}

/** Implementations persist the complete scope in one atomic write. */
export interface ExperienceStore {
  get(scope: string): Promise<ExperienceSnapshot | undefined>
  put(scope: string, snapshot: ExperienceSnapshot): Promise<void>
  delete(scope: string): Promise<void>
}

/** All operational limits and thresholds are deployment policy, supplied explicitly. */
export interface ExperiencePolicy {
  readonly minTrustedEpisodes: number
  readonly minConfidence: number
  readonly duplicateSimilarity: number
  readonly skillTtlMs: number
  readonly candidateTtlMs: number
  readonly maxEpisodes: number
  readonly maxSkills: number
  readonly maxTextLength: number
  readonly maxSteps: number
  readonly maxItemsPerField: number
  readonly maxCandidatesPerLearn: number
  readonly maxEpisodesPerLearn: number
  readonly maxExistingSkillsPerLearn: number
  /** Maximum JSON characters sent to an extractor, in complete evidence units. */
  readonly maxDistillationCharacters: number
  readonly maxRecall: number
  readonly feedbackPrior: number
  readonly harmfulFeedbackThreshold: number
  readonly verifiedOutcomeWeight: number
  readonly toolEvidenceOutcomeWeight: number
  readonly minOutcomeConfidence: number
  readonly userOutcomeWeight: number
  readonly modelOutcomeWeight: number
  readonly unknownOutcomeWeight: number
}

export interface ExperienceOutcomePolicy {
  readonly minOutcomeConfidence: number
  readonly maxTextLength: number
  readonly maxItemsPerField: number
}

/** Suggested feedback still requires a later independent task in ExperienceMemory.feedback. */
export interface ExperienceOutcomeFeedback {
  readonly skillId: string
  readonly version: number
  readonly verdict: 'helpful' | 'harmful'
  readonly reason: string
  readonly actionEvidence: readonly ExperienceEvidenceQuote[]
  readonly verificationEvidence: readonly ExperienceEvidenceQuote[]
}

export interface ExperienceOutcomeResult {
  readonly outcome: ExperienceOutcome
  readonly feedback: readonly ExperienceOutcomeFeedback[]
}

export interface ExperienceConfirmationOptions {
  /** Atomic compare-and-set: a stale background assessment cannot replace a correction. */
  readonly expectedLatestEpisodeId?: string | undefined
  /** Reject a background judgement if a newer task checkpoint appeared meanwhile. */
  readonly expectedTaskRevision?: number | undefined
  readonly signal?: AbortSignal | undefined
}

export interface ExperienceDistillInput {
  readonly scope: string
  readonly episodes: readonly ExperienceEpisode[]
  readonly existing: readonly ExperienceSkill[]
  readonly signal?: AbortSignal
}

export interface ExperienceDistiller {
  /** Version this identity when prompts or models change. */
  readonly name: string
  distill(input: ExperienceDistillInput): Promise<readonly ExperienceCandidate[]>
}

export interface ExperienceRecallQuery {
  readonly scopes: readonly string[]
  readonly text: string
  readonly environment: ExperienceEnvironment
  /** Missing tool inventory does not satisfy a nonempty requiredTools list. */
  readonly availableTools?: readonly string[]
  readonly limit?: number
  readonly now?: number
}

export interface ExperienceRecallHit {
  readonly skill: ExperienceSkill
  readonly score: number
  readonly evidence: readonly string[]
}

export interface ExperienceSourceManifest {
  readonly skillId: string
  readonly skillVersion: number
  readonly scope: string
  readonly evidenceCount: number
  readonly sessions: readonly {
    readonly sessionId: string | null
    readonly evidenceCount: number
    readonly episodes: readonly {
      readonly id: string
      readonly revision: number | null
      readonly kind: ExperienceTaskContext['kind'] | null
      readonly previousEpisodeId: string | null
      readonly derivedFrom: string | null
      readonly priorCaptureIncomplete: boolean
      readonly currentEvidenceStartSeq: number | null
      readonly outcome: ExperienceOutcomeStatus
      readonly source: ExperienceOutcomeSource
      readonly completedAt: number
      readonly validatedAt: number | null
      readonly evidenceCount: number
      readonly supportsSkill: boolean
      readonly providesFeedback: boolean
    }[]
  }[]
}

export interface ExperienceLearnResult {
  readonly episodes: readonly string[]
  readonly skills: readonly ExperienceSkill[]
  /** Complete episodes that did not fit this extraction window; still pending. */
  readonly skippedEpisodes: readonly string[]
}

export interface ExperienceMaintenanceReport {
  readonly expired: number
  readonly deprecated: number
  readonly quarantined: number
}

export type ExperienceForgetTarget =
  | { readonly episodeId: string }
  | { readonly skillId: string }
  | { readonly evidenceId: string }
  | { readonly all: true }

export interface ExperienceForgetReport {
  readonly episodes: number
  readonly skills: number
  readonly revisions: number
  readonly feedback: number
}
