/**
 * 银河麒麟 CoreAI embedding provider for the memory hub.
 *
 * This is a thin, real-SDK provider: it spawns `memory_embed_runner`, a small
 * native binary that links `libkysdk-coreai-embedding` and returns one JSON
 * status line with a vector. The subprocess boundary keeps SDK crashes and ABI
 * changes away from the Harness process.
 *
 * The provider is deliberately transport-only. It does not cache vectors and it
 * does not fall back to feature hashing: a failed call is visible to the caller,
 * and the memory hub keeps the record and recalls lexically instead. A cache can
 * be added later only with bounded capacity, model/version isolation and forget
 * propagation; until then, correctness beats an unmeasured hit rate.
 *
 * @module dsh-advanced-mem-plugin/embedding-kylin
 */

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, isAbsolute, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { MemoryEmbedderError, MEMORY_EMBEDDER_FAILURE_REASONS } from '../memory/index.ts'
import type {
  MemoryEmbedder,
  MemoryEmbedderFailure,
  MemoryEmbedderFailureCode,
} from '../memory/index.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'memory-embedding-kylin'

/** The hub this provider mounts on. */
export const inject = ['memory']

/** Stable prefix of the provider name stamped onto every vector. */
export const PROVIDER_NAME = 'kylin-coreai'

/** Deployment choice of runner, model identity, width, budget and degradation. */
export interface Config {
  /**
   * Whether to mount the provider at all. `false` skips runner resolution and
   * registration, so a profile can keep the row configured but disabled.
   */
  enabled: boolean
  /**
   * Path to the compiled `memory_embed_runner`. Relative paths resolve against
   * the package root. `KYLIN_EMBED_RUNNER` overrides this when non-empty.
   */
  runnerPath: string
  /** Model identity, for example the official `gte-base`. */
  model: string
  /**
   * Model weights or protocol revision. It is stamped into the provider name
   * together with {@link Config.model}, so vectors from another version are
   * never compared against this one.
   */
  modelVersion: string
  /** Vector width the runner must return; the official model is 768. */
  dimensions: number
  /** Per-text subprocess timeout in milliseconds. */
  timeoutMs: number
  /**
   * Combined stdout/stderr byte cap for one runner call. A larger output is a
   * malformed runner, not a vector, so the child is killed and the call fails.
   */
  maxOutputBytes: number
  /**
   * What recall does when the SDK is unavailable or fails. Only `lexical` is
   * supported: raw records are still persisted and query-time failures degrade
   * to BM25. The field is required so a profile states that policy explicitly.
   */
  fallback: 'lexical'
}

/** Schemastery validation for {@link Config}. */
export const Config: z<Config> = z.object({
  enabled: z.boolean().required(),
  runnerPath: z.string().required(),
  model: z.string().required(),
  modelVersion: z.string().required(),
  dimensions: z.number().required(),
  timeoutMs: z.number().required(),
  maxOutputBytes: z.number().required(),
  fallback: z.const('lexical').required(),
})

/** JSON status line the runner prints on stdout. */
export interface RunnerPayload {
  status?: string
  dim?: number
  vector?: number[]
  error?: string
  error_code?: number
}

/** What one runner process returned before parsing. */
export interface RunnerResult {
  readonly stdout: string
  readonly stderr: string
  readonly code: number | null
}

/** A text-to-stdout runner, injectable so tests need no native SDK. */
export type KylinRunner = (
  text: string,
  options: {
    readonly timeoutMs: number
    readonly maxOutputBytes: number
    readonly signal?: AbortSignal
  },
) => Promise<RunnerResult>

/** Options shared by the process runner. */
export interface RunnerOptions {
  readonly timeoutMs: number
  readonly maxOutputBytes: number
  readonly signal?: AbortSignal
}

/**
 * Package root so relative `runnerPath` values survive both source tests and a
 * built install under `lib/`.
 */
export function pluginRoot(from = import.meta.url): string {
  return resolve(fileURLToPath(from), '..', '..', '..')
}

/**
 * Resolve which binary to spawn.
 *
 * A non-empty `KYLIN_EMBED_RUNNER` wins over `runnerPath`. Both values are
 * resolved to an absolute path; a relative value is taken from the package
 * root, never from the process working directory. Enabling the provider with
 * neither value set is a configuration error rather than a hidden default.
 * @param configured - `runnerPath` from the profile row.
 * @param env - process environment; `KYLIN_EMBED_RUNNER` wins when non-empty.
 * @param root - package root for relative paths.
 * @returns the absolute runner path.
 * @throws when both the environment override and `runnerPath` are empty.
 */
