// transcript.js — read-only "peek" into a Claude Code session's transcript so
// the UI can show the last few turns of a chat. Like the rest of Agency this
// NEVER writes to or executes against the session: getTranscript only reads the
// trailing slice of the on-disk JSONL transcript and returns a `resumeCmd`
// STRING for the UI to display/copy (it is never run here).
//
// Transcript path mapping mirrors lib/live.js: Claude encodes a session's cwd
// into the projects dir name by replacing every '/' and '.' with '-', and names
// the transcript <sessionId>.jsonl inside it. We duplicate that tiny mapping
// here rather than reach into live.js internals.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const HOME = os.homedir();
const PROJECTS_DIR = path.join(HOME, '.claude', 'projects');
const TAIL_BYTES = 256 * 1024; // only ever read this much from the file end

// Resolve a session's transcript path the way live.js does: prefer the project
// dir derived from cwd; otherwise scan the projects dir for <sessionId>.jsonl.
function resolvePath(sessionId, cwd) {
  if (cwd) {
    const encoded = cwd.replace(/[/.]/g, '-');
    const f = path.join(PROJECTS_DIR, encoded, `${sessionId}.jsonl`);
    if (fs.existsSync(f)) return f;
  }
  try {
    for (const dir of fs.readdirSync(PROJECTS_DIR)) {
      const f = path.join(PROJECTS_DIR, dir, `${sessionId}.jsonl`);
      if (fs.existsSync(f)) return f;
    }
  } catch {
    /* ignore — missing projects dir */
  }
  return null;
}

// Pull the displayable text out of one transcript line's message.content, which
// is either a plain string or an array of blocks; we join the text of the
// type:"text" blocks (skipping tool_use / tool_result / thinking blocks).
function extractText(content) {
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';
  const parts = [];
  for (const b of content) {
    if (b && b.type === 'text' && typeof b.text === 'string') parts.push(b.text);
  }
  return parts.join('\n').trim();
}

// Read the TRAILING ~256KB of `file` (cheap; avoids loading huge transcripts),
// mirroring live.js's readSessionMeta windowing. The first line of the slice is
// likely a partial JSON line and is skipped by the parse try/catch below.
function readTail(file) {
  let fd;
  try {
    const st = fs.fstatSync((fd = fs.openSync(file, 'r')));
    const len = Math.min(st.size, TAIL_BYTES);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, st.size - len);
    return buf.toString('utf8');
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

// Human-readable summary of one tool_use block — "what the agent is doing right
// now". Picks the most informative argument (file path, command, query, url, …)
// as the target. Returns { tool, target } or null for an unrecognized block.
function describeTool(b) {
  if (!b || b.type !== 'tool_use' || !b.name) return null;
  const inp = b.input || {};
  const base = (p) => (typeof p === 'string' ? p.replace(/\/+$/, '').split('/').pop() || p : null);
  const clip = (s, n = 60) => {
    if (typeof s !== 'string') return null;
    const c = s.replace(/\s+/g, ' ').trim();
    return c.length > n ? c.slice(0, n - 1) + '…' : c;
  };
  const name = b.name;
  let verb = name;
  let target = null;
  switch (name) {
    case 'Edit':
    case 'Write':
    case 'NotebookEdit':
      verb = name === 'Write' ? 'Writing' : 'Editing';
      target = base(inp.file_path || inp.notebook_path);
      break;
    case 'Read':
      verb = 'Reading';
      target = base(inp.file_path);
      break;
    case 'Bash':
      verb = 'Running';
      target = clip(inp.command, 70);
      break;
    case 'Grep':
      verb = 'Searching';
      target = clip(inp.pattern, 40);
      break;
    case 'Glob':
      verb = 'Globbing';
      target = clip(inp.pattern, 40);
      break;
    case 'Task':
    case 'Agent':
      verb = 'Dispatching';
      target = clip(inp.description || inp.subagent_type || inp.agentType, 50);
      break;
    case 'WebFetch':
      verb = 'Fetching';
      target = clip(inp.url, 50);
      break;
    case 'WebSearch':
      verb = 'Searching the web';
      target = clip(inp.query, 50);
      break;
    case 'TodoWrite':
      verb = 'Updating the plan';
      break;
    default:
      // MCP tools read as "mcp__server__tool" — surface a tidy name.
      verb = String(name).replace(/^mcp__/, '').replace(/__/g, ' · ');
      target = clip(inp.path || inp.file_path || inp.query || inp.command, 50);
  }
  return { tool: name, verb, target };
}

// Scan JSONL text for the agent's CURRENT action: the most recent assistant
// tool_use whose tool_result hasn't come back yet (i.e. the one in flight). If
// every tool has already returned, fall back to the single most recent tool_use
// so we can still say what it last did. Returns { tool, verb, target } or null.
// Exported for unit-testing without the fs.
export function parseLastAction(text) {
  const lines = text.split('\n');
  const finished = new Set(); // tool_use ids that have a matching tool_result
  const uses = []; // { id, desc } in file order (oldest → newest)
  for (const line of lines) {
    if (!line) continue;
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    const content = o.message && Array.isArray(o.message.content) ? o.message.content : null;
    if (!content) continue;
    if (o.type === 'assistant') {
      for (const b of content) {
        if (b && b.type === 'tool_use') {
          const desc = describeTool(b);
          if (desc) uses.push({ id: b.id || null, desc });
        }
      }
    } else if (o.type === 'user') {
      for (const b of content) {
        if (b && b.type === 'tool_result' && b.tool_use_id) finished.add(b.tool_use_id);
      }
    }
  }
  if (!uses.length) return null;
  // Prefer the newest still-in-flight tool_use (its result hasn't arrived).
  for (let i = uses.length - 1; i >= 0; i--) {
    if (!uses[i].id || !finished.has(uses[i].id)) return uses[i].desc;
  }
  // Everything returned — report the most recent action.
  return uses[uses.length - 1].desc;
}

// Parse JSONL text → the last `limit` user/assistant turns as
// [{ role, text, ts }]. Exported so the parser is unit-testable without the fs.
export function parseTranscript(text, limit = 25) {
  const out = [];
  for (const line of text.split('\n')) {
    if (!line) continue;
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      continue; // partial line at the head of the tail window, or non-JSON
    }
    if (o.type !== 'user' && o.type !== 'assistant') continue;
    const content = o.message ? o.message.content : undefined;
    const txt = extractText(content);
    if (!txt) continue; // e.g. a turn that was only a tool_use / tool_result
    out.push({ role: o.type, text: txt, ts: o.timestamp || null });
  }
  return out.slice(-limit);
}

