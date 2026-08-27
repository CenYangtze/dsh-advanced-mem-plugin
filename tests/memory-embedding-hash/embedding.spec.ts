import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import MemoryRuntime, { cosineSimilarity } from '../../src/memory/index.ts'
import type { Config as MemoryConfig } from '../../src/memory/index.ts'
import { HashedTermEmbedder, apply, embedText } from '../../src/memory-embedding-hash/index.ts'

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

describe('embedText', () => {
  it('produces unit-length vectors of the requested width', () => {
    const vector = embedText('run the linter', 64)
    expect(vector).toHaveLength(64)
    expect(cosineSimilarity(vector, vector)).toBeCloseTo(1)
  })

  it('is stable across calls, so a vector written today still compares tomorrow', () => {
    expect(embedText('deploy the service', 32)).toEqual(embedText('deploy the service', 32))
  })

  it('scores overlapping texts above unrelated ones', () => {
    const query = embedText('run the linter before pushing', 512)
    const related = embedText('always run the linter first', 512)
    const unrelated = embedText('book a table for dinner', 512)
    expect(cosineSimilarity(query, related)).toBeGreaterThan(cosineSimilarity(query, unrelated))
  })

  it('ignores word order, which is what a bag-of-terms projection can and cannot do', () => {
    expect(embedText('linter run', 128)).toEqual(embedText('run linter', 128))
  })

  it('yields a zero vector for text with no indexable terms', () => {
    expect(embedText('!!! ???', 8)).toEqual(new Array<number>(8).fill(0))
  })

  it('damps a repeated term instead of letting it dominate the direction', () => {
    const once = embedText('deploy service', 256)
    const many = embedText('deploy deploy deploy deploy service', 256)
    expect(cosineSimilarity(once, many)).toBeGreaterThan(0.7)
    expect(many).not.toEqual(once)
  })
})

describe('HashedTermEmbedder', () => {
  it('embeds a batch in input order', async () => {
    const embedder = new HashedTermEmbedder(32)
    const vectors = await embedder.embed(['alpha', 'beta'])
    expect(vectors).toHaveLength(2)
    expect(vectors[0]).toEqual(embedText('alpha', 32))
    expect(vectors[1]).toEqual(embedText('beta', 32))
  })
})

describe('apply', () => {
  it('mounts the embedder on the hub', async () => {
    const ctx = new Context()
    await ctx.plugin(MemoryRuntime, memoryConfig)
    await ctx.plugin({ name: 'memory-embedding-hash', inject: ['memory'], apply }, { dimensions: 64 })
    expect(ctx.memory.embedder?.name).toBe('hashed-terms')
    expect(ctx.memory.embedder?.dimensions).toBe(64)
  })

  it('fails loud on a width that cannot produce a usable vector', async () => {
    const ctx = new Context()
    await ctx.plugin(MemoryRuntime, memoryConfig)
    expect(() => { apply(ctx, { dimensions: 0 }) }).toThrow(/positive safe integer/)
  })
})
