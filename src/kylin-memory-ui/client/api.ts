import type { Context } from '@deepseek-ai/cordis'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import type {} from '@deepseek-ai/dsh-client-connection/client'

/** One safe row returned by the read-only memory host channel. */
export interface KylinMemoryItem {
  readonly id: string
  readonly kind: 'node' | 'record'
  readonly type: string
  readonly label: string
  readonly summary: string
  readonly status: string
  readonly scope: string
  readonly createdAt: number
  readonly updatedAt?: number
  readonly evidenceCount: number
}

/** Successful read result from the host channel. */
export interface KylinMemoryData {
  readonly items: readonly KylinMemoryItem[]
  readonly mode: 'lexical' | 'semantic' | null
}

const CHANNEL = '/kylin-memory-ui'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isMemoryItem(value: unknown): value is KylinMemoryItem {
  if (!isRecord(value)) return false
  return typeof value.id === 'string'
    && (value.kind === 'node' || value.kind === 'record')
    && typeof value.type === 'string'
    && typeof value.label === 'string'
    && typeof value.summary === 'string'
    && typeof value.status === 'string'
    && typeof value.scope === 'string'
    && typeof value.createdAt === 'number'
    && (value.updatedAt === undefined || typeof value.updatedAt === 'number')
    && typeof value.evidenceCount === 'number'
}

function parseMemoryResponse(value: unknown): KylinMemoryData {
  if (!isRecord(value)) throw new Error('invalid memory response')
  if (value.ok === false) {
    const error = isRecord(value.error) ? value.error : undefined
    const failure = new Error(typeof error?.message === 'string' ? error.message : 'memory request failed')
    if (typeof error?.code === 'string') failure.name = error.code
    throw failure
  }
  if (value.ok !== true || !isRecord(value.data)) throw new Error('invalid memory response')
  const items = value.data.items
  const mode = value.data.mode
  if (!Array.isArray(items) || !items.every(isMemoryItem)) throw new Error('invalid memory items')
  if (mode !== null && mode !== 'lexical' && mode !== 'semantic') throw new Error('invalid memory mode')
  return { items, mode }
}

/** Runtime check for the browser Connection service; the host and browser faces differ. */
function isConnectionHandle(value: unknown): value is ConnectionHandle {
  if (!isRecord(value)) return false
  const rpc = Reflect.get(value, 'rpc')
  return isRecord(rpc) && typeof Reflect.get(rpc, 'call') === 'function'
}

function clientConnection(ctx: Context): ConnectionHandle {
  const candidate: unknown = ctx.connection
  if (!isConnectionHandle(candidate)) throw new Error('memory connection is unavailable')
  return candidate
}

/**
 * Read one page of safe memory rows through the generic connection channel.
 * @param ctx - client context carrying the connection service.
 * @param endpoint - profile listing or recall search.
 * @param payload - session identity and optional query/limit.
 * @param signal - caller cancellation.
 * @returns the host projection after wire validation.
 */
export async function readMemory(
  ctx: Context,
  endpoint: 'list' | 'search',
  payload: { readonly sessionId: string; readonly query?: string; readonly limit?: number },
  signal?: AbortSignal,
): Promise<KylinMemoryData> {
  const result = await clientConnection(ctx).rpc.call(CHANNEL, endpoint, payload, signal)
  if (!result.ok) throw new Error(result.error.message)
  return parseMemoryResponse(result.value)
}