export function resolveRunnerPath(
  configured: string,
  env: NodeJS.Dict<string> = process.env,
  root = pluginRoot(),
): string {
  const fromEnv = env['KYLIN_EMBED_RUNNER']?.trim()
  if (fromEnv !== undefined && fromEnv.length > 0) {
    return isAbsolute(fromEnv) ? fromEnv : resolve(root, fromEnv)
  }
  const trimmed = configured.trim()
  if (trimmed.length === 0) {
    throw new TypeError(
      'memory-embedding-kylin: runnerPath must be non-empty when KYLIN_EMBED_RUNNER is not set',
    )
  }
  return isAbsolute(trimmed) ? trimmed : resolve(root, trimmed)
}

/**
 * Build the vector identity stamped onto every record. Including the model and
 * version here is what stops a re-embedding after a model change from being
 * compared against stale vectors.
 * @param model - model identity from the profile.
 * @param version - model weights or protocol revision.
 * @returns the provider name used by {@link MemoryEmbedder.name}.
 */
export function providerName(model: string, version: string): string {
  return `${PROVIDER_NAME}:${model.trim()}@${version.trim()}`
}

/**
 * Parse the first JSON status line from the runner's stdout. Diagnostic lines
 * before it are ignored; a JSON object without `status` is not a payload.
 * @param stdout - the child's complete standard output.
 * @returns the payload, or `undefined` when no status object was printed.
 */
export function parseRunnerOutput(stdout: string): RunnerPayload | undefined {
  for (const line of stdout.split('\n')) {
    const candidate = line.trim()
    if (!candidate.startsWith('{')) continue
    try {
      const decoded = JSON.parse(candidate) as RunnerPayload
      if (typeof decoded === 'object' && decoded !== null && 'status' in decoded) return decoded
    } catch {
      // A diagnostic or partially written line is not the status payload.
    }
  }
  return undefined
}

/**
 * Read a finite vector out of a successful runner payload.
 * @param payload - the decoded status line.
 * @param expectedDimensions - configured width, when the caller knows it.
 * @returns the raw vector in runner order.
 * @throws when the payload is empty, non-finite, or a different width.
 */
export function vectorFromPayload(payload: RunnerPayload, expectedDimensions?: number): number[] {
  const raw = payload.vector
  const dim = payload.dim
  if (!Array.isArray(raw) || typeof dim !== 'number') {
    throw new MemoryEmbedderError('invalid-payload')
  }
  if (!Number.isSafeInteger(dim) || dim < 1 || raw.length < 1) {
    throw new MemoryEmbedderError('invalid-payload')
  }
  if (raw.length !== dim) {
    throw new MemoryEmbedderError('invalid-payload')
  }
  if (expectedDimensions !== undefined && dim !== expectedDimensions) {
    throw new MemoryEmbedderError('dimension-mismatch')
  }
  const vector: number[] = new Array(raw.length)
  for (let index = 0; index < raw.length; index++) {
    const value = raw[index]
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new MemoryEmbedderError('invalid-payload')
    }
    vector[index] = value
  }
  return vector
}

/**
 * Normalize a vector, rejecting zero direction and overflow instead of passing
 * a degenerate vector into recall. A norm that reaches infinity would otherwise
 * turn every component into zero (or a NaN product) and poison comparisons.
 * @param vector - finite raw components from the runner.
 * @returns the L2-normalized vector.
 * @throws {@link MemoryEmbedderError} with `invalid-payload` when unusable.
 */
function normalizeChecked(vector: readonly number[]): number[] {
  let norm = 0
  let nonZero = false
  for (const component of vector) {
    if (!Number.isFinite(component)) throw new MemoryEmbedderError('invalid-payload')
    if (component !== 0) nonZero = true
    norm += component * component
    if (!Number.isFinite(norm)) throw new MemoryEmbedderError('invalid-payload')
  }
  if (!nonZero || norm <= 0) throw new MemoryEmbedderError('invalid-payload')
  const scale = 1 / Math.sqrt(norm)
  const normalized = vector.map(component => component * scale)
  if (!normalized.every(component => Number.isFinite(component))) {
    throw new MemoryEmbedderError('invalid-payload')
  }
  return normalized
}
/**
 * Spawn the native runner for one text. Kept separate from payload parsing so
 * tests can supply a fake runner while production exercises the real process
 * boundary.
 * @param runnerPath - absolute path to `memory_embed_runner`.
 * @param text - the text to embed; passed as `argv[1]`.
 * @param options - timeout, output cap and cancellation.
 * @returns stdout, stderr and the exit code.
 */
