/**
 * Model-facing memory tools plus the memory protocol prompt section.
 *
 * This is the Consumer role of the memory seam, and the half that makes memory
 * deliberate: `memory_search` lets the agent ask before it decides,
 * `memory_write` lets it keep what it just learned, and `memory_forget` lets it
 * drop what turned out to be wrong. The prompt section registered alongside them
 * is what turns those capabilities into a habit — without it, tools this general
 * are reliably ignored.
 *
 * @module dsh-advanced-mem-plugin/tool
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import { sessionScope } from '../memory/index.ts'
import type { MemoryCue, MemoryNode, MemoryScope } from '../memory/index.ts'
import { MEMORY_PROTOCOL, MEMORY_SECTION_NAME, MEMORY_SECTION_ORDER } from './prompt.ts'

export { MEMORY_PROTOCOL, MEMORY_SECTION_NAME, MEMORY_SECTION_ORDER } from './prompt.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'tool-memory'

/** The hub the tools operate on, the registry they join, and the prompt they contribute to. */
export const inject = ['memory', 'tools', 'systemPrompt']

/**
 * Subject classes the model may write. The affinity and procedure classes are
 * deliberately absent: those are mined from observed behavior, and letting the
 * model assert them would let its own guesses masquerade as usage evidence.
 */
const WRITABLE_TYPES = ['preference', 'constraint', 'project', 'entity', 'routine', 'person'] as const

/** Relations the model may assert between two remembered subjects. */
const WRITABLE_RELATIONS = ['prefers', 'avoids', 'uses', 'works-on', 'part-of', 'caused-by'] as const

/** Reach selectors the model chooses between. */
const SCOPE_CHOICES = ['workspace', 'user'] as const

/** Tool-facing memory policy. */
export interface Config {
  /** Cues a search returns when the call does not state its own limit. */
  defaultSearchLimit: number
  /** Cues a single search may return, whatever the call asks for. */
  maxSearchLimit: number
  /** Characters kept from a written summary; longer text is rejected rather than silently cut. */
  maxSummaryLength: number
}

/** Schemastery validation for {@link Config}. */
export const Config: z<Config> = z.object({
  defaultSearchLimit: z.number().required(),
  maxSearchLimit: z.number().required(),
  maxSummaryLength: z.number().required(),
})

/**
 * Resolve the scope a call addresses.
 *
 * `workspace` needs a session to know which workspace, so a call from outside an
 * agent session is rejected rather than silently redirected to the user scope —
 * a memory written to the wrong reach is invisible where it was meant to be
 * found, and quietly present everywhere else.
 * @param choice - the selector the model supplied.
 * @param exec - the execution, carrying the owning agent when there is one.
 * @returns the resolved scope.
 * @throws when `workspace` is asked for outside an agent session, or the session has no workspace.
 */
function resolveScope(choice: string, exec: Readonly<ToolExecution>): MemoryScope {
  if (choice === 'user') return { kind: 'user' }
  const agent = exec.agent
  if (agent === undefined) {
    throw new Error('scope "workspace" requires an owning agent session; use scope "user" instead')
  }
  const scope = sessionScope(agent.session)
  if (scope.kind !== 'workspace') {
    throw new Error('this session has no workspace; use scope "user" instead')
  }
  return scope
}

/** The scope chain a search reads: the workspace when there is one, then the user scope. */
function searchScopes(choice: string | undefined, exec: Readonly<ToolExecution>): MemoryScope[] {
  if (choice === 'user') return [{ kind: 'user' }]
  const agent = exec.agent
  const workspace = agent === undefined ? undefined : sessionScope(agent.session)
  if (workspace === undefined || workspace.kind !== 'workspace') return [{ kind: 'user' }]
  return choice === 'workspace' ? [workspace] : [workspace, { kind: 'user' }]
}

/** Project one cue onto the tool's structured output. */
function cueOutput(cue: MemoryCue): {
  kind: string
  label: string
  detail: string
  confidence: number
  origin: string
  score: number
} {
  switch (cue.kind) {
    case 'node':
      return {
        kind: cue.node.type,
        label: cue.node.label,
        detail: cue.node.summary,
        confidence: Number(cue.node.confidence.toFixed(3)),
        origin: cue.node.origin,
        score: Number(cue.score.toFixed(4)),
      }
    case 'edge':
      return {
        kind: `relation:${cue.edge.relation}`,
        label: cue.endpoints.map(endpoint => endpoint.label).join(' → '),
        detail: cue.edge.claim,
        confidence: Number(cue.edge.confidence.toFixed(3)),
        origin: cue.edge.origin,
        score: Number(cue.score.toFixed(4)),
      }
    case 'record':
      return {
        kind: `episode:${cue.record.kind}`,
        label: new Date(cue.record.createdAt).toISOString().slice(0, 10),
        detail: cue.record.text,
        confidence: 1,
        origin: cue.record.fidelity,
        score: Number(cue.score.toFixed(4)),
      }
  }
}

