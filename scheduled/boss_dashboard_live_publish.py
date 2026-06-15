"""Publish the boss dashboard safe live summary for the Vercel phone view."""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
WORKSPACE = ROOT / "workspace"
PUBLISHER = WORKSPACE / "boss-dashboard" / "scripts" / "publish_live_summary.js"


def main() -> int:
    if not PUBLISHER.exists():
        print(f"ERROR: missing publisher script: {PUBLISHER}")
        return 1

    cmd = ["node", str(PUBLISHER), "--commit", "--push"]
    proc = subprocess.run(
        cmd,
        cwd=str(WORKSPACE),
        text=True,
        capture_output=True,
        timeout=90,
    )
    if proc.stdout.strip():
        print(proc.stdout.strip())
    if proc.stderr.strip():
        print(proc.stderr.strip(), file=sys.stderr)
    return proc.returncode


if __name__ == "__main__":
    raise SystemExit(main())
