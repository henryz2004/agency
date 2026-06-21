// proc-office.js — the fully-procedural office: lays mock agents into project
// desk clusters interleaved with cozy decor zones (lounge, meeting table, kitchen
// counter, plant beds, pets), then composites the whole scene. Renders into a
// buffer canvas that the page scales up crisply.

import { makeAgents } from './mock-agents.js';
import {
  px, shade, hashInt, rng,
  drawWall, drawFloor, drawDaylight,
  drawCubicle, drawCrown, CELL_W, CELL_H,
} from './proc-sprites.js';

const WALL_H = 70;                 // cream wall band; fills from the top of canvas
const TOP = WALL_H;                // floor starts here (no sky)
const MARGIN = 16;
const CLUSTER_PAD = 6;             // inset around a cluster's cells
const HEADER_H = 14;               // repo-label clearance atop each cluster (DOM tab sits here)
const GAP_X = 16;                  // gap between blocks on a row
const GAP_Y = 20;                  // gap between rows
const TILE_COLS = 3;               // max cubicles across per cluster
const UPSCALE = 3;                 // canvas is CSS-scaled this much; the DOM label layer matches

let canvas, ctx, bufW = 0, bufH = 0, frame = 0;
let agents = [];
let clusters = [];   // {x, y, w, h, count, firstAgent, project, seed}
let decor = [];      // {type, x, y, w, h, seed}
let cells = [];      // {x, y, agent} — flattened, in draw order

// DOM overlay layer: real (crisp) HTML text for the name chips + repo labels,
// instead of canvas pixel text. One wrapper div over the canvas, scaled by
// UPSCALE so children are positioned in BUFFER coordinates (matching the canvas
// art); a future camera can transform this one wrapper as a group.
let labelWrap = null;        // the single group wrapper
const nameNodes = [];        // pooled name-chip elements, reused between frames
const repoNodes = [];        // pooled repo-label elements, reused between frames

// ---- layout ----------------------------------------------------------------

function clusterDims(count) {
  const cols = Math.min(count, TILE_COLS);
  const rows = Math.ceil(count / cols);
  return {
    cols, rows,
    w: cols * CELL_W + CLUSTER_PAD * 2,
    h: HEADER_H + rows * CELL_H + CLUSTER_PAD,
  };
}

// One project = ONE team = ONE cluster (one rug, one label). The list arrives
// project-sorted (see setAgents), so each project is a single contiguous run.
// A big team is NOT split into pods — clusterDims() wraps it across rows WITHIN
// the one cluster, so it never reads as two separate teams.
function clusterRuns(list) {
  const runs = [];
  let i = 0;
  while (i < list.length) {
    const key = list[i].project;
    let j = i;
    while (j < list.length && list[j].project === key) j++;
    runs.push({ project: key, start: i, count: j - i });
    i = j;
  }
  return runs;
}

// Pack the desk clusters into a TIGHT central grid (clusters directly adjacent,
// small gaps, wrapping into rows) — like the reference's cubicle block — then lay
// a dedicated cozy LOUNGE BAND of decor along the floor beneath the desks, plus
// fixed amenities against the back wall. Decor is NOT interleaved between desks
// (that's what made the floor read sparse); it lives in its own band so the
// bullpen stays dense.
const CLUSTER_GAP_X = 12; // tight gap between adjacent desk clusters on a row
const CLUSTER_GAP_Y = 10; // gap between rows of desk clusters (tight, like the ref)
const LOUNGE_BAND_H = 60; // height of the decor band beneath the bullpen
// Reserved band at the top of the floor for back-wall amenities (the kitchen
// counter ends at TOP+25) and the hanging ceiling pendants (end ~TOP+18). The
// bullpen starts below this so decor never clips a cluster rug — count-independent.
const AMENITY_BAND_H = 30;

