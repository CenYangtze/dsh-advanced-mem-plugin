# -*- coding: utf-8 -*-
"""OSWorld same-task retry: does remembering your own failed attempt help?

The cross-task protocol could not answer this. Fifteen largely unrelated
spreadsheet tasks give continual learning almost nothing to carry forward, only
about a quarter of them succeed so there is little verified knowledge to write
down, and the measured run-to-run variance is +/-1.7 tasks at n=15 -- wide enough
to swallow any effect a thin, incidental memory could produce.

So this narrows the question until it is answerable. Each task is attempted
twice against the same reset snapshot:

    attempt 1   no memory at all          -> the control
    attempt 2   memory holding exactly one lesson: the one distilled from this
                task's own attempt 1      -> the treatment

The pair is as tight as this benchmark allows: same task, same attempt index,
same scaffold, same model, same VM state at the start of both. The store is
cleared between tasks, so attempt 2 can only ever see its own predecessor -- no
accumulation, no cross-task contamination, nothing to attribute the difference to
except the one lesson.

It is also the honest use case for an OS agent's memory. An agent that just
failed to build a pivot table and is asked again should not have to rediscover
where the dialog lives.

    python run_retry_ablation.py --domain libreoffice_calc --n 8 \
        --memory-url http://127.0.0.1:8848 --out retry.json
"""

from __future__ import annotations

import argparse
import concurrent.futures as futures
import json
import logging
import os
import sys
import time
import traceback
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from desktop_env.desktop_env import DesktopEnv  # noqa: E402
from mm_agents.memory_agent import MemoryPromptAgent  # noqa: E402

logging.basicConfig(level=logging.INFO,
                    format="%(asctime)s %(levelname)s %(name)s: %(message)s")
logger = logging.getLogger("retry")
logging.getLogger("urllib3").setLevel(logging.WARNING)


def load_tasks(root, domain, n):
    meta = json.load(open(os.path.join(root, "evaluation_examples", "test_all.json"),
                          encoding="utf-8"))
    out = []
    for tid in meta[domain][:n]:
        path = os.path.join(root, "evaluation_examples", "examples", domain, tid + ".json")
        out.append((tid, json.load(open(path, encoding="utf-8"))))
    return out


