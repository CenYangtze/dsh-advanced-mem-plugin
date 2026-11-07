import type { IncomingMessage } from 'node:http'
import { describe, expect, it } from 'vitest'
import { Context, Service } from '@deepseek-ai/cordis'
import CredentialProvider from '@deepseek-ai/dsh-credentials'
import type {
  CredentialInfo,
  CredentialKey,
  CredentialRecord,
  CredentialRecordEntry,
  CredentialRecordInfo,
  CredentialRef,
  ResolvedCredential,
} from '@deepseek-ai/dsh-credentials'
import { WebServer } from '@deepseek-ai/dsh-host-webserver'
import * as clientConnection from '@deepseek-ai/dsh-client-connection'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import type {
  HostConnectionHandle,
  PeerId,
  PeerScope,
  Principal,
} from '@deepseek-ai/dsh-client-connection'
import MemoryRuntime, {
  MemoryEdgeId,
  MemoryNodeId,
  MemoryRecordId,
  memoryScopeKey,
  tokenize,
} from '../../src/memory/index.ts'
import type {
  Config as MemoryConfig,
  MemoryEdge,
  MemoryNode,
  MemoryNodeType,
  MemoryRecord,
  MemoryRecordKind,
  MemoryRecordUse,
  MemoryScope,
  MemoryStatus,
} from '../../src/memory/index.ts'
import * as kylin from '../../src/kylin-memory-ui/index.ts'
import type { KylinMemoryData, KylinMemoryResponse } from '../../src/kylin-memory-ui/index.ts'
import { FakeMemoryStore } from '../memory/helpers/fake-store.ts'

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface PrincipalMap {
    /** Test-only non-owner caller, standing in for an authenticated API peer. */
    guest: { readonly kind: 'guest' }
  }
}

const CHANNEL = '/kylin-memory-ui'
const SIGNAL = new AbortController().signal
const WORKSPACE: MemoryScope = { kind: 'workspace', workspace: '/repo' }

const memoryConfig: MemoryConfig = {
  recallLimit: 10,
  profileLimit: 10,
  inferredConfidence: 0.4,
  assertedConfidence: 0.9,
  inferredHalfLifeMs: 1_000_000_000,
  assertedHalfLifeMs: 0,
  reinforcementRate: 0.3,
  contradictionRate: 0.5,
  retirementFloor: 0.1,
  activationHops: 1,
  activationFalloff: 0.5,
  recordBudget: 100,
  supportWeight: 0,
  duplicateThreshold: 1,
  diversityThreshold: 1,
  vectorWeight: 1,
  safety: {
    redactPrivateKeys: true,
    redactProviderTokens: true,
    redactBearerTokens: true,
    redactSecretAssignments: true,
    rejectSensitivePatterns: false,
    blockedLiterals: [],
  },
}

const kylinConfig: kylin.Config = { defaultLimit: 2, maxLimit: 10 }

/** Connection double that only decides the request principal; the carrier is real. */
class TestConnection extends Service {
  constructor(ctx: Context) {
    super(ctx, 'connection')
  }

  admit(request: IncomingMessage): { peer: PeerScope } {
    const guest = request.headers['x-test-role'] === 'guest'
    return { peer: peerOf(this.ctx, guest ? { kind: 'guest' } : { kind: 'owner' }) }
  }
}

/** In-memory credential provider: Connection only creates one signing grant. */
class TestCredentials extends CredentialProvider {
  private readonly records = new Map<CredentialKey, CredentialRecord>()

  resolve(_ref: CredentialRef): Promise<ResolvedCredential | undefined> {
    return Promise.resolve(undefined)
  }

  describe(_ref: CredentialRef): Promise<CredentialInfo> {
    return Promise.resolve({ configured: false, writable: true })
  }

  set(_ref: CredentialRef, _value: string): Promise<void> {
    return Promise.resolve()
  }

  unset(_ref: CredentialRef): Promise<void> {
    return Promise.resolve()
  }

  readRecord(key: CredentialKey): Promise<CredentialRecord | undefined> {
    return Promise.resolve(this.records.get(key))
  }

  describeRecord(key: CredentialKey): Promise<CredentialRecordInfo> {
    const record = this.records.get(key)
    return Promise.resolve(record === undefined
      ? { configured: false, writable: true }
      : { configured: true, kind: record.kind, writable: true })
  }

  listRecords(): Promise<readonly CredentialRecordEntry[]> {
    return Promise.resolve([...this.records].map(([key, record]) => ({ key, kind: record.kind })))
  }

