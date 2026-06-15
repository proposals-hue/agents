#!/usr/bin/env python3
"""Check that boss-dashboard display data stays aligned with OpenClaw jobs."""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path


def read_json(path: Path, fallback):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return fallback


def read_text(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def js_object_block(source: str, const_name: str) -> str:
    match = re.search(rf"const\s+{re.escape(const_name)}\s*=\s*\{{", source)
    if not match:
        return ""
    start = match.end()
    depth = 1
    i = start
    while i < len(source):
        ch = source[i]
        if ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0:
                return source[start:i]
        i += 1
    return ""


def object_keys(block: str) -> set[str]:
    keys = set()
    for line in block.splitlines():
        match = re.match(r"\s*(?:'([^']+)'|\"([^\"]+)\"|([A-Za-z0-9_-]+))\s*:", line)
        if match:
            keys.add(next(group for group in match.groups() if group))
    return keys


def resolve_from_dashboard(dashboard_root: Path, raw: str) -> Path:
    path = Path(raw)
    if path.is_absolute():
        return path
    return (dashboard_root / path).resolve()


def main() -> int:
    skill_root = Path(__file__).resolve().parents[1]
    workspace_root = skill_root.parents[2]
    dashboard_root = workspace_root / "boss-dashboard"
    server_js = dashboard_root / "server.js"
    workflows_path = dashboard_root / "workflows.json"
    config_path = dashboard_root / "config.json"

    config = read_json(config_path, {})
    paths = config.get("paths", {}) if isinstance(config, dict) else {}
    cron_path = resolve_from_dashboard(dashboard_root, paths.get("cronJobs", "../../cron/jobs.json"))

    server = read_text(server_js)
    cron = read_json(cron_path, {"jobs": []})
    workflows = read_json(workflows_path, {})

    jobs = cron.get("jobs", []) if isinstance(cron, dict) else []
    enabled_jobs = [job for job in jobs if job.get("enabled") is True]
    enabled_ids = {str(job.get("id", "")) for job in enabled_jobs if job.get("id")}

    ar_copy_ids = object_keys(js_object_block(server, "AUTOMATION_AR_COPY"))
    area_ids = object_keys(js_object_block(server, "AREA"))
    area_summary_ids = object_keys(js_object_block(server, "AREA_SUMMARY"))

    missing_ar_copy = sorted(enabled_ids - ar_copy_ids)
    missing_area_summary = sorted(area_ids - area_summary_ids)
    workflow_title_missing = sorted(
        workflow_id
        for workflow_id, workflow in workflows.items()
        if isinstance(workflow, dict)
        and (
            not isinstance(workflow.get("title"), dict)
            or not workflow["title"].get("en")
            or not workflow["title"].get("ar")
        )
    )

    snippet_checks = {
        "displayName/displayDescription": "displayName: display.name" in server
        and "displayDescription: display.description" in server,
        "valueToday": "function valueToday(" in server,
        "attentionItems": "attentionItems" in server,
        "visibleChecksForArea": "function visibleChecksForArea(" in read_text(dashboard_root / "public" / "index.html"),
        "activityHeadlineRender": "a.headline" in read_text(dashboard_root / "public" / "index.html"),
    }
    missing_snippets = sorted(name for name, ok in snippet_checks.items() if not ok)

    result = {
        "workspace": str(workspace_root),
        "enabled_jobs": len(enabled_jobs),
        "automation_ar_copy": len(ar_copy_ids),
        "workflows": len([k for k in workflows if not str(k).startswith("_")]),
        "areas": len(area_ids),
        "missing_ar_copy": missing_ar_copy,
        "missing_area_summary": missing_area_summary,
        "workflow_title_missing": workflow_title_missing,
        "missing_dashboard_features": missing_snippets,
    }

    print(json.dumps(result, indent=2, ensure_ascii=False))

    if missing_ar_copy or missing_area_summary or workflow_title_missing or missing_snippets:
        print("boss-dashboard-sync: dashboard is missing required display alignment.", file=sys.stderr)
        return 1

    print("boss-dashboard-sync: OK")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
