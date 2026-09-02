#!/usr/bin/env bash
# Run every retrieval suite, plus the two ablations worth reporting beside them.
#
#   bench/retrieval-matrix.sh /path/to/membench-data [limit]
#
# The data directory is expected to hold, by these names:
#   locomo10.json              github.com/snap-research/locomo  (data/locomo10.json)
#   longmemeval_s.json         hf.co/datasets/xiaowu0162/longmemeval  (longmemeval_s)
#   perltqa_perltqa_en.json    github.com/Elvin-Yiming-Du/PerLTQA  (Dataset/en/perltqa_en.json)
#   perltqa_perltmem_en.json   the matching memory bank
#   perltqa_perltqa.json       the same pair from Dataset/zh/
#   perltqa_perltmem.json
set -euo pipefail

DATA="${1:?usage: bench/retrieval-matrix.sh <data-dir> [limit]}"
LIMIT="${2:-0}"
HERE="$(dirname "$0")"
# LongMemEval's 278 MB of JSON needs the headroom; the others do not care.
NODE=(node --experimental-transform-types --max-old-space-size=10240 "$HERE/retrieval.ts")

run() {
  echo "### $*"
  "${NODE[@]}" --limit "$LIMIT" "$@" 2>&1 | grep -Ev 'ExperimentalWarning|trace-warnings'
  echo
}

# The three suites, as shipped.
run --suite locomo      --dataset "$DATA/locomo10.json"
run --suite perltqa     --dataset "$DATA/perltqa_perltqa_en.json"
run --suite perltqa     --dataset "$DATA/perltqa_perltqa.json"      # the Chinese half
run --suite longmemeval --dataset "$DATA/longmemeval_s.json"

# LongMemEval is the one suite whose evidence sits partly in assistant turns,
# which are evidence-use by author and so never quoted. This is that price.
run --suite longmemeval --dataset "$DATA/longmemeval_s.json" --include-evidence

# What the vector signal is worth: the same run with the embedder unmounted.
run --suite locomo      --dataset "$DATA/locomo10.json" --dimensions 0
