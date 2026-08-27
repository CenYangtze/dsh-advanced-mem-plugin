import type {
  MemoryEdge,
  MemoryEdgeId,
  MemoryNode,
  MemoryNodeId,
  MemoryRecord,
  MemoryRecordId,
  MemoryScopeKey,
  MemoryStore,
} from '../../../src/memory/index.ts'

/**
 * A store with no medium behind it. The hub's contract is synchronous reads and
 * asynchronous writes, and this satisfies it with plain maps so hub tests
 * exercise retrieval and belief dynamics rather than persistence.
 */
export class FakeMemoryStore implements MemoryStore {
  readonly name = 'fake'
  readonly recordRows = new Map<string, MemoryRecord>()
  readonly nodeRows = new Map<string, MemoryNode>()
  readonly edgeRows = new Map<string, MemoryEdge>()

  getRecord(id: MemoryRecordId): MemoryRecord | undefined {
    return this.recordRows.get(id)
  }

  records(scopes: readonly MemoryScopeKey[]): Iterable<MemoryRecord> {
    return [...this.recordRows.values()].filter(record => scopes.includes(record.scope))
  }

  putRecord(record: MemoryRecord): Promise<void> {
    this.recordRows.set(record.id, record)
    return Promise.resolve()
  }

  getNode(id: MemoryNodeId): MemoryNode | undefined {
    return this.nodeRows.get(id)
  }

  nodes(scopes: readonly MemoryScopeKey[]): Iterable<MemoryNode> {
    return [...this.nodeRows.values()].filter(node => scopes.includes(node.scope))
  }

  putNode(node: MemoryNode): Promise<void> {
    this.nodeRows.set(node.id, node)
    return Promise.resolve()
  }

  getEdge(id: MemoryEdgeId): MemoryEdge | undefined {
    return this.edgeRows.get(id)
  }

  edges(scopes: readonly MemoryScopeKey[]): Iterable<MemoryEdge> {
    return [...this.edgeRows.values()].filter(edge => scopes.includes(edge.scope))
  }

  putEdge(edge: MemoryEdge): Promise<void> {
    this.edgeRows.set(edge.id, edge)
    return Promise.resolve()
  }

  eraseRecord(id: MemoryRecordId): Promise<boolean> {
    return Promise.resolve(this.recordRows.delete(id))
  }
}
