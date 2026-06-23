// avatar.js — a controllable USER AVATAR for the pixel office. The user drives a
// "player" character around the floor with WASD / arrow keys, walks up to an
// agent's desk, and the existing chat panel surfaces what that agent is doing.
//
// DORMANT: this module is PRESERVED for a future idle-wander / walkable-avatar
// feature but is not wired into the live office today (its former caller,
// render.js, was deleted when proc became the sole renderer). The walk-cycle
// code below is intentionally kept intact + self-contained.
//
// SELF-CONTAINED: this module owns the avatar's position, input, animation and
// proximity logic. It draws in the SAME buffer coordinates a worker uses (the
// office camera transform is applied by CSS to the whole world, so a buffer-
// space draw lands correctly), reusing its own inlined character pipeline (the
// dev-auburn walk atlas) so the avatar matches the art.
//
// SEAM CONTRACT (how a renderer would drive it):
//   const avatar = createAvatar();                  // once, after initOffice
//   avatar.update(dtMs, { podPositions, bounds });  // each frame, before draw
//   avatar.draw(ctx);                               // each frame, after workers
//     podPositions: [{ x, y, i, agent }]  — desk buffer coords + the agent
//     bounds:       { minX, maxX, minY, maxY }  — floor extents (clamp box)
//   getters: avatar.pos {x,y} · avatar.nearestAgentIndex (int|null) · avatar.enabled (settable)
//
// PROXIMITY → INSPECT: when the avatar walks into a desk's radius it dispatches
// the EXISTING `agency:select` CustomEvent (detail `{ agent }`) so the chat panel
// reacts exactly as it does for a click. Debounced: it fires only when ENTERING a
// new desk's zone, and clears (agent:null) on exit.
//
// CAMERA-FOLLOW is intentionally NOT here — a host renderer owns the camera. This
// module just exposes `pos` so a renderer can optionally center on it.

// The LIVE avatar draws as a front-facing proc worker (drawPerson) so it matches
// the proc office art, with striding legs + a USER tag added on top (see draw()).
// The animated-atlas pipeline below is the older side-profile path — kept DORMANT
// (intentionally preserved) but no longer fed; drawPerson is the active body.
import { drawPerson, px } from './sprites.js';

// Walk-cycle character pipeline — inlined here (formerly characters.js) so the
// avatar's animated walk atlas survives independently. Only the ANIMATED path is
// needed: the avatar always loads a generated atlas JSON (dev-auburn.json), never
// a static office-sheet sprite, so the sheet-blit path doesn't come along.

// Default cadences for any anim a sheet doesn't specify an fps for.
const DEFAULT_FPS = { idle: 2, type: 6, walk: 8 };

// Load an animated character: fetch its JSON atlas, normalize to the contract,
// and load its PNG. Resolves to { kind:'animated', atlas, img } or null on any
// failure (fail-soft so a missing/half-generated atlas never throws).
async function loadCharacter(jsonUrl) {
  try {
    const res = await fetch(jsonUrl);
    if (!res.ok) return null;
    const raw = await res.json();
    const atlas = normalizeAtlas(raw, jsonUrl);
    if (!atlas) return null;
    const img = await loadImage(resolveImageUrl(jsonUrl, atlas.image));
    if (!img) return null;
    return { kind: 'animated', atlas, img };
  } catch {
    return null;
  }
}

