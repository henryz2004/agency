// app.js — fetches /api/state, drives the office renderer, and computes the
// "manpower" translation + comparison panels. All manpower math is client-side
// so the assumption sliders update everything instantly.

import { initOffice, setAgents } from './office.js';
import { drawHead, colorFor } from './sprites.js';
import { initSoundPref, toggleSound, updateSound } from './sound.js';
import { initUI } from './ui.js';
import { mockEnabled, getMockState } from './mock.js';
import { initChatPanel } from './chat-panel.js';

const $ = (id) => document.getElementById(id);

const office = $('office');
const labels = $('labels');
initOffice(office, labels);
initUI();
initChatPanel(); // read-only "open agent's chat" peek panel (listens for agency:select)

// ---- assumptions (persisted) ---------------------------------------------

const DEFAULTS = { tok: 3000, hrs: 8, days: 230, sal: 150000 };
let assume = loadAssumptions();

function loadAssumptions() {
  try {
    return { ...DEFAULTS, ...JSON.parse(localStorage.getItem('agency.assume') || '{}') };
  } catch {
    return { ...DEFAULTS };
  }
}
function saveAssumptions() {
  try {
    localStorage.setItem('agency.assume', JSON.stringify(assume));
  } catch {
    /* ignore */
  }
}

function bindSlider(id, key, fmt) {
  const el = $(id);
  const out = $('v' + key[0].toUpperCase() + key.slice(1));
  el.value = assume[key];
  out.textContent = fmt(assume[key]);
  el.addEventListener('input', () => {
    assume[key] = Number(el.value);
    out.textContent = fmt(assume[key]);
    saveAssumptions();
    renderManpower();
  });
}

// ---- formatting -----------------------------------------------------------

