import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { ExperienceMemory } from './core.ts'
import type { ExperiencePolicy, ExperienceStore } from './types.ts'

export * from './types.ts'
export { ExperienceMemory, ExperienceError, renderSkillMarkdown } from './core.ts'
export * from './provider.ts'
export * from './schema.ts'
export { FileExperienceStore } from './store.ts'

declare module '@deepseek-ai/cordis' {
  interface Context { experience: ExperienceRuntime }
  interface Events {
    /** Published only after a durable experience mutation. */
    'experience/changed'(scope: string): void
  }
}

/** Independent service: factual records and experience snapshots never share a table. */
export class ExperienceRuntime extends Service {
  static Config: z<ExperiencePolicy> = z.object({
    minTrustedEpisodes: z.number().required(),
    minConfidence: z.number().required(),
    duplicateSimilarity: z.number().required(),
    skillTtlMs: z.number().required(),
    candidateTtlMs: z.number().required(),
    maxEpisodes: z.number().required(),
    maxSkills: z.number().required(),
    maxTextLength: z.number().required(),
    maxSteps: z.number().required(),
    maxItemsPerField: z.number().required(),
    maxCandidatesPerLearn: z.number().required(),
    maxEpisodesPerLearn: z.number().required(),
    maxExistingSkillsPerLearn: z.number().required(),
    maxDistillationCharacters: z.number().required(),
    maxRecall: z.number().required(),
    feedbackPrior: z.number().required(),
    harmfulFeedbackThreshold: z.number().required(),
    verifiedOutcomeWeight: z.number().required(),
    userOutcomeWeight: z.number().required(),
    modelOutcomeWeight: z.number().required(),
    unknownOutcomeWeight: z.number().required(),
  })

  private core: ExperienceMemory | undefined
  constructor(ctx: Context, readonly policy: ExperiencePolicy) { super(ctx, 'experience') }
  get ready(): boolean { return this.core !== undefined }
  get memory(): ExperienceMemory {
    if (!this.core) throw new Error('Experience memory has no durable store mounted')
    return this.core
  }

  registerStore(store: ExperienceStore): () => void {
    if (this.core) throw new Error('Experience memory already has a store')
    const notify = (scope: string): void => {
      try { this.ctx.emit('experience/changed', scope) }
      catch (error) { this.ctx.logger.warn(`experience: change listener failed: ${String(error)}`) }
    }
    const core = new ExperienceMemory({
      get: scope => store.get(scope),
      put: async (scope, snapshot) => { await store.put(scope, snapshot); notify(scope) },
      delete: async scope => { await store.delete(scope); notify(scope) },
    }, this.policy)
    this.core = core
    return () => { if (this.core === core) this.core = undefined }
  }
}

export default ExperienceRuntime
