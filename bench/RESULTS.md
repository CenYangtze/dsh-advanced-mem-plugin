# Benchmark results

Four public datasets, four domains, one memory stack. Every number here comes
from `bench/retrieval.ts` or `bench/run.ts` against the shipped plugin bodies,
with the raw reports in `bench/out/`.

## What was run, and why these four

| Dataset | Domain | Size | Ground truth |
|---|---|---|---|
| [LongMemEval-S][lme] | long-term assistant chat | 500 questions, ~50 sessions each, 246,918 turns | evidence labelled per turn (`has_answer`) |
| [LoCoMo][locomo] | multi-session social dialogue | 10 conversations, ~27 sessions each, 1,982 questions | evidence dialogue ids |
| [PerLTQA][perltqa] | personal memory bank, EN + ZH | 32 personas, 8,593 questions each half | the memory entry the question cites |
| KylinMem | software engineering | 2,282 SWE-bench repo-pairs, 9,120 questions | keyword match, the dataset's own judge |

They were chosen to vary along the axes that actually change a memory system's
score: **who authored the evidence** (assistant turns in LongMemEval, two humans
in LoCoMo, structured entries in PerLTQA), **whether one corpus serves one
question or hundreds** (LongMemEval builds a haystack per question; LoCoMo makes
590 turns answer 199 questions), **script** (PerLTQA ships parallel Chinese and
English), and **domain** (three conversational, one code).

[lme]: https://huggingface.co/datasets/xiaowu0162/longmemeval
[locomo]: https://github.com/snap-research/locomo
[perltqa]: https://github.com/Elvin-Yiming-Du/PerLTQA

## Retrieval results

There is no language model in this system: it decides what a turn gets to see.
So the measurement is retrieval, reported the way LongMemEval's own paper
reports it — at **session** granularity, since a strict per-turn recall is capped
by the cue budget whenever a question has more evidence turns than there are
slots. Ten cues per query throughout.

| Suite | R@1 | R@5 | R@10 | hit@10 | MRR |
|---|---|---|---|---|---|
| LongMemEval-S | 44.8% | 80.9% | 85.7% | 92.8% | 0.799 |
| LoCoMo | 37.8% | 66.1% | 76.4% | 81.6% | 0.533 |
| PerLTQA (en) | 65.5% | 99.0% | 99.0% | 99.0% | 0.809 |
| PerLTQA (zh) | 68.6% | 99.5% | 99.5% | 99.5% | 0.822 |

By question type, where the dataset provides one:

| LongMemEval type | n | R@10 | hit@10 | MRR |
|---|---|---|---|---|
| knowledge-update | 78 | **96.8%** | **100.0%** | **0.966** |
| single-session-user | 70 | 95.7% | 95.7% | 0.818 |
| temporal-reasoning | 133 | 85.6% | 94.7% | 0.816 |
| multi-session | 133 | 82.2% | 97.7% | 0.848 |
| single-session-assistant | 56 | 76.8% | 76.8% | 0.603 |
| single-session-preference | 30 | **66.7%** | 66.7% | **0.402** |

| LoCoMo category | n | R@10 | hit@10 | MRR |
|---|---|---|---|---|
| single-hop | 841 | 93.4% | 93.5% | 0.760 |
| adversarial | 446 | 93.9% | 93.9% | 0.758 |
| temporal | 321 | 84.5% | 86.3% | 0.629 |
| multi-hop | 282 | **55.6%** | 82.6% | 0.519 |
| open-domain | 92 | 60.7% | 72.8% | 0.423 |

(The LoCoMo rows are from the lexical configuration — see the next section for
why that is the one worth quoting.)

## KylinMem Integrated v7.0 (office)

The office domain the other three suites do not cover: multi-app workflows
stitched from OfficeBench and OdysseyBench, each shipping the chat sessions it
is meant to draw on plus an injected set of `memory_chains` naming which past
utterances each subtask depends on.

Only `KYLIN-0001` was available, so nothing here is a score — six queries over
one corpus is a wiring check. What it did establish is that the published labels
do not describe the data, which is worth more than a number from one instance.

