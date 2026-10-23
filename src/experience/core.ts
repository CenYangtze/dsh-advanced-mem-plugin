import { createHash, randomUUID } from 'node:crypto'
import { bm25Rank, rankScore, similarity, tokenize } from '../memory/scoring.ts'
import { serializeExperienceDistillation } from './payload.ts'
import {
  ExperienceCandidateSchema, ExperienceEpisodeInputSchema, ExperienceFeedbackInputSchema,
  ExperienceOutcomeSchema, ExperienceSnapshotSchema,
} from './schema.ts'
import type {
  ExperienceCandidate, ExperienceDistiller, ExperienceEnvironment, ExperienceEpisode, ExperienceEpisodeInput,
  ExperienceFeedback, ExperienceFeedbackInput, ExperienceForgetReport, ExperienceForgetTarget,
  ExperienceLearnResult, ExperienceMaintenanceReport, ExperienceOutcome, ExperiencePolicy,
  ExperienceRecallHit, ExperienceRecallQuery, ExperienceRevision, ExperienceSkill, ExperienceSkillContent,
  ExperienceSnapshot, ExperienceStore,
} from './types.ts'

type MutableSnapshot = {
  schemaVersion: 1
  scope: string
  episodes: ExperienceEpisode[]
  skills: ExperienceSkill[]
  revisions: ExperienceRevision[]
  feedback: ExperienceFeedback[]
}

/** Multiple engines sharing one store also share its scope transaction queues. */
const STORE_QUEUES = new WeakMap<ExperienceStore, Map<string, Promise<unknown>>>()

export class ExperienceError extends Error {
  constructor(readonly code: 'invalid-input' | 'identity-conflict' | 'missing-evidence' | 'capacity' | 'not-found', message: string) {
    super(message)
    this.name = 'ExperienceError'
  }
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

function contentOf(skill: ExperienceSkillContent): ExperienceSkillContent {
  return {
    title: skill.title, description: skill.description, kind: skill.kind,
    applicability: [...skill.applicability], preconditions: [...skill.preconditions], procedure: [...skill.procedure],
    cautions: [...skill.cautions], verification: [...skill.verification], tags: [...skill.tags],
    environment: { ...skill.environment }, requiredTools: [...skill.requiredTools],
  }
}

function searchText(skill: ExperienceSkillContent): string {
  return [skill.title, skill.description, ...skill.applicability, ...skill.tags, ...skill.preconditions, ...skill.procedure].join('\n')
}

function sameContext(left: ExperienceSkillContent, right: ExperienceSkillContent): boolean {
  return canonical(left.environment) === canonical(right.environment)
    && canonical([...left.requiredTools].sort()) === canonical([...right.requiredTools].sort())
}

function environmentMatches(constraints: ExperienceEnvironment, environment: ExperienceEnvironment): boolean {
  return Object.entries(constraints).every(([key, value]) => environment[key] === value)
}

function supportsOutcome(skill: ExperienceSkillContent, episode: ExperienceEpisode): boolean {
  return environmentMatches(skill.environment, episode.environment) && (skill.kind === 'procedure'
    ? episode.outcome.status === 'success'
    : episode.outcome.status === 'failure' || episode.outcome.status === 'partial')
}

/** This audit marker distinguishes outcome-based reassessment from legacy evidence-only merges. */
const CONFIDENCE_REASSESSMENT = 'Reassessed extraction confidence from trusted outcomes'

function unique<T>(values: readonly T[]): T[] { return [...new Set(values)] }

function checkTime(at: number): void {
  if (!Number.isSafeInteger(at) || at < 0) throw new ExperienceError('invalid-input', 'Time must be nonnegative integer epoch milliseconds')
}

function blank(scope: string): MutableSnapshot {
  return { schemaVersion: 1, scope, episodes: [], skills: [], revisions: [], feedback: [] }
}

/** Portable experience engine. All mutations of a scope commit as one snapshot. */
export class ExperienceMemory {
  private readonly pending: Map<string, Promise<unknown>>
  private readonly indexes = new WeakMap<ExperienceSnapshot, {
    episodes: readonly ExperienceEpisode[]
    length: number
    byId: Map<string, ExperienceEpisode>
    families: Map<string, string>
  }>()

