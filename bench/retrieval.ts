/**
 * Cross-dataset retrieval runner.
 *
 * One corpus at a time: boot a stack, write the corpus in, ask every question
 * asked against it, tear the stack down. What varies between datasets is only
 * the suite that reduced them; the stack, the metrics and this loop are shared,
 * which is what makes a LoCoMo number and a LongMemEval number belong on the
 * same page.
 *
 * ```
 * node --experimental-transform-types --max-old-space-size=8192 bench/retrieval.ts \
 *   --suite longmemeval --dataset /path/longmemeval_s.json --limit 100
 * ```
 *
 * @module dsh-advanced-mem-plugin/bench/retrieval
 */

import { mkdir, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { bm25Rank, cosineSimilarity, reciprocalRankFusion, tokenize } from '@deepseek-ai/dsh-memory'
import { ApiEmbedder } from './embedding-api.ts'
import { MemoryStack } from './stack.ts'
import { CUTOFFS, score, summarize } from './metrics.ts'
import type { RetrievalScore } from './metrics.ts'
import type { BenchSuite } from './suites/types.ts'
import { longmemeval } from './suites/longmemeval.ts'
import { locomo } from './suites/locomo.ts'
import { perltqa } from './suites/perltqa.ts'
import { kylinofficeDeclared, kylinofficeGrounded } from './suites/kylinoffice.ts'

const SUITES: Readonly<Record<string, BenchSuite>> = {
  [longmemeval.name]: longmemeval,
  [locomo.name]: locomo,
  [perltqa.name]: perltqa,
  [kylinofficeDeclared.name]: kylinofficeDeclared,
  [kylinofficeGrounded.name]: kylinofficeGrounded,
}

const USAGE = `Usage: node --experimental-transform-types bench/retrieval.ts [options]

  --suite <name>       ${Object.keys(SUITES).join(' | ')}   (required)
  --dataset <path>     dataset file for that suite          (required)
  --out <dir>          output directory                     (default: bench/out)
  --baseline <b>       memory | none | random | recent | bm25 | dense | rrf
                       (default: memory). dense and rrf need --embed-model.
  --limit <n>          corpora to run, 0 for all            (default: 0)
  --recall-limit <n>   cues per query                       (default: 10)
  --dimensions <n>     embedding width, 0 for lexical only  (default: 0)
  --vector-weight <w>  weight of the vector ranking in fusion  (default: 1)
  --include-evidence   quote evidence-use records too       (default: off)
  --consolidate        run the distiller so layer 1 joins    (default: off)
  --embed-model <id>   mount a real encoder from an OpenAI-compatible /embeddings
                       endpoint instead of the feature-hash one. Needs
                       OPENAI_BASE_URL and OPENAI_API_KEY in the environment.
  --embed-dims <n>     vector width that endpoint returns    (default: 1024)
  --embed-cache <path> JSONL vector cache        (default: bench/out/emb-<model>.jsonl)
  --dump-retrieved <p> write per-question retrieved text as JSONL, for a reader
                       to answer from. Retrieval alone needs no text; an
                       end-to-end QA run does.
`

/**
 * What produces the ranking being scored.
 *
 * `memory` is the system under test. The other three are floors, and they exist
 * because a retrieval score means nothing without one: `none` is the definitional
 * zero, `random` is what a corpus of this size yields by luck alone, and `recent`
 * is the cheapest thing anybody would actually build instead — keep the last few
 * turns and hand those over. A memory system has to beat *that*, not zero.
 *
 * `bm25` is the one that decides whether this system is worth its complexity:
 * plain Okapi BM25 over the same documents, through the same `tokenize` and
 * `bm25Rank` the stack itself calls, with everything else removed — no vector
 * signal, no graph activation, no recency or confidence prior, no layer-1 nodes
 * competing with layer-0 records, no dedup. Whatever separates `memory` from
 * `bm25` is exactly what the memory architecture contributes over text matching.
 */
export type Baseline = 'memory' | 'none' | 'random' | 'recent' | 'bm25' | 'dense' | 'rrf'

/** Everything the runner was told to do. */
interface Options {
  readonly suite: BenchSuite
  readonly baseline: Baseline
  readonly dataset: string
  readonly out: string
  readonly limit: number
  readonly recallLimit: number
  readonly dimensions: number
  readonly vectorWeight: number
  readonly includeEvidence: boolean
  readonly consolidate: boolean
  readonly embedModel: string
  readonly embedDims: number
  readonly embedCache: string
  readonly dumpRetrieved: string
}

/**
 * Read the command line.
 * @param argv - arguments after the script name.
 * @returns the parsed options.
 * @throws when a flag is unknown, missing, or names no suite.
 */
function parseArgs(argv: readonly string[]): Options {
  const flags = new Map<string, string>()
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] ?? ''
    if (!arg.startsWith('--')) throw new Error(`unexpected argument: ${arg}`)
    const key = arg.slice(2)
    if (key === 'include-evidence' || key === 'consolidate') {
      flags.set(key, 'true')
      continue
    }
    const value = argv[index + 1]
    if (value === undefined || value.startsWith('--')) throw new Error(`--${key} needs a value`)
    flags.set(key, value)
    index += 1
  }
  const name = flags.get('suite')
  const suite = name === undefined ? undefined : SUITES[name]
  if (suite === undefined) throw new Error(`--suite must be one of ${Object.keys(SUITES).join(', ')}`)
  const dataset = flags.get('dataset')
  if (dataset === undefined) throw new Error('--dataset is required')
  const baseline = (flags.get('baseline') ?? 'memory') as Baseline
  if (!['memory', 'none', 'random', 'recent', 'bm25', 'dense', 'rrf'].includes(baseline)) {
    throw new Error(`unknown --baseline ${baseline}`)
  }
  const number = (key: string, fallback: number): number => {
    const raw = flags.get(key)
    if (raw === undefined) return fallback
    const parsed = Number(raw)
    if (!Number.isFinite(parsed) || parsed < 0) throw new Error(`--${key} must be a non-negative number`)
    return parsed
  }
  return {
    suite,
    baseline,
    dataset: resolve(dataset),
    out: resolve(flags.get('out') ?? join(dirname(fileURLToPath(import.meta.url)), 'out')),
    limit: number('limit', 0),
    recallLimit: number('recall-limit', 10),
    dimensions: number('dimensions', 0),
    vectorWeight: number('vector-weight', 1),
    includeEvidence: flags.get('include-evidence') === 'true',
    consolidate: flags.get('consolidate') === 'true',
    embedModel: flags.get('embed-model') ?? '',
    embedDims: number('embed-dims', 1024),
    embedCache: flags.get('embed-cache') ?? '',
    dumpRetrieved: flags.get('dump-retrieved') ?? '',
  }
}