export function runProcess(
  runnerPath: string,
  text: string,
  options: RunnerOptions,
): Promise<RunnerResult> {
  return new Promise((resolvePromise, rejectPromise) => {
    if (text.includes('\0')) {
      rejectPromise(new MemoryEmbedderError('invalid-text'))
      return
    }
    let stdout = ''
    let stderr = ''
    let bytes = 0
    let settled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const child = spawn(runnerPath, [text], {
      cwd: dirname(runnerPath),
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')

    const finish = (work: () => void): void => {
      if (settled) return
      settled = true
      if (timer !== undefined) clearTimeout(timer)
      options.signal?.removeEventListener('abort', abortHandler)
      work()
    }
    const abortHandler = (): void => {
      child.kill('SIGKILL')
      finish(() => rejectPromise(new MemoryEmbedderError('aborted')))
    }

    child.stdout.on('data', (chunk: string) => {
      if (settled) return
      bytes += Buffer.byteLength(chunk, 'utf8')
      if (bytes > options.maxOutputBytes) {
        child.kill('SIGKILL')
        finish(() => rejectPromise(new MemoryEmbedderError('output-limit')))
        return
      }
      stdout += chunk
    })
    child.stderr.on('data', (chunk: string) => {
      if (settled) return
      bytes += Buffer.byteLength(chunk, 'utf8')
      if (bytes > options.maxOutputBytes) {
        child.kill('SIGKILL')
        finish(() => rejectPromise(new MemoryEmbedderError('output-limit')))
        return
      }
      stderr += chunk
    })
    child.on('error', error => {
      const code = (error as NodeJS.ErrnoException).code
      finish(() => rejectPromise(
        new MemoryEmbedderError(code === 'ENOENT' ? 'not-found' : 'sdk-failure'),
      ))
    })
    child.on('close', code => {
      finish(() => {
        if (options.signal?.aborted) {
          rejectPromise(new MemoryEmbedderError('aborted'))
          return
        }
        resolvePromise({ stdout, stderr, code })
      })
    })

    timer = setTimeout(() => {
      child.kill('SIGKILL')
      finish(() => rejectPromise(new MemoryEmbedderError('timeout')))
    }, options.timeoutMs)
    if (options.signal?.aborted) abortHandler()
    else options.signal?.addEventListener('abort', abortHandler, { once: true })
  })
}

/**
 * Bind {@link runProcess} to a configured binary.
 * @param runnerPath - absolute path to `memory_embed_runner`.
 * @returns a runner usable by {@link KylinCoreaiEmbedder}.
 */
export function processRunner(runnerPath: string): KylinRunner {
  return (text, options) => runProcess(runnerPath, text, options)
}

/**
 * The provider: one subprocess per text, L2-normalized to match the hub
 * contract. Input within one call is processed sequentially; concurrent calls
 * are not globally bounded in this phase.
 */
export class KylinCoreaiEmbedder implements MemoryEmbedder {
  /**
   * @param name - provider identity, including model and version.
   * @param dimensions - configured vector width.
   * @param runner - text-to-runner transport.
   * @param timeoutMs - per-text timeout.
   * @param maxOutputBytes - per-call output cap.
   */
  constructor(
    readonly name: string,
    readonly dimensions: number,
    private readonly runner: KylinRunner,
    private readonly timeoutMs: number,
    private readonly maxOutputBytes: number,
  ) {}

  /**
   * Embed a batch, one runner process at a time.
   * @param texts - texts to embed, in order.
   * @param options - optional batch cancellation.
   * @returns one L2-normalized vector per text, in order.
   */
  async embed(
    texts: readonly string[],
    options?: { readonly signal?: AbortSignal },
  ): Promise<readonly (readonly number[])[]> {
    const vectors: number[][] = []
    for (const text of texts) {
      if (text.trim().length === 0) throw new MemoryEmbedderError('empty-text')
      let result: RunnerResult
      try {
        result = await this.runner(text, {
          timeoutMs: this.timeoutMs,
          maxOutputBytes: this.maxOutputBytes,
          ...(options?.signal === undefined ? {} : { signal: options.signal }),
        })
      } catch (error) {
        // A transport failure must not expose its message; known provider errors
        // keep their category, everything else becomes a fixed SDK failure.
        throw error instanceof MemoryEmbedderError ? error : new MemoryEmbedderError('sdk-failure')
      }
      if (result.code === null || result.code !== 0) {
        throw new MemoryEmbedderError('sdk-failure')
      }
      const payload = parseRunnerOutput(result.stdout)
      if (payload === undefined) throw new MemoryEmbedderError('invalid-payload')
      if (payload.status !== 'pass') throw new MemoryEmbedderError('sdk-failure')
      const vector = vectorFromPayload(payload, this.dimensions)
      vectors.push(normalizeChecked(vector))
    }
    return vectors
  }
}

/**
 * A mounted-but-unusable provider. It records the failure category so recall can
 * tell an intentionally disabled embedder from a configured runner that is
 * missing, without spawning a process or falling back to feature hashing.
 */
export class UnavailableKylinEmbedder implements MemoryEmbedder {
  /** Fixed failure category reported by recall. */
  readonly unavailable: MemoryEmbedderFailure

  /**
   * @param name - provider identity, including model and version.
   * @param dimensions - configured vector width.
   * @param code - safe failure category, usually `not-found`.
   */
  constructor(
    readonly name: string,
    readonly dimensions: number,
    code: MemoryEmbedderFailureCode = 'not-found',
  ) {
    this.unavailable = { code, reason: MEMORY_EMBEDDER_FAILURE_REASONS[code] }
  }

  /**
   * Always fails with the category carried by {@link unavailable}; the hub skips
   * this call for capture and reports the category on recall.
   * @returns never resolves.
   */
  embed(): Promise<never> {
    return Promise.reject(new MemoryEmbedderError(this.unavailable.code))
  }
}

/**
 * Mount the official embedder when enabled and the runner binary is present.
 * A missing runner mounts an unavailable provider: recall stays lexical but
 * reports `not-found`, so enabled-but-missing is distinguishable from disabled.
 * @param ctx - registrant context carrying the hub.
 * @param config - runner, model identity, width, budget and degradation policy.
 * @throws when a configured tunable cannot produce a usable vector, or when
 * `enabled` is true and neither `runnerPath` nor `KYLIN_EMBED_RUNNER` is set.
 */
export function apply(ctx: Context, config: Config): void {
  if (!Number.isSafeInteger(config.dimensions) || config.dimensions < 1) {
    throw new TypeError(
      `memory-embedding-kylin: dimensions must be a positive safe integer, got ${String(config.dimensions)}`,
    )
  }
  if (!Number.isSafeInteger(config.maxOutputBytes) || config.maxOutputBytes < 1) {
    throw new TypeError(
      `memory-embedding-kylin: maxOutputBytes must be a positive safe integer, got ${String(config.maxOutputBytes)}`,
    )
  }
  if (!Number.isFinite(config.timeoutMs) || config.timeoutMs <= 0) {
    throw new TypeError(
      `memory-embedding-kylin: timeoutMs must be a positive finite number, got ${String(config.timeoutMs)}`,
    )
  }
  if (config.model.trim().length === 0 || config.modelVersion.trim().length === 0) {
    throw new TypeError('memory-embedding-kylin: model and modelVersion must be non-empty')
  }
  if (config.fallback !== 'lexical') {
    throw new TypeError(
      `memory-embedding-kylin: fallback must be 'lexical', got ${String(config.fallback)}`,
    )
  }
  if (!config.enabled) return

  const runnerPath = resolveRunnerPath(config.runnerPath)
  if (!existsSync(runnerPath)) {
    ctx.logger.warn(
      'memory-embedding-kylin: runner not found; recall will report a lexical fallback with code not-found',
    )
    ctx.effect(() => ctx.memory.registerEmbedder(new UnavailableKylinEmbedder(
      providerName(config.model, config.modelVersion),
      config.dimensions,
      'not-found',
    )))
    return
  }
  ctx.effect(() => {
    return ctx.memory.registerEmbedder(new KylinCoreaiEmbedder(
      providerName(config.model, config.modelVersion),
      config.dimensions,
      processRunner(runnerPath),
      config.timeoutMs,
      config.maxOutputBytes,
    ))
  })
}
