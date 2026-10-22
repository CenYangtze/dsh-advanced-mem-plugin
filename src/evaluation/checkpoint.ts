import { mkdir, open, readFile, writeFile, unlink } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { join } from 'node:path'
import { fingerprint } from './datasets.ts'
import type { EvaluationCheckpoint, EvaluationManifest, EvaluationResult } from './types.ts'

/** One writer per run directory; completed attempts are durable before scheduling continues. */
export class JsonlCheckpoint implements EvaluationCheckpoint {
  private lock: FileHandle | undefined
  private output: FileHandle | undefined
  private chain: Promise<void> = Promise.resolve()
  constructor(readonly directory: string) {}

  async open(manifest: EvaluationManifest): Promise<readonly EvaluationResult[]> {
    if (this.lock) throw new Error('Checkpoint is already open')
    await mkdir(this.directory, { recursive: true })
    this.lock = await open(join(this.directory, 'writer.lock'), 'wx')
    await this.lock.writeFile(JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }))
    const manifestPath = join(this.directory, 'manifest.json')
    try {
      const existing: unknown = JSON.parse(await readFile(manifestPath, 'utf8'))
      if (fingerprint(existing) !== fingerprint(manifest)) throw new Error('Resume manifest differs from the original run')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' })
    }
    const path = join(this.directory, 'results.jsonl')
    let content: string
    try { content = await readFile(path, 'utf8') } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      content = ''
    }
    const complete = content.lastIndexOf('\n') + 1
    // A crash may interrupt the final write; only the incomplete suffix is removed.
    if (complete < content.length) {
      // Windows append handles cannot truncate; repair with a separate read/write handle.
      const repair = await open(path, 'r+')
      try { await repair.truncate(Buffer.byteLength(content.slice(0, complete))) } finally { await repair.close() }
    }
    this.output = await open(path, 'a')
    return content.slice(0, complete).split('\n').filter(Boolean).map((line, i) => {
      const row = JSON.parse(line) as EvaluationResult
      if (typeof row.id !== 'string' || !['completed', 'failed'].includes(row.status) || !Number.isFinite(row.durationMs)) throw new Error(`Invalid checkpoint row ${i + 1}`)
      return row
    })
  }

  async append(result: EvaluationResult): Promise<void> {
    const output = this.output
    if (!output) throw new Error('Checkpoint is not open')
    this.chain = this.chain.then(async () => { await output.write(`${JSON.stringify(result)}\n`); await output.sync() })
    return this.chain
  }

  async close(): Promise<void> {
    try { await this.chain } finally {
      await this.output?.close()
      this.output = undefined
      if (this.lock) {
        await this.lock.close()
        this.lock = undefined
        await unlink(join(this.directory, 'writer.lock'))
      }
    }
  }
}
