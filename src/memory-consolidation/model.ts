/**
 * Host-model plumbing for semantic preference extraction.
 *
 * The factual memory channel must not import the experience runtime. This file
 * keeps the small shared contract it needs: resolve the current session's model
 * projection, then stream one tool-free auxiliary request through the host LLM
 * service. Credentials and provider selection stay with Harness.
 *
 * @module dsh-advanced-mem-plugin/src/memory-consolidation/model
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent, ModelSelection } from '@deepseek-ai/dsh-agent'
import type { Session } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-projection'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { TokenUsage } from '@deepseek-ai/dsh-llm'
import type { MemoryModelRoute } from '../memory/index.ts'

/** Fixed failure categories a model request can report. */
export type SemanticRequestFailure =
  | 'timeout'
  | 'aborted'
  | 'output-limit'
  | 'truncated'
  | 'tool-call'
  | 'provider-failed'

/** A classified model-request failure carrying no provider text. */
export class SemanticRequestError extends Error {
  /** Fixed category. */
  readonly code: SemanticRequestFailure

  /**
   * @param code - the failure category.
   */
  constructor(code: SemanticRequestFailure) {
    super(`semantic preference request failed: ${code}`)
    this.name = 'SemanticRequestError'
    this.code = code
  }
}

/** Controls that bound one semantic model request. */
export interface SemanticModelControls {
  readonly temperature: number
  readonly maxTokens: number
  readonly timeoutMs: number
  readonly maxResponseBytes: number
  readonly maxInputCharacters: number
  readonly promptVersion: string
}

/** One completed model response and optional host-reported usage. */
export interface SemanticModelResult {
  readonly text: string
  readonly usage?: TokenUsage
}

/** One model bound to a route, ready to answer one prompt. */
export interface SemanticModel {
  readonly name: string
  complete(system: string, text: string, signal?: AbortSignal): Promise<SemanticModelResult>
}

/** A resolved session/agent/default route. */
export interface ResolvedSemanticRoute {
  readonly route: ModelSelection
  readonly source: 'session' | 'agent' | 'default'
}

function selection(value: unknown): ModelSelection | undefined {
  if (value === null || value === undefined) return undefined
  if (typeof value !== 'object' || !('provider' in value) || !('model' in value)
    || typeof value.provider !== 'string' || !value.provider.trim()
    || typeof value.model !== 'string' || !value.model.trim()) {
    throw new Error('Harness returned an invalid semantic model selection')
  }
  const effort = 'reasoningEffort' in value ? value.reasoningEffort : undefined
  if (effort !== undefined && (typeof effort !== 'string' || !effort.trim())) {
    throw new Error('Harness returned an invalid semantic reasoning effort')
  }
  return {
    provider: value.provider,
    model: value.model,
    ...(effort === undefined ? {} : { reasoningEffort: ReasoningEffortId(effort) }),
  }
}

/**
 * Resolve the same next-model projection the GUI shows for the owning session.
 *
 * The route belongs to the session that produced the turn, never to an
 * arbitrary workspace default. A missing route is a clear error rather than a
 * silent fallback to a different model.
 * @param ctx - host context with optional projections/default-model services.
 * @param agent - agent owning the session when available.
 * @param session - session whose request header supplies the route.
 * @returns the selected route and where it came from.
 * @throws when no session, agent or host default route exists.
 */
export function resolveSemanticRoute(ctx: Context, agent?: Agent, session?: Session): ResolvedSemanticRoute {
  const activeSession = agent?.session ?? session
  if (activeSession) {
    const projections = ctx.get('sessionProjections')
    const values = projections?.snapshot(activeSession).values as Readonly<Record<string, unknown>> | undefined
    const projection = values?.modelSelection
    if (projection !== null && typeof projection === 'object' && 'next' in projection) {
      const next = selection(projection.next)
      if (next) return { route: next, source: 'session' }
    }
    const header = activeSession.requestHeader()
    if (header) {
      const { reasoningEffort, ...route } = header.config
      return {
        route: selection({
          ...route,
          ...(header.adapterDefaults?.reasoningEffort === true || reasoningEffort === undefined ? {} : { reasoningEffort }),
        })!,
        source: 'session',
      }
    }
  }
  if (agent?.options.provider && agent.options.model) {
    return { route: selection(agent.options)!, source: 'agent' }
  }
  const defaultModel = ctx.get('agentDefaultModel')
  if (defaultModel) return { route: selection(defaultModel.currentSelection())!, source: 'default' }
  throw new Error(
    'Semantic preference extraction cannot resolve a Harness model. Select a session model or configure the Harness default model.',
  )
}

/**
 * Convert a host selection to the memory-facing route type.
 * @param route - host provider/model selection.
 * @returns a route safe to persist only in diagnostics, never credentials.
 */
export function memoryModelRoute(route: ModelSelection): MemoryModelRoute {
  return {
    provider: route.provider,
    model: route.model,
    ...(route.reasoningEffort === undefined ? {} : { reasoningEffort: route.reasoningEffort }),
  }
}

