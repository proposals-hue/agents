'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const dashboard = require('../server');

const DASHBOARD_ROOT = path.resolve(__dirname, '..');
const REPO_ROOT = path.resolve(DASHBOARD_ROOT, '..');
const OUT_FILE = path.join(DASHBOARD_ROOT, 'live', 'summary.json');
const REL_OUT = 'boss-dashboard/live/summary.json';
const MAX_ACTIVITY = 25;

const args = new Set(process.argv.slice(2));
const shouldCommit = args.has('--commit') || args.has('--push');
const shouldPush = args.has('--push');
const dryRun = args.has('--dry-run');

function runGit(argsList, options = {}) {
  const result = spawnSync('git', ['-C', REPO_ROOT, ...argsList], {
    encoding: 'utf8',
    windowsHide: true,
  });
  if (options.allowFailure) return result;
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || '').trim();
    throw new Error(`git ${argsList.join(' ')} failed${detail ? `: ${detail}` : ''}`);
  }
  return result;
}

function deepClone(value) {
  return JSON.parse(JSON.stringify(value));
}

function scrubText(value) {
  return String(value || '')
    .replace(/\b\d{12,}@g\.us\b/g, 'WhatsApp group')
    .replace(/\+?966[\d\s-]{7,}/g, (match) => {
      const digits = match.replace(/\D/g, '');
      return digits.length >= 4 ? `+***${digits.slice(-4)}` : '+***';
    })
    .replace(/\b(token|api[_-]?key|api[_-]?secret|password)\s*[:=]\s*[^,\s]+/ig, '$1=[redacted]');
}

function scrub(value) {
  if (Array.isArray(value)) return value.map(scrub);
  if (!value || typeof value !== 'object') {
    return typeof value === 'string' ? scrubText(value) : value;
  }
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    if (/secret|password|token|cookie/i.test(key)) continue;
    out[key] = scrub(item);
  }
  return out;
}

function publicSummary(data) {
  const copy = deepClone(data);
  copy.version = 1;
  copy.publicLive = true;
  copy.sourceMode = 'live-published';
  copy.localSourceMode = data.sourceMode || 'live';
  copy.livePublishedAt = new Date().toISOString();
  copy.publisher = {
    name: 'openclaw-local-dashboard-publisher',
    cadence: '5 minutes',
  };
  copy.activity = Array.isArray(copy.activity) ? copy.activity.slice(0, MAX_ACTIVITY) : [];
  copy.channels = Array.isArray(copy.channels)
    ? copy.channels.map((channel) => ({
        ...channel,
        peer: channel.kind === 'group' ? 'WhatsApp group' : scrubText(channel.peer),
      }))
    : [];
  return scrub(copy);
}

function writeIfChanged(file, payload) {
  const next = `${JSON.stringify(payload, null, 2)}\n`;
  let prev = '';
  try {
    prev = fs.readFileSync(file, 'utf8');
  } catch {
    // First publish.
  }
  if (prev === next) return false;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, next, 'utf8');
  return true;
}

async function main() {
  if (typeof dashboard.buildSummary !== 'function') {
    throw new Error('dashboard buildSummary export is missing');
  }

  const summary = publicSummary(await dashboard.buildSummary());
  const changed = dryRun ? true : writeIfChanged(OUT_FILE, summary);

  if (dryRun) {
    console.log(JSON.stringify({
      status: 'dry-run',
      messagesSentToday: summary.numbers && summary.numbers.messagesSentToday,
      activeAutomations: summary.numbers && summary.numbers.activeAutomations,
      agentsTotal: summary.numbers && summary.numbers.agentsTotal,
      activity: Array.isArray(summary.activity) ? summary.activity.length : 0,
      livePublishedAt: summary.livePublishedAt,
    }, null, 2));
    return;
  }

  if (shouldCommit) {
    runGit(['add', REL_OUT]);
    const diff = runGit(['diff', '--cached', '--quiet', '--', REL_OUT], { allowFailure: true });
    if (diff.status === 0) {
      console.log('NOOP live summary unchanged');
      return;
    }
    runGit(['commit', '--only', REL_OUT, '-m', 'Update boss dashboard live summary']);
    if (shouldPush) runGit(['push', 'origin', 'master']);
  }

  const action = changed ? 'published' : 'unchanged';
  const n = summary.numbers || {};
  console.log(`OK live summary ${action}: ${n.messagesSentToday || 0} updates, ${n.activeAutomations || 0} checks, ${n.agentsTotal || 0} team members`);
}

main().catch((err) => {
  console.error(`ERROR: ${err.message}`);
  process.exit(1);
});
