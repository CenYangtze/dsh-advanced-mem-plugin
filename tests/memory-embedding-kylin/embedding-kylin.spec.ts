import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import MemoryRuntime, { MemoryEmbedderError, normalizeVector } from '../../src/memory/index.ts'
import type { Config as MemoryConfig, MemoryScope } from '../../src/memory/index.ts'
import {
  KylinCoreaiEmbedder,
  PROVIDER_NAME,
  apply,
  parseRunnerOutput,
  providerName,
  resolveRunnerPath,
  vectorFromPayload,
} from '../../src/memory-embedding-kylin/index.ts'
import type { KylinRunner, RunnerResult } from '../../src/memory-embedding-kylin/index.ts'
import { FakeMemoryStore } from '../memory/helpers/fake-store.ts'

const memoryConfig: MemoryConfig = {
  recallLimit: 10,
  profileLimit: 10,
  inferredConfidence: 0.4,
  assertedConfidence: 0.9,
  inferredHalfLifeMs: 1_000_000,
  assertedHalfLifeMs: 0,
  reinforcementRate: 0.3,
  contradictionRate: 0.5,
  retirementFloor: 0.1,
  activationHops: 1,
  activationFalloff: 0.5,
  recordBudget: 100,
  supportWeight: 0,
  duplicateThreshold: 1,
  diversityThreshold: 1,
  vectorWeight: 1,
  safety: {
    redactPrivateKeys: true,
    redactProviderTokens: true,
    redactBearerTokens: true,
    redactSecretAssignments: true,
    rejectSensitivePatterns: false,
    blockedLiterals: [],
  },
}

const workspace: MemoryScope = { kind: 'workspace', workspace: '/repo' }

const providerConfig = {
  enabled: true,
  runnerPath: fileURLToPath(new URL('./embedding-kylin.spec.ts', import.meta.url)),
  model: 'gte-base',
  modelVersion: '2026-09',
  dimensions: 3,
  timeoutMs: 5_000,
  maxOutputBytes: 1_048_576,
  fallback: 'lexical' as const,
}

function responder(stdout: string, stderr = '', code: number | null = 0): KylinRunner {
  return () => Promise.resolve({ stdout, stderr, code })
}

function passingRunner(vector: number[], dim = vector.length): KylinRunner {
  return responder(`{"status":"pass","dim":${dim},"vector":${JSON.stringify(vector)}}`)
}

function expectCode(run: () => unknown, code: string): void {
  let caught: unknown
  try {
    run()
  } catch (error) {
    caught = error
  }
  expect(caught).toMatchObject({ name: 'MemoryEmbedderError', code })
}

async function expectRejectCode(run: Promise<unknown>, code: string): Promise<void> {
  let caught: unknown
  try {
    await run
  } catch (error) {
    caught = error
  }
  expect(caught).toMatchObject({ name: 'MemoryEmbedderError', code })
}

describe('parseRunnerOutput', () => {
  it('takes the first JSON status line and ignores diagnostics', () => {
    const payload = parseRunnerOutput('loading model\n{"status":"pass","dim":2,"vector":[0,1]}\n')
    expect(payload).toEqual({ status: 'pass', dim: 2, vector: [0, 1] })
  })

  it('returns undefined when stdout has no status object', () => {
    expect(parseRunnerOutput('not json\n{"dim":1}\n')).toBeUndefined()
  })

  it('keeps scanning past malformed JSON instead of failing the whole response', () => {
    expect(parseRunnerOutput('{"dim":1\n{"status":"fail","error":"boom"}')).toEqual({ status: 'fail', error: 'boom' })
  })
})

