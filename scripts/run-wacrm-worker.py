#!/usr/bin/env python3
"""Poll WACRM internal cron endpoints using the project .env.

Runs forever under systemd. Keeps automations and flow timeout sweeps active
without exposing the CRM publicly beyond the configured Tailscale Serve route.
"""
from __future__ import annotations

import json
import os
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path

PROJECT_DIR = Path(__file__).resolve().parents[1]
ENV_PATH = Path(os.environ.get("NEXOR_ENV", PROJECT_DIR / ".env"))
HOST = os.environ.get("WACRM_INTERNAL_HOST", "127.0.0.1")
PORT = os.environ.get("PORT", "3010")
INTERVAL_SECONDS = int(os.environ.get("WACRM_WORKER_INTERVAL_SECONDS", "60"))
INBOUND_INTERVAL_SECONDS = int(os.environ.get("WACRM_INBOUND_INTERVAL_SECONDS", "2"))
INBOUND_ENDPOINT = "/api/internal/evolution/cron"
ENDPOINTS = (
    INBOUND_ENDPOINT,
    "/api/internal/evolution/reconcile",
    "/api/automations/cron",
    "/api/flows/cron",
    "/api/broadcasts/cron",
)
MAINTENANCE_ENDPOINTS = tuple(endpoint for endpoint in ENDPOINTS if endpoint != INBOUND_ENDPOINT)
ENDPOINT_TIMEOUTS = {
    # Reconciliation fetches and normalizes a bounded page of Evolution
    # messages serially. Thirty seconds can expire while the server is still
    # making progress, causing the worker to report a false failure and start
    # another reconciliation on the next cycle.
    "/api/internal/evolution/reconcile": 120,
}


def parse_env_line(line: str) -> tuple[str, str] | None:
    stripped = line.strip()
    if not stripped or stripped.startswith("#") or "=" not in stripped:
        return None
    key, value = stripped.split("=", 1)
    key = key.strip()
    value = value.strip()
    if not key:
        return None
    if (value.startswith('"') and value.endswith('"')) or (value.startswith("'") and value.endswith("'")):
        value = value[1:-1]
    return key, value


def load_env(path: Path) -> None:
    if not path.exists():
        raise SystemExit(f"Env file not found: {path}")
    for raw in path.read_text(encoding="utf-8").splitlines():
        parsed = parse_env_line(raw)
        if parsed is None:
            continue
        key, value = parsed
        os.environ[key] = value


def hit(path: str, secret: str) -> None:
    url = f"http://{HOST}:{PORT}{path}"
    req = urllib.request.Request(url, headers={"x-cron-secret": secret})
    try:
        with urllib.request.urlopen(req, timeout=ENDPOINT_TIMEOUTS.get(path, 30)) as res:
            body = res.read().decode("utf-8", errors="replace")[:500]
            print(f"[wacrm-worker] {path} {res.status} {body}", flush=True)
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", errors="replace")[:500]
        print(f"[wacrm-worker] {path} failed {{'status': {exc.code}, 'body': {json.dumps(body)} }}", flush=True)
    except Exception as exc:  # noqa: BLE001 - worker should keep running
        print(f"[wacrm-worker] {path} failed {type(exc).__name__}: {exc}", flush=True)


def inbound_loop(secret: str, stop_event: threading.Event | None = None) -> None:
    """Drain the durable Evolution inbox independently from slow maintenance jobs."""
    stop = stop_event or threading.Event()
    while not stop.is_set():
        hit(INBOUND_ENDPOINT, secret)
        stop.wait(max(INBOUND_INTERVAL_SECONDS, 1))


def main() -> int:
    load_env(ENV_PATH)
    secret = os.environ.get("AUTOMATION_CRON_SECRET", "")
    if not secret:
        raise SystemExit("AUTOMATION_CRON_SECRET missing in project .env")
    threading.Thread(
        target=inbound_loop,
        args=(secret,),
        daemon=True,
        name="wacrm-evolution-inbound",
    ).start()
    while True:
        for endpoint in MAINTENANCE_ENDPOINTS:
            hit(endpoint, secret)
            time.sleep(5)
        time.sleep(max(INTERVAL_SECONDS, 10))


if __name__ == "__main__":
    raise SystemExit(main())
