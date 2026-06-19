// ui.js — wires the hovering/collapsible stats panel to the renderer. The
// office camera (pan / zoom / recenter) is driven by gestures inside render.js.

import { setReservedRight } from './render.js';

const $ = (id) => document.getElementById(id);
const GAP = 16; // breathing room between the office and the panel

export function initUI() {
  const panel = document.querySelector('.panel');
  const toggle = $('panelToggle');
  const handle = $('panelHandle');

  let open = loadOpen();

  function apply() {
    if (panel) panel.classList.toggle('collapsed', !open);
    if (toggle) toggle.classList.toggle('active', open);
    if (handle) handle.classList.toggle('show', !open);
    // Reserve space so the office fits beside the panel (0 when collapsed).
    setReservedRight(open && panel ? panel.offsetWidth + GAP : 0);
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

  // panel width can depend on viewport (max-width: 86vw) — re-reserve on resize.
  window.addEventListener('resize', () => {
    if (open && panel) setReservedRight(panel.offsetWidth + GAP);
  });

  apply();
}

function loadOpen() {
  try {
    const v = localStorage.getItem('agency.panelOpen');
    return v === null ? true : v === '1';
  } catch {
    return true;
  }
}
