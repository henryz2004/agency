// history.js — an in-memory ring of floor snapshots, sampled by server.js on a
// timer, so the dashboard can REPLAY the last few hours of the office and chart
// concurrency / per-agent uptime + wait time over time. We keep only the thin
// per-agent fields the timeline needs (enough to re-render the office via
// office.js setAgents AND compute the stats). The whole ring is regenerable.
//
// ponytail: in-memory only, server-lifetime — lost on restart, capped at a few
// hours. Persist a JSONL under data/ if you ever want the timeline to survive a
// restart or span multiple days.

export const SAMPLE_MS = 20 * 1000; // cadence server.js samples the floor at
const WINDOW_MS = 6 * 60 * 60 * 1000; // retain ~6h ("the past few hours")
const MAX = Math.ceil(WINDOW_MS / SAMPLE_MS) + 16; // hard length cap (+slack)

// [{ t, a: [{ id, name, project, act, need, role, subs }] }], oldest → newest
const ring = [];

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
  // Trim by age, and hard-cap the length so a backwards/stuck clock can't grow
  // the ring without bound. Always keep ≥1 so the timeline never goes blank.
  const cutoff = t - WINDOW_MS;
  while (ring.length > 1 && (ring[0].t < cutoff || ring.length > MAX)) ring.shift();
}

// The recorded window, oldest → newest. `since` (ms epoch) returns only newer
// snapshots so the client can refresh incrementally instead of refetching all.
export function getHistory(since) {
  const snapshots = since ? ring.filter((s) => s.t > since) : ring.slice();
  return { sampleMs: SAMPLE_MS, windowMs: WINDOW_MS, now: Date.now(), snapshots };
}