// Resolve the sheet path relative to the JSON's directory so an atlas can name
// its image as a bare filename ("auburn-walk.png").
function resolveImageUrl(jsonUrl, image) {
  if (!image) return null;
  if (/^(https?:)?\//.test(image)) return image;
  const dir = jsonUrl.replace(/[^/]*$/, '');
  return dir + image;
}

function loadImage(src) {
  return new Promise((resolve) => {
    if (!src) { resolve(null); return; }
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = src;
  });
}

// Bring an emitted atlas into the canonical shape. Tolerates the dev fixture
// (no name/fps, has rows/frameCount, only a walk anim) and fills sane defaults.
function normalizeAtlas(raw, jsonUrl) {
  if (!raw || !raw.cellW || !raw.cellH) return null;
  const cols = raw.cols || raw.columns || 1;
  const anims = { ...(raw.anims || {}) };
  // A sheet with no named anims at all (just a frame strip) → treat the whole
  // strip as a single looping anim usable for every state.
  if (!anims.idle && !anims.type && !anims.walk) {
    const count = raw.frameCount || cols * (raw.rows || 1);
    const all = Array.from({ length: count }, (_, i) => i);
    anims.idle = anims.type = anims.walk = all;
  }
  // Fall back any missing state to whatever the sheet does have.
  const have = anims.idle || anims.type || anims.walk || [0];
  anims.idle = anims.idle && anims.idle.length ? anims.idle : have;
  anims.type = anims.type && anims.type.length ? anims.type : (anims.idle || have);
  anims.walk = anims.walk && anims.walk.length ? anims.walk : have;
  const fps = { ...DEFAULT_FPS, ...(raw.fps || {}) };
  return {
    name: raw.name || jsonUrl.replace(/.*\//, '').replace(/\.json$/, ''),
    image: raw.image,
    cellW: raw.cellW,
    cellH: raw.cellH,
    cols,
    anchorX: raw.anchorX != null ? raw.anchorX : Math.floor(raw.cellW / 2),
    anchorY: raw.anchorY != null ? raw.anchorY : raw.cellH - 1,
    anims,
    fps,
  };
}

// Pick the frame index for an animated state from a shared clock. `clockMs` is a
// monotonic time; we advance through anims[state] at the state's fps. `phase`
// desyncs identical characters so a row doesn't keystroke in lockstep.
function frameForState({ atlas, state = 'idle', clockMs = 0, phase = 0 }) {
  const a = atlas.anims[state] || atlas.anims.idle || [0];
  if (a.length <= 1) return a[0] || 0;
  const fps = atlas.fps[state] || DEFAULT_FPS[state] || 4;
  const step = Math.floor(clockMs / (1000 / fps)) + (phase | 0);
  return a[((step % a.length) + a.length) % a.length];
}

// Draw one animated character cell so its anchor lands at (screenX, baselineY).
function drawCharacter(ctx, screenX, baselineY, atlas, img, state, frame) {
  if (!atlas || !img || !img.complete || !img.naturalWidth) return;
  const { cellW, cellH, cols, anchorX, anchorY } = atlas;
  const f = frame | 0;
  const col = ((f % cols) + cols) % cols;
  const row = Math.floor(f / cols);
  const sx = col * cellW;
  const sy = row * cellH;
  const dx = Math.round(screenX - anchorX);
  const dy = Math.round(baselineY - anchorY);
  const prevSmooth = ctx.imageSmoothingEnabled;
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(img, sx, sy, cellW, cellH, dx, dy, cellW, cellH);
  ctx.imageSmoothingEnabled = prevSmooth;
}

// Draw any character with its anchor at (screenX, baselineY). The avatar only
// ever feeds an animated atlas; static sheet sprites are not supported here.
function drawCharacterState(ctx, screenX, baselineY, char, { state = 'idle', clockMs = 0, phase = 0 } = {}) {
  if (!char) return;
  if (char.atlas && char.img) {
    const frame = frameForState({ atlas: char.atlas, state, clockMs, phase });
    drawCharacter(ctx, screenX, baselineY, char.atlas, char.img, state, frame);
  }
}

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
const AVATAR_SEED = 7;       // fixed appearance for the player's proc body
const PROXIMITY_R = 46;      // enter this radius of a desk centre → inspect it
const PROXIMITY_EXIT_R = 60; // leave beyond this (hysteresis so it doesn't flap)

// Desk hit geometry mirrors the office: buildPods() gives a cell's top-left and
// the worker/desk sit at its centre, so we measure proximity to the cell centre.
// Proc cells are CELL_W=58 x CELL_H=78 (NOT the old hybrid 64x92 pod), so the
// centre offset is 29/39 — using the old 32/56 put the hot-spot ~17px too low.
const POD_W = 64, POD_H = 92;  // legacy hybrid metrics, kept for the walk-speed note above
const DESK_CX = 29;          // proc CELL_W/2 — desk-centre x offset from the cell top-left
const DESK_CY = 39;          // proc CELL_H/2 — desk-centre y offset

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

    // The avatar draws via the proc worker sprite (drawPerson) — no atlas to load.
    this._onKeyDown = this._onKeyDown.bind(this);
    this._onKeyUp = this._onKeyUp.bind(this);
    window.addEventListener('keydown', this._onKeyDown);
    window.addEventListener('keyup', this._onKeyUp);
  }

  // ---- public getters / setters -------------------------------------------

  get pos() { return { x: this.x, y: this.y }; }
  get nearestAgentIndex() { return this._nearestIndex; }
  // Place the avatar (buffer coords) — the host seeds it at the view centre on enable.
  setPos(x, y) { this.x = x; this.y = y; }
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

  // Tear-down for completeness (nothing wires it up today, but the harness can).
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
  // agent (the same event a desk click uses) — or agent:null on clear —
  // only on an actual change, so the chat panel tracks the avatar without churn.
  _setInspection(p) {
    const nextIndex = p ? p.i : null;
    if (nextIndex === this._nearestIndex) return;
    this._nearestIndex = nextIndex;
    dispatchSelect(p ? p.agent : null);
  }

  _clearInspection() { this._setInspection(null); }

  // ---- draw ----------------------------------------------------------------

  // Draw the avatar at its buffer (x,y) — the camera is applied by the office via
  // CSS, so we draw in buffer coords exactly like a worker. Layers: a soft floor
  // shadow, the character sprite (flipped when facing left), then a "YOU" marker
  // (bobbing arrow + label) above the head so the player reads as the user.
  draw(ctx) {
    const prevSmooth = ctx.imageSmoothingEnabled;
    ctx.imageSmoothingEnabled = false;

    const cx = Math.round(this.x);
    const fy = Math.round(this.y);   // feet / floor point
    // Walk stride: -1 = standing (both legs planted), 0/1 alternate a step.
    const stride = this.moving ? (Math.floor(this.animClock / 90) % 2) : -1;
    // a 1px walk bounce: the body bobs up on alternating steps while the feet plant.
    const bob = stride === 0 ? 1 : 0;

    // ground shadow + a magenta USER ring so the player reads as "you" at a glance
    ctx.save();
    ctx.globalAlpha = 0.22;
    ctx.fillStyle = '#000';
    ctx.beginPath();
    ctx.ellipse(this.x, this.y, 9, 3, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 0.55;
    ctx.strokeStyle = '#ff2e88';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.ellipse(this.x, this.y, 8.5, 3, 0, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();

    // Legs first (the torso overlaps their tops). drawPerson is a SEATED worker
    // with no legs, so the avatar grows its own — two that alternate a step while
    // walking, both planted when standing.
    const pants = '#2b2f3a';
    const lLift = stride === 0 ? 1 : 0;
    const rLift = stride === 1 ? 1 : 0;
    px(ctx, cx - 4, fy - 4 + lLift, 3, 4 - lLift, pants);
    px(ctx, cx + 1, fy - 4 + rLift, 3, 4 - rLift, pants);

    // Front-facing proc body (matches the office workers). drawPerson's torso
    // bottom lands ~29px below headTop, i.e. fy-4, right where the legs begin.
    drawPerson(ctx, cx, fy - 33 - bob, {
      seed: AVATAR_SEED,
      activity: 'idle', // never "typing" — the avatar walks the floor, isn't at a desk
      frame: Math.floor(this.animClock / 130),
    });

    this._drawYouMarker(ctx);

    ctx.imageSmoothingEnabled = prevSmooth;
  }

  // The "YOU" tag: a bobbing magenta down-arrow + label floating above the head,
  // distinct from a worker's PM-crown / selection-plumbob so the player avatar is
  // unmistakable. Drawn in buffer px (scales with the world).
  _drawYouMarker(ctx) {
    const bob = (Math.floor(this.animClock / 250) % 2) ? 1 : 0;
    const headTop = this.y - 34;        // ~atlas cell height above the feet
    const ax = Math.round(this.x);
    const ay = Math.round(headTop - 8 - bob);

    // "YOU" as 3x5 pixel glyphs (fillRect), NOT canvas text — the world canvas is
    // CSS-upscaled several×, and anti-aliased fillText blurs when magnified; these
    // integer rects stay crisp like the rest of the procedural art.
    const GLYPHS = { Y: ['101', '101', '010', '010', '010'], O: ['111', '101', '101', '101', '111'], U: ['101', '101', '101', '101', '111'] };
    const letters = 'YOU', lw = 3, lh = 5, gap = 1;
    const textW = letters.length * lw + (letters.length - 1) * gap; // 11
    const padX = 3, padY = 2;
    const w = textW + padX * 2, h = lh + padY * 2; // 17 x 9
    const lx = ax - Math.round(w / 2), ly = ay - h - 2;
    ctx.fillStyle = '#ff2e88';                 // hot magenta pill
    ctx.fillRect(lx, ly, w, h);
    ctx.fillStyle = 'rgba(255,255,255,0.30)';  // top sheen
    ctx.fillRect(lx, ly, w, 1);
    ctx.fillStyle = '#fff';
    let gx = lx + padX;
    for (const ch of letters) {
      const g = GLYPHS[ch];
      for (let r = 0; r < lh; r++) for (let c = 0; c < lw; c++) {
        if (g[r][c] === '1') ctx.fillRect(gx + c, ly + padY + r, 1, 1);
      }
      gx += lw + gap;
    }

    // down-arrow pointing at the head — pixel rows (crisp), not an AA triangle
    ctx.fillStyle = '#ff2e88';
    ctx.fillRect(ax - 3, ay - 1, 7, 1);
    ctx.fillRect(ax - 2, ay, 5, 1);
    ctx.fillRect(ax - 1, ay + 1, 3, 1);
    ctx.fillRect(ax, ay + 2, 1, 1);
  }
}

// ---- helpers ---------------------------------------------------------------

function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

// Dispatch the EXACT event a desk click dispatches, so the chat
// panel surfaces the agent the avatar walked up to (or clears on exit).
function dispatchSelect(agent) {
  window.dispatchEvent(new CustomEvent('agency:select', { detail: { agent: agent || null } }));
}
