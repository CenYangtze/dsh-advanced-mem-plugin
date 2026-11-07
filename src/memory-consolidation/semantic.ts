/**
 * Model-backed semantic preference extraction.
 *
 * This distiller complements the deterministic stated-preference miner: the
 * miner only sees fixed cue phrases, while a host model can read free wording,
 * negation and implicit preferences. The model is treated as untrusted: it
 * receives aliased user-authored records, returns strict JSON, and every claim
 * must cite one of those aliases and quote text that exists in the cited record.
 * Scope, provenance and long-term durability are decided by the runtime.
 *
 * @module dsh-advanced-mem-plugin/src/memory-consolidation/semantic
 */

import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type {
  MemoryCandidateNode,
  MemoryDistillation,
  MemoryDistillationFailureReason,
  MemoryDistillationSkipReason,
  MemoryDistillationUsage,
  MemoryDistillInput,
  MemoryDistiller,
  MemoryDistillerProgressPolicy,
  MemoryModelRoute,
  MemoryNode,
  MemoryNodeType,
  MemoryRecord,
  MemoryRecordId,
  MemoryReplacementCandidate,
  MemoryFilterResult,
  MemoryRedaction,
  MemoryScopeKey,
} from '../memory/index.ts'
import { MemoryError } from '../memory/index.ts'
import { SemanticRequestError } from './model.ts'
import type { SemanticModel } from './model.ts'

/** Tunables of the semantic extractor, all supplied by the plugin configuration. */
export interface SemanticPolicy {
  /** Whether the semantic distiller is mounted. */
  readonly semanticEnabled: boolean
  /** Records offered to one model call. */
  readonly semanticMaxRecords: number
  /** Input characters per call, including JSON framing. */
  readonly semanticMaxInputCharacters: number
  /** Response byte ceiling per call. */
  readonly semanticMaxOutputBytes: number
  /** Candidate ceiling per call. */
  readonly semanticMaxCandidates: number
  /** Existing stable-key nodes offered as replacement targets per call. */
  readonly semanticMaxExistingNodes: number
  /** Host output-token ceiling per call. */
  readonly semanticMaxTokens: number
  /** Host sampling temperature in the closed unit interval. */
  readonly semanticTemperature: number
  /** Request timeout in milliseconds. */
  readonly semanticTimeoutMs: number
  /** Longest accepted subject/attribute/value/summary/quote field. */
  readonly semanticMaxFieldLength: number
  /** Model calls allowed in one consolidation pass. */
  readonly semanticMaxCallsPerPass: number
  /** Concurrent model calls allowed across passes. */
  readonly semanticMaxConcurrentCalls: number
  /** Prompt identity; progress keys include it. */
  readonly semanticPromptVersion: string
  /** Failed record retry bound from the shared consolidation settings. */
  readonly progressMaxAttempts: number
  /** Ceiling for a semantic belief derived from model confidence. */
  readonly maxConfidence: number
}

/** Builds the route-bound model for one pass; injectable for tests. */
export type SemanticModelFactory = (route: MemoryModelRoute) => SemanticModel

/** One parsed candidate before evidence validation. */
interface RawCandidate {
  readonly type: MemoryNodeType
  readonly operation: 'addition' | 'replacement'
  readonly target?: string
  readonly subject: string
  readonly attribute: string
  readonly applicability: string
  readonly cardinality: 'single' | 'multiple'
  readonly value: string
  readonly summary: string
  readonly quote: string
  readonly evidence: readonly string[]
  readonly attribution: string
  readonly durability: string
  readonly confidence: number
}

interface BatchSelection {
  readonly records: readonly MemoryRecord[]
  readonly skipped: readonly { record: MemoryRecordId; reason: MemoryDistillationSkipReason }[]
  readonly payload: string
}

