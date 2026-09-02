# -*- coding: utf-8 -*-
"""Score a bench run with the KylinMem dataset's own judge.

`bench/run.ts` produces answers; this feeds them to the dataset's `evaluate.py`
without editing it. Keeping the judge on the dataset's side of the seam is the
point: a memory system that also owns its scoring rule is not being measured.

The dataset's README asks for two sanity checks around every real run — an
oracle that replays the reference answer must score 100%, and a blank system
must score 0%. `--mode` runs either without needing a system under test, so a
number is never reported without the bracket it sits in.

Usage:
  python bench/score.py --answers bench/out/answers-gold-repo.jsonl \
                        --qa bench/out/qa-gold-repo.jsonl \
                        --dataset-dir D:/path/to/kylinmem_dev_batch
  python bench/score.py --mode oracle --qa bench/out/qa-gold-repo.jsonl \
                        --dataset-dir D:/path/to/kylinmem_dev_batch
"""

import argparse
import importlib.util
import json
import os
import sys

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass


def load_judge(dataset_dir):
    """Import the dataset's evaluate.py as a module, from wherever it lives."""
    path = os.path.join(dataset_dir, "evaluate.py")
    if not os.path.isfile(path):
        raise SystemExit("no evaluate.py in %s" % dataset_dir)
    spec = importlib.util.spec_from_file_location("kylin_evaluate", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class FileBackedSystem:
    """A system under test whose answers were produced out of band.

    `evaluate.py` only requires `mode` (for the report label) and
    `get_answer(qa)`, so a file of answers is a complete implementation of its
    plug-in point.
    """

    def __init__(self, mode, answers):
        self.mode = mode
        self.answers = answers

    def get_answer(self, qa):
        return self.answers.get(qa["qa_id"], "")


class ReplaySystem:
    """The dataset's own two reference systems, for the bracket around a run."""

    def __init__(self, mode):
        self.mode = mode

    def get_answer(self, qa):
        return qa["gold_answer"] if self.mode == "oracle" else ""


def read_jsonl(path):
    with open(path, encoding="utf-8") as handle:
        return [json.loads(line) for line in handle if line.strip()]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--qa", required=True, help="question file written by bench/run.ts")
    parser.add_argument("--answers", help="answer file written by bench/run.ts; omit with --mode")
    parser.add_argument("--dataset-dir", required=True, help="directory holding the dataset's evaluate.py")
    parser.add_argument("--mode", choices=["system", "oracle", "blank"], default="system")
    parser.add_argument("--out", help="where to write the score report (default: beside --qa)")
    args = parser.parse_args()

    judge = load_judge(args.dataset_dir)
    qa_items = read_jsonl(args.qa)

    if args.mode == "system":
        if not args.answers:
            raise SystemExit("--answers is required unless --mode is oracle or blank")
        answers = {row["qa_id"]: row.get("answer", "") for row in read_jsonl(args.answers)}
        missing = [qa["qa_id"] for qa in qa_items if qa["qa_id"] not in answers]
        if missing:
            print("警告: %d 道题没有答案, 按空串计分 (例: %s)" % (len(missing), missing[0]))
        system = FileBackedSystem("dsh-advanced-mem-plugin", answers)
    else:
        system = ReplaySystem(args.mode)

    report = judge.evaluate(qa_items, system)
    report["note"] = "judged by the dataset's evaluate.py; answers produced by bench/run.ts"

    out = args.out or os.path.join(
        os.path.dirname(os.path.abspath(args.qa)), "score-%s.json" % system.mode)
    with open(out, "w", encoding="utf-8") as handle:
        json.dump(report, handle, ensure_ascii=False, indent=2)

    print("系统: %s | 题数: %d | 通过: %d | 准确率: %.1f%%"
          % (report["system_under_test"], report["total"], report["passed"], report["accuracy"] * 100))
    print("按维度: %s" % {k: "%.1f%%" % (v["accuracy"] * 100) for k, v in report["by_dimension"].items()})
    print("报告: %s" % out)

    # Counts, not the reported accuracy: evaluate.py rounds to three decimals, so
    # 9120/9124 prints as 100.0% and a rounding artefact would pass for a check.
    if args.mode == "oracle" and report["passed"] < report["total"]:
        raise SystemExit("oracle 未达 100%% (%d/%d): 判分规则失效, 本轮成绩不可信"
                         % (report["passed"], report["total"]))
    if args.mode == "blank" and report["passed"] > 0:
        raise SystemExit("blank 高于 0%% (%d/%d): 关键词泄漏进题面, 本轮成绩不可信"
                         % (report["passed"], report["total"]))


if __name__ == "__main__":
    main()
