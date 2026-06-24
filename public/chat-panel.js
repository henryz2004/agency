// chat-panel.js — read-only "open this agent's status" side panel.
//
// Listens for an `agency:select` CustomEvent (dispatched by office.js when a
// desk is clicked) and slides in a panel that summarizes the selected agent's
// truthful status. For a real Claude session it leads with a STATUS + METRICS
// card (honest state from the agent itself + a 30-min activity readout fetched
// from GET /api/transcript) — NOT a dump of the conversation. Reading is
// READ-ONLY. The one action it offers is "Open in Terminal", which POSTs
// /api/resume to jump back into the session via `claude --resume`.
//
// Agent kinds it handles:
//   - Claude sessions (role null/lead, source 'claude', has sessionId+cwd) →
//     status + metrics card (idle or working), plus the resume footer.
//   - In-process teammates (role 'teammate', kind 'teammate') → have no
//     transcript of their own; show their launch brief from the team config
//     instead, plus the lead's resume hint.
//   - opencode / codex agents → no Claude transcript on disk; show a short note.
//
// This module owns no render/camera state; it is a pure consumer of the
// selection event, so it stays decoupled from office.js.

const PANEL_ID = 'chatPanel';

let panelEl = null;
let bodyEl = null;
let titleEl = null;
let subEl = null;
let editEl = null; // header-level rename + hide strip (rebuilt per selection)
let currentKey = null; // selection key of the agent currently shown
let reqToken = 0; // guards against out-of-order fetch responses
let refreshTimer = null; // periodic /api/transcript re-fetch while the panel is open
const REFRESH_MS = 5000; // how often to refresh the live metrics/status readout

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"]/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])
  );
}

// Stable per-agent key, mirroring office.js's keyOf so selection lines up.
function keyOf(a) {
  if (!a) return null;
  return a.sessionId || (a.pid != null ? `pid:${a.pid}` : null);
}

function shortModel(m) {
  if (!m) return '?';
  return m
    .replace(/^.+\//, '')
    .replace('claude-', '')
    .replace(/-\d{8}$/, '')
    .replace(/\[1m\]/, ' 1M');
}

// ---- DOM scaffold ---------------------------------------------------------

function build() {
  panelEl = document.createElement('aside');
  panelEl.id = PANEL_ID;
  panelEl.className = 'chat-panel';
  panelEl.setAttribute('aria-hidden', 'true');
  panelEl.innerHTML = `
    <div class="cp-head">
      <div class="cp-headtop">
        <div class="cp-id">
          <div class="cp-title" id="cpTitle">—</div>
          <div class="cp-sub" id="cpSub"></div>
        </div>
        <button type="button" class="cp-close" id="cpClose" title="Close (Esc)" aria-label="Close">✕</button>
      </div>
      <div class="cp-edit" id="cpEdit"></div>
    </div>
    <div class="cp-body" id="cpBody"></div>`;
  document.body.appendChild(panelEl);

  bodyEl = panelEl.querySelector('#cpBody');
  titleEl = panelEl.querySelector('#cpTitle');
  subEl = panelEl.querySelector('#cpSub');
  editEl = panelEl.querySelector('#cpEdit');

  panelEl.querySelector('#cpClose').addEventListener('click', () => close());
  // Esc closes when the panel is open.
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && panelEl.classList.contains('open')) close();
  });
}

function open() {
  panelEl.classList.add('open');
  panelEl.setAttribute('aria-hidden', 'false');
}

function close() {
  panelEl.classList.remove('open');
  panelEl.setAttribute('aria-hidden', 'true');
  currentKey = null;
  reqToken++; // abandon any in-flight fetch's render
  stopRefresh();
}

// Stop the periodic metrics refresh (on close or before a new selection).
function stopRefresh() {
  if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = null;
  }
}