  constructor(private readonly store: ExperienceStore, readonly policy: ExperiencePolicy) {
    const pending = STORE_QUEUES.get(store) ?? new Map<string, Promise<unknown>>()
    STORE_QUEUES.set(store, pending)
    this.pending = pending
    for (const [key, value] of Object.entries(policy)) {
      if (!Number.isFinite(value) || value < 0) throw new ExperienceError('invalid-input', `Invalid experience policy: ${key}`)
    }
    for (const key of ['minTrustedEpisodes', 'maxEpisodes', 'maxSkills', 'maxTextLength', 'maxSteps', 'maxItemsPerField', 'maxCandidatesPerLearn', 'maxEpisodesPerLearn', 'maxExistingSkillsPerLearn', 'maxDistillationCharacters', 'maxRecall'] as const) {
      if (!Number.isSafeInteger(policy[key]) || policy[key] <= 0) throw new ExperienceError('invalid-input', `${key} must be a positive integer`)
    }
    for (const key of ['minConfidence', 'duplicateSimilarity', 'verifiedOutcomeWeight', 'userOutcomeWeight', 'modelOutcomeWeight', 'unknownOutcomeWeight'] as const) {
      if (!Number.isFinite(policy[key]) || policy[key] < 0 || policy[key] > 1) throw new ExperienceError('invalid-input', `${key} must be in [0, 1]`)
    }
    for (const key of ['skillTtlMs', 'candidateTtlMs'] as const) {
      if (!Number.isSafeInteger(policy[key]) || policy[key] <= 0) throw new ExperienceError('invalid-input', `${key} must be positive integer milliseconds`)
    }
    if (!Number.isFinite(policy.feedbackPrior) || !Number.isFinite(policy.harmfulFeedbackThreshold)
      || policy.feedbackPrior <= 0 || policy.harmfulFeedbackThreshold <= 0) {
      throw new ExperienceError('invalid-input', 'Feedback prior and harmful threshold must be positive')
    }
  }

  private scope(value: string): string {
    if (typeof value !== 'string' || !value.trim() || value.length > this.policy.maxTextLength) {
      throw new ExperienceError('invalid-input', 'A bounded, nonempty scope is required')
    }
    return value.trim()
  }

  /** Validate caller data rather than truncating evidence or changing its meaning. */
  private bounded(value: unknown): void {
    if (typeof value === 'string' && value.length > this.policy.maxTextLength) {
      throw new ExperienceError('invalid-input', 'Experience text exceeds maxTextLength')
    }
    if (Array.isArray(value)) value.forEach(item => this.bounded(item))
    else if (value !== null && typeof value === 'object') {
      for (const [key, item] of Object.entries(value)) { this.bounded(key); this.bounded(item) }
    }
  }

  private fields(content: ExperienceSkillContent): void {
    this.bounded(content)
    for (const field of [content.applicability, content.preconditions, content.procedure, content.cautions, content.verification, content.tags, content.requiredTools]) {
      if (field.length > this.policy.maxItemsPerField) throw new ExperienceError('invalid-input', 'Skill field exceeds maxItemsPerField')
    }
    if (Object.keys(content.environment).length > this.policy.maxItemsPerField) throw new ExperienceError('invalid-input', 'Too many environment constraints')
  }

  private serial<T>(scope: string, task: () => Promise<T>): Promise<T> {
    const next = (this.pending.get(scope) ?? Promise.resolve()).then(task, task)
    this.pending.set(scope, next)
    const cleanup = (): void => { if (this.pending.get(scope) === next) this.pending.delete(scope) }
    void next.then(cleanup, cleanup)
    return next
  }

  private async read(scope: string): Promise<MutableSnapshot> {
    const value = await this.store.get(scope)
    if (!value) return blank(scope)
    const parsed = ExperienceSnapshotSchema.parse(value)
    if (parsed.scope !== scope) throw new ExperienceError('invalid-input', 'Store returned another scope')
    return parsed
  }

  private mutate<T>(scopeInput: string, task: (snapshot: MutableSnapshot) => T | Promise<T>): Promise<T> {
    const scope = this.scope(scopeInput)
    return this.serial(scope, async () => {
      const snapshot = await this.read(scope)
      const before = canonical(snapshot)
      const result = await task(snapshot)
      if (before !== canonical(snapshot)) await this.store.put(scope, ExperienceSnapshotSchema.parse(snapshot))
      return structuredClone(result)
    })
  }

  /** An explicit administrative snapshot; raw episodes are never returned by recall. */
  snapshot(scopeInput: string): Promise<ExperienceSnapshot> {
    const scope = this.scope(scopeInput)
    return this.serial(scope, () => this.read(scope))
  }

  async record(input: ExperienceEpisodeInput): Promise<ExperienceEpisode> {
    const episode = ExperienceEpisodeInputSchema.parse(input)
    this.bounded(episode)
    if (episode.steps.length > this.policy.maxSteps) throw new ExperienceError('invalid-input', 'Episode exceeds maxSteps')
    if (Object.keys(episode.environment).length > this.policy.maxItemsPerField) throw new ExperienceError('invalid-input', 'Too many environment constraints')
    if (episode.completedAt > Date.now()) throw new ExperienceError('invalid-input', 'An episode cannot finish in the future')
    return this.mutate(episode.scope, snapshot => this.appendEpisode(snapshot, { ...episode, learnedBy: [] }))
  }

  private appendEpisode(snapshot: MutableSnapshot, episode: ExperienceEpisode): ExperienceEpisode {
    const existing = snapshot.episodes.find(item => item.id === episode.id)
    if (existing) {
      const { learnedBy: _old, ...oldInput } = existing
      const { learnedBy: _new, ...newInput } = episode
      if (canonical(oldInput) !== canonical(newInput)) throw new ExperienceError('identity-conflict', 'Episode identity already belongs to different content')
      return existing
    }
    if (snapshot.episodes.length >= this.policy.maxEpisodes) throw new ExperienceError('capacity', 'Experience episode capacity reached; export and explicitly forget material to reclaim it')
    if (episode.derivedFrom !== undefined && !snapshot.episodes.some(item => item.id === episode.derivedFrom)) {
      throw new ExperienceError('missing-evidence', 'Confirmation source episode does not exist')
    }
    snapshot.episodes.push(episode)
    return episode
  }

