# -*- coding: utf-8 -*-
"""Iterate on the memory *write* path offline, against trajectories already run.

The v1 memory arm scored 1/15 against a 4/15 no-memory baseline, and the cause
was in what got written, not in retrieval: 14 of 15 stored lessons were distilled
from failed attempts, and 5 of the 6 cues recalled for a typical task were
prohibitions ("avoid hardcoded pixel coordinates; use keyboard shortcuts"). That
advice is wrong under this scaffold -- the agent is handed an accessibility tree
with exact coordinates, so clicking is the reliable route -- and it measurably
pushed the agent off working paths (task 12: 2 steps and done without memory,
15 steps and capped with it).

Fixing that by rerunning the whole ablation costs two hours per attempt. The
trajectories are already on disk in the run log, so the write path can be
rebuilt and inspected in a couple of minutes instead: replay the logged
trajectories through a candidate distiller, then show, for every task, exactly
which cues that task *would* have been given.

    python distil_lab.py --log flog-none.txt --results f-none.json --variant v2
"""

from __future__ import annotations

import argparse
import json
import os
import re
import urllib.request

# --------------------------------------------------------------------- prompts

V1 = """You are keeping notes for an agent that operates a Linux desktop.
Below is one attempt at a task and whether it succeeded.

Application: {domain}
Task: {instruction}
Outcome: {outcome}
Actions attempted:
{trace}

Write at most 3 short bullet lines of knowledge that would help on a DIFFERENT
task in the same application. Record where controls live, which menu or keyboard
route works, what dialogs appear and what they demand. If the attempt failed, say
what to avoid and what to try instead.

Never write pixel coordinates - they are worthless on another screen.
If nothing generalises, reply with exactly: NOTHING"""

V2 = """You are recording interface facts about {domain} for a colleague who will
work on a DIFFERENT task in the same application.

Task that was attempted: {instruction}
Outcome: {outcome}
Actions taken:
{trace}

Write at most 3 short bullet lines. Each line must be a FACT ABOUT THE
APPLICATION that you can see in the actions above -- a menu path, the name of a
dialog and the fields it asks for, a formula and what it does, where a control
lives.

Hard rules:
- Record only what the actions above actually show. Do not infer, guess, or
  theorise about why something did or did not work.
- Write NOTHING about how to operate the computer: no advice about clicking
  versus keyboard versus menus, no advice about coordinates. How to point at a
  control is decided by tooling your colleague has and you do not, so a note
  about it is worse than no note.
- Never write "avoid", "do not", "instead of", or any other prohibition. Only
  state what a thing IS or WHERE it is.
- If the attempt failed, you may still record interface facts that were visible,
  but say nothing about the failure itself.

If the actions show no reusable interface fact, reply with exactly: NOTHING"""

VARIANTS = {"v1": V1, "v2": V2, "v3": V2}

# ------------------------------------------------------------------ write gate

COORD = re.compile(r"\(\s*\d{2,4}\s*,\s*\d{2,4}\s*\)")
PROHIBIT = re.compile(r"avoid|do not|don't|instead of|never", re.I)


def sanitize_trace(calls):
    """Show the distiller what was done, never where it was clicked.

    v2 still leaked coordinates into stored lessons -- including the two clicks
    this harness itself injects to dismiss LibreOffice's notification banners,
    which the distiller faithfully recorded as "interactive elements located at
    (1847, 266)". Asking a model not to write something it can see is unreliable;
    removing it from what the model sees is not. Everything semantic -- the key
    pressed, the text typed, the formula entered -- survives.
    """
    out = []
    for call in calls:
        out.append(COORD.sub("(<x>, <y>)", call))
    return out


def validate_lesson(text):
    """Refuse to store a lesson that is unusable or actively misleading.

    Three failure modes were observed offline and each one poisons every later
    task that recalls it: coordinates (meaningless on another screen state),
    prohibitions (the v1 regression: "avoid pixel coordinates, use keyboard
    shortcuts" pushed the agent off the route that worked), and degenerate
    multilingual token salad from the distiller itself. A memory system that
    writes whatever a model returns has no way to recover from any of them.
    @returns a reason string when the lesson must be rejected, else "".
    """
    if not text or text.strip().upper().startswith("NOTHING"):
        return "empty"
    if text.startswith("ERROR "):
        return "distiller error"
    if COORD.search(text):
        return "contains coordinates"
    if PROHIBIT.search(text):
        return "contains a prohibition"
    letters = [c for c in text if c.isalpha()]
    if letters:
        ascii_ratio = sum(c.isascii() for c in letters) / len(letters)
        if ascii_ratio < 0.9:
            return "degenerate output (%.0f%% ascii)" % (100 * ascii_ratio)
    words = re.findall(r"[A-Za-z']+", text)
    if len(words) < 8:
        return "too short to carry a fact"
    return ""

