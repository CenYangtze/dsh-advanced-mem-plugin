import { createHash, randomUUID } from 'node:crypto'
import { mkdir, open, readFile, readdir, rename, unlink } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { ExperienceSnapshotSchema } from './schema.ts'
import type { ExperienceSnapshot, ExperienceStore } from './types.ts'

export { ExperienceSnapshotSchema } from './schema.ts'

function hasCode(error: unknown, code: string): boolean {
  return error !== null && typeof error === 'object' && 'code' in error && error.code === code
}

/**
 * Standalone durable store for API clients. One owner holds an exclusive lease;
 * another process cannot silently replace a snapshot read by this owner.
 * Harness installations normally use the storage-domain provider instead.
 */
export class FileExperienceStore implements ExperienceStore {
  readonly directory: string
  private lease: Promise<FileHandle> | undefined
  private closed = false

  constructor(directory: string) {
    if (!directory.trim()) throw new Error('Experience store directory is required')
    this.directory = resolve(directory)
  }

  private ready(): Promise<FileHandle> {
    if (this.closed) return Promise.reject(new Error('Experience store is closed'))
    if (this.lease) return this.lease
    this.lease = (async () => {
      await mkdir(this.directory, { recursive: true })
      const lock = join(this.directory, '.writer.lock')
      let handle: FileHandle
      try { handle = await open(lock, 'wx', 0o600) }
      catch (error) {
        if (hasCode(error, 'EEXIST')) throw new Error(`Experience store is already owned: ${lock}. After an interrupted process, verify the recorded owner has stopped before removing this lock.`)
        throw error
      }
      try {
        await handle.writeFile(JSON.stringify({ pid: process.pid, openedAt: Date.now() }))
        await handle.sync()
        // Recover only our interrupted transaction files after obtaining ownership.
        for (const entry of await readdir(this.directory)) {
          if (/^[a-f0-9]{64}\.json\.[a-f0-9-]{36}\.tmp$/u.test(entry)) await unlink(join(this.directory, entry))
        }
        return handle
      } catch (error) {
        await handle.close()
        await unlink(lock)
        throw error
      }
    })()
    return this.lease
  }

  private file(scope: string): string {
    if (!scope.trim()) throw new Error('Experience scope is required')
    return join(this.directory, `${createHash('sha256').update(scope).digest('hex')}.json`)
  }

  async get(scope: string): Promise<ExperienceSnapshot | undefined> {
    await this.ready()
    let raw: string
    try { raw = await readFile(this.file(scope), 'utf8') }
    catch (error) { if (hasCode(error, 'ENOENT')) return undefined; throw error }
    const snapshot = ExperienceSnapshotSchema.parse(JSON.parse(raw))
    if (snapshot.scope !== scope) throw new Error('Experience file has a mismatched scope')
    return snapshot
  }

  async put(scope: string, value: ExperienceSnapshot): Promise<void> {
    await this.ready()
    const snapshot = ExperienceSnapshotSchema.parse(value)
    if (snapshot.scope !== scope) throw new Error('Experience snapshot has a mismatched scope')
    const file = this.file(scope)
    const temporary = `${file}.${randomUUID()}.tmp`
    const handle = await open(temporary, 'wx', 0o600)
    try {
      try { await handle.writeFile(JSON.stringify(snapshot)); await handle.sync() }
      finally { await handle.close() }
      await rename(temporary, file)
      if (process.platform !== 'win32') {
        const directory = await open(this.directory, 'r')
        try { await directory.sync() } finally { await directory.close() }
      }
    } catch (error) {
      try { await unlink(temporary) } catch (cleanup) { if (!hasCode(cleanup, 'ENOENT')) throw cleanup }
      throw error
    }
  }

  async delete(scope: string): Promise<void> {
    await this.ready()
    try { await unlink(this.file(scope)) } catch (error) { if (!hasCode(error, 'ENOENT')) throw error }
  }

  /** Call after outstanding core operations settle to release the directory. */
  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    if (!this.lease) return
    let handle: FileHandle
    try { handle = await this.lease } catch { return }
    await handle.close()
    await unlink(join(this.directory, '.writer.lock'))
  }
}
