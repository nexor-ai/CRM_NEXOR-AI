#!/usr/bin/env python3
"""Start WACRM/CRM_NEXOR-AI in production mode with a safe env loader.

Do not `source` shared env files in a shell. This loader reads only the project
.env and then execs Next.js with an explicit localhost bind.
"""
from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path

PROJECT_DIR = Path(__file__).resolve().parents[1]
ENV_PATH = Path(os.environ.get("NEXOR_ENV", PROJECT_DIR / ".env"))
NODE_BIN = Path(os.environ.get("NEXOR_NODE_BIN", "/home/hermes/.hermes/node/bin"))
HOST = os.environ.get("HOST", "127.0.0.1")
PORT = os.environ.get("PORT", "3010")


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


def main() -> int:
    load_env(ENV_PATH)
    os.environ["PATH"] = f"{NODE_BIN}:{os.environ.get('PATH', '')}"
    cmd = ["npm", "run", "start", "--", "-p", PORT, "-H", HOST]
    return subprocess.call(cmd, cwd=PROJECT_DIR)


if __name__ == "__main__":
    raise SystemExit(main())
