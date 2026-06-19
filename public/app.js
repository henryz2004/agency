// app.js — fetches /api/state, drives the office renderer, and computes the
// "manpower" translation + comparison panels. All manpower math is client-side
// so the assumption sliders update everything instantly.

import { initOffice, setAgents } from './render.js';
import { drawHead, TIER } from './sprites.js';

const $ = (id) => document.getElementById(id);

const office = $('office');
const labels = $('labels');
initOffice(office, labels);

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

function tierOfModel(model) {
  if (!model) return 'unknown';
  const m = model.toLowerCase();
  if (m.includes('opus') || m.includes('fable')) return 'opus';
  if (m.includes('sonnet')) return 'sonnet';
  if (m.includes('haiku')) return 'haiku';
  return 'unknown';
}

async function poll() {
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
  setAgents(live.agents);

  $('tsLive').textContent = live.agents.length;
  $('tsBusy').textContent = live.agents.filter((a) => a.status === 'busy').length;
  $('tsTeams').textContent = (live.teams || []).filter((t) => (t.members || []).length > 1).length;
  $('emptyBanner').classList.toggle('hidden', live.agents.length > 0);

  renderManpower();
  renderModels(usage);
  renderDepts(usage);
  renderDaily(usage);
  renderLedger(usage);
  renderTicker();
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

// ---- model mix ------------------------------------------------------------

function renderModels(usage) {
  const entries = Object.entries(usage.byModel || {})
    .map(([m, v]) => ({ model: m, out: v.out, tier: tierOfModel(m) }))
    .filter((e) => e.out > 0)
    .sort((a, b) => b.out - a.out);
  const total = entries.reduce((s, e) => s + e.out, 0) || 1;

  const bar = $('modelBar');
  bar.innerHTML = '';
  entries.forEach((e) => {
    const seg = document.createElement('div');
    seg.className = 'seg';
    seg.style.width = (100 * e.out) / total + '%';
    seg.style.background = (TIER[e.tier] || TIER.unknown).screen;
    seg.title = `${e.model}: ${fmt(e.out)}`;
    bar.appendChild(seg);
  });

  const legend = $('modelLegend');
  legend.innerHTML = '';
  entries.slice(0, 5).forEach((e) => {
    const item = document.createElement('div');
    item.className = 'legend-item';
    const pct = ((100 * e.out) / total).toFixed(0);
    item.innerHTML = `<span class="swatch" style="background:${(TIER[e.tier] || TIER.unknown).screen}"></span>
      <span class="lg-name">${shortModel(e.model)}</span><span class="lg-val">${pct}% · ${fmt(e.out)}</span>`;
    legend.appendChild(item);
  });
}

function shortModel(m) {
  return m
    .replace('claude-', '')
    .replace(/-\d{8}$/, '')
    .replace(/\[1m\]/, ' 1M');
}

// ---- departments ----------------------------------------------------------

function renderDepts(usage) {
  const entries = Object.entries(usage.byProject || {})
    .map(([p, v]) => ({ project: p, ...v }))
    .filter((e) => e.out > 0)
    .sort((a, b) => b.out - a.out)
    .slice(0, 7);
  const max = entries.length ? entries[0].out : 1;

  const list = $('deptList');
  list.innerHTML = '';
  entries.forEach((e) => {
    const row = document.createElement('div');
    row.className = 'dept-row';
    row.innerHTML = `
      <div class="dept-head"><span class="dept-name">${escapeHtml(e.project)}</span>
        <span class="dept-val">${fmt(e.out)}</span></div>
      <div class="dept-bar"><div class="dept-fill" style="width:${(100 * e.out) / max}%"></div></div>
      <div class="dept-meta">${e.sessions} sessions · ${fmt(e.tools)} actions · ${e.agents} subagents</div>`;
    list.appendChild(row);
  });
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
    const tl = (TIER[a.tier] || TIER.unknown).label;
    const name = escapeHtml(a.name);
    const proj = escapeHtml(a.project);
    const labelText = a.task || a.chatName || a.lastPrompt;
    const label = labelText ? `“${escapeHtml(labelText)}”` : '';
    const up = fmtUptimeShort(a.uptimeMs);
    const subN = (a.subagents || []).length;
    const sub = subN ? ` · 🤖 ${subN} subagent${subN > 1 ? 's' : ''}` : '';
    if (a.status === 'busy') {
      items.push(`🟢 <b>${name}</b> (${escapeHtml(a.title)}) shipping in <b>${proj}</b>${label ? ` — ${label}` : ''} · ${tl}${sub} · up ${up}`);
    } else if (a.state === 'done') {
      items.push(`✅ <b>${name}</b> finished${label ? ` ${label}` : ''} in ${proj} · up ${up}`);
    } else {
      items.push(`💤 <b>${name}</b> idle in ${proj}${label ? ` — ${label}` : ''}${sub} · up ${up}`);
    }
  }
  const top = Object.entries(usage.byProject || {}).sort((a, b) => b[1].out - a[1].out)[0];
  items.push(`📊 ${fmt(usage.lifetime.out)} output tokens shipped all-time`);
  items.push(`🤖 ${comma(usage.lifetime.agents)} subagents dispatched across ${comma(usage.lifetime.sessions)} sessions`);
  if (top) items.push(`🏆 busiest department: <b>${escapeHtml(top[0])}</b> (${fmt(top[1].out)})`);
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

window.addEventListener('resize', () => {
  if (STATE) {
    renderManpower();
    renderDaily(STATE.usage);
  }
});

poll();
setInterval(poll, 3000);
