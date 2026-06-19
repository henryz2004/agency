// live.js — discover currently-running Claude Code sessions ("agents on the
// floor"). Claude Code writes a heartbeat file per process at
// ~/.claude/sessions/<pid>.json containing startedAt, status (busy/idle), cwd,
// and kind. We validate each against a live PID, derive uptime, and look up the
// session's current model from the tail of its transcript.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { getOpenCodeLive } from './opencode.js';

const HOME = os.homedir();
const SESSIONS_DIR = path.join(HOME, '.claude', 'sessions');
const PROJECTS_DIR = path.join(HOME, '.claude', 'projects');
const TEAMS_DIR = path.join(HOME, '.claude', 'teams');

// Is a PID currently alive? Signal 0 performs error checking without sending.
function isAlive(pid) {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM'; // exists but not ours
  }
}

// session meta cache: sessionId -> { file, mtime, meta }
const metaCache = new Map();

// Factory (not a shared constant) so no two agents alias the same subagents array.
const emptyMeta = () => ({ model: null, aiTitle: null, lastPrompt: null, subagents: [] });

function truncate(s, n) {
  if (!s) return null;
  const clean = String(s).replace(/\s+/g, ' ').trim();
  return clean.length > n ? clean.slice(0, n - 1) + '…' : clean;
}

// Scan the trailing chunk of a transcript (cheap; avoids loading huge files) for
// the session's current model, AI-generated chat title, last user prompt, and
// any subagents spawned but not yet returned (i.e. still running). Subagents are
// `Task`/`Agent` tool_use blocks whose tool_use id has no matching tool_result.
function readSessionMeta(file) {
  const meta = { model: null, aiTitle: null, lastPrompt: null, subagents: [] };
  let fd;
  try {
    const st = fs.statSync(file);
    const len = Math.min(st.size, 256 * 1024);
    const buf = Buffer.alloc(len);
    fd = fs.openSync(file, 'r');
    fs.readSync(fd, buf, 0, len, st.size - len);
    const lines = buf.toString('utf8').split('\n');

    const spawned = new Map(); // tool_use id -> subagent type
    const finished = new Set(); // tool_use ids that have returned

    for (const line of lines) {
      if (!line) continue;
      // cheap prefilter — skip the overwhelming majority of lines
      if (
        line.indexOf('"model"') === -1 &&
        line.indexOf('"aiTitle"') === -1 &&
        line.indexOf('"lastPrompt"') === -1 &&
        line.indexOf('"tool_use"') === -1 &&
        line.indexOf('"tool_result"') === -1
      )
        continue;
      let o;
      try {
        o = JSON.parse(line);
      } catch {
        continue; // partial line at the head of the tail window
      }

      if (o.type === 'ai-title' && o.aiTitle) {
        meta.aiTitle = o.aiTitle;
        continue;
      }
      if (o.type === 'last-prompt' && o.lastPrompt) {
        meta.lastPrompt = o.lastPrompt;
        continue;
      }

      const content = o.message && Array.isArray(o.message.content) ? o.message.content : null;
      if (!content) continue;

      if (o.type === 'assistant') {
        if (o.message.model) meta.model = o.message.model;
        for (const b of content) {
          if (b && b.type === 'tool_use' && (b.name === 'Agent' || b.name === 'Task') && b.id) {
            const inp = b.input || {};
            spawned.set(b.id, inp.subagent_type || inp.agentType || 'agent');
          }
        }
      } else if (o.type === 'user') {
        for (const b of content) {
          if (b && b.type === 'tool_result' && b.tool_use_id) finished.add(b.tool_use_id);
        }
      }
    }

    for (const [id, type] of spawned) {
      if (!finished.has(id)) meta.subagents.push({ type });
    }
  } catch {
    /* ignore */
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
  meta.lastPrompt = truncate(meta.lastPrompt, 80);
  return meta;
}

// Resolve a session's transcript file (named <sessionId>.jsonl under the
// projects dir) and return its meta, cached by mtime.
function sessionMetaFor(sessionId, cwd) {
  // Prefer the project dir derived from cwd (Claude encodes path with dashes).
  const candidates = [];
  if (cwd) {
    const encoded = cwd.replace(/[/.]/g, '-');
    candidates.push(path.join(PROJECTS_DIR, encoded, `${sessionId}.jsonl`));
  }

  let file = candidates.find((f) => fs.existsSync(f));
  if (!file) {
    try {
      for (const dir of fs.readdirSync(PROJECTS_DIR)) {
        const f = path.join(PROJECTS_DIR, dir, `${sessionId}.jsonl`);
        if (fs.existsSync(f)) {
          file = f;
          break;
        }
      }
    } catch {
      /* ignore */
    }
  }
  if (!file) return emptyMeta();

  let mtime = 0;
  try {
    mtime = fs.statSync(file).mtimeMs;
  } catch {
    return emptyMeta();
  }

  const cached = metaCache.get(sessionId);
  if (cached && cached.file === file && cached.mtime === mtime) return cached.meta;

  const meta = readSessionMeta(file);
  metaCache.set(sessionId, { file, mtime, meta });
  return meta;
}

// Count multi-member teams (orchestrations) currently configured.
function readTeams() {
  const teams = [];
  let dirs;
  try {
    dirs = fs.readdirSync(TEAMS_DIR);
  } catch {
    return teams;
  }
  for (const d of dirs) {
    const cfg = path.join(TEAMS_DIR, d, 'config.json');
    try {
      const o = JSON.parse(fs.readFileSync(cfg, 'utf8'));
      const members = Array.isArray(o.members) ? o.members : [];
      teams.push({
        name: o.name || d,
        createdAt: o.createdAt || null,
        leadSessionId: o.leadSessionId || null,
        members: members.map((m) => ({
          name: m.name,
          agentType: m.agentType,
          cwd: m.cwd,
          joinedAt: m.joinedAt,
        })),
      });
    } catch {
      /* skip */
    }
  }
  return teams;
}

// Granular activity from the per-pid heartbeat file: busy | shell | idle.
// `claude agents --json` collapses busy+shell into "busy", so we read the file
// to tell "the model is generating" (busy) from "a command is running" (shell).
function fileStatusFor(pid) {
  try {
    const o = JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, `${pid}.json`), 'utf8'));
    return o.status || null;
  } catch {
    return null;
  }
}

