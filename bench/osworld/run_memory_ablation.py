# -*- coding: utf-8 -*-
"""OSWorld memory ablation: the same task list, twice, memory the only difference.

    python run_memory_ablation.py --domain libreoffice_calc --n 15 \
        --arm memory --memory-url http://127.0.0.1:8848

OSWorld resets the VM to a snapshot before every task, so nothing carries over
between tasks except what the memory server holds. That is what makes this a
*continual-learning* comparison rather than a per-task one: task k can only
benefit from tasks 1..k-1 through memory, and the no-memory arm has no channel
at all. Task order is fixed and identical across arms so the two are paired.

Success is OSWorld's own `env.evaluate()`; nothing here decides correctness.
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

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from desktop_env.desktop_env import DesktopEnv  # noqa: E402
from mm_agents.memory_agent import MemoryPromptAgent  # noqa: E402

logging.basicConfig(level=logging.INFO,
                    format="%(asctime)s %(levelname)s %(name)s: %(message)s")
logger = logging.getLogger("ablation")
logging.getLogger("urllib3").setLevel(logging.WARNING)


def load_tasks(root, domain, n):
    """The first `n` task ids of a domain, in the meta file's own order."""
    meta = json.load(open(os.path.join(root, "evaluation_examples", "test_all.json"),
                          encoding="utf-8"))
    ids = meta[domain][:n]
    tasks = []
    for tid in ids:
        path = os.path.join(root, "evaluation_examples", "examples", domain, tid + ".json")
        tasks.append((tid, json.load(open(path, encoding="utf-8"))))
    return tasks


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--domain", default="libreoffice_calc")
    ap.add_argument("--n", type=int, default=15)
    ap.add_argument("--arm", choices=["none", "memory"], required=True)
    ap.add_argument("--memory-url", default="")
    ap.add_argument("--max-steps", type=int, default=15)
    ap.add_argument("--max-tokens", type=int, default=4000)
    ap.add_argument("--out", required=True)
    ap.add_argument("--model", default=os.environ.get("QA_MODEL", "alibaba/qwen3.5-27b"))
    ap.add_argument("--obs-timeout", type=float, default=90.0,
                    help="seconds to wait for one observation before giving up on the "
                         "accessibility tree for that step. Measured on a stalled run: the "
                         "model call cost 394s in total while fetching the a11y tree from "
                         "the VM cost 7535s, almost all of it in a handful of multi-minute "
                         "stalls. Without a bound one bad fetch can cost more than a whole task.")
    a = ap.parse_args()

    root = os.path.dirname(os.path.abspath(__file__))
    tasks = load_tasks(root, a.domain, a.n)
    logger.info("arm=%s domain=%s tasks=%d", a.arm, a.domain, len(tasks))

    # The official scaffold, at its own defaults: pyautogui actions and the
    # screenshot+a11y-tree observation the published numbers use. The endpoint
    # comes from OPENAI_BASE_URL / OPENAI_API_KEY, which PromptAgent reads itself.
    agent = MemoryPromptAgent(
        model=a.model,
        action_space="pyautogui",
        observation_type="screenshot_a11y_tree",
        max_tokens=a.max_tokens,
        temperature=0.0,
        max_trajectory_length=3,
        memory_url=(a.memory_url or None) if a.arm == "memory" else None,
        domain=a.domain,
    )

    env = DesktopEnv(provider_name="docker", action_space="pyautogui",
                     screen_size=(1920, 1080), headless=True,
                     require_a11y_tree=True, os_type="Ubuntu")

    def observe():
        """Fetch one observation, bounded.

        AT-SPI in the guest occasionally takes tens of minutes to answer once
        LibreOffice has a chart or a dialog open. Returning a screenshot-only
        observation is much better than stalling: the step is weaker, both arms
        are affected identically, and the run finishes.
        """
        with futures.ThreadPoolExecutor(max_workers=1) as pool:
            job = pool.submit(env._get_obs)
            try:
                return job.result(timeout=a.obs_timeout), False
            except futures.TimeoutError:
                logger.warning("observation timed out after %.0fs; continuing without "
                               "a fresh a11y tree", a.obs_timeout)
                return None, True

    results = []
    stalls = 0
    try:
        for index, (tid, config) in enumerate(tasks, 1):
            instruction = config.get("instruction", "")
            logger.info("[%d/%d] %s :: %s", index, len(tasks), tid, instruction[:90])
            score, error, declared = 0.0, "", "capped"
            try:
                agent.reset()
                env.reset(task_config=config)
                time.sleep(2)
                # Environment normalisation, identical in both arms: LibreOffice
                # ships two notification banners ("Help us make LibreOffice even
                # better", "Your donations support...") that occupy the top ~80px
                # and push the grid down, so row 1 lands where the model expects
                # the header row. They are chrome, not part of any task, and they
                # cost every condition equally -- but they cost it for no reason.
                for close_x, close_y in ((1847, 266), (1847, 226)):
                    try:
                        env.step("pyautogui.click(%d, %d)" % (close_x, close_y), pause=0.6)
                    except Exception:  # noqa: BLE001 - a banner that is not there
                        pass
                fresh, stalled = observe()
                stalls += stalled
                if fresh is not None:
                    obs = fresh
                for _ in range(a.max_steps):
                    _reply, actions = agent.predict(instruction, obs)
                    stop = False
                    for action in actions:
                        if action in ("DONE", "FAIL"):
                            declared = action
                            stop = True
                            break
                        if action == "WAIT":
                            time.sleep(2.0)
                            fresh, stalled = observe()
                            stalls += stalled
                            if fresh is not None:
                                obs = fresh
                            continue
                        env.step(action, pause=1.0)
                        fresh, stalled = observe()
                        stalls += stalled
                        if fresh is not None:
                            obs = fresh
                    if stop:
                        break
                score = float(env.evaluate())
            except Exception as exc:  # noqa: BLE001 - a crashed task is a failed task
                error = f"{type(exc).__name__}: {exc}"
                logger.error("task %s crashed: %s", tid, error)
                logger.debug(traceback.format_exc())

            success = score > 0
            # Write-back happens for the memory arm only, and after evaluation,
            # so the lesson records the real outcome rather than a guess.
            if a.arm == "memory":
                agent.write_back(instruction, success)
            results.append({"task_id": tid, "instruction": instruction,
                            "score": score, "success": success,
                            "steps": len(agent.actions), "error": error,
                            "declared": declared, "cues_used": len(agent.cues),
                            "obs_stalls": stalls})
            logger.info("  -> %s (running %d/%d)", "SUCCESS" if success else "fail",
                        sum(r["success"] for r in results), len(results))
            with open(a.out, "w", encoding="utf-8") as f:
                json.dump({"arm": a.arm, "domain": a.domain, "model": a.model,
                           "results": results}, f, ensure_ascii=False, indent=1)
    finally:
        try:
            env.close()
        except Exception:  # noqa: BLE001
            pass

    n_ok = sum(r["success"] for r in results)
    print("\narm=%-7s %s  success %d/%d = %.1f%%"
          % (a.arm, a.domain, n_ok, len(results), 100 * n_ok / max(1, len(results))))


if __name__ == "__main__":
    main()
