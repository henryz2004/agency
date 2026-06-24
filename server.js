#!/usr/bin/env node
// server.js — zero-dependency HTTP server for Agency.
// Serves the static frontend and a single /api/state endpoint that fuses live
// running sessions with historical usage stats and stable agent identities.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { getUsage } from './lib/usage.js';
import { getLive } from './lib/live.js';
import { identityFor, overrideFor, setOverride } from './lib/roster.js';
import { getTranscript } from './lib/transcript.js';
import * as control from './lib/control.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(__dirname, 'public');
const PORT = process.env.PORT ? Number(process.env.PORT) : 4313;
const HOST = process.env.HOST || '127.0.0.1';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.mp3': 'audio/mpeg',
};

function buildState() {
  const usage = getUsage();
  const live = getLive();

  // Which sessions are paused on a Stop hook, waiting for a reply (Control
  // Phase-1). Folded onto matching live agents as awaitingReply / pendingSince
  // so the frontend HUD + render.js "needs you" indicator can read it. The
  // agent shape is otherwise unchanged.
  const waiting = control.list();

  // Attach a stable identity to each live agent. In-process teammates keep
  // their team-config label + subagent_type as name/title (the roster still
  // supplies a stable avatar palette + hire date), so "cc-internals" reads as
  // itself rather than a roster-minted persona.
  const agents = live.agents.map((a) => {
    const ident = identityFor(a.sessionId, a.model, a.startedAt);
    const w = a.sessionId ? waiting[a.sessionId] : null;
    const ctrl = w ? { awaitingReply: true, pendingSince: w.since } : null;
    // User overrides (rename / hide), persisted per sessionId. A custom name
    // wins over the minted persona AND the teammate label; `hidden` is carried
    // on EVERY agent (default false) so consumers never see undefined.
    const ov = overrideFor(a.sessionId);
    if (a.role === 'teammate') {
      return {
        ...a,
        ...ident,
        ...ctrl,
        name: ov.name || a.teammateName || ident.name,
        title: a.teammateType || ident.title,
        hidden: ov.hidden,
      };
    }
    return { ...a, ...ident, ...ctrl, name: ov.name || ident.name, hidden: ov.hidden };
  });

  return {
    generatedAt: Date.now(),
    live: { agents, teams: live.teams, now: live.now },
    usage,
  };
}

