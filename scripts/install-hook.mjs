#!/usr/bin/env node
// install-hook.mjs — idempotently merge Agency's global Stop hook into
// ~/.claude/settings.json so paused Claude Code agents can be answered from the
// dashboard (Control Phase-1).
//
// THE HOOK: a Stop hook of type "http" pointed at Agency's /api/hook/stop. When
// an agent stops, Claude Code POSTs the hook and BLOCKS until we respond; Agency
// holds that connection open until you reply (or a soft deadline), then resumes
// or stops the agent. The hook FAILS OPEN: if Agency isn't running (connection
// refused) or times out, the agent just stops normally — so installing this is
// safe even when the dashboard is closed.
//
// This is USER OPT-IN. The merge mirrors judge's installer (idempotent: it
// won't add a second Agency entry if one already exists, and it preserves any
// other hooks you have). It writes ONLY ~/.claude/settings.json (your hook
// config) — never the session/usage data Agency reads.
//
// Usage:
//   node scripts/install-hook.mjs            # install/merge
//   node scripts/install-hook.mjs --uninstall  # remove only Agency's entry
//   node scripts/install-hook.mjs --print      # show the entry, write nothing

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const PORT = process.env.PORT ? Number(process.env.PORT) : 4313;
const HOST = process.env.HOST || '127.0.0.1';
const HOOK_URL = `http://${HOST}:${PORT}/api/hook/stop`;
const HOOK_TIMEOUT = 120; // seconds — must exceed Agency's ~110s soft deadline

const SETTINGS = path.join(os.homedir(), '.claude', 'settings.json');

// The hook entry we install. We tag it by its URL path so we can find/replace
// our own entry on re-runs without disturbing anyone else's Stop hooks.
const AGENCY_SIG = '/api/hook/stop';
function agencyEntry() {
  return { hooks: [{ type: 'http', url: HOOK_URL, timeout: HOOK_TIMEOUT }] };
}

// Does this Stop-hook entry belong to Agency? (matches any port/host install.)
function isAgencyEntry(entry) {
  return (
    entry &&
    Array.isArray(entry.hooks) &&
    entry.hooks.some((h) => h && h.type === 'http' && typeof h.url === 'string' && h.url.includes(AGENCY_SIG))
  );
}

function loadSettings(file) {
  if (!fs.existsSync(file)) return {};
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    console.error(`Can't read ${file}: ${err.message} — aborting.`);
    process.exit(1);
  }
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      console.error(`${file} is not a JSON object — fix it manually, aborting.`);
      process.exit(1);
    }
    return parsed;
  } catch {
    console.error(`${file} is invalid JSON — fix it manually, aborting.`);
    process.exit(1);
  }
}

function install() {
  const cfg = loadSettings(SETTINGS);
  cfg.hooks = cfg.hooks && typeof cfg.hooks === 'object' && !Array.isArray(cfg.hooks) ? cfg.hooks : {};
  const cur = cfg.hooks.Stop;
  if (cur !== undefined && !Array.isArray(cur)) {
    console.error(`${SETTINGS}: hooks.Stop is not an array — fix it manually, aborting.`);
    process.exit(1);
  }
  cfg.hooks.Stop = Array.isArray(cur) ? cur : [];

  if (cfg.hooks.Stop.some(isAgencyEntry)) {
    console.log(`Agency Stop hook already wired in ${SETTINGS} (nothing to do).`);
    return;
  }
  cfg.hooks.Stop.push(agencyEntry());
  fs.mkdirSync(path.dirname(SETTINGS), { recursive: true });
  fs.writeFileSync(SETTINGS, JSON.stringify(cfg, null, 2) + '\n');
  console.log(`Wired Agency Stop hook into ${SETTINGS} → ${HOOK_URL}`);
  console.log('Run `npm start`, then run `claude` anywhere — when an agent stops,');
  console.log('answer it from the dashboard (it fails open if Agency is closed).');
}

function uninstall() {
  if (!fs.existsSync(SETTINGS)) {
    console.log(`No settings at ${SETTINGS} — nothing to remove.`);
    return;
  }
  const cfg = loadSettings(SETTINGS);
  if (!cfg.hooks || typeof cfg.hooks !== 'object' || !Array.isArray(cfg.hooks.Stop)) {
    console.log(`No Agency Stop hook in ${SETTINGS}.`);
    return;
  }
  const before = cfg.hooks.Stop.length;
  cfg.hooks.Stop = cfg.hooks.Stop.filter((e) => !isAgencyEntry(e));
  const removed = before - cfg.hooks.Stop.length;
  if (cfg.hooks.Stop.length === 0) delete cfg.hooks.Stop;
  if (cfg.hooks && Object.keys(cfg.hooks).length === 0) delete cfg.hooks;
  fs.writeFileSync(SETTINGS, JSON.stringify(cfg, null, 2) + '\n');
  console.log(removed ? `Removed Agency Stop hook from ${SETTINGS}.` : `No Agency Stop hook in ${SETTINGS}.`);
}

const arg = process.argv[2];
if (arg === '--print') {
  console.log(JSON.stringify({ hooks: { Stop: [agencyEntry()] } }, null, 2));
} else if (arg === '--uninstall' || arg === '-u') {
  uninstall();
} else {
  install();
}