  modifyRecord(
    key: CredentialKey,
    mutate: (current: CredentialRecord | undefined) => Promise<CredentialRecord | undefined>,
  ): Promise<CredentialRecord | undefined> {
    return mutate(this.records.get(key)).then((next) => {
      if (next !== undefined) this.records.set(key, next)
      return next
    })
  }

  deleteRecord(key: CredentialKey): Promise<void> {
    this.records.delete(key)
    return Promise.resolve()
  }
}

interface Harness {
  readonly ctx: Context
  readonly connection: TestConnection
  readonly store: FakeMemoryStore
  readonly plugin: { dispose(): Promise<void> }
  call(endpoint: string, payload: unknown, role?: 'owner' | 'guest'): Promise<KylinMemoryResponse>
  status(endpoint: string): Promise<number>
  dispose(): Promise<void>
}

/** Build one in-process Peer for either principal kind. */
function peerOf(ctx: Context, principal: Principal): PeerScope {
  return {
    id: 'peer-test' as PeerId,
    ctx,
    principal,
    interactions: 'answer',
    signal: SIGNAL,
    dispose: () => Promise.resolve(),
  }
}

/** Exchange a launch token for one authority-bound browser cookie. */
function browserCookie(connection: HostConnectionHandle, authority: string): string {
  const url = new URL(connection.authenticatedUrl(`http://${authority}/`))
  let setCookie: string | undefined
  const response = {
    writeHead(_status: number, headers?: Readonly<Record<string, string>>): void {
      setCookie = headers?.['set-cookie']
    },
    end(_body?: string): void {},
  }
  connection.authorizeIndex(
    { headers: { host: authority }, method: 'GET', url: `${url.pathname}${url.search}` },
    response,
  )
  if (setCookie === undefined) throw new Error('Connection did not mint a browser cookie')
  const cookie = setCookie.split(';', 1)[0]
  if (cookie === undefined) throw new Error('Connection cookie header is empty')
  return cookie
}

/** Mount the real hubs and Web carrier over one fake store and one fake Connection. */
async function setup(): Promise<Harness> {
  const ctx = new Context()
  const connection = new TestConnection(ctx)
  await ctx.plugin(SessionStore)
  await ctx.plugin(MemoryRuntime, memoryConfig)
  const store = new FakeMemoryStore()
  ctx.memory.registerStore(store)
  ctx.sessions.create(SessionId('session-1'), { meta: { cwd: '/repo' } })
  await ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 })
  const plugin = ctx.plugin(kylin, kylinConfig)
  await plugin.await()

  const web = ctx.get('webServer')
  if (web === undefined) throw new Error('webServer is not available')
  const origin = web.getOrigin()

  const call = async (
    endpoint: string,
    payload: unknown,
    role: 'owner' | 'guest' = 'owner',
  ): Promise<KylinMemoryResponse> => {
    const response = await fetch(`${origin}${CHANNEL}/${endpoint}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-test-role': role },
      body: JSON.stringify({
        type: 'client-request',
        rpcId: `rpc-${endpoint}`,
        method: endpoint,
        payload,
      }),
    })
    if (response.status !== 200) throw new Error(`unexpected HTTP status ${String(response.status)}`)
    const envelope = await response.json() as {
      result?: { ok?: boolean; value?: KylinMemoryResponse }
    }
    expect(envelope.result?.ok).toBe(true)
    const value = envelope.result?.value
    if (value === undefined) throw new Error('missing protocol result')
    return value
  }

  const status = async (endpoint: string): Promise<number> => {
    const response = await fetch(`${origin}${CHANNEL}/${endpoint}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-test-role': 'owner' },
      body: JSON.stringify({
        type: 'client-request',
        rpcId: `rpc-${endpoint}`,
        method: endpoint,
        payload: { sessionId: 'session-1' },
      }),
    })
    return response.status
  }

  return { ctx, connection, store, plugin, call, status, dispose: () => ctx.fiber.dispose() }
}

function makeNode(input: {
  id: string
  label: string
  summary: string
  scope?: MemoryScope
  type?: MemoryNodeType
  status?: MemoryStatus
  evidence?: readonly MemoryRecordId[]
  confidence?: number
  createdAt?: number
  updatedAt?: number
}): MemoryNode {
  return {
    id: MemoryNodeId(input.id),
    scope: memoryScopeKey(input.scope ?? WORKSPACE),
    type: input.type ?? 'preference',
    label: input.label,
    summary: input.summary,
    attributes: { source: 'test' },
    confidence: input.confidence ?? 0.8,
    decay: { halfLifeMs: null },
    support: {
      observations: 1,
      reinforcements: 0,
      contradictions: 0,
      sessions: 1,
      firstSeenAt: 1,
      lastSeenAt: 1,
    },
    evidence: input.evidence ?? [],
    origin: 'asserted',
    status: input.status ?? 'active',
    createdAt: input.createdAt ?? 1,
    updatedAt: input.updatedAt ?? 2,
  }
}