function plan() {
  clusters = []; decor = []; cells = [];
  const runs = clusterRuns(agents);

  // --- size each cluster, then pick a columns-per-row that keeps the bullpen
  // roughly landscape (wider than tall) without overflowing a sane width. ---
  const sized = runs.map((run, ci) => {
    const d = clusterDims(run.count);
    return { count: run.count, project: run.project, firstAgent: run.start, w: d.w, h: d.h, dims: d, seed: 101 + ci * 7 };
  });
  const nC = sized.length;
  const perRow = nC <= 1 ? 1 : nC <= 2 ? 2 : nC <= 6 ? 3 : 4;

  // --- greedy row-wrap by CLUSTER COUNT (fixed perRow), tight gaps. Rows are
  // left-aligned to a common bullpen origin; the whole bullpen is centred later. ---
  const bx0 = MARGIN, by0 = TOP + AMENITY_BAND_H;
  let col = 0, rowW = 0, rowTopH = 0;
  let cx = bx0, cy = by0;
  const rows = [[]];
  sized.forEach((b) => {
    if (col === perRow) { // wrap
      cy += rowTopH + CLUSTER_GAP_Y;
      cx = bx0; col = 0; rowTopH = 0; rows.push([]);
    }
    b.x = cx; b.y = cy;
    rows[rows.length - 1].push(b);
    cx += b.w + CLUSTER_GAP_X; col++;
    rowTopH = Math.max(rowTopH, b.h);
    rowW = Math.max(rowW, cx - CLUSTER_GAP_X - bx0);
  });
  const bullpenBottom = cy + rowTopH;

  // centre each row within the widest row so ragged tails read balanced
  rows.forEach((row) => {
    if (!row.length) return;
    const last = row[row.length - 1];
    const used = last.x + last.w - bx0;
    const shift = Math.round((rowW - used) / 2);
    if (shift > 0) row.forEach((b) => { b.x += shift; });
  });

  // --- realise clusters + cells ---
  sized.forEach((b) => {
    clusters.push({ x: b.x, y: b.y, w: b.w, h: b.h, count: b.count, firstAgent: b.firstAgent, project: b.project, seed: b.seed });
    const { cols } = b.dims;
    for (let k = 0; k < b.count; k++) {
      const c = k % cols, r = Math.floor(k / cols);
      cells.push({
        x: b.x + CLUSTER_PAD + c * CELL_W,
        y: b.y + HEADER_H + r * CELL_H,
        agent: agents[b.firstAgent + k],
      });
    }
  });

  // --- buffer width: the bullpen plus margins, but at least wide enough to host
  // the lounge band + amenities so few-agent floors still read like a real room. ---
  const minRoomW = 360;
  bufW = Math.max(minRoomW, rowW + MARGIN * 2);

  // --- cozy LOUNGE BAND beneath the bullpen: a couch lounge, a meeting table,
  // and plant beds spread across the floor width so the lower half reads furnished
  // rather than empty. Sized to the room; trimmed on a narrow (few-agent) floor. ---
  const bandY = bullpenBottom + 8;
  const bandItems = bufW > 520
    ? [
        { type: 'plants', w: 40 }, { type: 'lounge', w: 100 },
        { type: 'meeting', w: 92 }, { type: 'plants', w: 40 }, { type: 'lounge', w: 100 },
      ]
    : bufW > 300
      ? [{ type: 'lounge', w: 100 }, { type: 'meeting', w: 92 }, { type: 'plants', w: 40 }]
      : [{ type: 'lounge', w: 100 }, { type: 'plants', w: 40 }];
  // lay the band centred across the floor with even gaps
  const bandTotal = bandItems.reduce((s, it) => s + it.w, 0);
  const bandGap = bandItems.length > 1 ? Math.max(18, (bufW - MARGIN * 2 - bandTotal) / (bandItems.length - 1)) : 0;
  let lx = MARGIN + Math.max(0, (bufW - MARGIN * 2 - bandTotal - bandGap * (bandItems.length - 1)) / 2);
  bandItems.forEach((it) => {
    decor.push({ type: it.type, x: Math.round(lx), y: bandY, w: it.w, h: LOUNGE_BAND_H, seed: hashInt(it.type + lx) });
    lx += it.w + bandGap;
  });

  // --- bounds (now that the band is placed) ---
  let maxY = bullpenBottom;
  decor.forEach((z) => { maxY = Math.max(maxY, z.y + z.h); });
  bufH = Math.round(maxY) + MARGIN + 8;

  // centre the bullpen horizontally in the (possibly wider) room
  const bullShift = Math.round((bufW - MARGIN * 2 - rowW) / 2);
  if (bullShift > 0) {
    clusters.forEach((c) => { c.x += bullShift; });
    cells.forEach((c) => { c.x += bullShift; });
  }

  // --- fixed amenities + pets ---
  // kitchen counter standing against the back wall on the far right
  decor.push({ type: 'kitchen', x: bufW - 84, y: TOP - 1, w: 78, h: 30, seed: 999 });
  // a cat and a dog lounging on the open floor of the band
  decor.push({ type: 'cat', x: MARGIN + 10, y: bandY + LOUNGE_BAND_H - 6, seed: 5 });
  decor.push({ type: 'dog', x: bufW - 60, y: bandY + LOUNGE_BAND_H - 4, seed: 9 });
}

// ---- decor drawing ---------------------------------------------------------

function drawDecor() {
  for (const z of decor) {
    if (z.type === 'lounge') drawLounge(z);
    else if (z.type === 'meeting') drawMeeting(z);
    else if (z.type === 'plants') drawPlants(z);
    else if (z.type === 'kitchen') drawKitchen(z);
    else if (z.type === 'cat') drawCat(z.x, z.y, frame);
    else if (z.type === 'dog') drawDog(z.x, z.y);
  }
}

function drawAreaRug(z, fill, edge) {
  const rx = z.x + 4, ry = z.y + z.h - 40, rw = z.w - 8, rh = 36;
  px(ctx, rx + 3, ry, rw - 6, rh, fill);
  px(ctx, rx, ry + 3, rw, rh - 6, fill);
  px(ctx, rx + 3, ry, rw - 6, 1, edge);
  px(ctx, rx + 3, ry + rh - 1, rw - 6, 1, edge);
  px(ctx, rx + 8, ry + 4, rw - 16, 1, 'rgba(255,255,255,0.08)');
  return { rx, ry, rw, rh, floorY: ry + rh - 4 };
}

