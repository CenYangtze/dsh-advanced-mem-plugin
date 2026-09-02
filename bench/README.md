# KylinMem benchmark harness

A scoring adapter for the [KylinMem development-scenario dataset][dataset] — the
Kylin OS agent-memory benchmark. It ingests the dataset's history sessions into
a live instance of this plugin's memory stack, asks the dataset's questions, and
hands the answers to the dataset's own judge.

Nothing here ships. `bench/` is excluded from the package `files` list and from
the bundle; it exists so a number about this system can be produced by someone
who did not write it.

[dataset]: https://github.com/../kylinmem_dev_batch

## What it measures

The dataset's premise is **memory dependency injection**: take a solved issue,
distil it into one memory, then ask a question that cannot be answered from the
prompt alone. An agent without the memory has to rediscover the answer; an agent
with it does not. The gap between the two is what memory is worth.

That makes the score a *retrieval* score, not a reasoning score. The judge counts
keywords, and the answer this harness submits is the text the recall plugin would
have injected into a turn — produced by the shipped `renderCue`, not by anything
written for the benchmark. If the right memory came back, the keywords are in it.

## Running it

Three commands. The first two are the bracket the dataset's README asks for; the
third is the run.

```bash
# 1. Produce answers from a live memory stack.
pnpm run bench -- --dataset /path/to/kylinmem_dev_batch_real.jsonl \
                  --mode gold --isolation repo

# 2. Check the judge before trusting it: an oracle must score 100%, a blank 0%.
python bench/score.py --mode oracle --qa bench/out/qa-gold-repo.jsonl \
                      --dataset-dir /path/to/kylinmem_dev_batch
python bench/score.py --mode blank  --qa bench/out/qa-gold-repo.jsonl \
                      --dataset-dir /path/to/kylinmem_dev_batch

# 3. Score the run with the dataset's judge.
python bench/score.py --qa bench/out/qa-gold-repo.jsonl \
                      --answers bench/out/answers-gold-repo.jsonl \
                      --dataset-dir /path/to/kylinmem_dev_batch
```

`bench/run.ts` also prints its own reading of the same judging rule, so a quick
loop needs no Python; `bench/score.py` is what makes a published number the
dataset's rather than ours. They agree by construction — `tests/bench` pins that.

## The knobs that decide the number

Report all three. A memory score without them is not comparable to anything.

| Flag | Values | What changes |
|---|---|---|
| `--mode` | `gold` \| `raw` \| `off` | `gold` writes the dataset's distilled memory in and measures retrieval alone — the ceiling. `raw` writes only the history events and lets the shipped distiller decide what to believe — the end-to-end score. `off` writes nothing — the floor the dataset calls `blank`. |
| `--isolation` | `instance` \| `repo` \| `global` | How many other memories a question competes with. `instance` gives each its own scope and is a wiring check, not a score. `repo` matches the dataset's repo-pair construction. `global` puts all 2,282 in one scope. |
| `--query` | `issue` \| `task` | Which question is asked. `issue` reproduces `build_qa.py`. `task` asks the harder one the dataset designed but never wrote down — see below. |
| `--include-evidence` | off by default | Whether `evidence`-use records may be quoted back. See below. |

`bench/matrix.sh <dataset.jsonl> [limit]` runs the six configurations that
bracket each other, which is the shape a result should be reported in.

Also `--limit N` (instances, spread across repositories rather than truncated),
`--recall-limit N` (cues per answer), `--dimensions N` (`0` runs lexically, with
no vector signal).

### `--query task`: the question the dataset designed but did not write

All four of `build_qa.py`'s questions quote the historical issue back verbatim —
`关于「WCS.all_world2pix failed to converge」这个历史问题…`. That string is also
the memory's own subject line, so retrieval collapses into looking a document up
by its title, and any lexical index scores near the ceiling. It measures
indexing, not recall.

The dataset's own `memory_dependency.memory_on_expected` describes something
harder and states it plainly: *retrieve m1 (repository experience) → reuse the
approach → fix B directly*. B is the target task, which shares no wording with
the history. `--query task` asks that instead, and changes nothing else: the
reference answer is still the gold memory, so the judge and its oracle check are
untouched. Expect a much lower number, and expect the retrieval block rather than
the accuracy to be the informative half of it.

### The one flag that is a design question