| Grounding | scoreable | R@1 | R@5 | MRR |
|---|---|---|---|---|
| `declared` — the file's own `memory_chains` | 6 | 0.0% | 5.6% | 0.139 |
| `grounded` — history utterances naming the same artefact | 3 | **72.2%** | **94.4%** | **1.000** |

Same retriever, same 86-record corpus. Only the labels differ.

Three defects, each checked rather than asserted:

**The cited memories are absent from the history the file ships.** Ten unique
memories are cited across the six chains; zero of them appear anywhere in
`chat_sessions_info`. A system asked to retrieve them from that history cannot,
so the harness admits them as documents in their own right — otherwise
`declared` would score zero for a reason that says nothing about retrieval.

**The cited memories are about a different task.** Every chain draws from one
conversation about averaging midterm scores in `score.xlsx`, while the subtasks
concern a class roster, a company budget and a shopping list. Token overlap
between a subtask and its own cited memories runs 0.04–0.10, and the shared
terms are `a`, `to`, `in`, `the`, `and`, `per`. Meanwhile the history *does*
contain the real antecedents — "Hi, can you add a new header 'Class' to the
class member excel file?" — unlabelled, which is what `grounded` picks up.

**The evaluator cannot be satisfied.** Ten cell conflicts: `class_member.xlsx`
(1,2) is required to hold `Class`, `Attendance` *and* `Meeting`; (2,2) to hold
both `Y` and `8:00`; `company_budget.xlsx` (1,3) both `amount after 1 year` and
`Increase Percentage Per Year`. Each stitched subtask was written as though it
owned column 2 or 3, and stitching them left every write on top of the last.

Two further problems that bound any future run: `chat_sessions_info` reports
`total_sessions: 12` but holds 7 distinct sessions, one of them repeated six
times; and every Chinese field is lossily corrupted — `批` arrives as `E6 B9`
with the `0x89` byte dropped, so no decode restores it. The English subtasks and
chat utterances are intact, which is why the suite runs at all.

`grounded` labels by artefact name and this harness ranks lexically, so its
1.000 is a ceiling, not a measurement. The comparison is the finding.

## What the runs changed

Three defects were found by these datasets and fixed. Each was measured before
and after; two of them were fixed and one hypothesis was measured and abandoned.

**One rank-to-score transform.** Layer-1 cues scored `1/(1 + position)` while
layer-0 cues came through fusion at `1/(60 + position + 1)`. At the same rank a
belief was worth **61 episodes**, and a belief ranked twentieth still beat the
best episode in the scope by three to one. Nothing in the graph was competing
with the substrate on merit; it simply preceded it. `rankScore` is now the only
transform, applied to nodes, edges, fused records, and activation seeding alike.

**A weight on the vector signal.** `memory-embedding-hash` is FNV-1a feature
hashing — a random projection of token hashes with no semantics — so its cosine
similarity is a lossier restatement of the term overlap BM25 already computes.
Unweighted RRF nonetheless let its first-ranked document outscore BM25's tenth.
Swept on all four corpora, monotonically:

| MRR | weight 1 | 0.25 | 0 |
|---|---|---|---|
| LoCoMo | 0.533 | 0.611 | **0.688** |
| LongMemEval-S | 0.800 | 0.834 | **0.859** |
| PerLTQA (en) | 0.696 | 0.731 | **0.734** |
| PerLTQA (zh) | 0.720 | 0.769 | **0.788** |

No weight beat zero anywhere, so the shipped bundle no longer mounts the hash
embedder at all. `vectorWeight` stays at 1 because it is the weight a *real*
embedder should get; the hash one was the problem, not the seam.

**Support weighting moved out of query-time ranking.** Added in response to
"emphasise what recurs", and correct as an idea, but wrong here: once the rank
curve was flat — rank 1 and rank 20 differ by a factor of 1.3 — a 1.5×
multiplier outweighed twenty places of lexical evidence.

| supportWeight | gold hit@1 | gold MRR | raw hit@1 | raw MRR |
|---|---|---|---|---|
| 0.15 | 76.9% | 0.857 | 83.3% | 0.888 |
| 0.05 | 91.5% | 0.943 | 88.1% | 0.912 |
| **0** | **96.3%** | **0.969** | **88.1%** | **0.912** |

