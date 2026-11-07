import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import MemoryRuntime from '../../src/memory/index.ts'
import type { Config, MemoryEmbedder, MemoryScope } from '../../src/memory/index.ts'
import { FakeMemoryStore } from './helpers/fake-store.ts'

const workspace: MemoryScope = { kind: 'workspace', workspace: '/repo' }

function config(overrides: Partial<Config['safety']> = {}): Config {
  return {
    recallLimit: 10,
    profileLimit: 10,
    inferredConfidence: 0.4,
    assertedConfidence: 0.9,
    inferredHalfLifeMs: 1_000_000,
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
      ...overrides,
    },
  }
}

function harness(memoryConfig = config(  ), store = new FakeMemoryStore(), embedder?: MemoryEmbedder) {
  const ctx = new Context()
  const runtime = new MemoryRuntime(ctx, memoryConfig)
  runtime.registerStore(store)
  if (embedder !== undefined) runtime.registerEmbedder(embedder)
  return { ctx, runtime, store }
}

const POSITIVE = [
  '-----BEGIN RSA PRIVATE KEY-----\nMIIEow\n-----END RSA PRIVATE KEY-----',
  '-----BEGIN EC PRIVATE KEY-----\nMHcCAQEE\n-----END EC PRIVATE KEY-----',
  '-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXk\n-----END OPENSSH PRIVATE KEY-----',
  '-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkq\n',
  'AKIA1234567890ABCDEF',
  'ASIA1234567890ABCDEF',
  'sk-abcdefghijklmnopqrstuvwxyz123456',
  'ghp_abcdefghijklmnopqrstuvwxyz123456',
  'gho_abcdefghijklmnopqrstuvwxyz123456',
  'Authorization: Bearer abcdefghijklmnop',
  'password=hunter2',
  'api_key: abcdef123456',
  'secret = "supersecret"',
  'token=abcdef123456',
  'authorization: bearer abcdef123456',
  'pwd=letmein123',
  'API-KEY=abcdef123456',
  'passwd: abcdef123456',
  'secret_key=abcdef123456',
  'client_secret=abcdef123456',
] as const

const NEGATIVE = [
  'please list the files in the repository',
  'always run the linter before pushing',
  'my token budget is 500 for this task',
  'the password policy says twelve characters',
  'authorization is required for this endpoint',
  'the secret sauce is patience',
  'API key rotation is documented',
  'Bearer',
  'private key handling belongs in a vault',
  'AKIA is a prefix, not a key',
  'sk- is just a prefix',
  'ghp_ is a short prefix',
  'password:',
  'tokenization helps retrieval',
  'secretive behavior is hard to measure',
  '请检查构建日志',
  'remember the column layout for the report',
  'open the local configuration file',
  '1234567890',
  'the meeting is on Friday',
] as const

