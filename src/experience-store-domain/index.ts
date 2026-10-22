import type { Context } from '@deepseek-ai/cordis'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import type { Domain } from '@deepseek-ai/dsh-storage-domain'
import type { ExperienceSnapshot, ExperienceStore } from '../experience/types.ts'
import { ExperienceSnapshotSchema } from '../experience/schema.ts'
import type {} from '../experience/index.ts'

export const name = 'experience-store-domain'
export const inject = ['experience', 'storageDomain']

/** A separate domain keeps procedural learning out of the factual graph. */
export const experienceDomainSpec = defineDomain({
  name: 'experience',
  version: 1,
  tables: { scopes: domainTable<string, ExperienceSnapshot>(ExperienceSnapshotSchema) },
})

export class DomainExperienceStore implements ExperienceStore {
  constructor(private readonly domain: Domain<typeof experienceDomainSpec>) {}
  async get(scope: string): Promise<ExperienceSnapshot | undefined> {
    const value = this.domain.table('scopes').get(scope)
    return value === undefined ? undefined : structuredClone(value)
  }
  async put(scope: string, snapshot: ExperienceSnapshot): Promise<void> {
    if (snapshot.scope !== scope) throw new Error('Experience scope mismatch')
    await this.domain.table('scopes').put(scope, structuredClone(snapshot))
  }
  async delete(scope: string): Promise<void> { await this.domain.table('scopes').delete(scope) }
}

export async function apply(ctx: Context): Promise<void> {
  const domain = await ctx.storageDomain.open(experienceDomainSpec)
  ctx.effect(() => async () => { await domain.close() })
  ctx.effect(() => ctx.experience.registerStore(new DomainExperienceStore(domain)))
}
