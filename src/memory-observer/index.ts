/**
 * Passive memory capture from the session log.
 *
 * This is the automatic half of the memory system: nothing here asks the agent
 * to do anything. It listens to the durable session log and appends layer-0
 * records for the interactions that carry signal — what the user asked for, what
 * tools and skills were reached for, and which originals (images, files, URLs)
 * were involved. Those records are what the consolidation engine later mines
 * into preferences and affinities.
 *
 * Capture reads the log rather than intercepting the loop, so it observes exactly
 * what was durably recorded and cannot change what the model sees. Writes are
 * serialized on one chain and never awaited by the log: a slow or failing medium
 * degrades memory, it does not stall a turn.
 *
 * @module dsh-advanced-mem-plugin/observer
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import { sessionScope } from '../memory/index.ts'
import type {
  MemoryAttachment,
  MemoryObservation,
  MemoryProvenance,
  MemoryRecordKind,
} from '../memory/index.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'memory-observer'

/** The hub to write into and the session store whose log is observed. */
export const inject = ['memory', 'sessions']

/** What the observer captures and how much of it. */
export interface Config {
  /**
   * Capture direct human prompts verbatim. This is the highest-signal material
   * in the log and the only source of `asserted`-grade evidence, so turning it
   * off leaves the graph with inference alone.
   */
  captureUserMessages: boolean
  /**
   * Capture assistant replies as summaries. Off by default in most assemblies:
   * assistant text is voluminous and largely restates the user's own request, so
   * it inflates the substrate faster than it improves recall.
   */
  captureAssistantMessages: boolean
  /**
   * Capture tool calls. This is what makes behavior-cycle mining possible — the
   * frequency with which a person reaches for a given tool or skill is exactly
   * the evidence the consolidation engine turns into an affinity.
   */
  captureToolCalls: boolean
  /** Characters kept per captured text; longer material is truncated, which marks the record `summary`. */
  maxTextLength: number
  /**
   * Tool names never captured. Deployment-specific: a tool that carries secrets
   * or high-volume machine output belongs here, and which tools those are is not
   * knowable from this package.
   */
  excludedTools: string[]
}

/** Schemastery validation for {@link Config}. */
export const Config: z<Config> = z.object({
  captureUserMessages: z.boolean().required(),
  captureAssistantMessages: z.boolean().required(),
  captureToolCalls: z.boolean().required(),
  maxTextLength: z.number().required(),
  excludedTools: z.array(z.string()).default([]),
})

/**
 * Flatten a message's model-facing blocks into indexable text.
 * @param content - the message blocks.
 * @returns the concatenated visible text; reasoning and tool plumbing are skipped.
 */
function visibleText(content: readonly ContentBlock[]): string {
  const parts: string[] = []
  for (const block of content) {
    switch (block.type) {
      case 'text':
        parts.push(block.text)
        break
      case 'tool-result':
      case 'tool-call':
      case 'reasoning':
      case 'image':
        break
      default:
        // ContentBlockMap is merge-extensible: an unrecognized block contributes
        // no text rather than failing capture.
        break
    }
  }
  return parts.join('\n').trim()
}

/**
 * Collect the non-text originals a message referenced.
 *
 * The bytes stay where the attachment service put them; memory keeps the
 * locator, the media type, and the size. That is the fidelity contract for
 * media: a later consumer resolves the original or reports that it is gone,
 * rather than working from a copy memory silently re-encoded.
 * @param content - the message blocks.
 * @returns one attachment reference per image block.
 */
function attachmentsOf(content: readonly ContentBlock[]): MemoryAttachment[] {
  const attachments: MemoryAttachment[] = []
  for (const block of content) {
    if (block.type !== 'image') continue
    const reference = block.attachment
    attachments.push({
      kind: 'image',
      uri: `attachment:${reference.attachmentId}`,
      mediaType: reference.mediaType,
      bytes: reference.bytes,
      ...reference.name === undefined ? {} : { caption: reference.name },
    })
  }
  return attachments
}

