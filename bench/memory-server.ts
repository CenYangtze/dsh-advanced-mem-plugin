/**
 * The Advanced Memory plugin behind a small HTTP seam, so a Python agent can use it.
 *
 * OSWorld's agent loop is Python and this plugin is TypeScript on cordis. Rather
 * than reimplement recall on the Python side — which would measure a
 * reimplementation rather than the plugin — this exposes the real
 * {@link MemoryStack} over three endpoints and lets the agent call it.
 *
 * State is per `scope`, so one process can serve a whole continual-learning run:
 * the agent posts what happened after each task and recalls before the next, and
 * `/reset` starts the no-memory arm from a clean store without a restart.
 *
 * ```
 * node --experimental-transform-types bench/memory-server.ts --port 8848 \
 *   [--embed-model baai/bge-m3 --embed-dims 1024 --embed-cache path.jsonl]
 * ```
 *
 * @module dsh-advanced-mem-plugin/bench/memory-server
 */

import { createServer } from 'node:http'
import { MemoryStack } from './stack.ts'

/** Everything the server was told to do. */
interface Options {
  readonly port: number
  readonly recallLimit: number
  readonly includeEvidence: boolean
  readonly consolidate: boolean
  readonly embedModel: string
  readonly embedDims: number
  readonly embedCache: string
}

/**
 * Read the command line.
 * @param argv - arguments after the script name.
 * @returns the parsed options.
 */
function parseArgs(argv: readonly string[]): Options {
  const flags = new Map<string, string>()
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] ?? ''
    if (!arg.startsWith('--')) continue
    const value = argv[index + 1]
    if (value === undefined || value.startsWith('--')) flags.set(arg.slice(2), 'true')
    else {
      flags.set(arg.slice(2), value)
      index += 1
    }
  }
  return {
    port: Number(flags.get('port') ?? 8848),
    recallLimit: Number(flags.get('recall-limit') ?? 6),
    includeEvidence: flags.get('include-evidence') === 'true',
    consolidate: flags.get('consolidate') === 'true',
    embedModel: flags.get('embed-model') ?? '',
    embedDims: Number(flags.get('embed-dims') ?? 1024),
    embedCache: flags.get('embed-cache') ?? '',
  }
}

/** Read a request body as JSON. */
async function readJson(stream: AsyncIterable<Buffer>): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  for await (const chunk of stream) chunks.push(chunk)
  const text = Buffer.concat(chunks).toString('utf8')
  return text.length === 0 ? {} : JSON.parse(text) as Record<string, unknown>
}

const options = parseArgs(process.argv.slice(2))

/** Build a fresh stack; `/reset` calls this to start an arm with an empty store. */
async function makeStack(): Promise<MemoryStack> {
  return MemoryStack.create({
    recallLimit: options.recallLimit,
    dimensions: 0,
    vectorWeight: 1,
    includeEvidence: options.includeEvidence,
    consolidate: options.consolidate,
    ...(options.embedModel === ''
      ? {}
      : {
          apiEmbedder: {
            model: options.embedModel,
            baseUrl: process.env['OPENAI_BASE_URL'] ?? '',
            apiKey: process.env['OPENAI_API_KEY'] ?? '',
            dimensions: options.embedDims,
            cachePath: options.embedCache === '' ? 'bench/out/emb-osworld.jsonl' : options.embedCache,
            batch: 32,
            concurrency: 4,
          },
        }),
  })
}

let stack = await makeStack()
let written = 0

const server = createServer((request, response) => {
  void (async (): Promise<void> => {
    const send = (code: number, body: unknown): void => {
      const encoded = JSON.stringify(body)
      response.writeHead(code, { 'content-type': 'application/json' })
      response.end(encoded)
    }
    try {
      const url = request.url ?? '/'
      if (request.method === 'GET' && url === '/health') {
        send(200, { ok: true, records: stack.records, written, embedder: options.embedModel || 'lexical' })
        return
      }
      const body = await readJson(request)
      if (url === '/reset') {
        await stack.dispose()
        stack = await makeStack()
        written = 0
        send(200, { ok: true })
        return
      }
      if (url === '/remember') {
        const text = String(body['text'] ?? '')
        if (text.trim().length === 0) {
          send(400, { error: 'text is required' })
          return
        }
        written += 1
        await stack.ingest([{
          id: String(body['id'] ?? `mem-${written}`),
          text,
          // Default to a user-authored kind: what the run writes back is a
          // record of what the *task* required, not the agent's own chatter.
          kind: (body['kind'] as 'user-message' | undefined) ?? 'user-message',
          session: String(body['session'] ?? 'osworld'),
          turn: written,
          // A dated corpus ranks reproducibly only if the record carries its
          // own clock reading; otherwise every line is "now" and decay is noise.
          ...(typeof body['at'] === 'number' ? { at: body['at'] } : {}),
        }])
        send(200, { ok: true, records: stack.records })
        return
      }
      if (url === '/recall') {
        const query = String(body['text'] ?? '')
        const result = await stack.retrieveTexts(query)
        // Ids travel with the text so the caller can tell the store which cue
        // failed to help; text alone gives it no way to point back.
        send(200, { cues: result.map(cue => cue.text), ids: result.map(cue => cue.id) })
        return
      }
      if (url === '/contradict') {
        const ids = Array.isArray(body['ids']) ? body['ids'] as string[] : []
        let retired = 0
        for (const id of ids) if (await stack.strikeRecord(String(id))) retired += 1
        send(200, { ok: true, struck: ids.length, retired })
        return
      }
      send(404, { error: `no route ${url}` })
    } catch (error) {
      send(500, { error: String(error) })
    }
  })()
})

server.listen(options.port, () => {
  process.stderr.write(
    `memory-server on :${options.port}  embedder=${options.embedModel || 'lexical(shipped)'} `
    + `limit=${options.recallLimit} evidence=${options.includeEvidence} graph=${options.consolidate}\n`,
  )
})
