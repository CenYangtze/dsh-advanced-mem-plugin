/**
 * Read-only host API for the Kylin visual memory surface.
 *
 * The browser half sends one `sessionId` and either lists the standing profile
 * or searches with a query. The host resolves the session through the live
 * `ctx.sessions` store and derives its memory scopes with `sessionScope`; a
 * client-supplied scope is never accepted, so this channel cannot become a
 * lookup into another session's or workspace's memory.
 *
 * Results are projections, not stored rows: only the fields the surface needs
 * leave the process, and layer-0 records stay `recallable` unless an audited
 * caller asks otherwise (this entry never asks). No write path, embedding,
 * provider credential, or raw evidence crosses the channel.
 *
 * @module dsh-advanced-mem-plugin/kylin-memory-ui
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { clientRequestSchema } from '@deepseek-ai/dsh-client-connection'
import type { PeerScope } from '@deepseek-ai/dsh-client-connection'
import { SessionId } from '@deepseek-ai/dsh-session'
import { sessionScope } from '../memory/index.ts'
import type {
  MemoryNode,
  MemoryRecord,
  MemoryScope,
} from '../memory/index.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'kylin-memory-ui'

/** Services the host entry reads. */
export const inject = ['memory', 'sessions', 'connection', 'webServer']

/** Absolute channel the browser half calls with `list` and `search`. */
const CHANNEL = '/kylin-memory-ui'

/** Largest JSON request body this read-only route buffers. */
const MAX_REQUEST_BODY_BYTES = 1_048_576

/** Whether an item is a layer-1 belief or a layer-0 record. */
export type KylinMemoryItemKind = 'node' | 'record'

/** Retrieval mode that actually ran; `null` for a profile listing. */
export type KylinMemoryMode = 'lexical' | 'semantic' | null

/** Stable failure categories for the browser half. */
export type KylinMemoryErrorCode =
  | 'invalid-input'
  | 'limit-out-of-range'
  | 'session-not-found'
  | 'forbidden'
  | 'unknown-endpoint'
  | 'internal'

/** One safe row the visual surface may render. */
export interface KylinMemoryItem {
  /** Durable item identity. */
  readonly id: string
  /** Layer the item came from. */
  readonly kind: KylinMemoryItemKind
  /** Node type for a belief, record kind for an episode. */
  readonly type: string
  /** Short title; for a record this is its kind. */
  readonly label: string
  /** Safe one-sentence body or record text. */
  readonly summary: string
  /** Lifecycle status of the stored item. */
  readonly status: string
  /** Durable memory partition key. */
  readonly scope: string
  /** Epoch milliseconds of creation. */
  readonly createdAt: number
  /** Epoch milliseconds of the last belief change; nodes only. */
  readonly updatedAt?: number
  /** Layer-0 records cited by a node; zero for a record. */
  readonly evidenceCount: number
}

/** Successful read result. */
export interface KylinMemoryData {
  /** Ranked safe rows. */
  readonly items: readonly KylinMemoryItem[]
  /** `null` for a list, otherwise the mode recall actually ran. */
  readonly mode: KylinMemoryMode
}

/** The fixed result protocol the browser half consumes. */
export type KylinMemoryResponse =
  | { readonly ok: true; readonly data: KylinMemoryData }
  | { readonly ok: false; readonly error: { readonly code: KylinMemoryErrorCode; readonly message: string } }

/**
 * Retrieval breadth for the surface. Both values are required so a deployment
 * states the profile size and the largest search it accepts.
 */
export interface Config {
  /** Items returned by a request that does not state its own limit. */
  defaultLimit: number
  /** Largest limit the channel accepts; requests above it fail. */
  maxLimit: number
}

/** Schemastery validation for {@link Config}. */
export const Config: z<Config> = z.object({
  defaultLimit: z.number().required(),
  maxLimit: z.number().required(),
})

/** Validated request fields after the wire payload has been narrowed. */
interface ParsedRequest {
  readonly sessionId: string
  readonly query?: string
  readonly limit: number
}

/** One endpoint's successful or failed protocol result. */
function success(items: readonly KylinMemoryItem[], mode: KylinMemoryMode): KylinMemoryResponse {
  return { ok: true, data: { items, mode } }
}

/** Build one fixed, non-sensitive protocol failure. */
function failure(code: KylinMemoryErrorCode, message: string): KylinMemoryResponse {
  return { ok: false, error: { code, message } }
}

