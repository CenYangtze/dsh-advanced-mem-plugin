/**
 * LoCoMo — very long-term conversational memory (Maharana et al., ACL 2024).
 *
 * Ten conversations between two people, averaging 27 sessions and about 20k
 * tokens each, with 1,986 questions annotated by the dialogue turns that answer
 * them. Unlike LongMemEval every question in a conversation shares one corpus,
 * so the same 590-odd turns have to serve two hundred different questions —
 * which is much closer to how a memory actually gets used than a haystack built
 * per question.
 *
 * Both speakers are people here; neither is the agent. So every turn is a
 * `user-message` and the evidence rule never bites, which makes this the one
 * suite whose score is not shaped by the quotable/evidence split.
 *
 * Source: https://github.com/snap-research/locomo (`data/locomo10.json`).
 *
 * @module dsh-advanced-mem-plugin/bench/suites/locomo
 */

import { readFile } from 'node:fs/promises'
import type { BenchCorpus, BenchDocument, BenchSuite, BenchTask } from './types.ts'

/** One dialogue turn as the file stores it. */
interface LocomoTurn {
  readonly speaker: string
  readonly dia_id: string
  readonly text: string
  readonly blip_caption?: string
}

/** One question as the file stores it. */
interface LocomoQa {
  readonly question: string
  readonly answer?: string
  readonly adversarial_answer?: string
  readonly evidence: readonly string[]
  readonly category: number
}

/** One conversation as the file stores it. */
interface LocomoConversation {
  readonly sample_id: string
  readonly conversation: Record<string, unknown>
  readonly qa: readonly LocomoQa[]
}

/**
 * The dataset's numeric categories, named.
 *
 * Taken from the paper's own ordering. `adversarial` questions are the ones
 * whose premise the conversation never supports; they still carry evidence
 * turns, so they score as retrieval like the rest — what they test downstream
 * is whether a model declines to answer, which is not this system's job.
 */
export const CATEGORY: Readonly<Record<number, string>> = {
  1: 'multi-hop',
  2: 'temporal',
  3: 'open-domain',
  4: 'single-hop',
  5: 'adversarial',
}

const SESSION = /^session_(\d+)$/

/**
 * Turn one conversation into a corpus.
 * @param row - one conversation from the file.
 * @returns the corpus with every question attached.
 */
export function corpusOf(row: LocomoConversation): BenchCorpus {
  const documents: BenchDocument[] = []
  const sessions = Object.keys(row.conversation)
    .map(key => ({ key, match: SESSION.exec(key) }))
    .filter((entry): entry is { key: string; match: RegExpExecArray } => entry.match !== null)
    .sort((left, right) => Number(left.match[1]) - Number(right.match[1]))
  for (const { key, match } of sessions) {
    const turns = row.conversation[key]
    if (!Array.isArray(turns)) continue
    const at = stampOf(row.conversation[`${key}_date_time`])
    for (const turn of turns as LocomoTurn[]) {
      // An image in this dataset is present only through its caption; dropping
      // it would silently make some evidence unretrievable by any means.
      const caption = turn.blip_caption === undefined ? '' : ` [shares a photo: ${turn.blip_caption}]`
      documents.push({
        id: turn.dia_id,
        text: `${turn.speaker}: ${turn.text}${caption}`,
        kind: 'user-message',
        session: key,
        turn: Number(match[1]),
        ...(at === undefined ? {} : { at }),
      })
    }
  }
  const tasks: BenchTask[] = row.qa
    .map((qa, index): BenchTask => ({
      id: `${row.sample_id}_q${index}`,
      group: CATEGORY[qa.category] ?? `category-${qa.category}`,
      query: qa.question,
      gold: qa.evidence,
    }))
    .filter(task => task.gold.length > 0)
  return { id: row.sample_id, documents, tasks }
}

/** Read a `1:56 pm on 8 May, 2023` style stamp, which Date parses well enough for ordering. */
function stampOf(value: unknown): number | undefined {
  if (typeof value !== 'string') return undefined
  const parsed = Date.parse(value.replace(' on ', ' '))
  return Number.isNaN(parsed) ? undefined : parsed
}

/** The LoCoMo suite. */
export const locomo: BenchSuite = {
  name: 'locomo',
  describe: '10 conversations of ~27 sessions, 1,986 questions in 5 categories, evidence labelled by dialogue turn',
  async load(path: string, limit: number): Promise<BenchCorpus[]> {
    const rows = JSON.parse(await readFile(path, 'utf8')) as LocomoConversation[]
    const wanted = limit <= 0 ? rows : rows.slice(0, limit)
    return wanted.map(corpusOf).filter(corpus => corpus.tasks.length > 0)
  },
}
