// timeline.js — the Timeline view: REPLAY the last few hours of the office floor
// and chart concurrency + per-agent uptime / wait-for-you stats. Reads
// /api/history (the server-side floor recorder) and does all the chart + stat
// math client-side, like the rest of app.js.
//
// "Playback" reuses office.js setAgents: feed it a reconstructed historical
// agent array and the existing renderer draws the floor exactly as it was. While
// playback is engaged we set window.agencyPlayback=true so app.js stops
// overwriting the floor with the live poll; "● LIVE" clears it and restores the
// current floor (app.js publishes it on window.agencyLiveAgents each poll).

import { setAgents } from './office.js';

const $ = (id) => document.getElementById(id);

let snaps = []; // [{ t, a:[{id,name,project,act,need,role,subs}] }], oldest→newest
let sampleMs = 20000; // recorder cadence (from the API); drives the stat math
let windowMs = 6 * 60 * 60 * 1000;
let idx = 0; // current playback snapshot index
let playing = false;
let playTimer = null;
let refreshTimer = null;
let active = false; // Timeline view currently visible

const SPEEDS = [1, 2, 4]; // snapshots advanced per tick (relative playback speed)
let speedIdx = 1;
const TICK_MS = 220;
const REFRESH_MS = 15000;

export function initTimeline() {
  $('tlPlay').addEventListener('click', togglePlay);
  $('tlLive').addEventListener('click', goLive);
  $('tlSpeed').addEventListener('click', cycleSpeed);
  $('tlScrub').addEventListener('input', onScrub);
  $('tlSpeed').textContent = `${SPEEDS[speedIdx]}×`; // sync label with the actual default speed
  window.addEventListener('resize', () => { if (active) renderChart(); });
  // The sidebar view toggle (app.js) fires this when a view becomes visible.
  window.addEventListener('agency:view', (e) => {
    const v = e && e.detail && e.detail.view;
    if (v === 'timeline') enter();
    else leave();
  });
}

// ---- enter / leave the view --------------------------------------------------

function enter() {
  if (active) return;
  active = true;
  fetchHistory(true);
  refreshTimer = setInterval(() => fetchHistory(false), REFRESH_MS);
}

function leave() {
  if (!active) return;
  active = false;
  stopPlay();
  exitPlayback(); // hand the floor back to the live poll
  clearInterval(refreshTimer);
  refreshTimer = null;
}

// ---- data --------------------------------------------------------------------

async function fetchHistory(full) {
  try {
    const since = !full && snaps.length ? snaps[snaps.length - 1].t : 0;
    const res = await fetch('/api/history' + (since ? `?since=${since}` : ''), { cache: 'no-store' });
    const data = await res.json();
    if (data && typeof data.sampleMs === 'number') sampleMs = data.sampleMs;
    if (data && typeof data.windowMs === 'number') windowMs = data.windowMs;
    const incoming = (data && Array.isArray(data.snapshots)) ? data.snapshots : [];
    if (full) snaps = incoming;
    else if (incoming.length) snaps.push(...incoming);
    // In LIVE mode the scrubber tracks the newest sample; trim the client copy to
    // the retained window so a long-open tab doesn't grow unbounded. (We never
    // trim mid-playback — it would shift the indices under the scrubber.)
    if (!window.agencyPlayback && snaps.length) {
      const cutoff = snaps[snaps.length - 1].t - windowMs;
      while (snaps.length > 1 && snaps[0].t < cutoff) snaps.shift();
      idx = snaps.length - 1;
    }
    onData();
  } catch {
    // server probably still warming up — the refresh tick retries
  }
}

function onData() {
  const scrub = $('tlScrub');
  const max = Math.max(0, snaps.length - 1);
  scrub.max = String(max);
  if (!window.agencyPlayback) scrub.value = String(max);
  $('tlPlay').disabled = snaps.length < 2;
  const note = $('tlNote');
  if (note) {
    note.textContent = snaps.length < 2
      ? 'Collecting activity… leave the dashboard open.'
      : `${snaps.length} samples · every ${Math.round(sampleMs / 1000)}s · drag to scrub, ▶ to replay`;
  }
  const hint = $('tlChartHint');
  if (hint) hint.textContent = `last ${fmtSpan(windowMs)}`;
  renderChart();
  renderStats();
  updateTimeLabel();
}

// ---- transport ---------------------------------------------------------------

function togglePlay() {
  if (snaps.length < 2) return;
  if (playing) { stopPlay(); return; }
  enterPlayback();
  // Restart from the beginning if we're parked at the very end.
  if (idx >= snaps.length - 1) idx = 0;
  renderFrame(idx); // paint the starting frame now — playStep advances BEFORE drawing
  playing = true;
  updatePlayBtn();
  playTimer = setInterval(playStep, TICK_MS);
}

function stopPlay() {
  playing = false;
  clearInterval(playTimer);
  playTimer = null;
  updatePlayBtn();
}