/** Project one safe layer-1 belief onto the surface fields. */
function nodeItem(node: MemoryNode): KylinMemoryItem {
  return {
    id: node.id,
    kind: 'node',
    type: node.type,
    label: node.label,
    summary: node.summary,
    status: node.status,
    scope: node.scope,
    createdAt: node.createdAt,
    updatedAt: node.updatedAt,
    evidenceCount: node.evidence.length,
  }
}

/**
 * Project one safe layer-0 record onto the surface fields.
 *
 * The record has no natural short title, so its kind stands in; the text is
 * the body. A record cites no layer-0 records, hence `evidenceCount: 0`.
 */
function recordItem(record: MemoryRecord): KylinMemoryItem {
  return {
    id: record.id,
    kind: 'record',
    type: record.kind,
    label: record.kind,
    summary: record.text,
    status: record.status,
    scope: record.scope,
    createdAt: record.createdAt,
    evidenceCount: 0,
  }
}

/** Narrow and validate the client payload at the wire boundary. */
function parseRequest(
  payload: unknown,
  endpoint: 'list' | 'search',
  config: Config,
): ParsedRequest | KylinMemoryResponse {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    return failure('invalid-input', 'request body must be an object')
  }
  const record = payload as Record<string, unknown>
  const rawSessionId = record.sessionId
  if (typeof rawSessionId !== 'string' || rawSessionId.trim().length === 0) {
    return failure('invalid-input', 'sessionId must be a non-empty string')
  }
  const rawQuery = record.query
  let query: string | undefined
  if (rawQuery !== undefined) {
    if (typeof rawQuery !== 'string') return failure('invalid-input', 'query must be a string')
    const trimmed = rawQuery.trim()
    if (trimmed.length > 0) query = trimmed
  }
  if (endpoint === 'search' && query === undefined) {
    return failure('invalid-input', 'search requires a non-empty query')
  }
  let limit = config.defaultLimit
  const rawLimit = record.limit
  if (rawLimit !== undefined) {
    if (typeof rawLimit !== 'number'
      || !Number.isSafeInteger(rawLimit)
      || rawLimit < 1
      || rawLimit > config.maxLimit) {
      return failure(
        'limit-out-of-range',
        `limit must be a positive integer no greater than ${String(config.maxLimit)}`,
      )
    }
    limit = rawLimit
  }
  return {
    sessionId: rawSessionId.trim(),
    ...(query === undefined ? {} : { query }),
    limit,
  }
}

/** Read the live session and derive the only scopes the surface may touch. */
function resolveScopes(ctx: Context, sessionId: string): MemoryScope[] | KylinMemoryResponse {
  const session = ctx.sessions.get(SessionId(sessionId))
  if (session === undefined) {
    return failure('session-not-found', 'the requested session is not available')
  }
  return [sessionScope(session), { kind: 'user' }]
}

/**
 * Execute one protocol request without throwing into the raw RPC envelope.
 *
 * Every store or provider failure is contained and replaced with a fixed
 * diagnostic: provider text, queries, and record material never reach the
 * error message.
 */
async function dispatch(
  ctx: Context,
  config: Config,
  endpoint: string,
  payload: unknown,
  signal: AbortSignal,
  peer: PeerScope,
): Promise<KylinMemoryResponse> {
  // PrincipalMap is merge-extensible; drivers add non-owner kinds. Raw RPC
  // admission authenticates the transport, not the owner-only memory scope.
  // oxlint-disable-next-line typescript/no-unnecessary-condition -- see above.
  if (peer.principal.kind !== 'owner') return failure('forbidden', 'owner access is required')
  if (endpoint !== 'list' && endpoint !== 'search') {
    return failure('unknown-endpoint', 'unknown memory endpoint')
  }
  const parsed = parseRequest(payload, endpoint, config)
  if ('ok' in parsed) return parsed
  const scopes = resolveScopes(ctx, parsed.sessionId)
  if (!Array.isArray(scopes)) return scopes
  try {
    if (endpoint === 'list') {
      const profile = ctx.memory.profile(scopes, { limit: parsed.limit })
      return success(profile.nodes.map(nodeItem), null)
    }
    const recall = await ctx.memory.recall({
      text: parsed.query ?? '',
      scopes,
      limit: parsed.limit,
      includeEvidence: false,
      signal,
    })
    const items: KylinMemoryItem[] = []
    for (const cue of recall.cues) {
      // Edges are not part of the first surface, and promoting one to a node
      // would invent an identity the store never issued.
      if (cue.kind === 'node') items.push(nodeItem(cue.node))
      else if (cue.kind === 'record') items.push(recordItem(cue.record))
    }
    return success(items.slice(0, parsed.limit), recall.mode)
  } catch (error: unknown) {
    // The raw RPC bridge copies a thrown message into its response; contain
    // store and provider failures here with one fixed diagnostic instead.
    void error
    return failure('internal', 'the memory request could not be completed')
  }
}