function drawLounge(z) {
  const { floorY, rx } = drawAreaRug(z, '#caa46c', '#b58f56'); // warm sand rug
  // two-seat couch on the left
  const couchCols = ['#d9694f', '#5d9ce0', '#5dc98a', '#a87de0'];
  const couch = couchCols[hashInt('couch' + z.seed) % couchCols.length];
  const cxx = rx + 4, cyy = floorY - 16;
  px(ctx, cxx, cyy, 34, 12, couch);              // body
  px(ctx, cxx, cyy - 5, 34, 6, shade(couch, -12)); // backrest
  px(ctx, cxx, cyy - 5, 34, 1, shade(couch, 22));
  px(ctx, cxx - 3, cyy - 4, 4, 16, shade(couch, -8)); // left arm
  px(ctx, cxx + 33, cyy - 4, 4, 16, shade(couch, -8)); // right arm
  px(ctx, cxx + 8, cyy + 1, 1, 10, shade(couch, -20)); // cushion seam
  px(ctx, cxx + 22, cyy + 1, 1, 10, shade(couch, -20));
  // a throw pillow
  px(ctx, cxx + 3, cyy + 2, 7, 6, '#f4d35e');
  // coffee table in front
  const tx = cxx + 40, ty = floorY - 8;
  px(ctx, tx, ty, 18, 5, '#8a5e34');
  px(ctx, tx, ty, 18, 1, '#a5743f');
  px(ctx, tx + 1, ty + 5, 2, 3, '#5a3d22');
  px(ctx, tx + 15, ty + 5, 2, 3, '#5a3d22');
  px(ctx, tx + 6, ty - 2, 4, 2, '#d8d2c8'); // mug on the table
  // a plant at the back-right
  drawPlant(ctx, tx + 22, floorY - 3);
}

function drawMeeting(z) {
  const { floorY, rx, rw } = drawAreaRug(z, '#54707b', '#46606a'); // slate task rug
  // a long meeting table centred
  const tw = rw - 24, tx = rx + 12, ty = floorY - 12;
  px(ctx, tx, ty, tw, 7, '#a5743f');
  px(ctx, tx, ty, tw, 2, '#c08a52');
  px(ctx, tx, ty + 7, tw, 2, '#6f4a2a');
  px(ctx, tx + 2, ty + 9, 2, 4, '#5a3d22');      // legs
  px(ctx, tx + tw - 4, ty + 9, 2, 4, '#5a3d22');
  // laptops / a coffee on top
  px(ctx, tx + 6, ty - 3, 8, 4, '#1c2230');
  px(ctx, tx + 7, ty - 2, 6, 2, '#5cd0ff');
  px(ctx, tx + tw - 16, ty - 3, 8, 4, '#1c2230');
  px(ctx, tx + tw - 15, ty - 2, 6, 2, '#ffd166');
  px(ctx, tx + (tw >> 1) - 2, ty - 2, 3, 2, '#c0473a'); // mug
  // accent chairs pulled up
  const chairCols = ['#e0855d', '#5dc98a', '#e0b05d', '#5d9ce0'];
  const c1 = chairCols[hashInt('ch' + z.seed) % chairCols.length];
  const c2 = chairCols[hashInt('ch' + z.seed + 3) % chairCols.length];
  px(ctx, tx - 8, floorY - 12, 6, 12, c1);
  px(ctx, tx - 8, floorY - 12, 6, 2, shade(c1, 20));
  px(ctx, tx + tw + 2, floorY - 12, 6, 12, c2);
  px(ctx, tx + tw + 2, floorY - 12, 6, 2, shade(c2, 20));
}

function drawPlants(z) {
  const floorY = z.y + z.h - 4;
  // a low wood planter box with two staggered plants
  const bx = z.x + 2, bw = z.w - 4, by = floorY - 6;
  px(ctx, bx, by, bw, 7, '#6f4d2b');
  px(ctx, bx, by, bw, 2, '#8a6238');
  px(ctx, bx, by + 6, bw, 1, '#5a3d22');
  drawPlant(ctx, z.x + 2, floorY - 5);
  drawPlant(ctx, z.x + z.w - 16, floorY - 1);
}

function drawPlant(ctx, x, baseY) {
  // a leafy potted plant ~14 tall
  px(ctx, x + 3, baseY - 5, 8, 6, '#b5602e'); // pot
  px(ctx, x + 3, baseY - 5, 8, 1, '#cd7438'); // pot rim
  px(ctx, x + 4, baseY - 11, 6, 7, '#3f9a55'); // foliage core
  px(ctx, x + 2, baseY - 9, 3, 5, '#4cb364');  // left frond
  px(ctx, x + 9, baseY - 9, 3, 5, '#4cb364');  // right frond
  px(ctx, x + 5, baseY - 14, 4, 4, '#5cc873');  // top frond
  px(ctx, x + 5, baseY - 13, 2, 2, '#74dd8c');  // highlight
}

function drawKitchen(z) {
  const x = z.x, y = z.y, w = z.w;
  const floorY = y + 26;
  // counter cabinet
  px(ctx, x, y + 8, w, 18, '#cfd5de');
  px(ctx, x, y + 8, w, 2, '#e2e7ee');        // counter top light
  px(ctx, x, y + 24, w, 2, 'rgba(0,0,0,0.12)');
  // cabinet doors
  for (let dx = x + 3; dx < x + w - 6; dx += 16) {
    px(ctx, dx, y + 12, 13, 11, '#bcc3cd');
    px(ctx, dx + 11, y + 16, 1, 3, '#8a93a0'); // handle
  }
  // a coffee machine on the counter
  px(ctx, x + 5, y + 1, 9, 8, '#2b2f38');
  px(ctx, x + 6, y + 2, 7, 3, '#3a414c');
  px(ctx, x + 7, y + 5, 5, 2, '#c0473a'); // hot plate glow
  // two mugs
  px(ctx, x + 17, y + 4, 4, 4, '#e4ded3');
  px(ctx, x + 17, y + 4, 4, 1, '#f2ede4');
  px(ctx, x + 23, y + 5, 4, 3, '#5dc98a');
  // a vending machine on the right end
  const vx = x + w - 18;
  px(ctx, vx, y - 6, 16, 32, '#c0473a');
  px(ctx, vx + 2, y - 4, 9, 24, '#1a2a3a'); // glass
  ctx.fillStyle = '#5cd0ff';
  for (let r = 0; r < 4; r++) for (let c = 0; c < 3; c++) px(ctx, vx + 3 + c * 3, y - 3 + r * 6, 2, 4, ['#5cd0ff', '#ffd166', '#6cff9a', '#e07db0'][(r + c) % 4]);
  px(ctx, vx + 12, y + 4, 3, 6, '#0d1018'); // dispense slot
}