/** One scored question, kept for the report. */
interface Row {
  readonly task: string
  readonly group: string
  readonly corpus: string
  /** Scored against the exact turns or entries the dataset labelled. */
  readonly score: RetrievalScore
  /**
   * Scored against the *sessions* those turns belong to.
   *
   * LongMemEval reports retrieval this way, and a strict turn-level recall is
   * bounded above by the cue budget whenever a question has more evidence turns
   * than there are slots — which is most of them. Both are printed because
   * neither alone is honest: the turn view says how precisely material is found,
   * the session view is what compares to published numbers.
   */
  readonly sessionScore: RetrievalScore
  readonly ms: number
}

/**
 * Deterministic 32-bit hash, so a `random` baseline is reproducible.
 *
 * Seeded per question rather than per run: a fixed shuffle of the corpus would
 * hand every question of a LoCoMo conversation the same ten documents, which is
 * a different and much luckier experiment than the one intended.
 * @param text - the seed material, normally the task id.
 * @returns a non-negative 32-bit integer.
 */
function hash(text: string): number {
  let value = 2166136261
  for (let index = 0; index < text.length; index += 1) {
    value ^= text.charCodeAt(index)
    value = Math.imul(value, 16777619)
  }
  return value >>> 0
}

/**
 * Build the ranking a baseline hands back for a question.
 * @param baseline - which floor to produce.
 * @param documents - the corpus, in the order it occurred.
 * @param limit - how many to return, matching the cue budget memory gets.
 * @returns a function from query text to the documents that baseline returns.
 */
