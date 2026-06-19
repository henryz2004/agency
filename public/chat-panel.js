// chat-panel.js — read-only "open this agent's chat" side panel.
//
// Listens for an `agency:select` CustomEvent (dispatched by render.js when a
// desk is clicked) and slides in a panel that peeks the selected agent's recent
// transcript via GET /api/transcript. The panel is strictly READ-ONLY: it only
// fetches the trailing transcript and offers copy-to-clipboard affordances (the
// resume command + the transcript path) — it never spawns, resumes, or writes.
//
// Agent kinds it handles:
//   - Claude sessions (role null/lead, source 'claude', has sessionId+cwd) →
//     fetch and render the last messages.
//   - In-process teammates (role 'teammate', kind 'teammate') → have no
//     transcript of their own; show their launch brief from the team config
//     instead, plus the lead's resume hint.
//   - opencode / codex agents → no Claude transcript on disk; show a short note.
//
// This module owns no render/camera state; it is a pure consumer of the
// selection event, so it stays decoupled from render.js.

const PANEL_ID = 'chatPanel';

let panelEl = null;
let bodyEl = null;
let titleEl = null;
let subEl = null;
let currentKey = null; // selection key of the agent currently shown
let reqToken = 0; // guards against out-of-order fetch responses

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"]/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])
  );
}

// Stable per-agent key, mirroring render.js's keyOf so selection lines up.
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
      <div class="cp-id">
        <div class="cp-title" id="cpTitle">—</div>
        <div class="cp-sub" id="cpSub"></div>
      </div>
      <button type="button" class="cp-close" id="cpClose" title="Close (Esc)" aria-label="Close">✕</button>
    </div>
    <div class="cp-body" id="cpBody"></div>`;
  document.body.appendChild(panelEl);

  bodyEl = panelEl.querySelector('#cpBody');
  titleEl = panelEl.querySelector('#cpTitle');
  subEl = panelEl.querySelector('#cpSub');

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
  const bits = [];
  if (a.title) bits.push(esc(a.title));
  if (a.project) bits.push(`<span class="cp-dept">${esc(a.project)}</span>`);
  if (a.model) bits.push(esc(shortModel(a.model)));
  subEl.innerHTML = bits.join(' · ');
}

// A small "footer" of actions (resume cmd, path) shown beneath any content.
function actionsFor(a, transcript) {
  const wrap = document.createElement('div');
  wrap.className = 'cp-actions';

  // Resume command — only meaningful for a real Claude session with an id+cwd.
  const resumeCmd =
    (transcript && transcript.resumeCmd) ||
    (a.sessionId && a.cwd ? `cd ${a.cwd} && claude --resume ${a.sessionId}` : null);
  if (a.role !== 'teammate' && a.source === 'claude' && resumeCmd) {
    const row = document.createElement('div');
    row.className = 'cp-action-row';
    const code = document.createElement('code');
    code.className = 'cp-cmd';
    code.textContent = resumeCmd;
    row.appendChild(code);
    row.appendChild(copyButton('copy', resumeCmd, 'Copy the resume command'));
    wrap.appendChild(row);
  }

  // Transcript path — read-only "reveal in Finder" surrogate: copy the path so
  // the user can open it themselves (we never spawn `open -R`, preserving the
  // app's read-only invariant).
  const tpath = transcript && transcript.path;
  if (tpath) {
    const row = document.createElement('div');
    row.className = 'cp-action-row';
    const code = document.createElement('code');
    code.className = 'cp-path';
    code.textContent = tpath;
    code.title = tpath;
    row.appendChild(code);
    row.appendChild(copyButton('copy path', tpath, 'Copy the transcript file path'));
    wrap.appendChild(row);
  }

  return wrap.children.length ? wrap : null;
}

function renderMessages(messages) {
  const list = document.createElement('div');
  list.className = 'cp-messages';
  for (const m of messages) {
    const row = document.createElement('div');
    row.className = `cp-msg ${m.role === 'user' ? 'user' : 'assistant'}`;
    const who = m.role === 'user' ? 'you' : 'agent';
    row.innerHTML =
      `<div class="cp-msg-role">${who}</div>` +
      `<div class="cp-msg-text">${esc(m.text)}</div>`;
    list.appendChild(row);
  }
  return list;
}

function renderNote(html) {
  const n = document.createElement('div');
  n.className = 'cp-note';
  n.innerHTML = html;
  return n;
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
  setHeader(agent);
  open();

  // ---- in-process teammate: no transcript, show its launch brief ----------
  if (agent.role === 'teammate' || agent.kind === 'teammate') {
    bodyEl.innerHTML = '';
    bodyEl.appendChild(
      renderNote(
        'In-process teammate — runs inside its lead\'s session, so it has no ' +
          'transcript of its own. Its launch brief:'
      )
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
    return;
  }

  // ---- opencode / codex: no Claude transcript on disk ----------------------
  if (agent.source && agent.source !== 'claude') {
    bodyEl.innerHTML = '';
    bodyEl.appendChild(
      renderNote(
        `${esc(agent.source)} agent — transcript peek is Claude Code only.`
      )
    );
    const acts = actionsFor(agent, null);
    if (acts) bodyEl.appendChild(acts);
    return;
  }

  // ---- real Claude session: fetch the transcript tail ----------------------
  if (!agent.sessionId || !agent.cwd) {
    bodyEl.innerHTML = '';
    bodyEl.appendChild(renderNote('<span class="cp-dim">No transcript available for this agent.</span>'));
    return;
  }

  bodyEl.innerHTML = '<div class="cp-loading">Opening chat…</div>';
  const token = reqToken; // already bumped at the top of show(); guards this fetch
  const url = `/api/transcript?sessionId=${encodeURIComponent(agent.sessionId)}&cwd=${encodeURIComponent(agent.cwd)}`;
  fetch(url, { cache: 'no-store' })
    .then((r) => r.json())
    .then((data) => {
      if (token !== reqToken) return; // a newer selection superseded this one
      bodyEl.innerHTML = '';
      const messages = (data && data.messages) || [];
      if (messages.length) {
        bodyEl.appendChild(renderMessages(messages));
      } else {
        bodyEl.appendChild(
          renderNote('<span class="cp-dim">No recent messages in the transcript tail.</span>')
        );
      }
      const acts = actionsFor(agent, data);
      if (acts) bodyEl.appendChild(acts);
      // Newest message is at the bottom; scroll there.
      bodyEl.scrollTop = bodyEl.scrollHeight;
    })
    .catch(() => {
      if (token !== reqToken) return;
      bodyEl.innerHTML = '';
      bodyEl.appendChild(renderNote('<span class="cp-dim">Couldn\'t load the transcript.</span>'));
      const acts = actionsFor(agent, null);
      if (acts) bodyEl.appendChild(acts);
    });
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
