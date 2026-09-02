/**
 * OSDA-Mem runner: the memory ON / OFF ablation on an OS-agent corpus.
 *
 * Unlike the conversational suites, a task here does not see a fixed corpus. Each
 * task carries a `cutoff_sequence_no`, and may only see the events of its episode
 * up to that point — the dataset is a clock, not a document set. So the loop walks
 * an episode forward: ingest events until the next cutoff, answer the tasks that
 * fall on it, ingest more. That is also the shape a real deployment has, which is
 * why it is worth running this way rather than flattening it.
 *
 * This emits contexts only. The reader and the dataset's own scorer live in
 * `bench/osda_llm.py`, so the number that gets reported is the dataset's, not ours.
 *
 * ```
 * node --experimental-transform-types bench/osda.ts \
 *   --data .../osda_mem/v1/data --split test --mode memory --out ctx-osda-memory.jsonl
 * ```
 *
 * @module dsh-advanced-mem-plugin/bench/osda
 */

import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { MemoryStack } from './stack.ts'
import type { BenchDocument } from './suites/types.ts'

/** One event as the dataset stores it; only the fields this runner reads. */
interface OsdaEvent {
  readonly event_id: string
  readonly episode_id: string
  readonly sequence_no: number
  readonly occurred_at: string
  readonly actor: string
  readonly action: string
  readonly object?: string
  readonly application?: string
  readonly source_type: string
  readonly sensitivity?: string
  readonly input?: { readonly target_event_id?: string } & Record<string, unknown>
  readonly output?: unknown
  readonly state_after?: unknown
  readonly supersedes_event_ids?: readonly string[]
}

/** One task as the dataset states it. */
interface OsdaTask {
  readonly task_id: string
  readonly episode_id: string
  readonly split: string
  readonly task_type: string
  readonly instruction: string
  readonly answer_format: string
  readonly cutoff_sequence_no: number
  readonly as_of: string
}

/** The gold record, read only for the oracle mode. */
interface OsdaGold {
  readonly task_id: string
  readonly required_event_ids: readonly string[]
  readonly supporting_event_ids: readonly string[]
}

/** What produces the context a reader will answer from. */
type Mode = 'memory' | 'all-visible' | 'oracle' | 'none'

/**
 * Project one event onto the text the memory indexes and the reader reads.
 *
 * Every field the gold answers draw on has to survive this projection — the
 * answer keys themselves live in `input`/`output`/`state_after`, which is what
 * makes the task memory-dependent rather than schema-dependent.
 * @param event - the event to render.
 * @returns a single line carrying its identity, time, and payload.
 */
function render(event: OsdaEvent): string {
  const parts = [
    `[${event.event_id}] seq=${event.sequence_no} at=${event.occurred_at}`,
    `${event.actor} ${event.action}${event.object === undefined ? '' : ` ${event.object}`}`,
    `source=${event.source_type}`,
  ]
  if (event.application !== undefined) parts.push(`app=${event.application}`)
  if (event.sensitivity !== undefined && event.sensitivity !== 'normal') {
    parts.push(`sensitivity=${event.sensitivity}`)
  }
  for (const [label, value] of [
    ['input', event.input], ['output', event.output], ['state_after', event.state_after],
  ] as const) {
    if (value === undefined) continue
    const encoded = JSON.stringify(value)
    if (encoded === undefined || encoded === '{}' || encoded === 'null') continue
    parts.push(`${label}=${encoded}`)
  }
  if (event.supersedes_event_ids !== undefined && event.supersedes_event_ids.length > 0) {
    parts.push(`supersedes=${event.supersedes_event_ids.join(',')}`)
  }
  return parts.join(' | ')
}

