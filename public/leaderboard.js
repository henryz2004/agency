// leaderboard.js — the opt-in social layer (Phase 2a).
//
// Privacy contract: NOTHING leaves this machine unless you click "Join", and
// even then only your chosen handle + your standardized eng-years (one number,
// derived from total output tokens) are sent. Never code, transcripts, repo, or
// project names. "Stop sharing" deletes your row server-side.
//
// Set LEADERBOARD_API to your deployed Worker URL (see worker/README.md). While
// it's empty, the whole feature stays hidden and the dashboard is unchanged.

import { standardEngYears, fmtEngTime } from './metric.js';

// Backend URL is injected by the server via /env.js (window.AGENCY_LEADERBOARD_API),
// driven by the LEADERBOARD_API env var — `LEADERBOARD_API=http://localhost:8787 npm
// start` for local/staging, else the production board. The hardcoded fallback only
// applies if /env.js didn't load. (We no longer read a sticky localStorage override:
// a stale value silently broke the prod board with a confusing "Failed to fetch".)
const LEADERBOARD_API =
  (typeof window !== 'undefined' && window.AGENCY_LEADERBOARD_API) ||
  'https://agency-leaderboard.henryz2004.workers.dev';

const KNOWN_SOURCES = ['claude', 'codex', 'opencode'];
const LS = { id: 'agency.lb.installId', handle: 'agency.lb.handle', opted: 'agency.lb.optedIn', seen: 'agency.lb.seen' };
const $ = (id) => document.getElementById(id);
const RESYNC_MS = 5 * 60 * 1000; // leaderboard auto-resync cadence (declared up here:
                                 // init() runs at load and reaches startAutoSync synchronously).

let welcomeMode = false; // true → render the first-run welcome instead of the leaderboard

if (LEADERBOARD_API) init();

function init() {
  const btn = $('leaderboardBtn');
  if (!btn) return;
  btn.hidden = false;
  btn.addEventListener('click', () => open()); // trophy → leaderboard view (not the welcome)
  greet();
  // The welcome can't be bypassed (no ✕/Escape/click-away) — "Enter" is the only way out.
  $('lbClose') && $('lbClose').addEventListener('click', close);
  $('lbOverlay') && $('lbOverlay').addEventListener('click', (e) => {
    if (e.target.id === 'lbOverlay' && !welcomeMode) close();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !welcomeMode && $('lbOverlay') && !$('lbOverlay').classList.contains('hidden')) close();
  });
  startAutoSync();
  // First-run welcome: greet new users, take their name, offer the leaderboard.
  // Stops once they finish setup (opted) or dismiss it (seen).
  if (localStorage.getItem(LS.opted) !== '1' && localStorage.getItem(LS.seen) !== '1') open(true);
}

// Personalize the topbar once we know the user's name.
function greet() {
  const name = localStorage.getItem(LS.handle);
  const el = document.querySelector('.brand-sub');
  if (name && el) el.textContent = `welcome, ${name}`;
}

// Keep your score current without a manual "update" — re-submit on load and on a
// slow interval while Agency is open. Silent: a failed sync (offline, or a legacy
// duplicate name) just leaves the last score standing. ponytail: fixed 5-min
// cadence; tie it to token deltas only if D1 writes ever become a concern.
function startAutoSync() {
  const tick = async () => {
    if (localStorage.getItem(LS.opted) !== '1') return;
    const handle = localStorage.getItem(LS.handle);
    if (!handle) return;
    const res = await submitScore(handle, await localStats());
    if (res && res.ok && $('lbYouRank')) { // modal open → refresh what's visible
      refreshRank();
      const list = document.querySelector('.lb-list');
      if (list) loadList(list);
    }
  };
  tick();
  setInterval(tick, RESYNC_MS);
}

function open(welcome = false) { welcomeMode = welcome; $('lbOverlay').classList.remove('hidden'); render(); }
function close() { $('lbOverlay').classList.add('hidden'); localStorage.setItem(LS.seen, '1'); }

// Swap the modal header between the welcome and the leaderboard framings.
function setHead(mode) {
  const title = $('lbTitle');
  const sub = document.querySelector('.lb-sub');
  if (mode === 'welcome') {
    if (title) title.textContent = '👋 Welcome to Agency';
    if (sub) { sub.hidden = false; sub.textContent = 'Your AI workforce, visualized.'; }
  } else {
    if (title) title.textContent = '🏆 Leaderboard';
    if (sub) { sub.hidden = false; sub.textContent = 'Standardized engineer-years shipped. Same formula for everyone, no sliders.'; }
  }
}

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
    const data = await res.json().catch(() => ({}));
    // On non-2xx, surface the server's { error } (e.g. "handle taken") so callers
    // can react to it, not just a bare status code.
    if (!res.ok) return { _error: data.error || `HTTP ${res.status}`, ...data };
    return data;
  } catch (e) {
    return { _error: String((e && e.message) || e) };
  }
}

// Pull this machine's lifetime output tokens + which tools are running, from the
// app's own read-only endpoint. Used only at submit time.
async function localStats() {
  const state = await fetchJSON('/api/state');
  const u = (state && state.usage) || {};
  // Rank by output SINCE this machine installed Agency (a level field for all),
  // not lifetime Claude history. Presence-check sinceInstall so a legit 0 (brand
  // new install) submits as 0; only fall back to lifetime on an older server.
  const out = (u.sinceInstall && typeof u.sinceInstall.out === 'number')
    ? u.sinceInstall.out
    : ((u.lifetime && u.lifetime.out) || 0);
  const agents = (state && state.live && state.live.agents) || [];
  const sources = [...new Set(agents.map((a) => a && a.source).filter((s) => KNOWN_SOURCES.includes(s)))];
  return { out, sources };
}

