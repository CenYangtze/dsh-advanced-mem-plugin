import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { assertUsableApiKey } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-settings'

/** Non-secret model choices persisted by the Harness configuration editor. */
export interface ExperienceModelSettings {
  /** Inherit preserves an explicitly configured legacy API mode; otherwise it follows the session. */
  readonly mode: 'inherit' | 'harness' | 'api'
  readonly provider?: string | undefined
  readonly model?: string | undefined
  readonly reasoningEffort?: string | undefined
  readonly endpoint?: string | undefined
  readonly apiKeyRef?: string | undefined
}

export const EXPERIENCE_SETTINGS_NAMESPACE = 'experience-harness'
export const EXPERIENCE_API_KEY_REFERENCE = 'DSH_EXPERIENCE_API_KEY'

/** The credential field is a reference; no API-key literal belongs in Config. */
export const modelSettingsSchema = z.object({
  mode: z.union(['inherit', 'harness', 'api'] as const).required()
    .description('Follow the current session, select a Harness model, or use an independent OpenAI-compatible API.'),
  provider: z.string().description('Harness provider identifier for the selected memory model.'),
  model: z.string().description('Model identifier for the Harness override or independent API.'),
  reasoningEffort: z.string().description('Optional reasoning effort supported by the selected Harness model.'),
  endpoint: z.string().description('Complete HTTP(S) chat/completions endpoint for an independent API.'),
  apiKeyRef: z.string().role('credential-ref').description('Harness credential reference; enter the actual key only in the dedicated API-key control.'),
}).default({ mode: 'inherit' }).volatile()

const fields = new Set(['mode', 'provider', 'model', 'reasoningEffort', 'endpoint', 'apiKeyRef'])

/** Validate without putting supplied values in diagnostics or accepting secret fields. */
export function readExperienceModelSettings(input: unknown): ExperienceModelSettings {
  const raw: unknown = input !== null && typeof input === 'object' && 'get' in input && typeof input.get === 'function' ? input.get() : input
  if (raw === undefined) return { mode: 'inherit' }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new TypeError('Invalid memory model settings')
  const record = raw as Record<string, unknown>
  if (Object.keys(record).some(key => !fields.has(key))) throw new TypeError('Memory model settings contain an unsupported field')
  if (!['inherit', 'harness', 'api'].includes(String(record.mode))) throw new TypeError('Invalid memory model selection mode')
  for (const key of ['provider', 'model', 'reasoningEffort', 'endpoint', 'apiKeyRef']) {
    if (record[key] !== undefined && (typeof record[key] !== 'string' || /[\r\n\0]/.test(record[key] as string))) throw new TypeError('Invalid memory model field')
  }
  const result = Object.fromEntries(Object.entries(record).flatMap(([key, value]) => {
    if (typeof value !== 'string') return []
    const text = value.trim()
    return text ? [[key, text]] : []
  })) as unknown as ExperienceModelSettings
  if (result.apiKeyRef !== undefined && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(result.apiKeyRef)) throw new TypeError('API key must be stored through the credential control; the reference must be an identifier')
  if (result.mode === 'harness' && (!result.provider || !result.model)) throw new TypeError('A Harness memory model needs both provider and model')
  if (result.mode === 'api' && (!result.endpoint || !result.model)) throw new TypeError('An independent memory API needs endpoint and model')
  if (result.endpoint !== undefined) {
    let endpoint: URL
    try { endpoint = new URL(result.endpoint) } catch { throw new TypeError('Invalid memory API endpoint') }
    if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
      throw new TypeError('Memory API endpoint must be HTTP(S), without embedded credentials, query, or fragment')
    }
  }
  return result
}

/** Re-resolve at request time so credential rotation applies to the next auxiliary request. */
export async function resolveExperienceApiCredential(ctx: Context, reference: string | undefined, options: { allowMissing?: boolean } = {}): Promise<string> {
  if (!reference) return ''
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(reference)) throw new TypeError('Invalid memory API credential reference')
  const credentials = ctx.get('credentials')
  // Headless legacy deployments may provide the named environment value without a credential service.
  const value = credentials ? (await credentials.resolve(credentialRef(reference)))?.value : process.env[reference]
  if (!value) {
    if (options.allowMissing) return ''
    throw new Error('The selected memory API credential is not configured')
  }
  return assertUsableApiKey(value, 'experience-harness', reference)
}

/** Expose the companion page and reject unsafe values before the editor writes them. */
export function registerExperienceModelSettings(ctx: Context): void {
  ctx.inject(['settings'], (child) => { child.effect(() => child.settings.configure({ auto: false }, ctx.fiber)) })
  ctx.on('internal/config', function (this, _raw, next) {
    const raw: unknown = next()
    if (this === ctx.fiber && raw !== null && typeof raw === 'object' && 'modelSettings' in raw) readExperienceModelSettings(raw.modelSettings)
    return raw
  })
}
