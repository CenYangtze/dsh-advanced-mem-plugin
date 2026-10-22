import { readFile, mkdir, open, rename, unlink } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { z } from 'zod'
import { fingerprint } from './datasets.ts'
import type { DatasetOptions } from './datasets.ts'
import type { ApiClient, ApiContent } from './http.ts'
import { positiveInteger } from './http.ts'
import { evaluateDataset } from './runner.ts'
import type { EvaluateOptions } from './runner.ts'
import type { EvaluationDataset, EvaluationMemoryFactory, EvaluationReport } from './types.ts'

export interface OSWorldTask { readonly id: string; readonly domain: string; readonly instruction: string; readonly configuration: Readonly<Record<string, unknown>> }
export interface OSWorldDataset { readonly dataset: EvaluationDataset; readonly tasks: readonly OSWorldTask[] }
export interface OSWorldObservation { readonly screenshot?: string; readonly accessibilityTree: string; readonly terminal: string }
export interface OSWorldEnvironment {
  reset(task: OSWorldTask, signal: AbortSignal): Promise<OSWorldObservation>
  step(action: string, signal: AbortSignal): Promise<{ readonly observation: OSWorldObservation; readonly done: boolean }>
  evaluate(signal: AbortSignal): Promise<number>
  close(): Promise<void>
}
export interface OSWorldStep { readonly action: string; readonly summary: string; readonly observation: OSWorldObservation; readonly done: boolean }
export interface OSWorldTrajectory { readonly taskId: string; readonly instruction: string; readonly steps: readonly OSWorldStep[]; readonly score: number; readonly startedAt: number; readonly completedAt: number }

const observationSchema = z.object({ accessibilityTree: z.string(), terminal: z.string(), screenshot: z.string().optional() })
const stepSchema = z.object({ observation: observationSchema, done: z.boolean() })
const scoreSchema = z.object({ score: z.number().min(0).max(1) })
const closedSchema = z.object({ closed: z.literal(true) })

function observation(value: z.infer<typeof observationSchema>): OSWorldObservation {
  return { accessibilityTree: value.accessibilityTree, terminal: value.terminal, ...(value.screenshot === undefined ? {} : { screenshot: value.screenshot }) }
}

/** Publish complete snapshots; an interrupted replacement leaves the previous trajectory intact. */
async function writeTrajectory(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`
  try {
    const output = await open(temporary, 'wx')
    try { await output.writeFile(JSON.stringify(value), 'utf8'); await output.sync() }
    finally { await output.close() }
    await rename(temporary, path)
  } finally {
    try { await unlink(temporary) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  }
}

/** Official evaluation_examples/test_all.json plus examples/<domain>/<id>.json. */
export async function loadOSWorld(directory: string, selectionPath: string, options: DatasetOptions & { readonly at: number }): Promise<OSWorldDataset> {
  if (!Number.isFinite(options.at)) throw new Error('OSWorld evaluation clock must be finite')
  const selection = JSON.parse(await readFile(selectionPath, 'utf8')) as unknown
  if (!selection || typeof selection !== 'object' || Array.isArray(selection)) throw new Error('OSWorld selection must map domains to task IDs')
  const tasks: OSWorldTask[] = []
  for (const [domain, ids] of Object.entries(selection)) {
    if (!/^[a-zA-Z0-9_-]+$/.test(domain) || !Array.isArray(ids)) throw new Error('Invalid OSWorld domain selection')
    for (const id of ids) {
      if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error('Invalid OSWorld task ID')
      const configuration = JSON.parse(await readFile(join(directory, 'examples', domain, `${id}.json`), 'utf8')) as Record<string, unknown>
      if (configuration.id !== id || typeof configuration.instruction !== 'string' || !configuration.evaluator) throw new Error(`Invalid OSWorld task ${id}`)
      tasks.push({ id, domain, instruction: configuration.instruction, configuration })
    }
  }
  if (new Set(tasks.map(task => task.id)).size !== tasks.length) throw new Error('OSWorld selection repeats a task')
  return { tasks, dataset: { name: 'osworld', revision: options.revision, source: options.source, fingerprint: fingerprint(tasks), cases: tasks.map(task => ({ input: { id: task.id, question: task.instruction, at: options.at }, group: task.domain, history: [], reference: '', abstention: false, evidenceMessageIds: [], evidenceSessionIds: [] })) } }
}

/** A leased bridge owns one real DesktopEnv instance. No action requests are retried. */
export class HttpOSWorldEnvironment implements OSWorldEnvironment {
  constructor(private readonly options: { readonly baseUrl: string; readonly apiKey: string; readonly namespace: string; readonly timeoutMs: number; readonly maxResponseBytes: number }) {
    positiveInteger(options.timeoutMs, 'OSWorld timeoutMs')
    positiveInteger(options.maxResponseBytes, 'OSWorld maxResponseBytes')
  }
  private async request(path: string, body: Readonly<Record<string, unknown>>, signal: AbortSignal): Promise<unknown> {
    const response = await fetch(`${this.options.baseUrl.replace(/\/$/, '')}/${path}`, { method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.options.apiKey}` },
      body: JSON.stringify({ lease: this.options.namespace, ...body }), signal: AbortSignal.any([signal, AbortSignal.timeout(this.options.timeoutMs)]) })
    if (!response.ok) { await response.body?.cancel(); throw new Error(`OSWorld bridge ${path}: HTTP ${response.status}`) }
    if (!response.body) throw new Error(`OSWorld bridge ${path}: empty response body`)
    const reader = response.body.getReader()
    const chunks: Uint8Array[] = []
    let bytes = 0
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        bytes += value.byteLength
        if (bytes > this.options.maxResponseBytes) throw new Error(`OSWorld bridge ${path}: response exceeds maxResponseBytes`)
        chunks.push(value)
      }
    } finally { await reader.cancel(); reader.releaseLock() }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  }
  async reset(task: OSWorldTask, signal: AbortSignal): Promise<OSWorldObservation> {
    return observation(observationSchema.parse(await this.request('reset', { task: task.configuration }, signal)))
  }
  async step(action: string, signal: AbortSignal): Promise<{ readonly observation: OSWorldObservation; readonly done: boolean }> {
    const result = stepSchema.parse(await this.request('step', { action }, signal))
    return { observation: observation(result.observation), done: result.done }
  }
  async evaluate(signal: AbortSignal): Promise<number> {
    return scoreSchema.parse(await this.request('evaluate', {}, signal)).score
  }
  async close(): Promise<void> { closedSchema.parse(await this.request('close', {}, new AbortController().signal)) }
}