function playStep() {
  idx += SPEEDS[speedIdx];
  if (idx >= snaps.length - 1) {
    renderFrame(snaps.length - 1);
    stopPlay();
    goLive(); // reached the present → resume the live floor
    return;
  }
  renderFrame(idx);
}

function onScrub(e) {
  if (snaps.length < 2) return;
  stopPlay();
  enterPlayback();
  renderFrame(Number(e.target.value) | 0);
}

function cycleSpeed() {
  speedIdx = (speedIdx + 1) % SPEEDS.length;
  $('tlSpeed').textContent = `${SPEEDS[speedIdx]}×`;
}

function updatePlayBtn() {
  const b = $('tlPlay');
  if (b) b.textContent = playing ? '⏸' : '▶';
}

// ---- playback / live handoff -------------------------------------------------

function enterPlayback() {
  window.agencyPlayback = true;
}

function exitPlayback() {
  window.agencyPlayback = false;
  // Restore the current floor immediately rather than waiting for the next poll.
  try { setAgents(window.agencyLiveAgents || []); } catch { /* renderer hiccup */ }
}

function goLive() {
  stopPlay();
  exitPlayback();
  idx = Math.max(0, snaps.length - 1);
  $('tlScrub').value = String(idx);
  updateTimeLabel();
  renderChart(); // drop the playhead
}

// Render the office floor at snapshot i (the heart of "playback").
function renderFrame(i) {
  i = Math.max(0, Math.min(i, snaps.length - 1));
  idx = i;
  $('tlScrub').value = String(i);
  try { setAgents(reconstruct(snaps[i].a)); } catch { /* renderer hiccup */ }
  updateTimeLabel();
  renderChart(); // move the playhead
}

// Rebuild a renderable agent from a thin history record — enough for office.js to
// draw desks, project rugs, activity LEDs, lead crowns, minions and needs-you
// bubbles. ponytail: teammate dress (teamColor) + lead-tie lines aren't recorded,
// so replayed teammates render as plain workers — store those fields to recover it.
function reconstruct(list) {
  return (list || []).map((x) => ({
    pid: null,
    sessionId: x.id,
    source: 'claude',
    cwd: x.cwd || null, // lets the chat panel peek this agent's transcript
    project: x.project,
    kind: x.role === 'teammate' ? 'teammate' : 'interactive',
    activity: x.act,
    status: x.act === 'working' ? 'busy' : 'idle',
    state: null,
    needsYou: !!x.need,
    awaitingReply: false,
    task: null,
    chatName: null,
    lastPrompt: null,
    subagents: Array.from({ length: x.subs || 0 }, () => ({ type: 'agent' })),
    startedAt: null,
    uptimeMs: null,
    model: null,
    role: x.role === 'lead' ? 'lead' : null,
    teamColor: null,
    teammateName: x.role === 'teammate' ? x.name : null,
    leadName: null,
    name: x.name,
    hidden: false,
  }));
}

// ---- concurrency chart (stacked area: generating / shell / idle) -------------

function renderChart() {
  const cv = $('tlChart');
  if (!cv || typeof cv.getContext !== 'function') return;
  const cssW = cv.clientWidth || 300;
  const cssH = 120;
  const dpr = window.devicePixelRatio || 1;
  cv.width = Math.max(1, Math.round(cssW * dpr));
  cv.height = Math.round(cssH * dpr);
  cv.style.height = cssH + 'px';
  const ctx = cv.getContext('2d');
  if (!ctx) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssW, cssH);

  const padT = 8, padB = 16, padL = 4, padR = 4;
  const plotW = cssW - padL - padR;
  const plotH = cssH - padT - padB;
  const baseY = padT + plotH;

  ctx.strokeStyle = 'rgba(108,118,137,0.25)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(padL, baseY + 0.5);
  ctx.lineTo(cssW - padR, baseY + 0.5);
  ctx.stroke();

  const n = snaps.length;
  if (n < 2) return;

  const counts = snaps.map((s) => {
    let w = 0, sh = 0, id = 0;
    for (const x of s.a) {
      if (x.act === 'working') w++;
      else if (x.act === 'shell') sh++;
      else id++;
    }
    return { w, sh, id, total: w + sh + id };
  });
  const max = Math.max(1, ...counts.map((c) => c.total));
  const xFor = (i) => padL + (i / (n - 1)) * plotW;
  const yFor = (v) => baseY - (v / max) * plotH;

  // Stacked bands, bottom → top: generating, running-cmd, idle.
  const band = (lowFn, highFn, color) => {
    ctx.beginPath();
    for (let i = 0; i < n; i++) { const x = xFor(i), y = yFor(highFn(counts[i])); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); }
    for (let i = n - 1; i >= 0; i--) { ctx.lineTo(xFor(i), yFor(lowFn(counts[i]))); }
    ctx.closePath();
    ctx.fillStyle = color;
    ctx.fill();
  };
  band((c) => 0, (c) => c.w, 'rgba(57,217,138,0.85)');
  band((c) => c.w, (c) => c.w + c.sh, 'rgba(255,180,84,0.8)');
  band((c) => c.w + c.sh, (c) => c.total, 'rgba(108,118,137,0.45)');

  // Playhead at the replayed moment.
  if (window.agencyPlayback) {
    const x = xFor(Math.min(idx, n - 1));
    ctx.strokeStyle = '#5cd0ff';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x, padT);
    ctx.lineTo(x, baseY);
    ctx.stroke();
  }

  ctx.fillStyle = '#6b7689';
  ctx.font = '11px "IBM Plex Mono", monospace';
  ctx.fillText(`peak ${max}`, padL + 2, padT + 9);
  ctx.fillText(fmtClock(snaps[0].t), padL + 2, cssH - 3);
  ctx.textAlign = 'right';
  ctx.fillText(fmtClock(snaps[n - 1].t), cssW - padR - 2, cssH - 3);
  ctx.textAlign = 'left';
}

