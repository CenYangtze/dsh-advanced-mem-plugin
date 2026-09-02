/**
 * Pure retrieval and belief mathematics: tokenization, lexical ranking, vector
 * similarity, rank fusion, and the confidence update laws. Everything here is a
 * deterministic function of its arguments, so retrieval quality and belief
 * dynamics are testable without a store, an embedder, or a clock.
 *
 * @module dsh-advanced-mem-plugin/src/memory/scoring
 */

/** BM25 term-frequency saturation. The standard value; retrieval is not sensitive to it. */
const BM25_K1 = 1.2
/** BM25 length normalization strength. The standard value. */
const BM25_B = 0.75
/** Reciprocal-rank-fusion smoothing constant, from the original RRF formulation. */
const RRF_K = 60

/**
 * Turn a position in a ranking into a score.
 *
 * The single rank-to-score transform in the system, and it has to be single: two
 * transforms means two scales, and cues scored on different scales cannot be
 * ordered against each other however carefully their priors are tuned. Layer-1
 * cues once used `1 / (1 + position)` while layer-0 cues came through
 * {@link reciprocalRankFusion} at `1 / (60 + position + 1)`, which made a belief
 * worth sixty episodes at the same rank — and a belief ranked twentieth still
 * worth three of the best episode in the scope.
 * @param position - zero-based position in a ranking, or `undefined` when the
 *   signal did not rank the item at all.
 * @returns the score contribution, or 0 for an unranked item.
 */
export function rankScore(position: number | undefined): number {
  return position === undefined ? 0 : 1 / (RRF_K + position + 1)
}

/**
 * Matches one run of Han, Hiragana, Katakana, or Hangul characters. These scripts
 * are written without spaces, so a run is one long word token that only an exact
 * repetition can match. Indexing the run's overlapping bigrams alongside it is
 * the cheapest segmentation that makes partial matches work without shipping a
 * dictionary.
 */
const CJK_RUN = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af]+/gu
/** Matches one run of Latin, digit, or underscore characters. */
const WORD_RUN = /[\p{Letter}\p{Number}_]+/gu

/**
 * Split text into lexical retrieval keys.
 *
 * Every run of letters, digits, and underscores becomes one lowercased term,
 * which for a space-free script is the whole run and serves as an exact-phrase
 * key. Runs in those scripts additionally yield overlapping character bigrams, so
 * a Chinese or Japanese query matches a longer phrase it appears inside.
 * Repeats are kept. Term frequency is what BM25 saturates and what the embedder
 * damps, so collapsing them here would silently reduce both to presence tests.
 * @param text - the text to index or query.
 * @returns the extracted terms in occurrence order.
 */
export function tokenize(text: string): string[] {
  const terms: string[] = []
  const push = (term: string): void => {
    if (term.length === 0) return
    terms.push(term)
  }
  for (const match of text.toLowerCase().matchAll(WORD_RUN)) push(match[0])
  for (const match of text.matchAll(CJK_RUN)) {
    const run = match[0]
    // A one-character run is already the whole word token from the pass above;
    // it has no bigrams and re-pushing it would double its frequency.
    if (run.length === 1) continue
    for (let index = 0; index + 1 < run.length; index++) push(run.slice(index, index + 2))
  }
  return terms
}

/**
 * How much two pieces of text overlap, as Jaccard similarity over their terms.
 *
 * Set overlap rather than edit distance, and over {@link tokenize} output rather
 * than characters, so the measure inherits the tokenizer's handling of case and
 * of scripts without spaces: "PNPM over npm" and "pnpm over NPM" are the same
 * text here, and two Chinese sentences overlap through their character bigrams
 * exactly as they do in the lexical index.
 *
 * One function for two jobs on purpose — deciding that a newly distilled belief
 * restates one already held, and deciding that a cue about to be shown restates
 * one already shown. Those are the same question asked at two moments, and
 * answering them differently is how a memory ends up holding six spellings of
 * one preference and then showing all six.
 * @param left - the first text.
 * @param right - the second text.
 * @returns overlap in the closed unit interval; 0 when either side has no terms.
 */
