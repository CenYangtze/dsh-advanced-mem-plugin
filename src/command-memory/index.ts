/**
 * Human-facing `/memory` command: see what the agent remembers, search it,
 * start from it, and correct it.
 *
 * Memory that a person cannot inspect is memory they cannot trust. The rest of
 * the family is addressed to the model — automatic recall injects, the tools let
 * the agent ask — and none of it answers the two questions a user actually has:
 * *what do you think you know about me*, and *how do I make you stop*. This
 * command is the only surface that answers both, and it is deliberately the
 * shortest path to `forget`: a system that learns from someone must let them see
 * and delete what it learned, without asking the model to do it for them.
 *
 * It also renders what memory suggests starting from, which is the one thing a
 * fresh session can offer before the person has typed anything.
 *
 * @module dsh-advanced-mem-plugin/command
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'
import { memoryScopeKey, sessionScope } from '../memory/index.ts'
import type {
  MemoryCue,
  MemoryNode,
  MemoryProfile,
  MemoryScope,
  MemorySuggestion,
} from '../memory/index.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'command-memory'

/** The command registry to register on and the hub to read. */
export const inject = ['commands', 'memory']

/** How much each `/memory` view shows. */
export interface Config {
  /** Beliefs listed by the default view. */
  profileLimit: number
  /** Suggestions offered alongside them. */
  suggestLimit: number
  /** Cues returned by `/memory search`. */
  searchLimit: number
}

/** Schemastery validation for {@link Config}. */
export const Config: z<Config> = z.object({
  profileLimit: z.number().required(),
  suggestLimit: z.number().required(),
  searchLimit: z.number().required(),
})

const USAGE = 'Usage: /memory [search <query>|suggest|forget <label>|stats]'

/** The grammar `/memory` owns; anything else is an error rather than a guess. */
type MemoryCommand =
  | { readonly kind: 'show' }
  | { readonly kind: 'suggest' }
  | { readonly kind: 'stats' }
  | { readonly kind: 'search'; readonly query: string }
  | { readonly kind: 'forget'; readonly label: string }
  | { readonly kind: 'usage' }

/**
 * Parse one `/memory` line.
 *
 * Unrecognized input returns usage rather than being treated as a search: a
 * mistyped subcommand that silently searched would look like it worked and
 * report nothing found.
 * @param rawInput - the text following the command name.
 * @returns the parsed command.
 */
export function parseMemoryCommand(rawInput: string): MemoryCommand {
  const input = rawInput.trim()
  if (input.length === 0) return { kind: 'show' }
  const [head = '', ...rest] = input.split(/\s+/u)
  const argument = rest.join(' ').trim()
  switch (head.toLowerCase()) {
    case 'suggest': return { kind: 'suggest' }
    case 'stats': return { kind: 'stats' }
    case 'search': return argument.length === 0 ? { kind: 'usage' } : { kind: 'search', query: argument }
    case 'forget': return argument.length === 0 ? { kind: 'usage' } : { kind: 'forget', label: argument }
    default: return { kind: 'usage' }
  }
}

/** Render one belief as a line stating what it is, how sure memory is, and where it came from. */
function renderNode(node: MemoryNode): string {
  return `- [${node.type} · ${node.confidence.toFixed(2)} · ${node.origin}] ${node.summary}`
}

/** Render one retrieved cue; layer-0 material is dated rather than scored, having no belief to state. */
function renderCue(cue: MemoryCue): string {
  switch (cue.kind) {
    case 'node': return renderNode(cue.node)
    case 'edge': return `- [${cue.edge.relation} · ${cue.edge.confidence.toFixed(2)} · ${cue.edge.origin}] ${cue.edge.claim}`
    case 'record': {
      const when = new Date(cue.record.createdAt).toISOString().slice(0, 10)
      return `- [episode · ${when}] ${cue.record.text}`
    }
  }
}

/** Render the suggestion list, or say plainly that memory holds no work to resume. */
function renderSuggestions(suggestions: readonly MemorySuggestion[]): string {
  if (suggestions.length === 0) {
    return 'Nothing to suggest yet — memory holds no project, routine, or procedure for this workspace.'
  }
  const lines = suggestions.map(
    suggestion => `- **${suggestion.subject}** (${suggestion.kind}) — ${suggestion.reason}`,
  )
  return ['Worth picking up:', ...lines].join('\n')
}

/** The default view: what memory believes, then what it suggests starting from. */
function renderShow(profile: MemoryProfile, suggestions: readonly MemorySuggestion[]): string {
  const sections: string[] = []
  if (profile.nodes.length === 0 && profile.edges.length === 0) {
    sections.push('Memory holds nothing about this user yet. It fills as you work.')
  } else {
    const lines = profile.nodes.map(renderNode)
    for (const edge of profile.edges) {
      lines.push(`- [${edge.relation} · ${edge.confidence.toFixed(2)} · ${edge.origin}] ${edge.claim}`)
    }
    const omitted = profile.total - profile.nodes.length
    // Stating the remainder matters: a person deciding whether to trust this
    // needs to know whether they are seeing everything or the top of a list.
    if (omitted > 0) lines.push(`- …and ${omitted} more (\`/memory search <query>\` to find them)`)
    sections.push(['What memory knows about you:', ...lines].join('\n'))
  }
  sections.push(renderSuggestions(suggestions))
  sections.push(USAGE)
  return sections.join('\n\n')
}