function makeRecord(input: {
  id: string
  text: string
  scope?: MemoryScope
  kind?: MemoryRecordKind
  use?: MemoryRecordUse
  status?: 'active' | 'retracted'
}): MemoryRecord {
  return {
    id: MemoryRecordId(input.id),
    scope: memoryScopeKey(input.scope ?? WORKSPACE),
    kind: input.kind ?? 'user-message',
    text: input.text,
    fidelity: 'verbatim',
    use: input.use ?? 'recallable',
    terms: tokenize(input.text),
    attachments: [],
    provenance: { author: input.kind === 'assistant-message' ? 'agent' : 'user' },
    createdAt: 10,
    promotedTo: [],
    status: input.status ?? 'active',
  }
}

function makeEdge(input: {
  id: string
  from: string
  to: string
  claim: string
}): MemoryEdge {
  return {
    id: MemoryEdgeId(input.id),
    scope: memoryScopeKey(WORKSPACE),
    from: MemoryNodeId(input.from),
    to: MemoryNodeId(input.to),
    relation: 'co-occurs',
    claim: input.claim,
    confidence: 0.7,
    decay: { halfLifeMs: null },
    support: {
      observations: 1,
      reinforcements: 0,
      contradictions: 0,
      sessions: 1,
      firstSeenAt: 1,
      lastSeenAt: 1,
    },
    evidence: [],
    origin: 'inferred',
    status: 'active',
    createdAt: 10,
    updatedAt: 20,
  }
}

function expectSuccess(response: KylinMemoryResponse): KylinMemoryData {
  expect(response.ok).toBe(true)
  if (!response.ok) throw new Error(response.error.message)
  return response.data
}

function errorOf(response: KylinMemoryResponse): { code: string; message: string } {
  expect(response.ok).toBe(false)
  if (response.ok) throw new Error('expected a protocol failure')
  return response.error
}

