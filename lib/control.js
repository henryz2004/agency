// control.js — in-memory registry of Claude Code agents paused on a Stop hook,
// waiting for a typed reply from the dashboard.
//
// THE MECHANISM: a Claude Code Stop hook of type "http" BLOCKS the agent until
// our server responds, and FAILS OPEN (timeout / refused / non-2xx → the agent
// just stops normally). server.js holds that connection open and registers the
// pending request here, keyed by session_id. When the user types a reply in the
// chat panel (POST /api/reply), we resolve(sessionId, text) → server sends the
// decision:"block" JSON that resumes the agent with the user's instruction. If
// no reply arrives before the soft deadline, we resolve with null → server
// sends an empty 200 and the agent stops normally (staying under the 120s hook
// timeout). This module owns ONLY in-memory state — no persistence, no fs writes
// (the app's read-only charter: the hook endpoint is a control surface, like
// /api/resume, not a writer of ~/.claude data).

// sessionId -> { cwd, transcriptPath, since, timer, settle }
const pending = new Map();

// Soft deadline: resolve the held connection with null (→ empty 200, agent
// stops) before the hook's own timeout fires. The default Stop hook timeout we
// install is 120s; 110s leaves headroom so WE decide the outcome, not the CLI.
export const DEADLINE_MS = 110_000;

// Register a paused agent. `settle(text)` is the server's resolver for the held
// response: settle(string) resumes the agent with that instruction; settle(null)
// lets it stop. A second register() for the same session supersedes the first
// (settles the old one as a timeout) — the latest Stop is the live one.
export function register(sessionId, { cwd, transcriptPath, settle }, deadlineMs = DEADLINE_MS) {
  if (!sessionId || typeof settle !== 'function') return;
  // Supersede any existing entry for this session.
  const prior = pending.get(sessionId);
  if (prior) {
    clearTimeout(prior.timer);
    pending.delete(sessionId);
    try {
      prior.settle(null); // let the stale hold stop normally
    } catch {
      /* ignore */
    }
  }
  const entry = {
    cwd: cwd || null,
    transcriptPath: transcriptPath || null,
    since: Date.now(),
    settle,
    timer: null,
  };
  entry.timer = setTimeout(() => {
    // Deadline hit with no reply: drop the entry and let the agent stop.
    if (pending.get(sessionId) === entry) pending.delete(sessionId);
    try {
      settle(null);
    } catch {
      /* ignore */
    }
  }, deadlineMs);
  // Let the process exit even if a hold is outstanding (don't keep Node alive).
  if (entry.timer.unref) entry.timer.unref();
  pending.set(sessionId, entry);
}

// Resolve a pending request with the user's reply text. `entry.settle` returns
// true only if it actually delivered (the held socket was still open); a hold
// whose client already hung up returns false, so a late reply is reported as
// "not delivered" rather than a false success. Returns true iff the reply was
// delivered to a live hold.
export function resolve(sessionId, text) {
  const entry = pending.get(sessionId);
  if (!entry) return false;
  clearTimeout(entry.timer);
  pending.delete(sessionId);
  try {
    return entry.settle(String(text == null ? '' : text)) === true;
  } catch {
    return false;
  }
}

// Drop a pending entry without resuming the agent — used when the held hook
// connection closes (agent killed / its hook timed out). Entry-scoped: only
// removes the entry if `settle` still matches the current one, so a stale
// connection closing after it was superseded can't delete the new hold.
export function cancel(sessionId, settle) {
  const entry = pending.get(sessionId);
  if (!entry || (settle && entry.settle !== settle)) return false;
  clearTimeout(entry.timer);
  pending.delete(sessionId);
  return true;
}

// Snapshot of who is currently waiting, for buildState() to fold into the live
// agents (awaitingReply / pendingSince). Returns a Map-like plain object keyed
// by sessionId so the caller can look up by agent id.
export function list() {
  const out = {};
  for (const [sessionId, e] of pending) {
    out[sessionId] = { cwd: e.cwd, transcriptPath: e.transcriptPath, since: e.since };
  }
  return out;
}

// Is a given session currently paused & waiting? (cheap point lookup)
export function isPending(sessionId) {
  return pending.has(sessionId);
}

// ---- self-check (node lib/control.js) -------------------------------------
// Tiny asserts exercising register→resolve (correct decision text) and the
// deadline path. No framework — just throws on failure, prints OK on success.
if (import.meta.url === `file://${process.argv[1]}`) {
  const assert = (cond, msg) => {
    if (!cond) throw new Error('control self-check FAILED: ' + msg);
  };

  // A live-hold stub: records the text it was settled with and returns true
  // (mimics server.js settle writing to an open socket).
  const liveHold = (sink) => (t) => { sink.text = t; return true; };

  // 1) register → resolve returns true and delivers the user's text.
  const a = {};
  register('sess-A', { cwd: '/tmp', transcriptPath: '/t.jsonl', settle: liveHold(a) });
  assert(isPending('sess-A'), 'sess-A should be pending after register');
  assert(list()['sess-A'], 'list() should include sess-A');
  const hit = resolve('sess-A', 'please run the tests');
  assert(hit === true, 'resolve should return true for a delivered reply');
  assert(a.text === 'please run the tests', 'settle should receive the reply text, got: ' + a.text);
  assert(!isPending('sess-A'), 'sess-A should be cleared after resolve');

  // 2) resolve with no pending entry returns false.
  assert(resolve('nope', 'x') === false, 'resolve of unknown session should be false');

  // 3) a dead hold (settle returns false) makes resolve report not-delivered.
  register('sess-D', { cwd: '/tmp', settle: () => false });
  assert(resolve('sess-D', 'late') === false, 'resolve of a dead hold should be false');

  // 4) cancel drops the entry (entry-scoped) without resuming.
  const c = {};
  const cSettle = liveHold(c);
  register('sess-E', { cwd: '/tmp', settle: cSettle });
  assert(cancel('sess-E', cSettle) === true, 'cancel should drop the matching entry');
  assert(!isPending('sess-E'), 'sess-E should be gone after cancel');
  // cancel with a non-matching settle must NOT delete a re-registered entry.
  const e2 = {};
  register('sess-E', { cwd: '/tmp', settle: liveHold(e2) });
  assert(cancel('sess-E', cSettle) === false, 'stale cancel must not drop a superseding hold');
  assert(isPending('sess-E'), 'superseding hold should survive a stale cancel');
  resolve('sess-E', 'ok'); // tidy up

  // 5) deadline path: a short deadline settles with null and clears the entry.
  const b = { text: 'unset' };
  register('sess-B', { cwd: '/tmp', settle: (t) => { b.text = t; return true; } }, 20);
  setTimeout(() => {
    assert(b.text === null, 'deadline should settle with null, got: ' + b.text);
    assert(!isPending('sess-B'), 'sess-B should be cleared after deadline');

    // 6) superseding: a second register settles the first as a timeout (null)
    //    and the new one resolves with text.
    const f = { text: 'unset' }, s = { text: 'unset' };
    register('sess-C', { cwd: '/tmp', settle: (t) => { f.text = t; return true; } });
    register('sess-C', { cwd: '/tmp', settle: liveHold(s) });
    assert(f.text === null, 'superseded hold should settle with null, got: ' + f.text);
    resolve('sess-C', 'go');
    assert(s.text === 'go', 'new hold should resolve with text, got: ' + s.text);

    console.log('control.js self-check OK');
    process.exit(0);
  }, 60);
}
