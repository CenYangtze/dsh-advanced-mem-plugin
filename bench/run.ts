/**
 * KylinMem benchmark runner.
 *
 * Loads the dataset, regenerates its layer-1 questions, ingests every history
 * into a live memory stack, asks every question, and writes three files: the
 * questions in the dataset's own schema, one answer per question, and a report.
 * The answers file is the seam — `bench/score.py` feeds it to the dataset's own
 * `evaluate.py`, so the published judge stays the authority on the score and
 * this program never grades itself.
 *
 * ```
 * node --experimental-transform-types bench/run.ts \
 *   --dataset D:/path/kylinmem_dev_batch_real.jsonl --mode gold --isolation repo
 * ```
 *
 * @module dsh-advanced-mem-plugin/bench/run
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadInstances, subsample } from './dataset.ts'
import type { KylinInstance } from './dataset.ts'
import { buildQuestions, judge } from './qa.ts'
import type { QueryStyle } from './qa.ts'
import { MemorySystemUnderTest } from './adapter.ts'
import type { AnswerRecord, IngestMode, Isolation } from './adapter.ts'

/** Everything the runner was told to do. */
interface Options {
  readonly dataset: string
  readonly out: string
  readonly mode: IngestMode
  readonly isolation: Isolation
  readonly query: QueryStyle
  readonly limit: number
  readonly recallLimit: number
  readonly dimensions: number
  readonly includeEvidence: boolean
  readonly supportWeight: number
  readonly consolidate: boolean
}

const USAGE = `Usage: node --experimental-transform-types bench/run.ts [options]

  --dataset <path>     KylinMem instance JSONL             (required)
  --out <dir>          Output directory                    (default: bench/out)
  --mode <m>           gold | raw | off                    (default: gold)
  --isolation <i>      instance | repo | global            (default: repo)
  --query <q>          issue | task                        (default: issue)
  --limit <n>          Instances to run, 0 for all         (default: 200)
  --recall-limit <n>   Cues per answer                     (default: 8)
  --dimensions <n>     Embedding width, 0 for lexical only (default: 0)
  --include-evidence   Quote evidence-use records too      (default: off)
  --support-weight <w> How much accumulated support lifts a belief (default: 0)
  --no-consolidate     Skip distillation in raw mode       (default: off)
`

/**
 * Read the command line.
 * @param argv - arguments after the script name.
 * @returns the parsed options.
 * @throws when a flag is unknown or a required value is missing.
 */
function parseArgs(argv: readonly string[]): Options {
  const flags = new Map<string, string>()
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] ?? ''
    if (!arg.startsWith('--')) throw new Error(`unexpected argument: ${arg}`)
    const key = arg.slice(2)
    if (key === 'include-evidence' || key === 'no-consolidate') {
      flags.set(key, 'true')
      continue
    }
    const value = argv[index + 1]
    if (value === undefined || value.startsWith('--')) throw new Error(`--${key} needs a value`)
    flags.set(key, value)
    index += 1
  }
  const dataset = flags.get('dataset')
  if (dataset === undefined) throw new Error('--dataset is required')
  const mode = (flags.get('mode') ?? 'gold') as IngestMode
  if (!['gold', 'raw', 'off'].includes(mode)) throw new Error(`unknown --mode ${mode}`)
  const isolation = (flags.get('isolation') ?? 'repo') as Isolation
  if (!['instance', 'repo', 'global'].includes(isolation)) throw new Error(`unknown --isolation ${isolation}`)
  const query = (flags.get('query') ?? 'issue') as QueryStyle
  if (!['issue', 'task'].includes(query)) throw new Error(`unknown --query ${query}`)
  const number = (key: string, fallback: number): number => {
    const raw = flags.get(key)
    if (raw === undefined) return fallback
    const parsed = Number(raw)
    if (!Number.isFinite(parsed) || parsed < 0) throw new Error(`--${key} must be a non-negative number`)
    return parsed
  }
  return {
    dataset: resolve(dataset),
    out: resolve(flags.get('out') ?? join(dirname(fileURLToPath(import.meta.url)), 'out')),
    mode,
    isolation,
    query,
    limit: number('limit', 200),
    recallLimit: number('recall-limit', 8),
    dimensions: number('dimensions', 0),
    includeEvidence: flags.get('include-evidence') === 'true',
    supportWeight: number('support-weight', 0),
    consolidate: flags.get('no-consolidate') !== 'true',
  }
}

