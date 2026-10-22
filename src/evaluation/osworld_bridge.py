"""Authenticated HTTP adapter for an installed, pinned OSWorld DesktopEnv.

Run from the OSWorld Python environment. Environment configuration is a local
JSON file containing DesktopEnv constructor arguments. The bridge holds one
VM lease at a time; start one bridge per concurrent worker.
"""
import argparse
import base64
import hmac
import json
import math
import os
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, required=True)
    parser.add_argument("--environment-config", required=True)
    parser.add_argument("--token-env", required=True)
    parser.add_argument("--max-request-bytes", type=int, required=True)
    args = parser.parse_args()
    token = os.environ[args.token_env]
    if not token or args.max_request_bytes < 1:
        raise ValueError("A nonempty bearer token and positive request limit are required")
    with open(args.environment_config, encoding="utf-8") as handle:
        config = json.load(handle)
    if config.get("action_space") != "pyautogui":
        raise ValueError("Set action_space to pyautogui in the environment configuration")
    from desktop_env.desktop_env import DesktopEnv
    lock = threading.Lock()
    state = {"env": None, "lease": None}

    def observation(value):
        # Explicit projection excludes evaluator configuration and hidden labels.
        result = {"accessibilityTree": value.get("accessibility_tree") or "", "terminal": value.get("terminal") or ""}
        screenshot = value.get("screenshot")
        if screenshot:
            result["screenshot"] = "data:image/png;base64," + base64.b64encode(screenshot).decode("ascii")
        return result

    class Handler(BaseHTTPRequestHandler):
        def respond(self, status, payload):
            encoded = json.dumps(payload).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(encoded)))
            self.end_headers()
            self.wfile.write(encoded)

        def do_POST(self):
            if not hmac.compare_digest(self.headers.get("Authorization", ""), "Bearer " + token):
                self.respond(401, {"error": "Unauthorized"})
                return
            try:
                length = int(self.headers.get("Content-Length", "0"))
                if length < 1 or length > args.max_request_bytes:
                    self.respond(413, {"error": "Request size outside configured limit"})
                    return
                body = json.loads(self.rfile.read(length))
                lease = body.get("lease")
                if not isinstance(lease, str) or not lease:
                    raise ValueError("Missing lease")
                with lock:
                    if state["lease"] not in (None, lease):
                        self.respond(409, {"error": "Environment leased to another attempt"})
                        return
                    if self.path == "/reset":
                        if state["env"] is not None:
                            raise ValueError("Lease already reset; open a new attempt after closing it")
                        state["lease"] = lease
                        state["env"] = DesktopEnv(**config)
                        result = observation(state["env"].reset(task_config=body["task"]))
                    elif self.path == "/close":
                        if state["env"] is not None:
                            state["env"].close()
                        state["env"] = None
                        state["lease"] = None
                        result = {"closed": True}
                    elif state["env"] is None:
                        raise ValueError("No active environment")
                    elif self.path == "/step":
                        if not isinstance(body.get("action"), str):
                            raise ValueError("Expected a pyautogui action string")
                        obs, _reward, done, _info = state["env"].step(body["action"])
                        result = {"observation": observation(obs), "done": bool(done)}
                    elif self.path == "/evaluate":
                        score = float(state["env"].evaluate())
                        if not math.isfinite(score) or not 0 <= score <= 1:
                            raise ValueError("Evaluator returned an invalid score")
                        result = {"score": score}
                    else:
                        self.respond(404, {"error": "Unknown endpoint"})
                        return
                self.respond(200, result)
            except (ValueError, KeyError, TypeError) as error:
                self.respond(400, {"error": type(error).__name__})
            except Exception as error:
                # Server stderr retains operational diagnostics; responses expose no task labels.
                self.log_error("%s", str(error))
                self.respond(500, {"error": type(error).__name__})

    server = ThreadingHTTPServer((args.host, args.port), Handler)
    try:
        server.serve_forever()
    finally:
        server.server_close()
        if state["env"] is not None:
            state["env"].close()


if __name__ == "__main__":
    main()
