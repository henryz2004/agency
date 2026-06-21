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
import { getCodexLive } from './codex.js';

const HOME = os.homedir();
const SESSIONS_DIR = path.join(HOME, '.claude', 'sessions');
const PROJECTS_DIR = path.join(HOME, '.claude', 'projects');
const TEAMS_DIR = path.join(HOME, '.claude', 'teams');

// Codex has no live IPC ground truth — its liveness is inferred from a rolling
// 30-min DB window (codex.js), so agents flicker on/off and report conversation
// age as "uptime". It can't hit the accuracy bar, so it's benched from the LIVE
// floor. Historical token usage stays accurate via getCodexUsage()/mergeUsage in
// usage.js — only the live floor is gated here. Flip to true to restore codex
// agents on the floor (one edit, no other change needed).
const CODEX_LIVE = false;

// Terminal background-agent states. `claude agents --json` keeps a FINISHED
// background agent in its listing with state ∈ done|failed|stopped; such an
// agent must NOT render as a live worker. This gate is state-only; the separate
// `r.pid && isAlive` gate below independently drops any row lacking a live pid —
// so a pid-less `blocked` (waiting-on-user) background agent is currently
// excluded too. Surfacing those is a deferred "paused agent" item. Interactive
// rows carry state:null and are never matched here.
const DONE_STATES = new Set(['done', 'failed', 'stopped']);
const isDoneState = (s) => !!s && DONE_STATES.has(String(s).toLowerCase());

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
const emptyMeta = () => ({ model: null, aiTitle: null, lastPrompt: null, subagents: [], teammates: [] });

function truncate(s, n) {
  if (!s) return null;
  const clean = String(s).replace(/\s+/g, ' ').trim();
  return clean.length > n ? clean.slice(0, n - 1) + '…' : clean;
}

