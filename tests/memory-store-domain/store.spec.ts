import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import * as storageJson from '@deepseek-ai/dsh-storage-json'
import * as storageDomain from '@deepseek-ai/dsh-storage-domain'
import MemoryRuntime from '../../src/memory/index.ts'
import type { Config as MemoryConfig, MemoryDistiller, MemoryScope } from '../../src/memory/index.ts'
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
  it('declares one table per stored element plus consolidation progress', () => {
    expect(Object.keys(memoryDomainSpec.tables).sort()).toEqual(['edges', 'nodes', 'progress', 'records'])
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

  it('erases progress rows with the record and keeps them gone after reload', async () => {
    const first = await harness()
    const distiller: MemoryDistiller = {
      name: 'progress-cleanup',
      rank: 1,
      version: '1',
      progress: { mode: 'record', maxAttempts: 1 },
      distill: () => Promise.resolve({ nodes: [], edges: [] }),
    }
    first.ctx.memory.registerDistiller(distiller)
    const record = await first.ctx.memory.remember({
      scope: workspace, kind: 'user-message', text: 'ordinary conversation', fidelity: 'verbatim',
    })
    await first.ctx.memory.consolidate(workspace)
    const scopes = ['workspace:/repo' as never]
    expect([...first.ctx.memory.store.progressStore!.progress(scopes)]).toHaveLength(1)
    expect(await first.ctx.memory.forget(record.id)).toBe(true)
    expect([...first.ctx.memory.store.progressStore!.progress(scopes)]).toEqual([])
    await first.ctx.fiber.dispose()

    const second = await harness(first.directory)
    expect([...second.ctx.memory.store.progressStore!.progress(scopes)]).toEqual([])
    await second.ctx.fiber.dispose()
  })

  it('persists consolidation progress so a reload does not rescan an empty window', async () => {
    const first = await harness()
    const distiller: MemoryDistiller = {
      name: 'progress-fixture',
      rank: 1,
      version: '1',
      progress: { mode: 'record', maxAttempts: 1 },
      distill: () => Promise.resolve({ nodes: [], edges: [] }),
    }
    first.ctx.memory.registerDistiller(distiller)
    await first.ctx.memory.remember({
      scope: workspace, kind: 'user-message', text: 'ordinary conversation', fidelity: 'verbatim',
    })
    expect((await first.ctx.memory.consolidate(workspace)).examined).toBe(1)
    await first.ctx.fiber.dispose()

    const second = await harness(first.directory)
    second.ctx.memory.registerDistiller(distiller)
    const rows = [...second.ctx.memory.store.progressStore!.progress(['workspace:/repo' as never])]
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ distiller: 'progress-fixture', version: '1', status: 'empty', attempts: 1 })
    expect((await second.ctx.memory.consolidate(workspace)).examined).toBe(0)
    await second.ctx.fiber.dispose()
  })

  it('persists a replacement node, tombstone and supersedes edge across reload', async () => {
    const first = await harness()
    const oldEvidence = await first.ctx.memory.remember({
      scope: workspace, kind: 'user-message', text: 'I prefer pnpm over npm.', fidelity: 'verbatim',
      provenance: { author: 'user', sessionId: 's1' as never, turn: 1 },
    })
    const old = await first.ctx.memory.assert({
      scope: workspace, type: 'preference', label: 'pnpm over npm', summary: 'Prefers pnpm over npm.',
      origin: 'asserted', evidence: [oldEvidence.id],
    })
    const correction = await first.ctx.memory.remember({
      scope: workspace, kind: 'user-message', text: 'Actually, use yarn instead of pnpm.', fidelity: 'verbatim',
      provenance: { author: 'user', sessionId: 's1' as never, turn: 2 },
    })
    const replaced = await first.ctx.memory.replace({
      scope: workspace,
      target: old.id,
      type: 'preference',
      label: 'pnpm over yarn',
      summary: 'Prefers pnpm over yarn.',
      origin: 'asserted',
      evidence: [correction.id],
      quote: 'use yarn instead of pnpm',
    })
    await first.ctx.fiber.dispose()

    const second = await harness(first.directory)
    expect(second.ctx.memory.store.getNode(old.id)).toMatchObject({
      status: 'superseded',
      supersededBy: replaced.replacement.id,
    })
    expect(second.ctx.memory.store.getNode(replaced.replacement.id)).toMatchObject({
      status: 'active',
      evidence: [correction.id],
    })
    expect(second.ctx.memory.store.getEdge(replaced.edge.id)).toMatchObject({
      from: replaced.replacement.id,
      to: old.id,
      relation: 'supersedes',
    })
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

  it('keeps erased belief text absent after closing and reopening the durable domain', async () => {
    const first = await harness()
    const node = await first.ctx.memory.assert({ scope: workspace, type: 'preference', label: 'private', summary: 'Private workspace preference.', origin: 'asserted' })
    expect(await first.ctx.memory.forgetNode(node.id)).toBe(1)
    await first.ctx.fiber.dispose()
    const second = await harness(first.directory)
    expect(second.ctx.memory.store.getNode(node.id)).toBeUndefined()
    expect(second.ctx.memory.store.getRecord(node.evidence[0]!)).toBeUndefined()
    expect((await second.ctx.memory.recall({ text: 'private workspace preference', scopes: [workspace], includeEvidence: true })).cues).toHaveLength(0)
    await second.ctx.fiber.dispose()
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
