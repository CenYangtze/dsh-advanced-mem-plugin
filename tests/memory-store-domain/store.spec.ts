import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import * as storageJson from '@deepseek-ai/dsh-storage-json'
import * as storageDomain from '@deepseek-ai/dsh-storage-domain'
import MemoryRuntime from '../../src/memory/index.ts'
import type { Config as MemoryConfig, MemoryScope } from '../../src/memory/index.ts'
import { apply, memoryDomainSpec } from '../../src/memory-store-domain/index.ts'

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
}

const workspace: MemoryScope = { kind: 'workspace', workspace: '/repo' }
const roots: string[] = []

/** Boot the hub over a JSON-backed memory domain in a fresh directory. */
async function harness(root?: string) {
  const directory = root ?? await mkdtemp(join(tmpdir(), 'dsh-memory-'))
  if (root === undefined) roots.push(directory)
  const ctx = new Context()
  await ctx.plugin(Storage)
  await ctx.plugin(storageJson, { root: directory })
  await ctx.plugin(storageDomain, { backend: 'json', routes: {} })
  await ctx.plugin(MemoryRuntime, memoryConfig)
  await ctx.plugin({ name: 'memory-store-domain', inject: ['memory', 'storageDomain'], apply })
  return { ctx, directory }
}

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

describe('memoryDomainSpec', () => {
  it('declares one table per stored element', () => {
    expect(Object.keys(memoryDomainSpec.tables).sort()).toEqual(['edges', 'nodes', 'records'])
  })
})

describe('DomainMemoryStore', () => {
  it('mounts on the hub and serves reads synchronously after an asynchronous write', async () => {
    const { ctx } = await harness()
    const record = await ctx.memory.remember({
      scope: workspace, kind: 'user-message', text: 'run the linter', fidelity: 'verbatim',
    })
    expect(ctx.memory.store.getRecord(record.id)).toMatchObject({ text: 'run the linter' })
    expect([...ctx.memory.store.records(['workspace:/repo' as never])]).toHaveLength(1)
  })

  it('partitions by scope so one scope never leaks into another', async () => {
    const { ctx } = await harness()
    await ctx.memory.remember({
      scope: workspace, kind: 'note', text: 'workspace note', fidelity: 'verbatim',
    })
    await ctx.memory.remember({
      scope: { kind: 'user' }, kind: 'note', text: 'user note', fidelity: 'verbatim',
    })
    expect([...ctx.memory.store.records(['workspace:/repo' as never])]).toHaveLength(1)
    expect([...ctx.memory.store.records(['user' as never])]).toHaveLength(1)
    expect([...ctx.memory.store.records(['user' as never, 'workspace:/repo' as never])]).toHaveLength(2)
  })

  it('survives a reload, which is the whole point of a durable store', async () => {
    const first = await harness()
    await first.ctx.memory.assert({
      scope: workspace, type: 'preference', label: 'pnpm', summary: 'Installs with pnpm.', origin: 'asserted',
    })
    await first.ctx.fiber.dispose()

    const second = await harness(first.directory)
    const recall = await second.ctx.memory.recall({ text: 'installs', scopes: [workspace] })
    const first_cue = recall.cues[0]
    expect(first_cue?.kind === 'node' && first_cue.node.label).toBe('pnpm')
    await second.ctx.fiber.dispose()
  })

  it('erases a record and reports whether one existed', async () => {
    const { ctx } = await harness()
    const record = await ctx.memory.remember({
      scope: workspace, kind: 'note', text: 'temporary', fidelity: 'verbatim',
    })
    expect(await ctx.memory.store.eraseRecord(record.id)).toBe(true)
    expect(await ctx.memory.store.eraseRecord(record.id)).toBe(false)
    expect([...ctx.memory.store.records(['workspace:/repo' as never])]).toEqual([])
  })

  it('moves an item out of its old partition when its scope changes', async () => {
    const { ctx } = await harness()
    const node = await ctx.memory.assert({
      scope: workspace, type: 'preference', label: 'dark', summary: 'Prefers dark mode.', origin: 'asserted',
    })
    await ctx.memory.store.putNode({ ...node, scope: 'user' as never })
    expect([...ctx.memory.store.nodes(['workspace:/repo' as never])]).toEqual([])
    expect([...ctx.memory.store.nodes(['user' as never])]).toHaveLength(1)
  })

  it('unmounts the store and releases the medium when the plugin unloads', async () => {
    const { ctx, directory } = await harness()
    expect(ctx.memory.ready).toBe(true)
    await ctx.fiber.dispose()
    // Reopening the same directory proves the unit handle was released rather
    // than leaked; a still-open unit rejects the second open.
    const reopened = await harness(directory)
    expect(reopened.ctx.memory.ready).toBe(true)
    await reopened.ctx.fiber.dispose()
  })
})
