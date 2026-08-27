/**
 * Keyless deterministic embedder: signed feature hashing over the same terms the
 * lexical index uses.
 *
 * This is the Service Provider that lets semantic recall work with no API key,
 * no network, and no model download — a random projection of the term space that
 * approximately preserves cosine distance. It is deliberately weaker than a
 * trained encoder: it captures term overlap and co-occurrence, not paraphrase.
 * A deployment that wants paraphrase recall mounts a model-backed embedder in
 * its place; nothing else in the seam changes.
 *
 * Being deterministic and offline also makes it the right embedder for tests and
 * for snapshot fixtures, where a hosted model would make recall unreproducible.
 *
 * @module dsh-advanced-mem-plugin/embedding-hash
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { normalizeVector, tokenize } from '../memory/index.ts'
import type { MemoryEmbedder } from '../memory/index.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'memory-embedding-hash'

/** The hub this provider mounts on. */
export const inject = ['memory']

/** FNV-1a 32-bit offset basis. */
const FNV_OFFSET = 0x811c9dc5
/** FNV-1a 32-bit prime. */
const FNV_PRIME = 0x01000193

/** Deployment choice of vector width. */
export interface Config {
  /**
   * Vector width. Wider vectors collide less and separate terms better at a
   * linear cost in storage and comparison time; the right width depends on how
   * large a memory the deployment expects, so there is no defensible default.
   */
  dimensions: number
}

/** Schemastery validation for {@link Config}. */
export const Config: z<Config> = z.object({
  dimensions: z.number().required(),
})

/**
 * FNV-1a over the UTF-16 code units of a term. Chosen for being stable across
 * processes and platforms: a vector written today must still compare against one
 * written by a later build, so the hash cannot be runtime-seeded.
 * @param term - the term to hash.
 * @returns an unsigned 32-bit hash.
 */
function hashTerm(term: string): number {
  let hash = FNV_OFFSET
  for (let index = 0; index < term.length; index++) {
    hash ^= term.charCodeAt(index)
    hash = Math.imul(hash, FNV_PRIME)
  }
  return hash >>> 0
}

/**
 * Project one text onto a fixed-width vector by signed feature hashing.
 *
 * Each term lands in one bucket with a sign taken from a separate hash bit. The
 * signs are what keep collisions from silently inflating similarity: two
 * unrelated terms sharing a bucket cancel as often as they reinforce, so the
 * expected error stays near zero instead of accumulating. Term counts are
 * damped logarithmically for the same reason BM25 saturates them — a term
 * repeated ten times is not ten times more about the text.
 * @param text - the text to embed.
 * @param dimensions - vector width.
 * @returns the L2-normalized vector.
 */
export function embedText(text: string, dimensions: number): number[] {
  const vector = new Array<number>(dimensions).fill(0)
  const counts = new Map<string, number>()
  for (const term of tokenize(text)) counts.set(term, (counts.get(term) ?? 0) + 1)
  for (const [term, count] of counts) {
    const hash = hashTerm(term)
    const bucket = hash % dimensions
    const sign = (hash >>> 31) === 1 ? -1 : 1
    vector[bucket] = (vector[bucket] ?? 0) + sign * (1 + Math.log(count))
  }
  return normalizeVector(vector)
}

/** The provider: a pure function of text and width, with no state to invalidate. */
export class HashedTermEmbedder implements MemoryEmbedder {
  /** Provider name stamped onto every vector it produces. */
  readonly name = 'hashed-terms'

  /**
   * @param dimensions - vector width, from the plugin configuration.
   */
  constructor(readonly dimensions: number) {}

  /**
   * Embed a batch of texts.
   * @param texts - the texts to embed, in order.
   * @returns one L2-normalized vector per input text, in the same order.
   */
  embed(texts: readonly string[]): Promise<readonly (readonly number[])[]> {
    return Promise.resolve(texts.map(text => embedText(text, this.dimensions)))
  }
}

/**
 * Mount the hashed-term embedder on the hub.
 * @param ctx - registrant context carrying the hub.
 * @param config - the deployment's chosen vector width.
 * @throws when `dimensions` is not a positive safe integer, which would produce unusable vectors.
 */
export function apply(ctx: Context, config: Config): void {
  if (!Number.isSafeInteger(config.dimensions) || config.dimensions < 1) {
    throw new TypeError(
      `memory-embedding-hash: dimensions must be a positive safe integer, got ${String(config.dimensions)}`,
    )
  }
  ctx.effect(() => ctx.memory.registerEmbedder(new HashedTermEmbedder(config.dimensions)))
}