export interface RunOSWorldOptions extends Omit<EvaluateOptions, 'dataset' | 'agent' | 'judge'> {
  readonly data: OSWorldDataset
  readonly client: ApiClient
  readonly memory: EvaluationMemoryFactory
  readonly environment: (namespace: string) => Promise<OSWorldEnvironment>
  readonly maxSteps: number
  readonly historySteps: number
  readonly maxObservationChars: number
  readonly includeScreenshot: boolean
  readonly systemPrompt: string
  readonly trajectoryDirectory: string
}

/** Frozen evaluation: the official evaluator runs once, after all agent actions. */
export async function runOSWorld(options: RunOSWorldOptions): Promise<EvaluationReport> {
  for (const field of ['maxSteps', 'historySteps', 'maxObservationChars'] as const) positiveInteger(options[field], field)
  if (options.manifest.protocol !== 'osworld-frozen-v1') throw new Error('OSWorld requires the frozen evaluation protocol')
  await mkdir(options.trajectoryDirectory, { recursive: true })
  const tasks = new Map(options.data.tasks.map(task => [task.id, task]))
  const manifest = { ...options.manifest, agent: { ...options.manifest.agent, osworld: { maxSteps: options.maxSteps, historySteps: options.historySteps,
    maxObservationChars: options.maxObservationChars, includeScreenshot: options.includeScreenshot, systemPrompt: options.systemPrompt } } }
  return evaluateDataset({ ...options, manifest, dataset: options.data.dataset,
    judge: async ({ answer }) => {
      if (!answer.environmentResult) throw new Error('Missing official environment evaluation')
      return { metric: 'osworld-task-score', value: answer.environmentResult.score }
    },
    agent: async input => {
      const memory = await options.memory(input)
      let env: OSWorldEnvironment
      try { env = await options.environment(input.namespace) } catch (error) { await memory.close(); throw error }
      return {
        async answer(question, signal) {
          const task = tasks.get(question.id)
          if (!task) throw new Error('Unknown OSWorld task')
          const startedAt = Date.now()
          const context = await memory.recall(question, signal)
          let observation = await env.reset(task, signal)
          const initial = observation
          const trajectory: OSWorldStep[] = []
          const usage = { inputTokens: 0, outputTokens: 0 }
          let done = false
          // One file per attempt; each published snapshot is complete.
          const output = join(options.trajectoryDirectory, `${fingerprint(input.namespace)}.json`)
          await writeTrajectory(output, { taskId: task.id, namespace: input.namespace, instruction: task.instruction, startedAt, initial, steps: trajectory })
          for (let step = 0; step < options.maxSteps && !done; step++) {
            signal.throwIfAborted()
            const content: ApiContent = [
              { type: 'text', text: JSON.stringify({ instruction: task.instruction, memory: context.text,
                recentActions: trajectory.slice(-options.historySteps).map(row => ({ action: row.action, summary: row.summary })),
                accessibilityTree: observation.accessibilityTree.slice(0, options.maxObservationChars), terminal: observation.terminal.slice(0, options.maxObservationChars) }) },
              ...(options.includeScreenshot && observation.screenshot ? [{ type: 'image_url' as const, image_url: { url: observation.screenshot } }] : []),
            ]
            const completion = await options.client.complete([{ role: 'system', content: `${options.systemPrompt}\nReturn only JSON: {"action": "Python pyautogui code or DONE or FAIL or WAIT", "summary": "short observable action description"}.` }, { role: 'user', content }], signal)
            usage.inputTokens += completion.usage.inputTokens; usage.outputTokens += completion.usage.outputTokens
            const action = JSON.parse(completion.text) as { action?: unknown; summary?: unknown }
            if (typeof action.action !== 'string' || !action.action.trim() || typeof action.summary !== 'string') throw new Error('OSWorld agent returned malformed action JSON')
            const next = await env.step(action.action, signal)
            done = next.done
            observation = next.observation
            trajectory.push({ action: action.action, summary: action.summary, observation, done })
            await writeTrajectory(output, { taskId: task.id, namespace: input.namespace, instruction: task.instruction, startedAt, initial, steps: trajectory })
          }
          const score = await env.evaluate(signal)
          const completed: OSWorldTrajectory = { taskId: task.id, instruction: task.instruction, steps: trajectory, score, startedAt, completedAt: Date.now() }
          await writeTrajectory(output, { ...completed, namespace: input.namespace, initial })
          return { text: trajectory[trajectory.length - 1]?.summary ?? '', usage, retrievedMessageIds: context.messageIds, retrievedSessionIds: context.sessionIds,
            environmentResult: { score, steps: trajectory.length, terminated: done } }
        },
        async close() { try { await env.close() } finally { await memory.close() } },
      }
    },
  })
}
