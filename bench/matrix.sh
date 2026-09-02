#!/usr/bin/env bash
# Run every configuration worth reporting, in one pass.
#
# A single number from this benchmark means nothing on its own: it depends on
# what was ingested, how many distractors the question competed with, and which
# question was asked. This runs the six that bracket each other, so a result can
# be read rather than quoted.
#
#   bench/matrix.sh /path/to/kylinmem_dev_batch_real.jsonl [limit]
set -euo pipefail

DATASET="${1:?usage: bench/matrix.sh <instances.jsonl> [limit]}"
LIMIT="${2:-0}"
RUN=(node --experimental-transform-types "$(dirname "$0")/run.ts" --dataset "$DATASET" --limit "$LIMIT")

run() {
  echo "### $*"
  "${RUN[@]}" "$@" 2>&1 | grep -Ev 'ExperimentalWarning|trace-warnings'
  echo
}

# The dataset's own questions: the ceiling, then the same thing with every
# repository's memories in one scope.
run --mode gold --isolation repo
run --mode gold --isolation global

# The question the dataset designed but did not write down.
run --mode gold --isolation repo --query task

# End to end: only the history events go in, the shipped distiller decides what
# to believe.
run --mode raw --isolation repo

# The same ingest with distillation off, paired with and without the evidence
# rule. The pair is the price tag on not quoting the agent's own tool calls back
# to it, and it has to be measured on the bare substrate: with the behaviour
# graph present, all eight cue slots go to tool habits and no record of either
# use reaches the answer at all.
run --mode raw --isolation repo --no-consolidate
run --mode raw --isolation repo --no-consolidate --include-evidence

# The floor. Anything above zero here is keyword leakage into the question.
run --mode off --isolation repo
