/**
 * LongMemEval — long-term memory for chat assistants (Wu et al., ICLR 2025).
 *
 * 500 questions, each with its own haystack of roughly 40–65 chat sessions, of
 * which one or two carry the answer. The dataset labels evidence at *turn*
 * level (`has_answer`), which is finer than the session-level retrieval the
 * paper reports and makes it the strictest of the three suites here.
 *
 * Its six question types are the reason it is worth running against this system
 * in particular: `knowledge-update` asks which of two contradicting statements
 * is current, and `temporal-reasoning` asks when something held — the two things
 * a memory graph with supersession and decay claims to be for.
 *
 * Source: https://huggingface.co/datasets/xiaowu0162/longmemeval (`longmemeval_s`).
 *
 * @module dsh-advanced-mem-plugin/bench/suites/longmemeval
 */

import { readFile } from 'node:fs/promises'
import type { BenchCorpus, BenchDocument, BenchSuite, BenchTask } from './types.ts'

/** One question with its haystack, as the file stores it. */
interface LongMemEvalRow {
  readonly question_id: string
  readonly question_type: string
  readonly question: string
  readonly question_date: string
  readonly answer: string
  readonly haystack_dates: readonly string[]
  readonly haystack_session_ids: readonly string[]
  readonly haystack_sessions: readonly (readonly { role: string; content: string; has_answer?: string }[])[]
  readonly answer_session_ids: readonly string[]
}

const DATE = /^(\d{4})\/(\d{2})\/(\d{2})[^\d]*(\d{2}):(\d{2})/

/**
 * Parse the dataset's `2023/05/20 (Sat) 02:21` stamps.
 * @param value - the stamp.
 * @returns epoch milliseconds, or `undefined` when the stamp is unreadable.
 */
export function parseStamp(value: string | undefined): number | undefined {
  const match = value === undefined ? null : DATE.exec(value)
  if (match === null) return undefined
  const [, year, month, day, hour, minute] = match
  return Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute))
}

/**
 * Turn one row into a corpus.
 *
 * Roles map straight through: a user turn is a `user-message` and an assistant
 * turn is an `assistant-message`. That second mapping is not cosmetic — an
 * assistant message is `evidence` by author, so the 56 `single-session-assistant`
 * questions are asking for material the shipped configuration will not quote.
 * Leaving the mapping honest is what lets `--include-evidence` price that.
 * @param row - one dataset row.
 * @returns the corpus, or `undefined` when the row labels no evidence at all.
 */
export function corpusOf(row: LongMemEvalRow): BenchCorpus | undefined {
  const documents: BenchDocument[] = []
  const flagged: string[] = []
  const inAnswerSession: string[] = []
  const answerSessions = new Set(row.answer_session_ids)
  for (const [index, session] of row.haystack_sessions.entries()) {
    const sessionId = row.haystack_session_ids[index] ?? `s${index}`
    const at = parseStamp(row.haystack_dates[index])
    for (const [position, turn] of session.entries()) {
      const id = `${sessionId}:${position}`
      documents.push({
        id,
        text: turn.content,
        kind: turn.role === 'assistant' ? 'assistant-message' : 'user-message',
        session: sessionId,
        turn: index + 1,
        ...(at === undefined ? {} : { at }),
      })
      if (turn.has_answer === 'True' || turn.has_answer === 'true') flagged.push(id)
      if (answerSessions.has(sessionId)) inAnswerSession.push(id)
    }
  }
  // Turn-level labels where the dataset gives them, the evidence session as a
  // whole where it does not. Abstention questions label neither, and are dropped
  // rather than scored as failures: with no evidence, no retrieval can succeed.
  const gold = flagged.length > 0 ? flagged : inAnswerSession
  if (gold.length === 0) return undefined
  const task: BenchTask = {
    id: row.question_id,
    group: row.question_type,
    query: row.question,
    gold,
    ...(parseStamp(row.question_date) === undefined ? {} : { at: parseStamp(row.question_date) as number }),
  }
  return { id: row.question_id, documents, tasks: [task] }
}

/** The LongMemEval-S suite. */
export const longmemeval: BenchSuite = {
  name: 'longmemeval',
  describe: '500 assistant-chat questions over per-question haystacks of ~50 sessions; turn-level evidence labels',
  async load(path: string, limit: number): Promise<BenchCorpus[]> {
    const rows = JSON.parse(await readFile(path, 'utf8')) as LongMemEvalRow[]
    const wanted = limit <= 0 ? rows : rows.slice(0, limit)
    const corpora: BenchCorpus[] = []
    for (const row of wanted) {
      const corpus = corpusOf(row)
      if (corpus !== undefined) corpora.push(corpus)
    }
    return corpora
  },
}