describe('resolveRunnerPath', () => {
  it('lets KYLIN_EMBED_RUNNER override the configured path', () => {
    expect(resolveRunnerPath('/configured', { KYLIN_EMBED_RUNNER: '/from-env' }, '/pkg')).toBe('/from-env')
  })

  it('resolves a relative environment override against the package root', () => {
    expect(resolveRunnerPath('/configured', { KYLIN_EMBED_RUNNER: 'tools/runner' }, '/pkg'))
      .toBe(resolve('/pkg', 'tools/runner'))
  })

  it('resolves a relative path against the package root', () => {
    expect(resolveRunnerPath('native/build/memory_embed_runner', {}, '/pkg'))
      .toBe(resolve('/pkg', 'native', 'build', 'memory_embed_runner'))
  })

  it('keeps an absolute configured path', () => {
    expect(resolveRunnerPath('/usr/bin/memory_embed_runner', {}, '/pkg')).toBe('/usr/bin/memory_embed_runner')
  })

  it('rejects an empty configured path when the environment override is absent', () => {
    expect(() => resolveRunnerPath('', {}, '/pkg')).toThrow(/runnerPath must be non-empty/)
  })
})

describe('providerName', () => {
  it('stamps both model and version so stale vectors are never compared', () => {
    expect(providerName('gte-base', '2026-09')).toBe(`${PROVIDER_NAME}:gte-base@2026-09`)
    expect(providerName('gte-base', '2026-09')).not.toBe(providerName('gte-base', '2026-10'))
  })
})

describe('vectorFromPayload', () => {
  it('reads a finite vector and checks dim against length', () => {
    expect(vectorFromPayload({ status: 'pass', dim: 4, vector: [0.5, 0.5, 0.5, 0.5] })).toEqual([0.5, 0.5, 0.5, 0.5])
  })

  it('rejects a dim that does not match the array', () => {
    expectCode(() => vectorFromPayload({ status: 'pass', dim: 768, vector: [0.5, 0.5, 0.5, 0.5] }), 'invalid-payload')
  })

  it('rejects a model width change', () => {
    expectCode(() => vectorFromPayload({ status: 'pass', dim: 2, vector: [0.1, 0.2] }, 768), 'dimension-mismatch')
  })

  it('rejects an empty vector', () => {
    expectCode(() => vectorFromPayload({ status: 'pass', dim: 0, vector: [] }), 'invalid-payload')
  })

  it('rejects NaN and non-numeric components', () => {
    expectCode(
      () => vectorFromPayload({ status: 'pass', dim: 3, vector: [0.1, Number.NaN, 0.3] }),
      'invalid-payload',
    )
    expectCode(
      () => vectorFromPayload({ status: 'pass', dim: 3, vector: [0.1, '2' as unknown as number, 0.3] }),
      'invalid-payload',
    )
  })
})

