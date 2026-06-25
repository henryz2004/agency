// install.js — when this machine first ran Agency.
//
// The leaderboard ranks engineer-years shipped SINCE you joined Agency, not your
// whole Claude history, so everyone starts from zero on install. We persist the
// timestamp once, on the first run that records it — for an `npx` user that's
// the download. We deliberately do NOT backfill from the data dir's birthtime:
// an existing ~/.agency (from an earlier, pre-leaderboard build) would otherwise
// sweep months of pre-join usage into the "since install" slice.
//
// Fail-soft like every adapter: a read/write error never throws — worst case we
// recompute the anchor next process start.

import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './paths.js';

const FILE = path.join(DATA_DIR, 'install.json');

let cached = null;

// { at: epoch-ms, day: 'YYYY-MM-DD' (local, matches usage.js day buckets) }
export function installInfo() {
  if (cached) return cached;

  // Already recorded? Trust it.
  try {
    const j = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    if (j && typeof j.installedAt === 'number' && j.installedAt > 0) {
      return (cached = { at: j.installedAt, day: dayOf(j.installedAt) });
    }
  } catch { /* not written yet */ }

  // First run: anchor at now (see header — no birthtime backfill).
  const at = Date.now();

  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify({ installedAt: at }, null, 2));
  } catch { /* read-only data dir — keep the in-memory anchor for this process */ }

  return (cached = { at, day: dayOf(at) });
}

// Local-tz YYYY-MM-DD — usage.js keys day buckets with the same en-CA local date,
// so the leaderboard slice can compare bucket.date >= installedDay lexically.
function dayOf(ms) {
  return new Date(ms).toLocaleDateString('en-CA');
}