const SYSTEM_PROMPT = `Extract long-term user preferences from user-authored records.

Return only one JSON object, no markdown:
{"candidates":[
{"type":"preference"|"constraint","operation":"addition","target":"",<candidate fields>},
{"type":"preference"|"constraint","operation":"replacement","target":"n1",<candidate fields>}
]}
<candidate fields> = "subject":string,"attribute":string,"applicability":string,"cardinality":"single"|"multiple","value":string,"summary":string,"quote":string,"evidence":[string],"attribution":"user"|"quoted"|"third-party"|"roleplay"|"ghostwriting"|"assistant","durability":"long-term"|"task-local","confidence":number

Rules:
- Use only input records; evidence aliases are r1, r2.
- quote must be verbatim from a cited record; whitespace may differ.
- summary is normalized and may differ.
- subject, attribute and applicability name one fact's location; different entities, contexts or times are different facts unless the user clearly changes the same one.
- cardinality "single" means one value at that location; "multiple" means several may coexist.
- addition: target must be "" (or omit target); never put subject, attribute, value, a fact key or an invented id in target.
- replacement: only on an explicit correction at the same subject, attribute and applicability; target must be an existing alias n1, n2 from existing nodes, and only names the old node, never the new subject.
- Never infer replacement from a value difference.
- Only user-endorsed lasting preferences or constraints.
- Do not turn quotations, roleplay, ghostwriting, third-party preferences, assistant text, tool results or one-off instructions into long-term preferences.
- Do not invent scope, record ids, node ids or evidence.
- If none qualify, return {"candidates":[]}.`

function normalizeWhitespace(value: string): string {
  return value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim()
}

function trimField(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = normalizeWhitespace(value)
  if (trimmed.length === 0 || trimmed.length > max) return undefined
  return trimmed
}

function normalizedKey(value: string): string {
  return normalizeWhitespace(value).toLocaleLowerCase()
}

function identityFilter(text: string): MemoryFilterResult {
  return {
    text,
    metadata: { originalLength: text.length, retainedLength: text.length, blocked: false, redactions: [] },
  }
}

type JsonFilter = (value: JsonValue) => { value: JsonValue; blocked: boolean; redactions: MemoryRedaction[] }

function identityJsonFilter(value: JsonValue): { value: JsonValue; blocked: boolean; redactions: MemoryRedaction[] } {
  return { value, blocked: false, redactions: [] }
}

const REDACTION_PLACEHOLDER = /\[redacted:[a-z-]+\]/i

function semanticSource(record: MemoryRecord): boolean {
  if (record.use !== 'recallable') return false
  if (record.provenance.author !== 'user') return false
  return record.kind === 'user-message' || record.kind === 'note'
}

function nodeAttribute(node: MemoryNode, key: string): string {
  const value = node.attributes[key]
  return typeof value === 'string' ? value : ''
}

function candidateLabel(candidate: RawCandidate): string {
  return `${normalizeWhitespace(candidate.subject)}: ${normalizeWhitespace(candidate.attribute)} [${normalizeWhitespace(candidate.applicability)}/${candidate.cardinality}]=${normalizeWhitespace(candidate.value)}`
}

function candidateAttributes(candidate: RawCandidate, key: string): Record<string, string> {
  return {
    subject: candidate.subject,
    attribute: candidate.attribute,
    applicability: candidate.applicability,
    cardinality: candidate.cardinality,
    value: candidate.value,
    quote: candidate.quote,
    attribution: 'user',
    durability: 'long-term',
    source: 'semantic',
    factKey: key,
  }
}