/**
 * Create one tool-free host stream bound to a route.
 * @param ctx - host context carrying `llm`.
 * @param route - provider/model/reasoning effort selected for the session.
 * @param controls - explicit byte, token and timeout budgets.
 * @returns a model usable by the semantic distiller.
 * @throws when a control is not a positive finite value.
 */
export function createHarnessSemanticModel(
  ctx: Context,
  route: MemoryModelRoute,
  controls: SemanticModelControls,
): SemanticModel {
  for (const key of ['maxTokens', 'timeoutMs', 'maxResponseBytes', 'maxInputCharacters'] as const) {
    if (!Number.isSafeInteger(controls[key]) || controls[key] <= 0) {
      throw new Error(`semantic preference ${key} must be a positive integer`)
    }
  }
  if (!Number.isFinite(controls.temperature) || controls.temperature < 0 || controls.temperature > 1) {
    throw new Error('semantic preference temperature must be between 0 and 1')
  }
  if (!controls.promptVersion.trim()) throw new Error('semantic preference promptVersion must be non-empty')
  const effort = route.reasoningEffort === undefined ? undefined : ReasoningEffortId(route.reasoningEffort)
  return {
    name: `harness:${route.provider}:${route.model}:${route.reasoningEffort ?? 'default'}:${controls.promptVersion}`,
    async complete(system, text, requestSignal) {
      requestSignal?.throwIfAborted()
      if (text.length > controls.maxInputCharacters) {
        throw new SemanticRequestError('provider-failed')
      }
      const stop = new AbortController()
      const signal = AbortSignal.any([
        stop.signal,
        AbortSignal.timeout(controls.timeoutMs),
        ...(requestSignal === undefined ? [] : [requestSignal]),
      ])
      const blocks = new Map<number, string>()
      const reasoningBytes = new Map<number, number>()
      let bytes = 0
      let finished = false
      let usage: TokenUsage | undefined
      const checkSize = (): void => {
        if (bytes > controls.maxResponseBytes) throw new SemanticRequestError('output-limit')
      }
      try {
        for await (const chunk of ctx.llm.stream({
          provider: route.provider,
          model: route.model,
          ...(effort === undefined ? {} : { reasoningEffort: effort }),
          temperature: controls.temperature,
          maxTokens: controls.maxTokens,
          system,
          messages: [{ role: 'user', content: [{ type: 'text', text }] }],
          tools: [],
          signal,
        })) {
          signal.throwIfAborted()
          if (finished) throw new SemanticRequestError('provider-failed')
          switch (chunk.type) {
            case 'text-delta': {
              blocks.set(chunk.index, (blocks.get(chunk.index) ?? '') + chunk.text)
              bytes += Buffer.byteLength(chunk.text, 'utf8')
              checkSize()
              break
            }
            case 'reasoning-delta': {
              const size = Buffer.byteLength(chunk.text, 'utf8')
              reasoningBytes.set(chunk.index, (reasoningBytes.get(chunk.index) ?? 0) + size)
              bytes += size
              checkSize()
              break
            }
            case 'tool-call-delta':
              throw new SemanticRequestError('tool-call')
            case 'block-start':
              if (chunk.blockType === 'tool-call') throw new SemanticRequestError('tool-call')
              break
            case 'block-end':
              if (chunk.block.type === 'text') {
                bytes += Buffer.byteLength(chunk.block.text, 'utf8') - Buffer.byteLength(blocks.get(chunk.index) ?? '', 'utf8')
                blocks.set(chunk.index, chunk.block.text)
              } else if (chunk.block.type === 'reasoning') {
                const previous = reasoningBytes.get(chunk.index) ?? 0
                bytes += Buffer.byteLength(chunk.block.text, 'utf8') - previous
                reasoningBytes.set(chunk.index, Buffer.byteLength(chunk.block.text, 'utf8'))
              } else if (chunk.block.type === 'tool-call') {
                throw new SemanticRequestError('tool-call')
              }
              checkSize()
              break
            case 'usage':
              usage = chunk.usage
              break
            case 'finish':
              if (chunk.reason.kind === 'aborted') throw new SemanticRequestError('aborted')
              if (chunk.reason.kind === 'error') throw new SemanticRequestError('provider-failed')
              if (chunk.reason.kind === 'max-tokens') throw new SemanticRequestError('truncated')
              if (chunk.reason.kind === 'tool-calls') throw new SemanticRequestError('tool-call')
              if (chunk.reason.kind !== 'stop') throw new SemanticRequestError('provider-failed')
              finished = true
              break
          }
        }
        signal.throwIfAborted()
        if (!finished) throw new SemanticRequestError('truncated')
        return {
          text: [...blocks].sort(([left], [right]) => left - right).map(([, value]) => value).join(''),
          ...(usage === undefined ? {} : { usage }),
        }
      } catch (error) {
        if (error instanceof SemanticRequestError) throw error
        if (signal.aborted) {
          throw new SemanticRequestError(requestSignal?.aborted === true ? 'aborted' : 'timeout')
        }
        throw new SemanticRequestError('provider-failed')
      } finally {
        stop.abort()
      }
    },
  }
}
