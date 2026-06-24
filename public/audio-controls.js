// audio-controls.js — self-contained topbar UI for the two independent audio
// channels exposed by sound.js: MUSIC (lo-fi playlist) and SFX (keyboard
// clatter). Renders two toggle buttons and a now-playing track label.
//
// This file owns its own DOM and CSS (injected from JS) so it touches no shared
// file: app.js calls initAudioControls() once, and that's the only seam. It is
// the SOLE audio UI — the old single #soundToggle button is removed by app.js.
//
// Mirrors the look of the old .sound-toggle / .panel-toggle buttons (38x34 dark
// chips that glow green/cyan when on) using the project's CSS custom properties.

import {
  initSoundPref,
  toggleSfx,
  toggleMusic,
  isSfxEnabled,
  isMusicEnabled,
  currentTrackName,
  onTrackChange,
} from './sound.js';

const STYLE_ID = 'audio-controls-style';

// Scoped CSS for the controls. Reuses the project palette via var(--…) so it
// stays consistent if the theme changes. Kept small and tidy for the top bar.
const CSS = `
.audio-controls {
  display: inline-flex; align-items: center; gap: 6px;
}
.audio-controls .ac-btn {
  font-size: 15px; line-height: 1; cursor: pointer;
  width: 38px; height: 34px; padding: 0;
  display: inline-flex; align-items: center; justify-content: center;
  border: 1px solid var(--line, #222c40); border-radius: 4px;
  background: #0c111b; color: var(--ink, #cfd9ea);
  transition: border-color 0.15s, box-shadow 0.15s, transform 0.05s, opacity 0.15s;
}
.audio-controls .ac-btn:hover { border-color: var(--cyan, #5cd0ff); }
.audio-controls .ac-btn:active { transform: translateY(1px); }
.audio-controls .ac-btn[aria-pressed="false"] { opacity: 0.62; }
.audio-controls .ac-btn.ac-music[aria-pressed="true"] {
  border-color: var(--pink, #ff5cba); box-shadow: 0 0 10px rgba(255,92,186,0.35); opacity: 1;
}
.audio-controls .ac-btn.ac-sfx[aria-pressed="true"] {
  border-color: var(--green, #39d98a); box-shadow: 0 0 10px rgba(57,217,138,0.35); opacity: 1;
}
.audio-controls .ac-now {
  display: none; align-items: center; gap: 6px; max-width: 150px;
  padding: 5px 9px; border: 1px solid var(--line2, #1a2336); border-radius: 4px;
  background: #11161f; color: var(--muted, #6b7689);
  font-family: var(--term, ui-monospace, monospace); font-size: var(--t-fine, 11px);
  letter-spacing: 0.3px; white-space: nowrap; overflow: hidden;
}
.audio-controls .ac-now.show { display: inline-flex; }
.audio-controls .ac-now .ac-eq { color: var(--pink, #ff5cba); flex: none; }
.audio-controls .ac-now .ac-track {
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--ink, #cfd9ea);
}
`;

function injectStyle() {
  if (document.getElementById(STYLE_ID)) return;
  const el = document.createElement('style');
  el.id = STYLE_ID;
  el.textContent = CSS;
  document.head.appendChild(el);
}

// Pick a sensible mount point: the existing topbar controls cluster, falling
// back to the header or body so we never silently render nothing.
function findAnchor() {
  return (
    document.querySelector('.topctrls') ||
    document.querySelector('.topright') ||
    document.querySelector('.topbar') ||
    document.body
  );
}

// Reflect a button's pressed state into aria + glyph.
function paintBtn(btn, on, onGlyph, offGlyph) {
  btn.setAttribute('aria-pressed', on ? 'true' : 'false');
  btn.textContent = on ? onGlyph : offGlyph;
}

// Mount the controls once and wire them to sound.js. Idempotent: a second call
// is a no-op if the controls already exist.
export function initAudioControls() {
  if (document.querySelector('.audio-controls')) return;

  injectStyle();
  const pref = initSoundPref(); // { sfx, music } — desired pre-gesture state

  const wrap = document.createElement('div');
  wrap.className = 'audio-controls';

  // --- MUSIC toggle ---------------------------------------------------------
  const musicBtn = document.createElement('button');
  musicBtn.type = 'button';
  musicBtn.className = 'ac-btn ac-music';
  musicBtn.title = 'Toggle lo-fi music';
  musicBtn.setAttribute('aria-label', 'Toggle lo-fi music');

  // --- SFX toggle -----------------------------------------------------------
  const sfxBtn = document.createElement('button');
  sfxBtn.type = 'button';
  sfxBtn.className = 'ac-btn ac-sfx';
  sfxBtn.title = 'Toggle keyboard clatter';
  sfxBtn.setAttribute('aria-label', 'Toggle keyboard clatter sound effects');

  // --- now-playing label ----------------------------------------------------
  const now = document.createElement('div');
  now.className = 'ac-now';
  now.setAttribute('aria-live', 'polite');
  const eq = document.createElement('span');
  eq.className = 'ac-eq';
  eq.textContent = '♫';
  const trackSpan = document.createElement('span');
  trackSpan.className = 'ac-track';
  now.appendChild(eq);
  now.appendChild(trackSpan);

  // Reflect the persisted prefs onto the buttons (engines stay off until the
  // first user gesture; these calls just paint the buttons).
  paintBtn(musicBtn, pref.music, '🎵', '🎵');
  paintBtn(sfxBtn, pref.sfx, '⌨️', '⌨️');

  function refreshNow() {
    const name = currentTrackName();
    if (isMusicEnabled() && name) {
      trackSpan.textContent = name;
      now.classList.add('show');
    } else {
      trackSpan.textContent = '';
      now.classList.remove('show');
    }
  }

  musicBtn.addEventListener('click', () => {
    const on = toggleMusic(); // user gesture → music start/stop allowed
    paintBtn(musicBtn, on, '🎵', '🎵');
    refreshNow(); // track name arrives async via onTrackChange; this clears it on stop
  });

  sfxBtn.addEventListener('click', () => {
    const on = toggleSfx(); // user gesture → AudioContext create/resume allowed
    paintBtn(sfxBtn, on, '⌨️', '⌨️');
  });

  // Track changes update the label live (fires '' when music stops).
  onTrackChange(refreshNow);

  wrap.appendChild(musicBtn);
  wrap.appendChild(sfxBtn);
  wrap.appendChild(now);

  // Insert before the panel toggle if present so the audio cluster sits with the
  // other right-hand controls; otherwise just append.
  const anchor = findAnchor();
  const panelToggle = anchor.querySelector && anchor.querySelector('.panel-toggle');
  if (panelToggle) anchor.insertBefore(wrap, panelToggle);
  else anchor.appendChild(wrap);

  refreshNow();
}