/** Accuracy over a group of answers. */
interface Bucket { total: number; passed: number }

/** Group pass rates by some key of a result row. */
function groupBy<T>(rows: readonly T[], key: (row: T) => string, passed: (row: T) => boolean): Record<string, Bucket> {
  const groups: Record<string, Bucket> = {}
  for (const row of rows) {
    const bucket = groups[key(row)] ?? { total: 0, passed: 0 }
    bucket.total += 1
    if (passed(row)) bucket.passed += 1
    groups[key(row)] = bucket
  }
  return groups
}

/** Format a bucket map as `name 62.5% (25/40)` lines. */
function formatGroups(groups: Record<string, Bucket>): string {
  return Object.entries(groups)
    .sort(([, left], [, right]) => right.total - left.total)
    .map(([name, bucket]) => `    ${name.padEnd(24)} ${(100 * bucket.passed / bucket.total).toFixed(1).padStart(5)}%  (${bucket.passed}/${bucket.total})`)
    .join('\n')
}

/**
 * Run one configuration end to end.
 * @param options - the run configuration.
 */
async function main(options: Options): Promise<void> {
  const loaded = await loadInstances(options.dataset)
  const instances = subsample(loaded.instances, options.limit)
  const byId = new Map<string, KylinInstance>(instances.map(instance => [instance.instance_id, instance]))
  const { questions, unscoreable } = buildQuestions(instances, options.query)
  process.stderr.write(
    `dataset  ${instances.length}/${loaded.instances.length} instances, ${questions.length} questions\n`
    + `         repaired test lists: ${loaded.health.repairedTestLists}, `
    + `no recoverable test names: ${loaded.health.withoutTestNames}, `
    + `unscoreable instances: ${unscoreable.length}\n`,
  )

  const root = await mkdtemp(join(tmpdir(), 'kylin-bench-'))
  const started = Date.now()
  let ingestMs = 0
  let consolidated = { nodes: 0, edges: 0 }
  let counts = { records: 0, nodes: 0 }
  let collisions = 0
  const answers: { readonly qa: (typeof questions)[number]; readonly answer: AnswerRecord }[] = []
  const system = await MemorySystemUnderTest.create({
    mode: options.mode,
    isolation: options.isolation,
    root,
    recallLimit: options.recallLimit,
    dimensions: options.dimensions,
    vectorWeight: 1,
    supportWeight: options.supportWeight,
    includeEvidence: options.includeEvidence,
    consolidate: options.consolidate,
  })
  try {
    const ingestStarted = Date.now()
    for (const [index, instance] of instances.entries()) {
      await system.ingest(instance)
      if ((index + 1) % 100 === 0) process.stderr.write(`  ingested ${index + 1}/${instances.length}\r`)
    }
    if (options.mode === 'raw' && options.consolidate) consolidated = await system.consolidate()
    ingestMs = Date.now() - ingestStarted

    for (const [index, qa] of questions.entries()) {
      const instance = byId.get(qa.instance_id)
      if (instance === undefined) continue
      answers.push({ qa, answer: await system.answer(qa, instance) })
      if ((index + 1) % 200 === 0) process.stderr.write(`  answered ${index + 1}/${questions.length}\r`)
    }
    counts = system.counts()
    collisions = system.collisions.length
  } finally {
    await system.dispose()
    await rm(root, { recursive: true, force: true })
  }

  const results = answers.map(({ qa, answer }) => {
    const verdict = judge(qa, answer.answer)
    const instance = byId.get(answer.instance_id)
    return {
      ...answer,
      passed: verdict.passed,
      hits: verdict.hits,
      memory_type: instance?.gold_memory.type ?? 'unknown',
      repo: instance?.repo ?? 'unknown',
    }
  })

  const ranks = results.map(row => row.goldRank).filter((rank): rank is number => rank !== null)
  const passed = results.filter(row => row.passed).length
  const report = {
    system_under_test: `dsh-advanced-mem-plugin (${options.mode}/${options.isolation}/${options.query})`,
    options,
    dataset: { ...loaded.health, instances: instances.length, questions: questions.length, unscoreable: unscoreable.length },
    corpus: { ...counts, collisions, consolidated },
    timing: {
      ingest_ms: ingestMs,
      total_ms: Date.now() - started,
      mean_recall_ms: results.length === 0 ? 0 : results.reduce((sum, row) => sum + row.ms, 0) / results.length,
    },
    total: results.length,
    passed,
    accuracy: results.length === 0 ? 0 : passed / results.length,
    retrieval: {
      /** Share of questions whose own instance produced the top cue. */
      hit_at_1: share(ranks.filter(rank => rank === 1).length, results.length),
      hit_at_5: share(ranks.filter(rank => rank <= 5).length, results.length),
      hit_at_k: share(ranks.length, results.length),
      mrr: results.length === 0 ? 0 : ranks.reduce((sum, rank) => sum + 1 / rank, 0) / results.length,
      /**
       * Passes carried by a memory belonging to some *other* instance.
       *
       * The judge counts keywords, and neighbouring memories in one repository
       * name overlapping files, so a pass does not prove the right memory came
       * back. This is the share of the score that is the judge's confound rather
       * than the system's retrieval — read it beside the accuracy, always.
       */
      unattributed_passes: share(results.filter(row => row.passed && row.goldRank === null).length, Math.max(passed, 1)),
    },
    by_dimension: groupBy(results, row => row.dimension, row => row.passed),
    by_memory_type: groupBy(results, row => row.memory_type, row => row.passed),
    by_repo: groupBy(results, row => row.repo, row => row.passed),
    detail: results.map(row => ({ ...row, answer: row.answer.slice(0, 400) })),
  }

  await mkdir(options.out, { recursive: true })
  const suffix = `${options.mode}-${options.isolation}`
    + `${options.query === 'task' ? '-transfer' : ''}`
    + `${options.consolidate ? '' : '-episodic'}${options.includeEvidence ? '-evidence' : ''}`
  await writeFile(join(options.out, `qa-${suffix}.jsonl`), `${questions.map(qa => JSON.stringify(qa)).join('\n')}\n`, 'utf8')
  await writeFile(
    join(options.out, `answers-${suffix}.jsonl`),
    `${results.map(row => JSON.stringify({ qa_id: row.qa_id, answer: row.answer })).join('\n')}\n`,
    'utf8',
  )
  await writeFile(join(options.out, `report-${suffix}.json`), `${JSON.stringify(report, null, 2)}\n`, 'utf8')

  process.stdout.write(
    `\n${report.system_under_test}\n`
    + `  corpus       ${counts.records} records, ${counts.nodes} nodes`
    + `${collisions > 0 ? `, ${collisions} label collisions` : ''}`
    + `${options.mode === 'raw' ? `, distilled ${consolidated.nodes} nodes / ${consolidated.edges} edges` : ''}\n`
    + `  accuracy     ${(100 * report.accuracy).toFixed(1)}%  (${passed}/${results.length})\n`
    + `  confound     ${(100 * report.retrieval.unattributed_passes).toFixed(1)}% of passes came from another instance's memory
`
    + `  retrieval    hit@1 ${(100 * report.retrieval.hit_at_1).toFixed(1)}%  `
    + `hit@5 ${(100 * report.retrieval.hit_at_5).toFixed(1)}%  `
    + `hit@${options.recallLimit} ${(100 * report.retrieval.hit_at_k).toFixed(1)}%  `
    + `MRR ${report.retrieval.mrr.toFixed(3)}\n`
    + `  latency      ${report.timing.mean_recall_ms.toFixed(1)} ms per recall, ingest ${(ingestMs / 1000).toFixed(1)} s\n`
    + `  by dimension\n${formatGroups(report.by_dimension)}\n`
    + `  by memory type\n${formatGroups(report.by_memory_type)}\n`
    + `  written      ${join(options.out, `answers-${suffix}.jsonl`)}\n`,
  )
}

/** Guard the zero-question case so an empty run reports 0 rather than NaN. */
function share(count: number, total: number): number {
  return total === 0 ? 0 : count / total
}

try {
  await main(parseArgs(process.argv.slice(2)))
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n\n${USAGE}`)
  process.exitCode = 1
}