function drawCat(x, y, frame) {
  const tail = frame % 8 < 4 ? 0 : 1;
  px(ctx, x, y - 6, 8, 6, '#23252c');   // body
  px(ctx, x + 6, y - 11, 6, 6, '#23252c'); // head
  px(ctx, x + 6, y - 13, 2, 3, '#23252c'); // ears
  px(ctx, x + 10, y - 13, 2, 3, '#23252c');
  px(ctx, x + 8, y - 9, 1, 1, '#6cff9a'); // eye
  px(ctx, x + 10, y - 9, 1, 1, '#6cff9a');
  px(ctx, x - 2, y - 8 - tail, 2, 6, '#23252c'); // tail
  px(ctx, x + 1, y, 1, 1, '#23252c'); px(ctx, x + 5, y, 1, 1, '#23252c'); // paws
}

function drawDog(x, y) {
  px(ctx, x, y - 5, 12, 5, '#d98a4a');   // body
  px(ctx, x + 10, y - 9, 6, 6, '#d98a4a'); // head
  px(ctx, x + 9, y - 10, 2, 4, '#b5702e');  // ear
  px(ctx, x + 14, y - 6, 1, 1, '#1b1b22');  // eye
  px(ctx, x + 16, y - 5, 2, 1, '#1b1b22');  // snout
  px(ctx, x - 3, y - 6, 4, 2, '#e09a5a');   // tail
  px(ctx, x + 8, y - 5, 4, 3, '#fff');      // white belly patch
  px(ctx, x + 1, y, 1, 1, '#b5702e'); px(ctx, x + 9, y, 1, 1, '#b5702e'); // paws
}

// ---- ceiling pendant lights pooling warmth over each cluster ----------------
function drawCeilingLights() {
  const py = TOP + 3;
  // a service pipe across the top of the floor
  px(ctx, 0, py, bufW, 3, '#b8493d');
  px(ctx, 0, py, bufW, 1, 'rgba(255,255,255,0.12)');
  px(ctx, 0, py + 5, bufW, 1, '#8f8a80');
  const anchors = [
    ...clusters.map((c) => ({ cx: c.x + c.w / 2, py: c.y + c.h / 2, pool: c.w * 0.6, h: c.h })),
    ...decor.filter((z) => z.type === 'lounge' || z.type === 'meeting').map((z) => ({ cx: z.x + z.w / 2, py: z.y + z.h * 0.6, pool: z.w * 0.55, h: z.h })),
  ];
  for (const a of anchors) {
    const cx = Math.round(a.cx);
    const grad = ctx.createRadialGradient(cx, a.py, 2, cx, a.py, Math.max(28, a.pool));
    grad.addColorStop(0, 'rgba(255,224,150,0.16)');
    grad.addColorStop(0.7, 'rgba(255,224,150,0.04)');
    grad.addColorStop(1, 'rgba(255,224,150,0)');
    ctx.fillStyle = grad;
    ctx.fillRect(cx - a.pool, a.py - a.h / 2, a.pool * 2, a.h);
    // cord + cylinder shade + glowing bulb
    px(ctx, cx, py + 3, 1, 5, '#2b2b2b');
    px(ctx, cx - 3, py + 8, 6, 6, '#33373f');
    px(ctx, cx - 3, py + 8, 1, 6, '#454b55');
    px(ctx, cx + 2, py + 8, 1, 6, '#1d2026');
    px(ctx, cx - 2, py + 14, 4, 1, frame % 12 === 0 ? '#fff0c0' : '#ffe39a');
  }
}

// A muted area rug under each desk cluster — grounds the team neighbourhood and
// lets the warm wood read as the circulation path around it. Rug tone rotates
// across a small dusty palette so adjacent teams read as distinct zones.
const RUG_TONES = [
  { fill: '#4a6360', edge: '#3b504e' }, // dusty teal
  { fill: '#5c5168', edge: '#473f53' }, // muted plum
  { fill: '#6b5642', edge: '#564536' }, // warm taupe
  { fill: '#4a5a6e', edge: '#3c4a5b' }, // slate blue
];
function drawClusterRugs() {
  clusters.forEach((c) => {
    const tone = RUG_TONES[hashInt('rug' + c.seed) % RUG_TONES.length];
    // Rug now starts near the top of the cluster (was below the header band) so
    // it includes a top strip where the repo label is "sewn into" the carpet.
    const rx = c.x - 4, ry = c.y + 2, rw = c.w + 8, rh = c.h + 2;
    px(ctx, rx, ry, rw, rh, tone.fill);
    px(ctx, rx, ry, rw, 2, tone.edge);
    px(ctx, rx, ry + rh - 2, rw, 2, tone.edge);
    px(ctx, rx, ry, 2, rh, tone.edge);
    px(ctx, rx + rw - 2, ry, 2, rh, tone.edge);
    px(ctx, rx + 4, ry + 3, rw - 8, 1, 'rgba(255,255,255,0.05)'); // faint sheen
  });
}

