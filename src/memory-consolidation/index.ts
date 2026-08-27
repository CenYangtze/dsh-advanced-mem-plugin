/**
 * Consolidation: the maintenance half of long-term memory.
 *
 * Capture alone produces a growing pile of episodes. This plugin is what turns
 * that pile into knowledge and then keeps it honest over months: it mounts the
 * behavior-cycle distiller, promotes repeated behavior into layer-1 affinities
 * and procedures at turn boundaries, and periodically sweeps the graph so faded
 * inferences retire and overflowing raw material is evicted.
 *
 * Passes run on their own chain, off the turn's critical path. A pass that fails
 * is logged and the next one still runs, because a memory that stops maintaining
 * itself must not also stop the agent from working.
 *
 * @module dsh-advanced-mem-plugin/consolidation
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { sessionScope } from '../memory/index.ts'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import { BehaviorCycleDistiller } from './distiller.ts'
import type { DistillerPolicy } from './distiller.ts'

export { BehaviorCycleDistiller, actionOf, actionSequences, frequencyConfidence } from './distiller.ts'
export type { DistillerPolicy } from './distiller.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'memory-consolidation'

/** The hub to consolidate and the session store whose turn boundaries schedule passes. */
export const inject = ['memory', 'sessions']

/** Rank of the deterministic miner; low so it runs before any model-backed distiller. */
const BEHAVIOR_CYCLE_RANK = 100

/** Mining thresholds and pass scheduling. */
export interface Config extends DistillerPolicy {
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
    ['consolidateEveryTurns', config.consolidateEveryTurns],
    ['sweepEveryTurns', config.sweepEveryTurns],
  ]
  for (const [field, value] of positives) {
    if (!Number.isFinite(value) || value < 1) {
      throw new TypeError(`memory-consolidation: ${field} must be at least 1, got ${String(value)}`)
    }
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
 * Mount the behavior-cycle distiller and schedule maintenance passes.
 * @param ctx - registrant context carrying the hub and the session store.
 * @param config - mining thresholds and pass scheduling.
 * @throws when a threshold is unusable; misconfiguration fails at load, not at the first pass.
 */
export function apply(ctx: Context, config: Config): void {
  validate(config)
  ctx.effect(() => ctx.memory.registerDistiller(new BehaviorCycleDistiller(BEHAVIOR_CYCLE_RANK, config)))

  // Turn counts are per session and process-local: they schedule work, they are
  // not state anything reads back, so losing them on restart costs one delayed
  // pass and nothing else.
  const turns = new Map<string, number>()
  let chain: Promise<void> = Promise.resolve()
  const enqueue = (label: string, work: () => Promise<unknown>): void => {
    chain = chain.then(async () => {
      await work()
    }).catch((error: unknown) => {
      ctx.logger.warn(`memory-consolidation: ${label} pass failed: ${String(error)}`)
    })
  }

  ctx.on('session/event', (session: Session, event: SessionEvent) => {
    if (event.type !== 'turn/end' || !ctx.memory.ready) return
    const completed = (turns.get(session.id) ?? 0) + 1
    turns.set(session.id, completed)
    const scope = sessionScope(session)
    if (completed % config.consolidateEveryTurns === 0) {
      enqueue('consolidation', () => ctx.memory.consolidate(scope))
    }
    if (completed % config.sweepEveryTurns === 0) {
      enqueue('sweep', () => ctx.memory.sweep([scope]))
    }
  })

  ctx.effect(() => () => {
    turns.clear()
  })
}
