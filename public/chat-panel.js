// chat-panel.js — read-only "open this agent's chat" side panel.
//
// Listens for an `agency:select` CustomEvent (dispatched by render.js when a
// desk is clicked) and slides in a panel that peeks the selected agent's recent
// transcript via GET /api/transcript. Reading is READ-ONLY (just the trailing
// transcript). The one action it offers is "Open in Terminal", which POSTs
// /api/resume to jump back into the session via `claude --resume`.
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

// A small "footer" of actions shown beneath any content. The primary action is
// "Open in Terminal" — it jumps you back into the agent via `claude --resume`
// (the one non-read-only call; see openTerminalButton). The command is shown as
// copyable text for fallback. (Reveal-in-Finder was dropped — copying a path is
// busywork; resuming the session is the useful thing.)
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
    const row = document.createElement('div');
    row.className = 'cp-action-row';
    const code = document.createElement('code');
    code.className = 'cp-cmd';
    code.textContent = resumeCmd;
    row.appendChild(code);
    row.appendChild(openTerminalButton(a));
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
    ? 'Open a terminal and attach to this running background agent (claude agents)'
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
    '<span class="cp-reply-dot"></span> Paused — waiting on you. Reply to resume it.';
  wrap.appendChild(head);

  // Show the agent's parting question only when we actually have it
  // (pendingQuestion). We deliberately DON'T fall back to lastPrompt/chatName —
  // those are the last *user* prompt / chat title, not what the agent is asking,
  // so labelling them as its question would mislead. The transcript tail
  // rendered below already shows the agent's real last message for context.
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

  // If this agent is paused on a Stop hook, the reply box goes ABOVE the
  // transcript. Render it immediately (don't wait on the transcript fetch) so a
  // paused agent is answerable the instant it's selected.
  const replyBox = agent.awaitingReply ? renderReplyBox(agent) : null;
  bodyEl.innerHTML = '';
  if (replyBox) bodyEl.appendChild(replyBox);
  const loading = document.createElement('div');
  loading.className = 'cp-loading';
  loading.textContent = 'Opening chat…';
  bodyEl.appendChild(loading);

  const token = reqToken; // already bumped at the top of show(); guards this fetch
  const url = `/api/transcript?sessionId=${encodeURIComponent(agent.sessionId)}&cwd=${encodeURIComponent(agent.cwd)}`;
  fetch(url, { cache: 'no-store' })
    .then((r) => r.json())
    .then((data) => {
      if (token !== reqToken) return; // a newer selection superseded this one
      // Keep the reply box (if any) pinned at the top; rebuild only below it.
      bodyEl.innerHTML = '';
      if (replyBox) bodyEl.appendChild(replyBox);
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
      // Newest message is at the bottom; scroll there — unless a reply box is
      // pinned at the top, in which case keep it in view (that's the point).
      if (!replyBox) bodyEl.scrollTop = bodyEl.scrollHeight;
    })
    .catch(() => {
      if (token !== reqToken) return;
      bodyEl.innerHTML = '';
      if (replyBox) bodyEl.appendChild(replyBox);
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