// Re-fetch /api/transcript and patch the activity card's metrics + "doing now"
// line IN PLACE (no body rebuild, so a half-typed rename is undisturbed). Used
// on an interval while the panel is open so a transient 0 (e.g. a stale entry
// crowding the metrics window for one tick) can't stick until the user
// re-selects. On a transient miss we keep the last good values — never blank.
function refreshMetrics(agent, token, card) {
  if (token !== reqToken) return; // selection changed — this card is stale
  const url = `/api/transcript?sessionId=${encodeURIComponent(agent.sessionId)}&cwd=${encodeURIComponent(agent.cwd)}`;
  fetch(url, { cache: 'no-store' })
    .then((r) => r.json())
    .then((data) => {
      if (token !== reqToken) return;
      fillActivityCard(card, agent, data && data.lastAction, data && data.metrics);
    })
    .catch(() => {
      /* transient miss — leave the last good readout in place */
    });
}

// ---- copy affordance ------------------------------------------------------

// Copy `text` to the clipboard and flash the button label. Falls back to a
// hidden textarea + execCommand when the async clipboard API is unavailable
// (e.g. non-secure contexts), so the affordance still works on 127.0.0.1.
function copyToClipboard(text, btn) {
  const done = (ok) => {
    if (!btn) return;
    const prev = btn.dataset.label || btn.textContent;
    btn.dataset.label = prev;
    btn.textContent = ok ? '✓ copied' : '⚠ copy failed';
    btn.classList.toggle('ok', ok);
    setTimeout(() => {
      btn.textContent = btn.dataset.label;
      btn.classList.remove('ok');
    }, 1400);
  };
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(() => done(true), () => fallbackCopy(text, done));
  } else {
    fallbackCopy(text, done);
  }
}

function fallbackCopy(text, done) {
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    done(ok);
  } catch {
    done(false);
  }
}

// One copy button. Returns the element; wires the click to copy `value`.
function copyButton(label, value, title) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'cp-copy';
  b.textContent = label;
  if (title) b.title = title;
  b.addEventListener('click', () => copyToClipboard(value, b));
  return b;
}

// ---- rendering ------------------------------------------------------------

function setHeader(a) {
  const roleTag =
    a.role === 'lead'
      ? '<span class="cp-role lead">PM</span>'
      : a.role === 'teammate'
        ? '<span class="cp-role teammate">teammate</span>'
        : '';
  titleEl.innerHTML = `${esc(a.name || '—')} ${roleTag}`;
  // Sub-line is project · model (the agent title — "Distinguished Eng" — was
  // dropped as noise; project + model are what identify the desk).
  const bits = [];
  if (a.project) bits.push(`<span class="cp-dept">${esc(a.project)}</span>`);
  if (a.model) bits.push(esc(shortModel(a.model)));
  subEl.innerHTML = bits.join(' · ');
  // The rename + hide strip lives in the header now (not the body), so the body
  // is just status/transcript. Rebuilt per selection; self-gates to null.
  editEl.innerHTML = '';
  const cust = customizeControls(a);
  if (cust) editEl.appendChild(cust);
}

// A small "footer" of actions shown beneath any content. The primary action is
// "Open in Terminal" — it jumps you back into the agent via `claude --resume`
// (the one non-read-only call; see openTerminalButton). A "copy" button copies
// the full resume command for fallback; the command itself is NOT shown (too
// small to read, and you can't act on the raw text anyway). One clean row: a
// short note, then the terminal + copy buttons.
function actionsFor(a, transcript) {
  const wrap = document.createElement('div');
  wrap.className = 'cp-actions';

  // Resume — only for a real Claude session with an id+cwd. A running BACKGROUND
  // agent can't be --resume'd; you attach to it via `claude agents` instead.
  const bg = a.kind === 'background' || a.kind === 'bg';
  const resumeCmd = !(a.sessionId && a.cwd)
    ? null
    : bg
      ? `cd ${a.cwd} && claude agents --cwd ${a.cwd}`
      : (transcript && transcript.resumeCmd) || `cd ${a.cwd} && claude --resume ${a.sessionId}`;
  if (a.role !== 'teammate' && a.source === 'claude' && a.sessionId && a.cwd && resumeCmd) {
    // "Background agent" isn't a meaningful category — it's just an agent in agent
    // mode, and it IS reachable. Frame by the SPAWN relationship (was it spawned by
    // someone?), never as inaccessible. The terminal button below is the jump-in.
    const row = document.createElement('div');
    row.className = 'cp-action-row';
    const note = document.createElement('div');
    note.className = 'cp-action-note';
    note.textContent = bg
      ? a.leadName
        ? `Spawned by ${a.leadName}.`
        : 'Running in agent mode.'
      : 'Resume to read or message it.';
    row.appendChild(note);
    row.appendChild(openTerminalButton(a));
    // copy still copies the FULL resume command, even though it isn't shown.
    row.appendChild(copyButton('copy', resumeCmd, 'Copy the resume command'));
    wrap.appendChild(row);
  }

  return wrap.children.length ? wrap : null;
}

