# Boss Dashboard

A calm, bilingual (Arabic/English), read-only dashboard for Eng. Muhammad. It answers the
three questions the boss actually asks, with no technical clutter:

1. **What needs my attention today?** — status, current issues, and executive signals.
2. **What value did the system create today?** — money watched, follow-ups handled, and chats notified.
3. **What automations and workflows are running?** — active checks and workflow diagrams in plain language.

It is completely separate from the technical Mission Control dashboard — that one stays for
engineering. This one is just for the boss.

## Three views (left side panel)

- **Overview** — the executive brief: status banner, headline numbers, Value Today,
  Today's Business Updates, and Needs Your Attention. It intentionally does not repeat
  the full Team or Automations lists.
- **Team** — every agent as a card; tap one to open its detail with **workflow diagrams first**,
  then remaining active checks that are not already represented by workflows, then channels.
- **Automations** — every active scheduled job; tap one to see its **schedule, recipients, and
  step-by-step workflow diagram**.

Workflows are drawn as a vertical flow: a trigger pill, then step cards connected by a line,
with decision points showing a green "continue" branch and a hatched/muted dead-end branch.

## Editing or adding a workflow

Workflows live in [`workflows.json`](workflows.json), keyed by the cron job id (see
`cron/jobs.json`). Each entry:

```jsonc
"<cron-job-id>": {
  "area": "procurement",                      // links it to a business agent
  "title": { "en": "...", "ar": "..." },
  "recipients": { "en": "...", "ar": "..." }, // optional, shown as a chip
  "nodes": [
    { "type": "action",  "en": "...", "ar": "..." },
    { "type": "decision", "q": {"en":"...","ar":"..."},
      "branches": [
        { "label": {"en":"No","ar":"لا"},  "terminal": {"en":"nothing","ar":"لا شيء"} },
        { "label": {"en":"Yes","ar":"نعم"}, "continue": true } ] },
    { "type": "message", "en": "...", "ar": "..." }
  ]
}
```

Node `type`: `action` 🔍, `decision` ❓, `message` 💬, `wait` ⏳, `stop` 🔕, `done` ✅.
The trigger pill is generated from the job's real schedule — you don't author it.
No restart needed for edits (the file is read per request); just refresh the page.

## What it shows

- **Status banner**: "Everything is running" (green) or "Needs attention" (amber).
- **Numbers**: messages sent today, team working, active automations, automations run today,
  and (if ERP is reachable) POs awaiting approval + open material requests.
- **Your Team**: each agent with a green/grey/red dot and "last active …".
- **Value Today**: money watched, follow-ups handled, and teams/chats notified.
- **Scheduled Automations**: only the *enabled* jobs, **grouped into business
  categories** (Procurement & Suppliers, Sales & Quotations, Delivery & Fleet,
  Accounts & Collections, Rentals, Marketing, HR & Documents, Reports & Briefings,
  System & Monitoring). Each job shows a readable schedule ("every 15 min, 8am–5pm").
  Header shows "X of Y active".
  - **Names/descriptions are display-shaped**: technical wording the boss shouldn't
    see — "(Python)", script filenames (`foo.py`), "Runs x.py: " lead-ins,
    `[managed-by=…]` tags, and implementation-only sentences (script/session/
    timeout/doctype…) — is stripped at render time. See `cleanName`/`cleanDesc`.
    Arabic mode uses `AUTOMATION_AR_COPY` so enabled jobs do not fall back to raw English.
  - **Categories are assigned automatically** by `categorize()` (keyword match on
    id/name/description). A brand-new cron job is filed into the right category and
    cleaned with **no manual mapping** — nothing to edit when automations are added.
- **What Happened Today**: real successful sends from `scheduled/sent_log.json`, merged with
  Mission Control agent activity, newest first.

## Run it

```cmd
start.cmd
```

or

```cmd
node server.js
```

Then open **http://localhost:3001**. From a phone on the same network, use the PC's LAN IP,
e.g. `http://192.168.1.x:3001`.

## Deploy on Vercel

Deploy the Git repo root, not the `boss-dashboard/` subfolder. The repo root contains
`vercel.json` and `api/index.js`, which route Vercel requests into this dashboard.

The Vercel deployment uses:

- `config.example.json` when local-only `config.json` is not present.
- `boss-dashboard/data/jobs.json` as a sanitized active-automation snapshot.
- Empty bundled placeholders for live send logs and channel bindings.
- `boss-dashboard/live/summary.json` when the local live publisher has pushed a
  fresh safe summary.

Optional Vercel environment variables:

| Key | Meaning |
|-----|---------|
| `BOSS_DASH_PASS` | Password for the deployed dashboard. Recommended for public URLs. |
| `BOSS_LIVE_SUMMARY_URL` | Optional override for the safe live summary URL. Defaults to this repo's GitHub raw `boss-dashboard/live/summary.json` on Vercel. |
| `BOSS_LIVE_SUMMARY_MAX_AGE_MS` | How long the public live summary is considered fresh. Default: 30 minutes. |
| `MISSION_CONTROL_URL` | Public Mission Control URL, if you expose one later. |
| `MISSION_CONTROL_API_KEY` | Mission Control API key, if using a public Mission Control endpoint. |

Do not upload local `config.json`; it is ignored by git because it can contain secrets.

### Phone live updates

Boss phone view gets current numbers through a safe publisher:

```cmd
python C:\Users\DELL\.openclaw\workspace\scheduled\boss_dashboard_live_publish.py
```

The script builds the local `/api/summary` payload, removes risky fields, writes
`boss-dashboard/live/summary.json`, commits only that file, and pushes it to GitHub.
Vercel reads that raw JSON at runtime, so the phone dashboard refreshes without a
new deployment. `vercel.json` ignores live-summary-only commits to avoid rebuild
noise.

OpenClaw cron runs this every 5 minutes.

## Configuration — `config.json`

Copy `config.example.json` to `config.json` locally and fill private values there.
Do not commit `config.json`.

| Key | Meaning |
|-----|---------|
| `port` | Port to listen on (default 3001; `BOSS_PORT` env overrides). |
| `bindHost` | `0.0.0.0` = reachable on the LAN; `127.0.0.1` = this PC only. |
| `password` | Optional. If set, shows a single password screen. Empty = no gate. (`BOSS_DASH_PASS` env overrides.) |
| `missionControl.url` / `apiKey` | Where the agent data comes from. Key read from `mission-control/.env`. |
| `erp` | ERP read-only credentials for the optional approval/MR counts. |
| `paths.sentLog` / `paths.cronJobs` | Paths to the real send log and the cron jobs file. |
| `timezone` | Defaults to `Asia/Riyadh`. |

## Notes

- **Read-only**: this dashboard never writes anything anywhere. No buttons, no actions.
- **Secrets stay server-side**: the page only ever receives plain text; no API keys are exposed.
- Data refreshes automatically every 30 seconds.
- Requires the Mission Control app running on its port for agent health; if it's down, the
  banner shows "System unreachable" but the rest (automations, today's sends) still works.
- Pure Node standard library — no `npm install`, no build step. Node >= 18.
