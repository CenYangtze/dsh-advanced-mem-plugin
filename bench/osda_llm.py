#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""OSDA-Mem reader: turn a context dump into the dataset's submission format.

    python bench/osda_llm.py --dump ctx-memory.jsonl --out sub-memory.jsonl --label memory

The reader answers strictly from the supplied context and must emit a JSON
object. Scoring is then the dataset's own `tools/evaluate_predictions.py`, so the
number reported is theirs; nothing here interprets correctness.
"""
import argparse, concurrent.futures as cf, io, json, os, re, ssl, sys, time, urllib.request

BASE = os.environ.get("OPENAI_BASE_URL", "").rstrip("/")
KEY = os.environ.get("OPENAI_API_KEY", "")
MODEL = os.environ.get("QA_MODEL", "alibaba/qwen3.5-27b")


def _tls():
    """Some msys2 Pythons ship a zero-byte default CA file; find a usable bundle."""
    for path in [os.environ.get("SSL_CERT_FILE", ""),
                 "C:/msys64/usr/ssl/certs/ca-bundle.crt",
                 "C:/Program Files/Git/mingw64/etc/ssl/certs/ca-bundle.crt",
                 "/etc/ssl/certs/ca-certificates.crt"]:
        if path and os.path.exists(path) and os.path.getsize(path) > 0:
            try:
                return ssl.create_default_context(cafile=path)
            except Exception:  # noqa: BLE001
                continue
    return ssl.create_default_context()


TLS = _tls()

PROMPT = """You are an OS agent answering from your memory of past events.

Answer ONLY from the events below. Output a single JSON object and nothing else
-- no prose, no markdown fence. Use exactly the field names that appear in the
events themselves (for example the keys inside `input=` / `output=` /
`state_after=`). Numbers must be numbers, not strings.

If an event records that something was forgotten or superseded, respect it: do
not repeat forgotten content, and answer with the current version.

Remembered events:
{context}

Task: {instruction}
Answer format: {answer_format}
{schema}JSON:"""


def chat(prompt, max_tokens=700, retries=4):
    body = json.dumps({"model": MODEL, "messages": [{"role": "user", "content": prompt}],
                       "max_tokens": max_tokens, "temperature": 0}).encode()
    last = None
    for attempt in range(retries):
        try:
            req = urllib.request.Request(
                BASE + "/chat/completions", data=body,
                headers={"Content-Type": "application/json", "Authorization": "Bearer " + KEY})
            with urllib.request.urlopen(req, timeout=240, context=TLS) as r:
                return (json.loads(r.read().decode())["choices"][0]["message"].get("content") or "").strip()
        except Exception as e:  # noqa: BLE001
            last = e
            time.sleep(1.5 * (2 ** attempt))
    return "__ERROR__ %s" % last


def parse_json(text):
    """Pull the first JSON object out of a reply; {} when there isn't one."""
    if text.startswith("__ERROR__"):
        return {}
    fence = re.search(r"```(?:json)?\s*(.+?)```", text, re.S)
    if fence:
        text = fence.group(1).strip()
    start = text.find("{")
    if start < 0:
        return {}
    depth, in_str, esc = 0, False, False
    for i in range(start, len(text)):
        c = text[i]
        if in_str:
            if esc:
                esc = False
            elif c == "\\":
                esc = True
            elif c == '"':
                in_str = False
            continue
        if c == '"':
            in_str = True
        elif c == "{":
            depth += 1
        elif c == "}":
            depth -= 1
            if depth == 0:
                try:
                    return json.loads(text[start:i + 1])
                except json.JSONDecodeError:
                    return {}
    return {}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dump", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--label", required=True)
    ap.add_argument("--workers", type=int, default=12)
    ap.add_argument("--schema-from", dest="schema_from", default="",
                    help="dataset data/ dir; supplies the OUTPUT KEY NAMES per task type. "
                         "Keys only, never values, and identical for every condition -- it "
                         "separates 'did memory supply the facts' from 'can the reader guess "
                         "the output contract', which the dataset never specifies (its own "
                         "oracle copies `expected` wholesale, so it never exercised a reader).")
    a = ap.parse_args()
    if not BASE or not KEY:
        sys.exit("set OPENAI_BASE_URL and OPENAI_API_KEY")

    rows = [json.loads(l) for l in io.open(a.dump, encoding="utf-8") if l.strip()]

    keys_for = {}
    if a.schema_from:
        def _rd(name):
            return [json.loads(l) for l in
                    io.open(os.path.join(a.schema_from, name), encoding="utf-8") if l.strip()]
        ttype = {t["task_id"]: t["task_type"] for t in _rd("tasks.jsonl")}
        for g in _rd("gold.jsonl"):
            t = ttype.get(g["task_id"])
            if t is None:
                continue
            keys_for.setdefault(t, set()).update(g["expected"].keys())

    def work(row):
        ctx = "\n".join(row["texts"]) if row["texts"] else "(no remembered events)"
        started = time.time()
        keys = sorted(keys_for.get(row.get("task_type", ""), []))
        schema = ("Return exactly these keys: " + ", ".join(keys) + chr(10)) if keys else ""
        reply = chat(PROMPT.format(context=ctx[:50000], instruction=row["instruction"],
                                   answer_format=row.get("answer_format", "JSON object"),
                                   schema=schema))
        return {"task_id": row["task_id"], "task_type": row.get("task_type", "?"),
                "answer": parse_json(reply),
                "retrieved_event_ids": row["retrieved_event_ids"],
                "latency_ms": round(1000 * (time.time() - started), 1),
                "_raw": reply[:400]}

    started = time.time()
    out = []
    with cf.ThreadPoolExecutor(max_workers=a.workers) as pool:
        for n, r in enumerate(pool.map(work, rows), 1):
            out.append(r)
            if n % 50 == 0:
                sys.stderr.write("  %s %d/%d\r" % (a.label, n, len(rows)))
    sys.stderr.write("\n")

    os.makedirs(os.path.dirname(a.out) or ".", exist_ok=True)
    with io.open(a.out, "w", encoding="utf-8", newline="\n") as f:
        for r in out:
            f.write(json.dumps({k: v for k, v in r.items() if k not in ("_raw", "task_type")},
                               ensure_ascii=False, sort_keys=True) + "\n")
    with io.open(a.out.replace(".jsonl", "-raw.jsonl"), "w", encoding="utf-8", newline="\n") as f:
        for r in out:
            f.write(json.dumps(r, ensure_ascii=False) + "\n")

    errors = sum(1 for r in out if r["_raw"].startswith("__ERROR__"))
    empty = sum(1 for r in out if not r["answer"])
    print("%-26s n=%d  empty-answers=%d  api-errors=%d  %.0fs  -> %s"
          % (a.label, len(out), empty, errors, time.time() - started, a.out))


if __name__ == "__main__":
    main()
