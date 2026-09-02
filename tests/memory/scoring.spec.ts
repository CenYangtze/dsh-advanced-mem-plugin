import { describe, expect, it } from 'vitest'
import {
  bm25Rank,
  clampConfidence,
  cosineSimilarity,
  decayedConfidence,
  normalizeVector,
  rankScore,
  reciprocalRankFusion,
  reinforcedConfidence,
  tokenize,
  weakenedConfidence,
} from '../../src/memory/scoring.ts'

describe('tokenize', () => {
  it('lowercases word runs and drops punctuation', () => {
    expect(tokenize('Run the Linter, then push!')).toEqual(['run', 'the', 'linter', 'then', 'push'])
  })

  it('keeps repeats, because term frequency is what ranking and embedding read', () => {
    expect(tokenize('push push pull push')).toEqual(['push', 'push', 'pull', 'push'])
  })

  it('indexes a CJK run as an exact key plus overlapping bigrams, so partial queries match', () => {
    expect(tokenize('提交代码')).toEqual(['提交代码', '提交', '交代', '代码'])
  })

  it('emits a single CJK character once, not once per pass', () => {
    expect(tokenize('推 code')).toEqual(['推', 'code'])
  })

  it('matches a CJK query against the longer phrase it appears inside', () => {
    const ranked = bm25Rank(tokenize('代码'), [
      { item: 'hit', terms: tokenize('请提交代码') },
      { item: 'miss', terms: tokenize('请写文档') },
    ])
    expect(ranked.map(entry => entry.item)).toEqual(['hit'])
  })

  it('yields nothing for text with no indexable characters', () => {
    expect(tokenize('  --- ??? ')).toEqual([])
  })
})

describe('bm25Rank', () => {
  const corpus = [
    { item: 'a', terms: ['pnpm', 'install', 'workspace'] },
    { item: 'b', terms: ['npm', 'install'] },
    { item: 'c', terms: ['deploy', 'release'] },
  ]

  it('ranks the document sharing the rarest query term first', () => {
    const ranked = bm25Rank(['pnpm'], corpus)
    expect(ranked.map(entry => entry.item)).toEqual(['a'])
  })

  it('omits documents that share no query term', () => {
    const ranked = bm25Rank(['install'], corpus)
    expect(ranked.map(entry => entry.item).sort()).toEqual(['a', 'b'])
  })

  it('returns nothing for an empty query or an empty corpus', () => {
    expect(bm25Rank([], corpus)).toEqual([])
    expect(bm25Rank(['pnpm'], [])).toEqual([])
  })

  it('weights a rare term above a common one', () => {
    const [rare] = bm25Rank(['pnpm'], corpus)
    const [common] = bm25Rank(['install'], corpus)
    expect(rare?.score).toBeGreaterThan(common?.score ?? Infinity)
  })
})

describe('cosineSimilarity', () => {
  it('is 1 for identical directions regardless of magnitude', () => {
    expect(cosineSimilarity([1, 2, 2], [2, 4, 4])).toBeCloseTo(1)
  })

  it('is 0 for orthogonal vectors and for a degenerate one', () => {
    expect(cosineSimilarity([1, 0], [0, 1])).toBe(0)
    expect(cosineSimilarity([0, 0], [1, 1])).toBe(0)
  })

  it('rejects mismatched lengths rather than comparing incomparable vectors', () => {
    expect(() => cosineSimilarity([1, 0], [1, 0, 0])).toThrow(/equal lengths/)
  })
})

describe('normalizeVector', () => {
  it('scales to unit length', () => {
    const unit = normalizeVector([3, 4])
    expect(unit[0]).toBeCloseTo(0.6)
    expect(unit[1]).toBeCloseTo(0.8)
  })

  it('leaves a zero vector alone, since it has no direction to preserve', () => {
    expect(normalizeVector([0, 0])).toEqual([0, 0])
  })
})

