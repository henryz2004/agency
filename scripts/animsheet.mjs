// animsheet.mjs — a film-strip of every character & pet ANIMATION to
// docs/animations.png: one row per animation, columns = consecutive frames left
// to right (read a row like a flip-book). Static poses only — to watch them move,
// run `npm start` and open /lab.html. Some rows jump to a specific frame window so
// a given idle fidget (which fires on a seed-staggered cadence) is guaranteed to
// show; the console prints the row legend.
//
//   node scripts/animsheet.mjs
import { writeFileSync } from 'node:fs';
import { Ctx, encodePNG, upscale, selfCheckPNG } from './_pixpng.mjs';
import { drawPerson, drawWalker, drawCat, drawDog } from '../public/sprites.js';

selfCheckPNG();

// idle fidgets fire when (frame + seed*37) % 116 < 22, cycling kind 0→1→2 each
// period. seed 0 → window starts at frame 0 (kind 0), 116 (kind 1), 232 (kind 2).
const clips = [
  { name: 'seated · typing',     kind: 'person', seed: 7, act: 'working',                f: (i) => i },
  { name: 'seated · sip coffee', kind: 'person', seed: 0, act: 'idle',                   f: (i) => i * 3 },
  { name: 'seated · stretch',    kind: 'person', seed: 0, act: 'idle',                   f: (i) => 116 + i * 3 },
  { name: 'seated · lean back',  kind: 'person', seed: 0, act: 'idle',                   f: (i) => 232 + i * 3 },
  { name: 'seated · wave (done)',kind: 'person', seed: 3, act: 'idle', unread: true,     f: (i) => i },
  { name: 'walk cycle',          kind: 'walker', seed: 5, walking: true,                 f: (i) => i },
  { name: 'idle · check phone',  kind: 'walker', seed: 0, walking: false,                f: (i) => i * 3 },
  { name: 'idle · stretch',      kind: 'walker', seed: 0, walking: false,                f: (i) => 116 + i * 3 },
  { name: 'cat · walk',          kind: 'cat',    mode: 'walk',                           f: (i) => i * 2 },
  { name: 'cat · groom',         kind: 'cat',    mode: 'sit',                            f: (i) => i },
  { name: 'cat · sleep',         kind: 'cat',    mode: 'sleep',                          f: (i) => i * 2 },
  { name: 'cat · petted',        kind: 'cat',    mode: 'pet',                            f: (i) => i },
  { name: 'dog · pant/look',     kind: 'dog',    mode: 'idle',                           f: (i) => 6 + i },
  { name: 'dog · yawn',          kind: 'dog',    mode: 'yawn',                           f: (i) => 99 + i },
  { name: 'dog · petted',        kind: 'dog',    mode: 'pet',                            f: (i) => i },
];

const FR = 8, CW = 30, CH = 46, M = 12, SCALE = 5, BG = '#1b1e26';
const W = M * 2 + FR * CW, H = M * 2 + clips.length * CH;
const ctx = new Ctx(W, H, BG);

function render(clip, cx, top, bottom, frame) {
  if (clip.kind === 'person') drawPerson(ctx, cx, top + 9, { seed: clip.seed, activity: clip.act, frame, unread: !!clip.unread });
  else if (clip.kind === 'walker') drawWalker(ctx, cx, bottom - 5, { seed: clip.seed, frame, walking: clip.walking });
  else if (clip.kind === 'cat') {
    const o = clip.mode === 'sleep' ? { sleeping: true } : clip.mode === 'pet' ? { petted: true } : clip.mode === 'walk' ? { walking: true } : {};
    drawCat(ctx, cx - 6, bottom - 5, frame, 1, o);
  } else drawDog(ctx, cx - 9, bottom - 5, { frame, petted: clip.mode === 'pet' });
}

clips.forEach((clip, r) => {
  const top = M + r * CH, bottom = top + CH;
  // pets live on the warm office floor and the cat is near-black — give the pet
  // rows a floor band so they read (workers stay on dark so their torsos fade out).
  if (clip.kind === 'cat' || clip.kind === 'dog') { ctx.fillStyle = '#a8814e'; ctx.fillRect(M, top, W - M * 2, CH); }
  for (let i = 0; i < FR; i++) render(clip, M + i * CW + CW / 2, top, bottom, clip.f(i));
  if (r) { ctx.fillStyle = 'rgba(255,255,255,0.07)'; ctx.fillRect(M, top, W - M * 2, 1); } // row divider
});

const out = new URL('../docs/animations.png', import.meta.url);
writeFileSync(out, encodePNG(W * SCALE, H * SCALE, upscale(ctx.buf, W, H, SCALE)));
console.log(`wrote ${out.pathname} — ${W * SCALE}×${H * SCALE}px, ${clips.length} animations × ${FR} frames`);
clips.forEach((c, r) => console.log(`  row ${r + 1}: ${c.name}`));
