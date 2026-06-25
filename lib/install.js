// install.js — when this machine first ran Agency.
//
// The leaderboard ranks engineer-years shipped SINCE you joined Agency, not your
// whole Claude history, so everyone starts from zero on install. We persist the
// timestamp once. For an `npx` user, first-run ≈ download. For an existing
// ~/.agency we best-effort backfill from the data dir's creation time so it
// keeps its real age instead of resetting to "now".
//
// Fail-soft like every adapter: a read/write error never throws — worst case we
// recompute the anchor next process start.

import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './paths.js';

const FILE = path.join(DATA_DIR, 'install.json');
const Y2010 = 1262304000000; // sanity floor for a plausible birthtime

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

  // First run: anchor at the data dir's birthtime if it looks real, else now.
  let at = Date.now();
  try {
    const bt = fs.statSync(DATA_DIR).birthtimeMs;
    if (bt && bt > Y2010 && bt < at) at = bt;
  } catch { /* dir may not exist yet */ }

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