/**
 * Classify an event by who authored it, in the plugin's own vocabulary.
 *
 * Deliberately not uniform: a user's configuration is a user turn, an agent's
 * tool run is a tool invocation, and telemetry is a note. That mapping decides
 * what the shipped configuration will quote back, so it is a property of the
 * data rather than a knob — and `--include-evidence` is how its cost is measured.
 * @param event - the event to classify.
 * @returns the record kind to write it as.
 */
function kindOf(event: OsdaEvent): BenchDocument['kind'] {
  switch (event.source_type) {
    case 'manual_config':
    case 'user_behavior':
    case 'correction':
    case 'forget_request':
      return 'user-message'
    case 'tool_result':
      return 'tool-invocation'
    default:
      return 'note'
  }
}

/** Read a JSONL file into rows. */
async function readJsonl<T>(path: string): Promise<T[]> {
  const text = await readFile(path, 'utf8')
  return text.split('\n').filter(line => line.trim().length > 0).map(line => JSON.parse(line) as T)
}

/** Everything the runner was told to do. */
interface Options {
  readonly data: string
  readonly split: string
  readonly mode: Mode
  readonly out: string
  readonly recallLimit: number
  readonly includeEvidence: boolean
  readonly consolidate: boolean
  readonly honourForget: boolean
  readonly embedModel: string
  readonly embedDims: number
  readonly embedCache: string
}

/**
 * Read the command line.
 * @param argv - arguments after the script name.
 * @returns the parsed options.
 * @throws when a required flag is missing.
 */
function parseArgs(argv: readonly string[]): Options {
  const flags = new Map<string, string>()
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] ?? ''
    if (!arg.startsWith('--')) throw new Error(`unexpected argument: ${arg}`)
    const key = arg.slice(2)
    const value = argv[index + 1]
    if (value === undefined || value.startsWith('--')) {
      flags.set(key, 'true')
      continue
    }
    flags.set(key, value)
    index += 1
  }
  const data = flags.get('data')
  const out = flags.get('out')
  if (data === undefined) throw new Error('--data is required')
  if (out === undefined) throw new Error('--out is required')
  const mode = (flags.get('mode') ?? 'memory') as Mode
  if (!['memory', 'all-visible', 'oracle', 'none'].includes(mode)) throw new Error(`bad --mode ${mode}`)
  return {
    data,
    out,
    mode,
    split: flags.get('split') ?? 'test',
    recallLimit: Number(flags.get('recall-limit') ?? 10),
    includeEvidence: flags.get('include-evidence') === 'true',
    honourForget: flags.get('honour-forget') === 'true',
    consolidate: flags.get('consolidate') === 'true',
    embedModel: flags.get('embed-model') ?? '',
    embedDims: Number(flags.get('embed-dims') ?? 1024),
    embedCache: flags.get('embed-cache') ?? '',
  }
}

/**
 * Run one configuration over one split.
 * @param options - the run configuration.
 */
