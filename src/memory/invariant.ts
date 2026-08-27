/** Package-owned memory graph invariants. @module dsh-advanced-mem-plugin/invariant */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantFailure, InvariantInstaller } from '@deepseek-ai/dsh-invariants'
import type { MemoryEdge, MemoryNode, MemoryRecord, MemorySupport } from './types.ts'

const PACKAGE_NAME = 'dsh-advanced-mem-plugin'

/** Cordis companion plugin name. */
export const name = 'memory-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * Validate the belief state shared by nodes and edges.
 *
 * These are the relationships every consumer of a cue depends on: a confidence
 * outside the unit interval breaks every comparison and filter downstream, and
 * support counters that run backwards make the decay clock read a future the
 * item never had.
 */
function validateBelief(
  kind: string,
  id: string,
  confidence: number,
  support: MemorySupport,
  evidence: readonly string[],
  createdAt: number,
  updatedAt: number,
  fail: InvariantFailure,
): void {
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    fail(`memory ${kind} ${id} carries confidence ${String(confidence)} outside the unit interval`)
  }
  if (support.lastSeenAt < support.firstSeenAt) {
    fail(`memory ${kind} ${id} was last seen before it was first seen`)
  }
  for (const [field, value] of Object.entries({
    observations: support.observations,
    reinforcements: support.reinforcements,
    contradictions: support.contradictions,
    sessions: support.sessions,
  })) {
    if (!Number.isInteger(value) || value < 0) {
      fail(`memory ${kind} ${id} carries a negative or fractional support.${field}`)
    }
  }
  if (updatedAt < createdAt) {
    fail(`memory ${kind} ${id} was updated before it was created`)
  }
  if (new Set(evidence).size !== evidence.length) {
    fail(`memory ${kind} ${id} cites the same evidence record twice, double-counting its support`)
  }
}

/** Validate one node's own state. */
function validateNode(node: MemoryNode, fail: InvariantFailure): void {
  validateBelief('node', node.id, node.confidence, node.support, node.evidence, node.createdAt, node.updatedAt, fail)
  if (node.label.trim() !== node.label || node.label.length === 0) {
    fail(`memory node ${node.id} carries an untrimmed or empty label, which breaks label-keyed merging`)
  }
  if (node.supersededBy !== undefined && node.status === 'active') {
    fail(`memory node ${node.id} names a replacement while still active`)
  }
}

/**
 * Validate one edge, including the relationship the hub alone can break: an edge
 * whose endpoint is missing or lives in another partition would be recalled in a
 * scope that cannot resolve it.
 */
function validateEdge(ctx: Context, edge: MemoryEdge, fail: InvariantFailure): void {
  validateBelief('edge', edge.id, edge.confidence, edge.support, edge.evidence, edge.createdAt, edge.updatedAt, fail)
  if (edge.supersededBy !== undefined && edge.status === 'active') {
    fail(`memory edge ${edge.id} names a replacement while still active`)
  }
  if (!ctx.memory.ready) return
  for (const endpoint of [edge.from, edge.to]) {
    const node = ctx.memory.store.getNode(endpoint)
    if (node === undefined) {
      fail(`memory edge ${edge.id} points at node ${endpoint}, which the store does not hold`)
    }
  }
}

/** Validate one layer-0 record's retrieval keys and fidelity claim. */
function validateRecord(record: MemoryRecord, fail: InvariantFailure): void {
  if (record.text.trim().length === 0) {
    fail(`memory record ${record.id} carries no indexable text`)
  }
  if (record.embedding !== undefined && record.embedding.vector.length !== record.embedding.dimensions) {
    fail(`memory record ${record.id} carries a vector of ${record.embedding.vector.length} components declared as ${record.embedding.dimensions}`)
  }
  for (const attachment of record.attachments) {
    if (attachment.uri.trim().length === 0) {
      fail(`memory record ${record.id} references an original with no locator, so the original is unreachable`)
    }
  }
}

/** Install validation for every belief change and every captured record. */
const install: InvariantInstaller = Object.assign((ctx: Context, fail: InvariantFailure) => {
  ctx.on('memory/node-changed', (node) => { validateNode(node, fail) })
  ctx.on('memory/edge-changed', (edge) => { validateEdge(ctx, edge, fail) })
  ctx.on('memory/recorded', (record) => { validateRecord(record, fail) })
}, { inject: ['memory'] })

/**
 * Register the memory invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
