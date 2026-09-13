# -*- coding: utf-8 -*-
"""KYLIN office-memory benchmark: does the plugin's memory make the new task solvable?

Each item is a spreadsheet workspace, a dated history of past sessions with the
user, and a new request that only makes sense if you remember those sessions
("apply the current ranking - you know which way it runs now"). Scoring is by
cell: every check names an A1 range and passes when the model's final table
matches the expected one there.

Three arms, same model, same prompt, same output format:

    none     task + workspace only            -> what the request alone buys
    memory   history ingested into the Advanced Memory plugin through the HTTP
             bridge, cues recalled for the request, folded into the prompt
    full     the whole history pasted into the prompt -> the oracle ceiling,
             which also exposes checks that no amount of memory can pass

    OPENAI_BASE_URL=... OPENAI_API_KEY=... \
    python bench/kylin.py --data <dir> --memory-url http://127.0.0.1:8848 \
        --arms none,memory,full --out bench/out/kylin.json
"""

from __future__ import annotations

import argparse
import concurrent.futures as futures
import datetime as dt
import glob
import json
import os
import re
import sys
import threading
import time
import urllib.request

# ------------------------------------------------------------------ transport


def post(url, payload, timeout=60):
    req = urllib.request.Request(url, data=json.dumps(payload).encode(),
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode())


def chat(model, messages, max_tokens=4000):
    base = os.environ["OPENAI_BASE_URL"].rstrip("/")
    url = base + "/chat/completions" if base.endswith("/v1") else base + "/v1/chat/completions"
    body = json.dumps({"model": model, "messages": messages, "max_tokens": max_tokens,
                       "temperature": 0}).encode()
    last = None
    for attempt in range(4):
        try:
            req = urllib.request.Request(url, data=body, headers={
                "Content-Type": "application/json",
                "Authorization": "Bearer " + os.environ["OPENAI_API_KEY"]})
            with urllib.request.urlopen(req, timeout=300) as r:
                d = json.loads(r.read().decode())
            return (d["choices"][0]["message"].get("content") or "").strip()
        except Exception as exc:  # noqa: BLE001
            last = exc
            time.sleep(2 ** attempt)
    raise RuntimeError("llm failed: %s" % last)

# ------------------------------------------------------------------ scoring


def col_index(letters):
    n = 0
    for ch in letters:
        n = n * 26 + (ord(ch.upper()) - 64)
    return n - 1


def cells_of(spec):
    """Expand 'B2,B5' / 'C2:C6' / 'B1' into (row, col) zero-based pairs."""
    out = []
    for part in spec.split(","):
        part = part.strip()
        if ":" in part:
            a, b = part.split(":")
        else:
            a = b = part
        ma, mb = re.match(r"([A-Z]+)(\d+)", a), re.match(r"([A-Z]+)(\d+)", b)
        for row in range(int(ma.group(2)), int(mb.group(2)) + 1):
            for col in range(col_index(ma.group(1)), col_index(mb.group(1)) + 1):
                out.append((row - 1, col))
    return out


def norm(value, mode):
    text = "" if value is None else str(value)
    if mode == "str_strip":
        text = text.strip()
    return text


def cell(rows, r, c):
    if r < len(rows) and c < len(rows[r]):
        return rows[r][c]
    return None


def score(item, predicted):
    """@returns (passed, total, per-check list)."""
    mode = item.get("normalize", "str_strip")
    per = []
    for fname, checks in item["checks"].items():
        exp = item["expected"][fname]
        got = predicted.get(fname) or []
        for chk in checks:
            ok = all(norm(cell(got, r, c), mode) == norm(cell(exp, r, c), mode)
                     for r, c in cells_of(chk["cells"]))
            per.append({"id": chk["id"], "file": fname, "cells": chk["cells"],
                        "facts": chk.get("facts", []), "pass": ok})
    return sum(p["pass"] for p in per), len(per), per

# ------------------------------------------------------------------ prompting

OUTPUT_RULES = """
Return the FINAL contents of every workspace file after carrying out the request,
as one JSON object and nothing else:
{"<file name>": [[header cells...], [row cells...], ...], ...}
Every cell is a string. Keep existing rows and columns unless the request or a
remembered rule says otherwise. When the request adds several columns, add them
in the order the request lists them. If a value is unknown, leave the cell "".
Do not add commentary before or after the JSON."""


def workspace_block(item):
    return "\n".join("%s:\n%s" % (fn, json.dumps(rows, ensure_ascii=False))
                     for fn, rows in item["workspace"].items())


def event_text(session, event):
    stamp = event.get("t") or session.get("date", "")
    return "[%s] %s: %s" % (stamp[:16].replace("T", " "), event["role"], event["text"])


def build_messages(item, arm, cues):
    system = item["system"].replace("{task}", item["task"])
    parts = ["Current workspace files (rows as JSON arrays):", workspace_block(item)]
    if arm == "memory":
        if cues:
            parts.append("\nWhat memory recalled from earlier sessions (dated; when two "
                         "conflict, the later one is the decision that stands):")
            parts.extend("- " + c.replace("\n", " ") for c in cues)
        else:
            parts.append("\nMemory recalled nothing for this request.")
    elif arm == "full":
        parts.append("\nComplete transcript of earlier sessions:")
        for session in item["history"]:
            for ev in session["events"]:
                parts.append(event_text(session, ev))
    parts.append(OUTPUT_RULES)
    return [{"role": "system", "content": system},
            {"role": "user", "content": "\n".join(parts)}]


def parse_table(reply):
    text = reply.strip()
    fence = re.search(r"```(?:json)?\s*(\{.*\})\s*```", text, re.S)
    if fence:
        text = fence.group(1)
    else:
        start, end = text.find("{"), text.rfind("}")
        if start >= 0 and end > start:
            text = text[start:end + 1]
    try:
        data = json.loads(text)
    except Exception:  # noqa: BLE001
        return {}
    return {k: v for k, v in data.items() if isinstance(v, list)}

