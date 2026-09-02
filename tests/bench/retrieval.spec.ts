import { describe, expect, it } from 'vitest'
import { CUTOFFS, score, summarize } from '../../bench/metrics.ts'
import { MemoryStack } from '../../bench/stack.ts'
import { floorOf } from '../../bench/retrieval.ts'
import { corpusOf as longMemEvalCorpus, parseStamp } from '../../bench/suites/longmemeval.ts'
import { CATEGORY, corpusOf as locomoCorpus } from '../../bench/suites/locomo.ts'
import { documentsOf, tasksOf } from '../../bench/suites/perltqa.ts'
import { artefactOf, corpusOf as kylinofficeCorpus } from '../../bench/suites/kylinoffice.ts'

describe('score', () => {
  it('reports the rank of the first gold document', () => {
    const result = score({ returned: ['a', 'b', 'c'], gold: new Set(['c']) }, CUTOFFS)
    expect(result.firstRank).toBe(3)
    expect(result.reciprocalRank).toBeCloseTo(1 / 3)
    expect(result.hitAt[1]).toBe(false)
    expect(result.hitAt[5]).toBe(true)
  })

  it('measures recall against the whole gold set, not just the first hit', () => {
    const result = score({ returned: ['a', 'x', 'b'], gold: new Set(['a', 'b', 'c']) }, CUTOFFS)
    expect(result.recallAt[10]).toBeCloseTo(2 / 3)
    expect(result.recallAt[1]).toBeCloseTo(1 / 3)
  })

  it('reports a clean miss rather than a rank of zero', () => {
    const result = score({ returned: ['x'], gold: new Set(['a']) }, CUTOFFS)
    expect(result).toMatchObject({ hit: false, firstRank: null, reciprocalRank: 0, ndcg: 0 })
  })

  it('normalises nDCG against the best achievable order, so a perfect run scores 1', () => {
    const perfect = score({ returned: ['a', 'b'], gold: new Set(['a', 'b']) }, CUTOFFS)
    expect(perfect.ndcg).toBeCloseTo(1)
  })

  it('survives an empty gold set instead of dividing by zero', () => {
    expect(score({ returned: ['a'], gold: new Set() }, CUTOFFS).recallAt[1]).toBe(0)
  })
})

describe('summarize', () => {
  it('averages over queries and returns zeroes for an empty run', () => {
    const rows = [
      score({ returned: ['a'], gold: new Set(['a']) }, CUTOFFS),
      score({ returned: ['x'], gold: new Set(['a']) }, CUTOFFS),
    ]
    expect(summarize(rows).mrr).toBeCloseTo(0.5)
    expect(summarize([])).toMatchObject({ queries: 0, mrr: 0, ndcg: 0 })
  })
})

describe('longmemeval suite', () => {
  const row = {
    question_id: 'q1',
    question_type: 'knowledge-update',
    question: 'Where do I work now?',
    question_date: '2023/05/30 (Tue) 23:40',
    answer: 'Acme',
    haystack_dates: ['2023/05/20 (Sat) 02:21', '2023/05/21 (Sun) 09:00'],
    haystack_session_ids: ['s0', 's1'],
    haystack_sessions: [
      [{ role: 'user', content: 'unrelated chatter', has_answer: 'False' }],
      [
        { role: 'user', content: 'I moved to Acme last week', has_answer: 'True' },
        { role: 'assistant', content: 'Congratulations!', has_answer: 'False' },
      ],
    ],
    answer_session_ids: ['s1'],
  }

  it('reads the dataset date stamps', () => {
    expect(parseStamp('2023/05/20 (Sat) 02:21')).toBe(Date.UTC(2023, 4, 20, 2, 21))
    expect(parseStamp('not a date')).toBeUndefined()
  })

  it('takes turn-level labels as the gold set when the dataset gives them', () => {
    expect(longMemEvalCorpus(row)?.tasks[0]?.gold).toEqual(['s1:0'])
  })

  it('maps roles to authors, so assistant turns stay evidence-use', () => {
    const documents = longMemEvalCorpus(row)?.documents ?? []
    expect(documents.find(d => d.id === 's1:1')?.kind).toBe('assistant-message')
    expect(documents.find(d => d.id === 's1:0')?.kind).toBe('user-message')
  })

  it('falls back to the whole evidence session when no turn is flagged', () => {
    const unflagged = {
      ...row,
      haystack_sessions: [row.haystack_sessions[0]!, row.haystack_sessions[1]!.map(t => ({ ...t, has_answer: 'False' }))],
    }
    expect(longMemEvalCorpus(unflagged)?.tasks[0]?.gold).toEqual(['s1:0', 's1:1'])
  })

  it('drops a question with no evidence at all rather than scoring it as a failure', () => {
    expect(longMemEvalCorpus({ ...row, answer_session_ids: [], haystack_sessions: [row.haystack_sessions[0]!], haystack_session_ids: ['s0'] })).toBeUndefined()
  })
})

