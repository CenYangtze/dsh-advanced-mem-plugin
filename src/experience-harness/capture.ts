import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-tools'
import { memoryScopeKey, sessionScope } from '../memory/index.ts'
import type { ExperienceEnvironment, ExperienceEpisodeInput, ExperienceStep } from '../experience/types.ts'

export interface CapturePolicy {
  readonly maxTextLength: number
  readonly maxSteps: number
  readonly maxObservationLength: number
  readonly excludedTools: readonly string[]
  readonly transportTools: readonly string[]
  readonly environment: ExperienceEnvironment
}

function visible(content: readonly ContentBlock[], limit: number): string {
  return content.filter(block => block.type === 'text').map(block => block.text).join('\n').slice(0, limit)
}

/** Bounded projection of committed events. Arguments and reasoning are never retained. */
export interface TurnCapture {
  accept(session: Session, event: SessionEvent): ExperienceEpisodeInput | undefined
  invalidate(sessionId: string): void
  invalidateScope(scope: string): void
  clear(): void
}

export function createTurnCapture(policy: CapturePolicy): TurnCapture {
  interface State {
    turn: number; scope: string; startedAt: number; task: string; summary: string; summaryEvidence?: string
    steps: ExperienceStep[]; calls: Map<string, string>; evidence: Set<string>
  }
  const states = new Map<string, State>()
  const eligible = (tool: string): boolean => !policy.excludedTools.includes(tool) && !policy.transportTools.includes(tool)
  const accept: TurnCapture['accept'] = (session, event) => {
    if (event.type === 'turn/start') {
      states.set(session.id, { turn: event.data.turn, scope: memoryScopeKey(sessionScope(session)), startedAt: event.time, task: '', summary: '', steps: [], calls: new Map(), evidence: new Set() })
      return undefined
    }
    const state = states.get(session.id)
    if (!state) return undefined
    const { steps, calls, evidence } = state
    const cite = (): void => { evidence.add(`session:${session.id}:event:${event.seq}`) }
    switch (event.type) {
      case 'user/message':
        if (event.data.source.kind === 'user' && state.task.length < policy.maxTextLength) {
          const text = visible(event.data.content, policy.maxTextLength)
          if (text.trim()) {
            state.task = `${state.task}\n${text}`.trim().slice(0, policy.maxTextLength)
            cite()
          }
        }
        break
      case 'assistant/message':
        if (!event.data.interrupted) {
          const text = visible(event.data.message.content, policy.maxTextLength)
          if (text) {
            state.summary = text
            if (state.summaryEvidence) evidence.delete(state.summaryEvidence)
            state.summaryEvidence = `session:${session.id}:event:${event.seq}`
            cite()
          }
        }
        break
      case 'tool/call':
        if (eligible(event.data.name) && calls.size + steps.length < policy.maxSteps) calls.set(event.data.callId, event.data.name)
        break
      case 'tool/result': {
        const result = event.data.message
        const tool = calls.get(result.toolCallId)
        calls.delete(result.toolCallId)
        if (tool && steps.length < policy.maxSteps) {
          const observation = visible(result.content, policy.maxObservationLength) || `Tool returned ${result.content.map(block => block.type).join(', ') || 'no visible'} content`
          steps.push({ tool, action: `Invoke ${tool}`, observation: `${result.isError ? 'Error: ' : ''}${observation}`.slice(0, policy.maxTextLength) })
          cite()
        }
        break
      }
      case 'tool/ptc-dispatch':
        if (eligible(event.data.name) && steps.length < policy.maxSteps) {
          const observation = visible(event.data.content, policy.maxObservationLength) || `Tool returned ${event.data.content.map(block => block.type).join(', ') || 'no visible'} content`
          steps.push({ tool: event.data.name, action: `Invoke ${event.data.name}`, observation: `${event.data.isError ? 'Error: ' : ''}${observation}`.slice(0, policy.maxTextLength) })
          cite()
        }
        break
      case 'turn/end': {
        states.delete(session.id)
        if (event.data.turn !== state.turn || !state.task || !steps.length) return undefined
        cite()
        return {
          id: `${session.id}:turn:${state.turn}`, scope: memoryScopeKey(sessionScope(session)),
          sessionId: session.id, task: state.task, summary: state.summary || state.task, steps,
          outcome: { status: 'unknown', source: 'unknown', reason: `Harness turn ended: ${event.data.reason.kind}`, evidence: [] },
          environment: policy.environment, evidence: [...evidence], startedAt: state.startedAt, completedAt: event.time,
        }
      }
    }
    return undefined
  }
  return { accept, invalidate: sessionId => { states.delete(sessionId) }, clear: () => { states.clear() },
    invalidateScope: scope => { for (const [id, state] of states) if (state.scope === scope) states.delete(id) } }
}
