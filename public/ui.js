// ui.js — wires the stats DRAWER to the renderer. The office camera (pan / zoom /
// recenter) is driven by gestures inside office.js.
//
// The stats panel is a DRAWER you summon, not a pinned rail: the office is always
// full-bleed (we never reserve width for it), and opening the drawer overlays it
// on the right. It starts CLOSED so the floor is the hero on load and nothing
// auto-blocks the office. Per-agent detail lives in a floating card beside the
// agent (chat-panel.js), not here.

const $ = (id) => document.getElementById(id);

export function initUI() {
  const panel = document.querySelector('.panel');
  const toggle = $('panelToggle');
  const handle = $('panelHandle');

  let open = loadOpen();

  function apply() {
    if (panel) panel.classList.toggle('collapsed', !open);
    if (toggle) toggle.classList.toggle('active', open);
    if (handle) handle.classList.toggle('show', !open);
    // Office stays full-bleed: the drawer overlays it rather than shrinking it,
    // so we never reserve width (no setReservedRight call).
  }
  function set(next) {
    open = next;
    try {
      localStorage.setItem('agency.panelOpen', open ? '1' : '0');
    } catch {
      /* ignore */
    }
    apply();
  }

  if (toggle) toggle.addEventListener('click', () => set(!open));
  if (handle) handle.addEventListener('click', () => set(true));

  apply();
}

function loadOpen() {
  try {
    // Default CLOSED so the office is unobstructed on load; remembers the user's
    // choice once they open it.
    return localStorage.getItem('agency.panelOpen') === '1';
  } catch {
    return false;
  }
}