/**
 * Count what the store holds, split the way a person asking "what did you keep"
 * actually cares about: how much is a belief versus raw material, and how much
 * of that material is the agent's own activity rather than theirs.
 * @param ctx - context carrying the hub.
 * @param scopes - the scope chain to count.
 * @returns the rendered summary.
 */
function renderStats(ctx: Context, scopes: readonly MemoryScope[]): string {
  const store = ctx.memory.store
  const keys = scopes.map(memoryScopeKey)
  const nodes = [...store.nodes(keys)].filter(node => node.status === 'active')
  const edges = [...store.edges(keys)].filter(edge => edge.status === 'active')
  const records = [...store.records(keys)].filter(record => record.status === 'active')
  const quotable = records.filter(record => record.use === 'recallable').length
  const byType = new Map<string, number>()
  for (const node of nodes) byType.set(node.type, (byType.get(node.type) ?? 0) + 1)
  const breakdown = [...byType.entries()]
    .sort((left, right) => right[1] - left[1])
    .map(([type, count]) => `  - ${type}: ${count}`)
  return [
    `Beliefs: ${nodes.length} node(s), ${edges.length} conclusion(s).`,
    ...breakdown,
    `Raw material: ${records.length} record(s) — ${quotable} quotable, ${records.length - quotable} evidence-only.`,
    'Evidence-only material is counted but never read back to the model.',
  ].join('\n')
}

/**
 * Retract every active belief carrying one label.
 *
 * Matching by label rather than id is what makes this usable from a keyboard:
 * the label is what the other views print. Every match is retracted, because a
 * person asking to be forgotten about a subject means all of it, not the first
 * one found.
 * @param ctx - context carrying the hub.
 * @param scopes - the scope chain to search.
 * @param label - the label to match, case-insensitively.
 * @returns the command result.
 */
async function forget(ctx: Context, scopes: readonly MemoryScope[], label: string): Promise<CommandResult> {
  const wanted = label.toLowerCase()
  const keys = scopes.map(memoryScopeKey)
  const matches = [...ctx.memory.store.nodes(keys)]
    .filter(node => node.status === 'active' && node.label.toLowerCase() === wanted)
  if (matches.length === 0) {
    return { kind: 'error', text: `No active memory labelled ${JSON.stringify(label)}. \`/memory\` lists what there is.` }
  }
  for (const node of matches) await ctx.memory.retract({ kind: 'node', id: node.id })
  const summaries = matches.map(node => `- ${node.summary}`)
  return {
    kind: 'success',
    text: [`Retracted ${matches.length} memory item(s) labelled ${JSON.stringify(label)}:`, ...summaries].join('\n'),
  }
}

/**
 * Execute one `/memory` invocation.
 * @param ctx - context carrying the hub.
 * @param config - view sizes.
 * @param invocation - the dispatched command.
 * @returns the rendered result.
 */
async function execute(ctx: Context, config: Config, invocation: CommandInvocation): Promise<CommandResult> {
  if (!ctx.memory.ready) {
    return { kind: 'error', text: 'Memory is not available: no store is mounted in this assembly.' }
  }
  const scopes: MemoryScope[] = [sessionScope(invocation.agent.session), { kind: 'user' }]
  const command = parseMemoryCommand(invocation.rawInput)
  switch (command.kind) {
    case 'usage':
      return { kind: 'error', text: USAGE }
    case 'show':
      return {
        kind: 'success',
        text: renderShow(
          ctx.memory.profile(scopes, { limit: config.profileLimit }),
          ctx.memory.suggest(scopes, { limit: config.suggestLimit }),
        ),
      }
    case 'suggest':
      return { kind: 'success', text: renderSuggestions(ctx.memory.suggest(scopes, { limit: config.suggestLimit })) }
    case 'stats':
      return { kind: 'success', text: renderStats(ctx, scopes) }
    case 'search': {
      const recall = await ctx.memory.recall({
        text: command.query,
        scopes,
        limit: config.searchLimit,
        signal: invocation.signal,
      })
      if (recall.cues.length === 0) {
        return { kind: 'success', text: `Nothing remembered for ${JSON.stringify(command.query)}.` }
      }
      return {
        kind: 'success',
        text: [`Remembered for ${JSON.stringify(command.query)}:`, ...recall.cues.map(renderCue)].join('\n'),
      }
    }
    case 'forget':
      return forget(ctx, scopes, command.label)
  }
}

/**
 * Register the `/memory` command for the lifetime of `ctx`.
 * @param ctx - registrant context carrying the command registry and the hub.
 * @param config - view sizes.
 * @throws when a view size is not a positive safe integer.
 */
export function apply(ctx: Context, config: Config): void {
  for (const [field, value] of [
    ['profileLimit', config.profileLimit],
    ['suggestLimit', config.suggestLimit],
    ['searchLimit', config.searchLimit],
  ] as const) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new TypeError(`command-memory: ${field} must be a positive safe integer, got ${String(value)}`)
    }
  }
  ctx.commands.register({
    name: 'memory',
    description: 'see, search, and prune what the agent remembers about you',
    input: { hint: '[search <query>|suggest|forget <label>|stats]' },
    handler: invocation => execute(ctx, config, invocation),
  })
}