/** The active node with one label in a scope chain, when exactly one exists. */
function findByLabel(ctx: Context, scopes: readonly MemoryScope[], label: string): MemoryNode | undefined {
  const wanted = label.trim()
  const profile = ctx.memory.profile(scopes, { limit: Number.MAX_SAFE_INTEGER })
  return profile.nodes.find(node => node.label === wanted)
}

/**
 * Register the memory tools and the memory protocol prompt section.
 * @param ctx - registrant context carrying the hub and the tool registry.
 * @param config - search and write limits.
 * @throws when a limit is not a positive safe integer, or the default limit exceeds the maximum.
 */
export function apply(ctx: Context, config: Config): void {
  for (const [field, value] of [
    ['defaultSearchLimit', config.defaultSearchLimit],
    ['maxSearchLimit', config.maxSearchLimit],
    ['maxSummaryLength', config.maxSummaryLength],
  ] as const) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new TypeError(`tool-memory: ${field} must be a positive safe integer, got ${String(value)}`)
    }
  }
  if (config.defaultSearchLimit > config.maxSearchLimit) {
    throw new TypeError(
      `tool-memory: defaultSearchLimit (${config.defaultSearchLimit}) exceeds maxSearchLimit (${config.maxSearchLimit})`,
    )
  }

  ctx.systemPrompt.section({
    name: MEMORY_SECTION_NAME,
    order: MEMORY_SECTION_ORDER,
    text: MEMORY_PROTOCOL,
  })

  ctx.tools.register(defineTool({
    name: 'memory_search',
    description:
      'Search what you remember about this user: their stated preferences and constraints, the '
      + 'tools, skills and routines they habitually use, their projects, and the raw episodes those '
      + 'conclusions were drawn from. Search before choosing an approach for a task this user may '
      + 'have done before, and before asking them something they may have already told you. Results '
      + 'carry a confidence and an origin — `asserted` means the user said it, `inferred` means it '
      + 'was concluded from their behavior.',
    parameters: {
      query: {
        type: 'string',
        required: true,
        description: 'What you want to know, in the words you would use to ask.',
      },
      scope: {
        type: 'string',
        enum: [...SCOPE_CHOICES],
        description:
          'Which memories to read: `workspace` for this project only, `user` for memories that '
          + 'follow the person everywhere. Omit to read both.',
      },
      limit: { type: 'integer', description: 'Maximum results to return.' },
      include_episodes: {
        type: 'boolean',
        description:
          'Include raw past interactions alongside durable conclusions. Useful when you need what '
          + 'was actually said or done rather than what was concluded from it.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          results: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                kind: { type: 'string', required: true },
                label: { type: 'string', required: true },
                detail: { type: 'string', required: true },
                confidence: { type: 'number', required: true },
                origin: { type: 'string', required: true },
                score: { type: 'number', required: true },
              },
            },
          },
          truncated: { type: 'boolean', required: true },
        },
      },
      render: (args, value) => [{
        type: 'text',
        text: value.results.length === 0
          ? `No memories matched ${JSON.stringify(args.query)}.`
          : `${value.results.length} memories for ${JSON.stringify(args.query)}:\n`
            + value.results
              .map(result => `- [${result.kind} · ${result.confidence} · ${result.origin}] ${result.detail}`)
              .join('\n')
            + (value.truncated ? '\n(more matched; narrow the query or raise the limit)' : ''),
      }],
    },
    async execute(args, exec) {
      const limit = Math.min(args.limit ?? config.defaultSearchLimit, config.maxSearchLimit)
      const recall = await ctx.memory.recall({
        text: args.query,
        scopes: searchScopes(args.scope, exec),
        limit,
        ...args.include_episodes === undefined ? {} : { includeEpisodes: args.include_episodes },
        signal: exec.signal,
      })
      return { results: recall.cues.map(cueOutput), truncated: recall.truncated }
    },
    presentCall: args => ({ card: 'generic', title: `Search memory: ${args.query}`, kind: 'read' }),
  }))

  ctx.tools.register(defineTool({
    name: 'memory_write',
    description:
      'Remember something that will still matter in a later session: a preference or constraint the '
      + 'user stated, a correction they made, or a durable fact about their project or how they work. '
      + 'Writing the same label again reinforces the existing memory rather than duplicating it. Do '
      + 'not store transient task state, credentials, or a conclusion drawn from one ambiguous signal.',
    parameters: {
      type: {
        type: 'string',
        required: true,
        enum: [...WRITABLE_TYPES],
        description:
          'What kind of thing this is: `preference` (how they like things done), `constraint` (a '
          + 'rule that must hold), `project`, `entity` (a system, service, or artifact), `routine` (a '
          + 'sequence they repeat), or `person`.',
      },
      label: {
        type: 'string',
        required: true,
        description:
          'Short canonical name, reused verbatim to reinforce or update this memory later.',
      },
      summary: {
        type: 'string',
        required: true,
        description: 'One sentence stating what is true, written so it reads correctly months from now.',
      },
      stated_by_user: {
        type: 'boolean',
        required: true,
        description:
          'True only when the user said this outright. A stated memory does not fade; one you '
          + 'inferred does, so claiming this falsely makes a guess permanent.',
      },
      scope: {
        type: 'string',
        enum: [...SCOPE_CHOICES],
        description:
          'Where it applies: `workspace` for this project, `user` for the person everywhere. Omit for `workspace`.',
      },
      related_to: {
        type: 'string',
        description: 'Label of an existing memory to link this one to.',
      },
      relation: {
        type: 'string',
        enum: [...WRITABLE_RELATIONS],
        description: 'How this memory relates to `related_to`. Required when `related_to` is given.',
      },
      claim: {
        type: 'string',
        description: 'One sentence stating the link. Required when `related_to` is given.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          label: { type: 'string', required: true },
          scope: { type: 'string', required: true },
          confidence: { type: 'number', required: true },
          linked: { type: 'boolean', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `Remembered "${value.label}" in ${value.scope} scope at confidence ${value.confidence}`
          + `${value.linked ? ' and linked it' : ''}.`,
      }],
    },
    async execute(args, exec) {
      const summary = args.summary.trim()
      if (summary.length > config.maxSummaryLength) {
        throw new Error(
          `summary is ${summary.length} characters; keep it under ${config.maxSummaryLength} so the memory stays a single statement`,
        )
      }
      const scope = resolveScope(args.scope ?? 'workspace', exec)
      const node = await ctx.memory.assert({
        scope,
        type: args.type,
        label: args.label,
        summary,
        origin: args.stated_by_user ? 'asserted' : 'inferred',
      })
      let linked = false
      if (args.related_to !== undefined) {
        if (args.relation === undefined || args.claim === undefined) {
          throw new Error('`related_to` requires both `relation` and `claim`')
        }
        const target = findByLabel(ctx, [scope], args.related_to)
        if (target === undefined) {
          throw new Error(`no memory labelled ${JSON.stringify(args.related_to)} in ${scope.kind} scope`)
        }
        await ctx.memory.relate({
          scope,
          from: node.id,
          to: target.id,
          relation: args.relation,
          claim: args.claim,
          origin: args.stated_by_user ? 'asserted' : 'inferred',
        })
        linked = true
      }
      return {
        label: node.label,
        scope: scope.kind,
        confidence: Number(node.confidence.toFixed(3)),
        linked,
      }
    },
    presentCall: args => ({ card: 'generic', title: `Remember: ${args.label}`, kind: 'other', rawInput: args.summary }),
  }))

  ctx.tools.register(defineTool({
    name: 'memory_forget',
    description:
      'Drop a memory that turned out to be wrong, or that the user asked you to remove. `retract` '
      + 'stops it being recalled while keeping it auditable, and is the right choice for a belief '
      + 'that was simply mistaken. `erase` permanently removes the underlying material and is for '
      + 'when the user asks for it to be gone.',
    parameters: {
      label: {
        type: 'string',
        required: true,
        description: 'Label of the memory to drop, exactly as `memory_search` reported it.',
      },
      mode: {
        type: 'string',
        enum: ['retract', 'erase'],
        description: 'How thoroughly to drop it. Omit for `retract`.',
      },
      scope: {
        type: 'string',
        enum: [...SCOPE_CHOICES],
        description: 'Where the memory lives. Omit to search both.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          label: { type: 'string', required: true },
          mode: { type: 'string', required: true },
          evidenceErased: { type: 'integer', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.mode === 'erase'
          ? `Erased "${value.label}" and ${value.evidenceErased} supporting records.`
          : `Retracted "${value.label}"; it will no longer be recalled.`,
      }],
    },
    async execute(args, exec) {
      const scopes = searchScopes(args.scope, exec)
      const node = findByLabel(ctx, scopes, args.label)
      if (node === undefined) {
        throw new Error(`no memory labelled ${JSON.stringify(args.label)}`)
      }
      const mode = args.mode ?? 'retract'
      await ctx.memory.retract({ kind: 'node', id: node.id })
      let evidenceErased = 0
      if (mode === 'erase') {
        for (const record of node.evidence) {
          if (await ctx.memory.forget(record)) evidenceErased++
        }
      }
      return { label: node.label, mode, evidenceErased }
    },
    presentCall: args => ({ card: 'generic', title: `Forget: ${args.label}`, kind: 'other' }),
  }))
}