# ------------------------------------------------------------------ memory arm


def recall_queries(item):
    """The request as a whole, then each numbered line, then the file itself."""
    task = item["task"]
    out = [task]
    for line in task.splitlines():
        m = re.match(r"\s*\d+[.)]\s*(.+)", line)
        if m:
            out.append(m.group(1).strip())
    out.extend(item["workspace"].keys())
    return out


def memory_cues(item, mem, limit, single=False, stamp=False):
    """Ingest the history, then recall; the store is reset per item."""
    post(mem + "/reset", {})
    turn = 0
    for session in item["history"]:
        for ev in session["events"]:
            turn += 1
            stamp = ev.get("t") or session.get("date", "")
            try:
                # Naive dataset clock -> UTC, so the bridge's stamp reads back
                # as the same wall time the dataset wrote.
                at = int(dt.datetime.fromisoformat(stamp).replace(tzinfo=dt.timezone.utc).timestamp() * 1000)
            except ValueError:
                at = None
            # Raw words only: the bridge stamps date and role on the way out, so
            # what the runtime indexes is what was said, not a log line.
            body = {"id": "%s-%d" % (item["id"], turn),
                    "text": event_text(session, ev) if stamp else ev["text"],
                    "kind": "user-message" if ev["role"] == "user" else "assistant-message",
                    "session": session["session"]}
            if at is not None:
                body["at"] = at
            post(mem + "/remember", body)
    seen, cues = set(), []
    for q in ([item["task"]] if single else recall_queries(item)):
        for text in post(mem + "/recall", {"text": q}).get("cues", []):
            if text not in seen:
                seen.add(text)
                cues.append(text)
    # Present in time order: the prompt tells the model the later decision wins,
    # and that is only checkable if it can see which one is later.
    def when(cue):
        """The record's own stamp: the reply line of an anchored cue, not the question's."""
        lines = [l.strip() for l in cue.split(chr(10))]
        own = [l for l in lines if l.startswith("-> ")] or [lines[0]]
        return own[0].lstrip("-> ")[:17]
    cues.sort(key=when)
    return cues[:limit]

# ------------------------------------------------------------------ main


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", required=True)
    ap.add_argument("--memory-url", default="http://127.0.0.1:8848")
    ap.add_argument("--arms", default="none,memory,full")
    ap.add_argument("--model", default=os.environ.get("QA_MODEL", "alibaba/qwen3.5-27b"))
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--cue-limit", type=int, default=16)
    ap.add_argument("--strip-marks", action="store_true",
                    help="drop the bridge's '(later corrected)' marks, to price them")
    ap.add_argument("--stamp-on-ingest", action="store_true",
                    help="write '[date] role: ' into the stored text, for a bridge that "
                         "does not stamp cues itself")
    ap.add_argument("--single-query", action="store_true",
                    help="ask memory once with the whole request, as an agent that does "
                         "not decompose would; prices the runtime's own cue splitting")
    ap.add_argument("--workers", type=int, default=6)
    ap.add_argument("--out", required=True)
    a = ap.parse_args()

    files = sorted(glob.glob(os.path.join(a.data, "KYLIN-*.json")))
    if a.limit:
        files = files[:a.limit]
    items = [json.load(open(f, encoding="utf-8")) for f in files]
    arms = a.arms.split(",")
    mem = a.memory_url.rstrip("/")
    lock = threading.Lock()  # the bridge holds one store; ingest+recall is one critical section

    def run_one(item, arm):
        cues = []
        if arm == "memory":
            with lock:
                cues = memory_cues(item, mem, a.cue_limit, a.single_query, a.stamp_on_ingest)
            if a.strip_marks:
                cues = [c.replace(" (later corrected)", "") for c in cues]
        reply = chat(a.model, build_messages(item, arm, cues))
        table = parse_table(reply)
        passed, total, per = score(item, table)
        return {"id": item["id"], "arm": arm, "passed": passed, "total": total,
                "checks": per, "cues": cues, "parsed": bool(table),
                "predicted": table, "reply": reply[:4000]}

    results = []
    jobs = [(item, arm) for item in items for arm in arms]
    started = time.time()
    with futures.ThreadPoolExecutor(max_workers=a.workers) as pool:
        futs = {pool.submit(run_one, item, arm): (item["id"], arm) for item, arm in jobs}
        for n, fut in enumerate(futures.as_completed(futs), 1):
            iid, arm = futs[fut]
            try:
                row = fut.result()
            except Exception as exc:  # noqa: BLE001
                row = {"id": iid, "arm": arm, "error": str(exc)[:200], "passed": 0, "total": 0}
            results.append(row)
            if n % 10 == 0 or n == len(jobs):
                done = {}
                for r in results:
                    d = done.setdefault(r["arm"], [0, 0, 0])
                    d[0] += r["passed"]; d[1] += r["total"]; d[2] += 1
                sys.stderr.write("%4d/%d %5.0fs  " % (n, len(jobs), time.time() - started)
                                 + "  ".join("%s %d/%d (%d items)" % (k, v[0], v[1], v[2])
                                             for k, v in sorted(done.items())) + "\n")
                with open(a.out, "w", encoding="utf-8") as f:
                    json.dump({"model": a.model, "arms": arms, "results": results}, f,
                              ensure_ascii=False, indent=1)

    with open(a.out, "w", encoding="utf-8") as f:
        json.dump({"model": a.model, "arms": arms, "results": results}, f,
                  ensure_ascii=False, indent=1)


if __name__ == "__main__":
    main()
