// avatar.js — a controllable USER AVATAR for the pixel office. The user drives a
// "player" character around the floor with WASD / arrow keys, walks up to an
// agent's desk, and the existing chat panel surfaces what that agent is doing.
//
// SELF-CONTAINED: this module owns the avatar's position, input, animation and
// proximity logic. It draws in the SAME buffer coordinates a worker uses (the
// render.js camera transform is applied by CSS to the whole world, so a buffer-
// space draw lands correctly), reusing the office's own character pipeline
// (characters.js + the dev-auburn walk atlas) so the avatar matches the art.
//
// SEAM CONTRACT (what render.js calls — see the report / wiring notes):
//   const avatar = createAvatar();                  // once, after initOffice
//   avatar.update(dtMs, { podPositions, bounds });  // each frame, before draw
//   avatar.draw(ctx);                               // each frame, after workers
//     podPositions: [{ x, y, i, agent }]  — desk buffer coords + the agent
//     bounds:       { minX, maxX, minY, maxY }  — floor extents (clamp box)
//   getters: avatar.pos {x,y} · avatar.nearestAgentIndex (int|null) · avatar.enabled (settable)
//
// PROXIMITY → INSPECT: when the avatar walks into a desk's radius it dispatches
// the EXISTING `agency:select` CustomEvent (detail `{ agent }`, matching
// render.js) so the chat panel reacts exactly as it does for a click. Debounced:
// it fires only when ENTERING a new desk's zone, and clears (agent:null) on exit.
//
// CAMERA-FOLLOW is intentionally NOT here — render.js owns the camera. This
// module just exposes `pos` so render.js can optionally center on it.

import { loadCharacter, drawCharacterState } from './characters.js';

// The avatar borrows the office's own generated walk atlas (side-profile walk
// cycle + idle frames). Path is relative to /public so it works under the static
// server. Loads async + fail-soft; until it's ready draw() falls back to a tiny
// procedural marker so the avatar is never invisible.
const AVATAR_ATLAS_URL = '/characters/dev-auburn.json';

// Movement feel. SPEED is buffer-px per second (the buffer is the low-res office;
// a worker pod is POD_W=64 wide, so ~90px/s crosses a couple of desks a second —
// brisk but controllable). The atlas anchor is the feet, so (x,y) is a FLOOR
// point and we draw the sprite standing on it.
const SPEED = 92;            // buffer px / second
const PROXIMITY_R = 46;      // enter this radius of a desk centre → inspect it
const PROXIMITY_EXIT_R = 60; // leave beyond this (hysteresis so it doesn't flap)

// Desk hit geometry mirrors render.js: podOrigin is a pod's top-left and the
// person/desk sit around its centre. We measure proximity to a point a little
// below the pod centre (the desk/chair the worker occupies), not the slot corner.
const POD_W = 64, POD_H = 92;
const DESK_CX = POD_W / 2;   // 32 — pod-centre x offset
const DESK_CY = 56;          // a touch below centre: the seat/desk, where the worker is

export function createAvatar(opts = {}) {
  return new Avatar(opts);
}

class Avatar {
  constructor(opts) {
    // Floor position (buffer coords) = the avatar's FEET. Seeded to opts.start or
    // a sensible spot; clamped into bounds on the first update once we know them.
    this.x = opts.start?.x ?? 80;
    this.y = opts.start?.y ?? 140;
    this._enabled = opts.enabled !== false;

    // Facing: +1 right, -1 left. Default right (the atlas walk faces right).
    this.facing = 1;
    this.moving = false;
    this.animClock = 0; // ms accumulator driving the walk/idle frame

    // Nearest desk currently being inspected (index into podPositions' agent
    // index `i`). `_nearestIndex` IS the inspection identity (the pod's `i`, or
    // null when not inspecting any desk) — we (re)fire agency:select only when it
    // CHANGES, so the chat panel updates on a real desk-to-desk handoff but not
    // every frame. Using the always-present pod index as the key (rather than the
    // agent's hash) avoids any "keyless agent" ambiguity in enter/exit.
    this._nearestIndex = null;

    // Held keys → movement vector. Tracked as a set of logical directions so
    // multiple keys combine (diagonals) and key-repeat doesn't matter.
    this._held = { up: false, down: false, left: false, right: false };

    // Character atlas (async, fail-soft). Null until loaded.
    this._char = null;
    loadCharacter(AVATAR_ATLAS_URL).then((c) => { this._char = c; }).catch(() => {});

    this._onKeyDown = this._onKeyDown.bind(this);
    this._onKeyUp = this._onKeyUp.bind(this);
    window.addEventListener('keydown', this._onKeyDown);
    window.addEventListener('keyup', this._onKeyUp);
  }

  // ---- public getters / setters -------------------------------------------

  get pos() { return { x: this.x, y: this.y }; }
  get nearestAgentIndex() { return this._nearestIndex; }
  get enabled() { return this._enabled; }
  set enabled(v) {
    this._enabled = !!v;
    if (!this._enabled) {
      // Drop held keys + stop so a disable mid-stride doesn't leave the avatar
      // gliding, and release any inspection so the panel isn't pinned.
      this._held = { up: false, down: false, left: false, right: false };
      this.moving = false;
      this._clearInspection();
    }
  }

