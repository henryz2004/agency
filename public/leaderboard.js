// leaderboard.js — the opt-in social layer (Phase 2a).
//
// Privacy contract: NOTHING leaves this machine unless you click "Join", and
// even then only your chosen handle + your standardized eng-years (one number,
// derived from total output tokens) are sent. Never code, transcripts, repo, or
// project names. "Stop sharing" deletes your row server-side.
//
// Set LEADERBOARD_API to your deployed Worker URL (see worker/README.md). While
// it's empty, the whole feature stays hidden and the dashboard is unchanged.

import { standardEngYears } from './metric.js';

const LEADERBOARD_API = 'https://agency-leaderboard.henryz2004.workers.dev';

const KNOWN_SOURCES = ['claude', 'codex', 'opencode'];
const LS = { id: 'agency.lb.installId', handle: 'agency.lb.handle', opted: 'agency.lb.optedIn' };
const $ = (id) => document.getElementById(id);

if (LEADERBOARD_API) init();

function init() {
  const btn = $('leaderboardBtn');
  if (!btn) return;
  btn.hidden = false;
  btn.addEventListener('click', open);
  $('lbClose') && $('lbClose').addEventListener('click', close);
  $('lbOverlay') && $('lbOverlay').addEventListener('click', (e) => {
    if (e.target.id === 'lbOverlay') close();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && $('lbOverlay') && !$('lbOverlay').classList.contains('hidden')) close();
  });
}

function open() { $('lbOverlay').classList.remove('hidden'); render(); }
function close() { $('lbOverlay').classList.add('hidden'); }

// Stable anonymous identity (so re-submits update your row, not duplicate it).
function installId() {
  let id = localStorage.getItem(LS.id);
  if (!id || !/^[A-Za-z0-9_-]{8,64}$/.test(id)) {
    id = (typeof crypto !== 'undefined' && crypto.randomUUID)
      ? crypto.randomUUID()
      : 'id-' + Math.random().toString(36).slice(2) + Date.now().toString(36);
    localStorage.setItem(LS.id, id);
  }
  return id;
}

async function fetchJSON(url, opts) {
  try {
    const res = await fetch(url, opts);
    if (!res.ok) return { _error: `HTTP ${res.status}` };
    return await res.json();
  } catch (e) {
    return { _error: String((e && e.message) || e) };
  }
}

// Pull this machine's lifetime output tokens + which tools are running, from the
// app's own read-only endpoint. Used only at submit time.
async function localStats() {
  const state = await fetchJSON('/api/state');
  const out = (state && state.usage && state.usage.lifetime && state.usage.lifetime.out) || 0;
  const agents = (state && state.live && state.live.agents) || [];
  const sources = [...new Set(agents.map((a) => a && a.source).filter((s) => KNOWN_SOURCES.includes(s)))];
  return { out, sources };
}

const fmtEY = (n) => (n >= 10 ? Math.round(n).toString() : n.toFixed(n >= 1 ? 1 : 2));
const fmtTok = (n) => (n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? Math.round(n / 1e3) + 'k' : String(n));

async function render() {
  const body = $('lbBody');
  body.innerHTML = '';
  const opted = localStorage.getItem(LS.opted) === '1';
  const stats = await localStats(); // { out, sources } — one local snapshot for preview + submit
  body.appendChild(opted ? statusBlock(stats) : optInBlock(stats));
  const list = document.createElement('div');
  list.className = 'lb-list';
  list.textContent = 'Loading…';
  body.appendChild(list);
  loadList(list);
}

// Submit the standardized score. Server derives eng-years from outputTokens.
function submitScore(handle, stats) {
  return fetchJSON(LEADERBOARD_API + '/api/submit', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ installId: installId(), handle, outputTokens: stats.out, sources: stats.sources }),
  });
}

// Refresh the "#N of M" line in place (so messages on the card survive).
function refreshRank() {
  fetchJSON(LEADERBOARD_API + '/api/rank?installId=' + encodeURIComponent(installId())).then((r) => {
    const el = $('lbYouRank');
    if (!el) return;
    if (r && typeof r.rank === 'number') el.textContent = `#${r.rank} of ${r.total} · ${fmtEY(r.engYears)} eng-yrs`;
    else el.textContent = 'not ranked yet';
  });
}

