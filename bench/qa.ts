/**
 * Layer-1 question generation for the KylinMem benchmark.
 *
 * The published batch ships instances but no question file, and the dataset's
 * own `build_qa.py` reads a `seed_sources.json` that is not distributed with it.
 * This module regenerates the questions from the instances instead, emitting the
 * exact record shape the dataset's `evaluate.py` consumes, so the scoring stays
 * the dataset's rather than ours.
 *
 * The one thing it cannot copy is the keyword list: `secret_tokens` is dropped
 * during instance assembly. See {@link keywordsFor} for what replaces it and why
 * that choice keeps the judge's oracle check meaningful.
 *
 * @module dsh-advanced-mem-plugin/bench/qa
 */

import type { KylinEvent, KylinInstance } from './dataset.ts'

/**
 * What a question tests.
 *
 * The first four are the dataset's own. `transfer` is added here; see
 * {@link transferQuestionFor} for what it asks and why the four are not enough.
 */
export type QaDimension = 'fact' | 'meaning' | 'causal' | 'state_update' | 'transfer'

/**
 * Which question set a run asks.
 *
 * `issue` reproduces `build_qa.py`: four questions per instance, each naming the
 * historical issue. `task` asks the single question the dataset's own
 * `memory_on_expected` describes but never poses.
 */
export type QueryStyle = 'issue' | 'task'

/** One generated question, in the dataset's published QA schema. */
export interface KylinQa {
  readonly qa_id: string
  readonly instance_id: string
  readonly dimension: QaDimension
  readonly memory_id: string
  readonly requires_memory_ids: readonly string[]
  readonly question: string
  readonly gold_answer: string
  readonly keywords: readonly string[]
  readonly scoring: string
  readonly context: string
  readonly provenance: Readonly<Record<string, string>>
}

const SOURCE_FILE = /[A-Za-z_][\w.-]*(?:\/[\w.-]+)+\.(?:py|pyx|rst|txt|cfg|toml|ini|json|yml|yaml)/g

/** Shorten a field to a single line, the way the dataset's own generator does. */
function short(text: string, limit: number): string {
  const flat = text.trim().replace(/\s+/g, ' ')
  return flat.length <= limit ? flat : `${flat.slice(0, limit)}...`
}

/**
 * Derive the countable keywords for one instance.
 *
 * The dataset's judge only counts a keyword the question does not already
 * contain — a word you can read off the prompt proves nothing about memory. That
 * rule is what the replacement has to respect: the source files a past fix
 * touched are stated nowhere except in the memory, they survive into both forms
 * of gold answer (the memory sentence and the event chain), and naming one is
 * exactly the repository knowledge the benchmark claims to measure.
 *
 * Deriving them from the *gold answer* rather than from the patch is also what
 * keeps the judge's oracle check honest: an oracle that replays the gold answer
 * must score 100%, or the scoring rule is broken rather than the system.
 *
 * Whole paths only, never their basenames. `astropy/time/core.py` identifies one
 * memory; `core` is in half the repository, and counting it turns any neighbour
 * memory into a pass. That confound is not hypothetical — it carried 44% of the
 * passes on a transfer run before this was tightened.
 * @param instance - the instance to derive keywords for.
 * @returns the source paths a fix touched, longest first; empty when the
 *   instance records no touched file and is therefore unscoreable.
 */
export function keywordsFor(instance: KylinInstance): string[] {
  const paths = new Set<string>()
  for (const match of instance.gold_memory.content.matchAll(SOURCE_FILE)) paths.add(match[0])
  for (const event of instance.history_session.events) {
    for (const match of (event.tool_input ?? '').matchAll(SOURCE_FILE)) paths.add(match[0])
  }
  return [...paths].sort((a, b) => b.length - a.length)
}

/** Compress the event chain into the causal dimension's reference answer. */
function chainSummary(events: readonly KylinEvent[]): string {
  const label: Record<string, string> = { observation: '背景/现象', tool_call: '操作', test: '验证' }
  return events
    .map((event, index) => {
      const kind = label[event.type] ?? event.type
      const body = event.content.length > 0
        ? short(event.content, 80)
        : short(`${event.tool ?? ''} ${event.tool_input ?? ''}`, 250)
      return `e${index + 1}(${kind}): ${body}`
    })
    .join(' -> ')
}

/**
 * Generate the four dimension questions for one instance.
 * @param instance - the instance to ask about.
 * @returns the questions, or an empty list when no keyword is countable.
 */