  /** Confirmation adds an immutable observation and re-evaluates its descendants. */
  async confirmOutcome(scope: string, episodeId: string, input: ExperienceOutcome): Promise<ExperienceEpisode> {
    const outcome = ExperienceOutcomeSchema.parse(input)
    this.bounded(outcome)
    if (!['user', 'verified'].includes(outcome.source) || !outcome.evidence.length) {
      throw new ExperienceError('invalid-input', 'Confirmation requires a user or verified outcome with evidence')
    }
    return this.mutate(scope, snapshot => {
      const source = this.episode(snapshot, episodeId)
      const latest = this.latest(snapshot, source.id)
      if (canonical(latest.outcome) === canonical(outcome)) return latest
      const id = `confirmation:${createHash('sha256').update(canonical({ episodeId: latest.id, outcome })).digest('hex')}`
      const now = Date.now()
      const confirmation = this.appendEpisode(snapshot, {
        ...source, id, derivedFrom: latest.id, outcome, learnedBy: [], completedAt: now,
        evidence: unique([...source.evidence, ...outcome.evidence]),
      })
      const family = this.family(snapshot, source.id)
      for (const skill of [...snapshot.skills]) {
        const supports = skill.episodeIds.some(id => this.family(snapshot, id) === family)
        const validates = snapshot.feedback.some(feedback => feedback.skillId === skill.id
          && this.family(snapshot, feedback.episodeId) === family)
        if (!supports && !validates) continue
        const next = this.assess(snapshot, supports ? { ...skill, episodeIds: unique([...skill.episodeIds, id]) } : skill, now)
        this.revise(snapshot, skill, next, 'Task outcome confirmed', now)
      }
      return confirmation
    })
  }

  private episode(snapshot: ExperienceSnapshot, id: string): ExperienceEpisode {
    let index = this.indexes.get(snapshot)
    if (!index || index.episodes !== snapshot.episodes || index.length !== snapshot.episodes.length) {
      index = { episodes: snapshot.episodes, length: snapshot.episodes.length,
        byId: new Map(snapshot.episodes.map(episode => [episode.id, episode])), families: new Map() }
      this.indexes.set(snapshot, index)
    }
    const episode = index.byId.get(id)
    if (!episode) throw new ExperienceError('missing-evidence', `Episode ${id} does not exist in this scope`)
    return episode
  }

  private family(snapshot: ExperienceSnapshot, id: string): string {
    const seen = new Set<string>()
    let episode = this.episode(snapshot, id)
    const families = this.indexes.get(snapshot)!.families
    const known = families.get(id)
    if (known) return known
    while (episode.derivedFrom !== undefined) {
      if (seen.has(episode.id)) throw new ExperienceError('invalid-input', 'Cyclic confirmation provenance')
      seen.add(episode.id)
      episode = this.episode(snapshot, episode.derivedFrom)
    }
    families.set(id, episode.id)
    for (const member of seen) families.set(member, episode.id)
    return episode.id
  }

  private latest(snapshot: ExperienceSnapshot, id: string): ExperienceEpisode {
    const family = this.family(snapshot, id)
    return snapshot.episodes.reduce((latest, episode) => this.family(snapshot, episode.id) === family
      && episode.completedAt >= latest.completedAt ? episode : latest, this.episode(snapshot, family))
  }

  private outcomeWeight(episode: ExperienceEpisode): number {
    switch (episode.outcome.source) {
      case 'verified': return this.policy.verifiedOutcomeWeight
      case 'user': return this.policy.userOutcomeWeight
      case 'model': return this.policy.modelOutcomeWeight
      case 'unknown': return this.policy.unknownOutcomeWeight
    }
  }

  private trusted(episode: ExperienceEpisode): boolean {
    return (episode.outcome.source === 'verified' || episode.outcome.source === 'user')
      && episode.outcome.evidence.length > 0 && this.outcomeWeight(episode) > 0
  }

  /** A later confirmation supersedes the judgement, while all provenance remains. */
  private supporting(snapshot: ExperienceSnapshot, skill: ExperienceSkill): ExperienceEpisode[] {
    const families = new Set(skill.episodeIds.map(id => this.family(snapshot, id)))
    const latest = new Map<string, ExperienceEpisode>()
    for (const episode of snapshot.episodes) {
      const family = this.family(snapshot, episode.id)
      if (!families.has(family)) continue
      const old = latest.get(family)
      if (!old || episode.completedAt >= old.completedAt) latest.set(family, episode)
    }
    return [...latest.values()]
  }

