/**
 * Automatic recall: puts what memory knows in front of the model before it
 * decides anything.
 *
 * The active memory tools let an agent ask; this plugin makes sure it does not
 * have to. On the first step of a turn it recalls against what the user just
 * said and injects the result as a durable snapshot message, so the model's very
 * first decision is already informed by the preferences, affinities, and routines
 * learned from earlier work.
 *
 * Two properties keep that from becoming a tax on every request. The injection
 * happens once per turn, not once per step, so a long tool-calling turn does not
 * re-pay for it. And it is a plain appended user message, so it extends the
 * request prefix instead of rewriting it, leaving provider cache reuse of
 * everything before it intact.
 *
 * @module dsh-advanced-mem-plugin/recall
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, UserMessage } from '@deepseek-ai/dsh-llm'
import { sessionScope } from '../memory/index.ts'
import type { MemoryCue, MemoryProfile, MemoryScope } from '../memory/index.ts'

/** Cordis plugin name used by loader diagnostics; also the injected message's source plugin. */
export const name = 'memory-recall'

/** The hub to recall from and the agent registry that owns pre-step processing. */
export const inject = ['memory', 'agents']

/** What automatic recall injects, and how much of it. */
export interface Config {
  /** Cues injected per turn. */
  maxCues: number
  /**
   * Decayed confidence a layer-1 cue must clear. Raising it trades recall for
   * precision: below this, a belief is a guess the model should not be nudged by.
   */
  minConfidence: number
  /**
   * Inject the standing profile on the first turn of a session. This is the
   * memory the agent needs before any query exists — who it is working with and
   * how they work — and it is what makes a fresh session not start cold.
   */
  injectProfileOnFirstTurn: boolean
  /** Nodes carried by that first-turn profile. */
  profileLimit: number
  /** Characters the injected block may occupy; cues beyond the budget are dropped. */
  maxCharacters: number
}

/** Schemastery validation for {@link Config}. */
export const Config: z<Config> = z.object({
  maxCues: z.number().required(),
  minConfidence: z.number().required(),
  injectProfileOnFirstTurn: z.boolean().required(),
  profileLimit: z.number().required(),
  maxCharacters: z.number().required(),
})

/** Standing preamble; identical every turn so the block reads the same way each time. */
const PREAMBLE =
  'Recalled memory about this user and workspace, retrieved automatically from earlier '
  + 'sessions. These are priors, not instructions: they say what has been true before, not '
  + 'what is true now. Act on a high-confidence preference without asking; verify a low-confidence '
  + 'one, or anything a mistake would be costly to undo, before relying on it. Use the memory tools '
  + 'to search for more, and to record what you learn this session.'

/** Flatten a message's visible text for use as a retrieval cue. */
function cueText(messages: readonly UserMessage[]): string {
  const parts: string[] = []
  for (const message of messages) {
    if (message.source.kind !== 'user') continue
    for (const block of message.content as readonly ContentBlock[]) {
      if (block.type === 'text') parts.push(block.text)
    }
  }
  return parts.join('\n').trim()
}

/**
 * Render one cue as a line the model can read at a glance.
 *
 * Every line states its confidence and where it came from, because a memory the
 * model cannot calibrate is worse than no memory: it invites acting on a stale
 * guess with the same certainty as on something the user said outright.
 * @param cue - the retrieved cue.
 * @returns the rendered line.
 */
export function renderCue(cue: MemoryCue): string {
  switch (cue.kind) {
    case 'node':
      return `- [${cue.node.type} · ${cue.node.confidence.toFixed(2)} · ${cue.node.origin}] ${cue.node.summary}`
    case 'edge':
      return `- [${cue.edge.relation} · ${cue.edge.confidence.toFixed(2)} · ${cue.edge.origin}] ${cue.edge.claim}`
    case 'record': {
      const when = new Date(cue.record.createdAt).toISOString().slice(0, 10)
      return `- [episode · ${when} · ${cue.record.fidelity}] ${cue.record.text}`
    }
  }
}