function parseCandidates(
  text: string,
  maxCandidates: number,
  maxField: number,
): { candidates: RawCandidate[]; total: number } {
  let decoded: unknown
  try {
    decoded = JSON.parse(text)
  } catch {
    throw new MemoryError('invalid-input', 'semantic preference output is not valid JSON')
  }
  if (decoded === null || typeof decoded !== 'object' || !('candidates' in decoded)) {
    throw new MemoryError('invalid-input', 'semantic preference output has no candidates array')
  }
  const candidates = (decoded as { candidates?: unknown }).candidates
  if (!Array.isArray(candidates) || candidates.length > maxCandidates) {
    throw new MemoryError('invalid-input', 'semantic preference output exceeds its candidate limit')
  }
  const parsed: RawCandidate[] = []
  for (const candidate of candidates) {
    if (candidate === null || typeof candidate !== 'object') continue
    const value = candidate as Readonly<Record<string, unknown>>
    const type = value['type']
    if (type !== 'preference' && type !== 'constraint') continue
    const operation = value['operation']
    if (operation !== 'addition' && operation !== 'replacement') continue
    const target = value['target']
    if (target !== undefined && typeof target !== 'string') continue
    const subject = trimField(value['subject'], maxField)
    const attribute = trimField(value['attribute'], maxField)
    const applicability = trimField(value['applicability'], maxField)
    const cardinality = value['cardinality']
    if (cardinality !== 'single' && cardinality !== 'multiple') continue
    const fact = trimField(value['value'], maxField)
    const summary = trimField(value['summary'], maxField)
    const quote = trimField(value['quote'], maxField)
    const attribution = value['attribution']
    const durability = value['durability']
    const confidence = value['confidence']
    const evidence = value['evidence']
    if (
      subject === undefined || attribute === undefined || applicability === undefined || fact === undefined
      || summary === undefined || quote === undefined
      || typeof attribution !== 'string' || typeof durability !== 'string'
      || typeof confidence !== 'number' || !Number.isFinite(confidence)
      || confidence < 0 || confidence > 1
      || !Array.isArray(evidence) || evidence.length === 0
      || evidence.some(alias => typeof alias !== 'string' || alias.trim().length === 0)
    ) continue
    parsed.push({
      type,
      operation,
      ...(target === undefined ? {} : { target }),
      subject,
      attribute,
      applicability,
      cardinality,
      value: fact,
      summary,
      quote,
      evidence: evidence as string[],
      attribution,
      durability,
      confidence,
    })
  }
  return { candidates: parsed, total: candidates.length }
}

interface ValidatedCandidate {
  readonly status: 'valid' | 'duplicate' | 'invalid'
  readonly node?: MemoryCandidateNode
  readonly replacement?: MemoryReplacementCandidate
}

interface SlotWaiter {
  readonly resolve: () => void
  readonly reject: (reason?: unknown) => void
  readonly signal: AbortSignal | undefined
  onAbort?: () => void
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new Error('semantic preference extraction aborted')
}

/**
 * The semantic distiller. It reads only user-authored records from the session
 * that owns the route, and returns candidates whose evidence is auditable.
 */
export class SemanticPreferenceDistiller implements MemoryDistiller {
  /** Provider name. */
  readonly name = 'semantic-preference'
  /** Base implementation version; `progressVersion` adds prompt/model identity. */
  readonly version = '4'
  /** Per-record progress with bounded retries. */
  readonly progress: MemoryDistillerProgressPolicy

  private readonly configKey: string
  private active = 0
  private readonly waiting: SlotWaiter[] = []

  /**
   * @param rank - ordering among distillers; after the deterministic miners.
   * @param policy - explicit model, window, byte and retry controls.
   * @param modelFor - route-bound host model factory, injectable for tests.
   */
  constructor(
    readonly rank: number,
    private readonly policy: SemanticPolicy,
    private readonly modelFor: SemanticModelFactory,
    private readonly filterText: (text: string) => MemoryFilterResult = identityFilter,
    private readonly filterJson: JsonFilter = identityJsonFilter,
  ) {
    this.progress = { mode: 'record', maxAttempts: policy.progressMaxAttempts }
    this.configKey = [
      policy.semanticPromptVersion,
      policy.semanticMaxRecords,
      policy.semanticMaxInputCharacters,
      policy.semanticMaxOutputBytes,
      policy.semanticMaxCandidates,
      policy.semanticMaxExistingNodes,
      policy.semanticMaxTokens,
      policy.semanticTemperature,
      policy.semanticTimeoutMs,
      policy.semanticMaxFieldLength,
      policy.semanticMaxCallsPerPass,
      policy.maxConfidence,
    ].join(':')
  }

