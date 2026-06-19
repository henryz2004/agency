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
// { messages, resumeCmd, path }. Fails soft — any error yields no messages and
// path:null, never throws.
export function getTranscript(sessionId, cwd, { limit = 25 } = {}) {
  // resumeCmd is a STRING for the UI to show/copy; it is never executed here.
  const resumeCmd = `cd ${cwd || '.'} && claude --resume ${sessionId}`;
  try {
    const file = resolvePath(sessionId, cwd);
    if (!file) return { messages: [], resumeCmd, path: null };
    const messages = parseTranscript(readTail(file), limit);
    return { messages, resumeCmd, path: file };
  } catch {
    return { messages: [], resumeCmd, path: null };
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
    console.log('transcript.js self-check OK');
  }
}
