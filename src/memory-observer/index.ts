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
// Type-only: Code Mode declares `tool/code-dispatch-start` on SessionEventMap by
// module augmentation, so the arm below is only well-typed with it in scope.
import type {} from '@deepseek-ai/dsh-tools'
import { sessionScope } from '../memory/index.ts'
import type {
  MemoryAttachment,
  MemoryObservation,
  MemoryProvenance,
  MemoryRecordKind,
  MemoryScope,
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
  /**
   * Capture the individual tool calls a Code Mode program makes.
   *
   * Under Code Mode the model calls one transport tool and drives every real
   * tool from inside the program, so the outer call says only "a program ran".
   * These are the dispatches that say which tools were actually reached for,
   * and without them usage mining under Code Mode learns nothing.
   */
  captureCodeDispatches: boolean
  /**
   * Tools that only carry other tools, such as Code Mode's `run_code`.
   *
   * Their own invocation is not evidence of a preference — every Code Mode call
   * looks identical — and their arguments are a whole program. They are skipped
   * so the dispatches inside them are what gets counted. Naming them here rather
   * than hardcoding keeps the transport a deployment fact, which is what it is.
   */
  transportTools: string[]
  /** Characters kept from a tool call's argument digest; short by design — this is a label, not a transcript. */
  maxToolDigestLength: number
}

/** Schemastery validation for {@link Config}. */
export const Config: z<Config> = z.object({
  captureUserMessages: z.boolean().required(),
  captureAssistantMessages: z.boolean().required(),
  captureToolCalls: z.boolean().required(),
  maxTextLength: z.number().required(),
  excludedTools: z.array(z.string()).default([]),
  captureCodeDispatches: z.boolean().required(),
  transportTools: z.array(z.string()).default([]),
  maxToolDigestLength: z.number().required(),
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
 * Argument keys that carry a human-readable label for a call, most telling first.
 *
 * Harness tools take a `description` precisely so a call can be named in one
 * line; the rest are the fields that identify what a call was about when it has
 * no description.
 */
const DIGEST_KEYS: readonly string[] = [
  'description', 'query', 'prompt', 'pattern', 'command', 'file_path', 'path', 'url',
]

/**
 * Reduce a tool call's arguments to a short label.
 *
 * Storing the raw argument JSON was the original mistake here. It is the agent's
 * own machine-shaped output: a whole program under Code Mode, escaped quotes and
 * absolute paths otherwise. As index material it actively misleads — any query
 * mentioning a path matches an unrelated call that happened to contain it — and
 * as recalled text it tells the model what it already did. What is worth keeping
 * is the one line a human would use to name the call.
 * @param args - the logged arguments: a JSON string for a native call, an
 * already-normalized value for a Code Mode dispatch.
 * @param limit - maximum characters of label to keep.
 * @returns a short label, or an empty string when the arguments say nothing useful.
 */
export function toolDigest(args: unknown, limit: number): string {
  let parsed: unknown = args
  if (typeof args === 'string') {
    try {
      parsed = JSON.parse(args)
    } catch {
      // Not JSON, so there is no field to name the call by. The tool name alone
      // is a better record than an arbitrary prefix of an unparseable blob.
      return ''
    }
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return ''
  const fields = parsed as Record<string, unknown>
  for (const key of DIGEST_KEYS) {
    const value = fields[key]
    if (typeof value !== 'string') continue
    const line = value.trim().split('\n')[0]?.trim() ?? ''
    if (line.length === 0) continue
    return line.length <= limit ? line : `${line.slice(0, limit)}…`
  }
  return ''
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
  if (!Number.isSafeInteger(config.maxToolDigestLength) || config.maxToolDigestLength < 1) {
    throw new TypeError(
      `memory-observer: maxToolDigestLength must be a positive safe integer, got ${String(config.maxToolDigestLength)}`,
    )
  }
  const excluded = new Set(config.excludedTools)
  const transports = new Set(config.transportTools)
  /**
   * Build the observation for one tool call, native or Code Mode dispatch.
   *
   * The tool name leads the text so a query naming the tool ranks above one
   * that merely mentions it, and the digest follows as a label rather than a
   * transcript. Fidelity is `derived` because no original says this sentence,
   * and the kind's default use keeps it out of what gets read back to the model.
   */
  const toolObservation = (
    scope: MemoryScope,
    tool: string,
    args: unknown,
    where: MemoryProvenance,
  ): MemoryObservation => {
    const digest = toolDigest(args, config.maxToolDigestLength)
    return {
      scope,
      kind: 'tool-invocation',
      text: digest.length === 0 ? tool : `${tool} — ${digest}`,
      fidelity: 'derived',
      provenance: where,
    }
  }
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
        // A transport call carries other calls; the dispatches inside it are
        // captured instead, so counting the transport too would count every
        // Code Mode turn as a preference for one tool nobody chose.
        if (transports.has(call.name)) return
        enqueue(toolObservation(scope, call.name, call.arguments, {
          ...provenance, turn: call.turn, callId: call.callId, tool: call.name,
        }))
        return
      }
      case 'tool/code-dispatch-start': {
        // Code Mode's real tool calls. Taken at dispatch start rather than at
        // completion: this is the moment the model reached for the tool, which
        // is what usage mining is about, and it stays symmetric with `tool/call`
        // where no result is observed either.
        if (!config.captureToolCalls || !config.captureCodeDispatches) return
        const dispatch = event.data
        if (excluded.has(dispatch.name) || transports.has(dispatch.name)) return
        enqueue(toolObservation(scope, dispatch.name, dispatch.arguments, {
          ...provenance, callId: dispatch.subCallId, tool: dispatch.name,
        }))
        return
      }
      default:
        // SessionEventMap is merge-extensible; unobserved event types are not
        // memory material and are skipped without inspection.
        break
    }
  })
}
