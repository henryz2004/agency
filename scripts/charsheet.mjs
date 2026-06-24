// charsheet.mjs — render a contact sheet of every procedural character variation
// to docs/characters.png. Zero deps: the renderers only use fillStyle+fillRect,
// so scripts/_pixpng.mjs runs them headlessly and dumps a PNG (stdlib zlib).
// Re-run after tweaking palettes / hair styles / clothing in public/sprites.js.
//
//   node scripts/charsheet.mjs
import { writeFileSync } from 'node:fs';
import { Ctx, encodePNG, upscale, selfCheckPNG } from './_pixpng.mjs';
import { drawWalker, personLook, SKINS, HAIRS, SHIRTS, HAIR_STYLES, TOPS } from '../public/sprites.js';

selfCheckPNG(); // throws if the shim/encoder is broken — fail before writing a bad file

// ---- the sheet: three stacked sections, each a centred grid of walkers -------
const CELL_W = 28, CELL_H = 50, SCALE = 4, BG = '#1b1e26';
const clean = (l) => ({ ...l, glasses: false, beard: false });

// Section 1 — hair styles (cols, each its own palette) × face accessory (rows).
const hairCols = [];
for (let c = 0; c < HAIR_STYLES; c++) { const b = clean(personLook(c * 7919 + 13)); b.hairStyle = c; b.top = 0; hairCols.push(b); }
const faceRows = [(l) => l, (l) => ({ ...l, glasses: true }), (l) => ({ ...l, beard: true }), (l) => ({ ...l, glasses: true, beard: true })];
const sec1 = faceRows.map((f) => hairCols.map((b) => f(b)));

// Section 2 — clothing styles (cols) × colorways (rows): each row is one person
// wearing every `top`, rows differ in palette so colors vary too.
const sec2 = [111, 222, 333, 444].map((seed) => {
  const b = clean(personLook(seed));
  return Array.from({ length: TOPS }, (_, t) => ({ ...b, top: t }));
});

// Section 3 — palette sweeps: every skin tone, hair color, shirt color.
const base = clean(personLook(42)); base.top = 0;
const sec3 = [
  SKINS.map((skin) => ({ ...base, skin, hairStyle: 0 })),
  HAIRS.map((hair) => ({ ...base, hair, hairStyle: 0 })),
  SHIRTS.map((shirt) => ({ ...base, shirt, hairStyle: 2 })),
];

const sections = [sec1, sec2, sec3];
const M = 16, GAP = 22;
const secW = (s) => Math.max(...s.map((r) => r.length)) * CELL_W;
const W = M * 2 + Math.max(...sections.map(secW));
const H = M * 2 + sections.reduce((n, s) => n + s.length * CELL_H, 0) + GAP * (sections.length - 1);
const ctx = new Ctx(W, H, BG);

const place = (look, gridX, col, gridY, row) =>
  drawWalker(ctx, gridX + col * CELL_W + CELL_W / 2, gridY + row * CELL_H + CELL_H - 6, { look, frame: 0, walking: false });

let y = M;
sections.forEach((sec, si) => {
  const gx = M + Math.round((W - M * 2 - secW(sec)) / 2);
  sec.forEach((looks, r) => looks.forEach((l, c) => place(l, gx, c, y, r)));
  y += sec.length * CELL_H;
  if (si < sections.length - 1) { ctx.fillStyle = 'rgba(255,255,255,0.10)'; ctx.fillRect(M, Math.round(y + GAP / 2), W - M * 2, 1); y += GAP; }
});

// ---- encode + write ---------------------------------------------------------
const out = new URL('../docs/characters.png', import.meta.url);
const big = upscale(ctx.buf, W, H, SCALE);
writeFileSync(out, encodePNG(W * SCALE, H * SCALE, big));
const count = sections.reduce((n, s) => n + s.reduce((m, r) => m + r.length, 0), 0);
console.log(`wrote ${out.pathname} — ${W * SCALE}×${H * SCALE}px, ${count} characters`);
