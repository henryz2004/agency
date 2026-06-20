// usage.js — parse Claude Code transcripts into workforce usage stats.
// Aggregates token throughput, tool actions, and subagent spawns by day,
// project, and model. Caches per-file aggregates keyed by mtime+size so a
// refresh only re-reads transcripts that actually changed.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { getOpenCodeUsage } from './opencode.js';
import { getCodexUsage } from './codex.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');
const DATA_DIR = path.join(__dirname, '..', 'data');
const CACHE_PATH = path.join(DATA_DIR, 'usage-cache.json');

// ---- per-file cache -------------------------------------------------------

let cache = { version: 3, files: {} }; // path -> { mtime, size, agg }

function loadCache() {
  try {
    const raw = JSON.parse(fs.readFileSync(CACHE_PATH, 'utf8'));
    if (raw && raw.version === cache.version) cache = raw;
  } catch {
    /* no cache yet */
  }
}

function saveCache() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(CACHE_PATH, JSON.stringify(cache));
  } catch {
    /* best effort */
  }
}

// Convert an ISO timestamp into a local YYYY-MM-DD bucket.
function localDay(ts) {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString('en-CA'); // YYYY-MM-DD in local tz
}

function emptyDay() {
  return { out: 0, in: 0, cr: 0, cc: 0, tools: 0, msgs: 0, agents: 0 };
}

// How many days back still counts as a "currently active" workspace. The
// departments panel scopes to this so it reflects what you're working in now,
// not every repo you've ever opened. Exported so the frontend can label it.
export const RECENT_DAYS = 7;
const RECENT_MS = RECENT_DAYS * 86400e3;

// Parse a single transcript file into an aggregate record.
function parseFile(file) {
  const agg = {
    days: {},
    models: {},
    project: null,
    cwd: null,
    sessionId: path.basename(file, '.jsonl'),
    firstTs: null,
    lastTs: null,
    out: 0,
    in: 0,
    cr: 0,
    cc: 0,
    tools: 0,
    msgs: 0,
    agents: 0,
  };

  let content;
  try {
    content = fs.readFileSync(file, 'utf8');
  } catch {
    return agg;
  }

  for (const line of content.split('\n')) {
    if (!line) continue;
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }

    if (!agg.cwd && typeof o.cwd === 'string') {
      agg.cwd = o.cwd;
      agg.project = path.basename(o.cwd) || o.cwd;
    }

    const ts = o.timestamp;
    if (ts) {
      if (!agg.firstTs || ts < agg.firstTs) agg.firstTs = ts;
      if (!agg.lastTs || ts > agg.lastTs) agg.lastTs = ts;
    }

    if (o.type !== 'assistant') continue;
    const msg = o.message || {};
    const u = msg.usage || {};
    const model = msg.model || 'unknown';
    const day = ts ? localDay(ts) : null;

    const out = u.output_tokens || 0;
    const inp = u.input_tokens || 0;
    const cr = u.cache_read_input_tokens || 0;
    const cc = u.cache_creation_input_tokens || 0;

    agg.out += out;
    agg.in += inp;
    agg.cr += cr;
    agg.cc += cc;
    agg.msgs += 1;

    // count tool actions + subagent spawns
    let tools = 0;
    let agents = 0;
    const blocks = Array.isArray(msg.content) ? msg.content : [];
    for (const b of blocks) {
      if (b && b.type === 'tool_use') {
        tools += 1;
        if (b.name === 'Task' || b.name === 'Agent') agents += 1;
      }
    }
    agg.tools += tools;
    agg.agents += agents;

    if (day) {
      const d = (agg.days[day] ||= emptyDay());
      d.out += out;
      d.in += inp;
      d.cr += cr;
      d.cc += cc;
      d.tools += tools;
      d.agents += agents;
      d.msgs += 1;
    }

    if (!agg.models[model]) agg.models[model] = { out: 0, in: 0, msgs: 0 };
    agg.models[model].out += out;
    agg.models[model].in += inp;
    agg.models[model].msgs += 1;
  }

  return agg;
}

// Walk the projects dir and return every transcript path with its stat.
function listTranscripts() {
  const out = [];
  let projectDirs;
  try {
    projectDirs = fs.readdirSync(PROJECTS_DIR);
  } catch {
    return out;
  }
  for (const dir of projectDirs) {
    const full = path.join(PROJECTS_DIR, dir);
    let entries;
    try {
      entries = fs.readdirSync(full);
    } catch {
      continue;
    }
    for (const name of entries) {
      if (!name.endsWith('.jsonl')) continue;
      const file = path.join(full, name);
      try {
        const st = fs.statSync(file);
        out.push({ file, mtime: st.mtimeMs, size: st.size });
      } catch {
        /* skip */
      }
    }
  }
  return out;
}

// ---- public API -----------------------------------------------------------

let loaded = false;

// Refresh the cache (re-parse only changed files) and return combined stats.
export function getUsage() {
  if (!loaded) {
    loadCache();
    loaded = true;
  }

  const transcripts = listTranscripts();
  const seen = new Set();
  let dirty = false;

  for (const t of transcripts) {
    seen.add(t.file);
    const prev = cache.files[t.file];
    if (prev && prev.mtime === t.mtime && prev.size === t.size) continue;
    cache.files[t.file] = { mtime: t.mtime, size: t.size, agg: parseFile(t.file) };
    dirty = true;
  }

  // drop deleted transcripts
  for (const f of Object.keys(cache.files)) {
    if (!seen.has(f)) {
      delete cache.files[f];
      dirty = true;
    }
  }

  if (dirty) saveCache();

  return combine();
}