// Open a terminal running `claude --resume` for this agent. This POSTs the one
// server ACTION endpoint (/api/resume) — the only non-read-only call the panel
// makes. The server validates id+cwd and spawns osascript→Terminal.
function openTerminalButton(a) {
  const bg = a.kind === 'background' || a.kind === 'bg';
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'cp-open';
  b.textContent = bg ? 'Attach in Terminal ▶' : 'Open in Terminal ▶';
  b.title = bg
    ? 'Open a terminal and attach to this running agent (claude agents)'
    : 'Open a terminal running claude --resume for this agent';
  b.addEventListener('click', () => {
    const prev = b.textContent;
    b.disabled = true;
    b.textContent = 'opening…';
    fetch('/api/resume', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: a.sessionId, cwd: a.cwd, kind: a.kind }),
    })
      .then((r) => r.json().catch(() => ({})))
      .then((d) => { b.textContent = d && d.ok ? '✓ opened' : '⚠ failed'; })
      .catch(() => { b.textContent = '⚠ failed'; })
      .finally(() => {
        setTimeout(() => { b.textContent = prev; b.disabled = false; }, 1600);
      });
  });
  return b;
}

function renderNote(html) {
  const n = document.createElement('div');
  n.className = 'cp-note';
  n.innerHTML = html;
  return n;
}

// ---- customize controls (rename + hide) -----------------------------------
// A compact "edit this agent" strip rendered IN THE HEADER (see setHeader) for
// any agent with a sessionId (claude sessions, teammates, opencode, codex): a
// slim rename field + Save and a small hide toggle on one row, so the body stays
// pure status/transcript. Both controls persist server-side via POST
// /api/agent-override and only WRITE the field they touch:
//   • RENAME → { sessionId, name }  (name:"" resets to the minted roster name)
//   • HIDE   → { sessionId, hidden } (toggles agent.hidden; office.js owns state)
// Each control flashes a transient confirmation on its own button, mirroring the
// copyButton / openTerminalButton pattern, and never throws on a failed/non-JSON
// response (we guard the .json() like openTerminalButton does).

// POST a single override field and flash `btn` with the result. `prevText` is
// restored after the flash; `body` carries only the field being changed.
function postOverride(btn, body, prevText) {
  btn.disabled = true;
  fetch('/api/agent-override', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
    .then((r) => r.json().catch(() => ({})))
    .then((d) => { btn.textContent = d && d.ok ? '✓ saved' : '⚠ failed'; btn.classList.toggle('ok', !!(d && d.ok)); })
    .catch(() => { btn.textContent = '⚠ failed'; btn.classList.remove('ok'); })
    .finally(() => {
      setTimeout(() => { btn.textContent = prevText; btn.classList.remove('ok'); btn.disabled = false; }, 1400);
    });
}

function customizeControls(a) {
  // Gate: only render for a selectable real agent carrying a sessionId.
  if (!a || !a.sessionId) return null;

  // One compact row: a slim rename field + Save, then a small hide toggle.
  const wrap = document.createElement('div');
  wrap.className = 'cp-customize cp-cust-row';

  // --- rename: input pre-filled with the current name + a Save button. Saving
  // an empty input clears the custom name (server resets to the minted name). ---
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'cp-cust-input';
  input.value = a.name || '';
  input.placeholder = 'Rename…';
  input.title = 'Rename this agent (clear to reset to its minted name)';
  const save = document.createElement('button');
  save.type = 'button';
  save.className = 'cp-cust-save';
  save.textContent = 'Save';
  save.title = 'Save the new name';
  const submitName = () => postOverride(save, { sessionId: a.sessionId, name: input.value.trim() }, 'Save');
  save.addEventListener('click', submitName);
  // Enter in the field saves too (blur is left alone so tabbing away is quiet).
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); submitName(); }
  });
  wrap.appendChild(input);
  wrap.appendChild(save);

  // --- hide: a small icon toggle reflecting agent.hidden. Optimistically flips
  // its own glyph/label; the next /api/state poll reflects the real state. ---
  const hide = document.createElement('button');
  hide.type = 'button';
  hide.className = 'cp-cust-hide';
  const labelFor = (hidden) => (hidden ? '🙈' : '👁');
  const titleFor = (hidden) => (hidden ? 'Unhide — show on the floor again' : 'Hide this agent from the office floor');
  hide.textContent = labelFor(a.hidden);
  hide.title = titleFor(a.hidden);
  hide.addEventListener('click', () => {
    const next = !a.hidden;
    a.hidden = next; // optimistic; office.js reconciles on the next poll
    const prev = labelFor(next);
    hide.title = titleFor(next);
    postOverride(hide, { sessionId: a.sessionId, hidden: next }, prev);
  });
  wrap.appendChild(hide);

  return wrap;
}