export function floorOf(
  baseline: Baseline,
  documents: readonly { readonly id: string; readonly text: string }[],
  limit: number,
): (task: string, query: string) => string[] {
  const ids = documents.map(document => document.id)
  if (baseline === 'none') return () => []
  // Plain BM25 over the same corpus, indexed once per corpus exactly as the
  // stack indexes it. No prior, no fusion, no second signal: the ranking is
  // the lexical one and nothing else.
  if (baseline === 'bm25') {
    const indexed = documents.map(document => ({ item: document.id, terms: tokenize(document.text) }))
    return (_task: string, query: string) =>
      bm25Rank(tokenize(query), indexed).slice(0, limit).map(scored => scored.item)
  }
  // The last `limit` documents, most recent first: what a fixed-size scrollback
  // window holds, and the thing a memory system is supposed to improve on.
  if (baseline === 'recent') {
    const window = [...ids].slice(-limit).reverse()
    return () => window
  }
  return (task: string) => {
    let seed = hash(task)
    const pool = [...ids]
    const picked: string[] = []
    while (picked.length < limit && pool.length > 0) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
      picked.push(...pool.splice(seed % pool.length, 1))
    }
    return picked
  }
}

/**
 * Rank with the embedder alone, or with BM25 and the embedder fused — both
 * assembled outside the memory stack from the same primitives it calls.
 *
 * This is the baseline that decides whether the architecture earns its keep. A
 * `memory` run with an encoder mounted is rank fusion of a lexical and a vector
 * ranking plus everything else the hub does; `rrf` is that fusion and nothing
 * else. Whatever separates them is the hub's contribution, and if nothing
 * separates them the hub contributed nothing.
 * @param mode - `dense` for the vector ranking alone, `rrf` for both fused.
 * @param documents - the corpus.
 * @param embedder - a warm embedder; the caller prewarms it.
 * @param limit - how many to return.
 * @returns a ranking function over query text.
 */
async function vectorFloor(
  mode: 'dense' | 'rrf',
  documents: readonly { readonly id: string; readonly text: string }[],
  embedder: ApiEmbedder,
  limit: number,
): Promise<(query: string) => Promise<string[]>> {
  const texts = documents.map(document => document.text.slice(0, 4000))
  const vectors = await embedder.embed(texts)
  const width = vectors[0]?.length ?? 0
  const lexical = documents.map((document, index) => ({ item: index, terms: tokenize(document.text) }))
  return async (query: string): Promise<string[]> => {
    const [queryVector] = await embedder.embed([query])
    const probe = queryVector ?? []
    const dense = documents
      .map((_, index) => {
        const vector = vectors[index] ?? []
        const score = vector.length === width && probe.length === width
          ? cosineSimilarity(probe, vector)
          : 0
        return { item: index, score }
      })
      .sort((left, right) => right.score - left.score)
      .map(scored => scored.item)
    if (mode === 'dense') return dense.slice(0, limit).map(index => documents[index]!.id)
    const sparse = bm25Rank(tokenize(query), lexical).map(scored => scored.item)
    return reciprocalRankFusion<number>([sparse, dense], index => String(index))
      .slice(0, limit)
      .map(scored => documents[scored.item]!.id)
  }
}

/** Format a summary as one aligned line. */
function line(label: string, rows: readonly Row[], session = false): string {
  const stats = summarize(rows.map(row => (session ? row.sessionScore : row.score)))
  const cell = (value: number): string => `${(100 * value).toFixed(1).padStart(5)}%`
  return `    ${label.padEnd(26)} n=${String(stats.queries).padStart(5)}  `
    + `R@1 ${cell(stats.recallAt[1] ?? 0)}  R@5 ${cell(stats.recallAt[5] ?? 0)}  R@10 ${cell(stats.recallAt[10] ?? 0)}  `
    + `hit@10 ${cell(Number(stats.hitAt[10] ?? 0))}  MRR ${stats.mrr.toFixed(3)}  nDCG ${stats.ndcg.toFixed(3)}`
}

/**
 * Run one suite end to end.
 * @param options - the run configuration.
 */
