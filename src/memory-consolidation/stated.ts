/**
 * The stated-preference distiller: turns what the user said about how they want
 * to work into layer-1 preferences and constraints.
 *
 * The behavior-cycle distiller beside it can only see *repetition* — it learns
 * that something keeps happening, never that someone asked for it. That leaves
 * the most direct evidence a memory system ever gets unused: a person saying
 * outright "always run the tests first", or "别用 npm". Those sentences are the
 * user's own words about their own work, which is the material memory exists to
 * hold; leaving them as raw episodes means the belief has to be rediscovered by
 * search every time instead of being known.
 *
 * Like its neighbour it uses no model. A small cue lexicon in two languages,
 * frequency, and nothing else — so it is deterministic, cheap enough for every
 * turn boundary, and cannot invent a preference the user never expressed. What
 * it buys in safety it pays for in reach: an obliquely phrased preference with
 * no cue in it is invisible here, and a model-backed distiller mounted beside
 * this one is what would see those.
 *
 * @module dsh-advanced-mem-plugin/src/memory-consolidation/stated
 */

import type {
  MemoryCandidateNode,
  MemoryDistillation,
  MemoryDistillInput,
  MemoryDistiller,
  MemoryNodeType,
  MemoryRecord,
  MemoryRecordId,
} from '../memory/index.ts'
import { recordUseFor } from '../memory/index.ts'
import { frequencyConfidence } from './distiller.ts'
import type { DistillerPolicy } from './distiller.ts'

/** Tunables of the stated-preference miner, all supplied by the plugin configuration. */
export interface StatedPolicy extends DistillerPolicy {
  /**
   * Statements before a stated preference becomes a belief.
   *
   * Separate from `minObservations` because the evidence is different in kind:
   * a habit is only visible through repetition, while a request was already
   * explicit the first time it was made. Raising this trades responsiveness for
   * protection against a passing remark being treated as a standing rule.
   */
  readonly minStatements: number
  /** Shortest extracted subject worth believing; rejects "it", "that", "这个". */
  readonly minSubjectLength: number
  /** Longest extracted subject kept, so a run-on sentence cannot become a label. */
  readonly maxSubjectLength: number
}

/**
 * The cue lexicon.
 *
 * Deliberately narrow, and hardcoded rather than configured: this is the
 * distiller's reading of language, the way a tokenizer is, not a retention
 * policy a deployment should be tuning. Every pattern is anchored at a sentence
 * start or a clause boundary and captures what follows, because the cue names
 * the *kind* of statement while the remainder names its subject.
 *
 * Constraint cues are anchored at the start of a sentence, because that is what
 * separates an instruction from a report: an imperative has no subject before
 * its verb. "Never force-push a shared branch" is a rule; "I never got the
 * email" is a complaint, and the only thing distinguishing them is the `I`. The
 * anchor costs some recall on rules phrased mid-sentence and buys never turning
 * a grievance into a standing constraint on how the agent must work.
 */