async function main(options: Options): Promise<void> {
  const events = await readJsonl<OsdaEvent>(join(options.data, 'events.jsonl'))
  const tasks = (await readJsonl<OsdaTask>(join(options.data, 'tasks.jsonl')))
    .filter(task => task.split === options.split)
  const gold = new Map((await readJsonl<OsdaGold>(join(options.data, 'gold.jsonl')))
    .map(row => [row.task_id, row]))
  const byId = new Map(events.map(event => [event.event_id, event]))

  const byEpisode = new Map<string, OsdaEvent[]>()
  for (const event of events) {
    const bucket = byEpisode.get(event.episode_id)
    if (bucket === undefined) byEpisode.set(event.episode_id, [event])
    else bucket.push(event)
  }
  const tasksByEpisode = new Map<string, OsdaTask[]>()
  for (const task of tasks) {
    const bucket = tasksByEpisode.get(task.episode_id)
    if (bucket === undefined) tasksByEpisode.set(task.episode_id, [task])
    else bucket.push(task)
  }

  const lines: string[] = []
  let recalls = 0
  let latency = 0
  for (const [episode, episodeTasks] of tasksByEpisode) {
    const ordered = [...(byEpisode.get(episode) ?? [])].sort((a, b) => a.sequence_no - b.sequence_no)
    const pending = [...episodeTasks].sort((a, b) => a.cutoff_sequence_no - b.cutoff_sequence_no)

    const stack = options.mode === 'memory'
      ? await MemoryStack.create({
        recallLimit: options.recallLimit,
        dimensions: 0,
        vectorWeight: 1,
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
                cachePath: options.embedCache,
                batch: 32,
                concurrency: 6,
              },
            }),
      })
      : undefined
    try {
      if (stack !== undefined && options.embedModel !== '') {
        await stack.prewarm([...ordered.map(render), ...episodeTasks.map(task => task.instruction)])
      }
      let cursor = 0
      for (const task of pending) {
        // Advance the clock to this task's cutoff before answering it.
        const upto: BenchDocument[] = []
        while (cursor < ordered.length && (ordered[cursor]?.sequence_no ?? 0) <= task.cutoff_sequence_no) {
          const event = ordered[cursor]!
          upto.push({
            id: event.event_id,
            text: render(event),
            kind: kindOf(event),
            session: event.episode_id,
            turn: event.sequence_no,
            at: Date.parse(event.occurred_at),
          })
          cursor += 1
        }
        if (stack !== undefined && upto.length > 0) await stack.ingest(upto)
        // A forget request is an instruction, not just another line to index.
        // Replaying it through the plugin's own retraction is the only way the
        // forgetting score says anything about the system rather than about luck.
        if (stack !== undefined && options.honourForget) {
          for (const document of upto) {
            const event = byId.get(document.id)
            if (event?.source_type !== 'forget_request') continue
            const target = event.input?.target_event_id
            if (typeof target === 'string') await stack.forgetDocument(target)
          }
          // Supersession is the other half of "do not hand back a stale answer":
          // half the dataset's forbidden ids are previous versions replaced by a
          // later event, not things the user asked to erase.
          for (const document of upto) {
            for (const stale of byId.get(document.id)?.supersedes_event_ids ?? []) {
              await stack.forgetDocument(stale)
            }
          }
        }

        let ids: string[]
        if (options.mode === 'none') {
          ids = []
        } else if (options.mode === 'oracle') {
          const target = gold.get(task.task_id)
          ids = [...new Set([...(target?.required_event_ids ?? []), ...(target?.supporting_event_ids ?? [])])]
        } else if (options.mode === 'all-visible') {
          ids = ordered.filter(event => event.sequence_no <= task.cutoff_sequence_no)
            .map(event => event.event_id)
        } else {
          const retrieved = await stack!.retrieve(task.instruction, Date.parse(task.as_of))
          ids = retrieved.documents
          latency += retrieved.ms
          recalls += 1
        }
        lines.push(JSON.stringify({
          task_id: task.task_id,
          task_type: task.task_type,
          scenario: task.task_id.split('-')[1] ?? '?',
          instruction: task.instruction,
          answer_format: task.answer_format,
          retrieved_event_ids: ids,
          texts: ids.map(id => (byId.get(id) === undefined ? '' : render(byId.get(id)!))),
        }))
      }
    } finally {
      await stack?.dispose()
    }
  }

  await writeFile(options.out, lines.map(line => `${line}\n`).join(''), 'utf8')
  process.stdout.write(
    `osda ${options.mode}${options.includeEvidence ? '+evidence' : ''}`
    + `${options.honourForget ? '+forget' : ''}`
    + `${options.consolidate ? '+graph' : ''}${options.embedModel === '' ? '' : `+${options.embedModel}`}`
    + `  split=${options.split}  tasks=${lines.length}`
    + `${recalls === 0 ? '' : `  ${(latency / recalls).toFixed(1)} ms/recall`}`
    + `  -> ${options.out}\n`,
  )
}

await main(parseArgs(process.argv.slice(2)))