This dataset's history events say things like `edit — apply gold_patch hunk →
astropy/wcs/wcsapi/fitswcs.py`. That file path is exactly what the judge counts.
It is also an *agent's own tool call*, which this system indexes and ranks but
refuses to quote back — the rule that stops a session from opening by telling the
model what it had already done.

So `--include-evidence` is not a tuning knob, it is a price tag: the delta
between the two runs is benchmark score this system declines to collect. Quote
the pair, not whichever half reads better.

## What comes out

`bench/out/` gets three files per configuration:

- `qa-<mode>-<isolation>.jsonl` — the questions, in the dataset's published QA
  schema, so its own tooling can read them.
- `answers-<mode>-<isolation>.jsonl` — `{qa_id, answer}`, the seam.
- `report-<mode>-<isolation>.json` — accuracy by dimension, memory type and
  repository, plus retrieval diagnostics and timings.

The retrieval block is the diagnostic worth reading first: `hit@1`, `hit@5`,
`hit@k` and `MRR` over whether the *questioned instance's own* memory came back
at all. Keyword accuracy tells you the score; those tell you why.

`unattributed_passes` in the same block is the one to read before quoting the
accuracy anywhere. Neighbouring memories in one repository name overlapping
files, so a keyword pass does not prove the right memory came back; this is the
share of the passes that were carried by some *other* instance's memory. On a
transfer run it has been high enough to account for most of the score.

## What a full run has shown

Every row below is all 2,282 instances, judged by the dataset's own `evaluate.py`
(bracket: oracle 100%, blank 0%).

| Configuration | Accuracy | hit@1 | MRR | Unattributed |
|---|---|---|---|---|
| `gold` / `repo` / `issue` | 98.8% | 98.0% | 0.983 | 0.1% |
| `gold` / `global` / `issue` | 98.6% | 98.0% | 0.983 | 0.0% |
| `gold` / `repo` / **`task`** | 23.6% | **0.4%** | 0.019 | **76.0%** |
| `raw` / `repo` / `issue` | 1.9% | 76.1% | 0.791 | 0.0% |
| `raw` / `repo` / `issue`, `--no-consolidate` | 4.4% | 88.6% | 0.919 | 0.7% |
| the same, `--include-evidence` | 14.1% | 87.8% | 0.910 | 2.4% |
| `off` / `repo` / `issue` | 0.0% | 0.0% | 0.000 | — |

Four things worth carrying away, three of them about the dataset:

**Retrieval is not the bottleneck, and the questions do not prove it is.** Going
from ~850 competing memories to 2,263 costs 0.2 points, which is not a
robustness result — it is what happens when the question quotes the memory's own
title. This measures indexing.

**The transfer question is at chance.** hit@1 of 0.4%, and 76% of the passes come
from a neighbour's memory rather than the right one. That is a property of the
pairing, not of any retriever: across the batch, a history issue and its target
task share a token Jaccard of 0.029, and the target names a file the history's
fix touched 2.1% of the time. There is nothing in A to retrieve for B. Pairs
chosen by shared subsystem rather than by adjacent instance number would fix it.

**Behavioural beliefs crowd out everything else.** With distillation on, all
eight cue slots fill with tool habits — `edit is habitually followed by bash` —
and no episodic record of either use reaches the answer at all. That is why the
evidence pair has to be measured with `--no-consolidate`, and it is worth
remembering outside the benchmark too: a graph that only knows how the agent
works will tell the model about the agent.

**The gap in this system is distillation, not recall.** `gold` 98.8% against
`raw` 1.9%: handed the right belief, it finds it; it cannot yet *form* that
belief. `BehaviorCycleDistiller` mines behaviour cycles, and this dataset asks
for domain facts — what a past fix touched, what a repository requires. A content
distiller alongside the behaviour one is what would move the `raw` column.

## Two things the dataset cannot score yet

Both are stated here rather than worked around silently, because they bound what
any number from this harness means.

**The questions are regenerated, not shipped.** The published batch contains
instances but no QA file, and the dataset's `build_qa.py` reads a
`seed_sources.json` that is not distributed with it. `bench/qa.ts` regenerates
the four dimensions from the instances, matching `build_qa.py` template for
template. The one thing it cannot copy is `secret_tokens`, the keyword list,
which is dropped during instance assembly: it derives the keywords from the
source files a fix touched instead. Those are stated nowhere but in the memory,
they survive into both forms of gold answer, and naming one is the repository
knowledge the benchmark claims to measure. The oracle check is what keeps that
substitution honest.

**Layer 2 does not exist yet.** The dataset's own README says so, and the
published batch confirms it: no `base_commit`, no `gold_patch`, no `test_patch`.
On top of that, `evaluator.fail_to_pass` and `pass_to_pass` arrive as JSON
strings rather than lists — some pipeline stage iterated a string into its
characters — so `["astropy/…"]` reads back as `["[", "\"", "a", …]`. `dataset.ts`
repairs that on load and reports how many rows it touched, but the fields it
recovers are still only test *names*. Until the ingest pipeline carries commits
and patches, ΔP (pass rate with memory minus without) cannot be computed, and
every number from this harness is layer 1: does the right memory come back.

## Other datasets

`bench/` also runs three public memory benchmarks under a retrieval protocol —
LongMemEval, LoCoMo and PerLTQA — sharing one stack, one set of metrics and one
runner. See [RESULTS.md](RESULTS.md) for what they measured, and:

```bash
bench/retrieval-matrix.sh /path/to/data-dir          # every suite and both ablations
pnpm exec node --experimental-transform-types bench/retrieval.ts   --suite locomo --dataset /path/to/locomo10.json    # one suite
```

| File | What it is |
|---|---|
| `bench/retrieval.ts` | the runner: one corpus at a time, boot, ingest, ask, tear down |
| `bench/stack.ts` | the stack under test, with nothing dataset-specific in it |
| `bench/metrics.ts` | Recall@k, hit@k, MRR, nDCG |
| `bench/suites/*.ts` | one file per dataset, reducing it to corpora, documents and gold ids |

## Layout

```
bench/dataset.ts   read and repair the instance file
bench/qa.ts        regenerate the four dimension questions and the judging rule
bench/adapter.ts   the system under test: boot, ingest, answer
bench/run.ts       CLI
bench/matrix.sh    the six configurations that bracket each other
bench/score.py     hand answers to the dataset's evaluate.py
bench/retrieval.ts the other three datasets, under a retrieval protocol
bench/RESULTS.md   what every dataset measured (+ .zh.md)
tests/bench/       what pins the pure parts of the above
```

`bench/adapter.ts` holds the one thing that is not shipped code: the policy
mapping a dataset event chain onto record kinds and node types. It is worth
reading before quoting a number, because every number depends on it.
