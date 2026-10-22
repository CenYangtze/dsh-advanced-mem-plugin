import type { MemoryRuntime, MemoryRecord, MemoryScope } from '../memory/index.ts'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { positiveInteger } from './http.ts'
import type { EvaluationMemoryFactory, HistoryMessage } from './types.ts'

export interface HarnessMemoryOptions {
  /** Open an isolated Harness runtime/store. close disposes the registry and backing store. */
  readonly open: (input: { readonly namespace: string; readonly signal: AbortSignal }) => Promise<{ readonly memory: MemoryRuntime; close(): Promise<void> }>
  readonly recallLimit: number
  readonly maxContextChars: number
  readonly consolidate: boolean
}

/** Exercise production capture/retrieval semantics, including the author-based evidence gate. */
export function createHarnessMemoryFactory(options: HarnessMemoryOptions): EvaluationMemoryFactory {
  positiveInteger(options.recallLimit, 'recallLimit')
  positiveInteger(options.maxContextChars, 'maxContextChars')
  return async input => {
    const backend = await options.open({ namespace: input.namespace, signal: input.signal })
    const scope: MemoryScope = { kind: 'workspace', workspace: input.namespace }
    const sourceByRecord = new Map<string, HistoryMessage>()
    const turns = new Map<string, number>()
    try {
      for (const turn of input.history) {
        input.signal.throwIfAborted()
        const turnIndex = turns.get(turn.sessionId) ?? 0
        turns.set(turn.sessionId, turnIndex + 1)
        const record = await backend.memory.remember({ scope, kind: turn.role === 'user' ? 'user-message' : 'assistant-message', text: turn.text, fidelity: 'verbatim', at: turn.at,
          provenance: { sessionId: `${input.namespace}:${turn.sessionId}` as SessionId, turn: turnIndex } })
        sourceByRecord.set(record.id, turn)
      }
      if (options.consolidate && input.history.length) await backend.memory.consolidate(scope, { now: input.history[input.history.length - 1]!.at, signal: input.signal })
    } catch (error) { await backend.close(); throw error }
    return {
      async recall(question, signal) {
        const recalled = await backend.memory.recall({ text: question.question, scopes: [scope], limit: options.recallLimit, now: question.at, signal })
        const lines: string[] = []
        const ids = new Set<string>()
        const sessions = new Set<string>()
        let length = 0
        const addSource = (record: MemoryRecord) => {
          const source = sourceByRecord.get(record.id)
          if (source) { ids.add(source.id); sessions.add(source.sessionId) }
        }
        for (const cue of recalled.cues) {
          const text = cue.kind === 'record'
            ? JSON.stringify({ at: new Date(cue.record.createdAt).toISOString(), text: cue.record.text, ...(cue.anchor ? { precedingQuestion: cue.anchor.text } : {}), ...(cue.confirmation ? { confirmation: cue.confirmation.text } : {}) })
            : cue.kind === 'node' ? cue.node.summary : cue.edge.claim
          if (length + text.length + 1 > options.maxContextChars) continue
          lines.push(text); length += text.length + 1
          if (cue.kind === 'record') {
            addSource(cue.record)
            if (cue.anchor) addSource(cue.anchor)
            if (cue.confirmation) addSource(cue.confirmation)
          } else {
            for (const id of cue.kind === 'node' ? cue.node.evidence : cue.edge.evidence) {
              const source = sourceByRecord.get(id)
              if (source) { ids.add(source.id); sessions.add(source.sessionId) }
            }
          }
        }
        return { text: lines.join('\n'), messageIds: [...ids], sessionIds: [...sessions] }
      },
      close: () => backend.close(),
    }
  }
}
