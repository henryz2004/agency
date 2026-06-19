import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';

const HOME = os.homedir();
const PROCESS_PATH = path.join(HOME, '.codex', 'process_manager', 'chat_processes.json');
const DB_PATH = path.join(HOME, '.codex', 'state_5.sqlite');

function isAlive(pid) {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

function dbExists() {
  try {
    fs.accessSync(DB_PATH);
    return true;
  } catch {
    return false;
  }
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

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function parseModel(raw) {
  if (!raw) return { id: null, provider: null };
  if (typeof raw === 'object') {
    return {
      id: raw.id || raw.name || null,
      provider: raw.providerID || raw.provider || null,
    };
  }
  const trimmed = String(raw).trim();
  if (!trimmed) return { id: null, provider: null };
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      return parseModel(JSON.parse(trimmed));
    } catch {
      return { id: trimmed, provider: null };
    }
  }
  return { id: trimmed, provider: null };
}

function localDay(ts) {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString('en-CA');
}

function emptyDay() {
  return { out: 0, in: 0, cr: 0, cc: 0, tools: 0, msgs: 0, agents: 0 };
}

function openSubagentCount(id) {
  const rows = query(
    `SELECT count(*) AS n FROM thread_spawn_edges ` +
    `WHERE parent_thread_id = '${String(id).replace(/'/g, "''")}' AND status = 'open'`
  );
  return rows.length ? Number(rows[0].n || 0) : 0;
}

export function getCodexLive() {
  const now = Date.now();
  const processes = readJson(PROCESS_PATH, []);
  const procById = new Map(
    Array.isArray(processes)
      ? processes.map((p) => [p.conversationId || null, p]).filter(([id]) => id)
      : []
  );

  const cutoff = now - 30 * 60 * 1000;
  const rows = query(
    `SELECT id, title, preview, model, cwd, tokens_used, created_at_ms, updated_at_ms, model_provider, thread_source, agent_nickname, agent_role ` +
    `FROM threads WHERE archived = 0 AND updated_at_ms > ${cutoff} ORDER BY updated_at_ms DESC`
  );

  const agents = rows
    .map((thread) => {
      const p = procById.get(thread.id) || {};
      const pid = p.osPid || p.pid || null;
      if (pid && !isAlive(pid)) return null;

      const model = parseModel(thread.model);
      const startedAt = thread.created_at_ms || p.startedAtMs || null;
      const updatedAt = thread.updated_at_ms || p.updatedAtMs || startedAt || null;
      const staleMs = updatedAt ? now - updatedAt : Number.POSITIVE_INFINITY;
      const activity = staleMs <= 2 * 60 * 1000 ? 'working' : 'idle';
      const cwd = thread.cwd || p.cwd || null;
      const project = cwd ? path.basename(cwd) : 'unknown';
      const subagents = openSubagentCount(thread.id);

      return {
        pid,
        sessionId: thread.id,
        source: 'codex',
        cwd,
        project,
        kind: 'interactive',
        activity,
        status: activity === 'working' ? 'busy' : 'idle',
        state: null,
        task: thread.title || p.command || null,
        chatName: thread.title || p.chatTitle || null,
        lastPrompt: thread.preview || p.command || null,
        subagents: Array.from({ length: subagents }, () => ({ type: 'agent' })),
        startedAt,
        uptimeMs: startedAt ? Math.max(0, now - startedAt) : null,
        model: model.id || null,
        modelSlug: typeof thread.model === 'string' ? thread.model : model.id || null,
        provider: model.provider || thread.model_provider || null,
        title: thread.agent_role || thread.agent_nickname || null,
      };
    })
    .filter(Boolean)
    .sort((a, b) => (b.uptimeMs || 0) - (a.uptimeMs || 0));

  return { agents, now };
}

export function getCodexUsage() {
  if (!dbExists()) return null;

  const rows = query(
    `SELECT id, cwd, title, preview, model, tokens_used, created_at_ms, updated_at_ms, ` +
    `(SELECT count(*) FROM thread_spawn_edges e WHERE e.parent_thread_id = threads.id AND e.status = 'open') AS open_children ` +
    `FROM threads ORDER BY updated_at_ms ASC`
  );

  const lifetime = { out: 0, in: 0, cr: 0, cc: 0, tools: 0, msgs: 0, agents: 0, sessions: 0 };
  const dayMap = {};
  const byModel = {};
  const byProject = {};

  for (const row of rows) {
    const out = Number(row.tokens_used || 0);
    const startedAt = row.created_at_ms || row.updated_at_ms || null;
    const day = startedAt ? localDay(startedAt) : null;
    const model = parseModel(row.model).id || 'unknown';
    const project = row.cwd ? path.basename(row.cwd) : 'unknown';
    const agents = Number(row.open_children || 0);

    lifetime.out += out;
    lifetime.msgs += 1;
    lifetime.agents += agents;
    lifetime.sessions += 1;

    if (day) {
      const d = (dayMap[day] ||= emptyDay());
      d.out += out;
      d.msgs += 1;
      d.agents += agents;
    }

    if (!byModel[model]) byModel[model] = { out: 0, in: 0, msgs: 0 };
    byModel[model].out += out;
    byModel[model].msgs += 1;

    const p = (byProject[project] ||= { out: 0, msgs: 0, tools: 0, agents: 0, sessions: 0, lastTs: null });
    p.out += out;
    p.msgs += 1;
    p.agents += agents;
    p.sessions += 1;
    if (row.updated_at_ms && (!p.lastTs || row.updated_at_ms > p.lastTs)) p.lastTs = row.updated_at_ms;
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
