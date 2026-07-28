#!/usr/bin/env python3
"""Swap the current and previous CRM production builds without restarting.

The operation is fail-closed: both builds must contain BUILD_ID and the temporary
swap path must be absent. Restart remains a separate, explicitly approved gate.
"""
from __future__ import annotations

import os
from pathlib import Path

PROJECT_DIR = Path(__file__).resolve().parents[1]
CURRENT_NAME = ".next-production"
PREVIOUS_NAME = ".next-production.previous"
SWAP_NAME = ".next-production.rollback"


def require_build(path: Path, label: str) -> str:
    build_id = path / "BUILD_ID"
    if not build_id.is_file():
        raise SystemExit(f"{label} production build not found: {build_id}")
    return build_id.read_text(encoding="utf-8").strip()


def main() -> int:
    current = PROJECT_DIR / CURRENT_NAME
    previous = PROJECT_DIR / PREVIOUS_NAME
    swap = PROJECT_DIR / SWAP_NAME

    current_id = require_build(current, "Current")
    previous_id = require_build(previous, "Previous")
    if swap.exists():
        raise SystemExit(f"Rollback swap path already exists: {swap}")

    os.replace(current, swap)
    try:
        os.replace(previous, current)
        os.replace(swap, previous)
    except BaseException:
        if swap.exists() and not current.exists():
            os.replace(swap, current)
        raise

    print(f"Rollback prepared: current={previous_id} previous={current_id}")
    print("Service was not restarted.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