function combine() {
  const lifetime = { out: 0, in: 0, cr: 0, cc: 0, tools: 0, msgs: 0, agents: 0, sessions: 0 };
  const dayMap = {};
  const byModel = {};
  const byProject = {};
  // The oldest local-day bucket that still counts as "recent" for the
  // departments scope (inclusive). Compared as a YYYY-MM-DD string.
  const recentCutoffDay = new Date(Date.now() - RECENT_MS).toLocaleDateString('en-CA');

  for (const { agg } of Object.values(cache.files)) {
    if (!agg) continue;
    lifetime.out += agg.out;
    lifetime.in += agg.in;
    lifetime.cr += agg.cr;
    lifetime.cc += agg.cc;
    lifetime.tools += agg.tools;
    lifetime.msgs += agg.msgs;
    lifetime.agents += agg.agents;
    lifetime.sessions += 1;

    for (const [day, d] of Object.entries(agg.days)) {
      const t = (dayMap[day] ||= emptyDay());
      t.out += d.out;
      t.in += d.in;
      t.cr += d.cr;
      t.cc += d.cc;
      t.tools += d.tools;
      t.agents += d.agents;
      t.msgs += d.msgs;
    }

    for (const [m, v] of Object.entries(agg.models)) {
      const t = (byModel[m] ||= { out: 0, in: 0, msgs: 0 });
      t.out += v.out;
      t.in += v.in;
      t.msgs += v.msgs;
    }

    const proj = agg.project || 'unknown';
    const p = (byProject[proj] ||= { out: 0, msgs: 0, tools: 0, agents: 0, sessions: 0, lastTs: null, recentOut: 0, recentDays: 0 });
    p.out += agg.out;
    p.msgs += agg.msgs;
    p.tools += agg.tools;
    p.agents += agg.agents;
    p.sessions += 1;
    if (agg.lastTs && (!p.lastTs || agg.lastTs > p.lastTs)) p.lastTs = agg.lastTs;
    // recentOut: output tokens this project shipped within the recency window —
    // the truthful "currently active" signal the departments panel scopes to.
    for (const [day, d] of Object.entries(agg.days)) {
      if (day >= recentCutoffDay) {
        p.recentOut += d.out;
        p.recentDays += 1;
      }
    }
  }

  const oc = getOpenCodeUsage();
  if (oc) mergeUsage(lifetime, dayMap, byModel, byProject, oc, recentCutoffDay);
  const codex = getCodexUsage();
  if (codex) mergeUsage(lifetime, dayMap, byModel, byProject, codex, recentCutoffDay);

  const daily = Object.entries(dayMap)
    .map(([date, v]) => ({ date, ...v }))
    .sort((a, b) => (a.date < b.date ? -1 : 1));

  const today = new Date().toLocaleDateString('en-CA');
  const todayStats = dayMap[today] ? { date: today, ...dayMap[today] } : { date: today, ...emptyDay() };

  return {
    lifetime,
    today: todayStats,
    daily,
    byModel,
    byProject,
    firstDay: daily.length ? daily[0].date : null,
    activeDays: daily.length,
    recentWindowDays: RECENT_DAYS, // window the departments panel scopes "active" to
  };
}

function mergeUsage(lifetime, dayMap, byModel, byProject, oc, recentCutoffDay) {
  lifetime.out += oc.lifetime.out;
  lifetime.in += oc.lifetime.in;
  lifetime.cr += oc.lifetime.cr;
  lifetime.cc += oc.lifetime.cc;
  lifetime.tools += oc.lifetime.tools;
  lifetime.msgs += oc.lifetime.msgs;
  lifetime.agents += oc.lifetime.agents;
  lifetime.sessions += oc.lifetime.sessions;

  for (const d of oc.daily || []) {
    const t = (dayMap[d.date] ||= emptyDay());
    t.out += d.out;
    t.in += d.in;
    t.cr += d.cr;
    t.cc += d.cc;
    t.tools += d.tools;
    t.agents += d.agents;
    t.msgs += d.msgs;
  }

  for (const [m, v] of Object.entries(oc.byModel || {})) {
    const t = (byModel[m] ||= { out: 0, in: 0, msgs: 0 });
    t.out += v.out;
    t.in += v.in;
    t.msgs += v.msgs;
  }

  for (const [proj, v] of Object.entries(oc.byProject || {})) {
    const p = (byProject[proj] ||= { out: 0, msgs: 0, tools: 0, agents: 0, sessions: 0, lastTs: null, recentOut: 0, recentDays: 0 });
    p.out += v.out;
    p.msgs += v.msgs;
    p.tools += v.tools;
    p.agents += v.agents;
    p.sessions += v.sessions;
    if (v.lastTs && (!p.lastTs || v.lastTs > p.lastTs)) p.lastTs = v.lastTs;
    // opencode/codex adapters don't bucket recent output; approximate "active"
    // from lastTs so a recently-used non-Claude workspace still shows up. Their
    // lastTs is epoch-ms (codex: updated_at_ms, opencode: time_updated), NOT an
    // ISO string, so normalize to a local-day key before comparing to the
    // YYYY-MM-DD cutoff (a raw string-prefix compare would always be false).
    if (v.recentOut) p.recentOut += v.recentOut;
    else if (recentCutoffDay && v.lastTs) {
      const day = new Date(v.lastTs).toLocaleDateString('en-CA');
      if (day >= recentCutoffDay) p.recentOut += v.out;
    }
    if (v.recentDays) p.recentDays += v.recentDays;
  }
}
