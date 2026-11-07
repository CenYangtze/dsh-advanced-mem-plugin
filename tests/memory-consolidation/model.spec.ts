import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Session } from '@deepseek-ai/dsh-session'
import {
  SemanticRequestError,
  createHarnessSemanticModel,
  memoryModelRoute,
  resolveSemanticRoute,
} from '../../src/memory-consolidation/model.ts'

const route = { provider: 'provider-a', model: 'model-a' }

function controls(overrides: Partial<{
  temperature: number
  maxTokens: number
  timeoutMs: number
  maxResponseBytes: number
  maxInputCharacters: number
  promptVersion: string
}> = {}) {
  return {
    temperature: 0,
    maxTokens: 100,
    timeoutMs: 5_000,
    maxResponseBytes: 1_000,
    maxInputCharacters: 1_000,
    promptVersion: 'semantic-test',
    ...overrides,
  }
}

function contextWithStream(stream: (options: { signal?: AbortSignal }) => AsyncIterable<unknown>): Context {
  return { llm: { stream } } as unknown as Context
}

async function* yielding(items: readonly unknown[]): AsyncGenerator<unknown> {
  for (const item of items) yield item
}

async function expectCode(promise: Promise<unknown>, code: string): Promise<void> {
  let caught: unknown
  try {
    await promise
  } catch (error) {
    caught = error
  }
  expect(caught).toBeInstanceOf(SemanticRequestError)
  expect((caught as SemanticRequestError).code).toBe(code)
}

describe('createHarnessSemanticModel', () => {
  it('collects text and host-reported token usage on a stop finish', async () => {
    const ctx = contextWithStream(() => yielding([
      { type: 'text-delta', index: 0, text: '{"candidates":' },
      { type: 'text-delta', index: 0, text: '[]}' },
      { type: 'usage', usage: { inputTokens: 12, outputTokens: 3 } },
      { type: 'finish', reason: { kind: 'stop' } },
    ]))
    const result = await createHarnessSemanticModel(ctx, route, controls()).complete('system', 'payload')
    expect(result.text).toBe('{"candidates":[]}')
    expect(result.usage).toMatchObject({ inputTokens: 12, outputTokens: 3 })
  })

  it('rejects truncation instead of accepting a partial object', async () => {
    const ctx = contextWithStream(() => yielding([
      { type: 'text-delta', index: 0, text: '{"candidates":[' },
      { type: 'finish', reason: { kind: 'max-tokens' } },
    ]))
    await expectCode(createHarnessSemanticModel(ctx, route, controls()).complete('system', 'payload'), 'truncated')
  })

  it('rejects a tool call, since the request provides no tools', async () => {
    let observed: AbortSignal | undefined
    const ctx = contextWithStream((options) => {
      observed = options.signal
      return yielding([{ type: 'block-start', index: 0, blockType: 'tool-call' }])
    })
    await expectCode(createHarnessSemanticModel(ctx, route, controls()).complete('system', 'payload'), 'tool-call')
    expect(observed?.aborted).toBe(true)
  })

  it('stops at the response byte ceiling', async () => {
    const ctx = contextWithStream(() => yielding([
      { type: 'text-delta', index: 0, text: 'x'.repeat(64) },
    ]))
    await expectCode(
      createHarnessSemanticModel(ctx, route, controls({ maxResponseBytes: 8 })).complete('system', 'payload'),
      'output-limit',
    )
  })

  it('reports a timeout when the stream waits on its signal', async () => {
    const ctx = contextWithStream(options => (async function* () {
      await new Promise((_resolve, reject) => {
        if (options.signal?.aborted) { reject(options.signal.reason); return }
        options.signal?.addEventListener('abort', () => reject(options.signal?.reason), { once: true })
      })
    })())
    await expectCode(
      createHarnessSemanticModel(ctx, route, controls({ timeoutMs: 5 })).complete('system', 'payload'),
      'timeout',
    )
  })

  it('reports caller cancellation as aborted', async () => {
    const controller = new AbortController()
    const ctx = contextWithStream(options => (async function* () {
      await new Promise((_resolve, reject) => {
        if (options.signal?.aborted) { reject(options.signal.reason); return }
        options.signal?.addEventListener('abort', () => reject(options.signal?.reason), { once: true })
      })
    })())
    const pending = createHarnessSemanticModel(ctx, route, controls()).complete('system', 'payload', controller.signal)
    controller.abort()
    await expectCode(pending, 'aborted')
  })

  it('rejects input above the configured character budget before streaming', async () => {
    let called = false
    const ctx = contextWithStream(() => {
      called = true
      return yielding([])
    })
    await expectCode(
      createHarnessSemanticModel(ctx, route, controls({ maxInputCharacters: 3 })).complete('system', 'long payload'),
      'provider-failed',
    )
    expect(called).toBe(false)
  })
})

describe('resolveSemanticRoute', () => {
  it('uses the session projection next model first', () => {
    const ctx = {
      get: (name: string) => name === 'sessionProjections'
        ? { snapshot: () => ({ values: { modelSelection: { next: { provider: 'p', model: 'm', reasoningEffort: 'high' } } } }) }
        : undefined,
    } as unknown as Context
    const session = {} as Session
    const resolved = resolveSemanticRoute(ctx, undefined, session)
    expect(resolved).toMatchObject({ source: 'session', route: { provider: 'p', model: 'm', reasoningEffort: 'high' } })
    expect(memoryModelRoute(resolved.route)).toEqual({ provider: 'p', model: 'm', reasoningEffort: 'high' })
  })

  it('falls back to the session request header', () => {
    const ctx = { get: () => undefined } as unknown as Context
    const session = {
      requestHeader: () => ({ config: { provider: 'header-p', model: 'header-m' }, adapterDefaults: {} }),
    } as unknown as Session
    expect(resolveSemanticRoute(ctx, undefined, session)).toMatchObject({
      source: 'session',
      route: { provider: 'header-p', model: 'header-m' },
    })
  })

  it('falls back to agent options and then the host default', () => {
    const ctx = { get: () => undefined } as unknown as Context
    const agent = { options: { provider: 'agent-p', model: 'agent-m' } } as unknown as Agent
    expect(resolveSemanticRoute(ctx, agent)).toMatchObject({ source: 'agent', route: { provider: 'agent-p', model: 'agent-m' } })

    const defaultCtx = {
      get: (name: string) => name === 'agentDefaultModel'
        ? { currentSelection: () => ({ provider: 'default-p', model: 'default-m' }) }
        : undefined,
    } as unknown as Context
    expect(resolveSemanticRoute(defaultCtx)).toMatchObject({
      source: 'default',
      route: { provider: 'default-p', model: 'default-m' },
    })
  })

  it('fails clearly when no route exists', () => {
    expect(() => resolveSemanticRoute({ get: () => undefined } as unknown as Context))
      .toThrow(/cannot resolve a Harness model/)
  })
})
