/**
 * The shape every retrieval suite reduces its dataset to.
 *
 * Three benchmarks with three file formats become one question: given this
 * corpus and this query, do the documents the dataset marked as evidence come
 * back? Keeping that shape narrow is what makes the numbers comparable across
 * domains — the alternative is three runners whose scores share a name and
 * nothing else.
 *
 * @module dsh-advanced-mem-plugin/bench/suites/types
 */

import type { MemoryRecordKind } from '../../src/memory/index.ts'

/** One item of a corpus, as the dataset states it. */
export interface BenchDocument {
  /** Stable id within the corpus; this is what evidence labels refer to. */
  readonly id: string
  /** The text to index. */
  readonly text: string
  /**
   * Who authored it, in this system's vocabulary.
   *
   * Set by the suite from the dataset, never inferred here. It decides whether
   * the line is quotable or evidence-only, which is a real constraint on these
   * benchmarks rather than a detail: a dataset whose answers live in assistant
   * turns is asking for something the shipped configuration declines to give.
   */
  readonly kind: MemoryRecordKind
  /** Session the item belongs to, when the dataset groups by one. */
  readonly session?: string
  /** Turn within its session, for the distiller's sequence grouping. */
  readonly turn?: number
  /** Epoch milliseconds, when the dataset dates it. */
  readonly at?: number
}

/** One question asked against a corpus. */
export interface BenchTask {
  /** Stable id, usually the dataset's own question id. */
  readonly id: string
  /** The dataset's own category for this question; scores are broken down by it. */
  readonly group: string
  /** What to ask memory. */
  readonly query: string
  /** Document ids the dataset marks as carrying the answer. */
  readonly gold: readonly string[]
  /** Clock reading for the question, when the dataset dates it. */
  readonly at?: number
}

/** A corpus and the questions asked against it. */
export interface BenchCorpus {
  readonly id: string
  readonly documents: readonly BenchDocument[]
  readonly tasks: readonly BenchTask[]
}

/** One dataset, reduced. */
export interface BenchSuite {
  /** Short name used on the command line and in report filenames. */
  readonly name: string
  /** One line on what the dataset is and what its evidence labels mean. */
  readonly describe: string
  /**
   * Read the dataset.
   * @param path - the dataset file the suite expects.
   * @param limit - maximum corpora to load; `0` loads everything.
   * @returns the corpora, each with its questions attached.
   */
  load(path: string, limit: number): Promise<BenchCorpus[]>
}