/**
 * Classify one message source as capture material.
 *
 * `MessageSourceMap` is merge-extensible, so this switches on the kinds the
 * harness produces and treats every other producer as a user-initiated entry
 * point — an explicitly invoked skill being the case that exists today.
 * @param sourceKind - the producing source's discriminant.
 * @returns the record kind to capture as, or `undefined` for harness output.
 */
function capturedKind(sourceKind: string): MemoryRecordKind | undefined {
  switch (sourceKind) {
    case 'plugin':
    case 'model':
    case 'tool':
      return undefined
    case 'user':
      return 'user-message'
    default:
      return 'skill-invocation'
  }
}

/**
 * Reduce text to the configured budget.
 * @param text - the captured text.
 * @param limit - maximum characters to keep.
 * @returns the text and whether it was reduced, which decides the record's fidelity.
 */
function truncate(text: string, limit: number): { text: string; reduced: boolean } {
  if (text.length <= limit) return { text, reduced: false }
  return { text: text.slice(0, limit), reduced: true }
}

/**
 * Register passive capture for the lifetime of `ctx`.
 * @param ctx - registrant context carrying the hub and the session store.
 * @param config - what to capture and how much.
 * @throws when `maxTextLength` is not a positive safe integer.
 */
export function apply(ctx: Context, config: Config): void {
  if (!Number.isSafeInteger(config.maxTextLength) || config.maxTextLength < 1) {
    throw new TypeError(
      `memory-observer: maxTextLength must be a positive safe integer, got ${String(config.maxTextLength)}`,
    )
  }
  const excluded = new Set(config.excludedTools)
  // One chain, so records land in log order and a slow medium cannot interleave
  // two writes for the same turn. Failures are contained per write: memory is
  // an enhancement, and a broken medium must not take the session with it.
  let chain: Promise<void> = Promise.resolve()
  const enqueue = (observation: MemoryObservation): void => {
    chain = chain.then(async () => {
      await ctx.memory.remember(observation)
    }).catch((error: unknown) => {
      ctx.logger.warn(`memory-observer: capture failed: ${String(error)}`)
    })
  }

  ctx.on('session/event', (session: Session, event: SessionEvent) => {
    if (!ctx.memory.ready) return
    const scope = sessionScope(session)
    const provenance: MemoryProvenance = { sessionId: session.id, eventSeq: event.seq }
    switch (event.type) {
      case 'user/message': {
        if (!config.captureUserMessages) return
        const message = event.data
        const text = visibleText(message.content)
        const attachments = attachmentsOf(message.content)
        if (text.length === 0 && attachments.length === 0) return
        const reduced = truncate(text, config.maxTextLength)
        const kind = capturedKind(message.source.kind)
        // A plugin-, model-, or tool-sourced message is the harness talking to
        // itself; capturing it would feed the graph its own output as if it
        // were evidence about the user.
        if (kind === undefined) return
        enqueue({
          scope,
          kind,
          text: reduced.text,
          fidelity: reduced.reduced ? 'summary' : 'verbatim',
          attachments,
          provenance,
        })
        return
      }
      case 'assistant/message': {
        if (!config.captureAssistantMessages) return
        const text = visibleText(event.data.message.content)
        if (text.length === 0) return
        const reduced = truncate(text, config.maxTextLength)
        enqueue({
          scope,
          kind: 'assistant-message',
          text: reduced.text,
          fidelity: reduced.reduced ? 'summary' : 'verbatim',
          provenance: { ...provenance, turn: event.data.turn },
        })
        return
      }
      case 'tool/call': {
        if (!config.captureToolCalls) return
        const call = event.data
        if (excluded.has(call.name)) return
        const reduced = truncate(call.arguments, config.maxTextLength)
        enqueue({
          scope,
          kind: 'tool-invocation',
          // The tool name leads the text so the lexical index ranks a query
          // naming the tool above one merely mentioning it in an argument.
          text: `${call.name} ${reduced.text}`,
          fidelity: 'derived',
          provenance: { ...provenance, turn: call.turn, callId: call.callId, tool: call.name },
        })
        return
      }
      default:
        // SessionEventMap is merge-extensible; unobserved event types are not
        // memory material and are skipped without inspection.
        break
    }
  })
}