const CUES: readonly { readonly type: MemoryNodeType; readonly pattern: RegExp }[] = [
  // Stated preferences — English.
  { type: 'preference', pattern: /\bi (?:prefer|like|usually use|normally use|tend to use)\s+(.{3,})/i },
  { type: 'preference', pattern: /\bi(?:'d| would) rather\s+(.{3,})/i },
  { type: 'preference', pattern: /\bmy preference is\s+(.{3,})/i },
  // Addressed to the agent explicitly. A bare "use X instead of Y" is dropped on
  // purpose: with no subject and no addressee it cannot be told apart from a
  // proposed code change — "Use repr instead of str in the error message" is a
  // bug report, not something the person wants remembered about them.
  { type: 'preference', pattern: /^please\s+(?:always\s+)?use\s+(.{3,})/i },
  // Stated preferences — Chinese.
  { type: 'preference', pattern: /我(?:喜欢|偏好|更喜欢|倾向于|更倾向于|习惯用|一般用|通常用)\s*(.{2,})/ },
  { type: 'preference', pattern: /我的偏好是\s*(.{2,})/ },

  // Stated constraints — English, imperative only.
  { type: 'constraint', pattern: /^(?:please\s+)?(?:never|do not|don't|avoid)\s+(.{3,})/i },
  { type: 'constraint', pattern: /^(?:please\s+)?always\s+(.{3,})/i },
  { type: 'constraint', pattern: /\byou must(?: not)?\s+(.{3,})/i },
  // Stated constraints — Chinese, imperative only.
  { type: 'constraint', pattern: /^(?:请)?(?:不要|别|禁止|不准|不能)\s*(.{2,})/ },
  { type: 'constraint', pattern: /^(?:请)?(?:必须|一定要|务必)\s*(.{2,})/ },
]

/** Sentence boundaries in both scripts, plus hard line breaks. */
const SENTENCE = /[.!?;。！？；\n]+/

/** One statement found in one record. */
export interface StatedClaim {
  /** Which kind of belief the cue marks. */
  readonly type: MemoryNodeType
  /** The merge key: what the statement is about, normalised. */
  readonly subject: string
  /** The sentence it was found in, kept verbatim as the belief's wording. */
  readonly sentence: string
}

/** Trim trailing punctuation and collapse whitespace in an extracted subject. */
function tidy(value: string): string {
  return value.replace(/\s+/g, ' ').replace(/^[\s,:：、]+|[\s.,!?;。！？；、]+$/g, '').trim()
}

/**
 * Find the statements a piece of text makes about how the user wants to work.
 *
 * One claim per sentence at most: a sentence carrying two cues is ambiguous
 * about which one governs, and guessing would manufacture a belief the sentence
 * does not clearly hold.
 * @param text - the record's text.
 * @param policy - subject length bounds.
 * @returns the claims found, in sentence order.
 */
export function claimsIn(text: string, policy: StatedPolicy): StatedClaim[] {
  const claims: StatedClaim[] = []
  for (const raw of text.split(SENTENCE)) {
    const sentence = raw.trim()
    if (sentence.length === 0) continue
    for (const cue of CUES) {
      const match = cue.pattern.exec(sentence)
      const captured = match?.[1]
      if (captured === undefined) continue
      const subject = tidy(captured).slice(0, policy.maxSubjectLength)
      if (subject.length < policy.minSubjectLength) continue
      claims.push({ type: cue.type, subject: subject.toLowerCase(), sentence })
      break
    }
  }
  return claims
}

/** What one subject accumulated across the window. */
interface Tally {
  readonly type: MemoryNodeType
  /** The first sentence that stated it, which becomes the belief's wording. */
  readonly sentence: string
  readonly evidence: MemoryRecordId[]
  readonly sessions: Set<string>
}

/**
 * Mine stated preferences and constraints from user-authored material.
 *
 * Registered beside {@link BehaviorCycleDistiller} and merged through the same
 * reinforcement path on the hub, so a preference stated twice in two sessions
 * strengthens rather than duplicating.
 */
export class StatedPreferenceDistiller implements MemoryDistiller {
  /** Provider name, attributed on the proposals it makes. */
  readonly name = 'stated-preference'

  /**
   * @param rank - ordering among mounted distillers; runs after frequency mining, which is cheaper.
   * @param policy - the mining thresholds from the plugin configuration.
   */
  constructor(readonly rank: number, private readonly policy: StatedPolicy) {}

  /**
   * Mine one window of layer-0 records.
   * @param input - the window and the graph around it.
   * @returns the proposed preferences and constraints; never any edges.
   */
  distill(input: MemoryDistillInput): Promise<MemoryDistillation> {
    const table = new Map<string, Tally>()
    for (const record of input.records) {
      // The same rule the whole subsystem turns on: only what the user wrote can
      // be the subject of a belief about the user. An assistant message that
      // says "I prefer X" is the model quoting itself back into memory.
      if (recordUseFor(record.kind) !== 'recallable') continue
      if (record.kind !== 'user-message' && record.kind !== 'note') continue
      for (const claim of claimsIn(record.text, this.policy)) {
        const key = `${claim.type}:${claim.subject}`
        let entry = table.get(key)
        if (entry === undefined) {
          entry = { type: claim.type, sentence: claim.sentence, evidence: [], sessions: new Set<string>() }
          table.set(key, entry)
        }
        entry.evidence.push(record.id)
        const sessionId = record.provenance.sessionId
        if (sessionId !== undefined) entry.sessions.add(sessionId)
      }
    }
    const nodes: MemoryCandidateNode[] = []
    for (const [key, entry] of table) {
      if (entry.evidence.length < this.policy.minStatements) continue
      nodes.push({
        type: entry.type,
        label: key.slice(key.indexOf(':') + 1),
        // The user's own sentence, not a paraphrase of it: a preference restated
        // in the harness's words is a preference the user cannot recognise or
        // correct when it is read back to them.
        summary: entry.sentence,
        attributes: { statements: entry.evidence.length, sessions: entry.sessions.size },
        confidence: frequencyConfidence(entry.evidence.length, this.policy),
        evidence: entry.evidence,
      })
    }
    return Promise.resolve({ nodes, edges: [] })
  }
}

/**
 * Whether a record is material this distiller may form a belief from.
 * @param record - the layer-0 record.
 * @returns true when the user authored it and it carries prose rather than a call.
 */
export function statable(record: MemoryRecord): boolean {
  return recordUseFor(record.kind) === 'recallable'
    && (record.kind === 'user-message' || record.kind === 'note')
}