export function similarity(left: string, right: string): number {
  const a = new Set(tokenize(left))
  const b = new Set(tokenize(right))
  if (a.size === 0 || b.size === 0) return 0
  let shared = 0
  for (const term of a) if (b.has(term)) shared++
  return shared / (a.size + b.size - shared)
}

/** One document offered to {@link bm25Rank}: an opaque handle plus its indexed terms. */
export interface LexicalDocument<T> {
  /** The caller's item, returned unchanged in the ranking. */
  readonly item: T
  /** Terms produced by {@link tokenize} at capture time. */
  readonly terms: readonly string[]
}

/** One scored item; `score` is comparable only within the ranking that produced it. */
export interface ScoredItem<T> {
  /** The caller's item. */
  readonly item: T
  /** Higher is more relevant. */
  readonly score: number
}

/**
 * Rank documents against query terms with Okapi BM25 over the supplied corpus.
 * Scores are corpus-relative, which is exactly what rank fusion needs: only the
 * induced order is consumed downstream.
 * @param queryTerms - terms from {@link tokenize} applied to the query.
 * @param documents - the candidate corpus.
 * @returns matching documents in descending score order; non-matching documents are omitted.
 */
export function bm25Rank<T>(
  queryTerms: readonly string[],
  documents: readonly LexicalDocument<T>[],
): ScoredItem<T>[] {
  if (queryTerms.length === 0 || documents.length === 0) return []
  const documentFrequency = new Map<string, number>()
  let totalLength = 0
  for (const document of documents) {
    totalLength += document.terms.length
    for (const term of new Set(document.terms)) {
      documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1)
    }
  }
  const averageLength = totalLength / documents.length
  const ranked: ScoredItem<T>[] = []
  for (const document of documents) {
    const counts = new Map<string, number>()
    for (const term of document.terms) counts.set(term, (counts.get(term) ?? 0) + 1)
    let score = 0
    for (const term of queryTerms) {
      const frequency = counts.get(term)
      if (frequency === undefined) continue
      const matching = documentFrequency.get(term) ?? 0
      // Probabilistic IDF with the +1 shift that keeps a term present in every
      // document at a small positive weight instead of a negative one.
      const idf = Math.log(1 + (documents.length - matching + 0.5) / (matching + 0.5))
      const normalization = averageLength === 0
        ? 1
        : 1 - BM25_B + BM25_B * (document.terms.length / averageLength)
      score += idf * (frequency * (BM25_K1 + 1)) / (frequency + BM25_K1 * normalization)
    }
    if (score > 0) ranked.push({ item: document.item, score })
  }
  ranked.sort((left, right) => right.score - left.score)
  return ranked
}

/**
 * Cosine similarity of two vectors of equal length. Callers store L2-normalized
 * vectors, so this reduces to a dot product; the norms are still divided out so
 * an un-normalized caller gets a correct answer rather than a silently inflated one.
 * @param left - first vector.
 * @param right - second vector.
 * @returns similarity in the closed interval from -1 to 1; 0 when either vector is degenerate.
 * @throws when the vectors have different lengths, which means mismatched embedders.
 */
export function cosineSimilarity(left: readonly number[], right: readonly number[]): number {
  if (left.length !== right.length) {
    throw new Error(`cosine similarity needs equal lengths, got ${left.length} and ${right.length}`)
  }
  let dot = 0
  let leftNorm = 0
  let rightNorm = 0
  for (let index = 0; index < left.length; index++) {
    const a = left[index] ?? 0
    const b = right[index] ?? 0
    dot += a * b
    leftNorm += a * a
    rightNorm += b * b
  }
  if (leftNorm === 0 || rightNorm === 0) return 0
  return dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm))
}

/**
 * Scale a vector to unit L2 length so later comparisons are pure dot products.
 * A zero vector is returned unchanged — it has no direction to preserve.
 * @param vector - the raw vector.
 * @returns the normalized copy.
 */