  /** Progress identity: implementation, prompt, model route and bounded controls. */
  progressVersion(route?: MemoryModelRoute): string {
    return `semantic-v4:${this.configKey}:${route?.provider ?? 'none'}:${route?.model ?? 'none'}:${route?.reasoningEffort ?? 'default'}`
  }

  /** Only user-authored, recallable records from the routed session are inputs. */
  accepts(record: MemoryRecord, context: { sessionId?: string }): boolean {
    if (!semanticSource(record)) return false
    if (context.sessionId === undefined) return true
    return record.provenance.sessionId === context.sessionId
  }

  /**
   * Extract candidates from one bounded pass.
   * @param input - records, route, session and cancellation.
   * @returns validated proposals plus explicit consumed/skipped/failed records.
   * @throws when no route or session is supplied, or when aborted.
   */
  async distill(input: MemoryDistillInput): Promise<MemoryDistillation> {
    if (!this.policy.semanticEnabled) {
      return { nodes: [], edges: [], consumedRecordIds: [] }
    }
    if (input.route === undefined) {
      throw new MemoryError('invalid-input', 'semantic preference extraction requires a session model route')
    }
    if (input.sessionId === undefined) {
      throw new MemoryError('invalid-input', 'semantic preference extraction requires a session id')
    }
    const model = this.modelFor(input.route)
    const consumed: MemoryRecordId[] = []
    const skipped: { record: MemoryRecordId; reason: MemoryDistillationSkipReason }[] = []
    const eligible: MemoryRecord[] = []
    for (const record of input.records) {
      if (record.scope !== input.scope || !semanticSource(record) || record.provenance.sessionId !== input.sessionId) continue
      const filtered = this.filterText(record.text)
      if (filtered.metadata.blocked) {
        skipped.push({ record: record.id, reason: 'blocked-sensitive' })
        continue
      }
      eligible.push(filtered.text === record.text ? record : { ...record, text: filtered.text })
    }
    const existingForPrompt = this.selectExisting(input.existing)
    const existingAliases = new Map<string, MemoryNode>(
      existingForPrompt.map((node, index) => [`n${index + 1}`, node]),
    )
    const failed: { record: MemoryRecordId; reason: MemoryDistillationFailureReason }[] = []
    const nodes: MemoryCandidateNode[] = []
    const replacements: MemoryReplacementCandidate[] = []
    const seenFacts = new Set<string>()
    const seenTargets = new Set<string>()
    let usage: MemoryDistillationUsage | undefined
    let remaining = [...eligible]
    let calls = 0

    while (remaining.length > 0 && calls < this.policy.semanticMaxCallsPerPass) {
      input.signal?.throwIfAborted()
      const selection = this.selectBatch(remaining, existingForPrompt)
      if (selection.records.length === 0) {
        skipped.push(...selection.skipped)
        const skippedIds = new Set(selection.skipped.map(row => row.record))
        remaining = remaining.filter(record => !skippedIds.has(record.id))
        if (remaining.length === 0) break
        continue
      }
      calls++
      const selectionIds = new Set([
        ...selection.records.map(record => record.id),
        ...selection.skipped.map(row => row.record),
      ])
      let result: { text: string; usage?: { inputTokens: number; outputTokens: number } }
      try {
        result = await this.withSlot(
          () => model.complete(SYSTEM_PROMPT, selection.payload, input.signal),
          input.signal,
        )
      } catch (error) {
        if (input.signal?.aborted === true || (error instanceof SemanticRequestError && error.code === 'aborted')) {
          throw error
        }
        const reason = semanticFailure(error)
        for (const record of selection.records) failed.push({ record: record.id, reason })
        skipped.push(...selection.skipped)
        remaining = remaining.filter(record => !selectionIds.has(record.id))
        break
      }
      skipped.push(...selection.skipped)
      if (result.usage !== undefined) {
        usage = {
          inputTokens: (usage?.inputTokens ?? 0) + result.usage.inputTokens,
          outputTokens: (usage?.outputTokens ?? 0) + result.usage.outputTokens,
        }
      }
      let parsed: { candidates: RawCandidate[]; total: number }
      try {
        parsed = parseCandidates(result.text, this.policy.semanticMaxCandidates, this.policy.semanticMaxFieldLength)
      } catch {
        for (const record of selection.records) failed.push({ record: record.id, reason: 'invalid-output' })
        remaining = remaining.filter(record => !selectionIds.has(record.id))
        break
      }
      const validated = parsed.candidates
        .map(candidate => this.validateCandidate(candidate, selection.records, input.existing, existingAliases, input.scope))
        .filter((candidate): candidate is ValidatedCandidate => candidate !== undefined)
      const valid = validated
        .filter((candidate): candidate is ValidatedCandidate & { node: MemoryCandidateNode } => candidate.status === 'valid' && candidate.node !== undefined)
        .map(candidate => candidate.node)
        .filter((candidate) => {
          const factKey = candidate.attributes?.['factKey']
          if (typeof factKey !== 'string' || seenFacts.has(factKey)) return false
          seenFacts.add(factKey)
          return true
        })
      const replacementsHere = validated
        .filter((candidate): candidate is ValidatedCandidate & { replacement: MemoryReplacementCandidate } =>
          candidate.status === 'valid' && candidate.replacement !== undefined)
        .map(candidate => candidate.replacement)
        .filter((replacement) => {
          if (seenTargets.has(replacement.target)) return false
          seenTargets.add(replacement.target)
          return true
        })
      const invalidCount = parsed.total - parsed.candidates.length
        + validated.filter(candidate => candidate.status === 'invalid').length
      if (valid.length === 0 && replacementsHere.length === 0 && parsed.total > 0 && invalidCount === parsed.total) {
        for (const record of selection.records) failed.push({ record: record.id, reason: 'invalid-output' })
      } else {
        nodes.push(...valid)
        replacements.push(...replacementsHere)
        for (const record of selection.records) consumed.push(record.id)
      }
      remaining = remaining.filter(record => !selectionIds.has(record.id))
    }

    return {
      nodes,
      edges: [],
      ...(replacements.length === 0 ? {} : { replacements }),
      consumedRecordIds: consumed,
      ...(skipped.length === 0 ? {} : { skipped }),
      ...(failed.length === 0 ? {} : { failed }),
      ...(usage === undefined ? {} : { usage }),
    }
  }

