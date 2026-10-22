import { setTimeout as delay } from 'node:timers/promises'
import type { TokenUsage } from './types.ts'

export type ApiContent = string | readonly ({ readonly type: 'text'; readonly text: string } | { readonly type: 'image_url'; readonly image_url: { readonly url: string } })[]
export interface ApiMessage { readonly role: 'system' | 'user' | 'assistant'; readonly content: ApiContent }
export interface ApiCompletion { readonly text: string; readonly usage: TokenUsage }
export interface ApiClient { complete(messages: readonly ApiMessage[], signal: AbortSignal): Promise<ApiCompletion> }
export interface OpenAIClientOptions {
  /** API root, for example https://api.deepseek.com/v1. */
  readonly baseUrl: string
  readonly apiKey: string
  readonly model: string
  readonly temperature: number
  readonly maxOutputTokens: number
  readonly timeoutMs: number
  readonly retries: number
  readonly retryBaseMs: number
  readonly headers?: Readonly<Record<string, string>>
}

/** Reproducibility metadata deliberately excludes authentication and custom headers. */
export function describeOpenAIClient(options: OpenAIClientOptions): Readonly<Record<string, unknown>> {
  const url = new URL(options.baseUrl)
  if (url.username || url.password || url.search) throw new Error('Use headers for API credentials; baseUrl must contain no credentials or query')
  return { baseUrl: url.href, model: options.model, temperature: options.temperature, maxOutputTokens: options.maxOutputTokens,
    timeoutMs: options.timeoutMs, retries: options.retries, retryBaseMs: options.retryBaseMs }
}

export function positiveInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`)
}

/** Retries inference only; environment actions are never replayed after a lost response. */
export function createOpenAIClient(options: OpenAIClientOptions): ApiClient {
  for (const key of ['timeoutMs', 'maxOutputTokens', 'retryBaseMs'] as const) positiveInteger(options[key], key)
  if (!Number.isSafeInteger(options.retries) || options.retries < 0) throw new Error('retries must be a non-negative integer')
  if (!Number.isFinite(options.temperature)) throw new Error('temperature must be finite')
  const endpoint = new URL(`${options.baseUrl.replace(/\/$/, '')}/chat/completions`)
  if (!['http:', 'https:'].includes(endpoint.protocol)) throw new Error('API base URL must use HTTP(S)')
  return { async complete(messages, signal) {
    for (let attempt = 0; ; attempt++) {
      signal.throwIfAborted()
      let response: Response
      try {
        response = await fetch(endpoint, {
          method: 'POST', headers: { ...options.headers, 'Content-Type': 'application/json', Authorization: `Bearer ${options.apiKey}` },
          body: JSON.stringify({ model: options.model, messages, temperature: options.temperature, max_tokens: options.maxOutputTokens, stream: false }),
          signal: AbortSignal.any([signal, AbortSignal.timeout(options.timeoutMs)]),
        })
      } catch (error) {
        if (signal.aborted || attempt >= options.retries) throw error
        await delay(options.retryBaseMs * 2 ** attempt, undefined, { signal })
        continue
      }
      if (!response.ok) {
        await response.body?.cancel()
        if ((response.status === 429 || response.status >= 500) && attempt < options.retries) {
          const retryAfter = Number(response.headers.get('retry-after'))
          await delay(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : options.retryBaseMs * 2 ** attempt, undefined, { signal })
          continue
        }
        // Provider bodies may echo credentials or prompts; report status and request ID only.
        throw new Error(`API HTTP ${response.status}; request=${response.headers.get('x-request-id') ?? 'unavailable'}`)
      }
      const body = await response.json() as { choices?: { message?: { content?: unknown }; finish_reason?: string }[]; usage?: { prompt_tokens?: number; completion_tokens?: number } }
      const choice = body.choices?.[0]
      if (choice?.finish_reason === 'length') throw new Error('API completion reached its output-token limit')
      if (typeof choice?.message?.content !== 'string') throw new Error('API returned no text completion')
      return { text: choice.message.content, usage: { inputTokens: body.usage?.prompt_tokens ?? 0, outputTokens: body.usage?.completion_tokens ?? 0 } }
    }
  } }
}
