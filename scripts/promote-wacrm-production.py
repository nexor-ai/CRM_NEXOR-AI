#!/usr/bin/env python3
"""Promote a verified .next candidate into the isolated production build.

This copies to a temporary sibling and atomically renames directories. The live
server keeps its current files until systemd is explicitly restarted; routine
`npm run build` calls cannot mutate `.next-production`.
"""
from __future__ import annotations

import os
import shutil
from pathlib import Path

PROJECT_DIR = Path(__file__).resolve().parents[1]
SOURCE = PROJECT_DIR / ".next"
TARGET = PROJECT_DIR / ".next-production"
STAGING = PROJECT_DIR / ".next-production.new"
PREVIOUS = PROJECT_DIR / ".next-production.previous"


def main() -> int:
    if not (SOURCE / "BUILD_ID").is_file():
        raise SystemExit(f"Candidate build not found: {SOURCE / 'BUILD_ID'}")

    if STAGING.exists():
        shutil.rmtree(STAGING)
    shutil.copytree(SOURCE, STAGING, symlinks=True)

    if PREVIOUS.exists():
        shutil.rmtree(PREVIOUS)
    if TARGET.exists():
        os.replace(TARGET, PREVIOUS)
    os.replace(STAGING, TARGET)

    print(f"Promoted build {TARGET.joinpath('BUILD_ID').read_text().strip()}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
