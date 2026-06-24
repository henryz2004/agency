// office.js — the fully-procedural office (the app's sole renderer): lays mock
// agents into project desk clusters interleaved with cozy decor zones (lounge,
// meeting table, kitchen counter, plant beds, pets), then composites the whole
// scene. Renders into a buffer canvas that the page scales up crisply.

import { makeAgents } from './mock-agents.js';
import {
  px, shade, hashInt, rng,
  drawWall, drawFloor, drawDaylight, moodForHour,
  drawCubicle, drawCrown, drawNeedsYou, drawWalker, CELL_W, CELL_H,
} from './sprites.js';
import { createAvatar } from './avatar.js';

const WALL_H = 70;                 // cream wall band; fills from the top of canvas
const TOP = WALL_H;                // floor starts here (no sky)
const MARGIN = 16;
const CLUSTER_PAD = 6;             // inset around a cluster's cells
const HEADER_H = 14;               // repo-label clearance atop each cluster (DOM tab sits here)
const GAP_X = 16;                  // gap between blocks on a row
const GAP_Y = 20;                  // gap between rows
const UPSCALE = 3;                 // canvas is CSS-scaled this much; the DOM label layer matches

let canvas, ctx, bufW = 0, bufH = 0, frame = 0;
let agents = [];
let clusters = [];   // {x, y, w, h, count, firstAgent, project, seed}
let decor = [];      // {type, x, y, w, h, seed}
let cells = [];      // {x, y, agent} — flattened, in draw order

// ---- floor entities: the walkable user avatar + a wandering cat -------------
let avatar = null;                  // the player (created in initOffice, off by default)
let lastT = 0;                      // last loop timestamp → real dt for motion
let walkBtn = null, walkHint = null; // on-screen walk-mode affordances (built in JS)
let nameBtn = null;                  // on-screen nametag-visibility toggle
let labelsHidden = false;            // hide all agent name chips when true ('n' / button)
// roaming pet: dir +1 faces right; sit→sleep when it rests a while; `petted` is
// set while the walking avatar is right next to it (→ wakes + hearts in drawCat).
const cat = { x: 0, y: 0, tx: 0, ty: 0, sit: true, until: 0, init: false, dir: 1, sleeping: false, petted: false };
// the dog lounges in a fixed spot but is PETTABLE like the cat (walk up → hearts);
// a floor entity so it z-sorts + animates. Position set in layout().
const dog = { x: 0, y: 0, init: false, petted: false };
if (typeof window !== 'undefined') { window.__cat = cat; window.__dog = dog; } // reel hooks: frame/control the pets
// Idle-wander: settled-idle workers leave their desk and amble around the floor —
// to a JITTERED point inside a lounge/kitchen zone (so they spread out instead of
// stacking on a fixed spot), often hopping between spots before heading home, and
// rushing back fast when resumed. Per-agent state keyed by keyOf(agent); each tick
// re-syncs the agent's home to its (possibly re-laid) desk.
const wanderers = new Map(); // key -> { phase, x, y, tx, ty, until, homeX, homeY, speed, rush, legDist }
let wanderZones = [];        // [{x, y, w, h}] destination zones (lounge / meeting / plants / kitchen)

// DOM overlay layer: real (crisp) HTML text for the name chips + repo labels,
// instead of canvas pixel text. One wrapper div over the canvas, scaled by
// UPSCALE so children are positioned in BUFFER coordinates (matching the canvas
// art); a future camera can transform this one wrapper as a group.
let labelWrap = null;        // the single group wrapper
const nameNodes = [];        // pooled name-chip elements, reused between frames
const repoNodes = [];        // pooled repo-label elements, reused between frames
const leadNodes = [];        // pooled "▸ leadName" captions tying teammates to a lead

// ---- layout ----------------------------------------------------------------