// ---- per-agent stats: uptime, work%, avg wait-for-you ------------------------

// Aggregate each agent across the window. "Waiting" = idle OR flagged needs-you;
// a run of consecutive waiting samples (broken when the agent works or leaves the
// floor) is one wait; avg wait is the mean run length × the sample cadence.
function aggregate() {
  const stats = new Map();
  for (const s of snaps) {
    const present = new Set();
    for (const x of s.a) {
      if (!x.id) continue;
      present.add(x.id);
      let st = stats.get(x.id);
      if (!st) { st = { name: x.name, project: x.project, present: 0, work: 0, runs: [], cur: 0, waiting: false }; stats.set(x.id, st); }
      st.name = x.name; st.project = x.project;
      st.present++;
      if (x.act === 'working') st.work++;
      const waiting = x.act === 'idle' || !!x.need;
      if (waiting) { st.cur++; st.waiting = true; }
      else if (st.waiting) { st.runs.push(st.cur); st.cur = 0; st.waiting = false; }
    }
    // An agent absent this sample ends any open wait run.
    for (const [id, st] of stats) {
      if (!present.has(id) && st.waiting) { st.runs.push(st.cur); st.cur = 0; st.waiting = false; }
    }
  }
  for (const [, st] of stats) { if (st.waiting && st.cur > 0) st.runs.push(st.cur); } // close trailing run
  return stats;
}

function renderStats() {
  const host = $('tlStats');
  if (!host) return;
  const rows = [...aggregate().values()].sort((a, b) => b.present - a.present).slice(0, 12);
  if (!rows.length) { host.innerHTML = '<div class="tl-empty">No agents recorded yet.</div>'; return; }
  host.innerHTML =
    '<div class="tl-row tl-head"><span>Agent</span><span>up</span><span>work</span><span title="avg stretch waiting on you">wait</span></div>' +
    rows.map((r) => {
      const up = fmtDur(r.present * sampleMs);
      const workPct = r.present ? Math.round((100 * r.work) / r.present) : 0;
      const avgWait = r.runs.length ? fmtDur((r.runs.reduce((s, v) => s + v, 0) / r.runs.length) * sampleMs) : '—';
      return `<div class="tl-row"><span class="tl-name" title="${escAttr(r.project)}">${escHtml(r.name)}</span>` +
        `<span>${up}</span><span>${workPct}%</span><span>${avgWait}</span></div>`;
    }).join('');
}

// ---- helpers -----------------------------------------------------------------

function updateTimeLabel() {
  const el = $('tlTime');
  if (!el) return;
  if (!window.agencyPlayback || !snaps.length) {
    el.textContent = 'LIVE';
    el.classList.add('tl-islive');
    return;
  }
  el.classList.remove('tl-islive');
  const i = Math.min(idx, snaps.length - 1);
  const ago = Math.max(0, snaps[snaps.length - 1].t - snaps[i].t);
  el.textContent = `${fmtClock(snaps[i].t, true)} · ${fmtDur(ago)} ago`;
}

function fmtClock(t, withSeconds) {
  return new Date(t).toLocaleTimeString([], withSeconds
    ? { hour: '2-digit', minute: '2-digit', second: '2-digit' }
    : { hour: '2-digit', minute: '2-digit' });
}

function fmtDur(ms) {
  const s = Math.round(ms / 1000);
  if (s < 60) return s + 's';
  const m = Math.floor(s / 60);
  if (m < 60) return m + 'm ' + (s % 60) + 's';
  const h = Math.floor(m / 60);
  return h + 'h ' + (m % 60) + 'm';
}

function fmtSpan(ms) {
  const h = ms / 3600000;
  return h >= 1 ? `${Math.round(h)}h` : `${Math.round(ms / 60000)}m`;
}

function escHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}
function escAttr(s) { return escHtml(s); }