// Public API: a read-only peek at the tail of a session's transcript. Returns
// { messages, lastAction, resumeCmd, path }. `lastAction` is what the agent is
// doing right now (its in-flight tool_use) for the agent-detail "current task"
// view. Fails soft — any error yields no messages / null lastAction and
// path:null, never throws.
export function getTranscript(sessionId, cwd, { limit = 25 } = {}) {
  // resumeCmd is a STRING for the UI to show/copy; it is never executed here.
  const resumeCmd = `cd ${cwd || '.'} && claude --resume ${sessionId}`;
  try {
    const file = resolvePath(sessionId, cwd);
    if (!file) return { messages: [], lastAction: null, resumeCmd, path: null };
    const text = readTail(file);
    const messages = parseTranscript(text, limit);
    const lastAction = parseLastAction(text);
    return { messages, lastAction, resumeCmd, path: file };
  } catch {
    return { messages: [], lastAction: null, resumeCmd, path: null };
  }
}

// Tiny self-check (no test framework in this repo):
//   node lib/transcript.js                       → run the synthetic parser assert
//   node lib/transcript.js <sessionId> <cwd>     → peek a real transcript
if (import.meta.url === `file://${process.argv[1]}`) {
  const [sessionId, cwd] = process.argv.slice(2);
  if (sessionId) {
    console.log(JSON.stringify(getTranscript(sessionId, cwd), null, 2));
  } else {
    const assert = (await import('node:assert')).default;
    const jsonl = [
      JSON.stringify({ type: 'summary', summary: 'ignored' }),
      JSON.stringify({ type: 'user', timestamp: 't1', message: { content: 'hi there' } }),
      JSON.stringify({
        type: 'assistant',
        timestamp: 't2',
        message: {
          content: [
            { type: 'text', text: 'hello' },
            { type: 'tool_use', name: 'Bash', input: {} },
          ],
        },
      }),
      JSON.stringify({
        type: 'user',
        message: { content: [{ type: 'tool_result', tool_use_id: 'x' }] },
      }), // tool-only turn → no text → dropped
      '{ this is a partial/garbage line', // unparseable → skipped
    ].join('\n');

    const msgs = parseTranscript(jsonl);
    assert.strictEqual(msgs.length, 2, 'two text-bearing turns survive');
    assert.deepStrictEqual(msgs[0], { role: 'user', text: 'hi there', ts: 't1' });
    assert.deepStrictEqual(msgs[1], { role: 'assistant', text: 'hello', ts: 't2' });
    assert.strictEqual(parseTranscript(jsonl, 1).length, 1, 'limit slices from the end');
    assert.deepStrictEqual(parseTranscript(jsonl, 1)[0].role, 'assistant', 'keeps the LAST turn');

    // parseLastAction: an in-flight Edit (no matching tool_result) wins over an
    // earlier, already-returned Bash.
    const actJsonl = [
      JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'tool_use', id: 'b1', name: 'Bash', input: { command: 'npm test' } }] },
      }),
      JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'b1' }] } }),
      JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'tool_use', id: 'e1', name: 'Edit', input: { file_path: '/a/b/render.js' } }] },
      }),
    ].join('\n');
    const act = parseLastAction(actJsonl);
    assert.strictEqual(act.verb, 'Editing', 'in-flight Edit is the current action');
    assert.strictEqual(act.target, 'render.js', 'Edit target is the basename');
    assert.strictEqual(parseLastAction('') , null, 'no actions → null');
    // When everything has returned, report the most recent action.
    const doneJsonl = [
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'r1', name: 'Read', input: { file_path: '/x/y/usage.js' } }] } }),
      JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'r1' }] } }),
    ].join('\n');
    assert.strictEqual(parseLastAction(doneJsonl).verb, 'Reading', 'falls back to most recent returned action');

    console.log('transcript.js self-check OK');
  }
}
