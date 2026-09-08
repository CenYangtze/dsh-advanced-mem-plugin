# -*- coding: utf-8 -*-
"""Verify every layer of the OSWorld memory ablation before spending hours on it.

This exists because three separate scaffold defects each failed *silently* and
each cost a multi-hour run to discover:

  * the completion signal ```DONE``` was parsed as pyautogui source and executed,
    so the episode never ended;
  * ``PromptAgent.call_llm`` dispatches on the model *name*, so a "gemini" model
    served by an OpenAI-compatible gateway was routed to the Google SDK, returned
    an empty string, and the agent burned its whole step budget doing nothing;
  * ``max_tokens`` was too small for the official prompt's "reflect, then act",
    so replies were truncated mid-fence and parsed to no action at all.

None of the three raised. Each looked exactly like "the model is not good enough".
So: check each layer directly, cheapest first, and refuse to start the run if any
layer is not demonstrably alive.

    python preflight.py --model gemini-3.6-flash --memory-url http://127.0.0.1:8848
"""

from __future__ import annotations

import argparse
import base64
import json
import os
import struct
import sys
import urllib.request
import zlib

OK, BAD = "PASS", "FAIL"
results = []


def check(name, fn):
    """Run one layer check and record its verdict."""
    try:
        detail = fn()
        results.append((OK, name, detail))
    except Exception as exc:  # noqa: BLE001 - a failed check is the point
        results.append((BAD, name, "%s: %s" % (type(exc).__name__, str(exc)[:160])))


def _png(width=64, height=64):
    """A two-colour PNG, for asking a vision model something with a known answer."""
    raw = b"".join(
        b"\x00" + b"".join((b"\xff\x00\x00" if x < width // 2 else b"\x00\x00\xff")
                           for x in range(width))
        for _ in range(height))
    chunk = lambda t, d: (struct.pack(">I", len(d)) + t + d
                          + struct.pack(">I", zlib.crc32(t + d) & 0xFFFFFFFF))
    return (b"\x89PNG\r\n\x1a\n"
            + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(raw)) + chunk(b"IEND", b""))


def post(url, payload, headers, timeout=120):
    req = urllib.request.Request(url, data=json.dumps(payload).encode(), headers=headers)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode())


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", required=True)
    ap.add_argument("--memory-url", default="")
    a = ap.parse_args()

    base = os.environ.get("OPENAI_BASE_URL", "").rstrip("/")
    key = os.environ.get("OPENAI_API_KEY", "")
    url = base + "/chat/completions" if base.endswith("/v1") else base + "/v1/chat/completions"
    head = {"Content-Type": "application/json", "Authorization": "Bearer " + key}

    # --- L1 the gateway serves this model at all -----------------------------
    def l1():
        if not base or not key:
            raise RuntimeError("OPENAI_BASE_URL / OPENAI_API_KEY not set")
        d = post(url, {"model": a.model, "max_tokens": 2000, "temperature": 0,
                       "messages": [{"role": "user", "content": "Reply with exactly: OK"}]}, head)
        text = (d["choices"][0]["message"].get("content") or "").strip()
        if not text:
            raise RuntimeError("empty completion")
        return "served=%s reply=%r" % (d.get("model"), text[:20])
    check("L1 gateway serves the model", l1)

    # --- L2 it can see, which the whole task depends on ----------------------
    def l2():
        b64 = base64.b64encode(_png()).decode()
        d = post(url, {"model": a.model, "max_tokens": 2000, "temperature": 0, "messages": [
            {"role": "user", "content": [
                {"type": "text", "text": "Two words: the left colour then the right colour."},
                {"type": "image_url", "image_url": {"url": "data:image/png;base64," + b64}}]}]}, head)
        text = (d["choices"][0]["message"].get("content") or "").strip().lower()
        if "red" not in text or "blue" not in text:
            raise RuntimeError("vision wrong: %r" % text[:60])
        return repr(text[:30])
    check("L2 model has working vision", l2)

    # --- L3 the agent's own call path, not a hand-rolled request -------------
    def l3():
        sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
        from mm_agents.memory_agent import MemoryPromptAgent
        agent = MemoryPromptAgent(model=a.model, action_space="pyautogui",
                                  observation_type="screenshot_a11y_tree",
                                  max_tokens=4000, temperature=0.0)
        text = agent.call_llm({"messages": [{"role": "user", "content": "Reply with exactly: OK"}]})
        if not text:
            raise RuntimeError("agent.call_llm returned empty -- name-based routing again?")
        return "call_llm -> %r" % text[:20]
    check("L3 agent.call_llm reaches the gateway", l3)

    # --- L4 the completion convention survives the parser --------------------
    def l4():
        sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
        from mm_agents.agent import parse_code_from_string
        for fenced in ("```DONE```", "```\nDONE\n```"):
            got = parse_code_from_string(fenced)
            if "DONE" not in got:
                raise RuntimeError("parser lost DONE in %r -> %r" % (fenced, got))
        return "fenced DONE survives parsing"
    check("L4 DONE signal survives the parser", l4)

    # --- L5 the memory seam round-trips --------------------------------------
    def l5():
        if not a.memory_url:
            return "skipped (no --memory-url)"
        mem = a.memory_url.rstrip("/")
        post(mem + "/reset", {}, {"Content-Type": "application/json"}, 30)
        probe = "In LibreOffice Calc a new sheet is inserted from the tab strip at the bottom left."
        post(mem + "/remember", {"id": "preflight", "text": probe},
             {"Content-Type": "application/json"}, 30)
        cues = post(mem + "/recall", {"text": "how do I add a sheet in Calc"},
                    {"Content-Type": "application/json"}, 30).get("cues", [])
        if not cues or "tab strip" not in cues[0]:
            raise RuntimeError("recall did not return what was just written: %r" % cues[:1])
        post(mem + "/reset", {}, {"Content-Type": "application/json"}, 30)
        return "remember -> recall round-trip verified, store reset"
    check("L5 memory bridge round-trips", l5)

    # --- L6 the container runtime the env needs ------------------------------
    def l6():
        import subprocess
        out = subprocess.run(["docker", "info", "--format", "{{.ServerVersion}}"],
                             capture_output=True, text=True, timeout=60)
        if out.returncode != 0 or not out.stdout.strip():
            raise RuntimeError("docker daemon not reachable")
        if not os.path.exists("/dev/kvm"):
            raise RuntimeError("/dev/kvm missing -- nested virtualisation unavailable")
        return "docker %s, /dev/kvm present" % out.stdout.strip()
    check("L6 docker + KVM available", l6)

    width = max(len(n) for _, n, _ in results)
    for status, name, detail in results:
        print("[%s] %-*s  %s" % (status, width, name, detail))
    failed = [n for s, n, _ in results if s == BAD]
    print("\n%d/%d layers alive." % (len(results) - len(failed), len(results)))
    if failed:
        print("REFUSING TO RUN. Fix: " + ", ".join(failed))
        return 1
    print("All layers alive - safe to start the ablation.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