// ---- status + metrics card ------------------------------------------------
// For EVERY real Claude session (idle OR working) the panel leads with this: a
// truthful status badge from the agent's OWN state, the task it's on, a 30-min
// activity readout (tool calls + tokens), and — ONLY when a tool is genuinely
// in flight — a live "doing now" line. We deliberately do NOT dump the
// conversation; the user wants honest status, not a transcript to read.

// The task/topic the agent is working toward — its AI chat title, the CLI task
// name, or the last user prompt, in that order of usefulness.
function taskLabel(a) {
  return a.chatName || a.task || a.lastPrompt || null;
}

// Compact a count for the metrics line: <1000 as-is, else "12.3k", "1.2M".
function fmtCount(n) {
  if (n == null || !isFinite(n)) return '—';
  const abs = Math.abs(n);
  if (abs < 1000) return String(n);
  if (abs < 1e6) return (n / 1e3).toFixed(1).replace(/\.0$/, '') + 'k';
  return (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'M';
}

// One-word status + matching css class for the activity dot/headline.
function statusBits(a) {
  if (a.activity === 'working') return { cls: 'working', icon: '🟢', text: 'Shipping now' };
  if (a.activity === 'shell') return { cls: 'shell', icon: '⚙', text: 'Running a command' };
  if (a.state === 'done') return { cls: 'done', icon: '✅', text: 'Finished' };
  return { cls: 'idle', icon: '💤', text: 'Idle' };
}

// Render the live "current action" line from a transcript lastAction object,
// e.g. "Editing app.js" / "Running npm test". Returns '' when we have none.
function actionLine(lastAction) {
  if (!lastAction || !lastAction.verb) return '';
  const verb = esc(lastAction.verb);
  const target = lastAction.target ? `<span class="cp-act-target">${esc(lastAction.target)}</span>` : '';
  return `${verb}${target ? ' ' + target : ''}`;
}

// The status + metrics header card. `lastAction` + `metrics` arrive with the
// transcript fetch; we render the card immediately (with both null) and patch
// them in once the fetch resolves, so the card never blocks on the network.
function renderActivityCard(a, lastAction, metrics) {
  const s = statusBits(a);
  const card = document.createElement('div');
  card.className = `cp-activity ${s.cls}`;

  const head = document.createElement('div');
  head.className = 'cp-act-head';
  head.innerHTML = `<span class="cp-act-dot ${s.cls}"></span><span class="cp-act-status">${s.icon} ${esc(s.text)}</span>`;
  card.appendChild(head);

  const task = taskLabel(a);
  if (task) {
    const t = document.createElement('div');
    t.className = 'cp-act-task';
    t.textContent = task;
    card.appendChild(t);
  }

  // The headline 30-min activity readout; renders em-dashes until the fetch
  // resolves, then patches in real counts (see show()).
  const stat = document.createElement('div');
  stat.className = 'cp-act-metrics';
  setMetricsLine(stat, metrics);
  card.appendChild(stat);

  // The live "doing now" line — populated ONLY when a tool is genuinely in
  // flight. Patched async; starts empty (no false "running" text on idle).
  const act = document.createElement('div');
  act.className = 'cp-act-now';
  setActionLine(act, a, lastAction);
  card.appendChild(act);

  const sub = (a.subagents || []).length;
  if (sub) {
    const m = document.createElement('div');
    m.className = 'cp-act-sub';
    m.textContent = `🤖 ${sub} subagent${sub > 1 ? 's' : ''} running`;
    card.appendChild(m);
  }
  return card;
}

// Fill the metrics readout element from a `metrics` object. Missing metrics
// degrade to em-dashes rather than vanishing, so the headline stat stays put.
function setMetricsLine(el, metrics) {
  const win = (metrics && metrics.windowMin) || 30;
  const calls = metrics ? fmtCount(metrics.toolCalls30m) : '—';
  const toks = metrics ? fmtCount(metrics.tokensOut30m) : '—';
  el.innerHTML =
    `<span class="cp-act-bolt">⚡</span> ${esc(calls)} tool calls · ` +
    `${esc(toks)} tokens <span class="cp-act-win">· last ${esc(win)} min</span>`;
}

// Fill the "doing now" line. CRUCIAL honesty rule: when `lastAction` is null we
// print NOTHING (the status badge already says idle/running) — UNLESS the agent
// is genuinely mid-generation (activity 'working' with no tool in flight), in
// which case a subtle "thinking…" is fair. A null action on an idle/shell agent
// must never read as "doing now …".
function setActionLine(el, a, lastAction) {
  const line = actionLine(lastAction);
  if (line) {
    el.innerHTML = `<span class="cp-act-label">doing now</span> ${line}`;
    el.classList.remove('cp-act-empty');
  } else if (a.activity === 'working') {
    el.innerHTML = '<span class="cp-act-label">doing now</span> <span class="cp-dim">thinking…</span>';
    el.classList.remove('cp-act-empty');
  } else {
    // Idle / shell with no in-flight tool — say nothing here.
    el.textContent = '';
    el.classList.add('cp-act-empty');
  }
}

// Patch an already-rendered card's metrics + action lines in place (called after
// the transcript fetch resolves). Mirrors the pre-render-then-patch pattern.
function fillActivityCard(card, a, lastAction, metrics) {
  if (!card) return;
  const stat = card.querySelector('.cp-act-metrics');
  if (stat) setMetricsLine(stat, metrics);
  const act = card.querySelector('.cp-act-now');
  if (act) setActionLine(act, a, lastAction);
}

// ---- blocked-background banner --------------------------------------------
// A needsYou agent is a BACKGROUND agent blocked on the user (state:'blocked').
// Unlike awaitingReply it holds NO Stop-hook connection, so a reply box here
// couldn't reach it — the only way in is its own terminal. So instead of a reply
// box we show WHY it's blocked + point at the attach footer, reusing the amber
// reply styling so it reads as the same "waiting on you" class of signal.
function renderBlockedBanner(agent, hasAttach) {
  const wrap = document.createElement('div');
  wrap.className = 'cp-reply cp-blocked';
  const head = document.createElement('div');
  head.className = 'cp-reply-head';
  head.innerHTML = '<span class="cp-reply-dot"></span> Blocked — waiting on you in its terminal.';
  wrap.appendChild(head);
  // Its parting question, when we have it (same source the reply box uses).
  if (agent.pendingQuestion) {
    const q = document.createElement('div');
    q.className = 'cp-reply-q';
    q.textContent = agent.pendingQuestion;
    wrap.appendChild(q);
  }
  const hint = document.createElement('div');
  hint.className = 'cp-reply-q cp-dim';
  hint.textContent = hasAttach
    ? 'No live chat hold here — attach in its terminal below to respond and unblock it.'
    : 'No live chat hold here — reach it in the terminal where it is running to respond.';
  wrap.appendChild(hint);
  return wrap;
}

// ---- reply box (Control Phase-1) ------------------------------------------
// When the selected agent is paused on a Stop hook (awaitingReply), render a
// reply box ABOVE the transcript: a textarea + Send that POSTs /api/reply
// { sessionId, text }. On success the agent is resumed with the typed text and
// the box collapses to a "sent" confirmation. This is the one place the panel
// writes anything (the authorized control surface, alongside /api/resume) — and
// it only resolves an already-held hook connection, never the ~/.claude data.
function renderReplyBox(agent) {
  const wrap = document.createElement('div');
  wrap.className = 'cp-reply';

  const head = document.createElement('div');
  head.className = 'cp-reply-head';
  head.innerHTML =
    '<span class="cp-reply-dot"></span> Waiting on your input. Reply to resume it.';
  wrap.appendChild(head);

  // Show the agent's parting question only when we actually have it
  // (pendingQuestion). We deliberately DON'T fall back to lastPrompt/chatName —
  // those are the last *user* prompt / chat title, not what the agent is asking,
  // so labelling them as its question would mislead.
  if (agent.pendingQuestion) {
    const ctx = document.createElement('div');
    ctx.className = 'cp-reply-q';
    ctx.textContent = agent.pendingQuestion;
    wrap.appendChild(ctx);
  }

  const ta = document.createElement('textarea');
  ta.className = 'cp-reply-input';
  ta.rows = 3;
  ta.placeholder = 'Type your reply… (⌘/Ctrl+Enter to send)';
  wrap.appendChild(ta);

  const row = document.createElement('div');
  row.className = 'cp-reply-row';
  const status = document.createElement('span');
  status.className = 'cp-reply-status';
  const send = document.createElement('button');
  send.type = 'button';
  send.className = 'cp-reply-send';
  send.textContent = 'Send ▶';
  row.appendChild(status);
  row.appendChild(send);
  wrap.appendChild(row);

  const doSend = () => {
    const text = ta.value.trim();
    if (!text) {
      ta.focus();
      return;
    }
    send.disabled = true;
    ta.disabled = true;
    status.textContent = 'sending…';
    status.className = 'cp-reply-status';
    fetch('/api/reply', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: agent.sessionId, text }),
    })
      .then((r) => r.json().then((d) => ({ ok: r.ok, d })).catch(() => ({ ok: r.ok, d: {} })))
      .then(({ ok, d }) => {
        if (ok && d && d.ok) {
          // Collapse to a confirmation; the next poll will drop awaitingReply.
          wrap.innerHTML =
            '<div class="cp-reply-sent">✓ sent — resuming the agent</div>';
        } else {
          status.textContent =
            d && d.error === 'no agent waiting for this session'
              ? 'agent already resumed or timed out'
              : '⚠ failed to send';
          status.className = 'cp-reply-status err';
          send.disabled = false;
          ta.disabled = false;
        }
      })
      .catch(() => {
        status.textContent = '⚠ failed to send';
        status.className = 'cp-reply-status err';
        send.disabled = false;
        ta.disabled = false;
      });
  };

  send.addEventListener('click', doSend);
  ta.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      doSend();
    }
  });
  // Autofocus so the reply box is immediately typeable on selection.
  setTimeout(() => ta.focus(), 0);
  return wrap;
}

