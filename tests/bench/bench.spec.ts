import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { loadInstances, repairTestList, subsample } from '../../bench/dataset.ts'
import type { KylinInstance } from '../../bench/dataset.ts'
import { buildQuestions, judge, keywordsFor, questionsFor, transferQuestionFor } from '../../bench/qa.ts'
import { MemorySystemUnderTest } from '../../bench/adapter.ts'

const roots: string[] = []

/** A minimal instance in the dataset's published shape. */
function instance(overrides: Partial<KylinInstance> = {}): KylinInstance {
  return {
    instance_id: 'kylin_real_astropy__astropy-1__astropy__astropy-2',
    repo: 'astropy/astropy',
    language: 'python',
    history_session: {
      session_id: 's1',
      issue: 'WCS.all_world2pix failed to converge\nlong body follows',
      events: [
        { event_id: 'e1', type: 'observation', step: 1, content: 'issue 正文: WCS.all_world2pix failed to converge' },
        {
          event_id: 'e2', type: 'tool_call', step: 2, content: '', tool: 'edit',
          tool_input: 'apply gold_patch hunk → astropy/wcs/wcsapi/fitswcs.py', result: 'patch 已应用', success: true,
        },
      ],
      evidence_ids: ['e1', 'e2'],
      outcome: 'resolved',
    },
    gold_memory: {
      memory_id: 'm1',
      type: 'skill',
      content: '仓库 astropy/astropy 曾修过: WCS.all_world2pix。修复涉及 astropy/wcs/wcsapi/fitswcs.py。',
      source_event_ids: ['e1', 'e2'],
    },
    target_task: {
      task_id: 't1',
      problem_statement: 'Add helpers to convert between uncertainty classes.',
      no_leak_note: '依赖仓库级记忆 m1',
      harder_without_memory: true,
    },
    evaluator: { inherited_from: 'SWE-bench', fail_to_pass: [], pass_to_pass: [] },
    ...overrides,
  }
}

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

describe('repairTestList', () => {
  it('recovers a list the dataset stored as a JSON string', () => {
    expect(repairTestList('["tests/test_wcs.py::test_all"]')).toEqual({
      names: ['tests/test_wcs.py::test_all'], repaired: true,
    })
  })

  it('recovers a list a pipeline stage iterated into characters', () => {
    expect(repairTestList([...'["a::b"]'])).toEqual({ names: ['a::b'], repaired: true })
  })

  it('leaves a well-formed list alone, so a fixed dataset is not double-handled', () => {
    expect(repairTestList(['a::b', 'c::d'])).toEqual({ names: ['a::b', 'c::d'], repaired: false })
  })

  it('reports an unrecoverable value rather than throwing mid-load', () => {
    expect(repairTestList('not json at all')).toEqual({ names: [], repaired: true })
    expect(repairTestList(undefined)).toEqual({ names: [], repaired: false })
  })
})

describe('loadInstances', () => {
  it('repairs the evaluator lists while reading, and says how many it touched', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'kylin-bench-'))
    roots.push(directory)
    const path = join(directory, 'batch.jsonl')
    const row = { ...instance(), evaluator: { inherited_from: 'SWE-bench', fail_to_pass: '["a::b"]', pass_to_pass: '[]' } }
    await writeFile(path, `${JSON.stringify(row)}\n\n{ broken\n`, 'utf8')
    const loaded = await loadInstances(path)
    expect(loaded.instances).toHaveLength(1)
    expect(loaded.instances[0]?.evaluator.fail_to_pass).toEqual(['a::b'])
    expect(loaded.health).toEqual({ unparsable: 1, repairedTestLists: 1, withoutTestNames: 0 })
  })
})

describe('subsample', () => {
  it('keeps the repository mix rather than the first N rows', () => {
    const rows = [
      instance({ instance_id: 'a1', repo: 'a' }),
      instance({ instance_id: 'a2', repo: 'a' }),
      instance({ instance_id: 'a3', repo: 'a' }),
      instance({ instance_id: 'b1', repo: 'b' }),
    ]
    expect(subsample(rows, 2).map(row => row.instance_id)).toEqual(['a1', 'b1'])
  })

  it('returns everything when the limit is zero or larger than the set', () => {
    const rows = [instance({ instance_id: 'a1' })]
    expect(subsample(rows, 0)).toHaveLength(1)
    expect(subsample(rows, 9)).toHaveLength(1)
  })
})

describe('keywordsFor', () => {
  it('takes the files a fix touched, which is what the memory knows and the prompt does not', () => {
    expect(keywordsFor(instance())).toEqual(['astropy/wcs/wcsapi/fitswcs.py'])
  })

  it('never counts a bare basename, which half the repository would satisfy', () => {
    expect(keywordsFor(instance())).not.toContain('fitswcs')
  })

  it('yields nothing for an instance that records no touched file', () => {
    const row = instance({
      gold_memory: { memory_id: 'm1', type: 'skill', content: '仓库 astropy 曾修过一个问题。', source_event_ids: [] },
      history_session: { ...instance().history_session, events: [] },
    })
    expect(keywordsFor(row)).toEqual([])
  })
})

