import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-tools'
import { memoryScopeKey, sessionScope } from '../memory/index.ts'
import type { ExperienceEnvironment, ExperienceEpisodeInput, ExperienceStep } from '../experience/types.ts'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { classifyCall, resultEvidence, type CallClassification } from './capture-evidence.ts'

export interface CapturePolicy {
  readonly maxTextLength: number
  readonly maxSteps: number
  readonly maxObservationLength: number
  readonly excludedTools: readonly string[]
  readonly transportTools: readonly string[]
  readonly environment: ExperienceEnvironment
}

function visible(content: readonly ContentBlock[]): string {
  return content.filter(block => block.type === 'text').map(block => block.text).join('\n')
}

/** Only an intact tool-produced read window may survive local observation clipping as context. */
function intactReadback(meta: JsonValue | undefined, text: string): boolean {
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return false
  const { offset, totalLines, lines, truncatedByBytes } = meta
  if (typeof offset !== 'number' || !Number.isSafeInteger(offset) || offset < 1
    || typeof totalLines !== 'number' || !Number.isSafeInteger(totalLines) || totalLines < 0
    || !Array.isArray(lines) || truncatedByBytes === true
    || /\(Output capped\.|\.\.\. \(line truncated to \d+ chars\)/i.test(text)) return false
  return lines.every((line, index) => line !== null && typeof line === 'object' && !Array.isArray(line)
    && line.number === offset + index && line.number <= totalLines && typeof line.text === 'string')
}

/** Bounded projection of committed events. Arguments and reasoning are never retained. */
export interface TurnCapture {
  accept(session: Session, event: SessionEvent): ExperienceEpisodeInput | undefined
  rememberRecall(sessionId: string, turn: number, skills: readonly { id: string; version: number }[]): void
  invalidate(sessionId: string): void
  invalidateScope(scope: string): void
  clear(): void
}

export function createTurnCapture(policy: CapturePolicy): TurnCapture {
  interface Call { tool: string; classification: CallClassification; carrier: boolean; excluded: boolean; children: boolean; nativeStep?: number; finalRole?: string; overlapping: boolean }
  interface State {
    turn: number; scope: string; startedAt: number; startSeq: number; task: string; summary: string; summaryEvidence?: string
    steps: ExperienceStep[]; calls: Map<string, Call>; roots: Map<string, Call>; subcalls: Map<string, Call>; settled: Set<string>; evidence: Set<string>
    complete: boolean; recalledSkills: Map<string, { id: string; version: number }>
  }
  const states = new Map<string, State>()
  const describe = (tool: string, args: unknown): Call => ({ tool, classification: classifyCall(tool, args, policy.maxTextLength), carrier: policy.transportTools.includes(tool), excluded: policy.excludedTools.includes(tool), children: false, overlapping: false })
  const mayChange = (call: Call): boolean => !call.excluded && call.tool !== 'read' && !['check', 'readback'].includes(call.finalRole ?? call.classification.role)
  const mayVerify = (call: Call): boolean => call.tool === 'read' || call.classification.role === 'check' || call.classification.namedVerifier
  const accept: TurnCapture['accept'] = (session, event) => {
    if (event.type === 'turn/start') {
      states.set(session.id, { turn: event.data.turn, scope: memoryScopeKey(sessionScope(session)), startedAt: event.time, startSeq: event.seq, task: '', summary: '', steps: [], calls: new Map(), roots: new Map(), subcalls: new Map(), settled: new Set(), evidence: new Set(), complete: true, recalledSkills: new Map() })
      return undefined
    }
    const state = states.get(session.id)
    if (!state) return undefined
    const { steps, calls, evidence } = state
    const eventId = `session:${session.id}:event:${event.seq}`
    const cite = (): void => { evidence.add(eventId) }
    const appendResult = (callId: string, call: Call, content: readonly ContentBlock[], isError: boolean, meta?: JsonValue, errorCode?: string): void => {
      if (call.excluded) return
      const text = visible(content)
      const outcome = resultEvidence(call.tool, call.classification, text, meta, isError, errorCode)
      call.finalRole = outcome.role
      // Successful carriers contribute their nested tool results, never the same work twice.
      if (call.carrier && call.children && outcome.execution === 'completed') return
      if (steps.length >= policy.maxSteps) { state.complete = false; return }
      const limit = Math.min(policy.maxObservationLength, policy.maxTextLength)
      const whole = text || `Tool returned ${content.map(block => block.type).join(', ') || 'no visible'} content`
      const targetComplete = outcome.target === undefined || outcome.target.length <= policy.maxTextLength
      // Native results are committed in model order, not necessarily execution order.
      const parallelMutation = call.nativeStep !== undefined && [...state.roots.values()].some(sibling => sibling !== call && sibling.nativeStep === call.nativeStep && mayChange(sibling))
      const orderingComplete = !['check', 'readback'].includes(outcome.role) || !call.overlapping && !parallelMutation
      const intact = outcome.complete && orderingComplete && targetComplete && content.every(block => block.type === 'text') && text.trim().length > 0
      const complete = intact && whole.length <= limit
      const clippedReadback = intact && whole.length > limit && outcome.role === 'readback' && outcome.execution === 'completed' && intactReadback(meta, text)
      if (!complete && !clippedReadback) state.complete = false
      // Locally clipped readbacks preserve the execution trace, but cannot verify any requirement.
      const observation = whole.length > limit ? whole.slice(-limit) : whole
      steps.push({ tool: call.tool, action: `Invoke ${call.tool}`, observation,
        evidence: { id: eventId, seq: event.seq, at: event.time, callId, ...outcome, complete, target: targetComplete ? outcome.target : undefined } })
      cite()
    }
    switch (event.type) {
      case 'user/message':
        if (event.data.source.kind === 'user') {
          const text = visible(event.data.content)
          if (event.data.content.some(block => block.type !== 'text')) state.complete = false
          if (text.trim()) {
            const combined = `${state.task}\n${text}`.trim()
            if (combined.length > policy.maxTextLength) state.complete = false
            state.task = combined.slice(0, policy.maxTextLength)
            cite()
          }
        }
        break
      case 'assistant/message':
        if (!event.data.interrupted) {
          const text = visible(event.data.message.content)
          if (text) {
            state.summary = text.slice(0, policy.maxTextLength)
            if (state.summaryEvidence) evidence.delete(state.summaryEvidence)
            state.summaryEvidence = `session:${session.id}:event:${event.seq}`
            cite()
          }
        }
        break
      case 'tool/call':
        if (event.data.turn !== state.turn) break
        if (state.roots.has(event.data.callId)) break
        if (state.roots.size >= policy.maxSteps || calls.size >= policy.maxSteps) { state.complete = false; break }
        { const call = describe(event.data.name, event.data.arguments); call.nativeStep = event.data.step; calls.set(event.data.callId, call); state.roots.set(event.data.callId, call) }
        break
      case 'tool/result': {
        if (event.data.turn !== state.turn) break
        const result = event.data.message
        if (state.settled.has(result.toolCallId)) break
        const call = calls.get(result.toolCallId)
        calls.delete(result.toolCallId)
        if (!call) { state.complete = false; break }
        state.settled.add(result.toolCallId)
        appendResult(result.toolCallId, call, result.content, result.isError === true, event.data.meta, event.data.error?.code)
        break
      }
      case 'tool/ptc-dispatch-start': {
        const data = event.data, root = state.roots.get(data.rootCallId)
        if (!root || state.settled.has(data.subCallId) || state.subcalls.has(data.subCallId)) break
        root.children = true
        const parent = calls.get(data.parentCallId) ?? state.subcalls.get(data.parentCallId)
        if (!parent) { state.complete = false; break }
        parent.children = true
        if (state.subcalls.size + steps.length >= policy.maxSteps) { state.complete = false; break }
        { const call = describe(data.name, data.arguments)
          for (const pending of state.subcalls.values()) {
            if (pending.carrier) continue
            if (mayVerify(call) && mayChange(pending)) call.overlapping = true
            if (mayChange(call) && mayVerify(pending)) pending.overlapping = true
          }
          state.subcalls.set(data.subCallId, call) }
        break
      }
      case 'tool/ptc-dispatch': {
        const data = event.data
        if (!state.roots.has(data.rootCallId) || state.settled.has(data.subCallId)) break
        const call = state.subcalls.get(data.subCallId)
        state.subcalls.delete(data.subCallId)
        if (!call || call.tool !== data.name) { state.complete = false; break }
        state.settled.add(data.subCallId)
        appendResult(data.subCallId, call, data.content, data.isError, data.meta, data.error?.code)
        break
      }
      case 'turn/end': {
        states.delete(session.id)
        if (event.data.turn !== state.turn || !state.task) return undefined
        cite()
        return {
          id: `${session.id}:turn:${state.turn}`, scope: memoryScopeKey(sessionScope(session)),
          sessionId: session.id, task: state.task, summary: state.summary || state.task, steps,
          outcome: { status: 'unknown', source: 'unknown', reason: `Harness turn ended: ${event.data.reason.kind}`, evidence: [] },
          environment: policy.environment, evidence: [...evidence], startedAt: state.startedAt, completedAt: event.time,
          capture: { complete: state.complete && calls.size === 0 && state.subcalls.size === 0, end: event.data.reason.kind === 'completed' ? 'completed' : 'incomplete' },
          recalledSkills: [...state.recalledSkills.values()],
          taskContext: { id: session.id, revision: state.turn, kind: 'initial', latestRequest: state.task, currentEvidenceStartSeq: state.startSeq },
        }
      }
    }
    return undefined
  }
  return { accept,
    rememberRecall(sessionId, turn, skills) {
      const state = states.get(sessionId)
      if (!state || state.turn !== turn) return
      for (const skill of skills) {
        if (!skill.id || !Number.isSafeInteger(skill.version) || skill.version < 1) continue
        const key = skill.id
        if (state.recalledSkills.size < policy.maxSteps || state.recalledSkills.has(key)) state.recalledSkills.set(key, { id: skill.id, version: skill.version })
      }
    }, invalidate: sessionId => { states.delete(sessionId) }, clear: () => { states.clear() },
    invalidateScope: scope => { for (const [id, state] of states) if (state.scope === scope) states.delete(id) } }
}