describe('KylinCoreaiEmbedder', () => {
  it('embeds in order and L2-normalizes each vector', async () => {
    const embedder = new KylinCoreaiEmbedder(
      providerName('gte-base', '2026-09'),
      3,
      passingRunner([3, 4, 0]),
      5_000,
      1_048_576,
    )
    const [vector] = await embedder.embed(['deploy'])
    expect(vector).toEqual(normalizeVector([3, 4, 0]))
    expect(embedder.name).toBe('kylin-coreai:gte-base@2026-09')
    expect(embedder.dimensions).toBe(3)
  })

  it('processes a batch one text at a time in input order', async () => {
    const seen: string[] = []
    const runner: KylinRunner = (text): Promise<RunnerResult> => {
      seen.push(text)
      return Promise.resolve({ stdout: '{"status":"pass","dim":3,"vector":[0.1,0.2,0.3]}', stderr: '', code: 0 })
    }
    const embedder = new KylinCoreaiEmbedder('kylin-coreai:test@1', 3, runner, 5_000, 1_048_576)
    await embedder.embed(['alpha', 'beta'])
    expect(seen).toEqual(['alpha', 'beta'])
  })

  it('surfaces a timeout instead of silently returning no vector', async () => {
    const runner: KylinRunner = () => Promise.reject(new MemoryEmbedderError('timeout'))
    const embedder = new KylinCoreaiEmbedder('kylin-coreai:test@1', 3, runner, 25, 1_048_576)
    await expectRejectCode(embedder.embed(['slow']), 'timeout')
  })

  it('rejects a non-zero runner exit even when stdout looks successful', async () => {
    const embedder = new KylinCoreaiEmbedder(
      'kylin-coreai:test@1',
      3,
      responder('{"status":"pass","dim":3,"vector":[1,0,0]}', '', 2),
      5_000,
      1_048_576,
    )
    await expectRejectCode(embedder.embed(['deploy']), 'sdk-failure')
  })

  it('rejects a null runner exit code', async () => {
    const embedder = new KylinCoreaiEmbedder(
      'kylin-coreai:test@1',
      3,
      responder('{"status":"pass","dim":3,"vector":[1,0,0]}', '', null),
      5_000,
      1_048_576,
    )
    await expectRejectCode(embedder.embed(['deploy']), 'sdk-failure')
  })

  it('surfaces a malformed runner response without its stderr text', async () => {
    const embedder = new KylinCoreaiEmbedder(
      'kylin-coreai:test@1',
      3,
      responder('boot\nnot json\n', 'secret-stderr-token'),
      5_000,
      1_048_576,
    )
    await expectRejectCode(embedder.embed(['deploy']), 'invalid-payload')
    try {
      await embedder.embed(['deploy'])
    } catch (error) {
      expect(String((error as Error).message)).not.toContain('secret-stderr-token')
    }
  })

  it('surfaces an SDK status failure without its payload text', async () => {
    const embedder = new KylinCoreaiEmbedder(
      'kylin-coreai:test@1',
      3,
      responder('{"status":"fail","error":"secret-payload-token"}', 'secret-stderr-token'),
      5_000,
      1_048_576,
    )
    await expectRejectCode(embedder.embed(['deploy']), 'sdk-failure')
    try {
      await embedder.embed(['deploy'])
    } catch (error) {
      expect(String((error as Error).message)).not.toContain('secret-payload-token')
      expect(String((error as Error).message)).not.toContain('secret-stderr-token')
    }
  })

  it('rejects a width the configured model cannot satisfy', async () => {
    const embedder = new KylinCoreaiEmbedder(
      'kylin-coreai:test@1',
      3,
      passingRunner([0.1, 0.2], 2),
      5_000,
      1_048_576,
    )
    await expectRejectCode(embedder.embed(['deploy']), 'dimension-mismatch')
  })

  it('rejects a zero vector instead of storing a directionless success', async () => {
    const embedder = new KylinCoreaiEmbedder(
      'kylin-coreai:test@1',
      3,
      passingRunner([0, 0, 0]),
      5_000,
      1_048_576,
    )
    await expectRejectCode(embedder.embed(['deploy']), 'invalid-payload')
  })

  it('rejects a vector whose norm overflows', async () => {
    const embedder = new KylinCoreaiEmbedder(
      'kylin-coreai:test@1',
      3,
      passingRunner([1e308, 1e308, 1e308]),
      5_000,
      1_048_576,
    )
    await expectRejectCode(embedder.embed(['deploy']), 'invalid-payload')
  })

  it('rejects empty text before calling the runner', async () => {
    let called = false
    const runner: KylinRunner = () => {
      called = true
      return Promise.resolve({ stdout: '{"status":"pass","dim":3,"vector":[0,1,0]}', stderr: '', code: 0 })
    }
    const embedder = new KylinCoreaiEmbedder('kylin-coreai:test@1', 3, runner, 5_000, 1_048_576)
    await expectRejectCode(embedder.embed(['   ']), 'empty-text')
    expect(called).toBe(false)
  })
})

