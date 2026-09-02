/**
 * Reader for the KylinMem development-scenario benchmark.
 *
 * The dataset ships one JSONL instance per line: a *history session* (a solved
 * issue, as an event chain), the *gold memory* distilled from it, and a *target
 * task* from the same repository that the history is supposed to help with. The
 * shape is documented in the dataset's own README; this module only mirrors the
 * fields a memory system is scored on, and repairs the two places where the
 * published batch does not match its documented schema.
 *
 * @module dsh-advanced-mem-plugin/bench/dataset
 */

import { readFile } from 'node:fs/promises'

/** One event in a history session, as the dataset records it. */
export interface KylinEvent {
  readonly event_id: string
  readonly type: 'observation' | 'tool_call' | 'test'
  readonly step: number
  readonly content: string
  readonly tool?: string
  readonly tool_input?: string
  readonly result?: string
  readonly success?: boolean
}

/** The layer-1 belief the dataset expects a memory system to end up holding. */
export interface KylinGoldMemory {
  readonly memory_id: string
  readonly type: 'preference' | 'workflow' | 'repo_gotcha' | 'env_gotcha' | 'skill' | 'knowledge_update'
  readonly content: string
  readonly source_event_ids: readonly string[]
}

/** One benchmark instance. */
export interface KylinInstance {
  readonly instance_id: string
  readonly repo: string
  readonly language: string
  readonly history_session: {
    readonly session_id: string
    readonly issue: string
    readonly events: readonly KylinEvent[]
    readonly evidence_ids: readonly string[]
    readonly outcome: string
  }
  readonly gold_memory: KylinGoldMemory
  readonly target_task: {
    readonly task_id: string
    readonly problem_statement: string
    readonly no_leak_note: string
    readonly harder_without_memory: boolean
  }
  readonly evaluator: {
    readonly inherited_from: string
    readonly type?: string
    readonly fail_to_pass: readonly string[]
    readonly pass_to_pass: readonly string[]
  }
}

/** What `loadInstances` had to repair, so a run can report the dataset's state honestly. */
export interface DatasetHealth {
  /** Lines that did not parse as JSON at all. */
  readonly unparsable: number
  /** Instances whose `fail_to_pass`/`pass_to_pass` arrived as a character list and were rejoined. */
  readonly repairedTestLists: number
  /** Instances that still carry no usable test names, so layer-2 scoring cannot run on them. */
  readonly withoutTestNames: number
}

/**
 * Repair a test-name list that was serialized as a JSON string and then iterated.
 *
 * The published batch stores `FAIL_TO_PASS` as `["[", "\"", "a", ...]` — the
 * ingest pipeline treated a JSON *string* as a sequence and sliced it into
 * characters. The information is not lost, only shredded: rejoining the
 * characters reproduces the original JSON text.
 * @param value - the list as it appears in the file.
 * @returns the recovered test names, or an empty list when nothing is recoverable.
 */
export function repairTestList(value: unknown): { readonly names: string[]; readonly repaired: boolean } {
  const encoded = typeof value === 'string'
    ? value
    // The other shape the same bug produces: the string iterated into its own
    // characters by a pipeline stage that expected a list.
    : Array.isArray(value) && value.every(item => typeof item === 'string' && item.length <= 1)
      ? value.join('')
      : undefined
  if (encoded === undefined) {
    if (!Array.isArray(value)) return { names: [], repaired: false }
    return { names: value.filter((item): item is string => typeof item === 'string'), repaired: false }
  }
  try {
    const parsed: unknown = JSON.parse(encoded)
    if (!Array.isArray(parsed)) return { names: [], repaired: true }
    return { names: parsed.filter((item): item is string => typeof item === 'string'), repaired: true }
  } catch {
    return { names: [], repaired: true }
  }
}

/**
 * Read a KylinMem instance file.
 *
 * Reads the whole file: the published batch is 34 MB, which is cheaper to hold
 * than to stream, and every downstream stage needs random access to it anyway.
 * @param path - the `.jsonl` instance file.
 * @returns the instances, and what had to be repaired to produce them.
 */
export async function loadInstances(
  path: string,
): Promise<{ readonly instances: KylinInstance[]; readonly health: DatasetHealth }> {
  const text = await readFile(path, 'utf8')
  const instances: KylinInstance[] = []
  let unparsable = 0
  let repairedTestLists = 0
  let withoutTestNames = 0
  for (const line of text.split('\n')) {
    if (line.trim().length === 0) continue
    let row: Record<string, unknown>
    try {
      row = JSON.parse(line) as Record<string, unknown>
    } catch {
      unparsable += 1
      continue
    }
    const evaluator = (row['evaluator'] ?? {}) as Record<string, unknown>
    const f2p = repairTestList(evaluator['fail_to_pass'])
    const p2p = repairTestList(evaluator['pass_to_pass'])
    if (f2p.repaired || p2p.repaired) repairedTestLists += 1
    if (f2p.names.length === 0) withoutTestNames += 1
    instances.push({
      ...(row as unknown as KylinInstance),
      evaluator: {
        inherited_from: String(evaluator['inherited_from'] ?? ''),
        fail_to_pass: f2p.names,
        pass_to_pass: p2p.names,
      },
    })
  }
  return { instances, health: { unparsable, repairedTestLists, withoutTestNames } }
}

/**
 * Take a reproducible subset, spread across repositories rather than truncated.
 *
 * A plain `slice` would hand back 94 astropy instances and nothing else, because
 * the file is grouped by repository. Round-robin keeps the repository mix of the
 * full set, which is what makes a subsampled score comparable to a full one.
 * @param instances - the full set.
 * @param limit - how many to keep; `0` keeps everything.
 * @returns the subset, in the file's original order.
 */
export function subsample(instances: readonly KylinInstance[], limit: number): KylinInstance[] {
  if (limit <= 0 || limit >= instances.length) return [...instances]
  const byRepo = new Map<string, KylinInstance[]>()
  for (const instance of instances) {
    const bucket = byRepo.get(instance.repo)
    if (bucket === undefined) byRepo.set(instance.repo, [instance])
    else bucket.push(instance)
  }
  const queues = [...byRepo.values()]
  const kept = new Set<string>()
  let index = 0
  while (kept.size < limit) {
    const queue = queues[index % queues.length]
    index += 1
    if (queue === undefined) break
    const next = queue.shift()
    if (next !== undefined) kept.add(next.instance_id)
    if (queues.every(q => q.length === 0)) break
  }
  return instances.filter(instance => kept.has(instance.instance_id))
}
