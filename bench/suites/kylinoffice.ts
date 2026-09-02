/**
 * KylinMem Integrated v7.0 — office workflows stitched from OfficeBench and
 * OdysseyBench.
 *
 * One JSON per task: a multi-app office workflow, the chat sessions it is meant
 * to draw on, and an injected set of "memory chains" claiming which past
 * utterances each subtask depends on. It is the office domain the other suites
 * here do not cover, which is what makes it worth wiring up.
 *
 * It is also the only suite that scores against **two** sets of labels, because
 * the published ones do not survive inspection. See {@link Grounding}.
 *
 * @module dsh-advanced-mem-plugin/bench/suites/kylinoffice
 */

import { readFile } from 'node:fs/promises'
import { readdir } from 'node:fs/promises'
import { extname, join } from 'node:path'
import type { BenchCorpus, BenchDocument, BenchSuite, BenchTask } from './types.ts'

/** One chat session as the file records it. */
interface OfficeSession {
  readonly session: string
  readonly date: string
  readonly user_requests: readonly string[]
}

/** One injected dependency claim. */
interface MemoryChain {
  readonly subtask_index: number
  readonly subtask: string
  readonly related_memories: readonly { date: string; speaker: string; text: string }[]
}

/** One task file. */
interface OfficeTask {
  readonly task_id: string
  readonly username: string
  readonly date: string
  readonly subtasks: readonly string[]
  readonly chat_sessions_info?: { sessions?: readonly OfficeSession[] }
  readonly memory_dependency?: { memory_chains?: readonly MemoryChain[] }
}

/**
 * Which set of labels a run is scored against.
 *
 * `declared` takes the file's `memory_chains` at face value. `grounded` ignores
 * them and labels each subtask with the utterances in the chat history that name
 * the same artefact — the header the subtask creates, or the file it edits.
 *
 * Both exist because the published labels do not describe this data. Across
 * KYLIN-0001 not one of the ten cited memories appears anywhere in the chat
 * history the file also ships, and the cited text is about averaging midterm
 * scores in `score.xlsx` while the subtasks are about class rosters, company
 * budgets and a shopping list — a token overlap of 0.04 to 0.10, all of it
 * stopwords. Meanwhile the history does contain the real antecedents ("can you
 * add a new header 'Class' to the class member excel file?"), unlabelled.
 *
 * `grounded` labels by artefact name, which is lexical, and this harness ranks
 * lexically — so treat its absolute score as a wiring check rather than as a
 * measurement. What is not circular is the comparison: the same retriever on
 * the same corpus, scored once against labels that point at the history and
 * once against labels that point away from it.
 */
export type Grounding = 'declared' | 'grounded'

/** The artefact a subtask names: a quoted header, or a bare `header X` mention. */
const ARTEFACT = /(?:new header(?: named)?|header)\s+'([^']+)'|(?:new header(?: named)?|header)\s+([A-Z][\w ]*?)(?:,|\s+in\b|\s+to\b|$)/

/**
 * The header name a subtask is about, lowercased.
 * @param subtask - the subtask text.
 * @returns the artefact name, or `undefined` when the subtask names none.
 */
export function artefactOf(subtask: string): string | undefined {
  const match = ARTEFACT.exec(subtask)
  const name = match?.[1] ?? match?.[2]
  return name === undefined ? undefined : name.trim().toLowerCase()
}

/** Read a date the file writes as `2020-04-26`. */
function stampOf(date: string): number | undefined {
  const parsed = Date.parse(`${date}T00:00:00Z`)
  return Number.isNaN(parsed) ? undefined : parsed
}

/**
 * Turn one task file into a corpus.
 *
 * The chat history and the cited memories both become documents. Citing them is
 * not an endorsement: the memories claim a date inside the history's range, so
 * a system asked to retrieve them must at least be able to see them. Leaving
 * them out would make `declared` score zero for a reason that says nothing
 * about retrieval.
 * @param task - the parsed task file.
 * @param grounding - which labels to score against.
 * @returns the corpus, or `undefined` when no subtask ends up scoreable.
 */
export function corpusOf(task: OfficeTask, grounding: Grounding): BenchCorpus | undefined {
  const documents: BenchDocument[] = []
  const seen = new Set<string>()
  const push = (id: string, text: string, session: string, turn: number, at?: number): void => {
    if (seen.has(text)) return
    seen.add(text)
    documents.push({ id, text, kind: 'user-message', session, turn, ...(at === undefined ? {} : { at }) })
  }

  const sessions = task.chat_sessions_info?.sessions ?? []
  for (const [index, session] of sessions.entries()) {
    for (const [position, utterance] of session.user_requests.entries()) {
      push(`${session.session}@${session.date}#${position}`, utterance, `${session.session}@${session.date}`, index + 1, stampOf(session.date))
    }
  }
  const chains = task.memory_dependency?.memory_chains ?? []
  for (const chain of chains) {
    for (const memory of chain.related_memories) {
      // The cited text is dated but not placed in any session, so it becomes its
      // own one-document session rather than being attributed to a real one.
      push(`cited@${memory.date}#${memory.text.slice(0, 24)}`, memory.text, `cited@${memory.date}`, sessions.length + 1, stampOf(memory.date))
    }
  }
  const byText = new Map(documents.map(document => [document.text, document.id]))

  const tasks: BenchTask[] = []
  for (const [index, subtask] of task.subtasks.entries()) {
    const gold = grounding === 'declared'
      ? (chains.find(chain => chain.subtask_index === index)?.related_memories ?? [])
        .map(memory => byText.get(memory.text))
        .filter((id): id is string => id !== undefined)
      : groundedGold(subtask, documents)
    if (gold.length === 0) continue
    tasks.push({
      id: `${task.task_id}_s${index + 1}`,
      group: grounding,
      query: subtask,
      gold,
      ...(stampOf(task.date) === undefined ? {} : { at: stampOf(task.date) as number }),
    })
  }
  return tasks.length === 0 ? undefined : { id: task.task_id, documents, tasks }
}

/** Utterances that name the artefact a subtask is about. */
function groundedGold(subtask: string, documents: readonly BenchDocument[]): string[] {
  const artefact = artefactOf(subtask)
  if (artefact === undefined) return []
  return documents
    .filter(document => document.text.toLowerCase().includes(artefact))
    .map(document => document.id)
}

/** Build the suite for one grounding. */
function suite(grounding: Grounding): BenchSuite {
  return {
    name: `kylinoffice-${grounding}`,
    describe: grounding === 'declared'
      ? 'office workflows, scored against the file\'s own injected memory_chains'
      : 'office workflows, scored against the chat utterances that name the same artefact',
    async load(path: string, limit: number): Promise<BenchCorpus[]> {
      const files = extname(path) === '.json'
        ? [path]
        : (await readdir(path)).filter(name => extname(name) === '.json').sort().map(name => join(path, name))
      const corpora: BenchCorpus[] = []
      for (const file of files) {
        const parsed = JSON.parse(await readFile(file, 'utf8')) as OfficeTask
        const corpus = corpusOf(parsed, grounding)
        if (corpus !== undefined) corpora.push(corpus)
        if (limit > 0 && corpora.length >= limit) break
      }
      return corpora
    },
  }
}

/** Scored against the file's published memory chains. */
export const kylinofficeDeclared: BenchSuite = suite('declared')

/** Scored against the utterances that actually mention the subtask's artefact. */
export const kylinofficeGrounded: BenchSuite = suite('grounded')