def post(url, payload, timeout=60):
    req = urllib.request.Request(url, data=json.dumps(payload).encode(),
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode())


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--domain", default="libreoffice_calc")
    ap.add_argument("--n", type=int, default=8)
    ap.add_argument("--memory-url", required=True)
    ap.add_argument("--max-steps", type=int, default=15)
    ap.add_argument("--max-tokens", type=int, default=4000)
    ap.add_argument("--obs-timeout", type=float, default=60.0)
    ap.add_argument("--model", default=os.environ.get("QA_MODEL", "alibaba/qwen3.5-27b"))
    ap.add_argument("--out", required=True)
    a = ap.parse_args()

    root = os.path.dirname(os.path.abspath(__file__))
    tasks = load_tasks(root, a.domain, a.n)
    mem = a.memory_url.rstrip("/")
    logger.info("same-task retry: %d tasks, 2 attempts each", len(tasks))

    env = DesktopEnv(provider_name="docker", action_space="pyautogui",
                     screen_size=(1920, 1080), headless=True,
                     require_a11y_tree=True, os_type="Ubuntu")

    def observe():
        """Bounded observation; a stalled a11y fetch must not cost more than a task."""
        with futures.ThreadPoolExecutor(max_workers=1) as pool:
            job = pool.submit(env._get_obs)
            try:
                return job.result(timeout=a.obs_timeout)
            except futures.TimeoutError:
                logger.warning("observation timed out after %.0fs", a.obs_timeout)
                return None

    def attempt(agent, config, instruction):
        """One attempt from a freshly reverted snapshot."""
        declared = "capped"
        agent.reset()
        env.reset(task_config=config)
        time.sleep(2)
        for close_x, close_y in ((1847, 266), (1847, 226)):
            try:
                env.step("pyautogui.click(%d, %d)" % (close_x, close_y), pause=0.6)
            except Exception:  # noqa: BLE001
                pass
        obs = observe()
        for _ in range(a.max_steps):
            if obs is None:
                obs = observe()
                if obs is None:
                    break
            _reply, actions = agent.predict(instruction, obs)
            stop = False
            for action in actions:
                if action in ("DONE", "FAIL"):
                    declared, stop = action, True
                    break
                if action == "WAIT":
                    time.sleep(2.0)
                else:
                    env.step(action, pause=1.0)
                obs = observe()
            if stop:
                break
        return float(env.evaluate()), declared, len(agent.actions)

    results = []
    try:
        for index, (tid, config) in enumerate(tasks, 1):
            instruction = config.get("instruction", "")
            logger.info("[%d/%d] %s :: %s", index, len(tasks), tid, instruction[:80])
            row = {"task_id": tid, "instruction": instruction}
            try:
                # The store is cleared per task, so attempt 2 sees exactly one
                # lesson and it is always its own. Nothing else can explain a gap.
                post(mem + "/reset", {})

                control = MemoryPromptAgent(
                    model=a.model, action_space="pyautogui",
                    observation_type="screenshot_a11y_tree", max_tokens=a.max_tokens,
                    temperature=0.0, max_trajectory_length=3,
                    memory_url=None, domain=a.domain)
                score1, declared1, steps1 = attempt(control, config, instruction)
                row.update(a1_score=score1, a1_success=score1 > 0,
                           a1_declared=declared1, a1_steps=steps1)
                logger.info("  attempt 1 (no memory): %s",
                            "SUCCESS" if score1 > 0 else "fail")

                # Distil attempt 1 through the real write path -- same prompt,
                # same sanitiser, same write gate the plugin arm uses.
                writer = MemoryPromptAgent(
                    model=a.model, action_space="pyautogui",
                    observation_type="screenshot_a11y_tree", max_tokens=a.max_tokens,
                    temperature=0.0, memory_url=mem, domain=a.domain)
                writer.actions = list(control.actions)
                writer.write_back(instruction, score1 > 0)
                row["lesson_stored"] = True

                treated = MemoryPromptAgent(
                    model=a.model, action_space="pyautogui",
                    observation_type="screenshot_a11y_tree", max_tokens=a.max_tokens,
                    temperature=0.0, max_trajectory_length=3,
                    memory_url=mem, domain=a.domain)
                score2, declared2, steps2 = attempt(treated, config, instruction)
                row.update(a2_score=score2, a2_success=score2 > 0,
                           a2_declared=declared2, a2_steps=steps2,
                           a2_cues=len(treated.cues))
                logger.info("  attempt 2 (with memory, %d cue): %s",
                            len(treated.cues), "SUCCESS" if score2 > 0 else "fail")
            except Exception as exc:  # noqa: BLE001
                row["error"] = "%s: %s" % (type(exc).__name__, exc)
                logger.error("task %s crashed: %s", tid, row["error"])
                logger.debug(traceback.format_exc())
            results.append(row)
            done = [r for r in results if "a2_success" in r]
            logger.info("  running: no-memory %d/%d, memory %d/%d",
                        sum(r["a1_success"] for r in done), len(done),
                        sum(r["a2_success"] for r in done), len(done))
            with open(a.out, "w", encoding="utf-8") as f:
                json.dump({"protocol": "same-task-retry", "domain": a.domain,
                           "model": a.model, "results": results}, f,
                          ensure_ascii=False, indent=1)
    finally:
        try:
            env.close()
        except Exception:  # noqa: BLE001
            pass

    done = [r for r in results if "a2_success" in r]
    n1 = sum(r["a1_success"] for r in done)
    n2 = sum(r["a2_success"] for r in done)
    print("\nsame-task retry over %d tasks" % len(done))
    print("  attempt 1, no memory : %d/%d" % (n1, len(done)))
    print("  attempt 2, memory    : %d/%d" % (n2, len(done)))


if __name__ == "__main__":
    main()
