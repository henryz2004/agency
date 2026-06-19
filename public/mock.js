// mock.js — synthesize /api/state-shaped data so the presentation layer can be
// developed with no real agents running. Enable via URL: ?mock (default cast),
// ?mock=12 (N agents), ?mock=empty (empty floor). A tiny "director" re-rolls
// activity each poll so working / shell / idle / done + subagents all animate.
//
// ponytail: frontend-only fixture, never touches lib/ — keeps the plumbing/UI
// split intact. The cast is built once (stable identities so selection sticks);
// only activity/subagents/uptime change between polls.

const params = new URLSearchParams(location.search);
export const mockEnabled = params.has('mock');

const arg = params.get('mock');
const EMPTY = arg === 'empty';
const N = Number(arg) > 0 ? Math.min(Number(arg), 60) : 7;

// ---- identity helpers (roster.js runs server-side; reproduce just enough) ---

const FIRST = ['Ada', 'Ravi', 'Mona', 'Kenji', 'Lena', 'Otis', 'Priya', 'Theo', 'Yara', 'Cole', 'Nina', 'Dax', 'Ines', 'Bram', 'Suki', 'Ezra'];
const LAST = ['Vance', 'Okoro', 'Sato', 'Reyes', 'Novak', 'Kapoor', 'Holt', 'Ferro', 'Lund', 'Cruz', 'Bose', 'Pike', 'Calder', 'Ono', 'Frost', 'Wells'];
const SKINS = ['#f0c8a0', '#e8b890', '#d8a070', '#c08858', '#a87048', '#8a5a3a'];
const HAIRS = ['#2b2233', '#5a3a26', '#3a2e22', '#1f2a33', '#4a2233', '#26333a'];
const SHIRTS = ['#e05d5d', '#5d9ce0', '#5dc98a', '#e0b05d', '#a87de0', '#e07db0', '#5dc9c9', '#9bd45d'];
const TITLES = { opus: 'Principal Engineer', sonnet: 'Senior Engineer', haiku: 'Junior Engineer', unknown: 'Contractor' };

const PROJECTS = ['startup-agency', 'browser-harness', 'auth-service', 'data-pipeline', 'mobile-app', 'ml-infra', 'billing'];
const TASKS = [
  'refactor the auth flow', 'wire up the live endpoint', 'fix the flaky test suite',
  'add the payroll meter', 'migrate to the new schema', 'chase down a memory leak',
  'draft the release notes', 'tighten the camera clamps', 'parse codex sqlite state',
];

// model + source per cast slot — covers every tier and every source/badge.
const CAST = [
  { model: 'claude-opus-4-8[1m]', source: 'claude' },
  { model: 'claude-sonnet-4-6', source: 'claude' },
  { model: 'claude-haiku-4-5-20251001', source: 'claude' },
  { model: 'gpt-5-codex', source: 'codex' },
  { model: 'claude-sonnet-4-6', source: 'opencode' },
  { model: 'claude-opus-4-8', source: 'claude' },
  { model: 'claude-haiku-4-5-20251001', source: 'opencode' },
];

const pick = (arr, i) => arr[i % arr.length];
const rint = (n) => Math.floor(Math.random() * n);

function tierFor(model) {
  const m = (model || '').toLowerCase();
  if (m.includes('opus') || m.includes('fable')) return 'opus';
  if (m.includes('sonnet')) return 'sonnet';
  if (m.includes('haiku')) return 'haiku';
  return 'unknown';
}

