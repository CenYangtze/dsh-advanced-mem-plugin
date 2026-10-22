/** Public, provider-independent contracts for reproducible memory evaluation. */
export interface HistoryMessage {
  readonly id: string
  readonly sessionId: string
  readonly role: 'user' | 'assistant'
  readonly text: string
  readonly at: number
}

/** This is the entire surface delivered to agents. Labels stay in EvaluationCase. */
export interface EvaluationInput {
  readonly id: string
  readonly question: string
  readonly at: number
}

export interface EvaluationCase {
  readonly input: EvaluationInput
  readonly group: string
  readonly history: readonly HistoryMessage[]
  readonly reference: string
  readonly abstention: boolean
  readonly evidenceMessageIds: readonly string[]
  readonly evidenceSessionIds: readonly string[]
}

export interface EvaluationDataset {
  readonly name: string
  readonly revision: string
  readonly source: string
  readonly fingerprint: string
  readonly cases: readonly EvaluationCase[]
}

export interface TokenUsage {
  readonly inputTokens: number
  readonly outputTokens: number
}

export interface EvaluationAnswer {
  readonly text: string
  /** IDs are those of the dataset history, in ranked order; omitted means unavailable. */
  readonly retrievedMessageIds?: readonly string[]
  readonly retrievedSessionIds?: readonly string[]
  readonly usage?: TokenUsage
  readonly environmentResult?: { readonly score: number; readonly steps: number; readonly terminated: boolean }
}

export interface EvaluationAgent {
  answer(input: EvaluationInput, signal: AbortSignal): Promise<EvaluationAnswer>
  close(): Promise<void>
}

export interface AgentFactoryInput {
  /** Unique per attempt, including after an interrupted run is resumed. */
  readonly namespace: string
  readonly history: readonly HistoryMessage[]
  readonly signal: AbortSignal
}

export type EvaluationAgentFactory = (input: AgentFactoryInput) => Promise<EvaluationAgent>

export interface EvaluationGrade {
  readonly metric: string
  readonly value: number
  readonly rationale?: string
  readonly usage?: TokenUsage
}

export type EvaluationJudge = (input: {
  readonly sample: EvaluationCase
  readonly answer: EvaluationAnswer
  readonly signal: AbortSignal
}) => Promise<EvaluationGrade>

export interface EvaluationManifest {
  readonly runId: string
  readonly dataset: { readonly name: string; readonly revision: string; readonly source: string; readonly fingerprint: string }
  readonly implementationRevision: string
  readonly agent: Readonly<Record<string, unknown>>
  readonly memory: Readonly<Record<string, unknown>>
  readonly judge: Readonly<Record<string, unknown>>
  readonly protocol: 'isolated-qa-v1' | 'osworld-frozen-v1'
  readonly sampleIds: readonly string[]
  readonly execution: { readonly concurrency: number; readonly timeoutMs: number }
}

export interface EvaluationResult {
  readonly id: string
  readonly group: string
  readonly status: 'completed' | 'failed'
  readonly startedAt: string
  readonly durationMs: number
  readonly answer?: EvaluationAnswer
  readonly grade?: EvaluationGrade
  readonly retrieval?: { readonly messageRecall: number | null; readonly sessionRecall: number | null; readonly reciprocalRank: number | null }
  readonly error?: string
}

export interface EvaluationCheckpoint {
  open(manifest: EvaluationManifest): Promise<readonly EvaluationResult[]>
  append(result: EvaluationResult): Promise<void>
  close(): Promise<void>
}

export interface EvaluationReport {
  readonly manifest: EvaluationManifest
  readonly results: readonly EvaluationResult[]
  readonly summary: EvaluationSummary
  readonly byGroup: Readonly<Record<string, EvaluationSummary>>
  readonly pendingIds: readonly string[]
}

export interface EvaluationSummary {
  readonly total: number
  readonly completed: number
  readonly failed: number
  /** Sum of each metric divided by every attempted case, including failures. */
  readonly metricsIncludingFailures: Readonly<Record<string, number>>
  readonly metrics: Readonly<Record<string, { readonly mean: number; readonly count: number }>>
  readonly latencyMs: { readonly mean: number; readonly p50: number; readonly p95: number }
  readonly usage: TokenUsage
}

/** A bounded, label-free context returned by a real memory backend. */
export interface EvaluationMemoryContext {
  readonly text: string
  readonly messageIds: readonly string[]
  readonly sessionIds: readonly string[]
}

export interface EvaluationMemory {
  recall(input: EvaluationInput, signal: AbortSignal): Promise<EvaluationMemoryContext>
  close(): Promise<void>
}

/** Must use the supplied namespace without adding production user/global scopes. */
export type EvaluationMemoryFactory = (input: AgentFactoryInput) => Promise<EvaluationMemory>
