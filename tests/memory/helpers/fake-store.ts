import type {
  MemoryDistillerProgress,
  MemoryEdge,
  MemoryEdgeId,
  MemoryNode,
  MemoryNodeId,
  MemoryProgressId,
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
  readonly progressRows = new Map<string, MemoryDistillerProgress>()

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

  get progressStore(): this {
    return this
  }

  getProgress(id: MemoryProgressId): MemoryDistillerProgress | undefined {
    return this.progressRows.get(id)
  }

  progress(scopes: readonly MemoryScopeKey[]): Iterable<MemoryDistillerProgress> {
    return [...this.progressRows.values()].filter(row => scopes.includes(row.scope))
  }

  putProgress(progress: MemoryDistillerProgress): Promise<void> {
    this.progressRows.set(progress.id, progress)
    return Promise.resolve()
  }

  eraseProgress(id: MemoryProgressId): Promise<boolean> {
    return Promise.resolve(this.progressRows.delete(id))
  }

  eraseNode(id: MemoryNodeId): Promise<boolean> {
    return Promise.resolve(this.nodeRows.delete(id))
  }

  eraseEdge(id: MemoryEdgeId): Promise<boolean> {
    return Promise.resolve(this.edgeRows.delete(id))
  }

  async eraseRecord(id: MemoryRecordId): Promise<boolean> {
    const erased = this.recordRows.delete(id)
    for (const [progressId, row] of this.progressRows) {
      if (row.record === id) this.progressRows.delete(progressId)
    }
    return erased
  }
}
