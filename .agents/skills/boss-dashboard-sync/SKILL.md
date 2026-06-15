---
name: boss-dashboard-sync
description: Keep the OpenClaw boss dashboard aligned when Codex adds or changes agents, cron jobs, scheduled automations, workflows, dashboard wording, channel bindings, or business-area ownership. Use for changes touching workspace/boss-dashboard, cron/jobs.json, openclaw.json agents/bindings, workflow diagrams, automation display copy, or boss-facing Arabic/English dashboard UX.
---

# Boss Dashboard Sync

## Purpose

Keep `workspace/boss-dashboard` accurate whenever OpenClaw gains a new agent, cron job, automation, workflow, routing owner, or visible dashboard wording. The dashboard is read-only and boss-facing; keep technical internals in code/config and show business value in clear Arabic/English.

## Sources Of Truth

- Agents, bindings, and channel reach live in `openclaw.json`.
- Active scheduled automations live in `cron/jobs.json`; only `enabled: true` jobs appear.
- Workflow diagrams live in `workspace/boss-dashboard/workflows.json`, keyed by cron job id.
- Dashboard shaping lives in `workspace/boss-dashboard/server.js` and `workspace/boss-dashboard/public/index.html`.
- Never expose secrets from `workspace/boss-dashboard/config.json`, credentials, or full WhatsApp peer ids in browser payloads.

## Required Update Flow

When adding or changing an agent:

1. Update `ROLES`, `AREA`, and `AREA_SUMMARY` in `server.js` if the business area is new.
2. Update `roleKeyFromMc()`, `agentArea()`, `areaForAgentId()`, and `areaIcon()` when matching cannot be inferred from current keywords.
3. Ensure channel/binding display still masks peers and routes to the correct `areaKey`.
4. Verify the Team card has a plain responsibility sentence, not just a department label.

When adding or changing a cron job or automation:

1. Keep the real job in `cron/jobs.json`; do not duplicate deterministic script jobs with agent cron.
2. Ensure `categorize()` and `inferAutomationAreas()` classify it into the right business category and related team area.
3. Add/update `AUTOMATION_AR_COPY` for every enabled cron job so Arabic mode never falls back to raw English names/descriptions.
4. Keep `name` and `description` raw/cleaned for English, and use `displayName` / `displayDescription` for bilingual UI.
5. Keep schedule wording boss-friendly via `humanizeCron()`; prefer phrases like `Every 30 min during work hours`.

When adding or changing a workflow diagram:

1. Add it to `workflows.json` under the exact cron job id.
2. Provide bilingual `title`, optional `recipients`, and bilingual node labels.
3. Keep Team detail pages ordered as workflow diagrams first, then active checks, then channels.
4. Do not duplicate workflow-backed jobs in the Team active checks list; `visibleChecksForArea()` filters them out.

When changing Overview:

1. Keep it as an executive brief: status, numbers, Value Today, Today's Business Updates, Needs Your Attention.
2. Do not put full Team grids or automation category lists back on Overview.
3. Business activity should use `activity[].headline` and `activity[].impact`, not raw technical log text.
4. Keep technical heartbeat/offline rows out of the business updates feed; use attention items for current problems.

## Validation

Run the deterministic checker first:

```powershell
python workspace\.agents\skills\boss-dashboard-sync\scripts\check_dashboard_sync.py
```

Then run syntax checks:

```powershell
node --check workspace\boss-dashboard\server.js
node -e "const fs=require('fs'); const html=fs.readFileSync('workspace/boss-dashboard/public/index.html','utf8'); const m=html.match(/<script>([\s\S]*)<\/script>/); new Function(m[1]); console.log('html script syntax ok')"
```

If the dashboard server is running, verify the live API:

```powershell
node -e "fetch('http://127.0.0.1:3001/api/summary',{cache:'no-store'}).then(r=>r.json()).then(d=>console.log(JSON.stringify({automations:d.automations.length,valueToday:d.valueToday?.length,attentionItems:Array.isArray(d.attentionItems)},null,2)))"
```

For UI-sensitive changes, run a browser check across Arabic and English, desktop and mobile. Confirm no console errors, no horizontal overflow, Arabic automations have Arabic names/descriptions, and Team detail pages show workflows before non-workflow checks.

## Git Hygiene

Before committing or pushing, inspect the repo from `workspace/` and stage only the intended dashboard/skill files. This workspace often has many unrelated untracked runtime files; do not add them casually.
