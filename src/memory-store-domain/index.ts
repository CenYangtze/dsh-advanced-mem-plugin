/**
 * Durable memory store over the storage-domain KV layer.
 *
 * This is the Service Provider role of the memory seam. The hub reads
 * synchronously on the request path, so the whole graph and its episodic
 * substrate live in scope-partitioned indexes rebuilt at open; writes go through
 * the domain, which validates every row and emits `domain/changed`. The domain
 * is routed to whichever backend the assembly configured, so the same store
 * serves a JSON file in a home directory and a SQLite file on a server without
 * any consumer noticing.
 *
 * @module dsh-advanced-mem-plugin/store-domain
 */

import type { Context } from '@deepseek-ai/cordis'
import type {
  MemoryEdge,
  MemoryEdgeId,
  MemoryNode,
  MemoryNodeId,
  MemoryRecord,
  MemoryRecordId,
  MemoryScopeKey,
  MemoryStore,
} from '../memory/index.ts'
import type { Domain, KvTable } from '@deepseek-ai/dsh-storage-domain'
import { memoryDomainSpec } from './spec.ts'

export {
  MEMORY_DOMAIN_VERSION,
  memoryDomainSpec,
  memoryEdgeSchema,
  memoryNodeSchema,
  memoryRecordSchema,
} from './spec.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'memory-store-domain'

/** The hub to register on, and the domain layer that owns the medium. */
export const inject = ['memory', 'storageDomain']

/** Any stored item; all three tables share the partition and identity fields the index needs. */
interface ScopedItem {
  readonly id: string
  readonly scope: MemoryScopeKey
}

/**
 * Scope-partitioned view over one domain table. The table already serves reads
 * from memory; this adds the by-scope grouping the hub enumerates, which the KV
 * shape has no key order to provide.
 */
class ScopeIndex<T extends ScopedItem> {
  private readonly byScope = new Map<MemoryScopeKey, Map<string, T>>()

  /**
   * @param table - the durable table this index mirrors.
   */
  constructor(private readonly table: KvTable<string, T>) {
    for (const [, item] of table.entries()) this.index(item)
  }

  /** Add or replace one item in the partition index. */
  private index(item: T): void {
    let partition = this.byScope.get(item.scope)
    if (partition === undefined) {
      partition = new Map<string, T>()
      this.byScope.set(item.scope, partition)
    }
    partition.set(item.id, item)
  }

  /**
   * Read one item.
   * @param id - the item identity.
   * @returns the item, or `undefined` when the id is unknown.
   */
  get(id: string): T | undefined {
    return this.table.get(id)
  }

  /**
   * Enumerate the items of several partitions.
   * @param scopes - the partition keys to read.
   * @returns a snapshot array; later writes do not mutate it.
   */
  list(scopes: readonly MemoryScopeKey[]): T[] {
    const items: T[] = []
    for (const scope of scopes) {
      const partition = this.byScope.get(scope)
      if (partition === undefined) continue
      items.push(...partition.values())
    }
    return items
  }

  /**
   * Write one item durably and refresh the partition index.
   *
   * A rescoped item is removed from its old partition first: memory items keep
   * their identity across a scope promotion (a session belief graduating to the
   * user), and leaving the stale copy behind would double-count it in recall.
   * @param item - the complete item.
   * @returns resolution once the write is durable.
   */
  async put(item: T): Promise<void> {
    const previous = this.table.get(item.id)
    if (previous !== undefined && previous.scope !== item.scope) {
      this.byScope.get(previous.scope)?.delete(item.id)
    }
    await this.table.put(item.id, item)
    this.index(item)
  }

  /**
   * Erase one item durably and drop it from the partition index.
   * @param id - the item identity.
   * @returns whether an item existed to erase.
   */
  async erase(id: string): Promise<boolean> {
    const existing = this.table.get(id)
    const deleted = await this.table.delete(id)
    if (existing !== undefined) this.byScope.get(existing.scope)?.delete(id)
    return deleted
  }
}

/** The store provider: three scope indexes over one storage domain. */
export class DomainMemoryStore implements MemoryStore {
  /** Provider name reported to the hub. */
  readonly name = 'domain'

