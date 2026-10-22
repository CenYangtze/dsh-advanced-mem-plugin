import { randomUUID } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import { fingerprint } from './datasets.ts'
import { positiveInteger } from './http.ts'
import type { EvaluationAgent, EvaluationAgentFactory, EvaluationCheckpoint, EvaluationDataset, EvaluationJudge, EvaluationManifest, EvaluationReport, EvaluationResult, EvaluationSummary } from './types.ts'

export interface EvaluateOptions {
  readonly dataset: EvaluationDataset
  readonly manifest: EvaluationManifest
  readonly agent: EvaluationAgentFactory
  readonly judge: EvaluationJudge
  readonly checkpoint: EvaluationCheckpoint
  readonly retryFailed: boolean
  readonly signal?: AbortSignal
}

function recall(gold: readonly string[], retrieved: readonly string[] | undefined): number | null {
  if (!gold.length || retrieved === undefined) return null
  const targets = new Set(gold)
  return [...targets].filter(id => retrieved.includes(id)).length / targets.size
}

export function summarizeResults(results: readonly EvaluationResult[]): EvaluationSummary {
  const completed = results.filter(row => row.status === 'completed')
  const metrics: Record<string, { mean: number; count: number }> = {}
  const gradeTotals: Record<string, number> = {}
  const add = (name: string, value: number | null | undefined) => {
    if (value === null || value === undefined) return
    const previous = metrics[name] ?? { mean: 0, count: 0 }
    metrics[name] = { mean: previous.mean + value, count: previous.count + 1 }
  }
  for (const row of completed) {
    if (row.grade) { add(row.grade.metric, row.grade.value); gradeTotals[row.grade.metric] = (gradeTotals[row.grade.metric] ?? 0) + row.grade.value }
    add('message-recall', row.retrieval?.messageRecall)
    add('session-recall', row.retrieval?.sessionRecall)
    add('retrieval-mrr', row.retrieval?.reciprocalRank)
  }
  const metricsIncludingFailures = Object.fromEntries(Object.entries(gradeTotals).map(([name, value]) => [name, results.length ? value / results.length : 0]))
  for (const value of Object.values(metrics)) value.mean /= value.count
  const durations = results.map(row => row.durationMs).sort((a, b) => a - b)
  const quantile = (p: number) => durations[Math.max(0, Math.ceil(durations.length * p) - 1)] ?? 0
  return { total: results.length, completed: completed.length, failed: results.length - completed.length, metrics, metricsIncludingFailures,
    latencyMs: { mean: durations.length ? durations.reduce((a, b) => a + b, 0) / durations.length : 0, p50: quantile(0.5), p95: quantile(0.95) },
    usage: results.reduce((total, row) => ({ inputTokens: total.inputTokens + (row.answer?.usage?.inputTokens ?? 0) + (row.grade?.usage?.inputTokens ?? 0), outputTokens: total.outputTokens + (row.answer?.usage?.outputTokens ?? 0) + (row.grade?.usage?.outputTokens ?? 0) }), { inputTokens: 0, outputTokens: 0 }) }
}

/** Each sample gets a new agent and scope; only the judge sees its reference. */
export async function evaluateDataset(options: EvaluateOptions): Promise<EvaluationReport> {
  const { dataset, manifest, checkpoint } = options
  positiveInteger(manifest.execution.concurrency, 'concurrency')
  positiveInteger(manifest.execution.timeoutMs, 'timeoutMs')
  const expected = { name: dataset.name, revision: dataset.revision, source: dataset.source, fingerprint: dataset.fingerprint }
  if (fingerprint(manifest.dataset) !== fingerprint(expected)) throw new Error('Manifest dataset does not match loaded data')
  if (fingerprint(manifest.sampleIds) !== fingerprint(dataset.cases.map(sample => sample.input.id))) throw new Error('Manifest sample order does not match the selected cases')
  if (!manifest.runId || !manifest.implementationRevision) throw new Error('Run and implementation revisions are required')
  const signal = options.signal ?? new AbortController().signal
  const results = new Map<string, EvaluationResult>()
  try {
    for (const row of await checkpoint.open(manifest)) {
      if (!manifest.sampleIds.includes(row.id)) throw new Error(`Checkpoint contains unknown sample ${row.id}`)
      results.set(row.id, row)
    }
    const pending = dataset.cases.filter(sample => !results.has(sample.input.id) || (options.retryFailed && results.get(sample.input.id)?.status === 'failed'))
    let cursor = 0
    const work = async () => {
      while (cursor < pending.length && !signal.aborted) {
        const sample = pending[cursor++]!
        const startedAt = new Date().toISOString()
        const start = performance.now()
        const attemptSignal = AbortSignal.any([signal, AbortSignal.timeout(manifest.execution.timeoutMs)])
        let agent: EvaluationAgent | undefined
        let result: EvaluationResult
        let answer: EvaluationResult['answer']
        try {
          agent = await options.agent({ namespace: `evaluation:${manifest.runId}:${sample.input.id}:${randomUUID()}`, history: sample.history, signal: attemptSignal })
          answer = await agent.answer(sample.input, attemptSignal)
          attemptSignal.throwIfAborted()
          const grade = await options.judge({ sample, answer, signal: attemptSignal })
          if (!Number.isFinite(grade.value) || grade.value < 0 || grade.value > 1 || !grade.metric) throw new Error('Judge must return a named score in [0,1]')
          const first = answer.retrievedMessageIds?.findIndex(id => sample.evidenceMessageIds.includes(id))
          result = { id: sample.input.id, group: sample.group, status: 'completed', startedAt, durationMs: performance.now() - start, answer, grade,
            retrieval: { messageRecall: recall(sample.evidenceMessageIds, answer.retrievedMessageIds), sessionRecall: recall(sample.evidenceSessionIds, answer.retrievedSessionIds), reciprocalRank: !sample.evidenceMessageIds.length || first === undefined ? null : first < 0 ? 0 : 1 / (first + 1) } }
        } catch (error) {
          result = { id: sample.input.id, group: sample.group, status: 'failed', startedAt, durationMs: performance.now() - start,
            ...(answer ? { answer } : {}), error: error instanceof Error ? error.message : String(error) }
        } finally {
          if (agent) {
            try { await agent.close() } catch (error) {
              result = { id: sample.input.id, group: sample.group, status: 'failed', startedAt, durationMs: performance.now() - start,
                ...(answer ? { answer } : {}), error: `${result!?.error ? `${result!.error}; ` : ''}Agent cleanup failed: ${error instanceof Error ? error.message : String(error)}` }
            }
          }
        }
        await checkpoint.append(result!)
        results.set(sample.input.id, result!)
      }
    }
    const workers = await Promise.allSettled(Array.from({ length: Math.min(manifest.execution.concurrency, pending.length) }, work))
    const failedWorker = workers.find(result => result.status === 'rejected')
    if (failedWorker?.status === 'rejected') throw failedWorker.reason
    const ordered = dataset.cases.flatMap(sample => results.has(sample.input.id) ? [results.get(sample.input.id)!] : [])
    const groups = [...new Set(ordered.map(row => row.group))]
    return { manifest, results: ordered, summary: summarizeResults(ordered), byGroup: Object.fromEntries(groups.map(group => [group, summarizeResults(ordered.filter(row => row.group === group))])), pendingIds: dataset.cases.filter(sample => !results.has(sample.input.id)).map(sample => sample.input.id) }
  } finally { await checkpoint.close() }
}
