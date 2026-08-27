/**
 * The one error type every memory role throws, so a consumer can distinguish a
 * composition or input fault from an unexpected runtime failure by code rather
 * than by message matching.
 * @module dsh-advanced-mem-plugin/src/memory/errors
 */

/**
 * Why a memory operation failed.
 *
 * - `no-store` — no store provider is composed, so nothing can be read or written.
 * - `duplicate-provider` — a second provider registered for a single-holder role.
 * - `unknown-item` — an id addressed no record, node, or edge.
 * - `invalid-input` — a caller-supplied value the interface could not constrain,
 *   such as a confidence outside the unit interval or an empty label.
 * - `embedder-mismatch` — a stored vector came from a different embedder than the
 *   one now composed, so the two are not comparable.
 * - `retracted` — the addressed item is tombstoned and may not be reinforced.
 */
export type MemoryErrorCode =
  | 'no-store'
  | 'duplicate-provider'
  | 'unknown-item'
  | 'invalid-input'
  | 'embedder-mismatch'
  | 'retracted'

/** A memory-capability failure carrying a machine-readable {@link MemoryErrorCode}. */
export class MemoryError extends Error {
  /**
   * @param code - the machine-readable failure reason.
   * @param message - the human-readable detail.
   * @param options - standard error options, carrying an underlying `cause` when there is one.
   */
  constructor(
    readonly code: MemoryErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = 'MemoryError'
  }
}