describe('apply', () => {
  it('mounts the official embedder when the runner path exists on disk', async () => {
    const previous = process.env['KYLIN_EMBED_RUNNER']
    delete process.env['KYLIN_EMBED_RUNNER']
    const ctx = new Context()
    await ctx.plugin(MemoryRuntime, memoryConfig)
    try {
      apply(ctx, providerConfig)
      expect(ctx.memory.embedder?.name).toBe('kylin-coreai:gte-base@2026-09')
      expect(ctx.memory.embedder?.dimensions).toBe(3)
    } finally {
      if (previous === undefined) delete process.env['KYLIN_EMBED_RUNNER']
      else process.env['KYLIN_EMBED_RUNNER'] = previous
    }
  })

  it('does not resolve or mount a runner when disabled', async () => {
    const ctx = new Context()
    await ctx.plugin(MemoryRuntime, memoryConfig)
    apply(ctx, { ...providerConfig, enabled: false, runnerPath: '/no/such/memory_embed_runner' })
    expect(ctx.memory.embedder).toBeUndefined()
  })

  it('mounts an unavailable provider when an enabled runner is missing', async () => {
    const previous = process.env['KYLIN_EMBED_RUNNER']
    delete process.env['KYLIN_EMBED_RUNNER']
    const ctx = new Context()
    await ctx.plugin(MemoryRuntime, memoryConfig)
    try {
      apply(ctx, { ...providerConfig, runnerPath: '/no/such/memory_embed_runner' })
      expect(ctx.memory.embedder?.name).toBe('kylin-coreai:gte-base@2026-09')
      expect(ctx.memory.embedder?.unavailable).toMatchObject({ code: 'not-found' })
    } finally {
      if (previous === undefined) delete process.env['KYLIN_EMBED_RUNNER']
      else process.env['KYLIN_EMBED_RUNNER'] = previous
    }
  })

  it('reports the unavailable provider on recall instead of looking disabled', async () => {
    const previous = process.env['KYLIN_EMBED_RUNNER']
    delete process.env['KYLIN_EMBED_RUNNER']
    const ctx = new Context()
    await ctx.plugin(MemoryRuntime, memoryConfig)
    try {
      ctx.memory.registerStore(new FakeMemoryStore())
      apply(ctx, { ...providerConfig, runnerPath: '/no/such/memory_embed_runner' })
      await ctx.memory.remember({ scope: workspace, kind: 'note', text: 'deploy on friday', fidelity: 'verbatim' })
      const recall = await ctx.memory.recall({ text: 'deploy', scopes: [workspace] })
      expect(recall.mode).toBe('lexical')
      expect(recall.embeddingFailure).toMatchObject({
        provider: 'kylin-coreai:gte-base@2026-09',
        code: 'not-found',
        reason: 'embedding provider runner is unavailable',
      })
    } finally {
      if (previous === undefined) delete process.env['KYLIN_EMBED_RUNNER']
      else process.env['KYLIN_EMBED_RUNNER'] = previous
    }
  })

  it('rejects an enabled provider with an empty runner path', async () => {
    const previous = process.env['KYLIN_EMBED_RUNNER']
    delete process.env['KYLIN_EMBED_RUNNER']
    const ctx = new Context()
    await ctx.plugin(MemoryRuntime, memoryConfig)
    try {
      expect(() => apply(ctx, { ...providerConfig, runnerPath: '   ' })).toThrow(/runnerPath must be non-empty/)
    } finally {
      if (previous === undefined) delete process.env['KYLIN_EMBED_RUNNER']
      else process.env['KYLIN_EMBED_RUNNER'] = previous
    }
  })

  it('rejects a fallback other than lexical', async () => {
    const ctx = new Context()
    await ctx.plugin(MemoryRuntime, memoryConfig)
    expect(() => {
      apply(ctx, { ...providerConfig, fallback: 'hash' as never })
    }).toThrow(/fallback/)
  })

  it('fails loud on a width that cannot produce a usable vector', async () => {
    const ctx = new Context()
    await ctx.plugin(MemoryRuntime, memoryConfig)
    expect(() => {
      apply(ctx, { ...providerConfig, dimensions: 0 })
    }).toThrow(/positive safe integer/)
  })
})

describe('model isolation', () => {
  it('does not compare vectors written by another model version', async () => {
    const store = new FakeMemoryStore()
    const first = new MemoryRuntime(new Context(), memoryConfig)
    first.registerStore(store)
    first.registerEmbedder(new KylinCoreaiEmbedder(
      providerName('gte-base', '2026-09'),
      3,
      passingRunner([1, 0, 0]),
      5_000,
      1_048_576,
    ))
    await first.remember({ scope: workspace, kind: 'note', text: 'deploy on friday', fidelity: 'verbatim' })

    const second = new MemoryRuntime(new Context(), memoryConfig)
    second.registerStore(store)
    second.registerEmbedder(new KylinCoreaiEmbedder(
      providerName('gte-base', '2026-10'),
      3,
      passingRunner([1, 0, 0]),
      5_000,
      1_048_576,
    ))
    const recall = await second.recall({ text: 'deploy', scopes: [workspace] })
    expect(recall.mode).toBe('lexical')
    expect(recall.semantic).toBe(false)
  })
})