function sendJSON(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function serveStatic(req, res) {
  let urlPath = decodeURIComponent(req.url.split('?')[0]);
  if (urlPath === '/') urlPath = '/index.html';
  const filePath = path.normalize(path.join(PUBLIC, urlPath));
  if (filePath !== PUBLIC && !filePath.startsWith(PUBLIC + path.sep)) {
    res.writeHead(403);
    res.end('forbidden');
    return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end('not found');
      return;
    }
    const ext = path.extname(filePath);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
}

// Open a new Terminal window running `claude --resume <id>` in the agent's cwd.
// macOS-only (osascript → Terminal.app). ponytail: Terminal.app is hardcoded;
// swap the AppleScript target if you live in iTerm. sessionId is charset-checked
// by the caller and cwd is single-quoted, then both layers are escaped for the
// AppleScript string so a weird path can't break out of it.
function openResumeTerminal(sessionId, cwd, kind, cb) {
  // A running BACKGROUND agent can't be `--resume`d (the CLI refuses — it's
  // already live); you attach to it via the agent manager. Interactive sessions
  // resume directly. ponytail: `claude agents` is a picker (no per-id attach in
  // this CLI); --cwd scopes it to this project so the agent is easy to find.
  const bg = kind === 'background' || kind === 'bg';
  const inner = bg ? `claude agents --cwd ${shellQuote(cwd)}` : `claude --resume ${sessionId}`;
  const shellCmd = `cd ${shellQuote(cwd)} && ${inner}`;
  const appleScript = `tell application "Terminal"\nactivate\ndo script "${appleEscape(shellCmd)}"\nend tell`;
  execFile('osascript', ['-e', appleScript], (err) => cb(err));
}
const shellQuote = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
const appleEscape = (s) => String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"');

const server = http.createServer((req, res) => {
  try {
    const q = req.url.indexOf('?');
    const pathname = q === -1 ? req.url : req.url.slice(0, q);
    const query = q === -1 ? '' : req.url.slice(q + 1);
    if (pathname === '/api/state') {
      sendJSON(res, 200, buildState());
      return;
    }
    // Read-only peek at the tail of a session's transcript (for the chat panel).
    if (pathname === '/api/transcript') {
      const params = new URLSearchParams(query);
      const sessionId = params.get('sessionId');
      const cwd = params.get('cwd');
      if (!sessionId || !cwd) {
        sendJSON(res, 400, { error: 'sessionId and cwd are required' });
        return;
      }
      sendJSON(res, 200, getTranscript(sessionId, cwd));
      return;
    }
    // ACTION endpoint (the one place Agency acts instead of viewing): open a
    // terminal running `claude --resume <id>` in the agent's cwd. User-authorized;
    // it spawns osascript→Terminal but never writes the ~/.claude data sources.
    if (pathname === '/api/resume' && req.method === 'POST') {
      let body = '';
      req.on('data', (c) => {
        body += c;
        if (body.length > 4096) req.destroy(); // cap — these payloads are tiny
      });
      req.on('end', () => {
        // This async handler fires after the top-level try/catch has returned, so
        // guard it too — a throw here would otherwise crash the process (the app's
        // fail-soft charter: a bad request must never take down the server).
        try {
          let sessionId, cwd, kind;
          try {
            ({ sessionId, cwd, kind } = JSON.parse(body || '{}'));
          } catch {
            return sendJSON(res, 400, { error: 'bad json' });
          }
          // Validate HARD before building any command: sessionId to a safe charset,
          // cwd to an existing absolute path. (cwd is still shell-quoted below.)
          if (!sessionId || !/^[A-Za-z0-9._-]+$/.test(sessionId)) {
            return sendJSON(res, 400, { error: 'invalid sessionId' });
          }
          if (!cwd || typeof cwd !== 'string' || !path.isAbsolute(cwd) || !fs.existsSync(cwd)) {
            return sendJSON(res, 400, { error: 'invalid cwd' });
          }
          openResumeTerminal(sessionId, cwd, kind, (err) =>
            err ? sendJSON(res, 500, { error: String(err.message || err) }) : sendJSON(res, 200, { ok: true })
          );
        } catch (err) {
          sendJSON(res, 500, { error: String(err && err.message ? err.message : err) });
        }
      });
      return;
    }
    // CONTROL endpoint — the Stop-hook landing pad. A Claude Code Stop hook of
    // type "http" POSTs here and BLOCKS the agent until we respond; it FAILS
    // OPEN (timeout / refused / non-2xx → agent just stops). We register the
    // paused session and HOLD this response open: it's resolved either by
    // /api/reply (→ decision:"block" JSON, resuming the agent with the user's
    // instruction) or by the soft deadline (→ empty 200, agent stops normally,
    // under the 120s hook timeout). Authorized control surface, like
    // /api/resume — never writes the ~/.claude data sources.
    if (pathname === '/api/hook/stop' && req.method === 'POST') {
      let body = '';
      req.on('data', (c) => {
        body += c;
        if (body.length > 64 * 1024) req.destroy(); // cap — hook payloads are small
      });
      req.on('end', () => {
        // Fires after the top-level try/catch returns, so guard it too — a
        // throw here would crash the process (fail-soft charter: a bad hook
        // payload must never take down the server / /api/state).
        try {
          let info = {};
          try {
            info = JSON.parse(body || '{}') || {};
          } catch {
            // Malformed payload: fail open — let the agent stop normally.
            return sendJSON(res, 200, {});
          }
          const sessionId = info.session_id;
          // No usable session id: nothing to register against, fail open.
          if (!sessionId || typeof sessionId !== 'string' || !/^[A-Za-z0-9._-]+$/.test(sessionId)) {
            return sendJSON(res, 200, {});
          }
          let settled = false;
          // settle(text): text → resume with the user's instruction; null →
          // empty 200 so the agent stops. Idempotent (timeout vs reply vs close
          // race) and returns true only if it actually wrote to a live socket,
          // so control.resolve can tell a delivered reply from a dropped one.
          const settle = (text) => {
            if (settled) return false;
            settled = true;
            try {
              if (typeof text === 'string') {
                sendJSON(res, 200, {
                  decision: 'block',
                  reason: text,
                  hookSpecificOutput: { hookEventName: 'Stop', additionalContext: text },
                });
              } else {
                sendJSON(res, 200, {});
              }
              return true;
            } catch {
              return false; // connection already gone
            }
          };
          // If the client hangs up while we hold (agent killed, hook timed out
          // on its side), mark this hold settled AND drop the registry entry
          // (entry-scoped, so a superseding hold survives) — otherwise the agent
          // would keep showing awaitingReply and a late /api/reply would falsely
          // report success on a dead socket.
          res.on('close', () => {
            settled = true;
            control.cancel(sessionId, settle);
          });
          control.register(sessionId, {
            cwd: info.cwd,
            transcriptPath: info.transcript_path,
            settle,
          });
        } catch (err) {
          // Last-ditch: fail open so the agent stops rather than hanging.
          try {
            sendJSON(res, 200, {});
          } catch {
            /* ignore */
          }
        }
      });
      return;
    }
    // CONTROL endpoint — deliver the user's typed reply to a paused agent.
    // { sessionId, text }: resolves the matching held /api/hook/stop request
    // (→ resumes the agent with `text`). 404 if no agent is pending for that id.
    if (pathname === '/api/reply' && req.method === 'POST') {
      let body = '';
      req.on('data', (c) => {
        body += c;
        if (body.length > 16 * 1024) req.destroy(); // cap — text is capped to ~8KB below
      });
      req.on('end', () => {
        try {
          let sessionId, text;
          try {
            ({ sessionId, text } = JSON.parse(body || '{}'));
          } catch {
            return sendJSON(res, 400, { error: 'bad json' });
          }
          if (!sessionId || typeof sessionId !== 'string' || !/^[A-Za-z0-9._-]+$/.test(sessionId)) {
            return sendJSON(res, 400, { error: 'invalid sessionId' });
          }
          if (typeof text !== 'string' || !text.trim()) {
            return sendJSON(res, 400, { error: 'text is required' });
          }
          const reply = text.slice(0, 8 * 1024); // cap the instruction length
          const delivered = control.resolve(sessionId, reply);
          if (delivered) sendJSON(res, 200, { ok: true });
          else sendJSON(res, 404, { error: 'no agent waiting for this session' });
        } catch (err) {
          sendJSON(res, 500, { error: String(err && err.message ? err.message : err) });
        }
      });
      return;
    }
    // OVERRIDE endpoint — persist a per-session rename / hide. Authorized like
    // the other POSTs; it writes only data/roster.json (a regenerable cache),
    // never the ~/.claude data sources. Body { sessionId, name?, hidden? }:
    // name '' or null clears the rename; hidden is a boolean toggle. Only the
    // keys present in the body are applied, so a hide-toggle won't wipe a rename.
    if (pathname === '/api/agent-override' && req.method === 'POST') {
      let body = '';
      req.on('data', (c) => {
        body += c;
        if (body.length > 4096) req.destroy(); // cap — these payloads are tiny
      });
      req.on('end', () => {
        // Fires after the top-level try/catch returns, so guard it too — a throw
        // here would crash the process (fail-soft charter: a bad request must
        // never take down the server / /api/state).
        try {
          let info;
          try {
            info = JSON.parse(body || '{}');
          } catch {
            return sendJSON(res, 400, { error: 'bad json' });
          }
          const { sessionId, name, hidden } = info || {};
          if (!sessionId || typeof sessionId !== 'string' || !/^[A-Za-z0-9._-]+$/.test(sessionId)) {
            return sendJSON(res, 400, { error: 'invalid sessionId' }); // match /api/reply's charset guard
          }
          // Pass through only the keys actually present so a hide-toggle doesn't
          // wipe the name and vice-versa. roster.setOverride trims + length-caps
          // + strips control chars from the name; it is never eval'd or exec'd.
          const patch = {};
          if (Object.prototype.hasOwnProperty.call(info, 'name')) patch.name = name;
          if (Object.prototype.hasOwnProperty.call(info, 'hidden')) {
            if (typeof hidden !== 'boolean') {
              return sendJSON(res, 400, { error: 'hidden must be a boolean' });
            }
            patch.hidden = hidden;
          }
          const override = setOverride(sessionId, patch);
          sendJSON(res, 200, { ok: true, override });
        } catch (err) {
          sendJSON(res, 500, { ok: false, error: String(err && err.message ? err.message : err) });
        }
      });
      return;
    }
    serveStatic(req, res);
  } catch (err) {
    sendJSON(res, 500, { error: String(err && err.message ? err.message : err) });
  }
});

// Open the dashboard in the default browser on launch (the `npx` UX). Best
// effort + fail-silent; skip with AGENCY_NO_OPEN=1 (dev / headless / remote).
function openBrowser(url) {
  if (process.env.AGENCY_NO_OPEN) return;
  const [cmd, args] =
    process.platform === 'darwin' ? ['open', [url]]
    : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]]
    : ['xdg-open', [url]];
  try {
    execFile(cmd, args, () => {});
  } catch {
    /* no browser opener available — the printed URL still works */
  }
}

server.listen(PORT, HOST, () => {
  // Warm the usage cache so the first request is fast.
  try {
    getUsage();
  } catch {
    /* ignore */
  }
  console.log(`\n  🏢  Agency is open for business.`);
  console.log(`      → http://${HOST}:${PORT}\n`);
  openBrowser(`http://${HOST}:${PORT}`);
});
