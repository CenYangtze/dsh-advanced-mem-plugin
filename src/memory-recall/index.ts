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

/** Line separator; a named constant so the escape survives every edit of this file. */
const SPLIT = '\n'

/** Blank-line separator between a heading and its body. */
const GAP = '\n\n'

/** Heading of the whole injected block; the two sections are subheadings under it. */
const HEADING = '## Memory'

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
 * Fit rendered lines into a character budget.
 *
 * Whole lines are dropped rather than one truncated: half a remembered
 * preference is a different, possibly wrong, preference.
 * @param body - the rendered lines.
 * @param room - characters available for them.
 * @returns the lines that fit, or `undefined` when none do.
 */
function fit(body: string, room: number): string | undefined {
  if (body.length === 0 || room <= 0) return undefined
  if (body.length <= room) return body
  const kept: string[] = []
  let used = 0
  for (const line of body.split('\n')) {
    if (used + line.length + 1 > room) break
    kept.push(line)
    used += line.length + 1
  }
  return kept.length === 0 ? undefined : kept.join('\n')
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
    // One preamble for the whole injection, not one per section. The calibration
    // rule is the same for both, and stating it twice cost roughly a fifth of the
    // block's budget to say nothing new.
    let room = config.maxCharacters - PREAMBLE.length - HEADING.length - 4

    // Lines already shown by the profile are not worth a second slot in the same
    // message: the model reads one message, and a repeated line reads as two
    // independent pieces of evidence for the same belief.
    const shown = new Set<string>()

    if (config.injectProfileOnFirstTurn && !profiled.has(agent.session.id)) {
      profiled.add(agent.session.id)
      const profile = ctx.memory.profile(scopes, { limit: config.profileLimit })
      const body = fit(renderProfile(profile), room)
      if (body !== undefined) {
        for (const line of body.split(SPLIT)) shown.add(line)
        const text = `### What memory knows about this user${GAP}${body}`
        room -= text.length + 2
        sections.push({ name: `${name}:profile`, text })
      }
    }

    const text = cueText(decision.messages)
    if (text.length > 0 && room > 0) {
      const recall = await ctx.memory.recall({
        text,
        scopes,
        limit: config.maxCues,
        minConfidence: config.minConfidence,
        signal,
      })
      const rendered = recall.cues.map(renderCue).filter(line => !shown.has(line))
      const body = fit(rendered.join(SPLIT), room)
      if (body !== undefined) {
        sections.push({ name: `${name}:recall`, text: `### Relevant to this request${GAP}${body}` })
      }
    }

    if (sections.length === 0) return decision
    const block = [`${HEADING}${GAP}${PREAMBLE}`, ...sections.map(section => section.text)].join(GAP)
    return {
      kind: 'enter',
      messages: [
        ...decision.messages,
        createUserMessage({
          content: [{ type: 'text', text: block }],
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