describe('locomo suite', () => {
  const conversation = {
    sample_id: 'conv1',
    conversation: {
      speaker_a: 'Caroline',
      speaker_b: 'Melanie',
      session_1_date_time: '1:56 pm on 8 May, 2023',
      session_1: [
        { speaker: 'Caroline', dia_id: 'D1:1', text: 'Hey Mel!' },
        { speaker: 'Melanie', dia_id: 'D1:2', text: 'Look at this', blip_caption: 'a dog on a beach' },
      ],
    },
    qa: [
      { question: 'Who did Caroline greet?', answer: 'Melanie', evidence: ['D1:1'], category: 4 },
      { question: 'unanswerable', evidence: [], category: 3 },
    ],
  }

  it('names the dataset numeric categories', () => {
    expect(CATEGORY[1]).toBe('multi-hop')
    expect(CATEGORY[5]).toBe('adversarial')
  })

  it('keeps an image turn retrievable through its caption', () => {
    const documents = locomoCorpus(conversation).documents
    expect(documents.find(d => d.id === 'D1:2')?.text).toContain('a dog on a beach')
  })

  it('treats both speakers as people, so the evidence rule never applies', () => {
    expect(locomoCorpus(conversation).documents.every(d => d.kind === 'user-message')).toBe(true)
  })

  it('drops a question the dataset gives no evidence for', () => {
    expect(locomoCorpus(conversation).tasks.map(t => t.query)).toEqual(['Who did Caroline greet?'])
  })
})

describe('perltqa suite', () => {
  const memory = {
    profile: { Protagonist: 'Wang Xiaoming', Gender: 'male', Age: 28 },
    social_relationship: { '1_0': { 'Supporting Characters': 'Wang Xiaohong', Relationship: 'elder sister' } },
    events: { '1_0_0': { content: 'They explored the Grand Canyon.' } },
    dialogues: { '1_0_0#0': { contents: { '2022-05-12 08:00': ['AI assistant: Hello', 'Wang Xiaoming: Hi'] } } },
  }

  it('gives every addressable memory entry its own document, keyed by the id the questions cite', () => {
    const ids = documentsOf(memory).map(d => d.id)
    expect(ids).toEqual(expect.arrayContaining(['Gender', 'Age', '1_0', '1_0_0', '1_0_0#0']))
  })

  it('reads the flat profile category and the three nested ones alike', () => {
    const tasks = tasksOf('Wang Xiaoming', {
      profile: [{ Question: 'What gender?', 'Reference Memory': 'Gender' }],
      events: [{ '1_0_0': [{ Question: 'Where did they go?' }] }],
    })
    expect(tasks.map(t => [t.group, t.gold[0]])).toEqual([['profile', 'Gender'], ['events', '1_0_0']])
  })

  it('skips a question that cites nothing, rather than emitting an unscoreable task', () => {
    expect(tasksOf('x', { profile: [{ Question: 'What gender?' }] })).toEqual([])
  })
})

describe('MemoryStack', () => {
  it('retrieves the document that answers a query, by the corpus id the dataset uses', async () => {
    const stack = await MemoryStack.create({ recallLimit: 5, dimensions: 64, includeEvidence: false, consolidate: false, vectorWeight: 1 })
    await stack.ingest([
      { id: 'd1', text: 'the deployment runs on Kubernetes', kind: 'user-message' },
      { id: 'd2', text: 'lunch was good', kind: 'user-message' },
    ])
    const result = await stack.retrieve('what does the deployment run on?')
    expect(result.documents[0]).toBe('d1')
    await stack.dispose()
  })

  it('withholds an assistant turn unless the run asks for evidence', async () => {
    const documents = [{ id: 'a1', text: 'Kubernetes is the orchestrator here', kind: 'assistant-message' as const }]
    const withheld = await MemoryStack.create({ recallLimit: 5, dimensions: 64, includeEvidence: false, consolidate: false, vectorWeight: 1 })
    await withheld.ingest(documents)
    expect((await withheld.retrieve('what is the orchestrator?')).documents).toEqual([])
    await withheld.dispose()

    const quoted = await MemoryStack.create({ recallLimit: 5, dimensions: 64, includeEvidence: true, consolidate: false, vectorWeight: 1 })
    await quoted.ingest(documents)
    expect((await quoted.retrieve('what is the orchestrator?')).documents).toEqual(['a1'])
    await quoted.dispose()
  })
})