export function questionsFor(instance: KylinInstance): KylinQa[] {
  const keywords = keywordsFor(instance)
  if (keywords.length === 0) return []
  const issue = short(instance.history_session.issue, 50)
  const memory = instance.gold_memory.content
  const chain = chainSummary(instance.history_session.events)
  const provenance = {
    seed_source: 'kylinmem_dev_batch_real.jsonl',
    generated_by: 'dsh-advanced-mem-plugin/bench/qa.ts (template, mirrors build_qa.py)',
    keywords_from: 'gold_memory source files (secret_tokens absent from the published instances)',
  }
  const draft: readonly (readonly [QaDimension, string, string])[] = [
    ['fact', `在 ${instance.repo} 中, 关于「${issue}」这个历史问题, 最终沉淀的关键做法是什么?`, memory],
    ['meaning', `为什么「${issue}」会发生? 根本原因是什么?`, memory],
    ['causal', `请按时间顺序还原解决「${issue}」的关键链路 (现象/背景 -> 操作 -> 验证)。`, chain],
    [
      'state_update',
      instance.gold_memory.type === 'knowledge_update'
        ? '仓库对这块的最新约定是什么? 和历史做法相比更新了什么?'
        : `基于历史会话, 仓库对「${issue}」涉及部分的当前约定/事实是什么?`,
      memory,
    ],
  ]
  return draft
    .map(([dimension, question, gold], index) => ({
      qa_id: `${instance.instance_id}_q${index + 1}`,
      instance_id: instance.instance_id,
      dimension,
      memory_id: instance.gold_memory.memory_id,
      requires_memory_ids: [instance.gold_memory.memory_id],
      question,
      gold_answer: gold,
      keywords,
      scoring: 'keyword_match (命中>=1 算对) / 可升 LLM-judge',
      context: 'memory (应仅凭记忆 m1 回答, 不给轨迹原文)',
      provenance,
    }))
    .filter(isScoreable)
}

/**
 * Whether a question can be scored at all.
 *
 * Some issue titles name the file their own fix touched, so the question quotes
 * the only keyword the instance has. The judge — correctly — refuses to count a
 * keyword the prompt already contains, which leaves nothing countable: the
 * question is unpassable by any system, including an oracle replaying the
 * reference answer. Dropping it is what keeps the oracle check meaningful as a
 * check rather than as a rounding artefact.
 * @param qa - the candidate question.
 * @returns whether at least one keyword is absent from the question.
 */
function isScoreable(qa: KylinQa): boolean {
  return qa.keywords.some(keyword => !qa.question.includes(keyword))
}

/**
 * Ask the question the dataset designed but did not write down.
 *
 * Every one of `build_qa.py`'s four questions quotes the historical issue back
 * verbatim — `关于「WCS.all_world2pix failed to converge」这个历史问题…`. That
 * string is also the memory's own subject line, so retrieval reduces to looking
 * a document up by its title, and any lexical index scores near the ceiling. It
 * measures indexing, not recall.
 *
 * The dataset's `memory_dependency.memory_on_expected` describes something
 * harder and states it plainly: *retrieve m1 (repository experience) → reuse the
 * approach → fix B directly*. B is the target task, which shares no wording with
 * the history. This asks that, and nothing else changes: the reference answer is
 * still the gold memory, so the judge and its oracle check are untouched.
 * @param instance - the instance to ask about.
 * @returns the question, or `undefined` when the instance has no countable keyword.
 */
export function transferQuestionFor(instance: KylinInstance): KylinQa | undefined {
  const keywords = keywordsFor(instance)
  if (keywords.length === 0) return undefined
  const qa: KylinQa = {
    qa_id: `${instance.instance_id}_qt`,
    instance_id: instance.instance_id,
    dimension: 'transfer',
    memory_id: instance.gold_memory.memory_id,
    requires_memory_ids: [instance.gold_memory.memory_id],
    question: `我现在要在 ${instance.repo} 上做这件事: `
      + `${short(instance.target_task.problem_statement, 400)} `
      + '这个仓库里有没有相关的历史经验可以复用? 具体涉及哪些文件?',
    gold_answer: instance.gold_memory.content,
    keywords,
    scoring: 'keyword_match (命中>=1 算对) / 可升 LLM-judge',
    context: 'memory (只给新任务, 不给历史 issue 标题)',
    provenance: {
      seed_source: 'kylinmem_dev_batch_real.jsonl',
      generated_by: 'dsh-advanced-mem-plugin/bench/qa.ts (transfer dimension, not in build_qa.py)',
      keywords_from: 'gold_memory source files (secret_tokens absent from the published instances)',
    },
  }
  return isScoreable(qa) ? qa : undefined
}

/**
 * Generate the question set for a batch.
 * @param instances - the instances to ask about.
 * @param style - which question set to ask; see {@link QueryStyle}.
 * @returns the questions and which instances yielded none.
 */
export function buildQuestions(
  instances: readonly KylinInstance[],
  style: QueryStyle = 'issue',
): { readonly questions: KylinQa[]; readonly unscoreable: string[] } {
  const questions: KylinQa[] = []
  const unscoreable: string[] = []
  for (const instance of instances) {
    if (style === 'task') {
      const generated = transferQuestionFor(instance)
      if (generated === undefined) unscoreable.push(instance.instance_id)
      else questions.push(generated)
      continue
    }
    const generated = questionsFor(instance)
    if (generated.length === 0) unscoreable.push(instance.instance_id)
    else questions.push(...generated)
  }
  return { questions, unscoreable }
}

/**
 * Apply the dataset's own judging rule to one answer.
 *
 * Reimplemented here only so a run can report its score without a Python round
 * trip; `bench/score.py` remains the authority, and the two agree by
 * construction. A keyword already present in the question is not counted.
 * @param qa - the question.
 * @param answer - what the system under test replied.
 * @returns whether the answer passed, and which keywords carried it.
 */
export function judge(qa: KylinQa, answer: string): { readonly passed: boolean; readonly hits: string[] } {
  const countable = qa.keywords.filter(keyword => !qa.question.includes(keyword))
  const hits = countable.filter(keyword => answer.includes(keyword))
  return { passed: hits.length > 0, hits }
}