  private selectBatch(
    remaining: readonly MemoryRecord[],
    existing: readonly MemoryNode[],
  ): BatchSelection {
    const records: MemoryRecord[] = []
    const skippedHere: { record: MemoryRecordId; reason: MemoryDistillationSkipReason }[] = []
    for (const record of remaining) {
      if (records.length >= this.policy.semanticMaxRecords) break
      const candidateRecords = [...records, record]
      const payload = this.payloadFor(candidateRecords, existing)
      const size = SYSTEM_PROMPT.length + payload.length
      if (size > this.policy.semanticMaxInputCharacters) {
        if (records.length === 0) {
          skippedHere.push({ record: record.id, reason: 'input-too-large' })
          continue
        }
        break
      }
      records.push(record)
    }
    return { records, skipped: skippedHere, payload: this.payloadFor(records, existing) }
  }

  private selectExisting(existing: MemoryDistillInput['existing']): MemoryNode[] {
    const candidates = existing
      .filter(node => node.status === 'active'
        && (node.type === 'preference' || node.type === 'constraint'))
      .map(node => this.visibleNode(node))
      .filter((node): node is MemoryNode => node !== undefined)
      .slice(0, this.policy.semanticMaxExistingNodes)
    while (candidates.length > 0
      && SYSTEM_PROMPT.length + this.payloadFor([], candidates).length > this.policy.semanticMaxInputCharacters) {
      candidates.pop()
    }
    return candidates
  }

