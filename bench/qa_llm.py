#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""End-to-end QA over a retrieval dump: a reader answers, a judge scores.

    python bench/qa_llm.py --dump out/ctx-memory.jsonl --dataset longmemeval_s.json \
                           --label memory --out out/qa

Reads OPENAI_BASE_URL / OPENAI_API_KEY / QA_MODEL from the environment; nothing
is written to disk that contains the key.

The reader sees only the retrieved context, so this measures the retrieval
condition and not the model's parametric knowledge. The judge is the same model
asked a yes/no equivalence question against the dataset's reference answer -- the
protocol LongMemEval uses, with a weaker judge than its GPT-4o. Judge agreement
with an oracle and a blank run is printed so the judge itself can be checked
before any number from it is believed.
"""
import argparse, concurrent.futures as cf, io, json, os, re, ssl, sys, time, urllib.request


def _tls():
    """An SSL context that can actually verify the gateway.

    Some msys2 Python installs ship a zero-byte `cert.pem` as their default
    CA file, so every HTTPS call fails verification while curl and Node -- which
    read a different bundle -- succeed. Rather than turn verification off, walk
    the bundles that are actually on the box and use the first usable one.
    """
    candidates = [os.environ.get("SSL_CERT_FILE", "")] + [
        "C:/msys64/usr/ssl/certs/ca-bundle.crt",
        "C:/Program Files/Git/mingw64/etc/ssl/certs/ca-bundle.crt",
        "/etc/ssl/certs/ca-certificates.crt",
    ]
    for path in candidates:
        if not path or not os.path.exists(path) or os.path.getsize(path) == 0:
            continue
        try:
            return ssl.create_default_context(cafile=path)
        except Exception:  # noqa: BLE001 - a malformed bundle is just the next candidate
            continue
    return ssl.create_default_context()


TLS = _tls()

BASE = os.environ.get("OPENAI_BASE_URL", "").rstrip("/")
KEY = os.environ.get("OPENAI_API_KEY", "")
MODEL = os.environ.get("QA_MODEL", "alibaba/qwen3.5-27b")

READER = (
    "You answer strictly from the supplied context. If the context does not "
    "contain the answer, reply exactly: NOT IN CONTEXT.\n"
    "Answer in as few words as possible -- a name, a date, a number, a short "
    "phrase. No explanation, no full sentence.\n\n"
    "Context:\n{context}\n\nQuestion: {question}\nAnswer:"
)

JUDGE = (
    "You grade a predicted answer against a reference answer for one question.\n"
    "Reply with exactly one word: YES if the prediction conveys the same "
    "information as the reference, NO otherwise. Ignore differences in wording, "
    "formatting, verbosity, and date format. A prediction that says the answer "
    "is absent is NO unless the reference also says so.\n\n"
    "Question: {question}\nReference: {reference}\nPrediction: {prediction}\nVerdict:"
)


def chat(prompt, max_tokens=256, retries=4):
    """One completion, retried on transient failure."""
    body = json.dumps({
        "model": MODEL,
        "messages": [{"role": "user", "content": prompt}],
        "max_tokens": max_tokens,
        "temperature": 0,
    }).encode()
    last = None
    for attempt in range(retries):
        try:
            req = urllib.request.Request(
                BASE + "/chat/completions", data=body,
                headers={"Content-Type": "application/json", "Authorization": "Bearer " + KEY})
            with urllib.request.urlopen(req, timeout=240, context=TLS) as r:
                d = json.loads(r.read().decode())
            return (d["choices"][0]["message"].get("content") or "").strip()
        except Exception as e:  # noqa: BLE001 - any transport failure is retryable
            last = e
            time.sleep(1.5 * (2 ** attempt))
    return "__ERROR__ %s" % last


def load_reference(path):
    """question_id -> (question, reference answer, type) from LongMemEval."""
    with io.open(path, encoding="utf-8") as f:
        rows = json.load(f)
    return {r["question_id"]: (r["question"], str(r["answer"]), r.get("question_type", "?"))
            for r in rows}


def oracle_context(path):
    """question_id -> the gold-flagged turns only. The retrieval ceiling."""
    with io.open(path, encoding="utf-8") as f:
        rows = json.load(f)
    out = {}
    for r in rows:
        texts = []
        for session in r.get("haystack_sessions", []):
            for turn in session:
                if str(turn.get("has_answer", "")).lower() == "true":
                    texts.append("%s: %s" % (turn.get("role", "?"), turn.get("content", "")))
        out[r["question_id"]] = texts
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dump", help="JSONL from retrieval.ts --dump-retrieved")
    ap.add_argument("--dataset", required=True)
    ap.add_argument("--label", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--ids-from", dest="ids_from", default="",
                    help="restrict to the question ids in this dump, so conditions compare on one set")
    ap.add_argument("--workers", type=int, default=12)
    ap.add_argument("--context", choices=["dump", "oracle", "none"], default="dump")
    a = ap.parse_args()

    if not BASE or not KEY:
        sys.exit("set OPENAI_BASE_URL and OPENAI_API_KEY")

    ref = load_reference(a.dataset)
    if a.context == "dump":
        items = []
        with io.open(a.dump, encoding="utf-8") as f:
            for line in f:
                if line.strip():
                    items.append(json.loads(line))
        ctx = {r["task"]: r["texts"] for r in items}
        groups = {r["task"]: r["group"] for r in items}
    elif a.context == "oracle":
        ctx = oracle_context(a.dataset)
        groups = {k: v[2] for k, v in ref.items()}
    else:
        ctx = {k: [] for k in ref}
        groups = {k: v[2] for k, v in ref.items()}

    ids = [i for i in ctx if i in ref]
    if a.ids_from:
        keep = set()
        with io.open(a.ids_from, encoding="utf-8") as f:
            for line in f:
                if line.strip():
                    keep.add(json.loads(line)["task"])
        ids = [i for i in ids if i in keep]
    ids.sort()
    if a.limit:
        ids = ids[:a.limit]

    def work(qid):
        question, reference, _ = ref[qid]
        joined = "\n---\n".join(ctx[qid]) if ctx[qid] else "(no context available)"
        pred = chat(READER.format(context=joined[:60000], question=question))
        verdict = chat(JUDGE.format(question=question, reference=reference, prediction=pred), 8)
        ok = bool(re.match(r"\s*yes", verdict, re.I))
        return {"qid": qid, "group": groups.get(qid, "?"), "question": question,
                "reference": reference, "prediction": pred, "verdict": verdict, "correct": ok}

    started = time.time()
    rows = []
    with cf.ThreadPoolExecutor(max_workers=a.workers) as pool:
        for n, row in enumerate(pool.map(work, ids), 1):
            rows.append(row)
            if n % 25 == 0:
                acc = sum(r["correct"] for r in rows) / len(rows)
                sys.stderr.write("  %s  %d/%d  running acc %.1f%%\r" % (a.label, n, len(ids), 100 * acc))
    sys.stderr.write("\n")

    errors = sum(1 for r in rows if r["prediction"].startswith("__ERROR__"))
    acc = sum(r["correct"] for r in rows) / max(1, len(rows))
    by = {}
    for r in rows:
        b = by.setdefault(r["group"], [0, 0])
        b[0] += r["correct"]; b[1] += 1

    os.makedirs(a.out, exist_ok=True)
    stem = os.path.join(a.out, "qa-%s" % re.sub(r"\W+", "-", a.label))
    with io.open(stem + ".jsonl", "w", encoding="utf-8") as f:
        for r in rows:
            f.write(json.dumps(r, ensure_ascii=False) + "\n")
    summary = {"label": a.label, "model": MODEL, "context": a.context, "n": len(rows),
               "accuracy": acc, "api_errors": errors, "seconds": round(time.time() - started, 1),
               "by_type": {k: {"n": v[1], "accuracy": v[0] / v[1]} for k, v in sorted(by.items())}}
    with io.open(stem + ".json", "w", encoding="utf-8") as f:
        json.dump(summary, f, ensure_ascii=False, indent=2)

    print("\n%-22s n=%d  accuracy %.1f%%   (api errors %d, %.0fs)"
          % (a.label, len(rows), 100 * acc, errors, summary["seconds"]))
    for k, v in sorted(by.items(), key=lambda kv: -kv[1][1]):
        print("    %-28s n=%-4d %.1f%%" % (k, v[1], 100 * v[0] / v[1]))


if __name__ == "__main__":
    main()