// The agent's most recent turn(s), so you can tell at a glance which real
// session a desk maps to (the rest of the panel is honest-status only). Renders
// the last assistant + user turn from /api/transcript's `messages`, each clipped.
function renderLastMessages(messages) {
  if (!Array.isArray(messages) || !messages.length) return null;
  const recent = messages.slice(-2); // last turn + the prior one for context
  const card = document.createElement('div');
  card.className = 'cp-lastmsg';
  const head = document.createElement('div');
  head.className = 'cp-lastmsg-head';
  head.textContent = recent.length > 1 ? 'Last messages' : 'Last message';
  card.appendChild(head);
  for (const m of recent) {
    const assistant = m && m.role === 'assistant';
    const row = document.createElement('div');
    row.className = 'cp-msg ' + (assistant ? 'cp-msg-agent' : 'cp-msg-you');
    const who = document.createElement('span');
    who.className = 'cp-msg-who';
    who.textContent = assistant ? 'agent' : 'you';
    const txt = document.createElement('div');
    txt.className = 'cp-msg-text';
    const t = String((m && m.text) || '').replace(/\s+/g, ' ').trim();
    txt.textContent = t.length > 300 ? t.slice(0, 299) + '…' : t;
    row.appendChild(who);
    row.appendChild(txt);
    card.appendChild(row);
  }
  return card;
}

