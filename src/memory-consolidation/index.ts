/**
 * Consolidation: the maintenance half of long-term memory.
 *
 * Capture alone produces a growing pile of episodes. This plugin is what turns
 * that pile into knowledge and then keeps it honest over months: it mounts the
 * behavior-cycle and stated-preference distillers, promotes what the user
 * repeated and what they asked for into layer-1 beliefs at turn boundaries, and
 * periodically sweeps the graph so faded inferences retire and overflowing raw
 * material is evicted.
 *
 * Both distillers obey one rule: only material the user authored may be the
 * subject of a belief. The agent's own tool calls are kept and indexed, but a
 * memory that concluded things about the person from them would be describing
 * the harness back to itself.
 *
 * Passes run on their own chain, off the turn's critical path. A pass that fails
 * is logged and the next one still runs, because a memory that stops maintaining
 * itself must not also stop the agent from working.
 *
 * @module dsh-advanced-mem-plugin/consolidation
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import z from '@deepseek-ai/schemastery'
import { sessionScope } from '../memory/index.ts'
import type { MemoryModelRoute } from '../memory/index.ts'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import { BehaviorCycleDistiller } from './distiller.ts'
import { StatedPreferenceDistiller } from './stated.ts'
import type { StatedPolicy } from './stated.ts'
import { SemanticPreferenceDistiller } from './semantic.ts'
import type { SemanticPolicy } from './semantic.ts'
import { createHarnessSemanticModel, memoryModelRoute, resolveSemanticRoute } from './model.ts'

export { BehaviorCycleDistiller, actionOf, actionSequences, frequencyConfidence } from './distiller.ts'
export type { DistillerPolicy } from './distiller.ts'
export { StatedPreferenceDistiller, claimsIn, statable } from './stated.ts'
export type { StatedClaim, StatedPolicy } from './stated.ts'
export { SemanticPreferenceDistiller } from './semantic.ts'
export type { SemanticPolicy } from './semantic.ts'
export { createHarnessSemanticModel, memoryModelRoute, resolveSemanticRoute } from './model.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'memory-consolidation'

/** The hub to consolidate and the session store whose turn boundaries schedule passes. */
export const inject = ['memory', 'sessions']

/** Rank of the deterministic miner; low so it runs before any model-backed distiller. */
const BEHAVIOR_CYCLE_RANK = 100

/** Rank of the stated-preference miner; after frequency mining, which is cheaper. */
const STATED_PREFERENCE_RANK = 110

/** Rank of the model-backed semantic extractor; last and optional. */
const SEMANTIC_PREFERENCE_RANK = 120

/** Mining thresholds and pass scheduling. */
export interface Config extends StatedPolicy, SemanticPolicy {
  /**
   * Turns between consolidation passes. Consolidation reads only unpromoted
   * records, so a larger interval costs recall freshness rather than work.
   */
  consolidateEveryTurns: number
  /**
   * Turns between maintenance sweeps. Sweeping is the expensive pass — it walks
   * every item in the scope — so it runs less often than consolidation.
   */
  sweepEveryTurns: number
}

/** Schemastery validation for {@link Config}. */
export const Config: z<Config> = z.object({
  minObservations: z.number().required(),
  observationSaturation: z.number().required(),
  maxConfidence: z.number().required(),
  minSequenceLength: z.number().required(),
  maxSequenceLength: z.number().required(),
  minSequenceRepeats: z.number().required(),
  minStatements: z.number().required(),
  minSubjectLength: z.number().required(),
  maxSubjectLength: z.number().required(),
  behaviorLookbackRecords: z.number().required(),
  progressMaxAttempts: z.number().required(),
  semanticEnabled: z.boolean().required(),
  semanticMaxRecords: z.number().required(),
  semanticMaxInputCharacters: z.number().required(),
  semanticMaxOutputBytes: z.number().required(),
  semanticMaxCandidates: z.number().required(),
  semanticMaxExistingNodes: z.number().required(),
  semanticMaxTokens: z.number().required(),
  semanticTemperature: z.number().required(),
  semanticTimeoutMs: z.number().required(),
  semanticMaxFieldLength: z.number().required(),
  semanticMaxCallsPerPass: z.number().required(),
  semanticMaxConcurrentCalls: z.number().required(),
  semanticPromptVersion: z.string().required(),
  consolidateEveryTurns: z.number().required(),
  sweepEveryTurns: z.number().required(),
})