describe('kylin memory host API', () => {
  it('lists active safe nodes from the session scope chain and reports no retrieval mode', async () => {
    const h = await setup()
    try {
      await h.store.putNode(makeNode({
        id: 'n-workspace',
        label: 'Prefers metric units',
        summary: 'Use millimeters for dimensions.',
        evidence: [MemoryRecordId('r-one'), MemoryRecordId('r-two')],
        confidence: 0.9,
        createdAt: 100,
        updatedAt: 200,
      }))
      await h.store.putNode(makeNode({
        id: 'n-user',
        label: 'Writes in Chinese',
        summary: 'Answers in Chinese.',
        scope: { kind: 'user' },
        confidence: 0.5,
        createdAt: 101,
        updatedAt: 201,
      }))
      await h.store.putNode(makeNode({
        id: 'n-retracted',
        label: 'Old preference',
        summary: 'This belief was retracted.',
        status: 'retracted',
        confidence: 0.99,
      }))
      await h.store.putNode(makeNode({
        id: 'n-other-workspace',
        label: 'Other workspace preference',
        summary: 'This must not leak into the requested session.',
        scope: { kind: 'workspace', workspace: '/other' },
        confidence: 0.99,
      }))
      await h.store.putRecord(makeRecord({ id: 'r-workspace', text: 'A record that list never returns.' }))

      const response = await h.call('list', { sessionId: 'session-1', limit: 3 })

      expect(response).toEqual({
        ok: true,
        data: {
          mode: null,
          items: [
            {
              id: 'n-workspace',
              kind: 'node',
              type: 'preference',
              label: 'Prefers metric units',
              summary: 'Use millimeters for dimensions.',
              status: 'active',
              scope: 'workspace:/repo',
              createdAt: 100,
              updatedAt: 200,
              evidenceCount: 2,
            },
            {
              id: 'n-user',
              kind: 'node',
              type: 'preference',
              label: 'Writes in Chinese',
              summary: 'Answers in Chinese.',
              status: 'active',
              scope: 'user',
              createdAt: 101,
              updatedAt: 201,
              evidenceCount: 0,
            },
          ],
        },
      })
    } finally {
      await h.dispose()
    }
  })

  it('searches real recall cues as nodes and records, skipping edges and evidence-only records', async () => {
    const h = await setup()
    try {
      await h.store.putNode(makeNode({
        id: 'n-deploy',
        label: 'Deploy preferences',
        summary: 'Use metric units for deployment.',
        evidence: [MemoryRecordId('r-evidence')],
      }))
      await h.store.putNode(makeNode({
        id: 'n-rollout',
        label: 'Rollout checklist',
        summary: 'Verify the release before announcing it.',
        confidence: 0.5,
      }))
      await h.store.putRecord(makeRecord({
        id: 'r-recallable',
        text: 'Deploy uses minutes and metric units.',
      }))
      await h.store.putRecord(makeRecord({
        id: 'r-evidence',
        text: 'Deploy internal trace that must never be quoted.',
        kind: 'assistant-message',
        use: 'evidence',
      }))
      await h.store.putEdge(makeEdge({
        id: 'e-deploy',
        from: 'n-deploy',
        to: 'n-rollout',
        claim: 'Deploy preferences co-occur with rollout checks',
      }))

      const response = await h.call('search', { sessionId: 'session-1', query: 'deploy', limit: 5 })
      const data = expectSuccess(response)

      expect(data.mode).toBe('lexical')
      expect(data.items.every(item => item.kind === 'node' || item.kind === 'record')).toBe(true)
      const byId = new Map(data.items.map(item => [item.id, item]))
      expect(byId.has('r-evidence')).toBe(false)
      expect(byId.has('e-deploy')).toBe(false)
      expect(byId.get('r-recallable')).toEqual({
        id: 'r-recallable',
        kind: 'record',
        type: 'user-message',
        label: 'user-message',
        summary: 'Deploy uses minutes and metric units.',
        status: 'active',
        scope: 'workspace:/repo',
        createdAt: 10,
        evidenceCount: 0,
      })
      expect(byId.get('n-deploy')).toEqual({
        id: 'n-deploy',
        kind: 'node',
        type: 'preference',
        label: 'Deploy preferences',
        summary: 'Use metric units for deployment.',
        status: 'active',
        scope: 'workspace:/repo',
        createdAt: 1,
        updatedAt: 2,
        evidenceCount: 1,
      })
    } finally {
      await h.dispose()
    }
  })

  it('redacts sensitive text and never returns evidence-only records', async () => {
    const h = await setup()
    const secret = 'sk-abcdefghijklmnopqrstuvwx1234'
    try {
      await h.store.putNode(makeNode({
        id: 'n-key',
        label: 'Deploy key',
        summary: `The key is ${secret}`,
      }))
      await h.store.putRecord(makeRecord({ id: 'r-key', text: `The key is ${secret}` }))
      await h.store.putRecord(makeRecord({
        id: 'r-hidden',
        text: `The key is ${secret} and this trace must stay hidden.`,
        kind: 'assistant-message',
        use: 'evidence',
      }))

      const listed = await h.call('list', { sessionId: 'session-1' })
      const listedData = expectSuccess(listed)
      expect(JSON.stringify(listed)).not.toContain(secret)
      expect(listedData.items.find(item => item.id === 'n-key')?.summary)
        .toContain('[redacted:provider-token]')

      const searched = await h.call('search', { sessionId: 'session-1', query: 'key', limit: 3 })
      const searchData = expectSuccess(searched)
      expect(JSON.stringify(searched)).not.toContain(secret)
      const byId = new Map(searchData.items.map(item => [item.id, item]))
      expect(byId.has('r-hidden')).toBe(false)
      expect(byId.get('r-key')?.summary).toContain('[redacted:provider-token]')
    } finally {
      await h.dispose()
    }
  })

  it('rejects malformed requests, unknown sessions, non-owner callers, and out-of-range limits', async () => {
    const h = await setup()
    try {
      expect(errorOf(await h.call('list', { sessionId: 'missing' }))).toEqual({
        code: 'session-not-found',
        message: 'the requested session is not available',
      })
      expect(errorOf(await h.call('list', null)).code).toBe('invalid-input')
      expect(errorOf(await h.call('list', [])).code).toBe('invalid-input')
      expect(errorOf(await h.call('list', {})).code).toBe('invalid-input')
      expect(errorOf(await h.call('list', { sessionId: 42 })).code).toBe('invalid-input')
      expect(errorOf(await h.call('search', { sessionId: 'session-1' })).code).toBe('invalid-input')
      expect(errorOf(await h.call('search', { sessionId: 'session-1', query: '   ' })).code)
        .toBe('invalid-input')
      expect(errorOf(await h.call('search', { sessionId: 'session-1', query: 42 })).code)
        .toBe('invalid-input')
      expect(errorOf(await h.call('list', { sessionId: 'session-1', limit: 0 })).code)
        .toBe('limit-out-of-range')
      expect(errorOf(await h.call('list', { sessionId: 'session-1', limit: 11 })).code)
        .toBe('limit-out-of-range')
      expect(errorOf(await h.call('list', { sessionId: 'session-1', limit: 1.5 })).code)
        .toBe('limit-out-of-range')
      expect(errorOf(await h.call('list', { sessionId: 'session-1', limit: '2' })).code)
        .toBe('limit-out-of-range')
      expect(errorOf(await h.call('remove', { sessionId: 'session-1' })).code)
        .toBe('unknown-endpoint')
      expect(errorOf(await h.call('list', { sessionId: 'session-1' }, 'guest')).code).toBe('forbidden')
    } finally {
      await h.dispose()
    }
  })

  it('bounds explicit and default result counts', async () => {
    const h = await setup()
    try {
      for (const index of [1, 2, 3]) {
        await h.store.putNode(makeNode({
          id: `n-${String(index)}`,
          label: `Preference ${String(index)}`,
          summary: `Summary ${String(index)}`,
          confidence: 0.5,
        }))
      }

      expect(expectSuccess(await h.call('list', { sessionId: 'session-1' })).items).toHaveLength(2)
      expect(expectSuccess(await h.call('list', { sessionId: 'session-1', limit: 1 })).items).toHaveLength(1)
      expect(expectSuccess(await h.call('list', { sessionId: 'session-1', limit: 3 })).items).toHaveLength(3)
      expect(expectSuccess(await h.call('search', {
        sessionId: 'session-1',
        query: 'preference',
        limit: 1,
      })).items).toHaveLength(1)
    } finally {
      await h.dispose()
    }
  })

  it('removes the channel route when the plugin fiber is disposed', async () => {
    const h = await setup()
    try {
      expect(expectSuccess(await h.call('list', { sessionId: 'session-1' })).mode).toBeNull()
      expect(await h.status('list')).toBe(200)

      await h.plugin.dispose()

      expect(await h.status('list')).toBe(404)
    } finally {
      await h.dispose()
    }
  })

  it('activates with the real Connection service when WebServer is a sibling plugin', async () => {
    const ctx = new Context()
    const store = new FakeMemoryStore()
    try {
      await ctx.plugin(SessionStore)
      await ctx.plugin(MemoryRuntime, memoryConfig)
      ctx.memory.registerStore(store)
      ctx.sessions.create(SessionId('session-1'), { meta: { cwd: '/repo' } })
      await store.putNode(makeNode({
        id: 'n-real',
        label: 'Real composition',
        summary: 'Registered through the real Connection service.',
      }))

      new TestCredentials(ctx)
      await ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 })
      await ctx.plugin(clientConnection, { trustedHosts: [] })
      const plugin = ctx.plugin(kylin, kylinConfig)
      await plugin.await()

      const web = ctx.get('webServer')
      if (web === undefined) throw new Error('webServer is not available')
      const origin = web.getOrigin()
      const authority = new URL(origin).host
      const cookie = browserCookie(ctx.connection, authority)

      const request = {
        type: 'client-request',
        rpcId: 'rpc-kylin-real',
        method: 'list',
        payload: { sessionId: 'session-1' },
      }
      const response = await fetch(`${origin}${CHANNEL}/list`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie },
        body: JSON.stringify(request),
      })

      expect(response.status).toBe(200)
      const body = await response.json() as {
        type?: string
        rpcId?: string
        result?: { ok?: boolean; value?: KylinMemoryResponse }
      }
      expect(body).toMatchObject({
        type: 'server-response',
        rpcId: 'rpc-kylin-real',
        result: { ok: true, value: { ok: true, data: { mode: null } } },
      })
      const value = body.result?.value
      expect(value?.ok).toBe(true)
      if (value?.ok === true) {
        expect(value.data.items.map(item => item.id)).toContain('n-real')
      }

      await plugin.dispose()
      const gone = await fetch(`${origin}${CHANNEL}/list`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie },
        body: JSON.stringify(request),
      })
      expect(gone.status).toBe(404)
    } finally {
      await ctx.fiber.dispose()
    }
  })
})