  private assessment(snapshot: ExperienceSnapshot, skill: ExperienceSkill): { confidence: number; count: number; at: number | null; harmful: number } {
    const episodes = this.supporting(snapshot, skill)
    const trusted = new Map<string, ExperienceEpisode>()
    const eligible = episodes.filter(episode => supportsOutcome(skill, episode))
    for (const episode of eligible.filter(episode => this.trusted(episode))) {
      const key = episode.sessionId ?? this.family(snapshot, episode.id)
      const previous = trusted.get(key)
      if (!previous || episode.completedAt > previous.completedAt) trusted.set(key, episode)
    }
    let helpful = 0
    let harmful = 0
    const seenFeedback = new Set<string>()
    for (const feedback of snapshot.feedback.filter(item => item.skillId === skill.id)) {
      const episode = this.latest(snapshot, feedback.episodeId)
      if (!this.trusted(episode)) continue
      const key = episode.sessionId ?? this.family(snapshot, episode.id)
      if (seenFeedback.has(key)) continue
      seenFeedback.add(key)
      const weight = this.outcomeWeight(episode)
      if (feedback.verdict === 'helpful' && episode.outcome.status === 'success') {
        helpful += weight
        trusted.set(key, episode)
      } else if (feedback.verdict === 'harmful' && ['failure', 'partial'].includes(episode.outcome.status)) harmful += weight
    }
    const trustedEvidence = eligible.filter(episode => this.trusted(episode))
    const weightedEvidence = trustedEvidence.length ? trustedEvidence : eligible
    const evidenceWeight = weightedEvidence.length
      ? weightedEvidence.reduce((sum, episode) => sum + this.outcomeWeight(episode), 0) / weightedEvidence.length
      : 0
    const prior = this.policy.feedbackPrior
    const confidence = (skill.proposedConfidence * evidenceWeight * prior + helpful) / (prior + helpful + harmful)
    return {
      confidence, count: trusted.size, harmful,
      at: trusted.size ? Math.max(...[...trusted.values()].map(episode => episode.completedAt)) : null,
    }
  }

  private assess(snapshot: ExperienceSnapshot, skill: ExperienceSkill, now: number): ExperienceSkill {
    if (skill.status === 'retracted' || skill.status === 'deprecated') return skill
    const assessment = this.assessment(snapshot, skill)
    const trusted = assessment.count >= this.policy.minTrustedEpisodes && assessment.confidence >= this.policy.minConfidence
    let status = skill.status
    if (assessment.harmful >= this.policy.harmfulFeedbackThreshold || skill.conflictsWith.length) status = 'quarantined'
    else if (status !== 'quarantined' && status !== 'expired') {
      if (trusted) status = 'active'
      else status = skill.status === 'active' ? 'quarantined' : 'candidate'
    }
    const expiresAt = trusted && assessment.at !== null
      ? assessment.at + this.policy.skillTtlMs
      : skill.createdAt + this.policy.candidateTtlMs
    if (expiresAt <= now && status !== 'quarantined') status = 'expired'
    return { ...skill, confidence: assessment.confidence, lastValidatedAt: assessment.at, expiresAt, status }
  }

  private revise(snapshot: MutableSnapshot, old: ExperienceSkill | undefined, next: ExperienceSkill, reason: string, at: number): ExperienceSkill {
    if (old && canonical(old) === canonical(next)) return old
    const skill = { ...next, version: old ? old.version + 1 : 1, updatedAt: at }
    const index = snapshot.skills.findIndex(item => item.id === skill.id)
    if (index >= 0) snapshot.skills[index] = skill
    else snapshot.skills.push(skill)
    snapshot.revisions.push({ id: randomUUID(), skillId: skill.id, version: skill.version, at, reason, skill })
    if (skill.status === 'active' && skill.supersedes) {
      const predecessor = snapshot.skills.find(item => item.id === skill.supersedes)
      if (predecessor && predecessor.supersededBy !== skill.id) {
        this.revise(snapshot, predecessor, {
          ...predecessor, status: predecessor.status === 'retracted' ? 'retracted' : 'deprecated', supersededBy: skill.id,
        }, 'Replaced by a validated skill', at)
      }
    }
    return skill
  }

  private validateCandidates(values: readonly ExperienceCandidate[]): ExperienceCandidate[] {
    if (values.length > this.policy.maxCandidatesPerLearn) throw new ExperienceError('invalid-input', 'Too many candidates in one extraction')
    return values.map(value => {
      const candidate = ExperienceCandidateSchema.parse(value)
      this.fields(candidate)
      return { ...candidate, episodeIds: unique(candidate.episodeIds), requiredTools: unique(candidate.requiredTools) }
    })
  }