// Build the stable cast once.
const now0 = Date.now();
const cast = EMPTY
  ? []
  : Array.from({ length: N }, (_, i) => {
      const base = CAST[i % CAST.length];
      const tier = tierFor(base.model);
      return {
        pid: 4000 + i,
        sessionId: `mock-${i}-${(now0 % 100000).toString(36)}`,
        source: base.source,
        cwd: `/Users/you/code/${pick(PROJECTS, i)}`,
        project: pick(PROJECTS, i),
        kind: 'interactive',
        model: base.model,
        modelSlug: base.source === 'opencode' ? `${base.source}/${base.model}` : base.model,
        provider: base.source === 'codex' ? 'openai' : 'anthropic',
        name: `${pick(FIRST, i)} ${pick(LAST, i + 3)}`,
        title: TITLES[tier],
        tier,
        skin: pick(SKINS, i + 1),
        hair: pick(HAIRS, i + 2),
        shirt: pick(SHIRTS, i),
        chatName: pick(TASKS, i),
        lastPrompt: pick(TASKS, i + 4),
        task: null,
        hiredAt: now0 - rint(40) * 86400e3,
        // varied ages so uptime labels differ (minutes → hours)
        startedAt: now0 - (60e3 + rint(5 * 3600e3)),
        // director-controlled, seeded so the first frame is already varied:
        activity: ['working', 'shell', 'idle'][i % 3],
        state: i === 5 ? 'done' : null,
        subagents: i % 4 === 0 ? [{ type: 'agent' }, { type: 'agent' }] : [],
      };
    });

// ---- the director: mutate volatile fields each poll ------------------------

function direct(a) {
  if (a.state === 'done') { a.activity = 'idle'; a.subagents = []; return; }
  const r = Math.random();
  a.activity = r < 0.5 ? 'working' : r < 0.75 ? 'shell' : 'idle';
  a.subagents = a.activity === 'working' && Math.random() < 0.5
    ? Array.from({ length: 1 + rint(3) }, () => ({ type: 'agent' }))
    : [];
}

// ---- synthetic usage (built once; today's bar nudges up so it animates) ----

let usage = null;
function buildUsage() {
  const daily = [];
  for (let i = 29; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const out = 180000 + Math.round(90000 * Math.sin(i / 3.3)) + rint(140000);
    daily.push({
      date: d.toLocaleDateString('en-CA'),
      out, in: Math.round(out * 0.55), cr: out * 5, cc: Math.round(out * 0.35),
      tools: 40 + rint(160), agents: rint(9), msgs: 60 + rint(220),
    });
  }
  const byModel = {
    'claude-opus-4-8[1m]': { out: 14_200_000, in: 9_100_000, msgs: 5400 },
    'claude-sonnet-4-6': { out: 6_800_000, in: 4_300_000, msgs: 7200 },
    'gpt-5-codex': { out: 3_100_000, in: 2_000_000, msgs: 2600 },
    'claude-haiku-4-5-20251001': { out: 1_200_000, in: 900_000, msgs: 3100 },
  };
  const byProject = {};
  PROJECTS.forEach((p, i) => {
    byProject[p] = {
      out: 9_000_000 - i * 1_100_000 + rint(800000),
      msgs: 1200 - i * 120, tools: 4200 - i * 480,
      agents: 90 - i * 10, sessions: 40 - i * 4,
      lastTs: now0 - i * 3600e3,
    };
  });
  const lifetime = {
    out: 25_300_000, in: 16_300_000, cr: 410_000_000, cc: 8_900_000,
    tools: 38_400, msgs: 18_300, agents: 612, sessions: 184,
  };
  return {
    lifetime,
    today: { date: daily[daily.length - 1].date, ...daily[daily.length - 1] },
    daily,
    byModel,
    byProject,
    firstDay: daily[0].date,
    activeDays: 184,
  };
}

// ---- public: produce a full /api/state-shaped object -----------------------

export function getMockState() {
  const now = Date.now();
  if (!usage) usage = buildUsage();
  // nudge today's output up a touch each poll so the "today" bar + eng-days move
  const last = usage.daily[usage.daily.length - 1];
  last.out += 200 + rint(1500);
  usage.today = { date: last.date, ...last };

  cast.forEach(direct);
  const agents = cast
    .map((a) => ({ ...a, uptimeMs: a.startedAt ? Math.max(0, now - a.startedAt) : null }))
    .sort((x, y) => (y.uptimeMs || 0) - (x.uptimeMs || 0));

  const teams = cast.length >= 3
    ? [{ name: 'launch-squad', members: agents.slice(0, 3).map((a) => ({ name: a.name, agentType: a.title, cwd: a.cwd })) }]
    : [];

  return { generatedAt: now, live: { agents, teams, now }, usage };
}