describe('reciprocalRankFusion', () => {
  it('promotes an item both signals found above one either found alone', () => {
    const fused = reciprocalRankFusion([['a', 'b'], ['b', 'c']], item => item)
    expect(fused[0]?.item).toBe('b')
  })

  it('fuses across signals whose scores are on incomparable scales', () => {
    // The lexical signal ranks 'x' first, the vector signal ranks it last;
    // fusion still keeps it, which is the property calibration-free fusion buys.
    const fused = reciprocalRankFusion([['x', 'y'], ['y', 'z', 'x']], item => item)
    expect(fused.map(entry => entry.item).sort()).toEqual(['x', 'y', 'z'])
  })

  it('returns nothing when every ranking is empty', () => {
    expect(reciprocalRankFusion<string>([[], []], item => item)).toEqual([])
  })
})

describe('belief dynamics', () => {
  it('halves confidence after exactly one half-life', () => {
    expect(decayedConfidence(0.8, 1000, 0, 1000)).toBeCloseTo(0.4)
  })

  it('leaves a belief untouched before any time passes, and when decay is disabled', () => {
    expect(decayedConfidence(0.8, 1000, 500, 400)).toBe(0.8)
    expect(decayedConfidence(0.8, null, 0, 10 ** 12)).toBe(0.8)
  })

  it('reinforces with diminishing returns and never reaches certainty', () => {
    let confidence = 0.5
    for (let index = 0; index < 100; index++) confidence = reinforcedConfidence(confidence, 0.2)
    expect(confidence).toBeLessThan(1)
    expect(confidence).toBeGreaterThan(0.99)
  })

  it('weakens multiplicatively and floors at zero', () => {
    expect(weakenedConfidence(0.8, 0.25)).toBeCloseTo(0.6)
    expect(weakenedConfidence(0.8, 2)).toBe(0)
  })

  it('clamps out-of-range and NaN beliefs', () => {
    expect(clampConfidence(1.5)).toBe(1)
    expect(clampConfidence(-0.2)).toBe(0)
    expect(clampConfidence(Number.NaN)).toBe(0)
  })
})

describe('rankScore', () => {
  it('is the single transform every signal goes through', () => {
    // The regression this pins: layer-1 cues once used 1/(1+position) while
    // layer-0 cues came through fusion at 1/(60+position+1), which made a belief
    // worth sixty episodes at the same rank.
    const fused = reciprocalRankFusion([['a']], item => item)
    expect(fused[0]?.score).toBeCloseTo(rankScore(0), 12)
  })

  it('falls off gently, so rank 1 and rank 20 stay the same order of magnitude', () => {
    expect(rankScore(0) / rankScore(19)).toBeLessThan(1.5)
  })

  it('scores an unranked item zero rather than dividing by zero', () => {
    expect(rankScore(undefined)).toBe(0)
  })
})

describe('reciprocalRankFusion weights', () => {
  it('lets one signal count for less than another', () => {
    const equal = reciprocalRankFusion([['a'], ['b']], item => item)
    expect(equal[0]?.score).toBeCloseTo(equal[1]?.score ?? 0, 12)

    const weighted = reciprocalRankFusion([['a'], ['b']], item => item, [1, 0.25])
    expect(weighted[0]?.item).toBe('a')
    expect(weighted[1]?.score).toBeCloseTo(0.25 * rankScore(0), 12)
  })

  it('drops a signal weighed zero, rather than folding it in at nothing', () => {
    const fused = reciprocalRankFusion([['a'], ['b']], item => item, [1, 0])
    expect(fused.map(entry => entry.item)).toEqual(['a'])
  })

  it('treats a missing weight as one, so an unweighted call is unchanged', () => {
    const partial = reciprocalRankFusion([['a'], ['b']], item => item, [1])
    expect(partial).toHaveLength(2)
    expect(partial[0]?.score).toBeCloseTo(partial[1]?.score ?? 0, 12)
  })

  it('still adds the contributions of a signal that ranks the same item twice over', () => {
    const fused = reciprocalRankFusion([['a', 'b'], ['a']], item => item, [1, 0.5])
    expect(fused[0]?.item).toBe('a')
    expect(fused[0]?.score).toBeCloseTo(rankScore(0) + 0.5 * rankScore(0), 12)
  })
})