describe('floorOf', () => {
  // The corpus is documents now, not bare ids: `bm25` ranks on their text, and
  // the floors that ignore text still have to be handed the same shape.
  const docs = ['a', 'b', 'c', 'd', 'e'].map(id => ({ id, text: `document ${id}` }))

  it('returns nothing for the definitional zero', () => {
    expect(floorOf('none', docs, 3)('q1', 'query')).toEqual([])
  })

  it('returns the tail of the corpus, most recent first, for a scrollback window', () => {
    expect(floorOf('recent', docs, 3)('q1', 'query')).toEqual(['e', 'd', 'c'])
  })

  it('gives different questions different random draws, not one lucky shuffle', () => {
    const draw = floorOf('random', docs, 3)
    expect(draw('q1', 'query')).not.toEqual(draw('q2', 'query'))
  })

  it('draws reproducibly and without repeats, so a floor is comparable across runs', () => {
    const draw = floorOf('random', docs, 3)
    expect(draw('q1', 'query')).toEqual(draw('q1', 'query'))
    expect(new Set(draw('q1', 'query')).size).toBe(3)
  })

  it('never returns more than the corpus holds', () => {
    const one = [{ id: 'a', text: 'document a' }]
    expect(floorOf('random', one, 5)('q1', 'query')).toEqual(['a'])
    expect(floorOf('recent', one, 5)('q1', 'query')).toEqual(['a'])
  })

  it('ranks lexically for the bm25 floor, which is the baseline memory has to beat', () => {
    const corpus = [
      { id: 'x', text: 'the cat sat on the mat' },
      { id: 'y', text: 'quarterly revenue guidance for the region' },
      { id: 'z', text: 'a feline on a rug' },
    ]
    expect(floorOf('bm25', corpus, 2)('q1', 'revenue guidance')[0]).toBe('y')
    expect(floorOf('bm25', corpus, 2)('q1', 'cat mat')[0]).toBe('x')
  })

  it('returns nothing from the bm25 floor when no term matches', () => {
    const corpus = [{ id: 'x', text: 'the cat sat on the mat' }]
    expect(floorOf('bm25', corpus, 3)('q1', 'zzzz')).toEqual([])
  })
})

describe('kylinoffice suite', () => {
  const task = {
    task_id: 'KYLIN-0001',
    username: 'Alice',
    date: '2020-05-01',
    subtasks: [
      "add a new header 'Class' to the class member excel file",
      'add a new header Cost in shopping list excel file',
      'do something with no artefact in it at all',
    ],
    chat_sessions_info: {
      sessions: [
        { session: 's1', date: '2020-04-27', user_requests: ["Hi, can you add a new header 'Class' to the class member excel file?", 'How was your weekend?'] },
        { session: 's1', date: '2020-04-27', user_requests: ['How was your weekend?'] },
      ],
    },
    memory_dependency: {
      memory_chains: [
        {
          subtask_index: 0,
          subtask: "add a new header 'Class' to the class member excel file",
          related_memories: [{ date: '2020-04-26', speaker: 'user', text: 'I was thinking about score.xlsx averages.' }],
        },
      ],
    },
  }

  it('reads the artefact a subtask is about, quoted or bare', () => {
    expect(artefactOf("add a new header 'Class' to the file")).toBe('class')
    expect(artefactOf('add a new header Cost in shopping list excel file')).toBe('cost')
    expect(artefactOf('do something vague')).toBeUndefined()
  })

  it('deduplicates the chat history, which ships the same session several times', () => {
    const corpus = kylinofficeCorpus(task, 'grounded')
    expect(corpus?.documents.filter(d => d.text === 'How was your weekend?')).toHaveLength(1)
  })

  it('admits the cited memories as documents, so declared labels are reachable at all', () => {
    const corpus = kylinofficeCorpus(task, 'declared')
    expect(corpus?.documents.some(d => d.text.includes('score.xlsx averages'))).toBe(true)
  })

  it('labels a subtask with the utterance naming its artefact, under grounded', () => {
    const corpus = kylinofficeCorpus(task, 'grounded')
    const first = corpus?.tasks.find(t => t.query.includes('Class'))
    const gold = corpus?.documents.filter(d => first?.gold.includes(d.id)).map(d => d.text) ?? []
    expect(gold).toContain("Hi, can you add a new header 'Class' to the class member excel file?")
  })

  it('drops a subtask nothing in the history speaks to, rather than scoring it as a miss', () => {
    const corpus = kylinofficeCorpus(task, 'grounded')
    expect(corpus?.tasks.map(t => t.query)).not.toContain('do something with no artefact in it at all')
  })
})