  // Tear-down for completeness (render.js never destroys it, but the harness can).
  destroy() {
    window.removeEventListener('keydown', this._onKeyDown);
    window.removeEventListener('keyup', this._onKeyUp);
  }

  // ---- input ---------------------------------------------------------------

  // Map a KeyboardEvent to one of our logical directions (WASD + arrows). Returns
  // null for any other key.
  _dirFor(e) {
    switch (e.key) {
      case 'ArrowUp': case 'w': case 'W': return 'up';
      case 'ArrowDown': case 's': case 'S': return 'down';
      case 'ArrowLeft': case 'a': case 'A': return 'left';
      case 'ArrowRight': case 'd': case 'D': return 'right';
      default: return null;
    }
  }

  // Ignore input while typing into a field (so WASD in the chat box doesn't walk
  // the avatar) or while disabled.
  _shouldIgnore(e) {
    if (!this._enabled) return true;
    const t = e.target;
    if (!t) return false;
    const tag = t.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
    if (t.isContentEditable) return true;
    return false;
  }

  _onKeyDown(e) {
    const dir = this._dirFor(e);
    if (!dir) return;
    if (this._shouldIgnore(e)) return;
    // Arrow keys scroll the page by default — suppress that so the floor doesn't
    // jump while driving. (WASD don't scroll, so no need.)
    if (e.key.startsWith('Arrow')) e.preventDefault();
    this._held[dir] = true;
  }

  _onKeyUp(e) {
    const dir = this._dirFor(e);
    if (!dir) return;
    // Always honor key-UP even if disabled / focus moved, so a key can't stick.
    this._held[dir] = false;
  }

  // ---- per-frame update ----------------------------------------------------

  // Advance position from held keys, clamp to bounds, animate, and resolve the
  // nearest desk (firing agency:select on entering a new one).
  update(dtMs, { podPositions = [], bounds } = {}) {
    // Disabled (toggled off / non-hybrid): do nothing — no movement, and crucially
    // no _resolveNearest, so toggling off while standing on a desk doesn't re-latch
    // and re-fire agency:select right after the enabled-setter already cleared it.
    if (!this._enabled) return;
    const dt = Math.max(0, Math.min(dtMs || 0, 100)) / 1000; // clamp big tab-out gaps

    // Movement vector from held keys.
    let vx = (this._held.right ? 1 : 0) - (this._held.left ? 1 : 0);
    let vy = (this._held.down ? 1 : 0) - (this._held.up ? 1 : 0);
    if (!this._enabled) { vx = 0; vy = 0; }

    this.moving = (vx !== 0 || vy !== 0);
    if (this.moving) {
      // Normalize so diagonals aren't faster than cardinals.
      const len = Math.hypot(vx, vy) || 1;
      this.x += (vx / len) * SPEED * dt;
      this.y += (vy / len) * SPEED * dt;
      // Face the horizontal direction of travel; keep the last facing on pure-
      // vertical moves so the sprite doesn't snap to a default.
      if (vx > 0) this.facing = 1;
      else if (vx < 0) this.facing = -1;
      this.animClock += dtMs || 0;
    } else {
      // Idle: keep a slow idle cadence ticking (drawCharacterState reads a clock).
      this.animClock += dtMs || 0;
    }

    // Clamp to the floor extents so the avatar can't walk off the room.
    if (bounds) {
      this.x = clamp(this.x, bounds.minX, bounds.maxX);
      this.y = clamp(this.y, bounds.minY, bounds.maxY);
    }

    this._resolveNearest(podPositions);
  }

  // Find the closest desk and reconcile the inspection with hysteresis. Two radii
  // (enter < exit) keep it from flapping at a zone edge, while still allowing a
  // crisp desk-to-desk HANDOFF: a different desk inside the enter radius wins even
  // when the current one is still within the exit band. agency:select fires only
  // when the inspected desk actually changes.
  _resolveNearest(podPositions) {
    let best = null, bestD = Infinity;
    let current = null, currentD = Infinity; // the desk we're currently inspecting
    for (const p of podPositions) {
      if (!p || !p.agent) continue;
      const dx = this.x - (p.x + DESK_CX);
      const dy = this.y - (p.y + DESK_CY);
      const d = Math.hypot(dx, dy);
      if (d < bestD) { bestD = d; best = p; }
      if (p.i === this._nearestIndex) { current = p; currentD = d; }
    }

    if (this._nearestIndex == null) {
      // Not inspecting: latch onto the nearest desk once inside the enter radius.
      if (best && bestD <= PROXIMITY_R) this._setInspection(best);
    } else if (best && best.i !== this._nearestIndex && bestD <= PROXIMITY_R) {
      // Handoff: a DIFFERENT desk is now within the enter radius → switch to it.
      this._setInspection(best);
    } else if (!current || currentD > PROXIMITY_EXIT_R) {
      // The inspected desk is gone or we've walked past its (larger) exit radius.
      this._setInspection(null);
    }
    // else: still loosely near the same desk — hold it, no re-fire.
  }