function optInBlock(stats) {
  const wrap = document.createElement('div');
  wrap.className = 'lb-optin';
  wrap.innerHTML = `
    <p class="lb-note">Share your standardized <b>engineer-years</b> on a public leaderboard.
    Only a display name + that one number are sent — <b>never</b> your code, transcripts, or repo names.</p>
    <p class="lb-preview">Your standardized score right now: <b></b> eng-yrs</p>
    <div class="lb-form">
      <input id="lbHandle" type="text" maxlength="32" placeholder="display name" autocomplete="off" />
      <button id="lbJoin" type="button">Join</button>
    </div>
    <div id="lbMsg" class="lb-msg"></div>`;
  wrap.querySelector('.lb-preview b').textContent = fmtEY(standardEngYears(stats.out));
  const input = wrap.querySelector('#lbHandle');
  input.value = localStorage.getItem(LS.handle) || '';
  const join = wrap.querySelector('#lbJoin');
  const msg = wrap.querySelector('#lbMsg');
  const go = async () => {
    const handle = input.value.trim();
    if (!handle) { msg.textContent = 'Pick a display name first.'; return; }
    join.disabled = true; msg.textContent = 'Submitting…';
    const res = await submitScore(handle, stats);
    join.disabled = false;
    if (res && res.ok) {
      localStorage.setItem(LS.handle, handle);
      localStorage.setItem(LS.opted, '1');
      render();
    } else {
      msg.textContent = 'Could not submit' + (res && res._error ? ` (${res._error})` : '') + '.';
    }
  };
  join.addEventListener('click', go);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
  return wrap;
}

function statusBlock(stats) {
  const wrap = document.createElement('div');
  wrap.className = 'lb-status';
  // Real stored handle (no placeholder fallback) — this is what we SUBMIT, so a
  // missing handle must never become the literal "you" on the server.
  const handle = localStorage.getItem(LS.handle) || '';
  wrap.innerHTML = `
    <div class="lb-you">
      <div class="lb-you-handle"></div>
      <div class="lb-you-rank" id="lbYouRank">—</div>
    </div>
    <div class="lb-actions">
      <button id="lbUpdate" type="button">Update my score</button>
      <button id="lbForget" type="button" class="lb-danger">Stop sharing</button>
    </div>
    <div id="lbMsg" class="lb-msg"></div>`;
  wrap.querySelector('.lb-you-handle').textContent = handle || 'you'; // display only; textContent = no injection
  const msg = wrap.querySelector('#lbMsg');

  refreshRank();

  wrap.querySelector('#lbUpdate').addEventListener('click', async (e) => {
    if (!handle) { msg.textContent = 'Re-join to set a display name first.'; return; }
    e.target.disabled = true; msg.textContent = 'Updating…';
    const res = await submitScore(handle, await localStats()); // re-fetch for freshness
    e.target.disabled = false;
    if (res && res.ok) {
      msg.textContent = 'Updated.';
      refreshRank();
      const list = document.querySelector('.lb-list');
      if (list) loadList(list);
    } else {
      msg.textContent = 'Update failed' + (res && res._error ? ` (${res._error})` : '') + '.';
    }
  });

  wrap.querySelector('#lbForget').addEventListener('click', async (e) => {
    e.target.disabled = true; msg.textContent = 'Removing…';
    const res = await fetchJSON(LEADERBOARD_API + '/api/forget', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ installId: installId() }),
    });
    if (res && res.ok) {
      localStorage.removeItem(LS.opted);
      render();
    } else {
      e.target.disabled = false;
      msg.textContent = 'Could not remove' + (res && res._error ? ` (${res._error})` : '') + '.';
    }
  });
  return wrap;
}

async function loadList(list) {
  // installId is sent ONLY when opted in (so the server can flag our own row);
  // before opt-in nothing identifying leaves the machine.
  const opted = localStorage.getItem(LS.opted) === '1';
  const q = '/api/leaderboard?limit=100' + (opted ? '&installId=' + encodeURIComponent(installId()) : '');
  const data = await fetchJSON(LEADERBOARD_API + q);
  if (!data || data._error || !Array.isArray(data.top)) {
    list.textContent = 'Leaderboard unavailable right now.';
    return;
  }
  if (!data.top.length) {
    list.textContent = 'No one has joined yet — be the first.';
    return;
  }
  list.innerHTML = '';
  for (const row of data.top) {
    const r = document.createElement('div');
    r.className = 'lb-row';
    if (row.mine) r.classList.add('lb-mine'); // server-flagged by installId, not by handle
    const rank = document.createElement('span'); rank.className = 'lb-rank'; rank.textContent = `#${row.rank}`;
    const name = document.createElement('span'); name.className = 'lb-name'; name.textContent = row.handle;
    const val = document.createElement('span'); val.className = 'lb-val';
    val.textContent = `${fmtEY(row.engYears)} eng-yrs`;
    val.title = `${fmtTok(row.outputTokens)} output tokens` + (row.sources && row.sources.length ? ` · ${row.sources.join(', ')}` : '');
    r.append(rank, name, val);
    list.appendChild(r);
  }
}
