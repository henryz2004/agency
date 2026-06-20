// mock-agents.js — synthetic agents in the SHAPE the real /api/state emits
// (source, activity, model, project/cwd, subagents, role). Used to drive the
// fully-procedural office prototype at 3 / 8 / 12 agents.

const MODELS = [
  'claude-opus-4-8',        // opus  → gold
  'claude-sonnet-4-6',      // sonnet → cyan
  'claude-haiku-4-5',       // haiku → green
  'openai/codex-mini',      // codex → orange
];

const PROJECTS = [
  'startup-agency', 'browser-harness', 'sprite-lab',
  'control-plane', 'pixel-pack', 'edge-router',
];

const TITLES = [
  'Staff Engineer', 'Senior Engineer', 'Frontend Dev', 'Backend Dev',
  'Infra Lead', 'Designer', 'QA Engineer', 'Researcher',
];

const NAMES = [
  'Ada', 'Bjorn', 'Cleo', 'Dex', 'Esme', 'Finn', 'Goro', 'Hana',
  'Iris', 'Juno', 'Kai', 'Lena', 'Milo', 'Nova', 'Otis', 'Priya',
];

const ACTIVITIES = ['working', 'working', 'shell', 'idle']; // weighted toward busy

// A deterministic mock generator so 3/8/12 are stable across reloads.
function mulberry(seed) {
  let s = seed >>> 0;
  return () => {
    s |= 0; s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function makeAgents(n, seed = 7) {
  const r = mulberry(seed * 100 + n);
  const out = [];
  // Decide a project layout: cluster agents into a few repos so the floor groups.
  // Fewer projects than agents → real desk neighbourhoods.
  const nProj = Math.max(1, Math.min(PROJECTS.length, Math.round(n / 2.5)));
  for (let i = 0; i < n; i++) {
    const proj = PROJECTS[Math.floor(r() * nProj)];
    const model = MODELS[Math.floor(r() * MODELS.length)];
    const activity = i === 0 ? 'working' : ACTIVITIES[Math.floor(r() * ACTIVITIES.length)];
    const subN = activity === 'working' && r() < 0.4 ? 1 + Math.floor(r() * 3) : 0;
    out.push({
      sessionId: `mock-${seed}-${i}`,
      pid: 1000 + i,
      name: NAMES[i % NAMES.length] + (i >= NAMES.length ? ' ' + Math.floor(i / NAMES.length) : ''),
      title: TITLES[Math.floor(r() * TITLES.length)],
      project: proj,
      cwd: `/Users/dev/code/${proj}`,
      model,
      source: model.includes('codex') ? 'codex' : 'claude',
      activity,
      role: i === 0 ? 'lead' : 'teammate',
      subagents: Array.from({ length: subN }, (_, k) => ({ name: `sub-${k}` })),
      uptimeMs: Math.floor(r() * 6 * 3600 * 1000),
      startedAt: Date.now() - Math.floor(r() * 6 * 3600 * 1000),
    });
  }
  // Group by project so co-located agents are adjacent (mirrors render.js).
  out.sort((a, b) => a.project.localeCompare(b.project));
  return out;
}