// Scan the trailing chunk of a transcript (cheap; avoids loading huge files) for
// the session's current model, AI-generated chat title, last user prompt, plus
// two kinds of spawned agent:
//   - foreground subagents — `Task`/`Agent` tool_use WITHOUT run_in_background.
//     Still-running ones (no matching tool_result) cluster as minions.
//   - in-process teammates — `Agent` tool_use WITH run_in_background:true. These
//     have no pid/heartbeat/transcript of their own; they live in the team
//     config. We record their name/type here and surface them as INDIVIDUAL
//     workers (liveness comes from the team config + live lead, NOT the
//     unmatched-id test — a background spawn returns its tool_result immediately
//     while the teammate keeps working).
function readSessionMeta(file) {
  const meta = { model: null, aiTitle: null, lastPrompt: null, subagents: [], teammates: [] };
  let fd;
  try {
    const st = fs.statSync(file);
    const len = Math.min(st.size, 256 * 1024);
    const buf = Buffer.alloc(len);
    fd = fs.openSync(file, 'r');
    fs.readSync(fd, buf, 0, len, st.size - len);
    const lines = buf.toString('utf8').split('\n');

    const spawned = new Map(); // tool_use id -> subagent type (foreground only)
    const finished = new Set(); // tool_use ids that have returned
    const teammates = new Map(); // teammate name -> subagent type (background)

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
            const type = inp.subagent_type || inp.agentType || 'agent';
            if (inp.run_in_background === true) {
              // background teammate — keyed by the launch name so the team
              // config can enrich it (color/model) downstream.
              if (inp.name) teammates.set(inp.name, type);
            } else {
              spawned.set(b.id, type);
            }
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
    for (const [name, type] of teammates) {
      meta.teammates.push({ name, type });
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

// Read the configured teams (orchestrations). Each team's config.json is the
// orchestration record: a lead (agentType:"team-lead") plus in-process member
// teammates. We keep the per-member enrichment (color/model/agentType/prompt)
// so getLive() can render background teammates as individual, well-dressed
// workers and mark the lead distinctly. Fail soft — a missing dir/file yields
// no teams, never throws.
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
        leadAgentId: o.leadAgentId || null,
        leadSessionId: o.leadSessionId || null,
        members: members.map((m) => ({
          agentId: m.agentId || null,
          name: m.name,
          color: m.color || null,
          model: m.model || null,
          agentType: m.agentType,
          prompt: m.prompt || null,
          backendType: m.backendType || null,
          cwd: m.cwd,
          joinedAt: m.joinedAt,
          isLead: m.agentType === 'team-lead',
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
    role: null, // 'lead' once we match this session to a team's lead (below)
    teamColor: null, // member.color word, for background teammates only
  };
}

// Synthesize an INDIVIDUAL worker agent for an in-process teammate (a member
// launched via the Agent tool with run_in_background:true). It has no pid /
// heartbeat / transcript, so we mint a stable synthetic identity from its
// agentId and take its liveness from the live lead it belongs to. Shape matches
// buildAgent() so the merge + frontend treat it like any other worker.
function buildTeammate(member, lead, type, now) {
  return {
    pid: null,
    sessionId: member.agentId || `${member.name}@${lead.sessionId}`, // stable key
    source: 'claude',
    cwd: member.cwd || lead.cwd || null,
    project: member.cwd ? path.basename(member.cwd) : lead.project,
    kind: 'teammate',
    activity: lead.activity === 'working' ? 'working' : 'idle', // no per-agent signal; mirror the lead's pulse
    status: 'idle',
    state: null,
    task: null,
    chatName: null,
    lastPrompt: truncate(member.prompt, 80), // its launch brief is the best label we have
    subagents: [],
    startedAt: member.joinedAt || lead.startedAt || null,
    uptimeMs: member.joinedAt ? Math.max(0, now - member.joinedAt) : lead.uptimeMs,
    model: member.model || null,
    role: 'teammate',
    teamColor: member.color || null,
    teammateName: member.name || null, // config label ("cc-internals"), preserved over the roster name
    teammateType: type || member.agentType || null, // subagent_type ("general-purpose")
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

// Expand teams into individual agents: mark any live session that is a team's
// lead with role:'lead', and synthesize one individual worker per in-process
// teammate it launched.
//
// LIVENESS: a teammate surfaces only when BOTH the team config lists it AND the
// lead's recent transcript shows a run_in_background launch of that name. The
// lead being in claudeAgents already proves the lead is alive; the launch's
// presence in the transcript tail is our "still active" proxy. We need the
// transcript signal because the team config is APPEND-ONLY — members are never
// removed when they finish, so config membership alone would resurface every
// teammate the lead ever spawned as a permanent ghost worker. Because
// readSessionMeta only scans the trailing 256 KB, a completed teammate's launch
// naturally ages out of the window and it drops off the floor; a long-idle but
// not-yet-finished teammate could age out too (see report — heuristic fork).
// This deliberately does NOT use the unmatched tool_use→tool_result test (a
// background spawn returns its tool_result immediately while the teammate keeps
// working). Fail soft: no teams / no match → leads & teammates just don't appear.
function expandTeams(claudeAgents, teams, now) {
  const byLeadSession = new Map();
  for (const t of teams) {
    if (t.leadSessionId) byLeadSession.set(t.leadSessionId, t);
  }
  if (byLeadSession.size === 0) return [];

  const extra = [];
  for (const lead of claudeAgents) {
    const team = lead.sessionId ? byLeadSession.get(lead.sessionId) : null;
    if (!team) continue;
    const workers = team.members.filter((m) => !m.isLead);
    if (workers.length === 0) continue;

    lead.role = 'lead'; // the orchestrator/PM — rendered distinctly

    // Which teammates the lead recently launched in the background (by name).
    const meta = sessionMetaFor(lead.sessionId, lead.cwd);
    const launched = new Map((meta.teammates || []).map((tm) => [tm.name, tm.type]));
    const seen = new Set(); // a name appears once even if the config lists it twice
    for (const m of workers) {
      if (m.backendType !== 'in-process') continue; // real bg jobs already appear via the CLI
      if (!launched.has(m.name) || seen.has(m.name)) continue; // config-only / aged out / dup
      seen.add(m.name);
      extra.push(buildTeammate(m, lead, launched.get(m.name), now));
    }
  }
  return extra;
}

export function getLive() {
  const now = Date.now();
  const raw = agentsFromCli() || agentsFromSessionFiles();
  // "Live" = a session whose pid the OS still confirms (isAlive guards both the
  // CLI and the session-file path against a dead pid leaking through) AND that
  // isn't a finished background agent (done/failed/stopped). Everything that
  // survives is a genuinely-running interactive session or an actively-running
  // (or user-blocked) background agent.
  const claudeAgents = raw
    .filter((r) => r && r.pid && isAlive(r.pid) && !isDoneState(r.state))
    .map((r) => buildAgent(r, now));

  const teams = readTeams();
  const teammates = expandTeams(claudeAgents, teams, now);

  const oc = getOpenCodeLive();
  const codex = CODEX_LIVE ? getCodexLive() : { agents: [] };
  const allAgents = [...claudeAgents, ...teammates, ...oc.agents, ...codex.agents]
    .sort((a, b) => (b.uptimeMs || 0) - (a.uptimeMs || 0));

  return { agents: allAgents, teams, now };
}
