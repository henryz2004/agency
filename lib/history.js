// history.js — a ring of floor snapshots, sampled by server.js on a timer, so the
// dashboard can REPLAY the last few hours of the office and chart concurrency +
// per-agent uptime / wait-for-you stats. We keep only the thin per-agent fields
// the timeline needs (enough to re-render the office via office.js setAgents AND
// compute the stats).
//
// The ring is mirrored to DATA_DIR/history.json so the timeline SURVIVES a server
// restart (close + reopen the dashboard and your history is still there). It's a
// regenerable cache: a missing / corrupt / stale-version file just starts empty.

import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './paths.js';

export const SAMPLE_MS = 20 * 1000; // cadence server.js samples the floor at
const WINDOW_MS = 6 * 60 * 60 * 1000; // retain ~6h ("the past few hours")
const MAX = Math.ceil(WINDOW_MS / SAMPLE_MS) + 16; // hard length cap (+slack)
const FLUSH_MS = 60 * 1000; // throttle disk writes — the ring updates every ~20s
const VERSION = 1; // bump if the snapshot record shape changes incompatibly
const HISTORY_PATH = path.join(DATA_DIR, 'history.json');

// [{ t, a: [{ id, name, project, cwd, act, need, role, subs }] }], oldest → newest
const ring = [];
let lastSave = 0;

// Drop snapshots older than the window, and hard-cap the length so a backwards /
// stuck clock can't grow the ring without bound. Always keep ≥1 so the timeline
// never goes blank.
function trim(now) {
  const cutoff = now - WINDOW_MS;
  while (ring.length > 1 && (ring[0].t < cutoff || ring.length > MAX)) ring.shift();
}

// Persist the ring. Throttled (we rewrite the whole file, and the ring changes
// every sample) and atomic (tmp + rename) so a process killed mid-write can't
// leave a truncated file that nukes ALL history on the next boot. Fail-soft.
// ponytail: whole-file rewrite throttled to ~60s — fine for a personal dashboard;
// switch to an append-only JSONL + compaction if a 24/7 instance ever makes the
// write volume matter.
function save(now) {
  if (now - lastSave < FLUSH_MS) return;
  lastSave = now;
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = HISTORY_PATH + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ version: VERSION, snapshots: ring }));
    fs.renameSync(tmp, HISTORY_PATH);
  } catch {
    /* a cache write failure must never break recording */
  }
}

// Seed the ring from disk at startup. Fail-soft: missing / corrupt / wrong-version
// → start empty. Trim to the window relative to NOW so a long downtime drops data
// that's already aged out (the chart shows the gap honestly).
function load() {
  try {
    const o = JSON.parse(fs.readFileSync(HISTORY_PATH, 'utf8'));
    if (!o || o.version !== VERSION || !Array.isArray(o.snapshots)) return;
    for (const s of o.snapshots) {
      if (s && typeof s.t === 'number' && Array.isArray(s.a)) ring.push(s);
    }
    ring.sort((x, y) => x.t - y.t); // guarantee oldest → newest
    if (ring.length) trim(Date.now());
  } catch {
    /* no / unreadable cache — start empty */
  }
}
load();

// Record one floor snapshot from buildState()'s live agents. Stores only the
// fields the timeline reads; everything else on the agent is dropped.
export function record(agents, now) {
  const t = now || Date.now();
  const a = (agents || []).map((x) => ({
    id: x.sessionId || null,
    name: x.name || x.project || 'agent',
    project: x.project || 'unknown',
    cwd: x.cwd || null, // so a replayed desk can still peek its transcript
    act: x.activity || 'idle', // 'working' | 'shell' | 'idle'
    need: !!(x.needsYou || x.awaitingReply), // blocked / paused waiting on the USER
    role: x.role || null, // 'lead' | 'teammate' | null
    subs: Array.isArray(x.subagents) ? x.subagents.length : 0,
  }));
  ring.push({ t, a });
  trim(t);
  save(t);
}

// The recorded window, oldest → newest. `since` (ms epoch) returns only newer
// snapshots so the client can refresh incrementally instead of refetching all.
export function getHistory(since) {
  const snapshots = since ? ring.filter((s) => s.t > since) : ring.slice();
  return { sampleMs: SAMPLE_MS, windowMs: WINDOW_MS, now: Date.now(), snapshots };
}