Best on both corpus shapes at once, so it ships at 0. Frequency still governs
`profile` and `suggest`, which rank on `confidence × log1p(support)` and are
where nothing is competing with a query.

**A hypothesis the data refused.** A `beliefPrior` was added on the theory that
the gold-mode regression was beliefs losing to episodes. Raising it to 2 cost
raw mode 19 points of rank-1 accuracy and changed gold mode *not at all* —
scaling every node equally cannot reorder nodes among themselves, so the gold
misses were belief-versus-belief all along. The knob was removed rather than
shipped at a value that only ever hurt.

Net, on KylinMem's 9,120 questions, both columns measured in the configuration
that actually ships:

| | at the start of this work | now |
|---|---|---|
| raw accuracy | 1.9% | **4.7%** |
| raw hit@5 | 83.1% | **97.7%** |
| raw MRR | 0.791 | **0.834** |
| raw hit@1 | 76.1% | 69.6% |
| gold accuracy | 98.8% | 98.7% |
| gold hit@1 | 98.0% | 98.0% |
| gold MRR | 0.983 | 0.980 |

Gold held. Raw — far more episodes than beliefs, which is what a real memory
looks like — gained 2.5× on the dataset's own judge and 14.6 points of hit@5,
against 6.5 points of hit@1.

That last row is worth stating rather than burying. Removing the hash embedder
costs raw mode rank-1 accuracy, because the vector signal's noise had been
inflating record scores enough to displace a handful of generic distilled nodes
— an accident helping, in the opposite direction to the one that started this.
The decision stands anyway: accuracy, hit@5 and MRR all improve without it here,
and on the three conversational corpora nothing about it was ever positive.

## Baselines

A retrieval score with no floor under it is not a result. Four rankings were
scored against the same questions: the system, and three that need no retrieval
at all — `none` (return nothing), `random` (ten documents drawn per question,
seeded reproducibly), and `recent` (the last ten documents, which is what a
fixed scrollback window holds).

| Dataset | metric | memory | lexical | random | recent | none |
|---|---|---|---|---|---|---|
| LoCoMo | session R@10 | 76.4% | **85.2%** | 33.8% | 2.6% | 0.0% |
| LoCoMo | session MRR | 0.533 | **0.688** | 0.137 | 0.029 | 0.000 |
| LongMemEval-S | session R@10 | 85.7% | **90.3%** | 21.4% | 3.7% | 0.0% |
| LongMemEval-S | session MRR | 0.799 | **0.859** | 0.132 | 0.054 | 0.000 |
| PerLTQA (en) | document R@10 | 94.4% | **96.1%** | 15.0% | 14.6% | 0.0% |
| PerLTQA (en) | document MRR | 0.696 | **0.734** | 0.044 | 0.042 | 0.000 |
| PerLTQA (zh) | document R@10 | 92.6% | **94.1%** | 14.6% | 14.6% | 0.0% |
| PerLTQA (zh) | document MRR | 0.720 | **0.788** | 0.042 | 0.042 | 0.000 |

Two things this settles, and one it breaks.

**The lift is real.** Against `random`, MRR is 5× better on LoCoMo, 6.5× on
LongMemEval and 16× on PerLTQA. Against `recent` — the honest competitor, since
a long context window is what a memory system is usually asked to justify itself
against — it is 24×, 16× and 17×. These datasets cannot be solved by keeping the
tail of the conversation, which is exactly what makes them worth running.

**`none` is 0.0% everywhere**, as it must be. It is reported because a floor that
is *not* zero would mean evidence had leaked into the ranking, and that check is
cheap.

**PerLTQA's session-level numbers are void.** A `random` draw scores 96.4% there
— indistinguishable from the system — because PerLTQA has no sessions: this
harness maps its four memory categories onto the session field, so ten random
documents out of ~67 almost always touch all four buckets. Only the
document-level column means anything for that dataset. The table above uses
session granularity for the two conversational suites and document granularity
for PerLTQA for exactly this reason; the earlier tables in this document report
PerLTQA at session level and should be read with that in mind.

## The finding that matters: the embedder is making retrieval worse