export function normalizeVector(vector: readonly number[]): number[] {
  let norm = 0
  for (const component of vector) norm += component * component
  if (norm === 0) return [...vector]
  const scale = 1 / Math.sqrt(norm)
  return vector.map(component => component * scale)
}

/**
 * Fuse several independent rankings of the same items with reciprocal rank
 * fusion. RRF consumes only positions, so a lexical score in BM25 units and a
 * cosine similarity in the unit interval combine without any calibration step
 * between them, which is what makes hybrid retrieval robust here.
 * Weights exist because "no calibration between signals" is not the same as
 * "every signal is worth the same". Unweighted, a ranking that knows nothing
 * still places its first item above the other signal's tenth — a signal with no
 * information does not merely fail to help, it actively displaces one that has
 * some. Weighting is how a signal earns its say.
 * @param rankings - one array per retrieval signal, each already in descending relevance order.
 * @param identify - stable identity of an item, so the same item found by two signals fuses.
 * @param weights - per-ranking multipliers, positionally matched; a missing entry weighs 1.
 * @returns the fused ranking in descending score order.
 */
export function reciprocalRankFusion<T>(
  rankings: readonly (readonly T[])[],
  identify: (item: T) => string,
  weights: readonly number[] = [],
): ScoredItem<T>[] {
  const fused = new Map<string, ScoredItem<T>>()
  for (const [index, ranking] of rankings.entries()) {
    const weight = weights[index] ?? 1
    if (weight <= 0) continue
    for (let position = 0; position < ranking.length; position++) {
      const item = ranking[position]
      if (item === undefined) continue
      const key = identify(item)
      const contribution = weight * rankScore(position)
      const existing = fused.get(key)
      fused.set(key, existing === undefined
        ? { item, score: contribution }
        : { item: existing.item, score: existing.score + contribution })
    }
  }
  return [...fused.values()].sort((left, right) => right.score - left.score)
}

/**
 * Apply time-based erosion to a stored belief.
 *
 * Confidence halves every `halfLifeMs` of elapsed time since the belief was last
 * supported, which makes staleness a continuous property rather than an
 * expiry flag: a belief that stops being observed fades out of recall on its own
 * while remaining on the medium and recoverable by one reinforcement.
 * @param confidence - the stored belief.
 * @param halfLifeMs - half-life, or `null` for a belief that never erodes.
 * @param lastSeenAt - epoch milliseconds of the latest supporting evidence.
 * @param now - epoch milliseconds of the read.
 * @returns the eroded belief, never below 0 or above the stored value.
 */
export function decayedConfidence(
  confidence: number,
  halfLifeMs: number | null,
  lastSeenAt: number,
  now: number,
): number {
  if (halfLifeMs === null || halfLifeMs <= 0) return confidence
  const elapsed = now - lastSeenAt
  if (elapsed <= 0) return confidence
  return confidence * 2 ** (-elapsed / halfLifeMs)
}

/**
 * Raise a belief toward certainty by one observation.
 *
 * The update moves a fraction of the remaining distance to 1, so repeated
 * agreement has diminishing returns and no finite number of observations
 * fabricates certainty from inference alone.
 * @param confidence - the stored belief.
 * @param rate - fraction of the remaining distance to close, in the open unit interval.
 * @returns the reinforced belief, capped below 1.
 */
export function reinforcedConfidence(confidence: number, rate: number): number {
  return confidence + rate * (1 - confidence)
}

/**
 * Lower a belief by one contradicting observation.
 *
 * Contradiction is multiplicative, so a strongly supported belief survives one
 * disagreement while a weakly supported one collapses quickly.
 * @param confidence - the stored belief.
 * @param rate - fraction of the current belief to remove, in the open unit interval.
 * @returns the weakened belief, never below 0.
 */
export function weakenedConfidence(confidence: number, rate: number): number {
  return Math.max(0, confidence * (1 - rate))
}

/**
 * Clamp a value into the closed unit interval.
 * @param value - the candidate belief.
 * @returns the clamped belief.
 */
export function clampConfidence(value: number): number {
  if (Number.isNaN(value)) return 0
  return Math.min(1, Math.max(0, value))
}