// ---- selection flow -------------------------------------------------------

function show(agent) {
  if (!agent) {
    close();
    return;
  }
  const key = keyOf(agent);
  // Clicking the already-open agent toggles the panel shut (matches the
  // renderer's tap-to-deselect feel).
  if (key && key === currentKey && panelEl.classList.contains('open')) {
    close();
    return;
  }
  currentKey = key;
  // Bump the request token on EVERY selection (not just the fetch path) so a
  // still-in-flight Claude transcript response can't render into a later
  // selection's panel (e.g. clicking a Claude agent then a teammate).
  reqToken++;
  stopRefresh(); // a prior agent's refresh loop must not patch this selection
  setHeader(agent);
  open();

  // ---- in-process teammate: no transcript, show its launch brief ----------
  if (agent.role === 'teammate' || agent.kind === 'teammate') {
    bodyEl.innerHTML = '';
    const lead = agent.leadName ? esc(agent.leadName) : 'its lead';
    bodyEl.appendChild(
      renderNote(`Spawned by ${lead} — part of their run. Its launch brief:`)
    );
    const brief = agent.lastPrompt || agent.prompt;
    if (brief) {
      const b = document.createElement('div');
      b.className = 'cp-brief';
      b.textContent = brief;
      bodyEl.appendChild(b);
    } else {
      bodyEl.appendChild(renderNote('<span class="cp-dim">No launch brief on record.</span>'));
    }
    // (Rename/hide for this teammate, when it carries a sessionId-ish key, lives
    // in the header strip now — see setHeader → customizeControls.)
    // Reach path: a teammate runs INSIDE its lead's session, so jumping in =
    // opening the lead. Reuse actionsFor with a lead-targeted pseudo-agent.
    if (agent.leadSessionId && agent.cwd) {
      const leadAgent = { ...agent, sessionId: agent.leadSessionId, kind: 'interactive', role: null, source: 'claude' };
      const acts = actionsFor(leadAgent, null);
      if (acts) bodyEl.appendChild(acts);
    }
    return;
  }

  // ---- opencode / codex: no Claude transcript, but INLINE metrics ----------
  if (agent.source && agent.source !== 'claude') {
    // Non-Claude agents carry their 30-min metrics INLINE on the agent object
    // (their adapter computes them), so render the same status + metrics card
    // straight from `agent.metrics` — no /api/transcript fetch (that path is
    // Claude-only). The Claude-vs-non-Claude shape asymmetry is INTENTIONAL: we
    // don't recompute Claude metrics every poll, so only non-Claude is inline.
    bodyEl.innerHTML = '';
    bodyEl.appendChild(renderActivityCard(agent, null, agent.metrics || null));
    const acts = actionsFor(agent, null);
    if (acts) bodyEl.appendChild(acts);
    return;
  }

  // ---- needsYou: a BACKGROUND agent blocked on the USER (state:'blocked') -----
  // It holds NO Stop-hook connection, so the reply box can't resume it — the only
  // way in is its own terminal. Surface that ACTIONABLE path. This sits ABOVE the
  // cwd guard below so a cwd-less blocked agent still gets the attach note instead
  // of dead-ending at "No transcript available". (awaitingReply — interactive,
  // hook-held — keeps its reply box in the card path.) Net: every amber "!" on
  // the floor leads to a real next step.
  if (agent.needsYou && !agent.awaitingReply) {
    bodyEl.innerHTML = '';
    const acts = actionsFor(agent, null); // the attach-in-terminal footer = the unblock path
    const banner = renderBlockedBanner(agent, !!acts);
    bodyEl.appendChild(banner);
    if (acts) bodyEl.appendChild(acts);
    // A blocked BACKGROUND agent still has a transcript on disk — surface its last
    // message(s) too (it used to show only the attach banner), so you can see what
    // it's blocked on without attaching. Fetched async, inserted just below the banner.
    if (agent.source === 'claude' && agent.sessionId && agent.cwd) {
      const token = reqToken; // bumped at the top of show(); a newer selection bails this
      const url = `/api/transcript?sessionId=${encodeURIComponent(agent.sessionId)}&cwd=${encodeURIComponent(agent.cwd)}`;
      fetch(url, { cache: 'no-store' })
        .then((r) => r.json())
        .then((data) => {
          if (token !== reqToken || !banner.parentNode) return; // superseded / detached
          const lastMsgs = renderLastMessages(data && data.messages);
          if (lastMsgs) banner.insertAdjacentElement('afterend', lastMsgs);
        })
        .catch(() => { /* fail-soft — keep the banner */ });
    }
    return;
  }

  // ---- real Claude session: status + metrics card --------------------------
  if (!agent.sessionId || !agent.cwd) {
    bodyEl.innerHTML = '';
    bodyEl.appendChild(renderNote('<span class="cp-dim">No transcript available for this agent.</span>'));
    return;
  }

  // CONTEXTUAL MODE — the panel adapts to the agent's state:
  //   • WAITING ON YOU (awaitingReply): reply box pinned on top, then the
  //     status + metrics card below it so you can answer in context.
  //   • IDLE / WORKING / done (and NOT waiting): just the status + metrics card.
  // The status + metrics card builds for EVERY real Claude session (idle
  // included) — its badge is the agent's OWN honest state, not derived from the
  // fetch. The reply box + card render IMMEDIATELY (before the fetch) so the
  // panel is useful the instant a desk is clicked; the live metrics + "doing
  // now" line patch in once the transcript fetch resolves.
  const waiting = !!agent.awaitingReply;

  const replyBox = waiting ? renderReplyBox(agent) : null;
  // The card is pre-built (metrics + action null) so we can patch them in async.
  const activityCard = renderActivityCard(agent, null, null);

  bodyEl.innerHTML = '';
  if (replyBox) bodyEl.appendChild(replyBox);
  bodyEl.appendChild(activityCard);
  const acts = actionsFor(agent, null);
  if (acts) bodyEl.appendChild(acts);

  const token = reqToken; // already bumped at the top of show(); guards this fetch
  const url = `/api/transcript?sessionId=${encodeURIComponent(agent.sessionId)}&cwd=${encodeURIComponent(agent.cwd)}`;
  fetch(url, { cache: 'no-store' })
    .then((r) => r.json())
    .then((data) => {
      if (token !== reqToken) return; // a newer selection superseded this one
      // Patch the live metrics + "doing now" line into the card. lastAction is
      // null whenever no tool is in flight; setActionLine handles that honestly.
      fillActivityCard(activityCard, agent, data && data.lastAction, data && data.metrics);
      // Rebuild the resume footer with the transcript's resumeCmd if present.
      const newActs = actionsFor(agent, data);
      bodyEl.innerHTML = '';
      if (replyBox) bodyEl.appendChild(replyBox);
      bodyEl.appendChild(activityCard);
      // The last message(s) — surfaced so a desk is identifiable as a real session.
      const lastMsgs = renderLastMessages(data && data.messages);
      if (lastMsgs) bodyEl.appendChild(lastMsgs);
      if (newActs) bodyEl.appendChild(newActs);
      // The rename/hide strip lives in the header (editEl), which this rebuild
      // leaves untouched — so a half-typed rename survives the metrics patch.
    })
    .catch(() => {
      if (token !== reqToken) return;
      // Couldn't reach /api/transcript — leave the honest status badge alone and
      // just clear the pending metrics to em-dashes.
      fillActivityCard(activityCard, agent, null, null);
    });

  // Keep the readout fresh while the panel stays open: re-fetch metrics + status
  // on an interval so a momentary 0 can't stick until the user re-selects. Patches
  // the card in place (see refreshMetrics) without rebuilding the body.
  refreshTimer = setInterval(() => refreshMetrics(agent, token, activityCard), REFRESH_MS);
}

// Normalize the event detail: accept either { agent } or the agent directly,
// and treat a null/absent agent as a deselect.
function agentFromEvent(e) {
  const d = e && e.detail;
  if (!d) return null;
  if ('agent' in d) return d.agent;
  // detail is the agent object itself (be liberal in what we accept).
  return d.sessionId !== undefined || d.pid !== undefined ? d : null;
}

export function initChatPanel() {
  if (panelEl) return; // idempotent
  build();
  window.addEventListener('agency:select', (e) => show(agentFromEvent(e)));
}