/** Map the channel path to its endpoint segment. */
function endpointOf(pathname: string): string | undefined {
  if (!pathname.startsWith(`${CHANNEL}/`)) return undefined
  const endpoint = pathname.slice(CHANNEL.length + 1)
  if (endpoint.length === 0 || endpoint.includes('/')) return undefined
  return endpoint
}

/** Read one bounded JSON body from the node carrier. */
async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.byteLength
    if (size > MAX_REQUEST_BODY_BYTES) throw new Error('request body too large')
    chunks.push(buffer)
  }
  return Buffer.concat(chunks).toString('utf8')
}

/** Write one JSON response unless the carrier already closed it. */
function sendJson(response: ServerResponse, status: number, value: unknown): void {
  if (response.writableEnded) return
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  response.end(JSON.stringify(value))
}

/**
 * Serve one channel request through the plugin's own Web route.
 *
 * `ctx.connection.rpc.handle` registers through the Connection service's
 * shadowed owner context, so its `owner.webServer` lookup starts at the
 * Connection fiber and fails when WebServer is a sibling plugin. This route
 * uses the plugin's own injected `webServer` face and still delegates request
 * admission to Connection.
 */
async function handleRequest(
  ctx: Context,
  config: Config,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const admission = ctx.connection.admit(request)
  if ('rejection' in admission) {
    response.writeHead(admission.rejection)
    response.end(admission.rejection === 401 ? 'unauthorized' : 'forbidden')
    return
  }
  if (request.method !== 'POST') {
    response.writeHead(404)
    response.end()
    return
  }
  const pathname = new URL(request.url ?? '/', 'http://dsh.internal').pathname
  const endpoint = endpointOf(pathname)
  if (endpoint === undefined) {
    response.writeHead(404)
    response.end()
    return
  }
  const mediaType = request.headers['content-type']?.split(';', 1)[0]?.trim().toLowerCase()
  if (mediaType !== 'application/json') {
    response.writeHead(415)
    response.end('content type must be application/json')
    return
  }
  let raw: string
  try {
    raw = await readBody(request)
  } catch {
    response.writeHead(413)
    response.end('request body too large')
    return
  }
  let body: unknown
  try {
    body = JSON.parse(raw)
  } catch {
    response.writeHead(400)
    response.end('body is not JSON')
    return
  }
  const envelope = clientRequestSchema.safeParse(body)
  if (!envelope.success) {
    response.writeHead(400)
    response.end('invalid client-request message')
    return
  }
  const message = envelope.data
  const abort = new AbortController()
  request.once('close', () => {
    if (!response.writableEnded) abort.abort()
  })
  const result = message.method === endpoint
    ? await dispatch(ctx, config, endpoint, message.payload, abort.signal, admission.peer)
    : failure('unknown-endpoint', 'unknown memory endpoint')
  sendJson(response, 200, {
    type: 'server-response',
    rpcId: message.rpcId,
    result: { ok: true, value: result },
  })
}

/**
 * Register the read-only channel for the lifetime of `ctx`.
 * @param ctx - registrant context carrying memory, sessions, connection, and webServer.
 * @param config - default and maximum result limits.
 * @throws when either limit is not a positive safe integer or `defaultLimit`
 *   exceeds `maxLimit`.
 */
export function apply(ctx: Context, config: Config): void {
  for (const [field, value] of [
    ['defaultLimit', config.defaultLimit],
    ['maxLimit', config.maxLimit],
  ] as const) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new TypeError(`kylin-memory-ui: ${field} must be a positive safe integer, got ${String(value)}`)
    }
  }
  if (config.defaultLimit > config.maxLimit) {
    throw new TypeError('kylin-memory-ui: defaultLimit must not exceed maxLimit')
  }
  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: CHANNEL,
    handler: async (request, response) => {
      try {
        await handleRequest(ctx, config, request, response)
      } catch (error: unknown) {
        // Keep even an unexpected failure from carrying provider or record text.
        void error
        if (!response.writableEnded) {
          response.writeHead(500)
          response.end('memory request failed')
        }
      }
    },
  }), `kylin-memory-ui: ${CHANNEL} route`)
}