// ---- DOM label overlay (real crisp text) ------------------------------------
// Name chips + repo labels are HTML, not canvas pixels — the sheet office at
// :4313 does the same (sharp DOM text scaled by the camera), which is far more
// legible than any bitmap font at this buffer resolution. The wrapper is sized
// in BUFFER coords and scaled by UPSCALE, so node positions reuse the same
// cell/cluster coords the canvas art uses. Nodes are pooled and reused between
// updates so nothing leaks. A future camera can transform `labelWrap` as a group.

// Build (once) the group wrapper, parented to the canvas's container so it
// overlays the canvas exactly. Inline styles only — we don't own index.html/css.
function ensureLabelWrap() {
  if (labelWrap || !canvas || !canvas.parentElement) return;
  labelWrap = document.createElement('div');
  labelWrap.className = 'proc-label-layer';
  labelWrap.style.cssText =
    'position:absolute;left:0;top:0;transform-origin:0 0;pointer-events:none;z-index:5;';
  canvas.parentElement.appendChild(labelWrap);
}

// A clean, LEGIBLE font (VT323 is the app's readable terminal face; ui-monospace
// as the system fallback). Readability beats retro here.
const NAME_FONT = "16px 'VT323', ui-monospace, monospace";
const REPO_FONT = "14px 'VT323', ui-monospace, monospace";

function statusColor(act) {
  return act === 'working' ? '#39d98a' : act === 'shell' ? '#ffb454' : '#5a6478';
}

// Position one name chip per agent (under its desk) and one repo label per
// cluster (in the clearance band above the pod). Reuses pooled nodes; hides any
// surplus from a previous, larger frame.
function syncLabels() {
  ensureLabelWrap();
  if (!labelWrap) return;
  // labelWrap's size + scale are owned by applyCam() (it scales with the camera,
  // matching the canvas). Here we only (re)position the child labels in buffer coords.

  // --- name chips (one per agent/cell) ---
  cells.forEach((cell, i) => {
    const a = cell.agent;
    const first = String(a.name || '').split(/\s+/)[0] || a.name || '—';
    let el = nameNodes[i];
    if (!el) {
      el = document.createElement('div');
      el.style.cssText =
        'position:absolute;transform:translateX(-50%);display:inline-flex;' +
        'align-items:center;gap:3px;max-width:62px;box-sizing:border-box;' +
        'padding:0 4px 0 3px;height:11px;white-space:nowrap;' +
        'background:rgba(14,20,32,0.92);border:1px solid rgba(255,255,255,0.18);' +
        'border-radius:4px;line-height:1;';
      const dot = document.createElement('span');
      dot.dataset.role = 'dot';
      dot.style.cssText = 'width:5px;height:5px;border-radius:50%;flex:0 0 auto;';
      const name = document.createElement('span');
      name.dataset.role = 'name';
      name.style.cssText =
        `font:${NAME_FONT};color:#eef3fb;line-height:1;` +
        'overflow:hidden;text-overflow:ellipsis;';
      el.appendChild(dot); el.appendChild(name);
      labelWrap.appendChild(el);
      nameNodes[i] = el;
    }
    el.style.display = 'inline-flex';
    // pin the chip just under the desk content, centred on the cell
    el.style.left = (cell.x + CELL_W / 2) + 'px';
    el.style.top = (cell.y + CELL_H - 10) + 'px';
    const dot = el.firstChild, name = el.lastChild;
    const col = statusColor(a.activity);
    dot.style.background = col;
    dot.style.boxShadow = a.activity === 'idle' ? 'none' : `0 0 4px ${col}`;
    name.textContent = first;
  });
  for (let i = cells.length; i < nameNodes.length; i++) nameNodes[i].style.display = 'none';

  // --- repo labels (one per cluster) ---
  clusters.forEach((c, i) => {
    let el = repoNodes[i];
    if (!el) {
      el = document.createElement('div');
      // "Sewn into the carpet": no chip background — cream thread-colored caps
      // with an embossed/stitched shadow + wide letter-spacing, sitting on the
      // rug's top strip so the team name reads as woven into the fabric.
      el.style.cssText =
        'position:absolute;transform:translateX(-50%);white-space:nowrap;' +
        "font:600 13px 'VT323', ui-monospace, monospace;letter-spacing:0.8px;" +
        'color:#f3ead2;text-align:center;' +
        'text-shadow:0 1px 0 rgba(0,0,0,0.55), 0 -1px 0 rgba(255,255,255,0.10);' +
        'overflow:hidden;text-overflow:ellipsis;box-sizing:border-box;';
      labelWrap.appendChild(el);
      repoNodes[i] = el;
    }
    el.style.display = 'block';
    // Allow the label to spill ~half the inter-cluster gap on each side so a
    // tiny (1-agent) rug doesn't ellipsis a readable name; neighbours are also
    // centred so the boxes meet at the gap midpoint without overlapping text.
    el.style.maxWidth = (c.w + CLUSTER_GAP_X) + 'px';
    el.style.left = (c.x + c.w / 2) + 'px';
    el.style.top = (c.y + 2) + 'px'; // on the rug's top strip
    el.textContent = String(c.project || '').toUpperCase();
  });
  for (let i = clusters.length; i < repoNodes.length; i++) repoNodes[i].style.display = 'none';
}