  private addCandidates(snapshot: MutableSnapshot, candidates: readonly ExperienceCandidate[], now: number): ExperienceSkill[] {
    const results: ExperienceSkill[] = []
    for (const candidate of candidates) {
      for (const id of candidate.episodeIds) this.episode(snapshot, id)
      const predecessor = candidate.supersedes ? snapshot.skills.find(skill => skill.id === candidate.supersedes) : undefined
      if (candidate.supersedes && !predecessor) throw new ExperienceError('missing-evidence', 'Superseded skill does not exist in this scope')
      const candidateFamilies = new Set(candidate.episodeIds.map(id => this.family(snapshot, id)))
      const preciseMatch = (skill: ExperienceSkill): boolean => skill.kind === candidate.kind && sameContext(skill, candidate)
        && (canonical(contentOf(skill)) === canonical(contentOf(candidate))
          || (similarity(searchText(skill), searchText(candidate)) >= this.policy.duplicateSimilarity
            && canonical(skill.procedure) === canonical(candidate.procedure)
            && canonical(skill.verification) === canonical(candidate.verification)))
      // Ordinary rewording preserves established instructions; explicit successors remain distinct.
      const sameTaskVariant = (skill: ExperienceSkill): boolean => candidate.supersedes === undefined
        && skill.kind === candidate.kind && sameContext(skill, candidate)
        && skill.title.toLowerCase() === candidate.title.toLowerCase()
        && similarity(searchText(skill), searchText(candidate)) >= this.policy.duplicateSimilarity
        && [...candidateFamilies].every(family => skill.episodeIds.some(id => this.family(snapshot, id) === family))
      const terminal = snapshot.skills.find(skill => ['retracted', 'deprecated'].includes(skill.status) && preciseMatch(skill))
      if (terminal) { results.push(terminal); continue }
      const duplicate = snapshot.skills.find(skill => skill.status !== 'retracted' && skill.status !== 'deprecated'
        && skill.id !== candidate.supersedes && (preciseMatch(skill) || sameTaskVariant(skill)))
      if (duplicate) {
        // A new trusted outcome can correct the extractor's earlier uncertainty.
        // Legacy evidence-only merge revisions did not reassess this estimate.
        const assessedIds = new Set(snapshot.revisions.filter(revision => revision.skillId === duplicate.id
          && (revision.reason === 'Extracted from task evidence' || revision.reason === CONFIDENCE_REASSESSMENT))
          .flatMap(revision => revision.skill.episodeIds))
        const newTrustedOutcome = candidate.episodeIds.some(id => {
          const episode = this.episode(snapshot, id)
          return !assessedIds.has(id) && this.trusted(episode) && supportsOutcome(duplicate, episode)
        })
        const merged = {
          ...duplicate, episodeIds: unique([...duplicate.episodeIds, ...candidate.episodeIds]),
          proposedConfidence: newTrustedOutcome ? Math.max(duplicate.proposedConfidence, candidate.confidence) : duplicate.proposedConfidence,
        }
        const assessed = this.assess(snapshot, merged, now)
        // Record consumption even when the proposed confidence stays unchanged.
        const next = newTrustedOutcome ? { ...assessed, version: duplicate.version + 1 } : assessed
        results.push(this.revise(snapshot, duplicate, next,
          newTrustedOutcome ? CONFIDENCE_REASSESSMENT : 'Merged duplicate evidence', now))
        continue
      }
      // A near match to an ancestor must not mask an already-present successor.
      const withdrawnVariant = snapshot.skills.find(skill => ['retracted', 'deprecated'].includes(skill.status) && sameTaskVariant(skill))
      if (withdrawnVariant) { results.push(withdrawnVariant); continue }
      if (predecessor?.supersededBy) throw new ExperienceError('invalid-input', 'Supersede the latest skill in the replacement chain')
      if (snapshot.skills.length >= this.policy.maxSkills) throw new ExperienceError('capacity', 'Experience skill capacity reached; export and explicitly forget material to reclaim it')
      const provisional: ExperienceSkill = {
        ...contentOf(candidate), id: randomUUID(), scope: snapshot.scope, version: 1, status: 'candidate',
        confidence: candidate.confidence, proposedConfidence: candidate.confidence, episodeIds: candidate.episodeIds,
        conflictsWith: [], createdAt: now, updatedAt: now, lastValidatedAt: null, expiresAt: now + this.policy.candidateTtlMs,
        ...(candidate.supersedes ? { supersedes: candidate.supersedes } : {}),
      }
      let next = this.assess(snapshot, provisional, now)
      const conflicts = snapshot.skills.filter(skill => skill.status === 'active' && skill.id !== candidate.supersedes
        && sameContext(skill, candidate) && skill.title.toLowerCase() === candidate.title.toLowerCase()
        && (skill.kind !== candidate.kind || canonical(skill.procedure) !== canonical(candidate.procedure)))
      if (conflicts.length && next.status === 'active') {
        next = { ...next, status: 'quarantined', conflictsWith: conflicts.map(skill => skill.id) }
        for (const conflict of conflicts) {
          const previousTasks = new Set(this.supporting(snapshot, conflict)
            .map(episode => episode.sessionId ?? this.family(snapshot, episode.id)))
          const independentSupport = new Set(this.supporting(snapshot, next)
            .filter(episode => this.trusted(episode) && supportsOutcome(next, episode))
            .map(episode => episode.sessionId ?? this.family(snapshot, episode.id))
            .filter(task => !previousTasks.has(task)))
          // An alternative reading of one task cannot revoke its established skill.
          if (independentSupport.size < this.policy.minTrustedEpisodes) continue
          this.revise(snapshot, conflict, {
            ...conflict, status: 'quarantined', conflictsWith: unique([...conflict.conflictsWith, next.id]),
          }, 'Conflicting supported procedure requires review', now)
        }
      } else if (conflicts.length) next = { ...next, status: 'quarantined', conflictsWith: conflicts.map(skill => skill.id) }
      const stored = this.revise(snapshot, undefined, next, 'Extracted from task evidence', now)
      results.push(stored)
    }
    return results
  }

