// characters.js — the office's PEOPLE layer for hybrid render mode, replacing
// the procedural drawWorker body. A "character" comes in two kinds:
//
//   STATIC   — a single front-facing standing sprite taken straight from the
//              office sheet (office-atlas.js worker1..worker5). No animation;
//              this is the immediate baseline that needs zero generated assets.
//   ANIMATED — a generated sprite SHEET + JSON atlas describing a cell grid,
//              anchor, and named animations (idle / type / walk). The upgrade
//              layer: when an agent has one of these it's used instead.
//
// Both kinds are drawn the same way through drawCharacterState(): the character's
// anchor point (feet for the standing sheet sprites; the atlas-declared anchor
// for generated ones) is placed at a given (screenX, baselineY) on the office
// buffer, crisply (imageSmoothingEnabled = false).
//
// Animated atlas contract (the generator emits this; we normalize minor variants):
//   { name, image, cellW, cellH, cols, anchorX, anchorY,
//     anims: { idle:[...], type:[...], walk:[...] }, fps: { idle, type, walk } }
// Frame N → cell (col = N % cols, row = floor(N / cols)); the cell's source rect
// is (col*cellW, row*cellH, cellW, cellH).

import { sheet, sheetReady, SPR } from './office-atlas.js';

// Default cadences for any anim a sheet doesn't specify an fps for.
const DEFAULT_FPS = { idle: 2, type: 6, walk: 8 };

// ---- static (sheet sprite) characters ------------------------------------

// Wrap an office-sheet worker SPR key as a STATIC character. The sprite is a
// front-facing standing pose; its anchor is the bottom-centre (feet), so it
// floor-anchors like the standing furniture. No image to load — it rides the
// shared office sheet, which the renderer already waits on (sheetReady()).
export function staticCharacter(sprName) {
  if (!SPR[sprName]) return null;
  return { kind: 'static', spr: sprName };
}

// Draw a STATIC character so its feet (bottom-centre of the sprite) land at
// (screenX, baselineY). No-op until the office sheet has loaded.
function drawStatic(ctx, screenX, baselineY, char) {
  const r = SPR[char.spr];
  if (!r || !sheetReady()) return;
  const [sx, sy, w, h] = r;
  const dx = Math.round(screenX - w / 2); // horizontal centre on screenX
  const dy = Math.round(baselineY - h);   // feet on baselineY
  const prevSmooth = ctx.imageSmoothingEnabled;
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(sheet, sx, sy, w, h, dx, dy, w, h);
  ctx.imageSmoothingEnabled = prevSmooth;
}

// ---- animated (generated atlas) characters --------------------------------

// Load an animated character: fetch its JSON atlas, normalize to the contract
// above, and load its PNG. Resolves to { kind:'animated', atlas, img } or null
// on any failure (fail-soft so a missing/half-generated character never throws
// into the draw loop).
export async function loadCharacter(jsonUrl) {
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
// (auburn-walk.json: no name/fps, has rows/frameCount, only a walk anim) and
// fills sane defaults so drawCharacter can treat every character uniformly.
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
  // Fall back any missing state to whatever the sheet does have, so seating a
  // walk-only fixture (no idle/type) still renders a frame rather than nothing.
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
    // Anchor defaults to the bottom-centre of a cell (feet on the floor) when
    // the atlas doesn't specify one.
    anchorX: raw.anchorX != null ? raw.anchorX : Math.floor(raw.cellW / 2),
    anchorY: raw.anchorY != null ? raw.anchorY : raw.cellH - 1,
    anims,
    fps,
  };
}

// Pick the frame index for an animated state from a shared clock. `clockMs` is a
// monotonic time (performance.now()); we advance through anims[state] at the
// state's fps. `phase` (e.g. a per-agent seed) desyncs identical characters so a
// row of typists doesn't keystroke in lockstep.
export function frameForState({ atlas, state = 'idle', clockMs = 0, phase = 0 }) {
  const a = atlas.anims[state] || atlas.anims.idle || [0];
  if (a.length <= 1) return a[0] || 0;
  const fps = atlas.fps[state] || DEFAULT_FPS[state] || 4;
  const step = Math.floor(clockMs / (1000 / fps)) + (phase | 0);
  return a[((step % a.length) + a.length) % a.length];
}

// Draw one animated character cell so its anchor lands at (screenX, baselineY).
// `frame` is an absolute frame number into the sheet's grid (col = frame % cols,
// row = floor(frame / cols)). `state` is accepted for the public contract but
// the frame is already resolved by the caller. No-op if the image isn't ready.
export function drawCharacter(ctx, screenX, baselineY, atlas, img, state, frame) {
  if (!atlas || !img || !img.complete || !img.naturalWidth) return;
  const { cellW, cellH, cols, anchorX, anchorY } = atlas;
  const f = frame | 0;
  const col = ((f % cols) + cols) % cols;
  const row = Math.floor(f / cols);
  const sx = col * cellW;
  const sy = row * cellH;
  // anchor within the cell → target point on the buffer
  const dx = Math.round(screenX - anchorX);
  const dy = Math.round(baselineY - anchorY);
  const prevSmooth = ctx.imageSmoothingEnabled;
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(img, sx, sy, cellW, cellH, dx, dy, cellW, cellH);
  ctx.imageSmoothingEnabled = prevSmooth;
}

// ---- unified draw ---------------------------------------------------------

// Draw any character (static OR animated) with its anchor at (screenX,
// baselineY). The single entry point the render loop uses per agent each frame;
// dispatches on char.kind. Static sprites ignore state/clock (no animation).
export function drawCharacterState(ctx, screenX, baselineY, char, { state = 'idle', clockMs = 0, phase = 0 } = {}) {
  if (!char) return;
  if (char.kind === 'static') { drawStatic(ctx, screenX, baselineY, char); return; }
  if (char.atlas && char.img) {
    const frame = frameForState({ atlas: char.atlas, state, clockMs, phase });
    drawCharacter(ctx, screenX, baselineY, char.atlas, char.img, state, frame);
  }
}
