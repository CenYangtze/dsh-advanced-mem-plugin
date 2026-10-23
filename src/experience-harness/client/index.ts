import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import { MemorySettingsPage, type MemorySettingsFace, type MemorySettingsSection } from './SettingsPage.ts'
import { en, zh, type MemorySettingsLocaleKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap { 'settings.experienceMemory': MemorySettingsLocaleKey }
}

export const inject = ['slots', 'locale', 'remote', 'remote.credentials', 'configForms']

/** One bundle-owned page; credentials travel through their dedicated write-only API. */
export function apply(ctx: Context): void {
  const namespace = 'experience-harness', locale = 'settings.experienceMemory'
  ctx.effect(() => ctx.locale.register(locale, { en, zh }), 'experience-memory: model settings copy')
  const form = ctx.configForms.get<MemorySettingsSection>(namespace)
  const face: MemorySettingsFace = {
    hooks: { memorySettings: form },
    saveSettings: (settings, revision) => {
      const value: Record<string, string> = {}
      for (const [key, field] of Object.entries(settings)) if (field !== undefined) value[key] = field
      return form.mutate([{ op: 'set', path: ['modelSettings'], value }], revision)
    },
    describeCredential: async reference => {
      const answer = await ctx.remote.credentials.describe([reference])
      if (!answer.ok) return undefined
      const info = answer.value[reference]
      return info ? { configured: info.configured, writable: info.writable } : undefined
    },
    saveCredential: async (reference, value) => (await ctx.remote.credentials.set(reference, value)).ok,
  }
  ctx.effect(() => ctx.configForms.whileServed([namespace], () => ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({
    name: 'plugins.bundle.config', key: 'dsh-advanced-mem-plugin', locale, inject: () => face,
  }, MemorySettingsPage))), 'experience-memory: bundle settings page')
}
