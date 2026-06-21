import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';

const HOME = os.homedir();
const DB_PATH = path.join(HOME, '.local', 'share', 'opencode', 'opencode.db');

function dbExists() {
  try {
    fs.accessSync(DB_PATH);
    return true;
  } catch {
    return false;
  }
}

function escId(s) {
  return String(s).replace(/'/g, "''");
}

function query(sql) {
  if (!dbExists()) return [];
  try {
    const out = execFileSync('sqlite3', [DB_PATH, '-cmd', '.timeout 3000', '-json', sql], {
      timeout: 4000,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    if (!out.trim()) return [];
    return JSON.parse(out);
  } catch {
    return [];
  }
}

const AGENTS_DIR = path.join(HOME, '.local', 'share', 'opencode', 'agents');

function isAlive(pid) {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

function getLiveFromHeartbeats(now) {
  let files;
  try {
    files = fs.readdirSync(AGENTS_DIR);
  } catch {
    return null;
  }

  const jsonFiles = files.filter((f) => f.endsWith('.json'));
  if (!jsonFiles.length) return null; // no plugin installed yet — fall back to DB

  const agents = [];
  for (const f of jsonFiles) {
    let hb;
    try {
      hb = JSON.parse(fs.readFileSync(path.join(AGENTS_DIR, f), 'utf8'));
    } catch {
      continue;
    }

    if (!isAlive(hb.pid)) {
      try { fs.unlinkSync(path.join(AGENTS_DIR, f)); } catch {}
      continue;
    }

    const cwd = hb.cwd || null;
    const activity = hb.status === 'idle' ? 'idle' : 'working';
    const startedAt = hb.startedAt || null;

    agents.push({
      pid: hb.pid,
      sessionId: hb.sessionId || null,
      source: 'opencode',
      cwd,
      project: cwd ? path.basename(cwd) : 'unknown',
      kind: hb.agent || 'interactive',
      activity,
      status: activity === 'working' ? 'busy' : 'idle',
      state: null,
      needsYou: false,
      task: hb.title || null,
      chatName: hb.title || null,
      lastPrompt: null,
      subagents: [],
      startedAt,
      uptimeMs: startedAt ? Math.max(0, now - startedAt) : null,
      model: hb.model || null,
      provider: hb.provider || null,
    });
  }

  return agents.length ? agents : [];
}

function activityFor(sessionId) {
  const rows = query(
    `SELECT json_extract(data, '$.type') as ptype, json_extract(data, '$.state.status') as status ` +
    `FROM part WHERE session_id = '${escId(sessionId)}' ` +
    `ORDER BY time_created DESC LIMIT 20`
  );
  for (const r of rows) {
    if (r.ptype === 'tool' && r.status === 'running') return 'shell';
    if (r.ptype === 'step-start') return 'working';
    if (r.ptype === 'step-finish') return 'idle';
  }
  return 'idle';
}

export function getOpenCodeLive() {
  const now = Date.now();

  const heartbeatAgents = getLiveFromHeartbeats(now);
  if (heartbeatAgents) {
    return { agents: heartbeatAgents, now };
  }

  const staleCutoff = now - 30 * 60 * 1000;
  const sessions = query(
    `SELECT id, title, model, directory, agent, tokens_input, tokens_output, ` +
    `tokens_cache_read, tokens_cache_write, tokens_reasoning, cost, ` +
    `time_created, time_updated ` +
    `FROM session WHERE time_archived IS NULL AND time_updated > ${staleCutoff} ORDER BY time_updated DESC`
  );
  if (!sessions.length) return { agents: [], now };

  const agents = sessions.map((s) => {
    let modelObj = {};
    try { modelObj = JSON.parse(s.model || '{}'); } catch { /* ignore */ }
    const modelId = modelObj.id || 'unknown';
    const provider = modelObj.providerID || '';
    const startedAt = s.time_created;
    const uptimeMs = startedAt ? Math.max(0, now - startedAt) : null;
    const activity = activityFor(s.id);
    const cwd = s.directory || null;

    const titleRows = query(
      `SELECT substr(json_extract(data, '$.text'), 1, 80) as txt ` +
      `FROM part WHERE session_id = '${escId(s.id)}' AND json_extract(data, '$.type') = 'text' ` +
      `ORDER BY time_created DESC LIMIT 1`
    );
    const lastPrompt = titleRows.length ? titleRows[0].txt : null;

    return {
      pid: null,
      sessionId: s.id,
      source: 'opencode',
      cwd,
      project: cwd ? path.basename(cwd) : 'unknown',
      kind: s.agent || 'interactive',
      activity,
      status: activity === 'working' ? 'busy' : 'idle',
      state: null,
      needsYou: false,
      task: s.title || null,
      chatName: s.title || null,
      lastPrompt,
      subagents: [],
      startedAt,
      uptimeMs,
      model: modelId,
      provider,
    };
  });

  return { agents, now };
}

// ---- usage -----------------------------------------------------------------

const DATA_DIR = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'data');
const CACHE_PATH = path.join(DATA_DIR, 'opencode-usage-cache.json');

let cache = { version: 2, lastDbMtime: 0, sessions: {} };
let loaded = false;

function loadCache() {
  try {
    const raw = JSON.parse(fs.readFileSync(CACHE_PATH, 'utf8'));
    if (raw && raw.version === cache.version) cache = raw;
  } catch { /* no cache yet */ }
}

function saveCache() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(CACHE_PATH, JSON.stringify(cache));
  } catch { /* best effort */ }
}

function localDay(ts) {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString('en-CA');
}

function emptyDay() {
  return { out: 0, in: 0, cr: 0, cc: 0, tools: 0, msgs: 0, agents: 0 };
}

function parseSession(s) {
  let modelObj = {};
  try { modelObj = JSON.parse(s.model || '{}'); } catch { /* ignore */ }
  const modelId = modelObj.id || 'unknown';

  const parts = query(
    `SELECT json_extract(data, '$.type') as ptype, ` +
    `json_extract(data, '$.tokens.input') as tok_in, ` +
    `json_extract(data, '$.tokens.output') as tok_out, ` +
    `json_extract(data, '$.tokens.cache.read') as tok_cr, ` +
    `json_extract(data, '$.tokens.cache.write') as tok_cc, ` +
    `json_extract(data, '$.tokens.reasoning') as tok_reason, ` +
    `json_extract(data, '$.tool') as tool_name, ` +
    `json_extract(data, '$.text') as txt, ` +
    `time_created ` +
    `FROM part WHERE session_id = '${escId(s.id)}' ` +
    `AND json_extract(data, '$.type') IN ('step-finish', 'tool') ` +
    `ORDER BY time_created ASC`
  );

  const agg = {
    days: {},
    models: {},
    project: s.directory ? path.basename(s.directory) : 'unknown',
    cwd: s.directory || null,
    sessionId: s.id,
    firstTs: s.time_created,
    lastTs: s.time_updated,
    out: 0,
    in: 0,
    cr: 0,
    cc: 0,
    tools: 0,
    msgs: 0,
    agents: 0,
  };

  for (const p of parts) {
    const ts = p.time_created;
    if (!ts) continue;

    if (p.ptype === 'step-finish') {
      const out = p.tok_out || 0;
      const inp = p.tok_in || 0;
      const cr = p.tok_cr || 0;
      const cc = p.tok_cc || 0;

      agg.out += out;
      agg.in += inp;
      agg.cr += cr;
      agg.cc += cc;
      agg.msgs += 1;

      const day = localDay(ts);
      if (day) {
        const d = (agg.days[day] ||= emptyDay());
        d.out += out;
        d.in += inp;
        d.cr += cr;
        d.cc += cc;
        d.msgs += 1;
      }

      if (!agg.models[modelId]) agg.models[modelId] = { out: 0, in: 0, msgs: 0 };
      agg.models[modelId].out += out;
      agg.models[modelId].in += inp;
      agg.models[modelId].msgs += 1;
    }

    if (p.ptype === 'tool') {
      agg.tools += 1;
      const toolName = p.tool_name || '';
      if (toolName === 'task' || toolName === 'agent') agg.agents += 1;
      const day = localDay(ts);
      if (day) {
        const d = (agg.days[day] ||= emptyDay());
        d.tools += 1;
        if (toolName === 'task' || toolName === 'agent') d.agents += 1;
      }
    }
  }

  return agg;
}

export function getOpenCodeUsage() {
  if (!dbExists()) return null;

  if (!loaded) {
    loadCache();
    loaded = true;
  }

  let dbMtime = 0;
  try {
    dbMtime = fs.statSync(DB_PATH).mtimeMs;
  } catch { /* ignore */ }

  if (dbMtime !== cache.lastDbMtime) {
    const sessions = query(
      `SELECT id, title, model, directory, tokens_input, tokens_output, ` +
      `tokens_cache_read, tokens_cache_write, tokens_reasoning, cost, ` +
      `time_created, time_updated ` +
      `FROM session ORDER BY time_updated ASC`
    );

    const seen = new Set();
    for (const s of sessions) {
      seen.add(s.id);
      const prev = cache.sessions[s.id];
      if (prev && prev.updatedAt === s.time_updated) continue;
      cache.sessions[s.id] = {
        updatedAt: s.time_updated,
        agg: parseSession(s),
      };
    }
    for (const id of Object.keys(cache.sessions)) {
      if (!seen.has(id)) delete cache.sessions[id];
    }
    cache.lastDbMtime = dbMtime;
    saveCache();
  }

  return combine();
}

function combine() {
  const lifetime = { out: 0, in: 0, cr: 0, cc: 0, tools: 0, msgs: 0, agents: 0, sessions: 0 };
  const dayMap = {};
  const byModel = {};
  const byProject = {};

  for (const { agg } of Object.values(cache.sessions)) {
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
    const p = (byProject[proj] ||= { out: 0, msgs: 0, tools: 0, agents: 0, sessions: 0, lastTs: null });
    p.out += agg.out;
    p.msgs += agg.msgs;
    p.tools += agg.tools;
    p.agents += agg.agents;
    p.sessions += 1;
    if (agg.lastTs && (!p.lastTs || agg.lastTs > p.lastTs)) p.lastTs = agg.lastTs;
  }

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
  };
}