async function main(options: Options): Promise<void> {
  const corpora = await options.suite.load(options.dataset, options.limit)
  const totalTasks = corpora.reduce((sum, corpus) => sum + corpus.tasks.length, 0)
  process.stderr.write(
    `${options.suite.name}  ${corpora.length} corpora, ${totalTasks} questions\n`
    + `           ${options.suite.describe}\n`,
  )

  const rows: Row[] = []
  const dump: string[] = []
  const started = Date.now()
  let records = 0
  let nodes = 0
  let edges = 0
  for (const [index, corpus] of corpora.entries()) {
    // A baseline run never boots the stack: booting it and then ignoring it
    // would let an ingest bug look like a baseline result.
    const stack = options.baseline === 'memory'
      ? await MemoryStack.create({
        recallLimit: options.recallLimit,
        dimensions: options.dimensions,
        vectorWeight: options.vectorWeight,
        includeEvidence: options.includeEvidence,
        consolidate: options.consolidate,
        ...(options.embedModel === ''
          ? {}
          : {
              apiEmbedder: {
                model: options.embedModel,
                baseUrl: process.env['OPENAI_BASE_URL'] ?? '',
                apiKey: process.env['OPENAI_API_KEY'] ?? '',
                dimensions: options.embedDims,
                cachePath: options.embedCache === ''
                  ? join(options.out, `emb-${options.embedModel.replace(/\W+/g, '-')}.jsonl`)
                  : options.embedCache,
                batch: 32,
                concurrency: 6,
              },
            }),
      })
      : undefined
    try {
      if (stack !== undefined) {
        await stack.prewarm(corpus.tasks.map(task => task.query))
        await stack.ingest(corpus.documents)
        records += stack.records
        const built = await stack.distil()
        nodes += built.nodes
        edges += built.edges
      }
      const floor = floorOf(options.baseline, corpus.documents, options.recallLimit)
      let vectorRank: ((query: string) => Promise<string[]>) | undefined
      if (options.baseline === 'dense' || options.baseline === 'rrf') {
        const embedder = new ApiEmbedder({
          model: options.embedModel,
          baseUrl: process.env['OPENAI_BASE_URL'] ?? '',
          apiKey: process.env['OPENAI_API_KEY'] ?? '',
          dimensions: options.embedDims,
          cachePath: options.embedCache === ''
            ? join(options.out, `emb-${options.embedModel.replace(/\W+/g, '-')}.jsonl`)
            : options.embedCache,
          batch: 32,
          concurrency: 6,
        })
        await embedder.prewarm([
          ...corpus.documents.map(document => document.text.slice(0, 4000)),
          ...corpus.tasks.map(task => task.query),
        ])
        vectorRank = await vectorFloor(options.baseline, corpus.documents, embedder, options.recallLimit)
      }
      const sessionOf = new Map(corpus.documents.map(document => [document.id, document.session ?? document.id]))
      const sessionsOf = (ids: readonly string[]): string[] => {
        const seen = new Set<string>()
        const out: string[] = []
        for (const id of ids) {
          const session = sessionOf.get(id) ?? id
          if (seen.has(session)) continue
          seen.add(session)
          out.push(session)
        }
        return out
      }
      const textOf = new Map(corpus.documents.map(document => [document.id, document.text]))
      for (const task of corpus.tasks) {
        const retrieved = stack !== undefined
          ? await stack.retrieve(task.query, task.at)
          : vectorRank !== undefined
            ? { documents: await vectorRank(task.query), ms: 0 }
            : { documents: floor(task.id, task.query), ms: 0 }
        if (options.dumpRetrieved !== '') {
          dump.push(JSON.stringify({
            task: task.id,
            group: task.group,
            query: task.query,
            texts: retrieved.documents.map(id => textOf.get(id) ?? ''),
          }))
        }
        rows.push({
          task: task.id,
          group: task.group,
          corpus: corpus.id,
          score: score({ returned: retrieved.documents, gold: new Set(task.gold) }, CUTOFFS),
          sessionScore: score(
            { returned: sessionsOf(retrieved.documents), gold: new Set(sessionsOf(task.gold)) },
            CUTOFFS,
          ),
          ms: retrieved.ms,
        })
      }
    } finally {
      await stack?.dispose()
    }
    if ((index + 1) % 25 === 0) process.stderr.write(`  ${index + 1}/${corpora.length} corpora\r`)
  }

  const overall = summarize(rows.map(row => row.score))
  const overallSession = summarize(rows.map(row => row.sessionScore))
  const groups = new Map<string, Row[]>()
  for (const row of rows) {
    const bucket = groups.get(row.group)
    if (bucket === undefined) groups.set(row.group, [row])
    else bucket.push(row)
  }
  const byGroup = [...groups.entries()].sort(([, left], [, right]) => right.length - left.length)

  const report = {
    system_under_test: options.baseline === 'memory'
      ? `dsh-advanced-mem-plugin (${options.suite.name})`
      : `baseline:${options.baseline} (${options.suite.name})`,
    suite: { name: options.suite.name, describe: options.suite.describe },
    options: { ...options, suite: options.suite.name },
    corpus: { corpora: corpora.length, questions: rows.length, records, nodes, edges },
    timing: {
      total_ms: Date.now() - started,
      mean_query_ms: rows.length === 0 ? 0 : rows.reduce((sum, row) => sum + row.ms, 0) / rows.length,
    },
    overall,
    overall_session: overallSession,
    by_group: Object.fromEntries(byGroup.map(([name, group]) => [name, {
      turn: summarize(group.map(row => row.score)),
      session: summarize(group.map(row => row.sessionScore)),
    }])),
    detail: rows.map(row => ({
      task: row.task, group: row.group, corpus: row.corpus,
      first_rank: row.score.firstRank, session_first_rank: row.sessionScore.firstRank,
      ndcg: Number(row.score.ndcg.toFixed(4)),
    })),
  }

  await mkdir(options.out, { recursive: true })
  if (options.dumpRetrieved !== '') {
    await writeFile(options.dumpRetrieved, dump.map(row => `${row}
`).join(''), 'utf8')
    process.stderr.write(`  dumped ${dump.length} contexts to ${options.dumpRetrieved}
`)
  }
  // The dataset basename is part of the name because one suite serves several
  // files — PerLTQA ships an English and a Chinese half, and a run of one must
  // not quietly overwrite the report of the other.
  const dataset = basename(options.dataset).replace(/\.json$/, '')
  const suffix = `${options.suite.name}-${dataset}`
    + `${options.baseline === 'memory' ? '' : `-baseline-${options.baseline}`}`
    + `${options.consolidate ? '-graph' : ''}`
    + `${options.includeEvidence ? '-evidence' : ''}`
    + `${options.embedModel === ''
      ? (options.dimensions === 0 ? '-lexical' : '')
      : `-emb-${options.embedModel.replace(/\W+/g, '-')}${options.vectorWeight === 1 ? '' : `-w${options.vectorWeight}`}`}`
  await writeFile(join(options.out, `retrieval-${suffix}.json`), `${JSON.stringify(report, null, 2)}\n`, 'utf8')

  process.stdout.write(
    `\n${report.system_under_test}\n`
    + `  corpus       ${corpora.length} corpora, ${records} records, ${rows.length} questions`
    + `${options.consolidate ? `, distilled ${nodes} nodes / ${edges} edges` : ''}\n`
    + `${line('overall (evidence unit)', rows)}\n`
    + `${line('overall (session)', rows, true)}\n`
    + `  by category, at evidence-unit granularity\n`
    + `${byGroup.map(([name, group]) => line(name, group)).join('\n')}\n`
    + `  by category, at session granularity\n`
    + `${byGroup.map(([name, group]) => line(name, group, true)).join('\n')}\n`
    + `  latency      ${report.timing.mean_query_ms.toFixed(1)} ms per query, `
    + `${(report.timing.total_ms / 1000).toFixed(0)} s total\n`
    + `  written      ${join(options.out, `retrieval-${suffix}.json`)}\n`,
  )
}

try {
  await main(parseArgs(process.argv.slice(2)))
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n\n${USAGE}`)
  process.exitCode = 1
}