// ---- camera: pan / zoom / click-to-select -----------------------------------
// proc reuses the sheet office's existing `.world` wrapper (absolute, origin 0,0,
// the canvas's parent). Pan = a translate on `.world` so the canvas AND the DOM
// label group (both children of `.world`) move together. Zoom scales the canvas
// crisply via CSS width (a transform-scale on the canvas would blur it, per
// render.js) and the label group by a matching factor. A click (a press with no
// drag) hit-tests the desk cells and dispatches the same `agency:select` event
// the sheet renderer + chat panel already use.
let world = null;
let recenterBtn = null;           // shared #recenter button (CSS hides it until .show)
const cam = { x: 0, y: 0, s: 1 }; // s multiplies the UPSCALE base
let userMoved = false;            // once the user pans/zooms, stop auto-fitting
const clampN = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// Selection + hover, tracked by a STABLE key so the selection survives the 3s
// /api/state polls (the agent objects are replaced each poll). Mirrors render.js.
let selectedKey = null;           // the clicked desk (persistent highlight)
let hoverKey = null;              // the desk under the cursor (transient)
const keyOf = (a) => a ? (a.sessionId || (a.pid != null ? `pid:${a.pid}` : null)) : null;

function viewportRect() {
  const host = world && world.parentElement; // .floor-frame
  return host ? host.getBoundingClientRect() : { left: 0, top: 0, width: 800, height: 600 };
}

function applyCam() {
  if (!canvas) return;
  const eff = UPSCALE * cam.s;
  canvas.style.position = 'absolute';
  canvas.style.left = '0';
  canvas.style.top = '0';
  canvas.style.width = bufW * eff + 'px';   // crisp CSS-width zoom
  canvas.style.height = bufH * eff + 'px';
  if (labelWrap) {
    labelWrap.style.width = bufW + 'px';
    labelWrap.style.height = bufH + 'px';
    labelWrap.style.transformOrigin = '0 0';
    labelWrap.style.transform = `scale(${eff})`;
  }
  if (world) world.style.transform = `translate(${Math.round(cam.x)}px, ${Math.round(cam.y)}px)`;
  // CSS hides #recenter until .show; reveal it once the user has panned/zoomed
  // (mirrors render.js), so the affordance isn't permanently invisible in proc mode.
  if (recenterBtn) recenterBtn.classList.toggle('show', userMoved);
}

function clampPan() {
  const vp = viewportRect();
  const w = bufW * UPSCALE * cam.s, h = bufH * UPSCALE * cam.s;
  const KEEP = 80; // always keep at least this much office on-screen
  cam.x = clampN(cam.x, KEEP - w, vp.width - KEEP);
  cam.y = clampN(cam.y, KEEP - h, vp.height - KEEP);
}

// Fit the whole office into the floor-frame, centered. Capped at the native 3x
// so a small floor isn't over-magnified.
function fitView() {
  const vp = viewportRect();
  const fitS = Math.min(vp.width / (bufW * UPSCALE), vp.height / (bufH * UPSCALE));
  cam.s = clampN(fitS, 0.25, 1);
  const eff = UPSCALE * cam.s;
  cam.x = Math.max(0, Math.round((vp.width - bufW * eff) / 2));
  cam.y = Math.max(0, Math.round((vp.height - bufH * eff) / 2));
  applyCam();
}

function zoomAt(clientX, clientY, factor) {
  const vp = viewportRect();
  const pxp = clientX - vp.left, pyp = clientY - vp.top;
  const eff0 = UPSCALE * cam.s;
  const bx = (pxp - cam.x) / eff0, by = (pyp - cam.y) / eff0;
  cam.s = clampN(cam.s * factor, 0.25, 3);
  const eff1 = UPSCALE * cam.s;
  cam.x = pxp - bx * eff1;
  cam.y = pyp - by * eff1;
  userMoved = true;
  clampPan();
  applyCam();
}

// Map a screen point to a desk cell (or null). The canvas rect already reflects
// the CSS scale + world translate, so dividing by the effective scale gives
// buffer-space px.
function cellAt(clientX, clientY) {
  if (!canvas) return null;
  const rect = canvas.getBoundingClientRect();
  const eff = UPSCALE * cam.s;
  const bx = (clientX - rect.left) / eff, by = (clientY - rect.top) / eff;
  for (const cell of cells) {
    if (bx >= cell.x && bx <= cell.x + CELL_W && by >= cell.y && by <= cell.y + CELL_H) return cell;
  }
  return null;
}
const agentAt = (clientX, clientY) => { const c = cellAt(clientX, clientY); return c ? c.agent : null; };