  // Set (or clear) the inspected desk. Fires agency:select with the new desk's
  // agent (the same event render.js uses on a click) — or agent:null on clear —
  // only on an actual change, so the chat panel tracks the avatar without churn.
  _setInspection(p) {
    const nextIndex = p ? p.i : null;
    if (nextIndex === this._nearestIndex) return;
    this._nearestIndex = nextIndex;
    dispatchSelect(p ? p.agent : null);
  }

  _clearInspection() { this._setInspection(null); }

  // ---- draw ----------------------------------------------------------------

  // Draw the avatar at its buffer (x,y) — the camera is applied by render.js via
  // CSS, so we draw in buffer coords exactly like a worker. Layers: a soft floor
  // shadow, the character sprite (flipped when facing left), then a "YOU" marker
  // (bobbing arrow + label) above the head so the player reads as the user.
  draw(ctx) {
    const prevSmooth = ctx.imageSmoothingEnabled;
    ctx.imageSmoothingEnabled = false;

    // ground shadow under the feet
    ctx.save();
    ctx.globalAlpha = 0.22;
    ctx.fillStyle = '#000';
    ctx.beginPath();
    ctx.ellipse(this.x, this.y, 9, 3, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    const state = this.moving ? 'walk' : 'idle';

    if (this._char) {
      if (this.facing < 0) {
        // Flip horizontally about the avatar's x so a right-facing atlas walks
        // left. drawCharacterState anchors on (screenX, baselineY); after the
        // mirror, screenX maps to the avatar's x again.
        ctx.save();
        ctx.translate(this.x, 0);
        ctx.scale(-1, 1);
        ctx.translate(-this.x, 0);
        drawCharacterState(ctx, this.x, this.y, this._char, { state, clockMs: this.animClock });
        ctx.restore();
      } else {
        drawCharacterState(ctx, this.x, this.y, this._char, { state, clockMs: this.animClock });
      }
    } else {
      // Atlas not loaded yet — a tiny procedural stand-in so the avatar is visible.
      this._drawFallbackBody(ctx);
    }

    this._drawYouMarker(ctx);

    ctx.imageSmoothingEnabled = prevSmooth;
  }

  // A minimal fallback person (head + body) drawn with its feet at (x,y), used
  // only until the walk atlas loads. Bright magenta so it's obviously the user.
  _drawFallbackBody(ctx) {
    const x = Math.round(this.x), y = Math.round(this.y);
    ctx.fillStyle = '#2b2233'; ctx.fillRect(x - 4, y - 24, 8, 4);   // hair
    ctx.fillStyle = '#f0c8a0'; ctx.fillRect(x - 4, y - 21, 8, 7);   // head
    ctx.fillStyle = '#ff4fa3'; ctx.fillRect(x - 5, y - 14, 10, 11); // body (USER pink)
    ctx.fillStyle = '#1a1a22'; ctx.fillRect(x - 4, y - 3, 3, 3);    // legs
    ctx.fillRect(x + 1, y - 3, 3, 3);
  }

  // The "YOU" tag: a bobbing magenta down-arrow + label floating above the head,
  // distinct from a worker's PM-crown / selection-plumbob so the player avatar is
  // unmistakable. Drawn in buffer px (scales with the world).
  _drawYouMarker(ctx) {
    const bob = (Math.floor(this.animClock / 250) % 2) ? 1 : 0;
    const headTop = this.y - 34;        // ~atlas cell height above the feet
    const ax = Math.round(this.x);
    const ay = Math.round(headTop - 8 - bob);

    // label pill
    const label = 'YOU';
    ctx.font = '6px monospace';
    ctx.textBaseline = 'top';
    ctx.textAlign = 'center';
    const padX = 3, tw = Math.ceil(ctx.measureText(label).width);
    const w = tw + padX * 2, h = 9;
    const lx = ax - Math.round(w / 2), ly = ay - h - 2;
    ctx.fillStyle = '#ff2e88';                 // hot magenta pill
    ctx.fillRect(lx, ly, w, h);
    ctx.fillStyle = 'rgba(255,255,255,0.30)';  // top sheen
    ctx.fillRect(lx, ly, w, 1);
    ctx.fillStyle = '#fff';
    ctx.fillText(label, ax, ly + 2);

    // down-arrow pointing at the head
    ctx.fillStyle = '#ff2e88';
    ctx.beginPath();
    ctx.moveTo(ax - 3, ay - 1);
    ctx.lineTo(ax + 3, ay - 1);
    ctx.lineTo(ax, ay + 3);
    ctx.closePath();
    ctx.fill();
  }
}

// ---- helpers ---------------------------------------------------------------

function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

// Dispatch the EXACT event render.js dispatches on a desk click, so the chat
// panel surfaces the agent the avatar walked up to (or clears on exit).
function dispatchSelect(agent) {
  window.dispatchEvent(new CustomEvent('agency:select', { detail: { agent: agent || null } }));
}