Running every suite with and without the feature-hash embedder (`--dimensions 0`
unmounts it and leaves BM25 plus graph activation):

| Suite | hybrid R@10 | lexical R@10 | hybrid MRR | lexical MRR |
|---|---|---|---|---|
| LoCoMo | 76.4% | **85.2%** | 0.533 | **0.688** |
| LongMemEval-S | 85.7% | **90.3%** | 0.799 | **0.859** |
| PerLTQA (en) | **99.0%** | 98.4% | 0.809 | **0.823** |
| PerLTQA (zh) | **99.5%** | 96.1% | 0.822 | **0.848** |

Lexical-only wins MRR on all four and R@10 on the two conversational ones, by up
to 8.8 points of recall and 0.155 of MRR.

The mechanism is not subtle. `memory-embedding-hash` is FNV-1a feature hashing —
a random projection of token hashes, with no semantics in it at all; cosine
similarity over that is a noisy restatement of term overlap, not a second opinion
about meaning. `reciprocalRankFusion` then weights it *equally* with BM25: a
document the vector signal ranks first contributes `1/61`, which outranks a
document BM25 puts tenth at `1/70`. So a signal that knows nothing displaces one
that does.

Three ways out, in increasing order of effort: weight the rankings in fusion
instead of summing them flat; gate the vector signal on some measure of its own
confidence; or replace the hash embedder with a real embedding model behind the
same `MemoryEmbedder` interface, which is what the interface was for. Until one
of those lands, `dimensions: 0` is the better default on text-heavy corpora — and
the bundle currently ships `512`.

## The cost of not quoting the agent back to itself

LongMemEval is the one suite whose evidence sometimes sits in *assistant* turns,
which are `evidence` by author and therefore never read back. Lifting that rule:

| LongMemEval type | withheld R@10 | quoted R@10 | withheld hit@10 | quoted hit@10 |
|---|---|---|---|---|
| single-session-assistant | 22.4% | **42.9%** | 76.8% | **91.1%** |
| all types | 16.7% | 21.3% | 92.8% | 93.8% |

So the rule costs about 14 points of hit@10 on the 56 questions that ask what the
assistant said, and roughly one point overall. That is the price of a session
that does not open by telling the model what it already did, stated as a number
rather than as an argument. Both halves belong in any quote.

## Where it is weak, and what that says

**Multi-hop is the floor.** LoCoMo multi-hop R@10 55.6% against 93.4% single-hop,
and hit@10 82.6% — the pieces are usually *somewhere* in the ten cues, but a
single query embedding cannot pull two distant turns to the top together.
Query decomposition, not better ranking, is what would move it.

**Preferences are found worst.** LongMemEval `single-session-preference` is the
weakest category at 66.7% hit@10 and MRR 0.402 — which is uncomfortable, because
preferences are exactly what this system claims to be for. They are phrased
obliquely ("I'd rather you kept it short") and share no terms with the question
that asks about them, so a lexical index cannot see them. This is the strongest
argument in these results for a real embedder, and the strongest argument for
distilling preferences into layer-1 nodes at capture time rather than hoping to
retrieve the turn later.

**Knowledge update is the ceiling.** 100% hit@10 and MRR 0.966, the best of any
category on any suite. Questions about what superseded what are the ones this
design was built around, and it shows.

**Chinese and English are at parity.** PerLTQA zh MRR 0.822 against en 0.809, on
the same corpus in two languages. The CJK character-bigram path in `tokenize`
works; nothing here needs a separate tokenizer.

One caveat on PerLTQA's Chinese `profile` category, which scores 12.0% against
84.6% in English: the Chinese memory bank stores English field labels
(`Gender`, `Age`) beside Chinese values, while the questions ask in Chinese
(`性别`). The term the question turns on appears nowhere in the document. That is
a property of the published file, not a retrieval failure, and the other three
categories — which are Chinese throughout — score at parity.

## KylinMem

Reported separately in [README.md](README.md#what-a-full-run-has-shown), because
its judge is keyword matching rather than retrieval. Short version: 98.8% on the
dataset's own questions, 1.9% end to end, and the gap is content distillation —
the same conclusion the preference category reaches here from the other side.