describe('minimal capture filtering', () => {
  it('classifies 20 synthetic secret positives without rejecting ordinary text', () => {
    const { runtime } = harness()
    for (const text of POSITIVE) {
      const filtered = runtime.filterExternalText(text)
      expect(filtered.metadata.redactions.length, text).toBeGreaterThan(0)
      expect(filtered.text, text).not.toBe(text)
    }
    for (const text of NEGATIVE) {
      const filtered = runtime.filterExternalText(text)
      expect(filtered.metadata.redactions, text).toEqual([])
      expect(filtered.text, text).toBe(text)
    }
  })

  it('redacts before persistence and before embedding', async () => {
    const seen: string[] = []
    const embedder: MemoryEmbedder = {
      name: 'capture',
      dimensions: 2,
      embed: (texts) => {
        seen.push(...texts)
        return Promise.resolve(texts.map(() => [1, 0]))
      },
    }
    const { runtime, store } = harness(config(), new FakeMemoryStore(), embedder)
    const secret = 'password=hunter2'
    const record = await runtime.remember({
      scope: workspace, kind: 'user-message', text: `keep this ${secret} please`, fidelity: 'verbatim',
      provenance: { author: 'user', sessionId: 's1' as never, turn: 1 },
    })
    expect(record.text).not.toContain(secret)
    expect(record.text).toContain('[redacted:secret-assignment]')
    expect(seen.every(text => !text.includes(secret))).toBe(true)
    expect(store.getRecord(record.id)?.text).toBe(record.text)
    expect(record.capture).toMatchObject({ blocked: false, redactions: [{ category: 'secret-assignment', count: 1 }] })
  })

  it('rejects an explicit literal instead of storing it', async () => {
    const { runtime, store } = harness(config({ blockedLiterals: ['Project Nightingale'] }))
    await expect(runtime.remember({
      scope: workspace, kind: 'user-message', text: 'Project Nightingale is the private codename', fidelity: 'verbatim',
    })).rejects.toMatchObject({ code: 'blocked-input' })
    expect(store.recordRows.size).toBe(0)
  })

  it('can reject rather than redact a sensitive pattern', async () => {
    const { runtime } = harness(config({ rejectSensitivePatterns: true }))
    await expect(runtime.remember({
      scope: workspace, kind: 'user-message', text: 'token=abcdef123456', fidelity: 'verbatim',
    })).rejects.toMatchObject({ code: 'blocked-input' })
  })

  it('filters nested JSON attributes in assert and replace', async () => {
    const { runtime, store } = harness()
    const record = await runtime.assert({
      scope: workspace, type: 'preference', label: 'service',
      summary: 'Uses a service.', origin: 'asserted',
      attributes: { config: { password: 'hunter2', endpoint: 'https://example.test' } },
    })
    expect(JSON.stringify(record.attributes)).not.toContain('hunter2')
    expect(JSON.stringify(record.attributes)).toContain('[redacted:secret-assignment]')
    expect(record.safety?.redactions[0]?.category).toBe('secret-assignment')
    expect(store.getNode(record.id)?.safety?.redactions).toHaveLength(1)
  })

  it('drops an attachment whose URI or metadata contains a secret', async () => {
    const { runtime, store } = harness()
    const record = await runtime.remember({
      scope: workspace,
      kind: 'user-message',
      text: 'see the linked file',
      fidelity: 'verbatim',
      attachments: [{
        kind: 'url',
        uri: 'https://example.test/file?token=abcdef123456',
        caption: 'report',
      }],
    })
    expect(record.attachments).toEqual([])
    expect(record.capture?.redactions).toContainEqual({ category: 'attachment-dropped', count: 1, replacement: '' })
    expect(JSON.stringify(store.getRecord(record.id))).not.toContain('abcdef123456')
  })

  it('omits an attachment whose URI contains a blocked literal', async () => {
    const { runtime } = harness(config({ blockedLiterals: ['Project-Nightingale'] }))
    const record = await runtime.remember({
      scope: workspace,
      kind: 'user-message',
      text: 'see the linked file',
      fidelity: 'verbatim',
      attachments: [{ kind: 'url', uri: 'https://example.test/Project-Nightingale' }],
    })
    expect(record.attachments).toEqual([])
    expect(record.capture?.redactions).toContainEqual({ category: 'attachment-dropped', count: 1, replacement: '' })
  })

  it('drops an attachment with an unrecognized kind instead of persisting the raw string', async () => {
    const { runtime, store } = harness()
    const record = await runtime.remember({
      scope: workspace,
      kind: 'user-message',
      text: 'see the linked file',
      fidelity: 'verbatim',
      attachments: [{
        kind: 'token=abcdef123456',
        uri: 'https://example.test/file',
      } as never],
    })
    expect(record.attachments).toEqual([])
    expect(record.capture?.redactions).toContainEqual({ category: 'attachment-dropped', count: 1, replacement: '' })
    expect(JSON.stringify(store.getRecord(record.id))).not.toContain('abcdef123456')
  })

  it('drops an attachment with malformed bytes instead of persisting the raw value', async () => {
    const { runtime } = harness()
    const record = await runtime.remember({
      scope: workspace,
      kind: 'user-message',
      text: 'see the linked file',
      fidelity: 'verbatim',
      attachments: [{
        kind: 'url',
        uri: 'https://example.test/file',
        bytes: 'token=abcdef123456',
      } as never],
    })
    expect(record.attachments).toEqual([])
    expect(record.capture?.redactions).toContainEqual({ category: 'attachment-dropped', count: 1, replacement: '' })
  })

  it('does not persist unknown nested attachment metadata', async () => {
    const { runtime, store } = harness()
    const record = await runtime.remember({
      scope: workspace,
      kind: 'user-message',
      text: 'see the linked file',
      fidelity: 'verbatim',
      attachments: [{
        kind: 'url',
        uri: 'https://example.test/file',
        metadata: { token: 'abcdef123456' },
      } as never],
    })
    expect(JSON.stringify(record)).not.toContain('abcdef123456')
    expect(JSON.stringify(store.getRecord(record.id))).not.toContain('abcdef123456')
    expect(record.attachments[0]).not.toHaveProperty('metadata')
  })

  it('keeps plain JSON when every redaction switch is off', async () => {
    const { runtime } = harness(config({
      redactPrivateKeys: false,
      redactProviderTokens: false,
      redactBearerTokens: false,
      redactSecretAssignments: false,
    }))
    const node = await runtime.assert({
      scope: workspace,
      type: 'preference',
      label: 'quota',
      summary: 'Uses a quota.',
      origin: 'asserted',
      attributes: {
        password: 'hunter2',
        config: { token: 'abcdef123456' },
      },
    })
    expect(node.attributes).toEqual({
      password: 'hunter2',
      config: { token: 'abcdef123456' },
    })
    expect(node.safety).toBeUndefined()
  })

  it('uses a prototype-free object when filtering nested JSON keys', async () => {
    const { runtime } = harness()
    const attributes = JSON.parse('{"__proto__":{"polluted":"yes"}}') as Record<string, never>
    const node = await runtime.assert({
      scope: workspace,
      type: 'preference',
      label: 'safe map',
      summary: 'Uses a safe map.',
      origin: 'asserted',
      attributes,
    })
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
    expect(Object.hasOwn(node.attributes, '__proto__')).toBe(true)
    expect(JSON.stringify(node.attributes)).toContain('"__proto__"')
  })

  it('projects legacy rows through safe recall and profile views', async () => {
    const { runtime, store } = harness()
    const scope = 'workspace:/repo' as never
    const secret = 'secret=abcdef123456'
    await store.putRecord({
      id: 'mem-r-old' as never, scope, kind: 'user-message', text: `deploy ${secret}`,
      fidelity: 'verbatim', use: 'recallable', terms: ['deploy', 'secret', 'abcdef123456'], attachments: [],
      provenance: { author: 'user', sessionId: 's1' as never, turn: 1 },
      createdAt: 1, promotedTo: [], status: 'active',
    })
    await store.putNode({
      id: 'mem-n-old' as never, scope, type: 'preference', label: 'deploy',
      summary: `Deploy ${secret}`, attributes: { note: secret },
      confidence: 0.9, decay: { halfLifeMs: null },
      support: { observations: 1, reinforcements: 0, contradictions: 0, sessions: 1, firstSeenAt: 1, lastSeenAt: 1 },
      evidence: ['mem-r-old' as never], origin: 'asserted', status: 'active', createdAt: 1, updatedAt: 1,
    })
    await store.putEdge({
      id: 'mem-e-old' as never, scope, from: 'mem-n-old' as never, to: 'mem-n-old' as never,
      relation: 'prefers', claim: `Prefers ${secret}`, confidence: 0.9, decay: { halfLifeMs: null },
      support: { observations: 1, reinforcements: 0, contradictions: 0, sessions: 1, firstSeenAt: 1, lastSeenAt: 1 },
      evidence: ['mem-r-old' as never], origin: 'asserted', status: 'active', createdAt: 1, updatedAt: 1,
    })
    const recall = await runtime.recall({ text: 'deploy secret', scopes: [workspace], includeEvidence: true })
    const profile = runtime.profile([workspace])
    expect(JSON.stringify(recall)).not.toContain('abcdef123456')
    expect(JSON.stringify(profile)).not.toContain('abcdef123456')
    expect(recall.safety?.redactions.length).toBeGreaterThan(0)
    expect(profile.safety?.redactions.length).toBeGreaterThan(0)
  })

  it('drops a blocked legacy cue instead of returning its text', async () => {
    const { runtime, store } = harness(config({ blockedLiterals: ['Project Nightingale'] }))
    await store.putRecord({
      id: 'mem-r-block' as never, scope: 'workspace:/repo' as never, kind: 'user-message',
      text: 'Project Nightingale deploy', fidelity: 'verbatim', use: 'recallable',
      terms: ['project', 'nightingale', 'deploy'], attachments: [],
      provenance: { author: 'user', sessionId: 's1' as never, turn: 1 },
      createdAt: 1, promotedTo: [], status: 'active',
    })
    await store.putNode({
      id: 'mem-n-block' as never, scope: 'workspace:/repo' as never, type: 'preference',
      label: 'Project Nightingale', summary: 'Project Nightingale deploy', attributes: {},
      confidence: 0.9, decay: { halfLifeMs: null },
      support: { observations: 1, reinforcements: 0, contradictions: 0, sessions: 1, firstSeenAt: 1, lastSeenAt: 1 },
      evidence: ['mem-r-block' as never], origin: 'asserted', status: 'active', createdAt: 1, updatedAt: 1,
    })
    const recall = await runtime.recall({ text: 'Project Nightingale deploy', scopes: [workspace], includeEvidence: true })
    expect(recall.cues).toEqual([])
    expect(runtime.profile([workspace]).nodes).toEqual([])
  })

  it('rejects an unsafe JSON key rather than letting it reach storage', async () => {
    const { runtime } = harness(config({ blockedLiterals: ['Project Nightingale'] }))
    for (const key of ['token=abcdef123456', 'AKIA1234567890ABCDEF', 'Project Nightingale']) {
      await expect(runtime.assert({
        scope: workspace, type: 'preference', label: 'key', summary: 'Key safety.', origin: 'asserted',
        attributes: { [key]: 'value' },
      })).rejects.toMatchObject({ code: 'blocked-input' })
    }
  })

  it('filters recall queries before the embedder sees them', async () => {
    const seen: string[] = []
    const embedder: MemoryEmbedder = {
      name: 'capture',
      dimensions: 2,
      embed: (texts) => {
        seen.push(...texts)
        return Promise.resolve(texts.map(() => [1, 0]))
      },
    }
    const { runtime } = harness(config(), new FakeMemoryStore(), embedder)
    await runtime.remember({
      scope: workspace, kind: 'note', text: 'deployment uses a token', fidelity: 'verbatim',
    })
    const recall = await runtime.recall({ text: 'token=abcdef123456 deployment', scopes: [workspace] })
    expect(recall.query).not.toContain('abcdef123456')
    expect(spanText(seen)).not.toContain('abcdef123456')
    expect(recall.safety?.redactions[0]?.category).toBe('secret-assignment')
  })
})

function spanText(values: readonly string[]): string {
  return values.join('\n')
}