/**
 * Reject a configuration whose thresholds cannot produce anything.
 * @param config - the validated plugin configuration.
 * @throws when a threshold is not a positive integer or the sequence window is inverted.
 */
function validate(config: Config): void {
  const positives: [string, number][] = [
    ['minObservations', config.minObservations],
    ['observationSaturation', config.observationSaturation],
    ['minSequenceLength', config.minSequenceLength],
    ['maxSequenceLength', config.maxSequenceLength],
    ['minSequenceRepeats', config.minSequenceRepeats],
    ['minStatements', config.minStatements],
    ['minSubjectLength', config.minSubjectLength],
    ['maxSubjectLength', config.maxSubjectLength],
    ['progressMaxAttempts', config.progressMaxAttempts],
    ['semanticMaxRecords', config.semanticMaxRecords],
    ['semanticMaxInputCharacters', config.semanticMaxInputCharacters],
    ['semanticMaxOutputBytes', config.semanticMaxOutputBytes],
    ['semanticMaxCandidates', config.semanticMaxCandidates],
    ['semanticMaxExistingNodes', config.semanticMaxExistingNodes],
    ['semanticMaxTokens', config.semanticMaxTokens],
    ['semanticTimeoutMs', config.semanticTimeoutMs],
    ['semanticMaxFieldLength', config.semanticMaxFieldLength],
    ['semanticMaxCallsPerPass', config.semanticMaxCallsPerPass],
    ['semanticMaxConcurrentCalls', config.semanticMaxConcurrentCalls],
    ['consolidateEveryTurns', config.consolidateEveryTurns],
    ['sweepEveryTurns', config.sweepEveryTurns],
  ]
  for (const [field, value] of positives) {
    if (!Number.isFinite(value) || value < 1) {
      throw new TypeError(`memory-consolidation: ${field} must be at least 1, got ${String(value)}`)
    }
  }
  if (!Number.isFinite(config.semanticTemperature) || config.semanticTemperature < 0 || config.semanticTemperature > 1) {
    throw new TypeError(
      `memory-consolidation: semanticTemperature must be between 0 and 1, got ${String(config.semanticTemperature)}`,
    )
  }
  if (config.semanticPromptVersion.trim().length === 0) {
    throw new TypeError('memory-consolidation: semanticPromptVersion must be non-empty')
  }
  if (!Number.isSafeInteger(config.behaviorLookbackRecords) || config.behaviorLookbackRecords < 0) {
    throw new TypeError(
      `memory-consolidation: behaviorLookbackRecords must be a non-negative safe integer, got ${String(config.behaviorLookbackRecords)}`,
    )
  }
  if (config.minSubjectLength > config.maxSubjectLength) {
    throw new TypeError(
      `memory-consolidation: minSubjectLength (${config.minSubjectLength}) exceeds maxSubjectLength (${config.maxSubjectLength})`,
    )
  }
  if (config.minSequenceLength > config.maxSequenceLength) {
    throw new TypeError(
      `memory-consolidation: minSequenceLength (${config.minSequenceLength}) exceeds maxSequenceLength (${config.maxSequenceLength})`,
    )
  }
  if (!(config.maxConfidence > 0) || config.maxConfidence >= 1) {
    throw new TypeError(
      `memory-consolidation: maxConfidence must be above 0 and below 1, got ${String(config.maxConfidence)}`,
    )
  }
}

/**
 * Mount both distillers and schedule maintenance passes.
 * @param ctx - registrant context carrying the hub and the session store.
 * @param config - mining thresholds and pass scheduling.
 * @throws when a threshold is unusable; misconfiguration fails at load, not at the first pass.
 */