  propose(scope: string, candidates: readonly ExperienceCandidate[]): Promise<readonly ExperienceSkill[]> {
    const validated = this.validateCandidates(candidates)
    return this.mutate(scope, snapshot => this.addCandidates(snapshot, validated, Date.now()))
  }

  /** Extraction runs outside the write queue; provenance is checked again at commit. */
  async learn(scope: string, distiller: ExperienceDistiller, options: { readonly episodeIds?: readonly string[]; readonly signal?: AbortSignal } = {}): Promise<ExperienceLearnResult> {
    this.bounded(distiller.name)
    if (!distiller.name.trim()) throw new ExperienceError('invalid-input', 'A versioned distiller identity is required')
    options.signal?.throwIfAborted()
    const before = await this.snapshot(scope)
    const available = options.episodeIds === undefined
      ? before.episodes.filter(episode => !episode.learnedBy.includes(distiller.name))
      : unique(options.episodeIds).map(id => this.episode(before, id)).filter(episode => !episode.learnedBy.includes(distiller.name))
    if (!available.length) return { episodes: [], skills: [], skippedEpisodes: [] }
    const fits = (episodes: readonly ExperienceEpisode[], existing: readonly ExperienceSkill[]): boolean =>
      serializeExperienceDistillation({ scope: before.scope, episodes, existing }).length <= this.policy.maxDistillationCharacters
    const seed = available.find(episode => fits([episode], []))
    if (!seed) throw new ExperienceError('invalid-input', `Pending episodes individually exceed maxDistillationCharacters; supply a larger budget or smaller task episodes (${available.map(episode => episode.id).slice(0, this.policy.maxEpisodesPerLearn).join(', ')})`)
    const existing = before.skills.filter(skill => !['retracted', 'deprecated'].includes(skill.status))
    const relevant = bm25Rank(tokenize(seed.task),
      existing.map(skill => ({ item: skill, terms: tokenize(searchText(skill)) }))).map(item => item.item)
    const rankedSkills = unique([...relevant, ...existing.toSorted((a, b) => b.updatedAt - a.updatedAt)])
    const firstSkill = rankedSkills.find(skill => fits([seed], [skill]))
    const offeredSkills: ExperienceSkill[] = firstSkill ? [firstSkill] : []
    const selected: ExperienceEpisode[] = []
    const skippedEpisodes: string[] = []
    for (const episode of available) {
      if (selected.length >= this.policy.maxEpisodesPerLearn) break
      if (fits([...selected, episode], offeredSkills)) selected.push(episode)
      else skippedEpisodes.push(episode.id)
    }
    for (const skill of rankedSkills) {
      if (offeredSkills.length >= this.policy.maxExistingSkillsPerLearn) break
      if (!offeredSkills.includes(skill) && fits(selected, [...offeredSkills, skill])) offeredSkills.push(skill)
    }
    const candidates = this.validateCandidates(await distiller.distill({
      scope: before.scope, episodes: structuredClone(selected),
      existing: structuredClone(offeredSkills),
      ...(options.signal ? { signal: options.signal } : {}),
    }))
    options.signal?.throwIfAborted()
    const offered = new Set(selected.map(episode => episode.id))
    if (candidates.some(candidate => candidate.episodeIds.some(id => !offered.has(id)))) {
      throw new ExperienceError('missing-evidence', 'Extractor cited an episode outside its input')
    }
    return this.mutate(scope, snapshot => {
      options.signal?.throwIfAborted()
      for (const episode of selected) {
        const current = this.episode(snapshot, episode.id)
        const { learnedBy: _before, ...original } = episode
        const { learnedBy: _after, ...present } = current
        if (canonical(original) !== canonical(present)) throw new ExperienceError('identity-conflict', 'Episode changed during extraction')
      }
      if (selected.every(episode => this.episode(snapshot, episode.id).learnedBy.includes(distiller.name))) return { episodes: [], skills: [], skippedEpisodes }
      const skills = this.addCandidates(snapshot, candidates, Date.now())
      snapshot.episodes = snapshot.episodes.map(episode => offered.has(episode.id)
        ? { ...episode, learnedBy: unique([...episode.learnedBy, distiller.name]) } : episode)
      return { episodes: selected.map(episode => episode.id), skills, skippedEpisodes }
    })
  }

