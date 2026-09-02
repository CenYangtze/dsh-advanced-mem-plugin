/**
 * PerLTQA — personal long-term memory (Du et al., SIGHAN 2024).
 *
 * A memory bank per persona rather than a transcript: a profile, the people
 * around them, the events they lived, and the conversations those produced. The
 * questions name the memory entry that answers them, which makes this the only
 * one of the three suites whose ground truth is a *structured* memory item
 * rather than a line of dialogue — and therefore the closest to what this
 * system's layer-1 graph is shaped like.
 *
 * It also covers a domain the other two do not: the four memory categories map
 * almost one to one onto node types this system already has (`person`,
 * `entity`, `preference`), and the dataset ships parallel Chinese and English
 * versions, so a run says something about both.
 *
 * Source: https://github.com/Elvin-Yiming-Du/PerLTQA (`Dataset/en/*.json`).
 *
 * @module dsh-advanced-mem-plugin/bench/suites/perltqa
 */

import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { BenchCorpus, BenchDocument, BenchSuite, BenchTask } from './types.ts'

/** One question as the file states it. */
interface PerltQuestion {
  readonly Question: string
  readonly Answer?: string
  readonly 'Reference Memory'?: string
}

/**
 * One category of questions, in either shape the dataset uses.
 *
 * The profile category is always a list of questions. The other three are a
 * list of single-key wrappers in the English files and a plain map in the
 * Chinese ones — the same data, published two ways. Either way the key is the
 * memory id being asked about, which is the retrieval ground truth.
 */
type PerltCategory =
  | readonly (PerltQuestion | Record<string, readonly PerltQuestion[]>)[]
  | Record<string, readonly PerltQuestion[]>

/** The memory bank entry for one persona. */
interface PerltMemory {
  readonly profile: Record<string, unknown>
  readonly profile_description?: string
  readonly social_relationship?: Record<string, Record<string, unknown>>
  readonly events?: Record<string, Record<string, unknown>>
  readonly dialogues?: Record<string, { contents?: Record<string, readonly string[]> }>
}

/** Render an object the dataset stores as a bag of labelled fields. */
function describe(value: Record<string, unknown>): string {
  return Object.entries(value)
    .filter(([, field]) => typeof field === 'string' || typeof field === 'number')
    .map(([key, field]) => `${key}: ${String(field)}`)
    .join('; ')
}

/**
 * Turn one persona's memory bank into documents.
 *
 * Every entry keeps the dataset's own id, because that id *is* the retrieval
 * ground truth. Profile fields are their own documents rather than one profile
 * blob for the same reason: the questions cite a single field.
 * @param memory - the persona's memory bank.
 * @returns one document per addressable memory entry.
 */
export function documentsOf(memory: PerltMemory): BenchDocument[] {
  const documents: BenchDocument[] = []
  const protagonist = String(memory.profile['Protagonist'] ?? 'the user')
  for (const [field, value] of Object.entries(memory.profile)) {
    if (typeof value !== 'string' && typeof value !== 'number') continue
    documents.push({
      id: field,
      text: `${protagonist} — ${field}: ${String(value)}`,
      kind: 'note',
      session: 'profile',
      turn: 1,
    })
  }
  for (const [id, entry] of Object.entries(memory.social_relationship ?? {})) {
    documents.push({ id, text: `${protagonist} — ${describe(entry)}`, kind: 'note', session: 'social', turn: 1 })
  }
  for (const [id, entry] of Object.entries(memory.events ?? {})) {
    documents.push({ id, text: describe(entry), kind: 'note', session: 'events', turn: 1 })
  }
  for (const [id, entry] of Object.entries(memory.dialogues ?? {})) {
    const lines = Object.entries(entry.contents ?? {})
      .flatMap(([stamp, turns]) => turns.map(line => `[${stamp}] ${line}`))
    // One document per dialogue, because that is the unit the questions cite;
    // it holds the persona's own words, so it stays quotable material.
    documents.push({ id, text: lines.join('\n'), kind: 'user-message', session: 'dialogues', turn: 1 })
  }
  return documents
}

/**
 * Turn one persona's question set into tasks.
 * @param persona - the persona's name, for task ids.
 * @param categories - the question set, by category.
 * @returns the tasks, each citing the memory entry that answers it.
 */
export function tasksOf(persona: string, categories: Record<string, PerltCategory>): BenchTask[] {
  const tasks: BenchTask[] = []
  const push = (group: string, gold: string, question: PerltQuestion): void => {
    if (gold.length === 0 || question.Question === undefined) return
    tasks.push({ id: `${persona}_${group}_${gold}_${tasks.length}`, group, query: question.Question, gold: [gold] })
  }
  const keyed = (wrapper: Record<string, readonly PerltQuestion[]>, group: string): void => {
    for (const [memoryId, questions] of Object.entries(wrapper)) {
      if (!Array.isArray(questions)) continue
      for (const question of questions) push(group, memoryId, question)
    }
  }
  for (const [group, entry] of Object.entries(categories)) {
    if (!Array.isArray(entry)) {
      // The Chinese files publish the keyed categories as a plain map.
      keyed(entry as Record<string, readonly PerltQuestion[]>, group)
      continue
    }
    for (const item of entry) {
      if (typeof (item as PerltQuestion).Question === 'string') {
        // The profile category asks directly and names its memory field.
        const question = item as PerltQuestion
        push(group, question['Reference Memory'] ?? '', question)
        continue
      }
      keyed(item as Record<string, readonly PerltQuestion[]>, group)
    }
  }
  return tasks
}

/** The PerLTQA suite; `path` is the QA file, and the memory bank is found beside it. */
export const perltqa: BenchSuite = {
  name: 'perltqa',
  describe: '141 personas with profile, relationship, event and dialogue memories; questions cite the entry that answers them',
  async load(path: string, limit: number): Promise<BenchCorpus[]> {
    const questionFile = JSON.parse(await readFile(path, 'utf8')) as Record<string, Record<string, PerltCategory>>[]
    const bankPath = path.includes('perltqa')
      ? path.replace('perltqa_en', 'perltmem_en').replace('perltqa.json', 'perltmem.json')
      : join(dirname(path), 'perltmem_en.json')
    const bank = JSON.parse(await readFile(bankPath, 'utf8')) as PerltMemory[]
    const byPersona = new Map<string, PerltMemory>()
    for (const memory of bank) byPersona.set(String(memory.profile['Protagonist'] ?? ''), memory)

    const corpora: BenchCorpus[] = []
    for (const entry of questionFile) {
      for (const [persona, categories] of Object.entries(entry)) {
        const memory = byPersona.get(persona)
        if (memory === undefined) continue
        const documents = documentsOf(memory)
        const known = new Set(documents.map(document => document.id))
        // A question citing an entry the bank does not hold is unanswerable by
        // retrieval; dropping it keeps the denominator honest.
        const tasks = tasksOf(persona, categories).filter(task => task.gold.every(id => known.has(id)))
        if (tasks.length > 0) corpora.push({ id: persona, documents, tasks })
        if (limit > 0 && corpora.length >= limit) return corpora
      }
    }
    return corpora
  },
}
