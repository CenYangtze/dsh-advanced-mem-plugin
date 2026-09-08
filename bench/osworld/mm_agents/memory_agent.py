# -*- coding: utf-8 -*-
"""OSWorld's own PromptAgent, with the Advanced Memory plugin bolted onto it.

Why a subclass rather than a hand-written agent
-----------------------------------------------
The first version of this file was an agent I wrote from scratch, and it scored
0/33 with *zero* DONE signals across two step budgets. That number was the tell:
models are usually over-eager to declare completion, so never declaring it once
in 33 tasks is a scaffold defect, not a capability ceiling. Three defects, in
descending order of damage:

  1. OSWorld's completion convention is ```DONE``` -- fenced. The old parser
     tested ``reply.startswith("DONE")``, which never matched, and then the
     code-block regex happily extracted ``DONE`` and fed it to ``env.step`` as
     pyautogui source. The agent was very likely signalling completion the whole
     time and the harness was eating it.
  2. History was appended as consecutive ``assistant`` messages with no ``user``
     message between them, so the model never saw the *result* of its actions --
     only the latest screenshot and its own past prose.
  3. It ran on pixels alone; the official default observation is
     ``screenshot_a11y_tree``, where the accessibility tree names the widgets
     instead of making the model guess coordinates.

So the baseline arm is now the published scaffold, unmodified. The memory arm is
that same scaffold plus one seam: cues recalled before the task go into the
system message, and a distilled lesson goes back after it.
"""

from __future__ import annotations

import json
import logging
import re
import os
import time
import urllib.request

from mm_agents.agent import PromptAgent

logger = logging.getLogger("desktopenv.agent")

DISTIL = """You are recording interface facts about {domain} for a colleague who
will work on a DIFFERENT task in the same application.

Task that was attempted: {instruction}
Outcome: {outcome}
Actions taken:
{trace}

Write at most 3 short bullet lines. Each line must be a FACT ABOUT THE
APPLICATION that the actions above actually show -- a menu path, the name of a
dialog and the fields it asks for, a formula and what it does, where a control
lives.

Hard rules:
- Record only what the actions show. Do not infer, guess, or theorise about why
  something did or did not work.
- Write NOTHING about how to operate the computer: no advice about clicking
  versus keyboard versus menus, no advice about coordinates. How to point at a
  control is decided by tooling your colleague has and you do not, so a note
  about it is worse than no note.
- Never write "avoid", "do not", "instead of", or any other prohibition. State
  only what a thing IS or WHERE it is.
- If the attempt failed, you may still record interface facts that were visible,
  but say nothing about the failure itself.

If the actions show no reusable interface fact, reply with exactly: NOTHING"""

COORD = re.compile(r"\(\s*\d{2,4}\s*,\s*\d{2,4}\s*\)")
PROHIBIT = re.compile(r"\bavoid\b|\bdo not\b|\bdon't\b|\binstead of\b|\bnever\b", re.I)


def sanitize_trace(actions):
    """Show the distiller what was done, never where it was clicked.

    Asking a model not to write something it can see is unreliable -- v2 still
    recorded "interactive elements located at (1847, 266)", which were this
    harness's own banner-dismissal clicks. Removing the numbers from what the
    model sees is reliable. Everything semantic survives: the key pressed, the
    text typed, the formula entered.
    """
    return [COORD.sub("(<x>, <y>)", " ".join(str(action).split())[:160])
            for action in actions]


def validate_lesson(text):
    """Refuse to store a lesson that is unusable or actively misleading.

    Every one of these was observed in the offline replay, and each poisons every
    later task whose query matches it:

      * coordinates -- meaningless against a different screen state;
      * prohibitions -- the v1 regression. "Avoid hardcoded pixel coordinates;
        use keyboard shortcuts" is confident, plausible, and wrong here, because
        the agent is handed an accessibility tree with exact coordinates. It cost
        three tasks that the no-memory arm solved;
      * degenerate output -- the distiller occasionally returns multilingual
        token salad, which is pure noise in the recall budget.

    A memory system that stores whatever a model hands it has no way back from
    any of these, so the gate belongs on the write path.
    @param text - the candidate lesson.
    @returns a rejection reason, or "" when the lesson may be stored.
    """
    if not text or text.strip().upper().startswith("NOTHING"):
        return "empty"
    if COORD.search(text):
        return "contains coordinates"
    if PROHIBIT.search(text):
        return "contains a prohibition"
    letters = [c for c in text if c.isalpha()]
    if letters and sum(c.isascii() for c in letters) / len(letters) < 0.9:
        return "degenerate output"
    if len(re.findall(r"[A-Za-z']+", text)) < 8:
        return "too short to carry a fact"
    return ""


