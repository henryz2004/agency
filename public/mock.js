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
const LEAD_SESSION = `mock-lead-${(now0 % 100000).toString(36)}`;

const cast = EMPTY
  ? []
  : Array.from({ length: N }, (_, i) => {
      const base = CAST[i % CAST.length];
      const tier = tierFor(base.model);
      // slot 0 is the team lead (PM); it also carries a couple of foreground
      // subagents so the "minions clustered under one worker" path stays visible.
      const isLead = i === 0;
      return {
        pid: 4000 + i,
        sessionId: isLead ? LEAD_SESSION : `mock-${i}-${(now0 % 100000).toString(36)}`,
        source: base.source,
        cwd: `/Users/you/code/${pick(PROJECTS, i)}`,
        project: pick(PROJECTS, i),
        kind: 'interactive',
        model: base.model,
        modelSlug: base.source === 'opencode' ? `${base.source}/${base.model}` : base.model,
        provider: base.source === 'codex' ? 'openai' : 'anthropic',
        name: `${pick(FIRST, i)} ${pick(LAST, i + 3)}`,
        title: isLead ? 'Engineering Manager' : TITLES[tier],
        tier,
        skin: pick(SKINS, i + 1),
        hair: pick(HAIRS, i + 2),
        shirt: pick(SHIRTS, i),
        chatName: pick(TASKS, i),
        lastPrompt: pick(TASKS, i + 4),
        task: null,
        role: isLead ? 'lead' : null, // marks the orchestrator → distinct render
        teamColor: null,
        hiredAt: now0 - rint(40) * 86400e3,
        // varied ages so uptime labels differ (minutes → hours)
        startedAt: now0 - (60e3 + rint(5 * 3600e3)),
        // director-controlled, seeded so the first frame is already varied:
        activity: ['working', 'shell', 'idle'][i % 3],
        state: i === 5 ? 'done' : null,
        // slot 1 is paused on a Stop hook, awaiting a reply — previews the
        // Control Phase-1 reply box + "needs you" HUD with no real hook (?mock).
        awaitingReply: i === 1,
        pendingSince: i === 1 ? now0 - 45e3 : undefined,
        pendingQuestion: i === 1
          ? 'I\'ve finished the refactor. Should I also update the tests, or leave them for a follow-up?'
          : undefined,
        // lead always shows 1-2 foreground minions; others occasionally do.
        subagents: isLead
          ? [{ type: 'general-purpose' }, { type: 'general-purpose' }]
          : i % 4 === 0 ? [{ type: 'agent' }, { type: 'agent' }] : [],
      };
    });

// Two in-process teammates the lead launched with run_in_background:true. They
// have no pid (mirrors real teammates) and render as INDIVIDUAL workers, shirted
// by their team color. Mirrors lib/live.js buildTeammate() + the server's
// teammate identity merge (name = config label, title = subagent_type).
const TEAMMATE_DEFS = EMPTY
  ? []
  : [
      { name: 'cc-internals', color: 'blue', model: 'claude-opus-4-8', task: 'scout Claude Code internals' },
      { name: 'sprite-audit', color: 'green', model: 'claude-sonnet-4-6', task: 'audit the sprite sheet' },
    ];
const teammates = TEAMMATE_DEFS.map((t, k) => ({
  pid: null,
  sessionId: `${t.name}@${LEAD_SESSION}`,
  source: 'claude',
  cwd: '/Users/you/code/startup-agency',
  project: 'startup-agency',
  kind: 'teammate',
  model: t.model,
  modelSlug: t.model,
  provider: 'anthropic',
  name: t.name, // config label, preserved over any roster name
  title: 'general-purpose', // = subagent_type
  tier: tierFor(t.model),
  skin: pick(SKINS, k + 2),
  hair: pick(HAIRS, k + 1),
  shirt: pick(SHIRTS, k + 4), // overridden by teamColor at draw time
  chatName: null,
  lastPrompt: t.task,
  task: null,
  role: 'teammate',
  teamColor: t.color,
  teammateName: t.name,
  teammateType: 'general-purpose',
  hiredAt: now0 - rint(10) * 86400e3,
  startedAt: now0 - (120e3 + rint(2 * 3600e3)),
  activity: 'working',
  state: null,
  subagents: [],
}));
if (cast.length) cast.push(...teammates);

// ---- the director: mutate volatile fields each poll ------------------------

function direct(a) {
  if (a.state === 'done') { a.activity = 'idle'; a.subagents = []; return; }
  const r = Math.random();
  a.activity = r < 0.5 ? 'working' : r < 0.75 ? 'shell' : 'idle';
  // The lead keeps a steady clutch of foreground minions (it's orchestrating);
  // teammates are individual workers and never cluster minions of their own.
  if (a.role === 'lead') {
    a.subagents = Array.from({ length: 1 + rint(2) }, () => ({ type: 'general-purpose' }));
    return;
  }
  if (a.role === 'teammate') { a.subagents = []; return; }
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
    const out = 9_000_000 - i * 1_100_000 + rint(800000);
    // First ~4 projects are "currently active" (recent output); the rest are
    // stale all-time workspaces, so the departments panel's recency scope is
    // visible in ?mock. lastTs is an ISO string to match the real adapter.
    const recent = i < 4;
    const lastTs = new Date(now0 - (recent ? i * 6 * 3600e3 : (9 + i * 3) * 86400e3)).toISOString();
    byProject[p] = {
      out,
      recentOut: recent ? Math.round(out * 0.4) + rint(300000) : 0,
      recentDays: recent ? 3 + rint(4) : 0,
      msgs: 1200 - i * 120, tools: 4200 - i * 480,
      agents: 90 - i * 10, sessions: 40 - i * 4,
      lastTs,
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
    recentWindowDays: 7,
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

  // Enriched team record matching lib/live.js readTeams(): a lead member plus
  // the in-process teammates, each with the per-member fields the frontend now
  // reads (color/model/agentType/isLead).
  const teams = cast.length
    ? [
        {
          name: 'launch-squad',
          createdAt: now0 - 3600e3,
          leadAgentId: `team-lead@${LEAD_SESSION}`,
          leadSessionId: LEAD_SESSION,
          members: [
            {
              agentId: `team-lead@${LEAD_SESSION}`,
              name: 'team-lead',
              color: null,
              model: cast[0].model,
              agentType: 'team-lead',
              prompt: null,
              backendType: 'in-process',
              cwd: cast[0].cwd,
              joinedAt: now0 - 3600e3,
              isLead: true,
            },
            ...TEAMMATE_DEFS.map((t) => ({
              agentId: `${t.name}@${LEAD_SESSION}`,
              name: t.name,
              color: t.color,
              model: t.model,
              agentType: 'general-purpose',
              prompt: t.task,
              backendType: 'in-process',
              cwd: '/Users/you/code/startup-agency',
              joinedAt: now0 - 1800e3,
              isLead: false,
            })),
          ],
        },
      ]
    : [];

  return { generatedAt: now, live: { agents, teams, now }, usage };
}
