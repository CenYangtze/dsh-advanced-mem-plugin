/**
 * Retrieval metrics.
 *
 * This system has no generator in it: it decides what a turn gets to see, and
 * something else decides what to say. So the honest question a memory benchmark
 * can ask of it is a retrieval question — of the material that actually answers
 * this, how much came back, and how near the top. Those are the numbers the
 * LongMemEval paper reports separately from end-to-end accuracy, and they are
 * the ones comparable across memory systems rather than across the language
 * models bolted to them.
 *
 * @module dsh-advanced-mem-plugin/bench/metrics
 */

/** One scored retrieval: what came back, in order, against what should have. */
export interface RetrievalOutcome {
  /** Document ids returned, best first, deduplicated. */
  readonly returned: readonly string[]
  /** Document ids that actually carry the answer. */
  readonly gold: ReadonlySet<string>
}

/** What one retrieval scored. */
export interface RetrievalScore {
  /** Whether any gold document appeared at all. */
  readonly hit: boolean
  /** 1-based position of the first gold document, or `null` when none returned. */
  readonly firstRank: number | null
  /** Reciprocal of `firstRank`, or 0. */
  readonly reciprocalRank: number
  /** Fraction of gold documents present, per cutoff. */
  readonly recallAt: Readonly<Record<number, number>>
  /** Whether at least one gold document is within the cutoff. */
  readonly hitAt: Readonly<Record<number, boolean>>
  /** Normalised discounted cumulative gain at the largest cutoff, binary relevance. */
  readonly ndcg: number
}

/** Cutoffs every run reports. */
export const CUTOFFS: readonly number[] = [1, 3, 5, 10]

/**
 * Score one retrieval.
 * @param outcome - what came back and what should have.
 * @param cutoffs - the @k values to report; defaults to {@link CUTOFFS}.
 * @returns the per-query score.
 */
export function score(outcome: RetrievalOutcome, cutoffs: readonly number[] = CUTOFFS): RetrievalScore {
  const { returned, gold } = outcome
  const firstIndex = returned.findIndex(id => gold.has(id))
  const recallAt: Record<number, number> = {}
  const hitAt: Record<number, boolean> = {}
  for (const k of cutoffs) {
    const window = returned.slice(0, k)
    const found = window.filter(id => gold.has(id)).length
    recallAt[k] = gold.size === 0 ? 0 : found / gold.size
    hitAt[k] = found > 0
  }
  const cutoff = Math.max(...cutoffs)
  let dcg = 0
  for (const [index, id] of returned.slice(0, cutoff).entries()) {
    if (gold.has(id)) dcg += 1 / Math.log2(index + 2)
  }
  let ideal = 0
  for (let index = 0; index < Math.min(gold.size, cutoff); index += 1) ideal += 1 / Math.log2(index + 2)
  return {
    hit: firstIndex >= 0,
    firstRank: firstIndex < 0 ? null : firstIndex + 1,
    reciprocalRank: firstIndex < 0 ? 0 : 1 / (firstIndex + 1),
    recallAt,
    hitAt,
    ndcg: ideal === 0 ? 0 : dcg / ideal,
  }
}

/** Aggregate figures over a set of queries. */
export interface RetrievalSummary {
  readonly queries: number
  /** Mean fraction of gold documents retrieved, per cutoff. */
  readonly recallAt: Readonly<Record<number, number>>
  /** Share of queries with at least one gold document, per cutoff. */
  readonly hitAt: Readonly<Record<number, boolean | number>>
  readonly mrr: number
  readonly ndcg: number
}

/**
 * Average a set of scores.
 * @param scores - the per-query scores.
 * @param cutoffs - the @k values to report; defaults to {@link CUTOFFS}.
 * @returns the aggregate, with zeroes rather than `NaN` for an empty set.
 */
export function summarize(
  scores: readonly RetrievalScore[],
  cutoffs: readonly number[] = CUTOFFS,
): RetrievalSummary {
  const n = scores.length
  const mean = (pick: (s: RetrievalScore) => number): number =>
    n === 0 ? 0 : scores.reduce((sum, s) => sum + pick(s), 0) / n
  const recallAt: Record<number, number> = {}
  const hitAt: Record<number, number> = {}
  for (const k of cutoffs) {
    recallAt[k] = mean(s => s.recallAt[k] ?? 0)
    hitAt[k] = mean(s => (s.hitAt[k] === true ? 1 : 0))
  }
  return {
    queries: n,
    recallAt,
    hitAt,
    mrr: mean(s => s.reciprocalRank),
    ndcg: mean(s => s.ndcg),
  }
}