const fmtTok = (n) => (n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? Math.round(n / 1e3) + 'k' : String(n));

async function render() {
  const body = $('lbBody');
  body.innerHTML = '';
  const opted = localStorage.getItem(LS.opted) === '1';
  const stats = await localStats(); // { out, sources } — one local snapshot for preview + submit
  const closeBtn = $('lbClose');
  if (welcomeMode && !opted) { // first-run: name + opt-in, no ✕ (can't be bypassed)
    setHead('welcome');
    if (closeBtn) closeBtn.hidden = true;
    body.appendChild(welcomeBlock(stats));
    return;
  }
  if (closeBtn) closeBtn.hidden = false;
  setHead('leaderboard');
  body.appendChild(opted ? statusBlock(stats) : optInBlock(stats));
  const list = document.createElement('div');
  list.className = 'lb-list';
  list.textContent = 'Loading…';
  body.appendChild(list);
  loadList(list);
}

// First-run welcome: greet, take a display name, and offer leaderboard opt-in
// (checked by default — uncheck to just set a name and enter).
function welcomeBlock(stats) {
  const wrap = document.createElement('div');
  wrap.className = 'lb-welcome';
  wrap.innerHTML = `
    <div class="lb-field">
      <label for="lbHandle">What should we call you?</label>
      <input id="lbHandle" type="text" maxlength="32" placeholder="your name" autocomplete="off" />
    </div>
    <label class="lb-check">
      <input id="lbOptCheck" type="checkbox" checked />
      <span>Join the public <b>leaderboard</b>, ranked by engineer-years</span>
    </label>
    <p class="lb-preview">Your score so far: <b></b></p>
    <p class="lb-fine">Only your name + score are shared, never your code.</p>
    <div class="lb-form">
      <button id="lbStart" type="button">Enter the office →</button>
    </div>
    <div id="lbMsg" class="lb-msg"></div>`;
  const preview = wrap.querySelector('.lb-preview');
  preview.querySelector('b').textContent = fmtEngTime(standardEngYears(stats.out));
  const input = wrap.querySelector('#lbHandle');
  input.value = localStorage.getItem(LS.handle) || '';
  const check = wrap.querySelector('#lbOptCheck');
  const start = wrap.querySelector('#lbStart');
  const msg = wrap.querySelector('#lbMsg');
  const syncPreview = () => { preview.style.display = check.checked ? '' : 'none'; };
  syncPreview();
  check.addEventListener('change', syncPreview);
  const go = async () => {
    const handle = input.value.trim();
    if (handle) { localStorage.setItem(LS.handle, handle); greet(); }
    if (check.checked) {
      if (!handle) { msg.textContent = 'Add a name to join the leaderboard.'; return; }
      start.disabled = true; msg.textContent = 'Joining…';
      const res = await submitScore(handle, stats);
      start.disabled = false;
      if (res && res.ok) {
        localStorage.setItem(LS.opted, '1');
        localStorage.setItem(LS.seen, '1');
        welcomeMode = false;
        render(); // show their rank + the live board as the payoff
        return;
      }
      if (res && res.error === 'handle taken') { msg.textContent = 'That name is taken, try another.'; return; }
      msg.textContent = 'Could not join' + (res && res._error ? ` (${res._error})` : '') + '.';
      return;
    }
    close(); // skipped the board — just enter (close() marks seen)
  };
  start.addEventListener('click', go);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
  return wrap;
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
    if (r && typeof r.rank === 'number') el.textContent = `#${r.rank} of ${r.total} · ${fmtEngTime(r.engYears)}`;
    else el.textContent = 'not ranked yet';
  });
}

function optInBlock(stats) {
  const wrap = document.createElement('div');
  wrap.className = 'lb-optin';
  wrap.innerHTML = `
    <p class="lb-note">Share your standardized <b>engineer-years</b>, counted <b>since you installed Agency</b>,
    on a public leaderboard. Only a display name + that one number are sent; <b>never</b> your code, transcripts, or repo names.</p>
    <p class="lb-preview">Your standardized score since install: <b></b></p>
    <div class="lb-form">
      <input id="lbHandle" type="text" maxlength="32" placeholder="display name" autocomplete="off" />
      <button id="lbJoin" type="button">Join</button>
    </div>
    <div id="lbMsg" class="lb-msg"></div>`;
  wrap.querySelector('.lb-preview b').textContent = fmtEngTime(standardEngYears(stats.out));
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
    } else if (res && res.error === 'handle taken') {
      msg.textContent = 'That name is taken, try another.';
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
      <button id="lbForget" type="button" class="lb-danger">Stop sharing</button>
    </div>
    <div id="lbMsg" class="lb-msg">Your score syncs automatically while Agency is open.</div>`;
  wrap.querySelector('.lb-you-handle').textContent = handle || 'you'; // display only; textContent = no injection
  const msg = wrap.querySelector('#lbMsg');

  refreshRank();

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
    list.textContent = 'No one has joined yet. Be the first.';
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
    val.textContent = fmtEngTime(row.engYears);
    val.title = `${fmtTok(row.outputTokens)} output tokens` + (row.sources && row.sources.length ? ` · ${row.sources.join(', ')}` : '');
    r.append(rank, name, val);
    list.appendChild(r);
  }
}
