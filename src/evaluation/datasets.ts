import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import type { EvaluationCase, EvaluationDataset, HistoryMessage } from './types.ts'

export function fingerprint(value: unknown): string {
  const canonical = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(canonical)
    if (item !== null && typeof item === 'object') return Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)).map(([key, val]) => [key, canonical(val)]))
    return item
  }
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex')
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`${label}: expected an object`)
  return value as Record<string, unknown>
}
function array(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label}: expected an array`)
  return value
}
function string(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new Error(`${label}: expected a string`)
  return value
}
function strings(value: unknown, label: string): string[] { return array(value, label).map((v, i) => string(v, `${label}[${i}]`)) }
function answer(value: unknown, label: string): string {
  if (typeof value === 'string') return value
  if (typeof value === 'number') return String(value)
  if (Array.isArray(value) && value.every(v => typeof v === 'string' || typeof v === 'number')) return value.join(', ')
  throw new Error(`${label}: expected text, number, or an answer list`)
}

/** Dataset timestamps have no timezone. Interpret them as UTC for reproducibility. */
export function parseLongMemEvalDate(value: unknown): number {
  const text = string(value, 'LongMemEval date')
  const match = /^(\d{4})\/(\d{2})\/(\d{2})\s+(?:\([^)]*\)\s*)?(\d{2}):(\d{2})\)?$/.exec(text)
    ?? /^(\d{4})\/(\d{2})\/(\d{2})\s+\((\d{2}):(\d{2})\)$/.exec(text)
  if (!match) throw new Error(`Unrecognized LongMemEval date: ${text}`)
  const [, y, m, d, h, min] = match
  const result = Date.UTC(Number(y), Number(m) - 1, Number(d), Number(h), Number(min))
  const date = new Date(result)
  if (date.getUTCFullYear() !== Number(y) || date.getUTCMonth() !== Number(m) - 1 || date.getUTCDate() !== Number(d) || Number(h) > 23 || Number(min) > 59) throw new Error(`Invalid LongMemEval date: ${text}`)
  return result
}

export interface DatasetOptions { readonly revision: string; readonly source: string }

function dataset(name: string, raw: unknown, options: DatasetOptions, cases: EvaluationCase[]): EvaluationDataset {
  const ids = new Set<string>()
  for (const sample of cases) {
    if (ids.has(sample.input.id)) throw new Error(`Duplicate evaluation case: ${sample.input.id}`)
    ids.add(sample.input.id)
  }
  return { name, ...options, fingerprint: fingerprint(raw), cases }
}

/** Read the official oracle/S/M JSON, retaining every abstention question. */
export async function loadLongMemEval(path: string, options: DatasetOptions): Promise<EvaluationDataset> {
  const raw: unknown = JSON.parse(await readFile(path, 'utf8'))
  const cases = array(raw, 'LongMemEval').map((value, index): EvaluationCase => {
    const row = object(value, `LongMemEval[${index}]`)
    const id = string(row.question_id, 'question_id')
    const sessionIds = strings(row.haystack_session_ids, `${id}.haystack_session_ids`)
    const dates = array(row.haystack_dates, `${id}.haystack_dates`)
    const sessions = array(row.haystack_sessions, `${id}.haystack_sessions`)
    if (new Set(sessionIds).size !== sessionIds.length || sessionIds.length !== dates.length || dates.length !== sessions.length) throw new Error(`${id}: misaligned or duplicated history sessions`)
    const history: HistoryMessage[] = []
    const evidence: string[] = []
    const evidenceSessions = strings(row.answer_session_ids, `${id}.answer_session_ids`)
    for (const evidenceId of evidenceSessions) if (!sessionIds.includes(evidenceId)) throw new Error(`${id}: unknown evidence session ${evidenceId}`)
    sessions.forEach((session, si) => {
      const sessionId = sessionIds[si]!
      const at = parseLongMemEvalDate(dates[si])
      array(session, `${id}.${sessionId}`).forEach((turn, ti) => {
        const entry = object(turn, `${id}.${sessionId}[${ti}]`)
        if (entry.role !== 'user' && entry.role !== 'assistant') throw new Error(`${id}: unsupported role ${String(entry.role)}`)
        const messageId = `${sessionId}:${ti}`
        // Construct explicitly: annotations, reference answers, and gold IDs never enter history.
        history.push({ id: messageId, sessionId, role: entry.role, text: string(entry.content, 'content'), at })
        if (entry.has_answer === true || entry.has_answer === 'True' || entry.has_answer === 'true') evidence.push(messageId)
      })
    })
    history.sort((a, b) => a.at - b.at)
    const at = parseLongMemEvalDate(row.question_date)
    return { input: { id, question: string(row.question, 'question'), at }, group: string(row.question_type, 'question_type'), history,
      reference: answer(row.answer, 'answer'), abstention: id.includes('_abs'), evidenceMessageIds: evidence, evidenceSessionIds: evidenceSessions }
  })
  return dataset('longmemeval', raw, options, cases)
}

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december']
function locomoDate(value: unknown): number {
  const text = string(value, 'LoCoMo date')
  const match = /^(\d{1,2}):(\d{2})\s*(am|pm)\s+on\s+(\d{1,2})\s+(\w+),?\s+(\d{4})$/i.exec(text)
  if (!match) throw new Error(`Unrecognized LoCoMo date: ${text}`)
  const [, hour, minute, period, day, month, year] = match
  const mi = MONTHS.indexOf(month!.toLowerCase())
  if (mi < 0 || Number(hour) < 1 || Number(hour) > 12 || Number(minute) > 59) throw new Error(`Invalid LoCoMo date: ${text}`)
  const at = Date.UTC(Number(year), mi, Number(day), Number(hour) % 12 + (period!.toLowerCase() === 'pm' ? 12 : 0), Number(minute))
  if (new Date(at).getUTCDate() !== Number(day)) throw new Error(`Invalid LoCoMo date: ${text}`)
  return at
}

/** Read the official locomo10.json; both dialogue speakers are people. */
export async function loadLoCoMo(path: string, options: DatasetOptions): Promise<EvaluationDataset> {
  const raw: unknown = JSON.parse(await readFile(path, 'utf8'))
  const groups: Record<number, string> = { 1: 'multi-hop', 2: 'temporal', 3: 'open-domain', 4: 'single-hop', 5: 'adversarial' }
  const cases: EvaluationCase[] = []
  array(raw, 'LoCoMo').forEach((value, index) => {
    const row = object(value, `LoCoMo[${index}]`)
    const id = string(row.sample_id, 'sample_id')
    const conversation = object(row.conversation, 'conversation')
    const history: HistoryMessage[] = []
    for (const key of Object.keys(conversation).filter(key => /^session_\d+$/.test(key)).sort((a, b) => Number(a.slice(8)) - Number(b.slice(8)))) {
      const at = locomoDate(conversation[`${key}_date_time`])
      for (const value of array(conversation[key], key)) {
        const turn = object(value, key)
        const caption = typeof turn.blip_caption === 'string' ? ` [photo caption: ${turn.blip_caption}]` : ''
        history.push({ id: string(turn.dia_id, 'dia_id'), sessionId: key, role: 'user', at,
          text: `${string(turn.speaker, 'speaker')}: ${string(turn.text, 'text')}${caption}` })
      }
    }
    if (!history.length || new Set(history.map(turn => turn.id)).size !== history.length) throw new Error(`${id}: empty history or duplicate dialogue IDs`)
    history.sort((a, b) => a.at - b.at)
    array(row.qa, 'qa').forEach((value, qi) => {
      const qa = object(value, 'qa')
      const category = Number(qa.category)
      if (!(category in groups)) throw new Error(`${id}: unknown category`)
      const abstention = category === 5
      // adversarial_answer is a deliberately wrong answer, never the reference.
      const reference = abstention ? 'The conversation does not provide enough information to answer this question.' : answer(qa.answer, 'answer')
      const evidence = strings(qa.evidence, 'evidence')
      cases.push({ input: { id: `${id}_q${qi}`, question: string(qa.question, 'question'), at: history[history.length - 1]!.at },
        group: groups[category]!, history, reference, abstention, evidenceMessageIds: evidence,
        evidenceSessionIds: [...new Set(history.filter(turn => evidence.includes(turn.id)).map(turn => turn.sessionId))] })
    })
  })
  return dataset('locomo', raw, options, cases)
}