function fmt(n) {
  n = n || 0;
  if (n >= 1e9) return (n / 1e9).toFixed(n >= 1e10 ? 0 : 1) + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(n >= 1e7 ? 0 : 1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(n >= 1e4 ? 0 : 1) + 'K';
  return String(Math.round(n));
}
function money(n) {
  if (n >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return '$' + Math.round(n / 1e3) + 'k';
  return '$' + Math.round(n);
}
function comma(n) {
  return Math.round(n).toLocaleString('en-US');
}

// ---- state ----------------------------------------------------------------

let STATE = null;

async function poll() {
  if (mockEnabled) {
    STATE = getMockState(); // synthetic data — iterate on the UI with no agents
    onState();
    return;
  }
  try {
    const res = await fetch('/api/state', { cache: 'no-store' });
    STATE = await res.json();
    onState();
  } catch (e) {
    // server probably restarting; keep last frame
  }
}

function onState() {
  // Bail if the server returned an error body instead of state.
  if (!STATE || !STATE.live || !Array.isArray(STATE.live.agents) || !STATE.usage) return;
  const { live, usage } = STATE;
  // Drive the canvas office, but never let a renderer throw take down the data
  // panels — they read the same STATE independently. (Fail-soft charter: a
  // broken render path shouldn't blank the whole dashboard.)
  try {
    setAgents(live.agents);
  } catch (e) {
    console.error('office render failed:', e);
  }

  // ---- topbar headline metrics (truthful definitions) --------------------
  // ponytail: "on the floor" = count of live agents (anything getLive() returns:
  // running interactive sessions + active/blocked background agents + teammates).
  const onFloor = live.agents.length;
  // ponytail: "shipping now" = agents whose activity is 'working' (the model is
  // actively generating). 'shell' (running a command) and 'idle' don't count.
  // This is an instantaneous snapshot, so on a 3s poll it's frequently 0 even
  // with agents present — true, but it reads dead. We keep it honest by RELABELING
  // it as a live $/hr burn rate (below) when we can derive one, and otherwise show
  // the working count under a clearer "generating now" frame.
  const workingCount = live.agents.filter((a) => a.activity === 'working').length;
  const shellCount = live.agents.filter((a) => a.activity === 'shell').length;
  const idleCount = onFloor - workingCount - shellCount;
  // ponytail: "teams" = distinct projects with a live agent (project = basename of
  // the agent's cwd). This counts the workspaces currently staffed, not the
  // collaborative-team records from readTeams() (which were almost always 0).
  const liveProjects = new Set(live.agents.map((a) => a && a.project).filter(Boolean));
  $('tsLive').textContent = onFloor;
  $('tsTeams').textContent = liveProjects.size;
  // Task 2: honest "generating now" count (model actively generating this instant).
  $('tsGenerating').textContent = workingCount;
  // Task 1: live token-burn from poll-to-poll deltas of lifetime.out.
  sampleBurn(usage);
  updateTopbarBurn();
  // Task 3 "Now" view panels (live, lightweight).
  renderNow({ onFloor, workingCount, shellCount, idleCount }, usage);
  // ponytail: track per-agent activity → drives the "just finished / unread" set.
  updateUnread(live.agents);
  updateSound(workingCount);
  $('emptyBanner').classList.toggle('hidden', live.agents.length > 0);

  // "Waiting on you" HUD: agents paused on a Stop hook (awaitingReply) OR a
  // background agent blocked waiting on the user (needsYou) — both need a look.
  renderWaiting(live.agents.filter((a) => a.awaitingReply || a.needsYou));

  renderManpower();
  renderModels(usage);
  renderDepts(usage);
  renderDaily(usage);
  renderLedger(usage);
  renderTicker();
}

// ---- topbar live token-burn ----------------------------------------------
// The honest "what's happening NOW": a LIVE output-token rate derived from
// poll-to-poll deltas of usage.lifetime.out (which is MONOTONIC — it never
// resets, unlike today.out which zeroes at midnight). We keep a short trailing
// window of {t, out} samples and compute rate = (newest.out - oldest.out) over
// the elapsed minutes, so it reads ~0 when idle and spikes on a burst — the
// genuine bursty signal. NO averages, no $-framing here (that moved to the
// Analytics tab). Guards: a missing/backwards lifetime.out never produces a
// rate; the FIRST sample (no prior) shows 0, never a phantom spike.
const BURN_WINDOW_MS = 5 * 60 * 1000; // 5-minute trailing window
const burnSamples = []; // [{ t: ms, out: lifetime.out }], oldest→newest
let liveBurnPerMin = 0; // tokens/min over the window (0 = idle/unknown)

function sampleBurn(usage) {
  const out = usage && usage.lifetime ? usage.lifetime.out : null;
  // Guard: missing or non-finite lifetime.out — don't record, don't fabricate.
  if (typeof out !== 'number' || !Number.isFinite(out)) {
    liveBurnPerMin = 0;
    return;
  }
  const now = Date.now();
  const prev = burnSamples.length ? burnSamples[burnSamples.length - 1] : null;
  // Guard: lifetime.out should be monotonic. If it goes BACKWARDS (e.g. a server
  // restart re-derived a smaller total, or a transient bad read), the window is
  // no longer a valid baseline — reset to this point and report 0 until we have a
  // fresh forward delta. This prevents a negative/garbage spike.
  if (prev && out < prev.out) {
    burnSamples.length = 0;
    burnSamples.push({ t: now, out });
    liveBurnPerMin = 0;
    return;
  }
  burnSamples.push({ t: now, out });
  // Drop samples older than the window (always keep ≥1 so we have a baseline).
  while (burnSamples.length > 1 && now - burnSamples[0].t > BURN_WINDOW_MS) {
    burnSamples.shift();
  }
  // First sample ever (no prior) → no delta → 0, never a huge spike.
  if (burnSamples.length < 2) {
    liveBurnPerMin = 0;
    return;
  }
  const oldest = burnSamples[0];
  const newest = burnSamples[burnSamples.length - 1];
  const minutes = (newest.t - oldest.t) / 60000;
  const deltaOut = newest.out - oldest.out;
  liveBurnPerMin = minutes > 0 ? Math.max(0, deltaOut / minutes) : 0;
}

function updateTopbarBurn() {
  const valEl = $('tsBurn');
  const lblEl = $('tsBurnLbl');
  if (!valEl) return;
  const active = liveBurnPerMin > 0;
  valEl.innerHTML = `${fmtBurn(liveBurnPerMin)} <span class="tstat-unit">tok/min</span>`;
  if (lblEl) lblEl.textContent = active ? 'burning now' : 'idle';
  valEl.title = 'live output-token rate over the last ~5 min (0 when idle)';
}

// Burn-specific number format: keep one decimal in the k range so "12.4k" reads,
// but show whole tokens below 1k and never the trailing ".0".
function fmtBurn(n) {
  n = n || 0;
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'k';
  return String(Math.round(n));
}

// ---- "just finished / unread" tracking ------------------------------------
// When an agent finishes a turn (active → idle) and the user hasn't opened it,
// it's "unread". We watch per-sessionId activity across polls and only mark
// unread on an OBSERVED active→idle transition — an agent already idle on first
// load is NOT unread (no false positives). The set is surfaced as a topbar count
// and exposed for an on-floor per-desk badge built in office.js:
//   - window.agencyUnread        : live Set<sessionId>, refreshed each poll
//   - 'agency:unread' CustomEvent: { detail: { ids: [...] } }, fired on change
// Viewing an agent (the existing agency:select event) clears its unread.
// ponytail: in-memory only for v1; localStorage persistence (so unread survives
// a refresh) is the upgrade.
const lastActivity = new Map(); // sessionId -> last seen activity
const unreadIds = new Set(); // sessionIds that just finished and aren't viewed yet
window.agencyUnread = unreadIds; // expose for office.js per-desk badge

function isActive(activity) {
  return activity === 'working' || activity === 'shell';
}

function emitUnread() {
  window.dispatchEvent(new CustomEvent('agency:unread', { detail: { ids: [...unreadIds] } }));
}

function updateUnread(agents) {
  const present = new Set();
  let changed = false;
  for (const a of agents) {
    const id = a && a.sessionId;
    if (!id) continue;
    present.add(id);
    const prev = lastActivity.get(id);
    const now = a.activity;
    // Only an OBSERVED transition counts. `prev === undefined` (first sighting)
    // never marks unread, so an agent already idle at page open stays read.
    if (prev !== undefined && isActive(prev) && !isActive(now)) {
      if (!unreadIds.has(id)) {
        unreadIds.add(id);
        changed = true;
      }
    }
    lastActivity.set(id, now);
  }
  // Forget agents that left the floor (and drop their stale unread).
  for (const id of lastActivity.keys()) {
    if (!present.has(id)) {
      lastActivity.delete(id);
      if (unreadIds.delete(id)) changed = true;
    }
  }
  renderUnreadPill();
  if (changed) emitUnread();
}

function clearUnread(sessionId) {
  if (sessionId && unreadIds.delete(sessionId)) {
    renderUnreadPill();
    emitUnread();
  }
}

let unreadPill = null;
function ensureUnreadPill() {
  if (unreadPill) return unreadPill;
  const stats = document.querySelector('.topstats');
  if (!stats) return null;
  unreadPill = document.createElement('button');
  unreadPill.type = 'button';
  unreadPill.id = 'unreadPill';
  unreadPill.className = 'unread-pill hidden';
  unreadPill.title = 'Agents that just finished a turn you haven’t opened — click to view';
  const live = stats.querySelector('.live-pill');
  if (live) stats.insertBefore(unreadPill, live);
  else stats.appendChild(unreadPill);
  return unreadPill;
}

function renderUnreadPill() {
  const pill = ensureUnreadPill();
  if (!pill) return;
  const n = unreadIds.size;
  if (!n) {
    pill.classList.add('hidden');
    return;
  }
  pill.classList.remove('hidden');
  pill.textContent = `✉ ${n} just finished`;
  pill.onclick = () => {
    // Open the first unread agent (clears its unread via the agency:select path).
    const first = unreadIds.values().next().value;
    const agent = STATE && STATE.live && STATE.live.agents
      ? STATE.live.agents.find((a) => a && a.sessionId === first)
      : null;
    if (agent) window.dispatchEvent(new CustomEvent('agency:select', { detail: { agent } }));
  };
}

// Viewing an agent (click on the floor, walk into its desk, or the waiting/unread
// pill) clears that agent's unread — same event every selection path already fires.
window.addEventListener('agency:select', (e) => {
  const agent = e && e.detail && e.detail.agent;
  if (agent && agent.sessionId) clearUnread(agent.sessionId);
});

// ---- "needs you" HUD (Control Phase-1) ------------------------------------
// A non-intrusive pill in the topbar showing how many agents are paused on a
// Stop hook waiting for a reply. Clicking it selects the first waiter, which
// opens the chat panel with the reply box (via the same agency:select event the
// renderer uses). The on-canvas per-agent indicator lives in office.js; this is
// just the at-a-glance count.
let waitingPill = null;

function ensureWaitingPill() {
  if (waitingPill) return waitingPill;
  const stats = document.querySelector('.topstats');
  if (!stats) return null;
  waitingPill = document.createElement('button');
  waitingPill.type = 'button';
  waitingPill.id = 'waitingPill';
  waitingPill.className = 'waiting-pill hidden';
  waitingPill.title = 'Agents paused, waiting for your reply — click to answer';
  // Insert before the LIVE pill so it reads alongside the status chips.
  const live = stats.querySelector('.live-pill');
  if (live) stats.insertBefore(waitingPill, live);
  else stats.appendChild(waitingPill);
  return waitingPill;
}

function renderWaiting(waiters) {
  const pill = ensureWaitingPill();
  if (!pill) return;
  const n = waiters.length;
  if (!n) {
    pill.classList.add('hidden');
    return;
  }
  pill.classList.remove('hidden');
  pill.textContent = `🔔 ${n} waiting on you`;
  pill.onclick = () => {
    // Jump straight into answering the first (oldest) waiter.
    const first = waiters.slice().sort((a, b) => (a.pendingSince || 0) - (b.pendingSince || 0))[0];
    if (first) window.dispatchEvent(new CustomEvent('agency:select', { detail: { agent: first } }));
  };
}

// ---- "Now" view (default) -------------------------------------------------
// The current-activity panels: live token-burn (mirrors the topbar), a
// working/shell/idle breakdown of the live floor, and recent tool-call activity.
// Everything here is instantaneous/live — no averages, no $-framing.

function renderNow(counts, usage) {
  const { onFloor, workingCount, shellCount, idleCount } = counts;

  // Live burn (same figure as the topbar, larger).
  const burnEl = $('nowBurn');
  if (burnEl) burnEl.textContent = fmtBurn(liveBurnPerMin);
  const burnNote = $('nowBurnNote');
  if (burnNote) {
    burnNote.textContent = liveBurnPerMin > 0
      ? 'output tokens / min over the last ~5 min'
      : 'no output flowing right now · 0 when idle';
  }

  // Working / shell / idle breakdown of the floor.
  setText('nowGenerating', workingCount);
  setText('nowShell', shellCount);
  setText('nowIdle', Math.max(0, idleCount));

  // Proportional bar (working = green, shell = amber, idle = grey).
  const bar = $('nowBar');
  if (bar) {
    bar.innerHTML = '';
    const total = onFloor;
    if (total > 0) {
      const segs = [
        ['now-seg-working', workingCount],
        ['now-seg-shell', shellCount],
        ['now-seg-idle', Math.max(0, idleCount)],
      ];
      for (const [cls, n] of segs) {
        if (n <= 0) continue;
        const seg = document.createElement('div');
        seg.className = 'now-seg ' + cls;
        seg.style.width = (100 * n) / total + '%';
        bar.appendChild(seg);
      }
    }
  }
  const foot = $('nowFoot');
  if (foot) {
    foot.textContent = onFloor === 0
      ? 'No agents on the floor.'
      : `${onFloor} on the floor · ${workingCount} generating`;
  }

  renderNowTools(usage);
}

// Recent tool-call activity: which currently-active workspaces have logged the
// most tool actions. /api/state carries no per-window tool count, only all-time
// `tools` and `recentOut` (output within the recency window), so we SCOPE to
// projects that are live now or shipped recently (honest "currently active") and
// rank those by their all-time tool actions. Fall back to all-time if nothing is
// active so the panel never goes blank.
function renderNowTools(usage) {
  const list = $('nowToolList');
  if (!list) return;
  const liveProjects = new Set(
    (STATE && STATE.live && STATE.live.agents ? STATE.live.agents : [])
      .map((a) => a && a.project)
      .filter(Boolean)
  );
  const all = Object.entries(usage.byProject || {}).map(([p, v]) => ({
    project: p,
    tools: v.tools || 0,
    recentOut: v.recentOut || 0,
  }));
  // Active = a live agent here now, or output shipped within the recency window.
  let entries = all.filter((e) => e.recentOut > 0 || liveProjects.has(e.project));
  let fallback = false;
  if (!entries.some((e) => e.tools > 0)) {
    entries = all.filter((e) => e.tools > 0);
    fallback = true;
  }
  entries.sort((a, b) => (b.tools || 0) - (a.tools || 0));
  entries = entries.slice(0, 5);
  const max = entries.length ? entries[0].tools || 1 : 1;

  const hint = $('nowToolsHint');
  if (hint) hint.textContent = fallback ? 'all-time' : `active · last ${usage.recentWindowDays || 7}d`;

  list.innerHTML = '';
  if (!entries.length) {
    list.innerHTML = '<div class="dept-empty">No tool activity yet.</div>';
    return;
  }
  for (const e of entries) {
    const live = liveProjects.has(e.project);
    const liveTag = live ? '<span class="dept-live" title="an agent is here now">●</span>' : '';
    const val = e.tools || 0;
    const barW = max ? (100 * val) / max : 0;
    const row = document.createElement('div');
    row.className = 'nowtool-row';
    row.innerHTML = `
      <div class="nowtool-head"><span class="nowtool-name">${liveTag}${escapeHtml(e.project)}</span>
        <span class="nowtool-val">${fmt(val)} actions</span></div>
      <div class="nowtool-bar"><div class="nowtool-fill" style="width:${barW}%"></div></div>`;
    list.appendChild(row);
  }
}

function setText(id, v) {
  const el = $(id);
  if (el) el.textContent = String(v);
}

// ---- manpower -------------------------------------------------------------

function recentDailyAvgOut(usage) {
  const d = usage.daily || [];
  if (!d.length) return 0;
  const last = d.slice(-7);
  const sum = last.reduce((s, x) => s + (x.out || 0), 0);
  return sum / Math.max(1, last.length);
}

function renderManpower() {
  if (!STATE) return;
  const usage = STATE.usage;
  const perEngDay = assume.tok * assume.hrs; // output tokens one engineer ships/day
  const perEngYear = perEngDay * assume.days;

  const avgDailyOut = recentDailyAvgOut(usage);
  const teamSize = avgDailyOut / perEngDay; // effective FTEs at recent pace
  const engYears = (usage.lifetime.out || 0) / perEngYear;
  const payroll = engYears * assume.sal;
  const engDaysToday = (usage.today.out || 0) / perEngDay;

  $('hcNum').textContent = teamSize.toFixed(1);
  $('mEngYears').textContent = engYears >= 1 ? engYears.toFixed(1) : engYears.toFixed(2);
  $('mPayroll').textContent = money(payroll);
  $('mToday').textContent = engDaysToday.toFixed(engDaysToday >= 10 ? 0 : 1);

  updatePayrollRate(avgDailyOut, perEngDay);

  const team = Math.max(1, Math.round(teamSize));
  const shown = Math.min(team, 60);
  const cap = team > shown ? ` <span class="hc-cap">(showing ${shown})</span>` : '';
  $('hcCompare').innerHTML = `1 human operating like a team of <b>${team}</b>${cap}`;
  drawHeadcount(team);
}

function drawHeadcount(team) {
  const cv = $('headsCanvas');
  const cssW = cv.clientWidth || 300;
  const HEAD_W = 12, HEAD_H = 13, GAP = 3;
  const perRow = Math.max(6, Math.floor((cssW * 0.9) / ((HEAD_W + GAP))));
  const show = Math.min(team, 60);
  const rows = Math.ceil(show / perRow);

  const scale = 3;
  cv.width = perRow * (HEAD_W + GAP) * scale;
  cv.height = Math.max(1, rows) * (HEAD_H + GAP) * scale;
  const ctx = cv.getContext('2d');
  ctx.imageSmoothingEnabled = false;
  ctx.setTransform(scale, 0, 0, scale, 0, 0);
  ctx.clearRect(0, 0, cv.width, cv.height);

  for (let i = 0; i < show; i++) {
    const r = Math.floor(i / perRow);
    const c = i % perRow;
    const x = c * (HEAD_W + GAP);
    const y = r * (HEAD_H + GAP);
    if (i === 0) {
      // "you" — gold to stand out
      drawHead(ctx, x, y, { skin: '#ffe0b0', hair: '#3a2a18', shirt: '#ffd166' });
    } else {
      const t = (i * 73) % 360;
      drawHead(ctx, x, y, {
        skin: ['#f0c8a0', '#d8a070', '#a87048'][i % 3],
        hair: ['#2b2233', '#5a3a26', '#26333a'][(i >> 1) % 3],
        shirt: `hsl(${t} 55% 60%)`,
      });
    }
  }
}

// ---- live payroll-equivalent meter ---------------------------------------
// A money meter that ticks UP in real time. We derive a $/sec accrual rate from
// recent throughput and accumulate it via requestAnimationFrame so the figure
// keeps climbing while the page is open. The rate is recomputed on every slider
// change / new STATE without resetting the running total (no jarring jumps).

let payrollRate = 0; // dollars per second
let payrollTotal = 0; // accumulated dollars shown on the meter
let payrollLastTs = 0; // timestamp of last rAF frame (ms)
let payrollStarted = false;

function updatePayrollRate(avgDailyOut, perEngDay) {
  // engineer-days produced per real day -> $/day -> $/sec.
  // perEngDay = tok/hr * hrs = output one engineer ships per workday.
  const engDaysPerDay = perEngDay > 0 ? avgDailyOut / perEngDay : 0;
  const dollarsPerWorkday = assume.days > 0 ? assume.sal / assume.days : 0;
  const dollarsPerDay = engDaysPerDay * dollarsPerWorkday;
  payrollRate = Math.max(0, dollarsPerDay / 86400);

  const rateEl = $('pmRate');
  if (rateEl) rateEl.textContent = payrollRate > 0 ? `+${money(payrollRate * 3600)}/hr` : '—';

  // Seed the starting total once with the lifetime payroll equivalent so the
  // meter shows a meaningful figure immediately, then climbs from there.
  if (!payrollStarted) {
    const usage = STATE && STATE.usage;
    if (usage && usage.lifetime) {
      const perEngYear = perEngDay * assume.days;
      const engYears = perEngYear > 0 ? (usage.lifetime.out || 0) / perEngYear : 0;
      payrollTotal = engYears * assume.sal;
      payrollStarted = true;
    }
  }
}

function renderPayrollValue() {
  const el = $('pmValue');
  if (!el) return;
  const whole = Math.floor(payrollTotal);
  const cents = Math.floor((payrollTotal - whole) * 100);
  el.innerHTML = `$${comma(whole)}<span class="pm-cents">.${String(cents).padStart(2, '0')}</span>`;
}

function payrollTick(ts) {
  if (payrollLastTs) {
    // Clamp dt so a backgrounded/throttled tab doesn't dump a huge lump sum on
    // refocus (rAF pauses in hidden tabs). Smooth climbing only.
    const dt = Math.min((ts - payrollLastTs) / 1000, 1);
    payrollTotal += payrollRate * dt;
  }
  payrollLastTs = ts;
  renderPayrollValue();
  requestAnimationFrame(payrollTick);
}
requestAnimationFrame(payrollTick);

// ---- model mix ------------------------------------------------------------

function renderModels(usage) {
  const entries = Object.entries(usage.byModel || {})
    .map(([m, v]) => ({ model: m, out: v.out }))
    .filter((e) => e.out > 0)
    .sort((a, b) => b.out - a.out);
  const total = entries.reduce((s, e) => s + e.out, 0) || 1;

  const bar = $('modelBar');
  bar.innerHTML = '';
  entries.forEach((e) => {
    const seg = document.createElement('div');
    seg.className = 'seg';
    seg.style.width = (100 * e.out) / total + '%';
    seg.style.background = colorFor(e.model).screen;
    seg.title = `${e.model}: ${fmt(e.out)}`;
    bar.appendChild(seg);
  });

  const legend = $('modelLegend');
  legend.innerHTML = '';
  entries.slice(0, 5).forEach((e) => {
    const item = document.createElement('div');
    item.className = 'legend-item';
    const pct = ((100 * e.out) / total).toFixed(0);
    item.innerHTML = `<span class="swatch" style="background:${colorFor(e.model).screen}"></span>
      <span class="lg-name">${shortModel(e.model)}</span><span class="lg-val">${pct}% · ${fmt(e.out)}</span>`;
    legend.appendChild(item);
  });
}

function shortModel(m) {
  return m
    .replace('claude-', '')
    .replace(/-\d{8}$/, '')
    .replace(/\[1m\]/, ' 1M')
    .replace(/^.+\//, '');
}

// ---- departments ----------------------------------------------------------
// The user's main data complaint was that this panel listed every workspace
// they'd ever opened (derived from all-time transcript history), drowning the
// few they're actually working in now. We scope it to CURRENTLY-ACTIVE
// workspaces: a project counts if it shipped output within the recency window
// (usage.recentWindowDays, default 7) OR has a live agent on the floor right
// now. Bars are sized by recent output so the busiest *current* work reads
// loudest. Fail soft: if nothing is recent we fall back to all-time so the
// panel never goes mysteriously empty.

function renderDepts(usage) {
  const liveProjects = new Set(
    (STATE && STATE.live && STATE.live.agents ? STATE.live.agents : [])
      .map((a) => a && a.project)
      .filter(Boolean)
  );

  const all = Object.entries(usage.byProject || {})
    .map(([p, v]) => ({ project: p, ...v, recentOut: v.recentOut || 0 }));

  // Active = recent output, or a live agent sitting in that project right now.
  let entries = all.filter((e) => e.recentOut > 0 || liveProjects.has(e.project));
  let metric = 'recentOut';
  let fallback = false;
  if (!entries.length) {
    // Nothing recent (e.g. a fresh boot before today's work) — show all-time so
    // the panel still says something useful rather than going blank.
    entries = all.filter((e) => e.out > 0);
    metric = 'out';
    fallback = true;
  }

  entries.sort((a, b) => b[metric] - a[metric]);
  const total = entries.length;
  entries = entries.slice(0, 7);
  const max = entries.length ? entries[0][metric] || 1 : 1;

  const win = usage.recentWindowDays || 7;
  const hintEl = $('deptHint');
  if (hintEl) {
    hintEl.textContent = fallback
      ? 'all-time (nothing active yet)'
      : `active · last ${win}d`;
  }

  const list = $('deptList');
  list.innerHTML = '';
  if (!entries.length) {
    list.innerHTML = '<div class="dept-empty">No active workspaces yet.</div>';
    return;
  }
  entries.forEach((e) => {
    const live = liveProjects.has(e.project);
    const liveTag = live ? '<span class="dept-live" title="an agent is here now">●</span>' : '';
    // Sort/scale by the chosen metric, but never show a bare "0" for a project
    // that's only here because an agent is sitting in it right now (recentOut 0
    // but live) — fall back to its all-time output, marked so it doesn't read as
    // "shipped this week".
    let val = e[metric];
    let valNote = '';
    if (metric === 'recentOut' && val === 0 && live) {
      val = e.out;
      valNote = '<span class="dept-alltime" title="no output yet this week — showing all-time"> all-time</span>';
    }
    const barW = max ? (100 * (metric === 'recentOut' ? e.recentOut : val)) / max : 0;
    const row = document.createElement('div');
    row.className = 'dept-row';
    row.innerHTML = `
      <div class="dept-head"><span class="dept-name">${liveTag}${escapeHtml(e.project)}</span>
        <span class="dept-val">${fmt(val)}${valNote}</span></div>
      <div class="dept-bar"><div class="dept-fill" style="width:${barW}%"></div></div>
      <div class="dept-meta">${e.sessions} sessions · ${fmt(e.tools)} actions · ${e.agents} subagents</div>`;
    list.appendChild(row);
  });

  // If we trimmed the list, note how many active workspaces exist in total.
  if (total > entries.length) {
    const more = document.createElement('div');
    more.className = 'dept-more';
    more.textContent = `+${total - entries.length} more active`;
    list.appendChild(more);
  }
}

// ---- daily chart ----------------------------------------------------------

function renderDaily(usage) {
  const cv = $('dailyCanvas');
  const days = (usage.daily || []).slice(-30);
  const cssW = cv.clientWidth || 320;
  const cssH = 90;
  const dpr = window.devicePixelRatio || 1;
  cv.width = cssW * dpr;
  cv.height = cssH * dpr;
  cv.style.height = cssH + 'px';
  const ctx = cv.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssW, cssH);
  if (!days.length) return;

  const max = Math.max(...days.map((d) => d.out)) || 1;
  const today = new Date().toLocaleDateString('en-CA');
  const gap = 2;
  const bw = Math.max(2, (cssW - gap * (days.length - 1)) / days.length);
  days.forEach((d, i) => {
    const h = Math.max(1, (d.out / max) * (cssH - 14));
    const x = i * (bw + gap);
    const y = cssH - h - 12;
    ctx.fillStyle = d.date === today ? '#39d98a' : '#3a6ea5';
    ctx.fillRect(x, y, bw, h);
  });
  // baseline + max label
  ctx.fillStyle = '#5b6478';
  ctx.font = '11px VT323, monospace';
  ctx.fillText(`peak ${fmt(max)} tok`, 2, cssH - 1);
  ctx.textAlign = 'right';
  ctx.fillText(`${days.length}d`, cssW - 2, cssH - 1);
  ctx.textAlign = 'left';
}

// ---- ledger ---------------------------------------------------------------

function renderLedger(usage) {
  const L = usage.lifetime;
  const rows = [
    ['Output tokens', fmt(L.out)],
    ['Input tokens', fmt(L.in)],
    ['Cache reads', fmt(L.cr)],
    ['Assistant turns', comma(L.msgs)],
    ['Tool actions', comma(L.tools)],
    ['Subagents hired', comma(L.agents)],
    ['Sessions worked', comma(L.sessions)],
    ['Active days', `${usage.activeDays}`],
    ['First day on the job', usage.firstDay || '—'],
  ];
  const el = $('ledger');
  el.innerHTML = rows
    .map(([k, v]) => `<div class="ledger-row"><span>${k}</span><b>${v}</b></div>`)
    .join('');
}

// ---- ticker ---------------------------------------------------------------

function fmtUptimeShort(ms) {
  if (ms == null) return '';
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h > 0 ? `${h}h${m}m` : `${m}m`;
}

function renderTicker() {
  const { live, usage } = STATE;
  const items = [];
  for (const a of live.agents) {
    const ml = a.model ? shortModel(a.model) : '?';
    const name = escapeHtml(a.name);
    const proj = escapeHtml(a.project);
    const labelText = a.task || a.chatName || a.lastPrompt;
    const label = labelText ? `"${escapeHtml(labelText)}"` : '';
    const up = fmtUptimeShort(a.uptimeMs);
    const subN = (a.subagents || []).length;
    const sub = subN ? ` · 🤖 ${subN} subagent${subN > 1 ? 's' : ''}` : '';
    const src = a.source === 'opencode' ? ' · opencode' : a.source === 'codex' ? ' · codex' : '';
    if (a.activity === 'working') {
      items.push(`🟢 <b>${name}</b>${src} (${escapeHtml(a.title)}) shipping in <b>${proj}</b>${label ? ` — ${label}` : ''} · ${ml}${sub} · up ${up}`);
    } else if (a.activity === 'shell') {
      items.push(`⚙ <b>${name}</b>${src} running a command in <b>${proj}</b>${label ? ` — ${label}` : ''}${sub} · up ${up}`);
    } else if (a.state === 'done') {
      items.push(`✅ <b>${name}</b>${src} finished${label ? ` ${label}` : ''} in ${proj} · up ${up}`);
    } else {
      items.push(`💤 <b>${name}</b>${src} idle in ${proj}${label ? ` — ${label}` : ''}${sub} · up ${up}`);
    }
  }
  // Busiest department: prefer the busiest *currently-active* workspace (by
  // recent output) so the ticker celebrates what's live, not a long-dead repo;
  // fall back to all-time if nothing is recent.
  const projEntries = Object.entries(usage.byProject || {});
  const topRecent = projEntries
    .filter(([, v]) => (v.recentOut || 0) > 0)
    .sort((a, b) => (b[1].recentOut || 0) - (a[1].recentOut || 0))[0];
  const top = topRecent || projEntries.sort((a, b) => b[1].out - a[1].out)[0];
  const topVal = topRecent ? top[1].recentOut : top && top[1].out;
  items.push(`📊 ${fmt(usage.lifetime.out)} output tokens shipped all-time`);
  items.push(`🤖 ${comma(usage.lifetime.agents)} subagents dispatched across ${comma(usage.lifetime.sessions)} sessions`);
  if (top) items.push(`🏆 busiest department: <b>${escapeHtml(top[0])}</b> (${fmt(topVal)})`);
  items.push(`📅 ${usage.activeDays} days on the job since ${usage.firstDay || '—'}`);

  const track = $('tickerTrack');
  const html = items.map((t) => `<span class="tick">${t}</span>`).join('<span class="tick-sep">◆</span>');
  // duplicate for seamless marquee
  track.innerHTML = html + '<span class="tick-sep">◆</span>' + html;
}

// ---- utils ----------------------------------------------------------------

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

// ---- boot -----------------------------------------------------------------

bindSlider('sTok', 'tok', (v) => comma(v));
bindSlider('sHrs', 'hrs', (v) => String(v));
bindSlider('sDays', 'days', (v) => String(v));
bindSlider('sSal', 'sal', (v) => '$' + Math.round(v / 1000) + 'k');

// ---- sidebar view toggle: Now (default) | Analytics ----------------------
// "Now" = current activity (live burn, generating count, working/idle split,
// recent tool calls). "Analytics" = the relocated windowed/historical panels
// (effective team size, eng-years, payroll-equiv + meter, model mix, depts,
// daily). Default is Now. ponytail: persisted to localStorage; falls back to
// in-memory if storage is unavailable (private mode / quota).
(function wireViewToggle() {
  const nowBtn = $('vtNow');
  const anaBtn = $('vtAnalytics');
  const nowView = $('viewNow');
  const anaView = $('viewAnalytics');
  if (!nowBtn || !anaBtn || !nowView || !anaView) return;

  function readPref() {
    try {
      return localStorage.getItem('agency.view') === 'analytics' ? 'analytics' : 'now';
    } catch {
      return 'now';
    }
  }
  function setView(view) {
    const analytics = view === 'analytics';
    nowView.classList.toggle('hidden', analytics);
    anaView.classList.toggle('hidden', !analytics);
    nowBtn.classList.toggle('active', !analytics);
    anaBtn.classList.toggle('active', analytics);
    nowBtn.setAttribute('aria-selected', String(!analytics));
    anaBtn.setAttribute('aria-selected', String(analytics));
    try {
      localStorage.setItem('agency.view', view);
    } catch {
      /* in-memory only */
    }
    // Analytics has canvases (heads, daily) sized to clientWidth — they render to
    // 0px while hidden, so re-render on reveal to size them correctly.
    if (analytics && STATE) {
      renderManpower();
      renderDaily(STATE.usage);
    }
  }
  nowBtn.addEventListener('click', () => setView('now'));
  anaBtn.addEventListener('click', () => setView('analytics'));
  setView(readPref());
})();

// ---- sound toggle ---------------------------------------------------------
// Pref is read at load (no audio yet); the AudioContext is created/resumed only
// inside the click handler (a user gesture). Defaults to OFF.
(function wireSound() {
  const btn = $('soundToggle');
  if (!btn) return;
  function paint(on) {
    btn.textContent = on ? '🔊' : '🔇';
    btn.classList.toggle('on', on);
    btn.setAttribute('aria-pressed', on ? 'true' : 'false');
  }
  // Reflect the saved pref visually, but do NOT start audio until a gesture.
  paint(initSoundPref());
  btn.addEventListener('click', () => {
    const on = toggleSound(); // creates/resumes AudioContext on first enable
    paint(on);
  });
})();

window.addEventListener('resize', () => {
  if (STATE) {
    renderManpower();
    renderDaily(STATE.usage);
  }
});

if (mockEnabled) {
  const sub = document.querySelector('.brand-sub');
  if (sub) sub.textContent = 'MOCK MODE — synthetic data';
}

poll();
setInterval(poll, 3000);
