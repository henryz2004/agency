// sprites.js — ALL procedural pixel-art primitives for the office. Nothing here
// blits a sprite sheet; every glyph is drawn with px() rects into a low-res
// buffer that CSS scales up crisply (image-rendering:pixelated).
//
// ONE consistent style: chunky 1px-grid pixel art, warm palette, soft top
// highlight + bottom shade on every solid so volumes read.

// ---- tiny helpers ----------------------------------------------------------
export function px(ctx, x, y, w, h, c) {
  ctx.fillStyle = c;
  ctx.fillRect(x | 0, y | 0, w | 0, h | 0);
}

export function shade(hex, amt) {
  const h = hex.replace('#', '');
  const n = parseInt(h.length === 3 ? h.replace(/(.)/g, '$1$1') : h, 16);
  let r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  r = Math.max(0, Math.min(255, r + amt));
  g = Math.max(0, Math.min(255, g + amt));
  b = Math.max(0, Math.min(255, b + amt));
  return `#${((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1)}`;
}

export function rng(seed) {
  let s = seed >>> 0 || 1;
  return () => {
    s = (Math.imul(s, 1103515245) + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };
}

export function hashInt(s) {
  let h = 2166136261 >>> 0;
  s = String(s);
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
  return h >>> 0;
}

// ---- palette ---------------------------------------------------------------
// Warm, cozy, cohesive. Model tiers keep the established color language:
// opus=gold, sonnet=cyan, haiku=green, codex=orange.
export const TIER = {
  opus:   { screen: '#ffce5e', glow: 'rgba(255,206,94,0.30)',  led: '#ffd166', code: '#fff0c0' },
  sonnet: { screen: '#5cd0ff', glow: 'rgba(92,208,255,0.30)',  led: '#5cd0ff', code: '#d0f4ff' },
  haiku:  { screen: '#6cff9a', glow: 'rgba(108,255,154,0.28)', led: '#6cff9a', code: '#d6ffe2' },
  codex:  { screen: '#ff9a4d', glow: 'rgba(255,138,61,0.30)',  led: '#ff8a3d', code: '#ffe0c9' },
};
export function tierFor(model) {
  const m = (model || '').toLowerCase();
  if (m.includes('codex')) return TIER.codex;
  if (m.includes('haiku')) return TIER.haiku;
  if (m.includes('sonnet')) return TIER.sonnet;
  return TIER.opus; // opus / fable / default
}

// ---- model color palette (salvaged from the old sprites.js) ----------------
// Used by app.js's model-mix bar/legend and the headcount comparison heads.
// Kept here (the sole sprites module) so app.js's `import { drawHead, colorFor }
// from './sprites.js'` resolves after proc graduation.
export const MODEL_COLORS = {
  'opus':   { screen: '#ffd166', glow: 'rgba(255,209,102,0.25)', code: '#fff0c0' },
  'sonnet': { screen: '#5cd0ff', glow: 'rgba(92,208,255,0.25)', code: '#d0f4ff' },
  'haiku':  { screen: '#6cff9a', glow: 'rgba(108,255,154,0.22)', code: '#d6ffe2' },
};

// Color for a model slug (used by the model-mix panel). Falls back to a stable
// hash-derived hue for any model not in MODEL_COLORS.
export function colorFor(model) {
  if (!model) return MODEL_COLORS.opus;
  const m = model.toLowerCase();
  if (m.includes('codex')) return { screen: '#ff8a3d', glow: 'rgba(255,138,61,0.25)', code: '#ffe0c9' };
  if (m.includes('opus') || m.includes('fable')) return MODEL_COLORS.opus;
  if (m.includes('sonnet')) return MODEL_COLORS.sonnet;
  if (m.includes('haiku')) return MODEL_COLORS.haiku;
  let h = 2166136261 >>> 0;
  for (let i = 0; i < m.length; i++) {
    h ^= m.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  const hue = h % 360;
  const screen = hslToHex(hue, 72, 68);
  const glow = `hsla(${hue} 72% 68% / 0.24)`;
  const code = hslToHex(hue, 60, 85);
  return { screen, glow, code };
}

function hslToHex(h, s, l) {
  s /= 100; l /= 100;
  const k = n => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = n => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  const toHex = v => Math.round(v * 255).toString(16).padStart(2, '0');
  return `#${toHex(f(0))}${toHex(f(8))}${toHex(f(4))}`;
}

// A single pixel "head" used for the headcount comparison row in app.js.
export function drawHead(ctx, x, y, { skin = '#f0c8a0', hair = '#2b2233', shirt = '#5d9ce0' } = {}) {
  px(ctx, x + 1, y, 6, 2, hair);
  px(ctx, x, y + 2, 8, 2, hair);
  px(ctx, x + 1, y + 2, 6, 4, skin);
  px(ctx, x + 2, y + 4, 1, 1, '#1a1a22');
  px(ctx, x + 5, y + 4, 1, 1, '#1a1a22');
  px(ctx, x, y + 6, 8, 3, shirt);
}

// Skin / hair / shirt variety palettes — warm and varied but harmonious.
// Exported so scripts/charsheet.mjs can enumerate the full appearance space.
export const SKINS = ['#ffe0bd', '#f2cda4', '#e8b88a', '#d49a6a', '#b87a4e', '#a86a44', '#8a5a3c', '#6b4426'];
export const HAIRS = ['#2b2233', '#4a3326', '#6b4a2e', '#8a5a30', '#c98a3a', '#9a9aa6', '#1d1d24', '#5a2d2d',
  '#b5532a', '#e6c878', '#e07db0', '#5d7de0', '#3aa6a0', '#d8d8e0']; // + ginger, blonde, pink, blue, teal, silver
export const SHIRTS = ['#d9694f', '#5d9ce0', '#5dc98a', '#e0b05d', '#a87de0', '#5dc9c9', '#e07db0', '#c0584f', '#4f8fb0',
  '#7d8a3a', '#3a6f8a', '#8a8f99', '#d97f3a', '#6f5dc9']; // + olive, steel, grey, orange, indigo
export const HAIR_STYLES = 7; // distinct hairStyle values — see drawHeadFace's switch
export const TOPS = 6;        // distinct clothing styles — see drawTorso

// ---- the back wall ---------------------------------------------------------
// A textured cream plaster wall (no sky — wall fills the whole band from the top
// of the canvas) with a wood rail, windows looking out on blue sky, a wall clock,
// framed pictures, and a glass whiteboard — all procedural.
// `wallH` is the full wall band height (the floor begins at y = wallH).
// ---- time-of-day mood ------------------------------------------------------
// The office mood shifts with the user's LOCAL hour: soft dawn, bright midday,
// warm dusk, dark-blue night. Each mood tints the wall plaster, the window sky,
// the ambient floor wash, and how strongly the interior pendant lights read.
// Night is kept READABLE — only the empty floor + walls darken; the team rugs
// and desks are drawn ON TOP of the wash, so they stay full color. office.js
// reads the clock (new Date() — fine client-side) and passes the mood in.
export const MOODS = {
  dawn:  { wall: '#e7dde0', sky: ['#c7a8d8', '#f3ccc2'], wash: ['rgba(255,206,196,0.16)', 'rgba(255,222,206,0.05)', 'rgba(48,30,40,0.16)'], glow: 0.35 },
  day:   { wall: '#efe6d4', sky: ['#7fc0f0', '#a9d8f7'], wash: ['rgba(255,238,200,0.16)', 'rgba(255,238,200,0.03)', 'rgba(40,22,6,0.14)'], glow: 0.0 },
  dusk:  { wall: '#e4cdb2', sky: ['#f3a05e', '#f8cf94'], wash: ['rgba(255,165,85,0.20)', 'rgba(255,150,95,0.06)', 'rgba(58,24,12,0.24)'], glow: 0.6 },
  night: { wall: '#3a3f55', sky: ['#16223f', '#283a5e'], wash: ['rgba(28,42,82,0.34)', 'rgba(22,32,62,0.22)', 'rgba(8,12,30,0.42)'], glow: 1.0 },
};
// Continuous time-of-day mood: interpolate between anchor moods so the lighting
// glides smoothly across the day instead of snapping between four states. Integer
// hours (the live app) land on sensible values; fractional hours (a time-lapse)
// get a smooth gradient.
const _hx = (c) => { c = c.replace('#', ''); return [parseInt(c.slice(0, 2), 16), parseInt(c.slice(2, 4), 16), parseInt(c.slice(4, 6), 16)]; };
const _lerp = (a, b, t) => a + (b - a) * t;
const _toHex = (r, g, b) => '#' + [r, g, b].map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0')).join('');
const _lerpHex = (a, b, t) => { const x = _hx(a), y = _hx(b); return _toHex(_lerp(x[0], y[0], t), _lerp(x[1], y[1], t), _lerp(x[2], y[2], t)); };
const _rgba = (s) => (s.match(/[\d.]+/g) || [0, 0, 0, 0]).map(Number);
const _lerpRgba = (a, b, t) => { const x = _rgba(a), y = _rgba(b); return `rgba(${Math.round(_lerp(x[0], y[0], t))},${Math.round(_lerp(x[1], y[1], t))},${Math.round(_lerp(x[2], y[2], t))},${_lerp(x[3] || 0, y[3] || 0, t).toFixed(3)})`; };
const _lerpMood = (A, B, t) => ({
  wall: _lerpHex(A.wall, B.wall, t),
  sky: [_lerpHex(A.sky[0], B.sky[0], t), _lerpHex(A.sky[1], B.sky[1], t)],
  wash: [_lerpRgba(A.wash[0], B.wash[0], t), _lerpRgba(A.wash[1], B.wash[1], t), _lerpRgba(A.wash[2], B.wash[2], t)],
  glow: _lerp(A.glow, B.glow, t),
});
const _MOOD_KEYS = [[0, MOODS.night], [6, MOODS.night], [8, MOODS.dawn], [10.5, MOODS.day], [16, MOODS.day], [18.5, MOODS.dusk], [20.5, MOODS.night], [24, MOODS.night]];
export function moodForHour(h) {
  h = ((h % 24) + 24) % 24;
  for (let i = 0; i < _MOOD_KEYS.length - 1; i++) {
    const [h0, m0] = _MOOD_KEYS[i], [h1, m1] = _MOOD_KEYS[i + 1];
    if (h >= h0 && h <= h1) return _lerpMood(m0, m1, (h - h0) / (h1 - h0));
  }
  return MOODS.night;
}

export function drawWall(ctx, bufW, wallH, frame, mood = MOODS.day) {
  // --- plaster wall fills the band from the top ---
  const wy = 0;
  ctx.fillStyle = mood.wall;
  ctx.fillRect(0, wy, bufW, wallH);
  // soft horizontal paneling lines (very faint) for texture
  ctx.fillStyle = 'rgba(150,120,80,0.05)';
  for (let y = wy + 12; y < wy + wallH - 8; y += 10) ctx.fillRect(0, y, bufW, 1);
  // a subtle ceiling shade along the very top so the wall reads as receding
  ctx.fillStyle = 'rgba(80,60,40,0.12)';
  ctx.fillRect(0, wy, bufW, 3);
  ctx.fillStyle = 'rgba(80,60,40,0.05)';
  ctx.fillRect(0, wy + 3, bufW, 2);

  // --- wall hangings: clock, pictures, glass board, windows ---
  // Reserve the FIXED features' x-ranges first, then tile windows ONLY where they
  // don't collide — so a narrow wall naturally shows fewer windows (down to one on
  // a 1-desk office) and the glass board never lands on top of a window.
  const winY = wy + 14, winW = 26, winH = 32;
  const clockX = Math.round(bufW * 0.46);
  const boardX = Math.round(bufW * 0.5) + 8, boardW = 40;
  const occupied = [
    [8, 38],                           // framed picture + calendar (upper-left)
    [clockX - 4, clockX + 14],         // wall clock
    [boardX - 3, boardX + boardW + 3], // glass board
  ];
  for (let x = 40; x < bufW - 36; x += 64) {
    if (occupied.some(([a, b]) => x + winW > a && x < b)) continue; // would overlap a feature
    drawWindow(ctx, x, winY, winW, winH, frame, mood.sky);
  }
  drawClock(ctx, clockX, wy + 16, frame);              // wall clock
  drawPicture(ctx, 14, wy + 18);                       // framed landscape, upper-left
  drawCalendar(ctx, 15, wy + 34);                      // calendar tucked beneath it
  drawGlassBoard(ctx, boardX, wy + 16);               // small green glass whiteboard

  // --- wood rail + baseboard at the bottom of the wall ---
  ctx.fillStyle = '#b07c44';
  ctx.fillRect(0, wy + wallH - 7, bufW, 4); // wood rail
  ctx.fillStyle = 'rgba(255,255,255,0.18)';
  ctx.fillRect(0, wy + wallH - 7, bufW, 1); // rail highlight
  ctx.fillStyle = '#7d5630';
  ctx.fillRect(0, wy + wallH - 3, bufW, 3); // baseboard
}

function drawWindow(ctx, x, y, w, h, frame, sky = ['#7fc0f0', '#a9d8f7']) {
  // frame
  px(ctx, x - 1, y - 1, w + 2, h + 2, '#3a4a63');
  // sky glass with a soft gradient + a diagonal glare streak (tinted by time of day)
  const g = ctx.createLinearGradient(x, y, x, y + h);
  g.addColorStop(0, sky[0]);
  g.addColorStop(1, sky[1]);
  ctx.fillStyle = g;
  ctx.fillRect(x, y, w, h);
  // glare
  ctx.fillStyle = 'rgba(255,255,255,0.35)';
  ctx.fillRect(x + 3, y + 2, 2, h - 4);
  ctx.fillRect(x + 6, y + 2, 1, h - 4);
  // muntins (cross bars)
  px(ctx, x + (w >> 1), y, 1, h, '#3a4a63');
  px(ctx, x, y + (h >> 1), w, 1, '#3a4a63');
  // a tiny potted plant on some sills (deterministic)
  if ((hashInt('sill' + x) & 3) === 0) {
    px(ctx, x + w - 7, y + h - 4, 4, 3, '#b5602e');
    px(ctx, x + w - 6, y + h - 7, 2, 3, '#4cb364');
  }
}

function drawClock(ctx, x, y, frame) {
  px(ctx, x - 1, y - 1, 12, 12, '#cdd6e6'); // rim
  px(ctx, x, y, 10, 10, '#fbf7ee');         // face
  px(ctx, x, y, 10, 1, '#e3ddd0');
  // ticks
  ctx.fillStyle = '#9a9488';
  px(ctx, x + 4, y + 1, 1, 1, '#9a9488');
  px(ctx, x + 4, y + 8, 1, 1, '#9a9488');
  px(ctx, x + 1, y + 4, 1, 1, '#9a9488');
  px(ctx, x + 8, y + 4, 1, 1, '#9a9488');
  // hands (hour fixed-ish, minute sweeps slowly)
  const min = (frame * 6) % 360;
  const a = (min * Math.PI) / 180;
  px(ctx, x + 5, y + 5, 1, 1, '#23262e');
  px(ctx, x + 5, y + 2, 1, 3, '#23262e'); // hour up
  px(ctx, x + 5 + Math.round(Math.sin(a) * 3), y + 5 - Math.round(Math.cos(a) * 3), 1, 1, '#c0473a');
}

function drawPicture(ctx, x, y) {
  px(ctx, x, y, 16, 12, '#6b4a2e');       // frame
  px(ctx, x + 1, y + 1, 14, 10, '#bfe3f5'); // sky
  px(ctx, x + 1, y + 7, 14, 4, '#e9c986');  // sandy ground
  px(ctx, x + 3, y + 4, 4, 4, '#e7a23a');   // sun-ish
  px(ctx, x + 1, y + 6, 14, 1, '#cda35e');
}

function drawCalendar(ctx, x, y) {
  px(ctx, x, y, 13, 12, '#f4f1ea');
  px(ctx, x, y, 13, 3, '#c0473a'); // red header
  ctx.fillStyle = '#b9c0cc';
  for (let r = 0; r < 3; r++)
    for (let c = 0; c < 4; c++) px(ctx, x + 1 + c * 3, y + 4 + r * 3, 2, 2, '#b9c0cc');
  px(ctx, x + 7, y + 7, 2, 2, '#e0855d'); // a marked day
}

function drawGlassBoard(ctx, x, y) {
  px(ctx, x - 1, y - 1, 40, 22, '#2e5b4a'); // dark green board
  px(ctx, x, y, 38, 20, '#356a56');
  px(ctx, x, y, 38, 1, 'rgba(255,255,255,0.12)');
  // faint scribbles + a tiny mountain logo (a la NORTHRIDGE STUDIO)
  ctx.fillStyle = 'rgba(255,255,255,0.55)';
  px(ctx, x + 4, y + 4, 6, 1, 'rgba(255,255,255,0.55)');
  px(ctx, x + 4, y + 7, 10, 1, 'rgba(255,255,255,0.35)');
  px(ctx, x + 4, y + 10, 7, 1, 'rgba(255,255,255,0.35)');
  // little chart bars
  ctx.fillStyle = '#8fdcb6';
  px(ctx, x + 24, y + 13, 2, 4, '#8fdcb6');
  px(ctx, x + 27, y + 11, 2, 6, '#8fdcb6');
  px(ctx, x + 30, y + 8, 2, 9, '#8fdcb6');
}

// ---- the floor -------------------------------------------------------------
// Warm wood planks — the cozy WeWork / Stardew vibe rather than cold tile.
export function drawFloor(ctx, bufW, top, bufH) {
  const plank = 14;
  for (let y = top, row = 0; y < bufH; y += plank, row++) {
    ctx.fillStyle = row % 2 ? '#c79a5e' : '#bb8e52'; // alternating board shade
    ctx.fillRect(0, y, bufW, plank);
    ctx.fillStyle = 'rgba(70,40,12,0.28)'; // seam below each board row
    ctx.fillRect(0, y + plank - 1, bufW, 1);
    ctx.fillStyle = 'rgba(255,240,210,0.10)'; // top sheen of each board
    ctx.fillRect(0, y, bufW, 1);
    ctx.fillStyle = 'rgba(70,40,12,0.16)'; // staggered board-end joints
    for (let x = (row % 2 ? 0 : 44); x < bufW; x += 88) ctx.fillRect(x, y, 1, plank - 1);
  }
}

// Soft warm daylight wash from the windows fading toward the front.
export function drawDaylight(ctx, bufW, top, bufH, mood = MOODS.day) {
  const g = ctx.createLinearGradient(0, top, 0, bufH);
  g.addColorStop(0, mood.wash[0]);
  g.addColorStop(0.5, mood.wash[1]);
  g.addColorStop(1, mood.wash[2]);
  ctx.fillStyle = g;
  ctx.fillRect(0, top, bufW, bufH - top);
}

// ---- a worker ("person at a desk") -----------------------------------------
// A little front-facing person: hair/skin/shirt vary per seed; hands type when
// working. Drawn so the head clears the cubicle divider and the body sits behind
// the desk. (cx, seatY) = centre-x, the chair seat line.

// Deterministic per-seed appearance (skin / hair / shirt / style / glasses /
// beard). Extracted so the seated worker and the standing walker derive the SAME
// look from a seed — keep the draw ORDER below so existing seeds are unchanged.
export function personLook(seed) {
  const vr = rng(seed * 2654435761 + 7);
  return {
    skin: SKINS[Math.floor(vr() * SKINS.length)],
    hair: HAIRS[Math.floor(vr() * HAIRS.length)],
    shirt: SHIRTS[Math.floor(vr() * SHIRTS.length)],
    hairStyle: Math.floor(vr() * HAIR_STYLES),
    top: Math.floor(vr() * TOPS),
    glasses: vr() < 0.3,
    beard: vr() < 0.22,
  };
}

// Hair + head + face + neck for one worker, from a personLook(). Shared by
// drawPerson (seated) and drawWalker (standing) so a worker looks identical either way.
function drawHeadFace(ctx, cx, hy, look, blink) {
  const { skin, hair, hairStyle, glasses, beard } = look;
  const hx = cx - 6;
  const fy = hy + 4;
  // --- hair style (7 variants). `sides`/`sideH` control the temple hair that
  // frames the face; bald shaves the sides (bare crown). All styles stay flush
  // to the skull — no protruding tufts that read as detached nubs at this size. ---
  let sides = true, sideH = 7;
  switch (hairStyle) {
    case 1: // tall quiff / pompadour
      px(ctx, hx, hy - 2, 12, 8, hair); px(ctx, hx + 3, hy - 4, 6, 3, hair); break;
    case 2: // side part — a parting line cut INTO the cap (not a raised tab)
      px(ctx, hx, hy, 12, 6, hair); px(ctx, hx + 4, hy, 1, 5, shade(hair, -34)); break;
    case 3: // cropped / buzz
      px(ctx, hx + 1, hy + 1, 10, 4, hair); break;
    case 4: // long — frames the face down past the jaw
      px(ctx, hx, hy, 12, 6, hair); sideH = 14; break;
    case 5: // bald — bare crown, no side hair
      px(ctx, hx + 1, hy + 1, 10, 4, skin);
      px(ctx, hx + 2, hy + 1, 6, 1, shade(skin, 18)); // pate shine
      sides = false; break;
    case 6: // afro / curls — a big rounded cap
      px(ctx, hx - 1, hy - 2, 14, 8, hair); px(ctx, hx, hy - 3, 12, 2, hair); sideH = 9; break;
    default: // 0 classic
      px(ctx, hx, hy, 12, 6, hair);
  }
  if (sides) {
    px(ctx, hx - 1, hy + 4, 2, sideH, hair); // sides
    px(ctx, hx + 11, hy + 4, 2, sideH, hair);
  }
  px(ctx, cx - 5, fy, 11, 10, skin);
  px(ctx, cx - 5, fy, 11, 2, shade(skin, 16)); // forehead light
  if (blink) {
    px(ctx, cx - 3, fy + 5, 2, 1, shade(skin, -40));
    px(ctx, cx + 2, fy + 5, 2, 1, shade(skin, -40));
  } else {
    px(ctx, cx - 3, fy + 4, 2, 2, '#1b1b22');
    px(ctx, cx + 2, fy + 4, 2, 2, '#1b1b22');
  }
  if (glasses) {
    px(ctx, cx - 4, fy + 3, 4, 4, '#23262e');
    px(ctx, cx + 1, fy + 3, 4, 4, '#23262e');
    px(ctx, cx - 3, fy + 4, 2, 2, blink ? skin : '#1b1b22');
    px(ctx, cx + 2, fy + 4, 2, 2, blink ? skin : '#1b1b22');
    px(ctx, cx, fy + 4, 1, 1, '#23262e'); // bridge
  }
  if (beard) px(ctx, cx - 5, fy + 7, 11, 3, shade(skin, -48));
  px(ctx, cx - 1, fy + 8, 3, 1, shade(skin, -30)); // mouth
  px(ctx, cx - 1, fy + 10, 3, 2, shade(skin, -14)); // neck
}

// Torso + clothing for one worker, from a personLook(). Shared by drawPerson
// (seated) and drawWalker (standing) so the outfit matches in both. (cx, ty) =
// centre-x and the shoulder line. Arms/legs are drawn by the caller; this is
// just the shirt block + a per-`top` clothing detail.
function drawTorso(ctx, cx, ty, look) {
  const s = look.shirt;
  px(ctx, cx - 5, ty, 11, 3, s);                  // shoulders (tapered in)
  px(ctx, cx - 6, ty + 3, 13, 8, s);              // torso body
  px(ctx, cx + 3, ty + 3, 4, 8, shade(s, -26));   // right-side shade
  switch (look.top) {
    case 1: // hoodie — neck roll, kangaroo pocket, drawstrings
      px(ctx, cx - 5, ty, 11, 2, shade(s, -34));
      px(ctx, cx - 3, ty + 6, 7, 3, shade(s, -30));
      px(ctx, cx - 3, ty + 6, 7, 1, shade(s, -14));
      px(ctx, cx - 1, ty + 2, 1, 4, '#eee8dc');
      px(ctx, cx + 1, ty + 2, 1, 4, '#eee8dc');
      break;
    case 2: // button-up / collared shirt
      px(ctx, cx - 3, ty, 3, 2, shade(s, 20));     // collar
      px(ctx, cx + 1, ty, 3, 2, shade(s, 20));
      px(ctx, cx - 1, ty, 2, 11, shade(s, 14));    // placket
      for (let i = 0; i < 4; i++) px(ctx, cx, ty + 2 + i * 2, 1, 1, shade(s, -52)); // buttons
      break;
    case 3: // crewneck sweater — ribbed collar + contrast chest band
      px(ctx, cx - 4, ty, 9, 2, shade(s, 24));
      px(ctx, cx - 6, ty + 6, 13, 2, shade(s, -22));
      break;
    case 4: // blazer over a tee — lapels + a lighter inner panel
      px(ctx, cx - 2, ty + 1, 5, 10, shade(s, 70));
      px(ctx, cx - 5, ty, 3, 6, shade(s, -22));
      px(ctx, cx + 3, ty, 3, 6, shade(s, -22));
      px(ctx, cx + 3, ty + 3, 4, 8, shade(s, -36));
      break;
    case 5: // striped tee
      px(ctx, cx - 6, ty + 4, 13, 1, shade(s, -40));
      px(ctx, cx - 6, ty + 7, 13, 1, shade(s, -40));
      px(ctx, cx - 6, ty + 10, 13, 1, shade(s, -40));
      px(ctx, cx - 1, ty, 2, 4, shade(s, 18));     // small collar
      break;
    default: // 0 plain tee
      px(ctx, cx - 1, ty, 2, 11, shade(s, 18));    // collar / placket
  }
}

// A staggered idle "fidget": every ~FIDGET_PERIOD frames an idling worker briefly
// performs one of three small actions, so a roomful never moves in lockstep.
// Returns { kind 0..2, t:0..1 progress } while one plays, else null. Deterministic
// from seed+frame (frame advances ~7.7×/s, so a fidget runs ~3s every ~15s).
const FIDGET_PERIOD = 116, FIDGET_LEN = 22;
function idleFidget(seed, frame) {
  const ph = (((frame + seed * 37) % FIDGET_PERIOD) + FIDGET_PERIOD) % FIDGET_PERIOD;
  if (ph >= FIDGET_LEN) return null;
  const kind = Math.floor((frame + seed * 37) / FIDGET_PERIOD) % 3;
  return { kind, t: ph / FIDGET_LEN };
}

export function drawPerson(ctx, cx, headTopY, opts) {
  const { seed = 1, activity = 'idle', frame = 0, unread = false } = opts;
  const look = opts.look || personLook(seed);
  const { skin, shirt } = look;

  const typing = activity === 'working';
  const shellRunning = activity === 'shell';
  const idle = !typing && !shellRunning;
  const fp = frame + (seed % 6);
  // Vertical body bob. WORKING dips DOWN on the typing cadence (leaning in);
  // shell/just-finished "breathe" up on a quick cadence; settled-idle breathes
  // calmly on a slow one AND throws an occasional fidget (sip / stretch / lean).
  const fidget = idle && !unread ? idleFidget(seed, frame) : null;
  const breath = (shellRunning || unread) && fp % 8 < 4 ? 1 : 0;
  const idleBreath = idle && !unread && fp % 16 < 8 ? 1 : 0;
  const typeBob = typing && frame % 4 < 2 ? 1 : 0; // dips DOWN, not up
  const hy = headTopY - breath - idleBreath + typeBob;
  const blink = (frame + (seed % 11)) % 13 === 0;
  const fy = hy + 4;

  // hair + head + face + neck (shared with the standing drawWalker)
  drawHeadFace(ctx, cx, hy, look, blink);

  // --- torso (shirt) — slimmed so the worker reads as a compact little person.
  // (The desk hides the lower half on a seated worker.)
  const ty = fy + 12; // carries the breath/typeBob shift via hy
  drawTorso(ctx, cx, ty, look);                   // shirt + per-`top` clothing
  const arm = shade(shirt, -12);
  // arms. UNREAD waves; a settled-idle worker fidgets; a working one strikes the
  // keys; otherwise the arms rest at the desk.
  if (unread && !typing && !shellRunning) {
    const wig = frame % 4 < 2 ? 0 : 2; // slow side-to-side hand wiggle (~2 Hz)
    px(ctx, cx - 8, ty + 3, 2, 7, arm);               // left arm down
    px(ctx, cx - 8, ty + 10, 2, 2, skin);             // left hand at desk
    px(ctx, cx + 6, ty, 2, 5, arm);                   // right upper arm, raised
    px(ctx, cx + 7, ty - 5, 2, 6, arm);               // right forearm up
    px(ctx, cx + 6 + wig, ty - 9, 3, 3, skin);        // waving hand
  } else if (fidget && fidget.kind === 0) {           // sip a coffee — hand to the mouth
    px(ctx, cx - 8, ty + 3, 2, 7, arm); px(ctx, cx - 8, ty + 10, 2, 2, skin); // left rests
    px(ctx, cx + 7, ty + 2, 2, 4, arm);               // right upper arm
    px(ctx, cx + 3, ty - 1, 2, 4, arm);               // forearm angled toward the face
    px(ctx, cx + 1, fy + 7, 4, 4, '#e4ded3');         // mug at the mouth
    px(ctx, cx + 1, fy + 7, 4, 1, '#f2ede4');
    px(ctx, cx + 5, fy + 8, 1, 2, '#c4bdb2');         // handle
    if (frame % 4 < 2) px(ctx, cx + 2, fy + 4, 1, 1, '#b8bdc8'); // steam
  } else if (fidget && fidget.kind === 1) {           // stretch — both arms reach up & ease back
    const up = Math.round(Math.sin(fidget.t * Math.PI) * 5);
    px(ctx, cx - 8, ty + 1 - up, 2, 6, arm); px(ctx, cx - 8, ty - 4 - up, 2, 2, skin);
    px(ctx, cx + 7, ty + 1 - up, 2, 6, arm); px(ctx, cx + 7, ty - 4 - up, 2, 2, skin);
  } else if (fidget && fidget.kind === 2) {           // lean back — elbows winged out, hands behind head
    px(ctx, cx - 9, ty + 1, 2, 4, arm); px(ctx, cx - 9, ty - 2, 4, 2, arm);
    px(ctx, cx + 7, ty + 1, 2, 4, arm); px(ctx, cx + 6, ty - 2, 4, 2, arm);
  } else {
    // typing strikes alternate L/R; at rest the arms simply hang at the desk.
    const lh = typing && frame % 2 ? 2 : 0;
    const rh = typing && frame % 2 ? 0 : 2;
    px(ctx, cx - 8, ty + 3, 2, 7 - lh, arm);          // left arm (raises with its hand)
    px(ctx, cx + 7, ty + 3, 2, 7 - rh, arm);          // right arm (mirror about cx)
    px(ctx, cx - 8, ty + 10 - lh, 2, 2, skin);        // left hand
    px(ctx, cx + 7, ty + 10 - rh, 2, 2, skin);        // right hand
  }
}

// A STANDING / walking worker — the same person as drawPerson, on its feet, for
// the idle-wander floor life. (cx, feetY) = centre-x and the floor line at the
// feet. Front-facing (no flip); `walking` strides the legs and bobs the body.
export function drawWalker(ctx, cx, feetY, opts = {}) {
  const { seed = 1, frame = 0, walking = false } = opts;
  const look = opts.look || personLook(seed);
  const { skin, shirt } = look;
  const blink = (frame + (seed % 11)) % 13 === 0;
  // soft pixel ground shadow for grounding
  px(ctx, cx - 6, feetY, 12, 1, 'rgba(0,0,0,0.20)');
  px(ctx, cx - 4, feetY + 1, 8, 1, 'rgba(0,0,0,0.12)');
  const bob = walking && frame % 4 < 2 ? 1 : 0;                      // gentle walk bob
  const idleRise = !walking && (frame + seed * 3) % 18 < 9 ? 1 : 0;  // calm standing breath
  const ty = feetY - 19 - bob - idleRise; // torso top
  const hy = ty - 16;                     // head top (neck lands back at ty)
  drawHeadFace(ctx, cx, hy, look, blink);
  // torso (shirt) — shared with the seated worker so the outfit matches
  drawTorso(ctx, cx, ty, look);
  const arm = shade(shirt, -12);
  // arms — swing opposite the legs while walking, fidget while idling (stretch /
  // check a phone), else hang. Idle fidgets are seed-staggered so wanderers don't sync.
  const fidget = !walking ? idleFidget(seed, frame) : null;
  if (fidget && fidget.kind === 1) {            // stretch up
    const up = Math.round(Math.sin(fidget.t * Math.PI) * 5);
    px(ctx, cx - 8, ty + 1 - up, 2, 6, arm); px(ctx, cx - 8, ty - 4 - up, 2, 2, skin);
    px(ctx, cx + 7, ty + 1 - up, 2, 6, arm); px(ctx, cx + 7, ty - 4 - up, 2, 2, skin);
  } else if (fidget && fidget.kind === 0) {     // check a phone — hands meet in front, screen glows
    px(ctx, cx - 6, ty + 4, 2, 4, arm); px(ctx, cx + 5, ty + 4, 2, 4, arm); // forearms angled in
    px(ctx, cx - 4, ty + 7, 8, 2, skin);        // hands at the belly
    px(ctx, cx - 2, ty + 6, 5, 2, '#2a2f3a');   // the phone
    px(ctx, cx - 2, ty + 6, 5, 1, '#5cd0ff');   // its glow
  } else {                                      // hang; hands swing ±1 opposite while walking
    const sw = walking ? (frame % 4 < 2 ? 1 : -1) : 0;
    px(ctx, cx - 8, ty + 3, 2, 7, arm); px(ctx, cx - 8, ty + 10 + sw, 2, 2, skin);
    px(ctx, cx + 7, ty + 3, 2, 7, arm); px(ctx, cx + 7, ty + 10 - sw, 2, 2, skin);
  }
  // legs (pants, darker than the shirt) + an alternating walk stride
  const pants = shade(shirt, -55);
  const legTop = ty + 11, legH = feetY - legTop;
  const lLift = walking && frame % 4 < 2 ? 1 : 0;
  const rLift = walking && frame % 4 < 2 ? 0 : 1;
  px(ctx, cx - 4, legTop + lLift, 3, legH - lLift, pants);
  px(ctx, cx + 1, legTop + rLift, 3, legH - rLift, pants);
}

// ---- pets: a wandering cat + a lounging dog -------------------------------
// Pure procedural sprites (office.js owns their roaming STATE and passes it in as
// opts). Both animate off `frame`; the cat additionally flips to face its heading.
// (cx of the cat art is ~x+5; the dog faces right and doesn't flip.)
export function drawCat(ctx, x, y, frame, dir = 1, opts = {}) {
  x = Math.round(x); y = Math.round(y);
  const { sleeping = false, petted = false, walking = false } = opts;
  const body = '#23252c';
  const flip = dir < 0; // mirror about the body centre so it walks the way it heads
  if (flip) { ctx.save(); ctx.translate((x + 5) * 2, 0); ctx.scale(-1, 1); }
  if (sleeping) {
    // curled up, eyes shut, slow breathing; a "z" drifts above.
    const br = frame % 16 < 8 ? 0 : 1;
    px(ctx, x, y - 4 - br, 11, 4 + br, body);        // curled body
    px(ctx, x + 7, y - 5 - br, 5, 4, body);          // tucked head
    px(ctx, x + 8, y - 7 - br, 2, 2, body);          // folded ear
    px(ctx, x + 8, y - 3 - br, 2, 1, '#3a3d45');     // closed eye
    px(ctx, x - 1, y - 1, 6, 1, body);               // tail wrapped round the front
    const zz = '#9aa3b5', zy = y - 11 - (frame % 8 < 4 ? 0 : 1); // "z" bobs
    px(ctx, x + 12, zy, 3, 1, zz); px(ctx, x + 13, zy + 1, 1, 1, zz); px(ctx, x + 12, zy + 2, 3, 1, zz);
  } else {
    // sitting / walking. Idle cats periodically groom (head dips, a pink tongue)
    // and flick an ear; walking cats bob and shuffle their paws.
    const grooming = !petted && !walking && (frame + 3) % 70 < 12;
    const earTwitch = !petted && !grooming && frame % 44 < 2;
    const bob = walking && frame % 4 < 2 ? 1 : 0, by = y - bob;
    const hd = grooming ? 2 : 0;                       // head dips to groom
    px(ctx, x, by - 6, 8, 6, body);                   // body
    px(ctx, x + 6, by - 11 + hd, 6, 6, body);         // head
    px(ctx, x + 6, by - 13 + hd - (earTwitch ? 1 : 0), 2, 3 + (earTwitch ? 1 : 0), body); // left ear (twitches)
    px(ctx, x + 10, by - 13 + hd, 2, 3, body);        // right ear
    if (grooming) {
      px(ctx, x + 8, by - 8, 1, 1, '#3a3d45');        // eye lowered while licking
      px(ctx, x + 8, by - 5, 1, 1, '#ff9db0');        // tongue at the paw
    } else {
      px(ctx, x + 8, by - 9, 1, 1, '#6cff9a'); px(ctx, x + 10, by - 9, 1, 1, '#6cff9a'); // eyes
    }
    const tail = frame % 8 < 4 ? 0 : 1;
    if (petted) px(ctx, x - 2, by - 12, 2, 7, body);            // happy upright tail
    else if (walking) px(ctx, x - 3, by - 7 - tail, 3, 2, body); // tail trails behind
    else px(ctx, x - 2, by - 8 - tail, 2, 6, body);            // lazy tail flick
    const step = walking && frame % 4 < 2 ? 1 : 0;             // paw shuffle
    px(ctx, x + 1, by - step, 1, 1, body); px(ctx, x + 5, by - (walking ? 1 - step : 0), 1, 1, body);
  }
  if (flip) ctx.restore();
  if (petted) { // hearts float up (drawn UNflipped so they read upright)
    const hx = x + 3, hy = y - 16 - (frame % 6), pink = '#ff6b9d';
    px(ctx, hx, hy, 1, 1, pink); px(ctx, hx + 2, hy, 1, 1, pink);
    px(ctx, hx - 1, hy + 1, 5, 1, pink); px(ctx, hx, hy + 2, 3, 1, pink); px(ctx, hx + 1, hy + 3, 1, 1, pink);
  }
}

export function drawDog(ctx, x, y, opts = {}) {
  x = Math.round(x); y = Math.round(y);
  const { frame = 0, petted = false } = opts;
  const fur = '#d98a4a', dk = '#b5702e';
  // periodic behaviours on offset cadences so they don't coincide
  const yawning = !petted && (frame + 5) % 104 < 10;   // a slow yawn
  const panting = petted || frame % 64 < 20;           // tongue out (always while petted)
  const earPerk = (frame + 7) % 52 < 6;                // ear pricks up, alert
  const lookDn = (frame + 11) % 86 < 8 ? 1 : 0;        // glances down/around
  const headBob = petted && frame % 4 < 2 ? 1 : 0;     // happy head bob when petted
  px(ctx, x, y - 5, 12, 5, fur);                       // body
  const hy = y - 9 - headBob;
  px(ctx, x + 10, hy, 6, 6, fur);                      // head
  px(ctx, x + 9, hy - 1 - (earPerk ? 1 : 0), 2, 4 + (earPerk ? 1 : 0), dk); // ear (perks)
  px(ctx, x + 14, hy + 3 + lookDn, 1, 1, '#1b1b22');   // eye (drifts when looking around)
  px(ctx, x + 16, hy + 4, 2, 1, '#1b1b22');            // snout
  if (yawning) {                                       // open mouth + a bit of tongue
    px(ctx, x + 15, hy + 5, 3, 2, '#3a1f16'); px(ctx, x + 16, hy + 6, 1, 1, '#ff9db0');
  } else if (panting) {
    const t = frame % 8 < 4 ? 1 : 0; px(ctx, x + 16, hy + 5 + t, 2, 2 - t, '#ff7a93'); // lolling tongue
  }
  const wag = petted ? (frame % 4 < 2 ? 0 : 2) : (frame % 8 < 4 ? 0 : 1);
  px(ctx, x - 3, y - 6 - wag, 4, 2, '#e09a5a');        // wagging tail
  px(ctx, x + 8, y - 5, 4, 3, '#fff');                 // white belly patch
  px(ctx, x + 1, y, 1, 1, dk); px(ctx, x + 9, y, 1, 1, dk); // paws
  if (petted) {
    const hx = x + 12, hy2 = y - 16 - (frame % 6), pink = '#ff6b9d';
    px(ctx, hx, hy2, 1, 1, pink); px(ctx, hx + 2, hy2, 1, 1, pink);
    px(ctx, hx - 1, hy2 + 1, 5, 1, pink); px(ctx, hx, hy2 + 2, 3, 1, pink); px(ctx, hx + 1, hy2 + 3, 1, 1, pink);
  }
}

// ---- a desk workstation ----------------------------------------------------
// A clean open desk (NO enclosing cubicle frame): a wood desk surface, a glowing
// tier-colored monitor + keyboard, a country/flag pin, a sticky-note cluster, a
// desk plant or mug, and the seated person. Everything procedural. The desk sits
// directly on its team rug (drawn by the office), reading like open team pods
// rather than boxed cubicles.
// (x, y) = top-left of the cell; CW/CH = cell size.
export const CELL_W = 58;
export const CELL_H = 78;
const DESK_TOP = 52;   // desk surface y within the cell
const DIV_W = 4;       // legacy inset used to position desk props/flag

export function drawCubicle(ctx, x, y, agent, frame, selected, hovered, unread = false, away = false) {
  const tier = tierFor(agent.model);
  const seed = (agent.pid | 0) || hashInt(agent.sessionId || 'a');
  const cx = x + CELL_W / 2;
  // --- the seated worker + their personal props. Idle no longer desaturates: the
  // OFF (dark) monitor + grey status dot already read as idle, so the worker keeps
  // full color. `away` (idle-wander): worker has left its desk → draw it empty.
  if (!away) drawPerson(ctx, cx - 6, y + DESK_TOP - 27, { seed, activity: agent.activity, frame, unread });
  // a pinned flag + sticky-note cluster (personalization)
  drawPin(ctx, cx - 22, y + DESK_TOP - 20, seed);
  drawStickies(ctx, cx + 14, y + DESK_TOP - 20, seed);

  // --- wood desk surface across the cell ---
  const dx = x + DIV_W, dw = CELL_W - DIV_W * 2;
  px(ctx, dx, y + DESK_TOP, dw, 8, '#9c6f44');       // desk slab
  px(ctx, dx, y + DESK_TOP, dw, 2, '#b3855a');       // top light
  px(ctx, dx, y + DESK_TOP + 8, dw, 3, '#6f4a2a');   // front edge

  // --- monitor (tier-colored screen + activity content) on the right ---
  drawMonitor(ctx, x + CELL_W - 24, y + DESK_TOP - 18, tier, agent, seed, frame);
  // keyboard in front of the worker
  px(ctx, cx - 9, y + DESK_TOP + 1, 16, 3, '#1c2029');
  px(ctx, cx - 8, y + DESK_TOP + 1, 14, 1, '#2a3340');
  // a desk mug or tiny plant on the left
  drawDeskProp(ctx, x + DIV_W + 3, y + DESK_TOP, seed, frame);

  // --- status LED on the desk ---
  const led = ledColor(agent.activity, frame);
  px(ctx, dx + 2, y + DESK_TOP + 3, 3, 3, led);
  // soft monitor glow over the cell while active
  if (agent.activity === 'working' || agent.activity === 'shell') {
    ctx.fillStyle = tier.glow;
    ctx.fillRect(x + CELL_W - 30, y + DESK_TOP - 22, 28, 24);
  }

  // --- subagents: tiny helpers gathered in front of the desk. Kept ABOVE the
  // name chip (its top sits at CELL_H-10) so the row never peeks out behind the
  // nameplate as a clipped teal band. ---
  const subs = agent.subagents || [];
  if (subs.length) {
    const n = Math.min(subs.length, 4), sp = 9;
    const sx = Math.round(x + (CELL_W - n * sp) / 2);
    for (let i = 0; i < n; i++) drawMinion(ctx, sx + i * sp, y + CELL_H - 13, (frame + i) % 2);
  }

  // --- selection / hover ring --- (selected = persistent tier-colored pulse;
  // hover = cyan #5cd0ff)
  if (selected || hovered) drawRing(ctx, x, y, CELL_W, CELL_H, selected ? tier.led : '#5cd0ff', frame, selected);
}

function ledColor(act, frame) {
  if (act === 'working') return frame % 2 ? '#39d98a' : '#1f7d52';
  if (act === 'shell') return frame % 2 ? '#ffb454' : '#9c6a1f';
  return '#5a6478';
}

function drawMonitor(ctx, x, y, tier, agent, seed, frame) {
  const mw = 20, mh = 15;
  px(ctx, x - 1, y - 1, mw + 2, mh + 2, '#15181f'); // bezel
  px(ctx, x, y, mw, mh, '#0d0f14');
  const typing = agent.activity === 'working';
  const shellRunning = agent.activity === 'shell';
  // The lit inner glass. (sx, sy) = top-left of usable pixels, sw × sh = its size.
  const sx = x + 1, sy = y + 1, sw = mw - 2, sh = mh - 2;
  if (typing) {
    px(ctx, sx, sy, sw, sh, shade(tier.screen, -178)); // deep tier-tinted glass
    // Deterministic content style per agent (a given agent always shows the same
    // app): code editor, terminal, diff, or a tiny dashboard.
    const style = shellRunning ? 1 : hashInt('mon' + seed) % 4;
    if (style === 0) drawScreenEditor(ctx, sx, sy, sw, sh, tier, seed, frame);
    else if (style === 1) drawScreenTerminal(ctx, sx, sy, sw, sh, tier, seed, frame);
    else if (style === 2) drawScreenDiff(ctx, sx, sy, sw, sh, tier, seed, frame);
    else drawScreenChart(ctx, sx, sy, sw, sh, tier, seed, frame);
  } else if (shellRunning) {
    px(ctx, sx, sy, sw, sh, '#0b130d'); // shell → dark green glass
    drawScreenTerminal(ctx, sx, sy, sw, sh, tier, seed, frame);
  } else { // idle: screen OFF — dark glass + a faint reflection so it reads "off"
    px(ctx, sx, sy, sw, sh, '#0b0e14');
    px(ctx, x + 2, y + 2, 1, mh - 4, 'rgba(255,255,255,0.06)');
    px(ctx, x + 4, y + 3, 1, mh - 6, 'rgba(255,255,255,0.03)');
  }
  // stand
  px(ctx, x + (mw >> 1) - 1, y + mh, 3, 3, '#3a4150');
  px(ctx, x + (mw >> 1) - 4, y + mh + 3, 9, 2, '#2b313e');
}

// --- monitor screen content -------------------------------------------------
// All four renderers fill the inner glass (sx, sy, sw, sh) and never spill past
// it. They lay out on a fixed 2px line grid so rows never overlap, vary length /
// color / indent deterministically from `seed`, and animate gently via `frame`.
// `LH` = line height (1px text + 1px gap); the syntax palette mixes tier.code
// with muted accents so a row of code reads as keywords/strings/idents.

const LH = 2; // px per text line (1px glyph + 1px gap)

// A 1px window-chrome title strip across the top of an app screen: a slightly
// lighter bar with two tiny "window dots", so editor/terminal/diff read as real
// app windows. Returns the y where content should begin (1px below the bar).
function drawScreenChrome(ctx, sx, sy, sw, tier) {
  px(ctx, sx, sy, sw, 1, 'rgba(255,255,255,0.10)'); // title bar
  px(ctx, sx + 1, sy, 1, 1, shade(tier.screen, 30)); // left "tab/dot"
  px(ctx, sx + 3, sy, 1, 1, 'rgba(255,255,255,0.28)');
  return sy + 1; // content starts on the next row
}

// A believable code editor: a title bar, a gutter of line numbers, then indented
// code lines whose token runs alternate color (keyword / ident / string), plus a
// caret on the active line that blinks and steps down a line every few frames.
function drawScreenEditor(ctx, sx, sy, sw, sh, tier, seed, frame) {
  const kw = shade(tier.screen, 50);      // "keyword" — bright tier hue
  const ident = tier.code;                 // identifiers — light text
  const str = '#e0a35d';                   // strings — warm
  const gut = 'rgba(255,255,255,0.20)';    // gutter line numbers
  const cy0 = drawScreenChrome(ctx, sx, sy, sw, tier);
  const rows = Math.floor((sy + sh - cy0) / LH);
  const gw = 3;                            // gutter width (room for a 2px digit)
  // gutter background tick marks (one faint 1px "line number" per row)
  for (let i = 0; i < rows; i++) px(ctx, sx + 1, cy0 + i * LH, 1, 1, gut);
  // a slow vertical scroll so new code drifts up over time
  const scroll = Math.floor(frame / 24);
  const active = (frame >> 1) % rows;       // the line the caret sits on
  let caretX = sx + gw + 1;
  for (let i = 0; i < rows; i++) {
    const rr = rng(seed * 17 + (i + scroll) * 131 + 7);
    const indent = (Math.floor(rr() * 3)) * 2;        // 0 / 2 / 4 px indent
    let cx = sx + gw + 1 + indent;
    const lineRight = sx + sw - 1;
    // 1–3 token runs of alternating color across the row
    const tokens = 1 + Math.floor(rr() * 3);
    const palette = [kw, ident, str];
    for (let t = 0; t < tokens && cx < lineRight; t++) {
      const tw = 2 + Math.floor(rr() * 4);
      const w = Math.min(tw, lineRight - cx);
      if (w > 0) px(ctx, cx, cy0 + i * LH, w, 1, palette[(t + i) % 3]);
      cx += w + 1; // 1px space between tokens
    }
    if (i === active) caretX = Math.min(cx, lineRight); // caret follows the code
  }
  // blinking caret on the active line
  if (frame % 2) px(ctx, caretX, cy0 + active * LH, 1, 1, '#ffffff');
}

// A terminal: a title strip, "$" prompt lines + output that scroll up as a new
// line is appended, with a blinking block caret on the active prompt.
function drawScreenTerminal(ctx, sx, sy, sw, sh, tier, seed, frame) {
  const green = '#8bd450', dim = 'rgba(139,212,80,0.55)', warn = '#e0a35d';
  const cy0 = drawScreenChrome(ctx, sx, sy, sw, tier);
  const rows = Math.floor((sy + sh - cy0) / LH);
  const right = sx + sw - 1;
  // which output line is the newest (it grows, mimicking a command printing)
  const tick = Math.floor(frame / 16);
  for (let i = 0; i < rows - 1; i++) {
    const rr = rng(seed * 23 + (i + tick) * 97 + 3);
    const isPrompt = rr() < 0.34;
    let cx = sx + 1;
    if (isPrompt) { px(ctx, cx, cy0 + i * LH, 1, 1, green); cx += 2; } // "$"
    // output run: length varies; the bottom-most line "types in" with frame
    let lw = 3 + Math.floor(rr() * 9);
    if (i === rows - 2) lw = 2 + (Math.floor(frame / 4) % 11);
    const w = Math.min(lw, right - cx);
    if (w > 0) px(ctx, cx, cy0 + i * LH, w, 1, isPrompt ? green : (rr() < 0.3 ? warn : dim));
  }
  // active prompt + blinking block caret on the last row
  const ly = cy0 + (rows - 1) * LH;
  px(ctx, sx + 1, ly, 1, 1, green);
  if (frame % 2) px(ctx, sx + 3, ly, 2, 1, green);
}

// A diff view: a title strip, a red/green change gutter and corresponding +/-
// lines, like a review pane. Lines hold their color (add=green, del=red, ctx=dim).
function drawScreenDiff(ctx, sx, sy, sw, sh, tier, seed, frame) {
  const add = '#4caf6a', addg = '#2e6b42', del = '#c0473a', delg = '#7a2e26';
  const ctxt = 'rgba(255,255,255,0.28)';
  const cy0 = drawScreenChrome(ctx, sx, sy, sw, tier);
  const rows = Math.floor((sy + sh - cy0) / LH);
  const scroll = Math.floor(frame / 30);
  for (let i = 0; i < rows; i++) {
    const rr = rng(seed * 29 + (i + scroll) * 113 + 11);
    const k = rr();
    const kind = k < 0.4 ? 'add' : (k < 0.7 ? 'del' : 'ctx');
    const gutc = kind === 'add' ? addg : kind === 'del' ? delg : 'transparent';
    const txtc = kind === 'add' ? add : kind === 'del' ? del : ctxt;
    if (gutc !== 'transparent') px(ctx, sx + 1, cy0 + i * LH, 1, 1, gutc); // change bar
    const indent = (Math.floor(rr() * 3)) * 2;
    const cx = sx + 3 + indent;
    const lw = 3 + Math.floor(rr() * 8);
    const w = Math.min(lw, sx + sw - 1 - cx);
    if (w > 0) px(ctx, cx, cy0 + i * LH, w, 1, txtc);
  }
}

// A tiny dashboard: a title strip, then a small live bar chart whose bars sway
// gently with frame — reads as a metrics/monitoring screen.
function drawScreenChart(ctx, sx, sy, sw, sh, tier, seed, frame) {
  const bar = shade(tier.screen, 30), tip = tier.code;
  const top = drawScreenChrome(ctx, sx, sy, sw, tier);
  // baseline
  const base = sy + sh - 1;
  px(ctx, sx + 1, base, sw - 2, 1, 'rgba(255,255,255,0.18)');
  const bw = 2, gap = 1;
  const maxH = base - top - 1;
  let bx = sx + 2;
  let i = 0;
  while (bx + bw <= sx + sw - 1) {
    const phase = (frame * 0.18) + i * 1.1 + (hashInt('bar' + seed) % 7);
    const norm = 0.35 + 0.55 * (0.5 - 0.5 * Math.cos(phase)); // 0.35..0.9, swaying
    const h = Math.max(1, Math.round(maxH * norm));
    const by = base - h;
    px(ctx, bx, by, bw, h, bar);
    px(ctx, bx, by, bw, 1, tip); // bright cap
    bx += bw + gap;
    i++;
  }
}

function drawDeskProp(ctx, x, baseY, seed, frame) {
  const kind = hashInt('prop' + seed) % 4;
  if (kind === 0) { // coffee mug + steam
    px(ctx, x, baseY - 5, 5, 5, '#e4ded3');
    px(ctx, x, baseY - 5, 5, 1, '#f2ede4');
    px(ctx, x + 1, baseY - 4, 3, 1, '#6f5240');
    px(ctx, x + 5, baseY - 4, 1, 2, '#c4bdb2');
    if (frame % 4 < 2) px(ctx, x + 2, baseY - 7, 1, 1, '#b8bdc8');
  } else if (kind === 1) { // tiny plant
    px(ctx, x + 1, baseY - 3, 4, 3, '#9c5a2e');
    px(ctx, x, baseY - 6, 2, 3, '#3f9a55');
    px(ctx, x + 2, baseY - 7, 2, 4, '#4cb364');
    px(ctx, x + 4, baseY - 5, 2, 2, '#3f9a55');
  } else if (kind === 2) { // a small stack of books
    px(ctx, x, baseY - 2, 7, 2, '#c0473a');
    px(ctx, x + 1, baseY - 4, 6, 2, '#5d9ce0');
    px(ctx, x, baseY - 6, 7, 2, '#5dc98a');
  } else { // framed photo
    px(ctx, x, baseY - 6, 6, 6, '#6b4a2e');
    px(ctx, x + 1, baseY - 5, 4, 4, '#bfe3f5');
    px(ctx, x + 2, baseY - 3, 2, 2, '#e0855d');
  }
}

function drawPin(ctx, x, y, seed) {
  const flags = [
    ['#c0473a', '#ffffff', '#3a5bbf'], // tricolor-ish
    ['#3a5bbf', '#ffffff', '#3a5bbf'],
    ['#2e7d4f', '#ffffff', '#e0855d'],
    ['#e0b05d', '#c0473a', '#2e5b8a'],
  ];
  const f = flags[hashInt('f' + seed) % flags.length];
  px(ctx, x, y, 9, 6, '#ffffff');
  px(ctx, x, y, 3, 6, f[0]);
  px(ctx, x + 3, y, 3, 6, f[1]);
  px(ctx, x + 6, y, 3, 6, f[2]);
  px(ctx, x, y, 9, 1, 'rgba(255,255,255,0.3)');
  px(ctx, x + 4, y - 1, 1, 1, '#888'); // pin
}

function drawStickies(ctx, x, y, seed) {
  const cols = ['#f4d35e', '#9ad5e0', '#e8a0c0', '#a8e0a0'];
  const n = 1 + (hashInt('st' + seed) % 3);
  for (let i = 0; i < n; i++) {
    const c = cols[(hashInt('sc' + seed + i)) % cols.length];
    px(ctx, x + (i % 2) * 6, y + (i >> 1) * 6, 5, 5, c);
    px(ctx, x + (i % 2) * 6, y + (i >> 1) * 6, 5, 1, shade(c, 20));
  }
}

function drawMinion(ctx, x, feetY, bob) {
  const y = feetY - bob;
  px(ctx, x + 1, y - 9, 4, 2, '#1f2a33');
  px(ctx, x + 1, y - 8, 4, 3, '#f0c8a0');
  px(ctx, x + 2, y - 7, 1, 1, '#10141a');
  px(ctx, x, y - 5, 6, 4, '#2bb0aa');
  px(ctx, x + 4, y - 5, 2, 4, '#1f8a85');
  px(ctx, x + 1, y - 1, 1, 1, '#171b22');
  px(ctx, x + 4, y - 1, 1, 1, '#171b22');
}

function drawRing(ctx, x, y, w, h, color, frame, strong) {
  const L = 7;
  ctx.globalAlpha = strong ? 1 : 0.6;
  ctx.fillStyle = color;
  const x1 = x + w - 1, y1 = y + h - 1;
  ctx.fillRect(x, y, L, 1); ctx.fillRect(x, y, 1, L);
  ctx.fillRect(x1 - L + 1, y, L, 1); ctx.fillRect(x1, y, 1, L);
  ctx.fillRect(x, y1, L, 1); ctx.fillRect(x, y1 - L + 1, 1, L);
  ctx.fillRect(x1 - L + 1, y1, L, 1); ctx.fillRect(x1, y1 - L + 1, 1, L);
  if (strong && frame % 4 < 2) {
    ctx.globalAlpha = 0.14;
    ctx.fillRect(x, y, w, 1); ctx.fillRect(x, y1, w, 1);
    ctx.fillRect(x, y, 1, h); ctx.fillRect(x1, y, 1, h);
  }
  ctx.globalAlpha = 1;
}

// "Waiting on you" — the floor's HIGHEST-signal state (a background agent blocked
// on the user). Treats the WHOLE DESK as the alert, not just a small floating !:
// a soft pulsing amber glow pooled over the cell + a bold pulsing amber frame
// around it + a bobbing "!" bubble over the head. Reads come-help-me, and is
// deliberately unlike the green working LED, the gray idle desk, and the pink
// just-finished pip. (x, y) = the cell's TOP-LEFT (CELL_W × CELL_H).
export function drawNeedsYou(ctx, x, y, frame) {
  const ph = (frame % 16) / 16;
  const pulse = 0.5 - 0.5 * Math.cos(ph * 2 * Math.PI); // smooth 0→1→0 breathing
  const amber = '#ffb454';
  // soft amber glow pooling over the desk
  const gx = x + CELL_W / 2, gy = y + CELL_H / 2;
  const grad = ctx.createRadialGradient(gx, gy, 4, gx, gy, CELL_W * 0.72);
  grad.addColorStop(0, `rgba(255,180,84,${(0.12 + pulse * 0.16).toFixed(3)})`);
  grad.addColorStop(1, 'rgba(255,180,84,0)');
  ctx.fillStyle = grad;
  ctx.fillRect(x - 3, y, CELL_W + 6, CELL_H);
  // bold pulsing amber frame around the whole cell (the come-help-me outline)
  ctx.globalAlpha = 0.55 + pulse * 0.45;
  const x1 = x + CELL_W;
  px(ctx, x, y + 3, CELL_W, 2, amber);          // top
  px(ctx, x, y + CELL_H - 5, CELL_W, 2, amber);  // bottom
  px(ctx, x, y + 3, 2, CELL_H - 8, amber);       // left
  px(ctx, x1 - 2, y + 3, 2, CELL_H - 8, amber);  // right
  ctx.globalAlpha = 1;
  // --- bobbing amber "!" bubble over the head ---
  const bob = frame % 6 < 3 ? 0 : 1;
  const bx = gx + 6, by = y + 16 - bob;
  ctx.globalAlpha = 0.30 + pulse * 0.28; // halo breathes with the frame
  px(ctx, bx - 2, by - 1, 16, 13, amber);
  ctx.globalAlpha = 1;
  px(ctx, bx - 1, by, 12, 9, amber);            // bubble body
  px(ctx, bx - 1, by, 12, 1, '#ffd793');        // top highlight
  px(ctx, bx - 1, by + 8, 12, 1, '#e08a2a');    // bottom shade
  px(ctx, bx, by + 9, 3, 2, amber);             // tail toward the head
  px(ctx, bx + 4, by + 2, 2, 4, '#3a2606');     // "!"
  px(ctx, bx + 4, by + 7, 2, 1, '#3a2606');
}

// PM crown — a small gold crown bobbing above the lead's head.
export function drawCrown(ctx, cx, headTopY, frame) {
  const bob = frame % 8 < 4 ? 0 : 1;
  const y = headTopY - 7 - bob;
  const g = '#ffd166', hl = '#fff0c0', dk = '#c79a2e';
  px(ctx, cx - 4, y + 4, 9, 2, g);
  px(ctx, cx - 4, y + 5, 9, 1, dk);
  px(ctx, cx - 4, y + 1, 2, 3, g);
  px(ctx, cx, y, 2, 4, g);
  px(ctx, cx + 4, y + 1, 2, 3, g);
  px(ctx, cx - 4, y + 1, 1, 1, hl);
  px(ctx, cx, y, 1, 1, hl);
  px(ctx, cx, y + 2, 1, 1, '#ff5cba');
}