class MemoryPromptAgent(PromptAgent):
    """The official agent, plus cross-task memory.

    Everything about acting -- prompt, observation type, parser, trajectory
    handling -- is inherited untouched, so the no-memory arm reproduces the
    published baseline and the two arms differ only by the seam below.
    """

    def __init__(self, *args, memory_url=None, domain="", **kwargs):
        super().__init__(*args, **kwargs)
        self.memory_url = memory_url.rstrip("/") if memory_url else None
        self.domain = domain
        self._base_system = self.system_message
        self.cues = []
        self.cue_ids = []
        self.instruction = ""

    # ---------------------------------------------------------------- memory
    def _post(self, route, payload, timeout=90):
        if not self.memory_url:
            return {}
        try:
            req = urllib.request.Request(
                self.memory_url + route, data=json.dumps(payload).encode(),
                headers={"Content-Type": "application/json"})
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return json.loads(r.read().decode())
        except Exception as exc:  # noqa: BLE001 - memory must never break the run
            logger.warning("memory %s failed: %s", route, exc)
            return {}

    def recall(self, instruction):
        """Fetch cross-task cues and fold them into the system message."""
        got = self._post("/recall", {"text": instruction})
        self.cues = got.get("cues", []) or []
        self.cue_ids = got.get("ids", []) or []
        if self.cues:
            joined = "\n".join("- " + c.replace("\n", " ") for c in self.cues)
            self.system_message = (
                self._base_system
                + "\n\nWhat you learned on earlier tasks in this application "
                  "(may or may not apply here):\n" + joined + "\n")
            logger.info("recalled %d cue(s)", len(self.cues))
        else:
            self.system_message = self._base_system
        return self.cues

    def write_back(self, instruction, success):
        """Distil one coordinate-free, transferable lesson and store it.

        An earlier version stored the raw pyautogui trace. That is the wrong
        unit: absolute coordinates describe a screen state that no longer
        exists, and harvested from a failed attempt they teach the next task how
        to fail. Procedural knowledge -- which menu, which dialog, which route --
        is what actually transfers, so a model extracts that first. This is the
        model-backed distiller the plugin's frequency miner cannot be.
        """
        if not self.memory_url:
            return
        trace = "\n".join(str(a).replace("\n", " ")[:160] for a in self.actions[:14]) or "(none)"
        payload = {
            "model": self.model,
            "messages": [{"role": "user", "content": DISTIL.format(
                domain=self.domain, instruction=instruction,
                outcome="SUCCEEDED" if success else "FAILED", trace=trace)}],
            "max_tokens": 1000,
            "temperature": 0,
        }
        try:
            lesson = self.call_llm(payload)
        except Exception as exc:  # noqa: BLE001
            logger.warning("distillation failed: %s", exc)
            return
        reject = validate_lesson(lesson)
        if reject:
            logger.info("lesson rejected by the write gate: %s", reject)
            return
        text = ("[%s] While doing: %s\nOutcome: %s\n%s"
                % (self.domain, instruction[:160],
                   "SUCCESS" if success else "FAILED", lesson.strip()[:700]))
        self._post("/remember", {"id": "osw-%d" % int(time.time() * 1000), "text": text})
        logger.info("wrote back a lesson (%d chars)", len(text))

    # ------------------------------------------------------------------- llm
    def call_llm(self, payload, *args, **kwargs):
        """Always talk to the OpenAI-compatible gateway, whatever the model is called.

        The base class dispatches on the model *name*: anything starting with
        "gemini" is routed to the Google GenAI SDK and demands GENAI_API_KEY, so
        pointing OPENAI_BASE_URL at an OpenAI-compatible gateway that happens to
        serve a Gemini model silently produced an empty response and zero
        actions -- the agent then burned its whole step budget doing nothing.
        Routing by name is the wrong axis here: the gateway defines the protocol,
        not the model.
        """
        body = json.dumps({
            "model": payload.get("model", self.model),
            "messages": payload["messages"],
            "max_tokens": payload.get("max_tokens", self.max_tokens),
            "temperature": payload.get("temperature", self.temperature),
            "top_p": payload.get("top_p", self.top_p),
        }).encode()
        base = os.environ["OPENAI_BASE_URL"].rstrip("/")
        url = base + "/chat/completions" if base.endswith("/v1") else base + "/v1/chat/completions"
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
        logger.error("llm call failed after retries: %s", last)
        return ""

    # ------------------------------------------------------------------ loop
    def predict(self, instruction, obs):
        """Recall once per task, then defer entirely to the official agent."""
        if instruction != self.instruction:
            self.instruction = instruction
            self.recall(instruction)
        return super().predict(instruction, obs)

    def reset(self, _logger=None, **kwargs):
        """Clear per-task state. The memory store deliberately survives."""
        super().reset(_logger)
        self.cues, self.cue_ids, self.instruction = [], [], ""
        self.system_message = self._base_system
