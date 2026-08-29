/**
 * Durable storage-domain declaration for the dual-layer memory store.
 *
 * These schemas are the durable boundary: every row is validated against them
 * when the domain opens, so a hand-edited or half-written medium fails loud at
 * startup rather than producing a graph with impossible beliefs. Zod infers
 * branded id fields structurally, which is why each table schema is asserted
 * onto the public interface it validates.
 *
 * @module dsh-advanced-mem-plugin/src/memory-store-domain/spec
 */

import { z } from 'zod'
import type { MemoryEdge, MemoryEdgeId, MemoryNode, MemoryNodeId, MemoryRecord, MemoryRecordId } from '../memory/index.ts'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'

/** Format version of the memory medium; a differently stamped medium is rejected at open. */
export const MEMORY_DOMAIN_VERSION = 1

const epochMs = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const unitInterval = z.number().min(0).max(1)

const attachmentSchema = z.object({
  kind: z.union([
    z.literal('image'),
    z.literal('video'),
    z.literal('audio'),
    z.literal('document'),
    z.literal('url'),
    z.literal('blob'),
  ]),
  uri: z.string().min(1),
  mediaType: z.string().min(1).optional(),
  bytes: z.number().int().nonnegative().optional(),
  digest: z.string().min(1).optional(),
  caption: z.string().optional(),
})

const provenanceSchema = z.object({
  sessionId: z.string().min(1).optional(),
  eventSeq: z.number().int().nonnegative().optional(),
  turn: z.number().int().nonnegative().optional(),
  callId: z.string().min(1).optional(),
  tool: z.string().min(1).optional(),
  skill: z.string().min(1).optional(),
})

const embeddingSchema = z.object({
  model: z.string().min(1),
  dimensions: z.number().int().positive(),
  vector: z.array(z.number()),
}).refine(embedding => embedding.vector.length === embedding.dimensions, {
  path: ['vector'],
  message: 'memory embedding vector length must equal its declared dimensions',
})

const supportSchema = z.object({
  observations: z.number().int().nonnegative(),
  reinforcements: z.number().int().nonnegative(),
  contradictions: z.number().int().nonnegative(),
  sessions: z.number().int().nonnegative(),
  firstSeenAt: epochMs,
  lastSeenAt: epochMs,
}).refine(support => support.lastSeenAt >= support.firstSeenAt, {
  path: ['lastSeenAt'],
  message: 'memory support lastSeenAt must not precede firstSeenAt',
})

const decaySchema = z.object({
  halfLifeMs: z.union([z.number().positive(), z.null()]),
})

const statusSchema = z.union([z.literal('active'), z.literal('superseded'), z.literal('retracted')])

/** Runtime schema for one layer-0 record. */
export const memoryRecordSchema = z.object({
  id: z.string().min(1),
  scope: z.string().min(1),
  kind: z.union([
    z.literal('user-message'),
    z.literal('assistant-message'),
    z.literal('tool-invocation'),
    z.literal('skill-invocation'),
    z.literal('procedure-step'),
    z.literal('artifact'),
    z.literal('note'),
  ]),
  text: z.string().min(1),
  fidelity: z.union([z.literal('verbatim'), z.literal('summary'), z.literal('derived')]),
  // Backfilled rather than required: a medium written before `use` existed
  // still validates, and every such row reads back as its kind's default. That
  // is what retires already-captured tool chatter from recall on first read,
  // with no migration pass and no window where the old rows are quotable.
  use: z.union([z.literal('recallable'), z.literal('evidence')]).optional(),
  terms: z.array(z.string()),
  attachments: z.array(attachmentSchema),
  provenance: provenanceSchema,
  createdAt: epochMs,
  embedding: embeddingSchema.optional(),
  promotedTo: z.array(z.string()),
  status: z.union([z.literal('active'), z.literal('retracted')]),
}) as unknown as z.ZodType<MemoryRecord>

/** Runtime schema for one layer-1 node. */
export const memoryNodeSchema = z.object({
  id: z.string().min(1),
  scope: z.string().min(1),
  type: z.union([
    z.literal('person'),
    z.literal('preference'),
    z.literal('skill-affinity'),
    z.literal('tool-affinity'),
    z.literal('entity'),
    z.literal('project'),
    z.literal('routine'),
    z.literal('procedure'),
    z.literal('constraint'),
  ]),
  label: z.string().min(1),
  summary: z.string().min(1),
  attributes: z.record(z.string(), z.json()),
  confidence: unitInterval,
  decay: decaySchema,
  support: supportSchema,
  evidence: z.array(z.string().min(1)),
  origin: z.union([z.literal('asserted'), z.literal('inferred')]),
  status: statusSchema,
  supersededBy: z.string().min(1).optional(),
  createdAt: epochMs,
  updatedAt: epochMs,
}) as unknown as z.ZodType<MemoryNode>

/** Runtime schema for one layer-1 edge. */
export const memoryEdgeSchema = z.object({
  id: z.string().min(1),
  scope: z.string().min(1),
  from: z.string().min(1),
  to: z.string().min(1),
  relation: z.union([
    z.literal('prefers'),
    z.literal('avoids'),
    z.literal('uses'),
    z.literal('works-on'),
    z.literal('part-of'),
    z.literal('caused-by'),
    z.literal('co-occurs'),
    z.literal('contradicts'),
    z.literal('supersedes'),
  ]),
  claim: z.string().min(1),
  confidence: unitInterval,
  decay: decaySchema,
  support: supportSchema,
  evidence: z.array(z.string().min(1)),
  origin: z.union([z.literal('asserted'), z.literal('inferred')]),
  status: statusSchema,
  supersededBy: z.string().min(1).optional(),
  createdAt: epochMs,
  updatedAt: epochMs,
}) as unknown as z.ZodType<MemoryEdge>

/**
 * The memory domain: one table per layer-0 and layer-1 element. Keys are the
 * branded item ids, so a row is addressable without an index, and scope
 * partitioning is an in-memory index the store rebuilds at open.
 */
export const memoryDomainSpec = defineDomain({
  name: 'memory',
  version: MEMORY_DOMAIN_VERSION,
  tables: {
    records: domainTable<MemoryRecordId, MemoryRecord>(memoryRecordSchema),
    nodes: domainTable<MemoryNodeId, MemoryNode>(memoryNodeSchema),
    edges: domainTable<MemoryEdgeId, MemoryEdge>(memoryEdgeSchema),
  },
})