export function apply(ctx: Context, config: Config): void {
  validate(config)
  ctx.effect(() => ctx.memory.registerDistiller(new BehaviorCycleDistiller(BEHAVIOR_CYCLE_RANK, config)))
  ctx.effect(() => ctx.memory.registerDistiller(new StatedPreferenceDistiller(STATED_PREFERENCE_RANK, config)))
  let semanticReady = false
  if (config.semanticEnabled) {
    const missing = ['llm', 'agents'].filter(name => ctx.get(name) === undefined)
    if (missing.length > 0) {
      ctx.logger.error(
        `memory-consolidation: semantic extraction enabled but optional services are not ready: ${missing.join(', ')}`,
      )
    }
    ctx.inject(['llm', 'agents'], child => {
      semanticReady = true
      child.effect(() => child.memory.registerDistiller(new SemanticPreferenceDistiller(
        SEMANTIC_PREFERENCE_RANK,
        config,
        route => createHarnessSemanticModel(child, route, {
          temperature: config.semanticTemperature,
          maxTokens: config.semanticMaxTokens,
          timeoutMs: config.semanticTimeoutMs,
          maxResponseBytes: config.semanticMaxOutputBytes,
          maxInputCharacters: config.semanticMaxInputCharacters,
          promptVersion: config.semanticPromptVersion,
        }),
        text => ctx.memory.filterExternalText(text),
        value => ctx.memory.filterExternalJson(value),
      )))
    })
  }

  // Turn counts are per session and process-local: they schedule work, they are
  // not state anything reads back, so losing them on restart costs one delayed
  // pass and nothing else.
  const turns = new Map<string, number>()
  let chain: Promise<void> = Promise.resolve()
  let disposed = false
  const shutdown = new AbortController()
  const enqueue = (label: string, work: (signal: AbortSignal) => Promise<unknown>): void => {
    chain = chain.then(async () => {
      if (disposed) return
      await work(shutdown.signal)
    }).catch(() => {
      if (disposed || shutdown.signal.aborted) return
      ctx.logger.warn(`memory-consolidation: ${label} pass failed`)
    })
  }

  const report = (diagnostic: {
    distiller: string
    pending: number
    advanced: number
    failed: number
    skipped: number
    usage?: { inputTokens: number; outputTokens: number }
  }): void => {
    if (diagnostic.failed > 0) {
      ctx.logger.warn(`memory-consolidation: ${diagnostic.distiller} failed ${diagnostic.failed} record(s)`)
    }
    if (diagnostic.skipped > 0) {
      ctx.logger.info(`memory-consolidation: ${diagnostic.distiller} skipped ${diagnostic.skipped} record(s)`)
    }
    if (diagnostic.usage !== undefined) {
      ctx.logger.info(
        `memory-consolidation: ${diagnostic.distiller} tokens input=${diagnostic.usage.inputTokens} output=${diagnostic.usage.outputTokens}`,
      )
    }
  }

  ctx.on('session/event', (session: Session, event: SessionEvent) => {
    if (event.type !== 'turn/end' || !ctx.memory.ready || disposed) return
    const completed = (turns.get(session.id) ?? 0) + 1
    turns.set(session.id, completed)
    const scope = sessionScope(session)
    if (completed % config.consolidateEveryTurns === 0) {
      let route: MemoryModelRoute | undefined
      if (config.semanticEnabled && semanticReady) {
        try {
          const agents = ctx.get('agents') as { get(id: string): Agent | undefined } | undefined
          const agent = agents?.get(session.id)
          route = memoryModelRoute(resolveSemanticRoute(ctx, agent, session).route)
        } catch {
          ctx.logger.warn('memory-consolidation: semantic route unavailable')
        }
      }
      enqueue('consolidation', signal => ctx.memory.consolidate(scope, {
        signal,
        sessionId: session.id,
        ...(route === undefined ? {} : { route }),
        onDiagnostic: report,
      }))
    }
    if (completed % config.sweepEveryTurns === 0) {
      enqueue('sweep', () => ctx.memory.sweep([scope]))
    }
  })

  ctx.effect(() => () => {
    disposed = true
    shutdown.abort()
    turns.clear()
  })
}