function clusterDims(count) {
  // Lay a team's desks as a LANDSCAPE block (wider than tall) so a big team grows
  // SIDEWAYS instead of into a tall column. A cell is 58w×78h (taller than wide),
  // so to read landscape we need cols well above rows: cols ≈ √(count · 2.4).
  const cols = Math.min(count, Math.max(1, Math.ceil(Math.sqrt(count * 2.4))));
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
const AMENITY_BAND_H = 16;
// Target bullpen aspect (width:height). >1 packs the desk clusters LANDSCAPE so
// the floor fills a desktop viewport instead of a tall portrait column. Biased
// well above 1 because the fixed amenity + lounge bands add height the bullpen
// must out-widen. Tuned by eye against the floor-frame.
const LANDSCAPE_ASPECT = 2.6;

function plan() {
  clusters = []; decor = []; cells = [];
  const runs = clusterRuns(agents);

  // --- size each cluster, then pick a columns-per-row that keeps the bullpen
  // roughly landscape (wider than tall) without overflowing a sane width. ---
  const sized = runs.map((run, ci) => {
    const d = clusterDims(run.count);
    return { count: run.count, project: run.project, firstAgent: run.start, w: d.w, h: d.h, dims: d, seed: 101 + ci * 7 };
  });
  // --- LANDSCAPE packing: wrap rows at a TARGET WIDTH derived from total cluster
  // area × the aspect bias, so the bullpen reads wider-than-tall and fills a
  // desktop viewport instead of a narrow column. Adapts to any team count: few
  // teams → one wide row; many → a wide grid. The widest cluster sets a floor so
  // a single big team never overflows its own row. ---
  const bx0 = MARGIN, by0 = TOP + AMENITY_BAND_H;
  const totalArea = sized.reduce((s, b) => s + (b.w + CLUSTER_GAP_X) * b.h, 0);
  const widest = sized.reduce((m, b) => Math.max(m, b.w), 0);
  const targetRowW = Math.max(widest, Math.sqrt(totalArea * LANDSCAPE_ASPECT));

  let rowW = 0, rowTopH = 0;
  let cx = bx0, cy = by0;
  const rows = [[]];
  sized.forEach((b) => {
    // wrap once the current row has REACHED the target width (the triggering
    // cluster overhangs, which packs rows wider → more landscape). Greedy by
    // width, not by a fixed cluster count.
    if (rows[rows.length - 1].length && (cx - bx0) >= targetRowW) {
      cy += rowTopH + CLUSTER_GAP_Y;
      cx = bx0; rowTopH = 0; rows.push([]);
    }
    b.x = cx; b.y = cy;
    rows[rows.length - 1].push(b);
    cx += b.w + CLUSTER_GAP_X;
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

  // --- DECOR PLACEMENT: the room HUGS its content so there's no cavern of dead floor.
  // Two regimes by floor size:
  //   SNUG (≤4 desks): desks high under the wall + a plant bed in each upper corner —
  //     a small office, not a hall.
  //   FULL (>4 desks): desks high + ONE coherent lounge band directly below them +
  //     a kitchen against the wall. Compact; no scattered fill.
  // The camera (fitView) centres on the desks, so a compact/portrait room still frames
  // them well, and the soft zoom-out lets you pull back to the whole floor.
  const nAgents = cells.length;
  const minRoomW = 320;

  if (nAgents <= 4) {
    // ---- SNUG: a cozy small office — desks high under the wall, a plant bed in each
    // UPPER CORNER tucked against the back wall (head-on, so it overlaps the wall's
    // base) instead of at desk height where it clipped the rug. ----
    const flankW = nAgents <= 2 ? 40 : 52; // slim flanks for 1–2 desks
    const gap = 10;
    bufW = rowW + 2 * (flankW + gap) + MARGIN * 2;
    bufH = bullpenBottom + 16 + MARGIN;
    clusters.forEach((c) => { c.x += flankW + gap; });
    cells.forEach((c) => { c.x += flankW + gap; });
    // a plant bed in each upper corner, standing AGAINST the wall (overlaps its base)
    decor.push({ type: 'plants', x: MARGIN, y: TOP - 6, w: flankW, h: 44, seed: hashInt('pl') });
    decor.push({ type: 'plants', x: bufW - MARGIN - flankW, y: TOP - 6, w: flankW, h: 44, seed: hashInt('pr') });
    dog.x = bufW - MARGIN - flankW / 2; dog.y = bullpenBottom - 4; dog.init = true;
  } else {
    // ---- FULL: desks high under the wall + ONE coherent lounge band directly below.
    // The room HUGS (desks + lounge) — no cavern of dead floor, and the decor reads as
    // a single sensible lounge instead of furniture scattered across an empty hall.
    bufW = Math.max(minRoomW, rowW + MARGIN * 2);
    // centre the bullpen horizontally
    const bullShift = Math.round((bufW - MARGIN * 2 - rowW) / 2);
    if (bullShift > 0) {
      clusters.forEach((c) => { c.x += bullShift; });
      cells.forEach((c) => { c.x += bullShift; });
    }

    // one lounge band beneath the desks: grouped, coherent pieces (couch+table,
    // meeting table, plant beds) scaled to the floor width.
    const bandY = bullpenBottom + 10;
    const floorW = bufW - MARGIN * 2;
    const wOf = (t) => (t === 'lounge' ? 104 : t === 'meeting' ? 96 : 44);
    const pieces = floorW > 560 ? ['plants', 'lounge', 'meeting', 'lounge', 'plants']
      : floorW > 380 ? ['plants', 'lounge', 'meeting', 'plants']
        : floorW > 230 ? ['lounge', 'plants']
          : ['lounge'];
    const used = pieces.reduce((s, t) => s + wOf(t), 0);
    const gap = pieces.length > 1 ? Math.max(16, (floorW - used) / (pieces.length - 1)) : 0;
    let lx = MARGIN + Math.max(0, (floorW - used - gap * (pieces.length - 1)) / 2);
    pieces.forEach((t) => {
      decor.push({ type: t, x: Math.round(lx), y: bandY, w: wOf(t), h: LOUNGE_BAND_H, seed: hashInt('b' + lx) });
      lx += wOf(t) + gap;
    });

    bufH = bandY + LOUNGE_BAND_H + MARGIN;
    // kitchen counter tucked UP against the back wall, far right (base above the desk
    // line so it never dips into a team rug)
    decor.push({ type: 'kitchen', x: bufW - 84, y: TOP - 12, w: 78, h: 26, seed: 999 });
    // the dog naps at the end of the lounge band
    dog.x = bufW - MARGIN - 30; dog.y = bandY + LOUNGE_BAND_H - 4; dog.init = true;
  }

  // idle-wander destination ZONES: the lounge spots (couch / meeting / plants) plus
  // the kitchen/vending bar, so workers actually visit the amenities. Stored as
  // zones — updateWanderers picks a JITTERED point inside one, so workers spread
  // out instead of stacking on a fixed point. (Empty floor → none → everyone stays.)
  wanderZones = decor
    .filter((z) => z.type === 'lounge' || z.type === 'meeting' || z.type === 'plants' || z.type === 'kitchen')
    .map((z) => ({ x: z.x, y: z.y, w: z.w, h: z.h, kind: z.type }));

  // focal point = centre of the desk bullpen, so fitView() frames the desks on any
  // room shape (not the empty back wall).
  if (clusters.length) {
    let minx = Infinity, maxx = -Infinity, miny = Infinity, maxy = -Infinity;
    clusters.forEach((c) => {
      minx = Math.min(minx, c.x); maxx = Math.max(maxx, c.x + c.w);
      miny = Math.min(miny, c.y); maxy = Math.max(maxy, c.y + c.h);
    });
    focusBX = (minx + maxx) / 2; focusBY = (miny + maxy) / 2;
  } else { focusBX = bufW / 2; focusBY = bufH / 2; }
}

// ---- decor drawing ---------------------------------------------------------

function drawDecor() {
  for (const z of decor) {
    if (z.type === 'lounge') drawLounge(z);
    else if (z.type === 'meeting') drawMeeting(z);
    else if (z.type === 'plants') drawPlants(z);
    else if (z.type === 'kitchen') drawKitchen(z);
    // (the cat + dog are floor entities now — drawn in the actor loop, not as decor)
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
  // two-seat couch on the left, FRONT-FACING (tall backrest at the back, seat
  // cushions toward the viewer, arms framing the sides) so it reads as a sofa you
  // sit into — not an ambiguous top-down slab.
  const couchCols = ['#d9694f', '#5d9ce0', '#5dc98a', '#a87de0'];
  const couch = couchCols[hashInt('couch' + z.seed) % couchCols.length];
  const lite = shade(couch, 20), dark = shade(couch, -22), arm = shade(couch, -8);
  const cxx = rx + 4, cyy = floorY - 16;
  // backrest (tall block at the back)
  px(ctx, cxx + 3, cyy - 8, 30, 9, couch);
  px(ctx, cxx + 3, cyy - 8, 30, 1, lite);           // top highlight
  px(ctx, cxx + 17, cyy - 7, 1, 7, dark);           // back split between the seats
  // seat cushions in front of the backrest
  px(ctx, cxx, cyy + 1, 36, 7, couch);
  px(ctx, cxx, cyy + 1, 36, 1, lite);               // cushion top edge
  px(ctx, cxx + 17, cyy + 1, 1, 7, dark);           // seam between the two seats
  // front base / skirt + little feet
  px(ctx, cxx + 2, cyy + 8, 32, 2, dark);
  px(ctx, cxx + 3, cyy + 10, 2, 2, '#2c2018');
  px(ctx, cxx + 31, cyy + 10, 2, 2, '#2c2018');
  // arms framing the seat (a touch taller than the cushions)
  px(ctx, cxx - 2, cyy - 5, 5, 14, arm);
  px(ctx, cxx + 33, cyy - 5, 5, 14, arm);
  px(ctx, cxx - 2, cyy - 5, 5, 1, lite);
  px(ctx, cxx + 33, cyy - 5, 5, 1, lite);
  // a throw pillow on the left cushion
  px(ctx, cxx + 4, cyy + 2, 7, 5, '#f4d35e');
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
  // a low wood planter box with plants TILED across it, so a wide bed reads as a
  // full planter — not two lonely plants at the ends with an empty box between.
  const bx = z.x + 2, bw = z.w - 4, by = floorY - 6;
  px(ctx, bx, by, bw, 7, '#6f4d2b');
  px(ctx, bx, by, bw, 2, '#8a6238');
  px(ctx, bx, by + 6, bw, 1, '#5a3d22');
  const slot = 14;                            // a single plant's footprint
  const n = Math.max(1, Math.floor(bw / 18)); // ~one plant per 18px of box
  const gap = n > 1 ? (bw - n * slot) / (n - 1) : 0;
  const x0 = bx + (n > 1 ? 0 : (bw - slot) / 2); // centre a lone plant
  for (let i = 0; i < n; i++) {
    drawPlant(ctx, Math.round(x0 + i * (slot + gap)), floorY - (i % 2 ? 1 : 5));
  }
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

function drawCat(x, y, frame, dir = 1, opts = {}) {
  x = Math.round(x); y = Math.round(y);
  const { sleeping = false, petted = false } = opts;
  const body = '#23252c';
  // The art faces right; mirror about the body centre (~x+5) to face left so the
  // cat walks the way it's heading instead of moonwalking backwards.
  const flip = dir < 0;
  if (flip) { ctx.save(); ctx.translate((x + 5) * 2, 0); ctx.scale(-1, 1); }
  if (sleeping) {
    // curled up, lower profile, eyes shut, slow breathing; a "z" drifts above.
    const br = frame % 16 < 8 ? 0 : 1;               // slow breathe
    px(ctx, x, y - 4 - br, 11, 4 + br, body);        // curled body (wider + lower)
    px(ctx, x + 7, y - 5 - br, 5, 4, body);          // tucked head
    px(ctx, x + 8, y - 7 - br, 2, 2, body);          // one folded ear
    px(ctx, x + 8, y - 3 - br, 2, 1, '#3a3d45');     // closed eye (a line)
    px(ctx, x - 1, y - 1, 6, 1, body);               // tail wrapped round the front
    const zz = '#9aa3b5', zy = y - 11 - (frame % 8 < 4 ? 0 : 1); // "z" bobs slowly
    px(ctx, x + 12, zy, 3, 1, zz); px(ctx, x + 13, zy + 1, 1, 1, zz); px(ctx, x + 12, zy + 2, 3, 1, zz);
  } else {
    const tail = frame % 8 < 4 ? 0 : 1;
    px(ctx, x, y - 6, 8, 6, body);        // body
    px(ctx, x + 6, y - 11, 6, 6, body);   // head
    px(ctx, x + 6, y - 13, 2, 3, body);   // ears
    px(ctx, x + 10, y - 13, 2, 3, body);
    px(ctx, x + 8, y - 9, 1, 1, '#6cff9a'); // eyes
    px(ctx, x + 10, y - 9, 1, 1, '#6cff9a');
    if (petted) px(ctx, x - 2, y - 12, 2, 7, body);  // happy upright tail
    else px(ctx, x - 2, y - 8 - tail, 2, 6, body);   // lazy tail flick
    px(ctx, x + 1, y, 1, 1, body); px(ctx, x + 5, y, 1, 1, body); // paws
  }
  if (flip) ctx.restore();
  // petting hearts float up over the cat (drawn UNflipped so they read upright).
  if (petted) {
    const hx = x + 3, hy = y - 16 - (frame % 6), pink = '#ff6b9d';
    px(ctx, hx, hy, 1, 1, pink); px(ctx, hx + 2, hy, 1, 1, pink);
    px(ctx, hx - 1, hy + 1, 5, 1, pink);
    px(ctx, hx, hy + 2, 3, 1, pink);
    px(ctx, hx + 1, hy + 3, 1, 1, pink);
  }
}

function drawDog(ctx, x, y, opts = {}) {
  const { frame = 0, petted = false } = opts;
  px(ctx, x, y - 5, 12, 5, '#d98a4a');   // body
  px(ctx, x + 10, y - 9, 6, 6, '#d98a4a'); // head
  px(ctx, x + 9, y - 10, 2, 4, '#b5702e');  // ear
  px(ctx, x + 14, y - 6, 1, 1, '#1b1b22');  // eye
  px(ctx, x + 16, y - 5, 2, 1, '#1b1b22');  // snout
  // wagging tail (back/left). Idle: a gentle 1px lift on a slow cadence.
  // Petted: a faster, bigger 2px sweep — the happy wag.
  const wag = petted ? (frame % 4 < 2 ? 0 : 2) : (frame % 8 < 4 ? 0 : 1);
  px(ctx, x - 3, y - 6 - wag, 4, 2, '#e09a5a');   // tail
  px(ctx, x + 8, y - 5, 4, 3, '#fff');      // white belly patch
  px(ctx, x + 1, y, 1, 1, '#b5702e'); px(ctx, x + 9, y, 1, 1, '#b5702e'); // paws
  // petting heart floats up over the dog's head (same pink pixel heart as the cat).
  if (petted) {
    const hx = x + 12, hy = y - 16 - (frame % 6), pink = '#ff6b9d';
    px(ctx, hx, hy, 1, 1, pink); px(ctx, hx + 2, hy, 1, 1, pink);
    px(ctx, hx - 1, hy + 1, 5, 1, pink);
    px(ctx, hx, hy + 2, 3, 1, pink);
    px(ctx, hx + 1, hy + 3, 1, 1, pink);
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
// Name chips + repo labels are HTML, not canvas pixels — sharp DOM text scaled
// by the camera, which is far more legible than any bitmap font at this buffer
// resolution. The wrapper is sized
// in BUFFER coords and scaled by UPSCALE, so node positions reuse the same
// cell/cluster coords the canvas art uses. Nodes are pooled and reused between
// updates so nothing leaks. A future camera can transform `labelWrap` as a group.

// Build (once) the group wrapper, parented to the canvas's container so it
// overlays the canvas exactly. Inline styles only — we don't own index.html/css.
function ensureLabelWrap() {
  if (labelWrap || !canvas || !canvas.parentElement) return;
  // inject the "just finished / unread" glow keyframe once (scoped <style>; we
  // don't own css). A calm CYAN breathe on the whole name chip — matches the
  // topbar's cyan "new for you" language and the wave the worker does; replaces
  // the old hot-magenta corner pip.
  if (!document.getElementById('proc-kf')) {
    const s = document.createElement('style');
    s.id = 'proc-kf';
    s.textContent =
      '@keyframes procUnreadGlow{0%,100%{box-shadow:0 0 4px 1px rgba(92,208,255,0.5)}' +
      '50%{box-shadow:0 0 10px 3px rgba(92,208,255,0.85)}}';
    document.head.appendChild(s);
  }
  labelWrap = document.createElement('div');
  labelWrap.className = 'proc-label-layer';
  labelWrap.style.cssText =
    'position:absolute;left:0;top:0;transform-origin:0 0;pointer-events:none;z-index:5;';
  canvas.parentElement.appendChild(labelWrap);
}

// Floor label face: IBM Plex Mono (clean, readable mono) for names/teams, small —
// the pixel identity lives in the art + Press Start 2P headers/numbers, not body text.
const NAME_FONT = "7px 'IBM Plex Mono', ui-monospace, monospace";
const REPO_FONT = "9px 'IBM Plex Mono', ui-monospace, monospace";

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
        'align-items:center;gap:2px;max-width:58px;box-sizing:border-box;' +
        'padding:0 3px 0 2px;height:8px;white-space:nowrap;' +
        'background:rgba(14,20,32,0.9);border:1px solid rgba(255,255,255,0.16);' +
        'border-radius:3px;line-height:1;';
      const dot = document.createElement('span');
      dot.dataset.role = 'dot';
      dot.style.cssText = 'width:3px;height:3px;border-radius:50%;flex:0 0 auto;';
      const name = document.createElement('span');
      name.dataset.role = 'name';
      name.style.cssText =
        `font:${NAME_FONT};color:#eef3fb;line-height:1;` +
        'overflow:hidden;text-overflow:ellipsis;';
      // "just finished / unread" is shown as a cyan glow on the whole chip (see
      // syncLabels below) + a wave from the worker — no separate corner badge.
      el.appendChild(dot); el.appendChild(name);
      labelWrap.appendChild(el);
      nameNodes[i] = el;
    }
    el.style.display = (labelsHidden || a.placeholder) ? 'none' : 'inline-flex';
    if (a.placeholder) return; // a vacant desk has no name chip
    // Pin the chip: FOLLOW a wandering worker, else sit under the desk. This
    // per-poll pass uses the SAME rule as the per-frame draw(), so the chip never
    // flickers back to the desk for a frame when a poll lands mid-stroll.
    const w = wanderers.get(keyOf(a));
    if (w && w.phase !== 'seated') { el.style.left = Math.round(w.x) + 'px'; el.style.top = Math.round(w.y - 46) + 'px'; }
    else { el.style.left = (cell.x + CELL_W / 2) + 'px'; el.style.top = (cell.y + CELL_H - 10) + 'px'; }
    const dot = el.firstChild, name = el.children[1];
    const col = statusColor(a.activity);
    dot.style.background = col;
    dot.style.boxShadow = a.activity === 'idle' ? 'none' : `0 0 4px ${col}`;
    name.textContent = first;
    // unread = agent just finished + not yet viewed (app.js owns the set). Shown
    // as a cyan glow on the chip (the worker also waves, see drawCubicle/unread).
    const unread = !!(a.sessionId && window.agencyUnread && window.agencyUnread.has(a.sessionId));
    el.style.borderColor = unread ? 'rgba(92,208,255,0.85)' : 'rgba(255,255,255,0.18)';
    el.style.animation = unread ? 'procUnreadGlow 1.8s ease-in-out infinite' : 'none';
  });
  for (let i = cells.length; i < nameNodes.length; i++) nameNodes[i].style.display = 'none';

  // --- repo labels (one per cluster) ---
  clusters.forEach((c, i) => {
    let el = repoNodes[i];
    if (!el) {
      el = document.createElement('div');
      // "Stamped INTO the carpet": a DEBOSSED label, not text floating on top. The
      // glyphs are a dark recess (semi-transparent black, so it darkens whatever rug
      // tone it sits on) with a 1px light lower lip — the classic engraved/letterpress
      // cue, so the team name reads as pressed into the fabric. Lowercase + trailing
      // slash so it reads plainly as the folder.
      el.style.cssText =
        'position:absolute;transform:translateX(-50%);white-space:nowrap;' +
        "font:600 7px 'IBM Plex Mono', ui-monospace, monospace;letter-spacing:0.2px;" +
        'color:rgba(232,224,205,0.66);text-align:center;' +
        'text-shadow:0 1px 2px rgba(0,0,0,0.6);' +
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
    const proj = String(c.project || '');
    el.textContent = proj ? proj + '/' : '';
  });
  for (let i = clusters.length; i < repoNodes.length; i++) repoNodes[i].style.display = 'none';

  // --- teammate → lead tie: a small "▸ leadName" caption just under a teammate's
  // chip so a sub-agent reads as "X's helper", not a peer (pm1 sets kind/leadName). ---
  cells.forEach((cell, i) => {
    const a = cell.agent;
    const tie = a.kind === 'teammate' && a.leadName ? '↳ ' + a.leadName + "'s helper" : '';
    let el = leadNodes[i];
    if (!el) {
      el = document.createElement('div');
      el.style.cssText =
        'position:absolute;transform:translateX(-50%);white-space:nowrap;' +
        "font:8px 'IBM Plex Mono', ui-monospace, monospace;color:#9fb3cf;" +
        'text-shadow:0 1px 2px rgba(0,0,0,0.65);';
      labelWrap.appendChild(el);
      leadNodes[i] = el;
    }
    if (!tie) { el.style.display = 'none'; return; }
    el.style.display = 'block';
    el.textContent = tie;
    el.style.left = (cell.x + CELL_W / 2) + 'px';
    el.style.top = (cell.y + CELL_H + 1) + 'px'; // just beneath the name chip
  });
  for (let i = cells.length; i < leadNodes.length; i++) leadNodes[i].style.display = 'none';

  syncHiddenChip();
}

// A small floor control showing how many desks the user has hidden, toggling
// them back into view. The hidden STATE is owned by app.js (agent.hidden); proc
// just collapses them by default and offers a local reveal (no poll needed —
// rebuild() re-filters lastAll). Anchored to the floor-frame, not the scaled
// label layer, so it stays a crisp, fixed-size control.
let hiddenChip = null;
function syncHiddenChip() {
  const host = world && world.parentElement;
  if (!host) return;
  if (!hiddenChip) {
    hiddenChip = document.createElement('button');
    hiddenChip.type = 'button';
    hiddenChip.style.cssText =
      'position:absolute;left:12px;top:12px;z-index:8;cursor:pointer;' +
      'appearance:none;-webkit-appearance:none;outline:none;' +
      'padding:3px 9px;border-radius:11px;white-space:nowrap;' +
      'background:rgba(14,20,32,0.9);border:1px solid rgba(255,255,255,0.22);' +
      "font:11px 'IBM Plex Mono', ui-monospace, monospace;color:#cdd8ea;letter-spacing:.3px;";
    hiddenChip.addEventListener('click', () => { showHidden = !showHidden; rebuild(); });
    host.appendChild(hiddenChip);
  }
  // count emptied → also drop the reveal flag, else a future hide would stay
  // visible with no chip to re-collapse it (the chip is gone at count 0).
  if (!hiddenCount) { showHidden = false; hiddenChip.style.display = 'none'; return; }
  hiddenChip.style.display = 'inline-block';
  hiddenChip.textContent = showHidden
    ? `▾ hide ${hiddenCount} hidden`
    : `▸ ${hiddenCount} away · show`;
}

// ---- camera: pan / zoom / click-to-select -----------------------------------
// The office uses a `.world` wrapper (absolute, origin 0,0, the canvas's parent).
// Pan = a translate on `.world` so the canvas AND the DOM label group (both
// children of `.world`) move together. Zoom scales the canvas crisply via CSS
// width (a transform-scale on the canvas would blur it) and the label group by a
// matching factor. A click (a press with no drag) hit-tests the desk cells and
// dispatches the `agency:select` event the chat panel listens for.
let world = null;
let recenterBtn = null;           // shared #recenter button (CSS hides it until .show)
const cam = { x: 0, y: 0, s: 1 }; // s multiplies the UPSCALE base
let focusBX = 0, focusBY = 0;     // centre of the desk bullpen (the default camera focus)
let userMoved = false;            // once the user pans/zooms, stop auto-fitting
let reservedRight = 0;            // px reserved on the right for the hovering panel
const clampN = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// ui.js calls this when the stats panel opens/closes/resizes so the office fits
// in the free area LEFT of the panel (0 when collapsed). fitView() subtracts it
// from the available width; re-fit unless the user has taken over the camera.
export function setReservedRight(px) {
  reservedRight = Math.max(0, px || 0);
  if (!canvas) return; // office not initialized yet
  // Don't re-fit during a walk (it would reset cam.s and drop the immersive zoom);
  // just re-confine to the new available width. Mirrors the guard in the loop.
  if (!userMoved && !(avatar && avatar.enabled)) fitView();
  else { clampPan(); applyCam(); }
}

// Selection + hover, tracked by a STABLE key so the selection survives the 3s
// /api/state polls (the agent objects are replaced each poll).
let selectedKey = null;           // the clicked desk (persistent highlight)
let hoverKey = null;              // the desk under the cursor (transient)
let lastInspectAgent = null;      // agent the avatar is walking past (E opens it)
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
  // translate3d (not translate) forces a GPU compositor layer so the camera
  // follow glides; rounding keeps the pixel art crisp under the 3x CSS upscale.
  if (world) world.style.transform = `translate3d(${Math.round(cam.x)}px, ${Math.round(cam.y)}px, 0)`;
  // CSS hides #recenter until .show; reveal it once the user has panned/zoomed
  // so the affordance isn't permanently invisible.
  if (recenterBtn) recenterBtn.classList.toggle('show', userMoved);
  positionOverlays(); // re-pin tooltip/card so they track pan/zoom/follow immediately
}

// The camera always CONFINES the office to the visible floor (the area left of the
// hovering panel) so we never see void around it — in walk mode AND free pan/zoom.
// Centres the office on an axis where it's smaller than the frame.
function clampPan() {
  const vp = viewportRect();
  const availW = Math.max(40, vp.width - reservedRight);
  const w = bufW * UPSCALE * cam.s, h = bufH * UPSCALE * cam.s;
  cam.x = w >= availW ? clampN(cam.x, availW - w, 0) : Math.round((availW - w) / 2);
  cam.y = h >= vp.height ? clampN(cam.y, vp.height - h, 0) : Math.round((vp.height - h) / 2);
}

// The COVER fit — the zoom at which the office FILLS the visible floor on BOTH axes,
// cropping the longer one. This is the DEFAULT framing (a full, no-void view).
// Capped at native 3x so a tiny floor isn't blown up absurdly.
function coverScale() {
  const vp = viewportRect();
  const availW = Math.max(40, vp.width - reservedRight);
  return clampN(Math.max(availW / (bufW * UPSCALE), vp.height / (bufH * UPSCALE)), 0.05, 3);
}

// The CONTAIN fit — the zoom at which the WHOLE office is visible (the smaller of the
// two ratios → limited by the office's LARGER dimension), with void around the short
// axis. This is the soft zoom-OUT floor: from the cover default you can keep pulling
// back past it (×0.85 leaves a little breathing margin) until the entire floor fits,
// instead of being hard-stopped at cover. clampPan centres the office in the void.
function containScale() {
  const vp = viewportRect();
  const availW = Math.max(40, vp.width - reservedRight);
  return clampN(Math.min(availW / (bufW * UPSCALE), vp.height / (bufH * UPSCALE)) * 0.85, 0.04, 3);
}

// Default view = the cover fit, CENTRED ON THE DESKS. Centering on the bullpen (not
// the buffer's top-left) means a tall/portrait small office frames the desks in the
// middle of the screen instead of pinning the empty back wall to the top and cropping
// the desks off the bottom. clampPan still prevents any void.
function fitView() {
  cam.s = coverScale();
  const vp = viewportRect();
  const availW = Math.max(40, vp.width - reservedRight);
  const eff = UPSCALE * cam.s;
  cam.x = availW / 2 - focusBX * eff;
  cam.y = vp.height / 2 - focusBY * eff;
  clampPan();
  applyCam();
}

function zoomAt(clientX, clientY, factor) {
  const vp = viewportRect();
  const pxp = clientX - vp.left, pyp = clientY - vp.top;
  const eff0 = UPSCALE * cam.s;
  const bx = (pxp - cam.x) / eff0, by = (pyp - cam.y) / eff0;
  // zoom-out floor is the CONTAIN fit (whole office visible), not cover — so you can
  // pull back to see the entire floor instead of being hard-stopped at the fill view.
  cam.s = clampN(cam.s * factor, containScale(), 3);
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
  // A wandering worker is away from its desk — hit-test the walker sprite (around
  // its feet) FIRST, so you can hover/click the agent itself, not just the desk.
  for (const cell of cells) {
    const w = wanderers.get(keyOf(cell.agent));
    if (w && w.phase !== 'seated' && bx >= w.x - 9 && bx <= w.x + 9 && by >= w.y - 38 && by <= w.y + 3) return cell;
  }
  for (const cell of cells) {
    if (bx >= cell.x && bx <= cell.x + CELL_W && by >= cell.y && by <= cell.y + CELL_H) return cell;
  }
  return null;
}
const agentAt = (clientX, clientY) => { const c = cellAt(clientX, clientY); return c ? c.agent : null; };

// ---- hover affordance + tooltip --------------------------------------------
// Hovering a desk rings it (handled in draw via hoverKey) and pops a light DOM
// tooltip of what that agent is doing — a minimal hover-ring + info-card feel
// (name · project, activity, current task). All fields come from
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
    "font:12px 'IBM Plex Mono', ui-monospace, monospace;color:#eef3fb;line-height:1.25;" +
    'box-shadow:0 4px 14px rgba(0,0,0,0.45);display:none;';
  document.body.appendChild(tooltip);
}

function hideTooltip() { if (tooltip) tooltip.style.display = 'none'; }

// The agent's LIVE buffer anchor: a wandering worker (its walker) when away from
// the desk, else the desk itself. This is what makes hover/inspect info appear
// beside the AGENT — following them as they roam — instead of over an empty desk.
function agentAnchor(cell) {
  const w = wanderers.get(keyOf(cell.agent));
  if (w && w.phase !== 'seated') return { cx: w.x, top: w.y - 36, bot: w.y + 3 };
  return { cx: cell.x + CELL_W / 2, top: cell.y, bot: cell.y + CELL_H };
}

// Pin the tooltip beside the agent's live anchor (above it, flipping below if
// cramped), clamped to the viewport. Split from showTooltip so the per-frame loop
// can re-pin it cheaply as a walker moves or the camera pans/zooms.
function positionTooltip(cell) {
  if (!tooltip || tooltip.style.display === 'none' || !canvas) return;
  const an = agentAnchor(cell);
  const rect = canvas.getBoundingClientRect();
  const eff = UPSCALE * cam.s;
  const cx = rect.left + an.cx * eff;
  const topY = rect.top + an.top * eff;
  const botY = rect.top + an.bot * eff;
  const tw = tooltip.offsetWidth, th = tooltip.offsetHeight;
  const left = clampN(cx, tw / 2 + 4, window.innerWidth - tw / 2 - 4);
  let top = topY - th - 8;
  if (top < 4) top = botY + 8;
  tooltip.style.left = Math.round(left) + 'px';
  tooltip.style.top = Math.round(top) + 'px';
}

function showTooltip(cell) {
  ensureTooltip();
  const a = cell.agent;
  if (a.placeholder) {
    // a vacant desk → invite the user to hire their first agent
    tooltip.innerHTML =
      '<div style="font-weight:600;letter-spacing:.3px">An empty desk</div>' +
      '<div style="opacity:.85;margin-top:2px;max-width:180px;white-space:normal">' +
      'Start a Claude agent to see your first employee.</div>';
    tooltip.style.display = 'block';
    positionTooltip(cell);
    return;
  }
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
    (a.model ? `<div style="opacity:.6;margin-top:1px;font-size:12px">` +
      `${escHtml(String(a.model).replace(/^claude-/, ''))}</div>` : '') +
    (task ? '<div style="opacity:.85;margin-top:1px;max-width:206px;overflow:hidden;' +
      `text-overflow:ellipsis">“${escHtml(task)}”</div>` : '') +
    (avatar && avatar.enabled ? '<div style="opacity:.5;margin-top:3px;font-size:11px">' +
      'press E to open</div>' : '');
  tooltip.style.display = 'block';
  positionTooltip(cell);
}

// The detail card (chat-panel #chatPanel) floats BESIDE the selected agent rather
// than as a screen-blocking rail. office.js owns its position (it knows the camera
// + the agent's live buffer pos); chat-panel.js owns its content. Re-pinned every
// frame so it tracks the agent + camera. Prefers the agent's right; flips left near
// the edge; clamps under the topbar.
function positionDetailCard() {
  const card = document.getElementById('chatPanel');
  if (!card || !card.classList.contains('open')) return;
  const cell = cells.find((c) => keyOf(c.agent) === selectedKey);
  if (!cell) return;
  const an = agentAnchor(cell);
  const rect = canvas.getBoundingClientRect();
  const eff = UPSCALE * cam.s;
  const ax = rect.left + an.cx * eff;
  const atop = rect.top + an.top * eff;
  const cw = card.offsetWidth || 300, ch = card.offsetHeight || 240;
  const margin = 12, gap = 22;
  let left = ax + gap;
  if (left + cw > window.innerWidth - margin) left = ax - gap - cw; // flip to the left
  left = clampN(left, margin, Math.max(margin, window.innerWidth - cw - margin));
  let top = clampN(atop - 8, 80, Math.max(80, window.innerHeight - ch - margin));
  card.style.left = Math.round(left) + 'px';
  card.style.top = Math.round(top) + 'px';
}

// Keep the hover tooltip + the selected detail card pinned to their agents as the
// camera moves and walkers roam. Called from draw() (walker motion) and applyCam()
// (pan/zoom/follow) so neither lags behind.
function positionOverlays() {
  if (!cells.length) return;
  if (hoverKey) {
    const cell = cells.find((c) => keyOf(c.agent) === hoverKey);
    if (cell) positionTooltip(cell); else hideTooltip();
  }
  if (selectedKey) positionDetailCard();
}

// A highlight disc under a wandering worker who is hovered/selected — the walker
// analogue of the desk's hover/selection ring, so the AGENT lights up (not just
// their empty desk). Drawn before the walker so it stands on the disc.
function drawWalkerRing(x, y, color) {
  ctx.save();
  ctx.globalAlpha = 0.18; ctx.fillStyle = color;
  ctx.beginPath(); ctx.ellipse(x, y + 1, 11, 4, 0, 0, Math.PI * 2); ctx.fill();
  ctx.globalAlpha = 0.95; ctx.strokeStyle = color; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.ellipse(x, y + 1, 10, 3.4, 0, 0, Math.PI * 2); ctx.stroke();
  ctx.restore();
}

// Recompute the hovered desk from a cursor point: update the cursor, the tooltip,
// and (only on change) the hover key + an immediate repaint so the ring tracks
// the cursor without waiting for the slow (~7.5fps) animation tick.
function updateHover(clientX, clientY) {
  if (avatar && avatar.enabled) return; // walk mode: avatar proximity drives the tooltip
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
      if (agent && agent.placeholder) {
        // a vacant desk isn't a real agent — show its hover hint, don't open a card
        const cell = cellAt(e.clientX, e.clientY);
        if (cell) showTooltip(cell);
      } else {
        const k = keyOf(agent);
        selectedKey = (k && k === selectedKey) ? null : k;
        draw(); // paint the selection ring now — don't wait for the slow loop tick
        window.dispatchEvent(new CustomEvent('agency:select', { detail: { agent: selectedKey ? agent : null } }));
      }
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
      // Magnitude-proportional zoom. A fixed per-event factor felt hair-trigger
      // on trackpads, which fire many
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
  // app.js mutates window.agencyUnread between polls and fires this; re-sync the
  // per-desk unread pips (syncLabels reads window.agencyUnread directly).
  window.addEventListener('agency:unread', () => syncLabels());
  // Selection can come from a click (here), the avatar's E key, or anywhere; keep
  // selectedKey in sync and pin the detail card beside the agent once it has opened
  // + measured (rAF), so it never flashes at its default corner.
  window.addEventListener('agency:select', (e) => {
    const a = e && e.detail && e.detail.agent;
    selectedKey = keyOf(a);
    requestAnimationFrame(positionDetailCard);
  });
  // Walk mode: the avatar fires agency:inspect as it passes desks. Surface a LIGHT
  // tooltip beside that agent (NOT the heavy detail card) so the floor isn't blocked
  // while wandering; E (see initOffice keydown) opens the full card for it.
  window.addEventListener('agency:inspect', (e) => {
    const a = e && e.detail && e.detail.agent;
    lastInspectAgent = a || null;
    const k = keyOf(a);
    if (k === hoverKey) return;
    hoverKey = k;
    if (a) {
      const cell = cells.find((c) => keyOf(c.agent) === k);
      if (cell) showTooltip(cell); else hideTooltip();
    } else hideTooltip();
    draw();
  });
}

// ---- floor entities: avatar (walkable player) + wandering cat ---------------

// Desks in the avatar's expected shape: pod top-left (cell x,y) + the agent.
function buildPods() {
  return cells.map((c, i) => ({ x: c.x, y: c.y, i, agent: c.agent }));
}

// Walkable floor extents in buffer coords (inside the walls + margins).
function floorBounds() {
  return { minX: MARGIN + 8, maxX: bufW - MARGIN - 8, minY: TOP + 14, maxY: bufH - MARGIN - 6 };
}

// Center the camera on the avatar (lerped catch-up) so it follows while walking.
// Mutates cam WITHOUT setting userMoved, so toggling walk off restores fit/pan.
function followAvatar(dt = 16) {
  if (!avatar) return;
  const vp = viewportRect();
  const availW = Math.max(40, vp.width - reservedRight);
  const eff = UPSCALE * cam.s;
  const tx = availW / 2 - avatar.pos.x * eff;
  const ty = vp.height / 2 - avatar.pos.y * eff;
  // Frame-rate-independent catch-up (~0.18 per frame at 60fps) so the follow
  // feels identical at 30 / 60 / 120 Hz instead of speeding up with frame rate.
  const k = 1 - Math.pow(0.82, dt / 16.67);
  cam.x += (tx - cam.x) * k;
  cam.y += (ty - cam.y) * k;
  clampPan();
  applyCam();
}

// Toggle walk mode (the 'g' key / the button). On ENTER: drop the avatar where
// the user is looking, then zoom IN for an immersive first-person feel and snap
// the camera onto it. On EXIT: restore the pre-walk camera.
const WALK_ZOOM = 1.8;  // cam.s in walk mode → eff ≈ 5.4x: a close, immersive view
let preWalkCam = null;  // camera saved on walk-enter, restored on walk-exit
function toggleWalk(on) {
  if (!avatar) return;
  const was = avatar.enabled;
  avatar.enabled = on == null ? !avatar.enabled : !!on;
  if (avatar.enabled && !was) {
    const vp = viewportRect();
    const effOld = UPSCALE * cam.s;
    const b = floorBounds();
    // drop the avatar at the current view centre, in world coords at the OLD zoom
    avatar.setPos(
      clampN((vp.width / 2 - cam.x) / effOld, b.minX, b.maxX),
      clampN((vp.height / 2 - cam.y) / effOld, b.minY, b.maxY)
    );
    preWalkCam = { s: cam.s, x: cam.x, y: cam.y, userMoved };
    cam.s = Math.max(WALK_ZOOM, coverScale()); // zoom in for immersion, but never below cover (no void)
    // snap (no lerp) so the camera doesn't lurch from the old framing
    const effNew = UPSCALE * cam.s;
    const availW = Math.max(40, vp.width - reservedRight);
    cam.x = availW / 2 - avatar.pos.x * effNew;
    cam.y = vp.height / 2 - avatar.pos.y * effNew;
    clampPan();
    applyCam();
  } else if (!avatar.enabled && was && preWalkCam) {
    // restore the pre-walk zoom + pan + auto-fit state
    cam.s = preWalkCam.s; cam.x = preWalkCam.x; cam.y = preWalkCam.y;
    userMoved = preWalkCam.userMoved; preWalkCam = null;
    clampPan(); applyCam();
  }
  updateWalkUI();
}

function updateWalkUI() {
  const on = !!(avatar && avatar.enabled);
  if (walkBtn) {
    walkBtn.textContent = on ? '🚶 walking · G to exit' : '🚶 walk (G)';
    walkBtn.style.borderColor = on ? '#ff2e88' : 'rgba(255,255,255,0.14)';
    walkBtn.style.color = on ? '#ff8fc4' : '#cdd6e6';
  }
  if (walkHint) walkHint.style.display = on ? 'block' : 'none';
}

// Toggle agent name-tag visibility (the 'n' key / the button). syncLabels + draw()
// both honor `labelsHidden`; we flip the active chips here too for an instant response.
function toggleLabels(on) {
  labelsHidden = on == null ? !labelsHidden : !!on;
  for (let i = 0; i < cells.length; i++) if (nameNodes[i]) nameNodes[i].style.display = labelsHidden ? 'none' : 'inline-flex';
  updateLabelBtn();
}
function updateLabelBtn() {
  if (!nameBtn) return;
  nameBtn.textContent = labelsHidden ? '🏷 names off' : '🏷 names';
  nameBtn.style.opacity = labelsHidden ? '0.6' : '1';
}

// Build the small walk affordances (a toggle button + a hint) over the floor
// frame, styled inline (index.html / style.css aren't in this lane).
function ensureWalkUI() {
  const host = world && world.parentElement; // .floor-frame
  if (!host || walkBtn) return;
  walkBtn = document.createElement('button');
  walkBtn.type = 'button';
  walkBtn.id = 'walkToggle';
  Object.assign(walkBtn.style, {
    position: 'absolute', left: '12px', bottom: '12px', zIndex: '6',
    font: '11px ui-monospace, monospace', background: 'rgba(16,20,28,0.82)',
    border: '1px solid rgba(255,255,255,0.14)', borderRadius: '6px',
    padding: '5px 9px', cursor: 'pointer',
  });
  walkBtn.addEventListener('click', () => toggleWalk());
  host.appendChild(walkBtn);
  // nametag-visibility toggle (top-left, clear of the bottom controls)
  nameBtn = document.createElement('button');
  nameBtn.type = 'button';
  nameBtn.id = 'nameToggle';
  nameBtn.title = 'Show / hide agent name tags (N)';
  Object.assign(nameBtn.style, {
    // sits just below the top-left "N away · show" hidden-agents chip (which also
    // anchors top-left), so the two stack instead of overlapping.
    position: 'absolute', left: '12px', top: '40px', zIndex: '6',
    font: '11px ui-monospace, monospace', background: 'rgba(16,20,28,0.82)',
    border: '1px solid rgba(255,255,255,0.14)', borderRadius: '6px',
    padding: '5px 9px', cursor: 'pointer', color: '#cdd6e6',
  });
  nameBtn.addEventListener('click', () => toggleLabels());
  host.appendChild(nameBtn);
  updateLabelBtn();
  walkHint = document.createElement('div');
  Object.assign(walkHint.style, {
    position: 'absolute', left: '12px', bottom: '40px', zIndex: '6',
    font: '11px ui-monospace, monospace', color: '#9aa6ba',
    background: 'rgba(16,20,28,0.82)', border: '1px solid rgba(255,255,255,0.10)',
    borderRadius: '6px', padding: '4px 8px', display: 'none', maxWidth: '250px',
  });
  walkHint.textContent = 'WASD / arrows to move · walk up to a desk to open it · G to exit';
  host.appendChild(walkHint);
  updateWalkUI();
}

// Gently roam a cat across the lower floor (the lounge): pick a target, amble to
// it, sit a while, repeat. Subtle ambient life; runs every loop tick.
function updateCat(dt, now) {
  if (!bufW || !bufH) return;
  const minX = MARGIN + 12, maxX = bufW - MARGIN - 14;
  const minY = Math.round(bufH * 0.66), maxY = bufH - MARGIN - 6;
  if (!cat.init) {
    cat.x = minX + 8; cat.y = maxY - 2; cat.tx = cat.x; cat.ty = cat.y;
    cat.sit = true; cat.until = now + 1500; cat.init = true;
  }
  cat.x = clampN(cat.x, minX, maxX); cat.y = clampN(cat.y, minY, maxY); // re-clamp after a reshape

  // Petting: while the walking avatar is right next to the cat, it wakes, sits
  // happily, and emits hearts (drawn in drawCat). Re-checked every tick so a
  // lingering pet keeps it awake; stepping away lets it drift back to napping.
  cat.petted = (typeof window !== 'undefined' && window.__pet) || false; // reel: force the happy/hearts state
  dog.petted = (typeof window !== 'undefined' && window.__pet) || false;
  if (avatar && avatar.enabled) {
    const pd = Math.hypot(avatar.pos.x - cat.x, avatar.pos.y - cat.y);
    if (pd < 22) {
      cat.petted = true;
      cat.sleeping = false;
      cat.sit = true;
      if (cat.until < now + 900) cat.until = now + 900; // stay put a beat to be petted
    }
    // the dog is stationary — just light up when the avatar is beside it
    if (dog.init && Math.hypot(avatar.pos.x - dog.x, avatar.pos.y - dog.y) < 22) dog.petted = true;
  }

  if (now >= cat.until) {
    if (cat.sleeping) {
      // wake from a nap → sit a moment, then resume roaming
      cat.sleeping = false; cat.sit = true; cat.until = now + 1400 + Math.random() * 2200;
    } else if (cat.sit) {
      // resting done → usually curl up for a nap, otherwise wander to a new spot
      if (!cat.petted && Math.random() < 0.45) {
        cat.sleeping = true; cat.until = now + 9000 + Math.random() * 9000; // a good nap
      } else {
        cat.sit = false;
        cat.tx = minX + Math.round(Math.random() * (maxX - minX));
        cat.ty = minY + Math.round(Math.random() * (maxY - minY));
        cat.until = now + 5000 + Math.random() * 4000; // safety cap before it must rest
      }
    } else {
      cat.sit = true; cat.until = now + 2200 + Math.random() * 4500; // arrived → rest a while
    }
  }
  if (!cat.sit) {
    const dx = cat.tx - cat.x, dy = cat.ty - cat.y, d = Math.hypot(dx, dy);
    if (d > 1.2) {
      const step = Math.min(14 * dt / 1000, d); // ~14 buffer px/s amble
      // Face the direction of travel so it never moonwalks (deadzone avoids
      // flicker on near-vertical paths; keeps the last facing otherwise).
      if (dx < -0.4) cat.dir = -1; else if (dx > 0.4) cat.dir = 1;
      cat.x += (dx / d) * step; cat.y += (dy / d) * step;
    } else { cat.sit = true; cat.until = now + 1500 + Math.random() * 3000; }
  }
}

// Idle-wander: settled-idle workers leave their desk and amble around the floor —
// to a JITTERED point inside a random destination zone (so they spread out instead
// of stacking on a fixed spot), usually hopping between spots a while before heading
// home (they don't camp at the desk), and RUSHING home fast when resumed. Runs every
// tick. ≤2 wander at once so the floor reads calm, and they cycle so it's not always
// the same two.
const WANDER_SPEED = 24; // fallback amble speed (buffer px/s); each wanderer varies its own
const RETURN_RUSH = 64;  // fast speed home when the agent is resumed / goes busy
function updateWanderers(dt, now) {
  if (!cells.length) return;
  const live = new Set();
  let away = 0;
  for (const [, w] of wanderers) if (w.phase !== 'seated') away++;
  cells.forEach((cell) => {
    const a = cell.agent;
    if (a.placeholder) return; // a vacant desk never wanders
    const key = keyOf(a);
    if (key == null) return;
    live.add(key);
    const homeX = cell.x + CELL_W / 2, homeY = cell.y + CELL_H - 6;
    let w = wanderers.get(key);
    if (!w) {
      w = { phase: 'seated', x: homeX, y: homeY, tx: homeX, ty: homeY, legDist: 1, rush: false,
            until: now + 8000 + Math.random() * 30000, homeX, homeY,
            speed: 19 + Math.random() * 13 }; // its own amble speed → motion isn't uniform
      wanderers.set(key, w);
    } else { w.homeX = homeX; w.homeY = homeY; } // re-sync home to the (re-laid) desk
    const settled = a.activity === 'idle' && !a.needsYou && !a.awaitingReply
      && !(a.sessionId && window.agencyUnread && window.agencyUnread.has(a.sessionId));
    // resumed / went busy while out → RUSH straight home, fast
    if (!settled && w.phase !== 'seated' && !(w.phase === 'returning' && w.rush)) {
      w.phase = 'returning'; w.rush = true; setTarget(w, w.homeX, w.homeY);
    }
    switch (w.phase) {
      case 'seated':
        if (now >= w.until) {
          // only SOMETIMES actually get up when the timer fires → irregular rhythm
          if (settled && away < 2 && wanderZones.length && Math.random() < 0.7) {
            w.x = w.homeX; w.y = w.homeY; w.rush = false; startStroll(w); away++;
          } else {
            w.until = now + 6000 + Math.random() * 18000;
          }
        }
        break;
      case 'walking':
        if (stepToward(w, dt)) { w.phase = 'lingering'; w.until = now + 3000 + Math.random() * 9000; }
        break;
      case 'lingering':
        if (now >= w.until) {
          // keep wandering: usually hop to ANOTHER spot; only sometimes head home
          if (settled && wanderZones.length && Math.random() < 0.7) startStroll(w);
          else { w.phase = 'returning'; w.rush = false; setTarget(w, w.homeX, w.homeY); }
        }
        break;
      case 'returning':
        if (stepToward(w, dt)) {
          w.phase = 'seated'; w.rush = false;
          // if still idle, don't camp — head out again soon; if it came back because
          // it's busy, sit (it's working) until it goes idle again.
          w.until = now + (settled ? 4000 + Math.random() * 12000 : 25000 + Math.random() * 40000);
        }
        break;
    }
  });
  for (const k of wanderers.keys()) if (!live.has(k)) wanderers.delete(k); // agent left the floor
}

// Aim w at (tx,ty), recording the leg distance so stepToward can ease in + out.
function setTarget(w, tx, ty) {
  w.tx = tx; w.ty = ty;
  w.legDist = Math.max(1, Math.hypot(tx - w.x, ty - w.y));
}

// Start ambling to a JITTERED point inside a random destination zone. The jitter
// (a random spot in the lower part of the zone) keeps workers from stacking on the
// same pixel and makes each visit look a little different.
function startStroll(w) {
  const z = wanderZones[Math.floor(Math.random() * wanderZones.length)];
  const jx = z.x + 6 + Math.random() * Math.max(1, z.w - 12);
  const jy = z.y + Math.max(0, z.h - 14) + Math.random() * 10; // lower part — in front of the zone
  w.phase = 'walking';
  setTarget(w, Math.round(jx), Math.round(jy));
}

// Amble w toward its target. Eases IN at the start and OUT near arrival for natural
// motion — unless RUSHING home (resumed), where it goes full speed straight back.
function stepToward(w, dt) {
  const dx = w.tx - w.x, dy = w.ty - w.y, d = Math.hypot(dx, dy);
  if (d <= 1.2) return true;
  const sp = w.rush ? RETURN_RUSH : (w.speed || WANDER_SPEED);
  const ease = w.rush ? 1
    : Math.max(0.4, Math.min(Math.min(1, (w.legDist - d) / 12 + 0.5), Math.min(1, d / 16)));
  const step = Math.min(sp * ease * dt / 1000, d);
  w.x += (dx / d) * step; w.y += (dy / d) * step;
  return false;
}

// ---- scene -----------------------------------------------------------------
function draw() {
  ctx.clearRect(0, 0, bufW, bufH);
  const mood = moodForHour(new Date().getHours()); // time-of-day mood (browser-local)
  drawWall(ctx, bufW, WALL_H, frame, mood);
  drawFloor(ctx, bufW, TOP, bufH);
  drawDaylight(ctx, bufW, TOP, bufH, mood);
  drawDecor();
  drawClusterRugs();
  // --- depth-sorted floor actors: every desk (the seated worker is HIDDEN while
  // its agent is away wandering), each wandering worker, the avatar, and the cat —
  // painted in baseline-y order so they pass correctly in front of / behind each
  // other. Names are DOM chips that FOLLOW a wandering worker (else sit at the desk).
  const actors = [];
  cells.forEach((cell, i) => {
    const a = cell.agent;
    const isEmpty = a.placeholder;          // a vacant desk: draw the desk, no worker
    const k = keyOf(a);
    const selected = k != null && k === selectedKey;
    const hovered = k != null && k === hoverKey && !selected;
    // just-finished + unviewed → the worker waves to catch your eye (app.js owns the set)
    const unread = !!(a.sessionId && window.agencyUnread && window.agencyUnread.has(a.sessionId));
    const w = wanderers.get(k);
    const away = !!(w && w.phase !== 'seated');
    // sort the desk by its FLOOR-CONTACT line (front edge ≈ DESK_TOP+11 = CELL_H-15),
    // NOT the cell bottom — otherwise a walker whose feet are in front of the desk
    // front but above the cell bottom wrongly sorts behind it. Characters sort by
    // their feet (w.y / avatar.pos.y / cat.y), so this makes occlusion feet-based.
    actors.push({ y: cell.y + CELL_H - 15, fn: () => {
      // a vacant desk hides the worker (away=true) — an empty chair + dark monitor.
      drawCubicle(ctx, cell.x, cell.y, a, frame, selected, hovered, unread, away || isEmpty);
      if (!isEmpty && a.role === 'lead') drawCrown(ctx, cell.x + CELL_W / 2 - 6, cell.y + 22, frame);
    } });
    if (away) {
      const seed = (a.pid | 0) || hashInt(a.sessionId || 'a'); // SAME look as the seated worker
      const moving = w.phase === 'walking' || w.phase === 'returning';
      const ring = selected ? '#ffd166' : hovered ? '#5cd0ff' : null; // gold = selected, cyan = hover
      actors.push({ y: w.y, fn: () => {
        if (ring) drawWalkerRing(Math.round(w.x), Math.round(w.y), ring);
        drawWalker(ctx, Math.round(w.x), Math.round(w.y), { seed, frame, walking: moving });
      } });
    }
    // the name chip follows a wandering worker; otherwise it sits under the desk
    const node = nameNodes[i];
    if (node) {
      node.style.display = (labelsHidden || isEmpty) ? 'none' : 'inline-flex';
      if (!labelsHidden && !isEmpty) {
        if (away) { node.style.left = Math.round(w.x) + 'px'; node.style.top = Math.round(w.y - 46) + 'px'; }
        else { node.style.left = (cell.x + CELL_W / 2) + 'px'; node.style.top = (cell.y + CELL_H - 10) + 'px'; }
      }
    }
  });
  if (avatar && avatar.enabled) actors.push({ y: avatar.pos.y, fn: () => avatar.draw(ctx) });
  if (cat.init) actors.push({ y: cat.y, fn: () => drawCat(cat.x, cat.y, frame, cat.dir, { sleeping: cat.sleeping, petted: cat.petted }) });
  if (dog.init) actors.push({ y: dog.y, fn: () => drawDog(ctx, dog.x, dog.y, { frame, petted: dog.petted }) });
  actors.sort((p, q) => p.y - q.y);
  for (const act of actors) act.fn();

  // "Waiting on you" — highest-signal state, painted LAST so it floats above every
  // desk. agent.needsYou is the live "blocked on you" field; awaitingReply is an
  // older alias for the same thing, kept as a harmless fallback. Falsy → not waiting.
  for (const cell of cells) {
    const a = cell.agent;
    if (a.needsYou || a.awaitingReply) drawNeedsYou(ctx, cell.x, cell.y, frame); // whole-desk amber treatment
  }

  positionOverlays(); // keep the hover tooltip + detail card pinned beside their agents
}

// ---- public API ------------------------------------------------------------
// initOffice(canvas, labels) + setAgents(agents) are the entry points app.js
// drives off the /api/state agent shape. Starts empty; the /api/state poll feeds
// real agents via setAgents. (labels is an unused HTML overlay arg kept for the
// call signature; this office draws its own DOM label group instead.)
export function initOffice(canvasEl, _labels) {
  // Only wire up canvas/ctx — DON'T paint anything yet. Painting an empty,
  // furnished room before the first /api/state poll arrives caused a visible
  // "load flash" (a fully-built office with zero agents flickering in before the
  // real data). The animation loop starts on the first setAgents() call instead,
  // so the first painted frame already reflects real agent data (or an
  // intentionally-empty room when the poll genuinely reports zero agents).
  // (_labels is the legacy #labels overlay arg; this office owns its own DOM
  // label group instead — see ensureLabelWrap.)
  canvas = canvasEl;
  ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = false;
  world = canvas.parentElement; // the .world wrapper (absolute, transform-origin 0,0)
  attachInput();                // pan / zoom / click-to-open-chat

  // Floor entities: the walkable player avatar (off by default) + its affordances.
  avatar = createAvatar({ enabled: false });
  ensureWalkUI();
  window.addEventListener('keydown', (e) => {
    const k = e.key.toLowerCase();
    const isOpen = k === 'e' || e.key === 'Enter';
    if (k !== 'g' && k !== 'n' && !isOpen) return;
    const t = e.target; // don't fire while typing in the chat panel
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
    if (k === 'g') toggleWalk();
    else if (k === 'n') toggleLabels();
    else if (isOpen && avatar && avatar.enabled && lastInspectAgent) {
      // open the full detail card for the agent we're standing next to
      selectedKey = keyOf(lastInspectAgent);
      draw();
      window.dispatchEvent(new CustomEvent('agency:select', { detail: { agent: lastInspectAgent } }));
    }
  });
}

export function init(canvasEl, n, seed) {
  canvas = canvasEl;
  ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = false;
  setAgents(makeAgents(n, seed));
}

let started = false;
let lastAll = [];        // last full agent set (pre hidden-filter), so the "show"
let showHidden = false;  // toggle can re-reveal hidden desks without a fresh poll
// A single VACANT desk shown when the floor is empty (no agents). Flows through the
// normal layout as one cell; the renderer draws an empty desk + a hover hint.
const EMPTY_DESK = { placeholder: true, project: '', name: '', activity: 'idle', model: '', sessionId: '__vacant__', pid: null, subagents: [], role: null };
let hiddenCount = 0;

const isActive = (a) => a.activity === 'working' || a.activity === 'shell';
// Sort: group by project (one rug/label per team — clusterRuns needs each team
// contiguous), then ACTIVE-first and LEAD-first WITHIN the team so the eye lands
// on what's live. Stable + deterministic so teams don't reshuffle between polls.
const agentOrder = (a, b) =>
  String(a.project || '').localeCompare(String(b.project || '')) ||
  (isActive(b) - isActive(a)) ||
  ((b.role === 'lead') - (a.role === 'lead'));

// Rebuild the scene from lastAll, honoring the hidden filter + showHidden toggle.
// Shared by setAgents (new poll) and the "N away · show" toggle (no poll).
function rebuild() {
  hiddenCount = lastAll.reduce((n, a) => n + (a.hidden ? 1 : 0), 0);
  const visible = showHidden ? lastAll.slice() : lastAll.filter((a) => !a.hidden);
  // No agents → show ONE vacant desk (the snug 1-desk office, just empty) so an empty
  // floor reads as "your office, awaiting your first hire" instead of a bare room.
  // The placeholder flows through the normal layout; the draw loop + tooltip special-
  // case it (no worker, a hover hint).
  agents = visible.length ? visible : [EMPTY_DESK];
  plan();
  canvas.width = bufW;
  canvas.height = bufH;
  canvas.style.width = bufW * UPSCALE + 'px';   // crisp CSS upscale
  canvas.style.height = bufH * UPSCALE + 'px';
  ctx.imageSmoothingEnabled = false;
  draw();       // repaint now — setting canvas.width cleared it (avoids a blank frame)
  syncLabels(); // (re)position the DOM name + repo + lead-tie labels + hidden chip
  // fit-to-view until the user pans/zooms, then respect their view.
  // While walking, the camera is driven by followAvatar(); a poll-time re-fit
  // would snap it away for one frame, so skip the auto-fit in walk mode.
  if (!userMoved && !(avatar && avatar.enabled)) fitView(); else applyCam();
}

export function setAgents(next) {
  lastAll = (next || []).slice().sort(agentOrder);
  rebuild();
  if (!started) { started = true; loop(); } // first data → kick off the animation loop
}

let raf, timer;
function loop() {
  if (!started) return;              // cancelled (reset) between frames
  const now = (typeof performance !== 'undefined' ? performance.now() : Date.now());
  // Animation phase is derived from wall-clock at a FIXED ~7.5fps cadence, NOT
  // incremented per loop — so sprites animate at the same speed regardless of the
  // loop rate. (Walk mode runs the loop at native refresh for smooth avatar/camera
  // motion; without this, every typing/blink/tail-wag cycle would run ~8x faster.)
  frame = Math.floor(now / 130);
  const dt = lastT ? Math.min(now - lastT, 100) : 16; // clamp big tab-out gaps
  lastT = now;
  updateCat(dt, now);                // ambient — roams whether or not walk mode is on
  updateWanderers(dt, now);          // ambient — idle workers stroll the lower floor
  const walking = !!(avatar && avatar.enabled);
  if (walking) {
    avatar.update(dt, { podPositions: buildPods(), bounds: floorBounds() });
    followAvatar(dt);
  }
  draw();
  // Walking: glide at the display's native refresh — no setTimeout throttle, so
  // motion is smooth and frame-aligned (the old ~30fps setTimeout-in-rAF was the
  // choppiness). Idle: the calm ~7.5fps pixel cadence (cheap + the retro tick).
  if (walking) {
    raf = requestAnimationFrame(loop);
  } else {
    raf = requestAnimationFrame(() => {
      if (!started) return;          // cancelled (reset) while the RAF was pending
      timer = setTimeout(loop, 130);
    });
  }
}

export function reset(n, seed) {
  cancelAnimationFrame(raf);
  clearTimeout(timer);               // kill the tick the RAF may have already scheduled
  started = false;                   // makes a pending RAF callback bail instead of rescheduling
  userMoved = false;                 // re-fit the fresh layout
  wanderers.clear();                 // fresh floor → nobody mid-stroll
  setAgents(makeAgents(n, seed));
}

// expose for the harness
window.__office = { init, reset };