// ---- hover affordance + tooltip --------------------------------------------
// Hovering a desk rings it (handled in draw via hoverKey) and pops a light DOM
// tooltip of what that agent is doing — render.js's hover-ring + info-card feel,
// kept minimal (name · project, activity, current task). All fields come from
// the agent object already in /api/state — no backend dependency.
let tooltip = null;
const ACTIVITY_TEXT = { working: 'shipping', shell: 'running a command', idle: 'idle' };
const escHtml = (s) => String(s == null ? '' : s).replace(/[&<>"]/g,
  (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function ensureTooltip() {
  if (tooltip) return;
  // position:fixed on <body> → viewport coords straight from getBoundingClientRect,
  // no offset-parent guesswork; pointer-events:none so it never eats clicks.
  tooltip = document.createElement('div');
  tooltip.className = 'proc-tooltip';
  tooltip.style.cssText =
    'position:fixed;z-index:30;pointer-events:none;transform:translateX(-50%);' +
    'padding:4px 7px;border-radius:5px;white-space:nowrap;' +
    'background:rgba(14,20,32,0.95);border:1px solid rgba(255,255,255,0.22);' +
    "font:14px 'VT323', ui-monospace, monospace;color:#eef3fb;line-height:1.25;" +
    'box-shadow:0 4px 14px rgba(0,0,0,0.45);display:none;';
  document.body.appendChild(tooltip);
}

function hideTooltip() { if (tooltip) tooltip.style.display = 'none'; }

function showTooltip(cell) {
  ensureTooltip();
  const a = cell.agent;
  const col = statusColor(a.activity);
  const act = ACTIVITY_TEXT[a.activity] || a.activity || 'idle';
  const task = a.task || a.chatName || a.lastPrompt || '';
  tooltip.innerHTML =
    `<div style="font-weight:600;letter-spacing:.3px">${escHtml(a.name)}` +
      `<span style="opacity:.55;font-weight:400"> · ${escHtml(a.project)}</span></div>` +
    '<div style="display:flex;align-items:center;gap:4px;margin-top:1px">' +
      `<span style="width:6px;height:6px;border-radius:50%;background:${col};` +
        `box-shadow:${a.activity === 'idle' ? 'none' : `0 0 5px ${col}`}"></span>` +
      `<span style="color:${col}">${escHtml(act)}</span></div>` +
    (task ? '<div style="opacity:.85;margin-top:1px;max-width:206px;overflow:hidden;' +
      `text-overflow:ellipsis">“${escHtml(task)}”</div>` : '');
  tooltip.style.display = 'block';
  // anchor above the desk (flip below if cramped), clamped to the viewport
  const rect = canvas.getBoundingClientRect();
  const eff = UPSCALE * cam.s;
  const cx = rect.left + (cell.x + CELL_W / 2) * eff;
  const topY = rect.top + cell.y * eff;
  const botY = rect.top + (cell.y + CELL_H) * eff;
  const tw = tooltip.offsetWidth, th = tooltip.offsetHeight;
  const left = clampN(cx, tw / 2 + 4, window.innerWidth - tw / 2 - 4);
  let top = topY - th - 8;
  if (top < 4) top = botY + 8;
  tooltip.style.left = Math.round(left) + 'px';
  tooltip.style.top = Math.round(top) + 'px';
}

// Recompute the hovered desk from a cursor point: update the cursor, the tooltip,
// and (only on change) the hover key + an immediate repaint so the ring tracks
// the cursor without waiting for the slow (~7.5fps) animation tick.
function updateHover(clientX, clientY) {
  const cell = cellAt(clientX, clientY);
  const k = cell ? keyOf(cell.agent) : null;
  if (canvas) canvas.style.cursor = cell ? 'pointer' : 'grab';
  if (k === hoverKey) return;
  hoverKey = k;
  if (cell) showTooltip(cell); else hideTooltip();
  draw();
}

// Attach pan/zoom/click once. A press that doesn't move is a click (select); a
// press that drags pans the floor. Trackpad: two-finger scroll pans, pinch (⌘
// /ctrl-wheel) zooms — matching the floor hint.
function attachInput() {
  if (!canvas || canvas.dataset.procInput) return;
  canvas.dataset.procInput = '1';
  let down = false, moved = 0, sx = 0, sy = 0;
  canvas.style.cursor = 'grab';
  canvas.addEventListener('mousedown', (e) => {
    down = true; moved = 0; sx = e.clientX; sy = e.clientY;
    canvas.style.cursor = 'grabbing';
    hoverKey = null; hideTooltip(); // dragging: drop the hover affordance
  });
  window.addEventListener('mousemove', (e) => {
    if (!down) { updateHover(e.clientX, e.clientY); return; } // not dragging → hover
    const dx = e.clientX - sx, dy = e.clientY - sy;
    moved += Math.abs(dx) + Math.abs(dy);
    cam.x += dx; cam.y += dy; sx = e.clientX; sy = e.clientY;
    userMoved = true; clampPan(); applyCam();
  });
  window.addEventListener('mouseup', (e) => {
    if (!down) return;
    down = false; canvas.style.cursor = 'grab';
    if (moved < 5) { // a clean tap selects; tapping the selected desk deselects
      const agent = agentAt(e.clientX, e.clientY);
      const k = keyOf(agent);
      selectedKey = (k && k === selectedKey) ? null : k;
      draw(); // paint the selection ring now — don't wait for the slow loop tick
      window.dispatchEvent(new CustomEvent('agency:select', { detail: { agent: selectedKey ? agent : null } }));
    }
    updateHover(e.clientX, e.clientY); // re-evaluate hover at rest
  });
  canvas.addEventListener('mouseleave', () => {
    if (hoverKey != null) { hoverKey = null; draw(); }
    hideTooltip(); canvas.style.cursor = 'grab';
  });
  const host = (world && world.parentElement) || canvas;
  host.addEventListener('wheel', (e) => {
    e.preventDefault();
    hideTooltip();
    if (e.ctrlKey || e.metaKey) { // pinch / ⌘ → zoom around the cursor
      // Magnitude-proportional zoom (ported from render.js:740-741). The old
      // fixed per-event factor felt hair-trigger on trackpads, which fire many
      // tiny wheel events; exp(-step·0.01) scales with gesture size. Normalize
      // line-mode (mouse wheel) deltas to px first. zoomAt still clamps the scale.
      const step = e.deltaMode !== 0 ? e.deltaY * 16 : e.deltaY;
      zoomAt(e.clientX, e.clientY, Math.exp(-step * 0.01));
    } else { // plain scroll → pan
      cam.x -= e.deltaX; cam.y -= e.deltaY;
      userMoved = true; clampPan(); applyCam();
    }
  }, { passive: false });
  recenterBtn = document.getElementById('recenter');
  if (recenterBtn) recenterBtn.addEventListener('click', () => { userMoved = false; fitView(); });
  window.addEventListener('resize', () => { if (!userMoved) fitView(); else { clampPan(); applyCam(); } });
}

// ---- scene -----------------------------------------------------------------
function draw() {
  ctx.clearRect(0, 0, bufW, bufH);
  drawWall(ctx, bufW, WALL_H, frame);
  drawFloor(ctx, bufW, TOP, bufH);
  drawDaylight(ctx, bufW, TOP, bufH);
  drawCeilingLights();
  drawDecor();
  drawClusterRugs();
  // cubicles (cells already in row-major order, so later rows overlap earlier).
  // Names + repo labels are DOM (see syncLabels), positioned on each setAgents().
  for (const cell of cells) {
    const a = cell.agent;
    const k = keyOf(a);
    const selected = k != null && k === selectedKey;
    const hovered = k != null && k === hoverKey && !selected;
    drawCubicle(ctx, cell.x, cell.y, a, frame, selected, hovered);
    if (a.role === 'lead') drawCrown(ctx, cell.x + CELL_W / 2 - 6, cell.y + 22, frame);
  }
}

// ---- public API ------------------------------------------------------------
// Drop-in entry matching render.js's initOffice(canvas, labels) so app.js can
// pick this module behind ?render=proc. Starts empty; the /api/state poll feeds
// real agents via setAgents. (labels is render.js's HTML overlay element; proc
// draws all text on-canvas, so it's ignored.)
// ponytail: no click-to-select in proc mode yet — agency:select is dispatched by
// render.js on canvas clicks; add a hit-test here when proc graduates from flag.
export function initOffice(canvasEl, _labels) {
  // Only wire up canvas/ctx — DON'T paint anything yet. Painting an empty,
  // furnished room before the first /api/state poll arrives caused a visible
  // "load flash" (a fully-built office with zero agents flickering in before the
  // real data). The animation loop starts on the first setAgents() call instead,
  // so the first painted frame already reflects real agent data (or an
  // intentionally-empty room when the poll genuinely reports zero agents).
  // (_labels is the shared sheet-office #labels element; proc owns its own DOM
  // label group instead — see ensureLabelWrap — so the two renderers don't clash.)
  canvas = canvasEl;
  ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = false;
  world = canvas.parentElement; // the .world wrapper (absolute, transform-origin 0,0)
  attachInput();                // pan / zoom / click-to-open-chat
}

export function init(canvasEl, n, seed) {
  canvas = canvasEl;
  ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = false;
  setAgents(makeAgents(n, seed));
}

let started = false;
export function setAgents(next) {
  // Group same-project agents together so each project is one contiguous run
  // (clusterRuns → one rug, one label per team) no matter what order /api/state
  // returns them in. Stable + alphabetical: deterministic across polls so teams
  // don't reshuffle as agents come and go. ponytail: project name only — the
  // floor labels by project, so that's the unit a "team" reads as.
  agents = (next || []).slice().sort((a, b) =>
    String(a.project || '').localeCompare(String(b.project || '')));
  plan();
  canvas.width = bufW;
  canvas.height = bufH;
  canvas.style.width = bufW * UPSCALE + 'px';   // crisp CSS upscale
  canvas.style.height = bufH * UPSCALE + 'px';
  ctx.imageSmoothingEnabled = false;
  draw(); // repaint now — setting canvas.width cleared it; don't wait for the slow loop tick (avoids a blank frame each poll)
  syncLabels(); // (re)position the DOM name + repo labels for the new layout
  // Size/position the camera: fit-to-view until the user pans/zooms, then respect
  // their view (just re-apply, since bufW/bufH may have changed with agent count).
  if (!userMoved) fitView(); else applyCam();
  if (!started) { started = true; loop(); } // first data → kick off the animation loop
}

let raf, timer;
function loop() {
  frame++;
  draw();
  raf = requestAnimationFrame(() => {
    if (!started) return;            // cancelled (reset) while the RAF was pending
    timer = setTimeout(loop, 130);   // ~7.5fps pixel cadence
  });
}

export function reset(n, seed) {
  cancelAnimationFrame(raf);
  clearTimeout(timer);               // kill the tick the RAF may have already scheduled
  started = false;                   // makes a pending RAF callback bail instead of rescheduling
  userMoved = false;                 // re-fit the fresh layout
  setAgents(makeAgents(n, seed));
}

// expose for the harness
window.__office = { init, reset };