# ------------------------------------------------------------------ extraction


def split_trajectories(log_path, n_tasks):
    """Recover one action trace per task from a run log.

    The runner prints a "[k/N] <id> :: <instruction>" banner before each task and
    the official agent logs every model reply, so the log is a complete record of
    what each task did -- which is what makes offline iteration possible at all.
    """
    text = open(log_path, encoding="utf-8", errors="replace").read()
    banners = list(re.finditer(r"INFO ablation: \[(\d+)/(\d+)\] (\S+) :: ", text))
    traces = {}
    for i, match in enumerate(banners):
        index = int(match.group(1))
        start = match.end()
        end = banners[i + 1].start() if i + 1 < len(banners) else len(text)
        body = text[start:end]
        calls = re.findall(r"pyautogui\.\w+\([^)]*\)", body)
        seen, ordered = set(), []
        for call in calls:
            if call in seen:
                continue
            seen.add(call)
            ordered.append(call)
        traces[index] = ordered[:16]
    return traces


def distil(prompt, base, key, model):
    body = json.dumps({"model": model, "max_tokens": 1200, "temperature": 0,
                       "messages": [{"role": "user", "content": prompt}]}).encode()
    url = base + "/chat/completions" if base.endswith("/v1") else base + "/v1/chat/completions"
    req = urllib.request.Request(url, data=body, headers={
        "Content-Type": "application/json", "Authorization": "Bearer " + key})
    with urllib.request.urlopen(req, timeout=240) as r:
        return (json.loads(r.read().decode())["choices"][0]["message"].get("content") or "").strip()


BANNED = re.compile(r"\bavoid\b|\bdo not\b|\bdon't\b|\binstead of\b|\bnever\b|"
                    r"coordinate|pixel|keyboard shortcut", re.I)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--log", required=True)
    ap.add_argument("--results", required=True)
    ap.add_argument("--variant", default="v2", choices=sorted(VARIANTS))
    ap.add_argument("--model", default="alibaba/qwen3.5-27b")
    ap.add_argument("--out", default="")
    a = ap.parse_args()

    base = os.environ["OPENAI_BASE_URL"].rstrip("/")
    key = os.environ["OPENAI_API_KEY"]
    results = json.load(open(a.results, encoding="utf-8"))["results"]
    domain = json.load(open(a.results, encoding="utf-8"))["domain"]
    traces = split_trajectories(a.log, len(results))

    lessons = []
    flagged = 0
    for index, row in enumerate(results, 1):
        trace = "\n".join(traces.get(index, [])) or "(no actions recorded)"
        prompt = VARIANTS[a.variant].format(
            domain=domain, instruction=row["instruction"],
            outcome="SUCCEEDED" if row["success"] else "FAILED", trace=trace)
        try:
            text = distil(prompt, base, key, a.model)
        except Exception as exc:  # noqa: BLE001
            text = "ERROR %s" % str(exc)[:80]
        reject = validate_lesson(text) if a.variant == "v3" else ""
        bad = bool(BANNED.search(text))
        flagged += bad
        lessons.append({"task": index, "success": row["success"], "lesson": text,
                        "has_banned_advice": bad, "rejected": reject})
        tag = "  <<< REJECTED: " + reject if reject else ("  <<< BANNED PHRASING" if bad else "")
        print("--- task %02d [%s]%s" % (index, "OK  " if row["success"] else "fail", tag))
        if reject:
            continue
        for line in text.splitlines():
            if line.strip():
                print("    " + line.strip()[:118])

    print("\n%s: %d lessons, %d contain banned advice (prohibitions / action-space)"
          % (a.variant, len(lessons), flagged))
    verified = sum(1 for l in lessons if l["success"] and l["lesson"] != "NOTHING")
    print("%d of them come from a verified success" % verified)
    if a.out:
        json.dump(lessons, open(a.out, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
        print("written %s" % a.out)


if __name__ == "__main__":
    main()