  feedback(scope: string, input: ExperienceFeedbackInput): Promise<ExperienceSkill> {
    const feedback = ExperienceFeedbackInputSchema.parse(input)
    this.bounded(feedback)
    return this.mutate(scope, snapshot => {
      const skill = snapshot.skills.find(item => item.id === feedback.skillId)
      if (!skill) throw new ExperienceError('not-found', 'Skill does not exist in this scope')
      const existing = snapshot.feedback.find(item => item.id === feedback.id)
      if (existing) {
        const { createdAt: _at, ...original } = existing
        if (canonical(original) !== canonical(feedback)) throw new ExperienceError('identity-conflict', 'Feedback identity already belongs to different content')
        return skill
      }
      const episode = this.latest(snapshot, feedback.episodeId)
      if (snapshot.feedback.some(item => item.skillId === skill.id && this.family(snapshot, item.episodeId) === this.family(snapshot, episode.id))) {
        throw new ExperienceError('identity-conflict', 'This task already provided feedback for this skill')
      }
      const source = this.supporting(snapshot, skill)
      if (source.some(item => this.family(snapshot, item.id) === this.family(snapshot, episode.id)
        || (item.sessionId !== undefined && item.sessionId === episode.sessionId)) || episode.startedAt < skill.createdAt) {
        throw new ExperienceError('invalid-input', 'Feedback must come from a later independent task')
      }
      if (!environmentMatches(skill.environment, episode.environment)) throw new ExperienceError('invalid-input', 'Feedback environment does not satisfy this skill')
      if (feedback.verdict === 'helpful' && episode.outcome.status !== 'success') throw new ExperienceError('invalid-input', 'Helpful feedback requires a successful outcome')
      if (feedback.verdict === 'harmful' && !['failure', 'partial'].includes(episode.outcome.status)) throw new ExperienceError('invalid-input', 'Harmful feedback requires a failed or partial outcome')
      const now = Date.now()
      snapshot.feedback.push({ ...feedback, createdAt: now })
      return this.revise(snapshot, skill, this.assess(snapshot, skill, now), `Task feedback: ${feedback.verdict}`, now)
    })
  }

  async recall(query: ExperienceRecallQuery): Promise<readonly ExperienceRecallHit[]> {
    this.bounded(query.text)
    const limit = query.limit ?? this.policy.maxRecall
    if (!Number.isSafeInteger(limit) || limit < 0) throw new ExperienceError('invalid-input', 'Recall limit must be a nonnegative integer')
    const now = query.now ?? Date.now()
    checkTime(now)
    const scopes = unique(query.scopes.map(scope => this.scope(scope)))
    const snapshots = await Promise.all(scopes.map(scope => this.snapshot(scope)))
    const tools = new Set(query.availableTools ?? [])
    const candidates = snapshots.flatMap(snapshot => snapshot.skills.filter(skill => skill.status === 'active'
      && skill.expiresAt > now && skill.confidence >= this.policy.minConfidence
      && environmentMatches(skill.environment, query.environment)
      && skill.requiredTools.every(tool => tools.has(tool))).map(skill => ({ skill, snapshot })))
    const ranked = bm25Rank(tokenize(query.text), candidates.map(item => ({ item, terms: tokenize(searchText(item.skill)) })))
    const hits = ranked.map(({ item }, position): ExperienceRecallHit => ({
      skill: structuredClone(item.skill), score: rankScore(position) * item.skill.confidence,
      evidence: unique([
        ...this.supporting(item.snapshot, item.skill).flatMap(episode => episode.evidence),
        ...item.snapshot.feedback.filter(feedback => feedback.skillId === item.skill.id)
          .flatMap(feedback => this.latest(item.snapshot, feedback.episodeId).evidence),
      ]),
    })).sort((left, right) => right.score - left.score || left.skill.id.localeCompare(right.skill.id))
    const selected: ExperienceRecallHit[] = []
    for (const hit of hits) {
      if (selected.length >= Math.min(limit, this.policy.maxRecall)) break
      if (selected.some(previous => previous.skill.kind === hit.skill.kind && sameContext(previous.skill, hit.skill)
        && similarity(searchText(previous.skill), searchText(hit.skill)) >= this.policy.duplicateSimilarity)) continue
      selected.push(hit)
    }
    return selected
  }

  maintain(scope: string, now = Date.now()): Promise<ExperienceMaintenanceReport> {
    checkTime(now)
    return this.mutate(scope, snapshot => {
      const report = { expired: 0, deprecated: 0, quarantined: 0 }
      const priorStatus = new Map(snapshot.skills.map(skill => [skill.id, skill.status]))
      for (const original of [...snapshot.skills]) {
        const skill = snapshot.skills.find(item => item.id === original.id)!
        const next = this.assess(snapshot, skill, now)
        if (next.status !== skill.status) {
          if (next.status === 'expired') report.expired++
          if (next.status === 'quarantined') report.quarantined++
        }
        this.revise(snapshot, skill, next, 'Lifecycle maintenance', now)
      }
      report.deprecated = snapshot.skills.filter(skill => skill.status === 'deprecated' && priorStatus.get(skill.id) !== 'deprecated').length
      return report
    })
  }

  retract(scope: string, skillId: string, reason: string): Promise<ExperienceSkill> {
    this.bounded(reason)
    if (!reason.trim()) throw new ExperienceError('invalid-input', 'Retraction reason is required')
    return this.mutate(scope, snapshot => {
      const skill = snapshot.skills.find(item => item.id === skillId)
      if (!skill) throw new ExperienceError('not-found', 'Skill does not exist in this scope')
      return this.revise(snapshot, skill, { ...skill, status: 'retracted' }, reason, Date.now())
    })
  }

