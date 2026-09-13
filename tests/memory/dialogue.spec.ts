/**
 * Recall over a *conversation* rather than a pile of notes: replies that only
 * make sense with their question, corrections that override what came before,
 * and requests with several parts that each deserve an answer.
 */
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import MemoryRuntime from '../../src/memory/index.ts'
import type { Config, MemoryRecordKind, MemoryScope } from '../../src/memory/index.ts'
import { isCorrection, splitCue } from '../../src/memory/scoring.ts'
import { FakeMemoryStore } from './helpers/fake-store.ts'

const HOUR = 3600_000

const config: Config = {
  recallLimit: 10,
  profileLimit: 10,
  inferredConfidence: 0.4,
  assertedConfidence: 0.9,
  inferredHalfLifeMs: 30 * 24 * HOUR,
  assertedHalfLifeMs: 0,
  reinforcementRate: 0.3,
  contradictionRate: 0.5,
  retirementFloor: 0.1,
  activationHops: 2,
  activationFalloff: 0.5,
  recordBudget: 100,
  supportWeight: 0,
  duplicateThreshold: 1,
  diversityThreshold: 1,
  vectorWeight: 1,
}

const scope: MemoryScope = { kind: 'workspace', workspace: '/office' }

function harness() {
  const ctx = new Context()
  const runtime = new MemoryRuntime(ctx, config)
  runtime.registerStore(new FakeMemoryStore())
  return runtime
}

/** Write one dated turn of a session. */
function turn(runtime: MemoryRuntime, session: string, index: number, kind: MemoryRecordKind, text: string, at: number) {
  return runtime.remember({
    scope, kind, text, fidelity: 'verbatim', at,
    provenance: { sessionId: SessionId(session), turn: index },
  })
}

describe('a reply travels with its question', () => {
  it('anchors a short user reply to the assistant question before it', async () => {
    const runtime = harness()
    await turn(runtime, 's-08', 1, 'user-message', 'Quick update on the group.', 1000)
    await turn(runtime, 's-08', 2, 'assistant-message', 'So values run 1 to 3 from now on?', 2000)
    await turn(runtime, 's-08', 3, 'user-message', '1 to 3, yes. Drop the old split entirely.', 3000)
    const recall = await runtime.recall({ text: 'the grouping split values', scopes: [scope], now: 4000 })
    const reply = recall.cues.find(cue => cue.kind === 'record' && cue.record.text.startsWith('1 to 3'))
    expect(reply?.kind).toBe('record')
    if (reply?.kind !== 'record') return
    expect(reply.anchor?.text).toBe('So values run 1 to 3 from now on?')
    // The question itself is still evidence-use and never a cue of its own.
    expect(recall.cues.some(cue => cue.kind === 'record' && cue.record.text.startsWith('So values'))).toBe(false)
  })

  it('attaches the assistant confirmation the user let stand, and not one the user corrected', async () => {
    const runtime = harness()
    await turn(runtime, 's-05', 1, 'user-message', 'Switch duration to minutes and rename the header.', 1000)
    await turn(runtime, 's-05', 2, 'assistant-message', "Understood - converting to minutes, header 'Duration (min)'.", 2000)
    await turn(runtime, 's-06', 1, 'user-message', 'Header the group column Category.', 3000)
    await turn(runtime, 's-06', 2, 'assistant-message', "Noted - header 'Category'.", 4000)
    await turn(runtime, 's-06', 3, 'user-message', 'No, that changed - the header has to read Group.', 5000)
    const recall = await runtime.recall({ text: 'duration minutes header group category', scopes: [scope], now: 6000 })
    const byText = new Map(recall.cues.map(cue => [cue.kind === 'record' ? cue.record.text : '', cue]))
    const kept = byText.get('Switch duration to minutes and rename the header.')
    expect(kept?.kind === 'record' && kept.confirmation?.text).toMatch(/converting to minutes/)
    const corrected = byText.get('Header the group column Category.')
    expect(corrected?.kind === 'record' && corrected.confirmation).toBeUndefined()
    // The confirmations themselves never surface as cues.
    expect(recall.cues.some(cue => cue.kind === 'record' && cue.record.kind === 'assistant-message')).toBe(false)
  })

  it('attaches nothing when evidence is being quoted outright', async () => {
    const runtime = harness()
    await turn(runtime, 's-08', 1, 'assistant-message', 'So values run 1 to 3 from now on?', 1000)
    await turn(runtime, 's-08', 2, 'user-message', '1 to 3, yes.', 2000)
    const recall = await runtime.recall({ text: 'values 1 to 3', scopes: [scope], now: 3000, includeEvidence: true })
    const reply = recall.cues.find(cue => cue.kind === 'record' && cue.record.text.startsWith('1 to 3'))
    expect(reply?.kind === 'record' && reply.anchor).toBeUndefined()
    expect(recall.cues.some(cue => cue.kind === 'record' && cue.record.text.startsWith('So values'))).toBe(true)
  })

  it('leaves a self-contained statement unanchored', async () => {
    const runtime = harness()
    await turn(runtime, 's-01', 1, 'assistant-message', 'Anything else for the roster today.', 1000)
    await turn(runtime, 's-01', 2, 'user-message',
      'One standing rule: whatever else we add to this file later, keep Parent Contact as the very last column, always at the far right.', 2000)
    const recall = await runtime.recall({ text: 'parent contact column rule', scopes: [scope], now: 3000 })
    const cue = recall.cues[0]
    expect(cue?.kind).toBe('record')
    if (cue?.kind !== 'record') return
    expect(cue.anchor).toBeUndefined()
  })
})