// Resolve the three-way activity from the coarse CLI status + granular file status.
function activityFor(rawStatus, fileStatus) {
  // CLI treats anything not explicitly "idle" as busy (a turn is in progress).
  const inTurn = rawStatus != null && rawStatus !== 'idle';
  if (!inTurn) return 'idle';
  if (fileStatus === 'shell') return 'shell'; // a command is running, model isn't generating
  if (fileStatus === 'idle') return 'idle'; // file is more granular than the CLI here
  return 'working'; // file "busy" or missing → model generating
}

// Normalize one raw session record into a dashboard agent.
function buildAgent(r, now) {
  const startedAt = r.startedAt || null;
  const meta = r.sessionId ? sessionMetaFor(r.sessionId, r.cwd) : emptyMeta();
  const fileStatus = fileStatusFor(r.pid);
  const activity = activityFor(r.status, fileStatus);
  return {
    pid: r.pid,
    sessionId: r.sessionId || null,
    source: 'claude',
    cwd: r.cwd || null,
    project: r.cwd ? path.basename(r.cwd) : 'unknown',
    kind: r.kind || 'interactive',
    activity, // 'working' | 'shell' | 'idle'
    status: activity === 'working' ? 'busy' : 'idle', // coarse, kept for reference
    state: r.state || null, // e.g. "done" for finished background agents
    task: r.task || null, // CLI-provided task name (background agents)
    chatName: meta.aiTitle || null, // the session's AI-generated chat title
    lastPrompt: meta.lastPrompt || null, // fallback label: last user prompt
    subagents: meta.subagents || [], // currently-running subagents
    startedAt,
    uptimeMs: startedAt ? Math.max(0, now - startedAt) : null,
    model: meta.model || null,
  };
}

// Source of truth: `claude agents --json` reads live IPC state, so its
// busy/idle status is accurate even for long-running turns (unlike the session
// heartbeat files, whose statusUpdatedAt only marks the last status *change*).
function agentsFromCli() {
  try {
    const out = execFileSync('claude', ['agents', '--json'], {
      timeout: 4000,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const arr = JSON.parse(out);
    if (!Array.isArray(arr)) return null;
    return arr.map((a) => ({
      pid: a.pid,
      sessionId: a.sessionId,
      cwd: a.cwd,
      kind: a.kind,
      startedAt: a.startedAt,
      status: a.status,
      state: a.state,
      task: a.name,
    }));
  } catch {
    return null; // fall back to session files
  }
}

// Fallback: read ~/.claude/sessions/<pid>.json and validate liveness. We trust
// the file's reported status directly (no staleness override).
function agentsFromSessionFiles() {
  const list = [];
  let files;
  try {
    files = fs.readdirSync(SESSIONS_DIR);
  } catch {
    return list;
  }
  for (const f of files) {
    if (!f.endsWith('.json')) continue;
    let o;
    try {
      o = JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, f), 'utf8'));
    } catch {
      continue;
    }
    if (!o.pid || !isAlive(o.pid)) continue;
    list.push({
      pid: o.pid,
      sessionId: o.sessionId,
      cwd: o.cwd,
      kind: o.kind,
      startedAt: o.startedAt,
      status: o.status,
      state: o.state, // session files don't carry these today, but keep the
      task: o.name, // shape consistent with the CLI path (defaults to null)
    });
  }
  return list;
}

export function getLive() {
  const now = Date.now();
  const raw = agentsFromCli() || agentsFromSessionFiles();
  const claudeAgents = raw
    .filter((r) => r && r.pid)
    .map((r) => buildAgent(r, now));

  const oc = getOpenCodeLive();
  const allAgents = [...claudeAgents, ...oc.agents]
    .sort((a, b) => (b.uptimeMs || 0) - (a.uptimeMs || 0));

  return { agents: allAgents, teams: readTeams(), now };
}