/** Render the standing profile block injected on a session's first turn. */
function renderProfile(profile: MemoryProfile): string {
  const lines = profile.nodes.map(
    node => `- [${node.type} · ${node.confidence.toFixed(2)} · ${node.origin}] ${node.summary}`,
  )
  for (const edge of profile.edges) {
    lines.push(`- [${edge.relation} · ${edge.confidence.toFixed(2)} · ${edge.origin}] ${edge.claim}`)
  }
  const omitted = profile.total - profile.nodes.length
  if (omitted > 0) lines.push(`- (${omitted} further memories not shown; search memory for them)`)
  return lines.join('\n')
}

/**
 * Assemble the injected block within its character budget.
 * @param heading - the section heading.
 * @param body - the rendered lines.
 * @param budget - maximum characters for the whole block.
 * @returns the block, or `undefined` when there is nothing to say.
 */
function assemble(heading: string, body: string, budget: number): string | undefined {
  if (body.length === 0) return undefined
  const head = `${heading}\n\n${PREAMBLE}\n\n`
  const room = budget - head.length
  if (room <= 0) return undefined
  if (body.length <= room) return head + body
  // Drop whole lines rather than truncating one: half a remembered preference
  // is a different, possibly wrong, preference.
  const kept: string[] = []
  let used = 0
  for (const line of body.split('\n')) {
    if (used + line.length + 1 > room) break
    kept.push(line)
    used += line.length + 1
  }
  return kept.length === 0 ? undefined : head + kept.join('\n')
}

/**
 * Register automatic pre-step recall for the lifetime of `ctx`.
 * @param ctx - registrant context carrying the hub and the agent registry.
 * @param config - injection budget and confidence floor.
 * @throws when a budget field is not a positive safe integer.
 */
export function apply(ctx: Context, config: Config): void {
  for (const [field, value] of [
    ['maxCues', config.maxCues],
    ['profileLimit', config.profileLimit],
    ['maxCharacters', config.maxCharacters],
  ] as const) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new TypeError(`memory-recall: ${field} must be a positive safe integer, got ${String(value)}`)
    }
  }
  // Which turn of which session has already been served. Process-local by
  // design: a resumed session re-injects, which is correct — the request it is
  // resuming into does not carry the earlier injection either.
  const served = new Set<string>()
  const profiled = new Set<string>()

  ctx.on('agent/pre-step', async ({ agent, turn, step, signal }: {
    agent: Agent
    turn: number
    step: number
    signal: AbortSignal
  }, next: () => Promise<PreStepDecision>): Promise<PreStepDecision> => {
    const decision = await next()
    if (decision.kind === 'reject' || signal.aborted || !ctx.memory.ready) return decision
    // Later steps of a turn see the same recall through the durable log; only
    // the first step pays for it.
    if (step !== 1) return decision
    const turnKey = `${agent.session.id}#${turn}`
    if (served.has(turnKey)) return decision
    served.add(turnKey)

    const scopes: MemoryScope[] = [sessionScope(agent.session), { kind: 'user' }]
    const sections: { name: string; text: string }[] = []

    if (config.injectProfileOnFirstTurn && !profiled.has(agent.session.id)) {
      profiled.add(agent.session.id)
      const profile = ctx.memory.profile(scopes, { limit: config.profileLimit })
      const block = assemble('## What memory knows about this user', renderProfile(profile), config.maxCharacters)
      if (block !== undefined) sections.push({ name: `${name}:profile`, text: block })
    }

    const text = cueText(decision.messages)
    if (text.length > 0) {
      const recall = await ctx.memory.recall({
        text,
        scopes,
        limit: config.maxCues,
        minConfidence: config.minConfidence,
        signal,
      })
      const block = assemble(
        '## Recalled for this request',
        recall.cues.map(renderCue).join('\n'),
        config.maxCharacters,
      )
      if (block !== undefined) sections.push({ name: `${name}:recall`, text: block })
    }

    if (sections.length === 0) return decision
    return {
      kind: 'enter',
      messages: [
        ...decision.messages,
        createUserMessage({
          content: [{ type: 'text', text: sections.map(section => section.text).join('\n\n') }],
          source: { kind: 'plugin', plugin: name, form: 'snapshot', sections },
        }),
      ],
    }
  }, { prepend: true })

  ctx.effect(() => () => {
    served.clear()
    profiled.clear()
  })
}