describe('a correction outranks what it corrected', () => {
  it('links "actually, ..." to the earlier instruction on the same topic and keeps both recallable', async () => {
    const runtime = harness()
    const stale = await turn(runtime, 's-04', 1, 'user-message', 'Track duration as a plain number for now.', 1000)
    await turn(runtime, 's-02', 1, 'user-message', 'Keep Parent Contact as the last column.', 1500)
    const fix = await turn(runtime, 's-05', 1, 'user-message',
      'Actually, switch duration to minutes instead of the raw number, and rename the header to Duration (min).', 2000)
    const stored = [...runtime.store.records([stale.scope])].find(record => record.id === stale.id)
    expect(stored?.supersededBy).toBe(fix.id)
    const recall = await runtime.recall({ text: 'duration plain number', scopes: [scope], now: 3000 })
    const order = recall.cues.map(cue => (cue.kind === 'record' ? cue.record.id : ''))
    // Marked, not hidden: what was said is still on record, and still ranks on
    // relevance — it is the message that holds the numbers the fix acts on.
    expect(order).toContain(stale.id)
    expect(order).toContain(fix.id)
    const staleCue = recall.cues.find(cue => cue.kind === 'record' && cue.record.id === stale.id)
    expect(staleCue?.kind === 'record' && staleCue.record.supersededBy).toBe(fix.id)
  })

  it('does not link a correction that shares no topic with anything', async () => {
    const runtime = harness()
    const other = await turn(runtime, 's-01', 1, 'user-message', 'Keep Parent Contact as the last column.', 1000)
    await turn(runtime, 's-02', 1, 'user-message', 'Actually, flip the rank rule - whoever asked last is top priority.', 2000)
    const stored = [...runtime.store.records([other.scope])].find(record => record.id === other.id)
    expect(stored?.supersededBy).toBeUndefined()
  })

  it('recognises the openers and nothing else', () => {
    expect(isCorrection('Actually, flip the rank rule.')).toBe(true)
    expect(isCorrection('No, use YYYY-MM-DD.')).toBe(true)
    expect(isCorrection('Scratch that, three groups.')).toBe(true)
    expect(isCorrection('Track duration as a plain number.')).toBe(false)
    expect(isCorrection('Nothing changed, keep going.')).toBe(false)
  })
})

describe('a multi-part request is served part by part', () => {
  it('splits numbered lines and ignores a heading too short to carry a topic', () => {
    expect(splitCue('Quick update - 3 things:\n1. Apply the current ranking\n2. Enter the numbers in the units we settled on\n3. Line up the slots'))
      .toEqual(['Apply the current ranking', 'Enter the numbers in the units we settled on', 'Line up the slots'])
    expect(splitCue('one line only')).toEqual([])
  })

  it('returns a record for each part instead of only the part with the most terms', async () => {
    const runtime = harness()
    await turn(runtime, 's-01', 1, 'user-message', 'Everyone gets a meeting slot, ten minutes each, first slot at 8:00.', 1000)
    await turn(runtime, 's-02', 1, 'user-message', 'Track the duration numbers in minutes and rename the header Duration (min).', 2000)
    await turn(runtime, 's-03', 1, 'user-message', 'Rank by whoever asked first, first come first served.', 3000)
    for (let index = 0; index < 8; index += 1) {
      await turn(runtime, 's-09', index + 1, 'user-message',
        `Meeting slot note ${index}: the meeting slot list and the slot times for the meeting.`, 4000 + index)
    }
    const cue = 'Three things:\n1. Apply the current ranking - you know which way it runs now\n2. Enter the numbers in the units we settled on\n3. Line up the meeting slots the same as before'
    const recall = await runtime.recall({ text: cue, scopes: [scope], now: 9000, limit: 4 })
    const texts = recall.cues.map(c => (c.kind === 'record' ? c.record.text : ''))
    expect(texts.some(text => text.startsWith('Rank by'))).toBe(true)
    expect(texts.some(text => text.startsWith('Track the duration'))).toBe(true)
  })
})