  /** Remove every derived artifact, including historical revisions, on erasure. */
  forget(scopeInput: string, target: ExperienceForgetTarget): Promise<ExperienceForgetReport> {
    const scope = this.scope(scopeInput)
    return this.serial(scope, async () => {
      const snapshot = await this.read(scope)
      const before = { episodes: snapshot.episodes.length, skills: snapshot.skills.length, revisions: snapshot.revisions.length, feedback: snapshot.feedback.length }
      if ('all' in target) { await this.store.delete(scope); return before }
      const episodes = new Set(snapshot.episodes.filter(episode => ('episodeId' in target && episode.id === target.episodeId)
        || ('evidenceId' in target && episode.evidence.includes(target.evidenceId))).map(episode => episode.id))
      const skills = new Set('skillId' in target ? [target.skillId] : [])
      if ('skillId' in target) {
        const skill = snapshot.skills.find(item => item.id === target.skillId)
        if (skill) {
          const sourceIds = [...skill.episodeIds, ...snapshot.feedback.filter(item => item.skillId === skill.id).map(item => item.episodeId)]
          const sourceFamilies = new Set(sourceIds.map(id => this.family(snapshot, id)))
          for (const episode of snapshot.episodes) if (sourceFamilies.has(this.family(snapshot, episode.id))) episodes.add(episode.id)
        }
      }
      let changed = true
      while (changed) {
        changed = false
        for (const episode of snapshot.episodes) {
          if (episode.derivedFrom && episodes.has(episode.derivedFrom) && !episodes.has(episode.id)) { episodes.add(episode.id); changed = true }
        }
        for (const skill of snapshot.skills) {
          if (skills.has(skill.id)) continue
          if (skill.episodeIds.some(id => episodes.has(id)) || (skill.supersedes !== undefined && skills.has(skill.supersedes))) {
            skills.add(skill.id); changed = true
          }
        }
        const forgottenFamilies = new Set([...episodes].map(id => this.family(snapshot, id)))
        for (const feedback of snapshot.feedback) {
          if (forgottenFamilies.has(this.family(snapshot, feedback.episodeId)) && !skills.has(feedback.skillId)) { skills.add(feedback.skillId); changed = true }
        }
      }
      snapshot.episodes = snapshot.episodes.filter(episode => !episodes.has(episode.id))
      snapshot.skills = snapshot.skills.filter(skill => !skills.has(skill.id)).map(skill => {
        const { supersededBy, ...rest } = skill
        return { ...rest, conflictsWith: skill.conflictsWith.filter(id => !skills.has(id)),
          ...(supersededBy && !skills.has(supersededBy) ? { supersededBy } : {}) }
      })
      snapshot.revisions = snapshot.revisions.filter(revision => !skills.has(revision.skillId)
        && !revision.skill.episodeIds.some(id => episodes.has(id))).map(revision => {
        const { supersededBy, ...rest } = revision.skill
        return { ...revision, skill: { ...rest, conflictsWith: rest.conflictsWith.filter(id => !skills.has(id)),
          ...(supersededBy && !skills.has(supersededBy) ? { supersededBy } : {}) } }
      })
      snapshot.feedback = snapshot.feedback.filter(feedback => !skills.has(feedback.skillId) && !episodes.has(feedback.episodeId))
      await this.store.put(scope, ExperienceSnapshotSchema.parse(snapshot))
      return {
        episodes: before.episodes - snapshot.episodes.length, skills: before.skills - snapshot.skills.length,
        revisions: before.revisions - snapshot.revisions.length, feedback: before.feedback - snapshot.feedback.length,
      }
    })
  }

  async export(scope: string, skillId: string): Promise<string> {
    const skill = (await this.snapshot(scope)).skills.find(item => item.id === skillId)
    if (!skill) throw new ExperienceError('not-found', 'Skill does not exist in this scope')
    return renderSkillMarkdown(skill)
  }
}

/** Export is advisory Markdown; it never installs or executes a skill. */
export function renderSkillMarkdown(skill: ExperienceSkill): string {
  const section = (name: string, items: readonly string[]): string => items.length ? `\n## ${name}\n\n${items.map(item => `- ${item}`).join('\n')}\n` : ''
  const name = `experience-${createHash('sha256').update(skill.id).digest('hex').slice(0, 32)}`
  const description = JSON.stringify(skill.description).replaceAll('\u2028', '\\u2028').replaceAll('\u2029', '\\u2029')
  return `---\nname: ${name}\ndescription: ${description}\n---\n\n`
    + `# ${skill.title}\n\n${skill.description}\n\nStatus: ${skill.status}; version: ${skill.version}; kind: ${skill.kind}.\n`
    + `\nScope: ${skill.scope}\n\nExpires: ${new Date(skill.expiresAt).toISOString()}\n`
    + section('Applicability', skill.applicability) + section('Preconditions', skill.preconditions)
    + section('Environment', Object.entries(skill.environment).map(([key, value]) => `${key}: ${value}`))
    + section('Required tools', skill.requiredTools) + section('Procedure', skill.procedure)
    + section('Cautions', skill.cautions) + section('Verification', skill.verification)
    + section('Source episodes', skill.episodeIds)
}