  private readonly recordIndex: ScopeIndex<MemoryRecord>
  private readonly nodeIndex: ScopeIndex<MemoryNode>
  private readonly edgeIndex: ScopeIndex<MemoryEdge>

  /**
   * @param domain - the opened memory domain; the caller owns closing it.
   */
  constructor(domain: Domain<typeof memoryDomainSpec>) {
    // The spec keys tables by branded id while the index works in plain
    // strings; the brands are erased at the medium either way.
    this.recordIndex = new ScopeIndex(domain.table('records'))
    this.nodeIndex = new ScopeIndex(domain.table('nodes'))
    this.edgeIndex = new ScopeIndex(domain.table('edges'))
  }

  /**
   * Read one layer-0 record.
   * @param id - the record identity.
   * @returns the record, or `undefined` when the id is unknown.
   */
  getRecord(id: MemoryRecordId): MemoryRecord | undefined {
    return this.recordIndex.get(id)
  }

  /**
   * Enumerate layer-0 records across partitions.
   * @param scopes - the partition keys to read.
   * @returns a snapshot iterable.
   */
  records(scopes: readonly MemoryScopeKey[]): Iterable<MemoryRecord> {
    return this.recordIndex.list(scopes)
  }

  /**
   * Insert or replace one layer-0 record.
   * @param record - the complete record.
   * @returns resolution once the write is durable.
   */
  putRecord(record: MemoryRecord): Promise<void> {
    return this.recordIndex.put(record)
  }

  /**
   * Read one layer-1 node.
   * @param id - the node identity.
   * @returns the node, or `undefined` when the id is unknown.
   */
  getNode(id: MemoryNodeId): MemoryNode | undefined {
    return this.nodeIndex.get(id)
  }

  /**
   * Enumerate layer-1 nodes across partitions.
   * @param scopes - the partition keys to read.
   * @returns a snapshot iterable.
   */
  nodes(scopes: readonly MemoryScopeKey[]): Iterable<MemoryNode> {
    return this.nodeIndex.list(scopes)
  }

  /**
   * Insert or replace one layer-1 node.
   * @param node - the complete node.
   * @returns resolution once the write is durable.
   */
  putNode(node: MemoryNode): Promise<void> {
    return this.nodeIndex.put(node)
  }

  /**
   * Read one layer-1 edge.
   * @param id - the edge identity.
   * @returns the edge, or `undefined` when the id is unknown.
   */
  getEdge(id: MemoryEdgeId): MemoryEdge | undefined {
    return this.edgeIndex.get(id)
  }

  /**
   * Enumerate layer-1 edges across partitions.
   * @param scopes - the partition keys to read.
   * @returns a snapshot iterable.
   */
  edges(scopes: readonly MemoryScopeKey[]): Iterable<MemoryEdge> {
    return this.edgeIndex.list(scopes)
  }

  /**
   * Insert or replace one layer-1 edge.
   * @param edge - the complete edge.
   * @returns resolution once the write is durable.
   */
  putEdge(edge: MemoryEdge): Promise<void> {
    return this.edgeIndex.put(edge)
  }

  /**
   * Permanently remove one layer-0 record.
   * @param id - the record identity.
   * @returns whether a record existed to erase.
   */
  eraseRecord(id: MemoryRecordId): Promise<boolean> {
    return this.recordIndex.erase(id)
  }
}

/**
 * Open the memory domain and mount the store on the hub.
 *
 * The domain handle is owned here: its close runs as this plugin's disposer, so
 * unloading the provider releases the medium and unmounts the store together
 * rather than leaving the hub pointing at a closed domain.
 * @param ctx - registrant context carrying the hub and the domain layer.
 * @returns resolution after the domain is open and the store is mounted.
 */
export async function apply(ctx: Context): Promise<void> {
  const domain = await ctx.storageDomain.open(memoryDomainSpec)
  ctx.effect(() => async () => {
    await domain.close()
  })
  ctx.effect(() => ctx.memory.registerStore(new DomainMemoryStore(domain)))
}