  private visibleNode(node: MemoryNode): MemoryNode | undefined {
    const label = this.filterText(node.label)
    const summary = this.filterText(node.summary)
    if (label.metadata.blocked || summary.metadata.blocked) return undefined
    const attributes = this.filterJson(node.attributes as JsonValue)
    if (attributes.blocked) return undefined
    return {
      ...node,
      label: label.text,
      summary: summary.text,
      attributes: attributes.value as Readonly<Record<string, JsonValue>>,
    }
  }

  private payloadFor(records: readonly MemoryRecord[], existing: readonly MemoryNode[]): string {
    return JSON.stringify({
      records: records.map((record, index) => ({ alias: `r${index + 1}`, text: record.text })),
      existing: existing.map((node, index) => {
        return {
          alias: `n${index + 1}`,
          type: node.type,
          label: node.label,
          summary: node.summary,
          subject: node.attributes['subject'],
          attribute: node.attributes['attribute'],
          applicability: node.attributes['applicability'],
          cardinality: node.attributes['cardinality'],
          value: node.attributes['value'],
          stable: node.attributes['source'] === 'semantic' && typeof node.attributes['factKey'] === 'string',
        }
      }),
    })
  }

  private validateCandidate(
    candidate: RawCandidate,
    records: readonly MemoryRecord[],
    existing: readonly MemoryNode[],
    existingAliases: ReadonlyMap<string, MemoryNode>,
    scope: MemoryScopeKey,
  ): ValidatedCandidate | undefined {
    if (candidate.attribution !== 'user' || candidate.durability !== 'long-term') {
      return { status: 'invalid' }
    }
    if (REDACTION_PLACEHOLDER.test(candidate.quote)) return { status: 'invalid' }
    if (candidate.type !== 'preference' && candidate.type !== 'constraint') return { status: 'invalid' }
    const aliases = new Map<string, MemoryRecord>(records.map((record, index) => [`r${index + 1}`, record]))
    const cited: MemoryRecord[] = []
    for (const alias of candidate.evidence) {
      const record = aliases.get(alias.trim())
      if (record === undefined || record.scope !== scope || !semanticSource(record)) return { status: 'invalid' }
      cited.push(record)
    }
    const quote = normalizeWhitespace(candidate.quote)
    if (!cited.some(record => normalizeWhitespace(record.text).includes(quote))) return { status: 'invalid' }
    const key = this.factKey(
      candidate.type,
      candidate.subject,
      candidate.attribute,
      candidate.applicability,
      candidate.cardinality,
      candidate.value,
    )
    const attributes = candidateAttributes(candidate, key)
    const addition = (): ValidatedCandidate => ({
      status: 'valid',
      node: {
        type: candidate.type,
        label: candidateLabel(candidate),
        summary: candidate.summary,
        attributes,
        confidence: Math.min(candidate.confidence, this.policy.maxConfidence),
        evidence: cited.map(record => record.id),
        merge: 'exact',
      },
    })
    for (const node of existing) {
      if (node.type !== candidate.type) continue
      const existingKey = typeof node.attributes['factKey'] === 'string'
        ? node.attributes['factKey']
        : undefined
      if (existingKey !== undefined && existingKey === key) return addition()
      if (existingKey === undefined && normalizedKey(node.summary) === normalizedKey(candidate.quote)) {
        return { status: 'duplicate' }
      }
    }

    if (candidate.operation === 'replacement') {
      if (candidate.target === undefined || candidate.target.trim().length === 0) return { status: 'invalid' }
      const target = existingAliases.get(candidate.target.trim())
      if (target === undefined) return { status: 'invalid' }
      const stable = target.attributes['source'] === 'semantic'
        && typeof target.attributes['factKey'] === 'string'
      const sameLocation = normalizedKey(nodeAttribute(target, 'subject')) === normalizedKey(candidate.subject)
        && normalizedKey(nodeAttribute(target, 'attribute')) === normalizedKey(candidate.attribute)
        && normalizedKey(nodeAttribute(target, 'applicability')) === normalizedKey(candidate.applicability)
      const replaceable = stable && sameLocation
        && target.status === 'active'
        && target.scope === scope
        && target.type === candidate.type
        && nodeAttribute(target, 'cardinality') === 'single'
        && candidate.cardinality === 'single'
      if (replaceable) {
        return {
          status: 'valid',
          replacement: {
            target: target.id,
            type: candidate.type,
            label: candidateLabel(candidate),
            summary: candidate.summary,
            attributes,
            confidence: Math.min(candidate.confidence, this.policy.maxConfidence),
            evidence: cited.map(record => record.id),
            quote: candidate.quote,
            origin: 'inferred',
          },
        }
      }
      // A proposed replacement that cannot be proved is retained as a new fact
      // under exact-label merging, marked for review. The old node is untouched.
      return {
        status: 'valid',
        node: {
          type: candidate.type,
          label: candidateLabel(candidate),
          summary: candidate.summary,
          attributes: {
            ...attributes,
            review: 'unconfirmed-replacement',
            reviewTarget: target.id,
          },
          confidence: Math.min(candidate.confidence, this.policy.maxConfidence),
          evidence: cited.map(record => record.id),
          merge: 'exact',
        },
      }
    }

    if (candidate.target !== undefined && candidate.target.trim().length > 0) return { status: 'invalid' }
    return addition()
  }