describe('questionsFor', () => {
  it('asks all four dimensions the dataset scores', () => {
    expect(questionsFor(instance()).map(qa => qa.dimension)).toEqual(['fact', 'meaning', 'causal', 'state_update'])
  })

  it('answers every dimension with something the keywords appear in, so an oracle scores 100%', () => {
    for (const qa of questionsFor(instance())) expect(judge(qa, qa.gold_answer).passed).toBe(true)
  })

  it('asks a knowledge_update instance what changed rather than what is true', () => {
    const row = instance({
      gold_memory: { ...instance().gold_memory, type: 'knowledge_update' },
    })
    expect(questionsFor(row)[3]?.question).toContain('更新了什么')
  })

  it('drops a question whose only keyword the issue title already leaks', () => {
    // sympy-21271 is real: its issue title names the very file its fix touched,
    // so the judge has nothing left to count and an oracle would fail the item.
    const row = instance({
      history_session: {
        ...instance().history_session,
        issue: 'Doctest failure in sympy/physics/vector/frame.py',
        events: [],
      },
      gold_memory: {
        memory_id: 'm1', type: 'skill',
        content: '修复涉及 sympy/physics/vector/frame.py。', source_event_ids: [],
      },
      repo: 'sympy/sympy',
    })
    expect(questionsFor(row)).toEqual([])
  })

  it('drops an unscoreable instance instead of emitting a question nothing can pass', () => {
    const row = instance({
      gold_memory: { memory_id: 'm1', type: 'skill', content: '没有文件。', source_event_ids: [] },
      history_session: { ...instance().history_session, events: [] },
    })
    expect(buildQuestions([row])).toEqual({ questions: [], unscoreable: [row.instance_id] })
  })
})

describe('transferQuestionFor', () => {
  it('asks about the new task instead of quoting the historical issue title back', () => {
    const qa = transferQuestionFor(instance())
    expect(qa?.dimension).toBe('transfer')
    expect(qa?.question).toContain('Add helpers to convert between uncertainty classes.')
    expect(qa?.question).not.toContain('all_world2pix')
  })

  it('keeps the gold memory as the reference answer, so the oracle check still holds', () => {
    const qa = transferQuestionFor(instance())
    expect(qa === undefined ? false : judge(qa, qa.gold_answer).passed).toBe(true)
  })

  it('is what buildQuestions emits in task style, one per instance', () => {
    const built = buildQuestions([instance()], 'task')
    expect(built.questions.map(qa => qa.dimension)).toEqual(['transfer'])
  })
})

describe('judge', () => {
  it('does not count a keyword the question already contains', () => {
    const qa = { ...(questionsFor(instance())[0] as NonNullable<ReturnType<typeof questionsFor>[number]>) }
    const inQuestion = { ...qa, question: `${qa.question} fitswcs`, keywords: ['fitswcs'] }
    expect(judge(inQuestion, 'fitswcs').passed).toBe(false)
  })
})

describe('MemorySystemUnderTest', () => {
  /** Boot the stack over a throwaway storage root. */
  async function system(overrides: Partial<Parameters<typeof MemorySystemUnderTest.create>[0]> = {}) {
    const root = await mkdtemp(join(tmpdir(), 'kylin-bench-'))
    roots.push(root)
    return MemorySystemUnderTest.create({
      mode: 'gold', isolation: 'repo', root, recallLimit: 8, dimensions: 64,
      includeEvidence: false, consolidate: true, vectorWeight: 1,
  supportWeight: 0.15, ...overrides,
    })
  }

  it('recalls the belief it was given, rendered the way a turn would see it', async () => {
    const sut = await system()
    const row = instance()
    await sut.ingest(row)
    const qa = questionsFor(row)[0]
    const answer = await sut.answer(qa as NonNullable<typeof qa>, row)
    expect(answer.answer).toContain('astropy/wcs/wcsapi/fitswcs.py')
    expect(answer.goldRank).toBe(1)
    await sut.dispose()
  })

  it('keeps the ingested tool calls out of the answer, which is what costs it keywords', async () => {
    const sut = await system({ mode: 'raw', consolidate: false, vectorWeight: 1 })
    const row = instance()
    await sut.ingest(row)
    const qa = questionsFor(row)[0]
    const answer = await sut.answer(qa as NonNullable<typeof qa>, row)
    // The path is only ever stated by the `edit` tool event, which is evidence.
    expect(answer.answer).not.toContain('astropy/wcs/wcsapi/fitswcs.py')
    await sut.dispose()
  })

  it('quotes the same tool calls when a run explicitly prices the rule', async () => {
    const sut = await system({ mode: 'raw', includeEvidence: true, consolidate: false, vectorWeight: 1 })
    const row = instance()
    await sut.ingest(row)
    const qa = questionsFor(row)[0]
    const answer = await sut.answer(qa as NonNullable<typeof qa>, row)
    expect(answer.answer).toContain('astropy/wcs/wcsapi/fitswcs.py')
    await sut.dispose()
  })

  it('writes nothing at all in off mode, so the floor is a real floor', async () => {
    const sut = await system({ mode: 'off' })
    const row = instance()
    await sut.ingest(row)
    const qa = questionsFor(row)[0]
    const answer = await sut.answer(qa as NonNullable<typeof qa>, row)
    expect(answer.answer).toBe('')
    expect(answer.goldRank).toBeNull()
    await sut.dispose()
  })

  it('separates scopes by isolation, so a repo run is not secretly an instance run', async () => {
    const sut = await system({ isolation: 'instance' })
    expect(sut.scopeOf(instance())).toEqual({ kind: 'workspace', workspace: `/kylin/${instance().instance_id}` })
    const shared = await system({ isolation: 'global' })
    expect(shared.scopeOf(instance())).toEqual({ kind: 'workspace', workspace: '/kylin' })
    await sut.dispose()
    await shared.dispose()
  })
})
