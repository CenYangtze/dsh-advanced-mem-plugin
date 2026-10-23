import type { Context } from '@deepseek-ai/cordis'
import type { Agent, ModelSelection } from '@deepseek-ai/dsh-agent'
import type { Session } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-projection'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import { EXPERIENCE_EXTRACTION_PROMPT, parseExperienceDistillation } from '../experience/provider.ts'
import type { ExperienceJsonModel } from '../experience/provider.ts'
import { serializeExperienceDistillation } from '../experience/payload.ts'
import type { ExperienceDistiller } from '../experience/types.ts'

export interface HarnessExtractionConfig {
  readonly temperature: number
  readonly maxTokens: number
  readonly timeoutMs: number
  readonly maxResponseBytes: number
  readonly maxInputCharacters: number
  readonly maxCandidates: number
  readonly promptVersion: string
}

function selection(value: unknown): ModelSelection | undefined {
  if (value === null || value === undefined) return undefined
  if (typeof value !== 'object' || !('provider' in value) || !('model' in value)
    || typeof value.provider !== 'string' || !value.provider.trim()
    || typeof value.model !== 'string' || !value.model.trim()) throw new Error('Harness returned an invalid experience model selection')
  const effort = 'reasoningEffort' in value ? value.reasoningEffort : undefined
  if (effort !== undefined && (typeof effort !== 'string' || !effort.trim())) throw new Error('Harness returned an invalid reasoning effort')
  return { provider: value.provider, model: value.model,
    ...(effort === undefined ? {} : { reasoningEffort: ReasoningEffortId(effort) }) }
}

/** Read the same next-model projection shown in the GUI, without changing selection. */
export function resolveExperienceModel(ctx: Context, agent?: Agent, session?: Session): { readonly route: ModelSelection; readonly source: 'session' | 'agent' | 'default' } {
  const activeSession = agent?.session ?? session
  if (activeSession) {
    const projections = ctx.get('sessionProjections')
    // The GUI owns this optional projection; its public wire key is read without importing its controller.
    const values = projections?.snapshot(activeSession).values as Readonly<Record<string, unknown>> | undefined
    const projection = values?.modelSelection
    if (projection !== null && typeof projection === 'object' && 'next' in projection) {
      const next = selection(projection.next)
      if (next) return { route: next, source: 'session' }
    }
    const header = activeSession.requestHeader()
    if (header) {
      const { reasoningEffort, ...route } = header.config
      return { route: selection({ ...route,
        ...(header.adapterDefaults?.reasoningEffort === true || reasoningEffort === undefined ? {} : { reasoningEffort }),
      })!, source: 'session' }
    }
  }
  if (agent?.options.provider && agent.options.model) return { route: selection(agent.options)!, source: 'agent' }
  const defaultModel = ctx.get('agentDefaultModel')
  if (defaultModel) return { route: selection(defaultModel.currentSelection())!, source: 'default' }
  throw new Error('Experience extraction cannot resolve a Harness model. Select a session model or configure the Harness default model.')
}

/** One auxiliary request through the host adapter; credentials remain owned by Harness. */
export function createHarnessExperienceModel(ctx: Context, route: ModelSelection, config: HarnessExtractionConfig): ExperienceJsonModel {
  for (const key of ['maxTokens', 'timeoutMs', 'maxResponseBytes', 'maxInputCharacters', 'maxCandidates'] as const) {
    if (!Number.isSafeInteger(config[key]) || config[key] <= 0) throw new Error(`${key} must be a positive integer`)
  }
  if (!Number.isFinite(config.temperature) || config.temperature < 0 || !config.promptVersion.trim()) throw new Error('Invalid Harness extraction controls')
  const selected = selection(route)!
  return {
    name: `harness:${selected.provider}:${selected.model}:${selected.reasoningEffort ?? 'default'}:${config.promptVersion}`,
    async complete(system, text, requestSignal) {
      requestSignal?.throwIfAborted()
      if (text.length > config.maxInputCharacters) throw new Error('Experience extraction exceeds maxInputCharacters')
      const stop = new AbortController()
      const signal = AbortSignal.any([stop.signal, AbortSignal.timeout(config.timeoutMs), ...(requestSignal ? [requestSignal] : [])])
      const blocks = new Map<number, string>()
      const reasoningBytes = new Map<number, number>()
      let bytes = 0
      let finished = false
      const checkSize = (): void => { if (bytes > config.maxResponseBytes) throw new Error('Harness experience extraction exceeds maxResponseBytes') }
      try {
        for await (const chunk of ctx.llm.stream({
          ...selected, temperature: config.temperature, maxTokens: config.maxTokens,
          system, messages: [{ role: 'user', content: [{ type: 'text', text }] }],
          tools: [], signal,
        })) {
          signal.throwIfAborted()
          if (finished) throw new Error('Harness experience extraction received content after its finish')
          switch (chunk.type) {
            case 'text-delta': {
              const previous = blocks.get(chunk.index) ?? ''
              blocks.set(chunk.index, previous + chunk.text)
              bytes += Buffer.byteLength(chunk.text)
              checkSize()
              break
            }
            case 'reasoning-delta': {
              const size = Buffer.byteLength(chunk.text)
              reasoningBytes.set(chunk.index, (reasoningBytes.get(chunk.index) ?? 0) + size)
              bytes += size
              checkSize()
              break
            }
            case 'tool-call-delta': throw new Error('Experience extraction requested an unprovided tool')
            case 'block-start':
              if (chunk.blockType === 'tool-call') throw new Error('Experience extraction requested an unprovided tool')
              break
            case 'block-end':
              if (chunk.block.type === 'text') {
                bytes += Buffer.byteLength(chunk.block.text) - Buffer.byteLength(blocks.get(chunk.index) ?? '')
                blocks.set(chunk.index, chunk.block.text)
              } else if (chunk.block.type === 'reasoning') {
                bytes += Buffer.byteLength(chunk.block.text) - (reasoningBytes.get(chunk.index) ?? 0)
                reasoningBytes.set(chunk.index, Buffer.byteLength(chunk.block.text))
              } else if (chunk.block.type === 'tool-call') throw new Error('Experience extraction requested an unprovided tool')
              checkSize()
              break
            case 'finish':
              if (chunk.reason.kind === 'error' || chunk.reason.kind === 'aborted') {
                throw new Error(`Harness experience extraction failed: ${chunk.reason.failure.code}`)
              }
              if (chunk.reason.kind !== 'stop') throw new Error(`Harness experience extraction did not complete: ${chunk.reason.kind}`)
              finished = true
              break
          }
        }
        signal.throwIfAborted()
        if (!finished) throw new Error('Harness experience extraction ended without a finish event')
        return [...blocks].sort(([a], [b]) => a - b).map(([, value]) => value).join('')
      } finally { stop.abort() }
    },
  }
}

/** Extraction and outcome review share host authentication and stream controls. */
export function createHarnessExperienceDistiller(ctx: Context, route: ModelSelection, config: HarnessExtractionConfig): ExperienceDistiller {
  const model = createHarnessExperienceModel(ctx, route, config)
  return {
    name: model.name,
    async distill(input) {
      return parseExperienceDistillation(await model.complete(EXPERIENCE_EXTRACTION_PROMPT,
        serializeExperienceDistillation(input), input.signal), input, config.maxCandidates)
    },
  }
}