  private factKey(
    type: MemoryNodeType,
    subject: string,
    attribute: string,
    applicability: string,
    cardinality: 'single' | 'multiple',
    value: string,
  ): string {
    return [
      type,
      normalizedKey(subject),
      normalizedKey(attribute),
      normalizedKey(applicability),
      cardinality,
      normalizedKey(value),
    ].join('\u0000')
  }

  private async withSlot<T>(work: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    await this.acquire(signal)
    try {
      signal?.throwIfAborted()
      return await work()
    } finally {
      this.release()
    }
  }

  /** Acquire a slot, rejecting immediately when a queued caller aborts. */
  private acquire(signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted()
    if (this.active < this.policy.semanticMaxConcurrentCalls) {
      this.active++
      return Promise.resolve()
    }
    return new Promise<void>((resolve, reject) => {
      const waiter: SlotWaiter = { resolve, reject, signal }
      if (signal !== undefined) {
        waiter.onAbort = (): void => {
          const index = this.waiting.indexOf(waiter)
          if (index < 0) return
          this.waiting.splice(index, 1)
          reject(abortReason(signal))
        }
        signal.addEventListener('abort', waiter.onAbort, { once: true })
      }
      this.waiting.push(waiter)
    })
  }

  /** Transfer a slot to the next healthy waiter, or free it. */
  private release(): void {
    while (this.waiting.length > 0) {
      const next = this.waiting.shift()!
      if (next.onAbort !== undefined) next.signal?.removeEventListener('abort', next.onAbort)
      if (next.signal?.aborted === true) {
        next.reject(abortReason(next.signal))
        continue
      }
      // The slot stays occupied and is handed to the waiter, so a new caller
      // cannot slip into the gap between release and the waiter resuming.
      next.resolve()
      return
    }
    this.active--
  }
}

function semanticFailure(error: unknown): MemoryDistillationFailureReason {
  if (!(error instanceof SemanticRequestError)) return 'provider-failed'
  switch (error.code) {
    case 'timeout': return 'timeout'
    case 'output-limit': return 'output-limit'
    case 'truncated':
    case 'tool-call': return 'invalid-output'
    case 'aborted': return 'provider-failed'
    default: return 'provider-failed'
  }
}
