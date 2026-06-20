// render.js — draws the pixel office into a low-res buffer, then lets the user
// pan/zoom it like a Sims camera. The canvas + scaled name tags live inside a
// transformed `.world` element, so tags scale WITH the floor and can never
// overlap. Full per-agent detail surfaces in a readable, screen-space info card
// on hover / click.

import { POD_W, POD_H, drawWorker, drawSelectRing, drawPlumbob, drawLeadBadge, drawNeedsYou, colorFor, teamColorHex } from './sprites.js';
import { sheetReady, blit, blitStanding, sprW, sprH, WORKER_SPRITES } from './office-atlas.js';
import { loadCharacter, staticCharacter, drawCharacterState } from './characters.js';

// Hybrid render mode (?render=hybrid): keep the sprite-sheet ENVIRONMENT but
// swap the procedural worker BODY for a sheet/character sprite. Default stays
// the current procedural renderer so the two can be compared.
const HYBRID = new URLSearchParams(location.search).get('render') === 'hybrid';

// The hybrid character layer is two-tier:
//  - STATIC baseline: the five front-facing standing workers already on the
//    office sheet (office-atlas.js worker1..5). Always available the moment the
//    sheet loads — zero generated assets, so this is what hybrid shows today.
//  - ANIMATED upgrade: generated sprite atlases dropped into public/characters/.
//    When one is assigned to an agent it's used INSTEAD of the static sprite.
// Each agent is mapped to one character deterministically by its stable seed so
// its look doesn't reshuffle between polls.
const staticChars = WORKER_SPRITES.map(staticCharacter).filter(Boolean);

// Loaded animated atlases ({kind:'animated', atlas, img}). Populated async; any
// that fail to load are skipped (fail-soft). These are the generated
// idle/type/walk sprite characters (27x34, cols=4, anchor (13,33)); each agent
// is mapped to one in animatedCharFor() below for per-agent stability. The
// static sheet workers stay the fallback if none of these load.
const CHARACTER_MANIFEST = [
  '/characters/dev-auburn.json',
  '/characters/dev-glasses.json',
  '/characters/dev-beanie.json',
];
let animatedChars = []; // [{kind:'animated', atlas, img}]

async function loadCharacters() {
  const results = await Promise.all(CHARACTER_MANIFEST.map((u) => loadCharacter(u).catch(() => null)));
  animatedChars = results.filter(Boolean);
}

const WALL_H = 72; // back-wall band: tall enough for standing furniture + windows
const MARGIN = 18; // outer breathing room around the whole floor
const COL_GAP = 12; // horizontal gap between two desks in the same cluster
const FIT_PAD = 28; // slack left around the office when fitting to the frame
// (the old ROW_GAP=34 name band is gone — superseded by NAME_BAND below.)

// POD_H (92) is the pod's HIT-TEST box (kept for podAt / sprites.js), but the
// drawn worker+desk content only spans head (py0+6) → desk front edge (py0+60),
// with the subagent "minions" reaching to ~py0+71. POD_CONTENT_H is that real
// occupied height — what the rug, row stride, and nameplate should pack to, so
// clusters stop rendering as ~2x-tall portrait rectangles with marooned desks.
const POD_CONTENT_H = 74; // head → minion feet (py0+6 → ~py0+74)
const NAME_GAP = 2; // gap between content bottom and the nameplate

// --- cluster ("neighborhood") geometry ------------------------------------
// Modern offices group 2–4 desks into small pods on a shared rug, with lounge
// + greenery zones breathing between them — not one uniform spreadsheet grid.
const CLUSTER_PAD = 12; // rug inset around a cluster's desks
const ZONE_GAP_X = 30; // horizontal air between neighbouring blocks on a row
const ZONE_GAP_Y = 26; // vertical air between rows of blocks
const LOUNGE_W = 116; // footprint of a lounge zone (couch + table + chairs)
const GREEN_W = 46; // footprint of a small greenery / plant cluster
const COLLAB_W = 100; // footprint of a collab zone (shared sheet bench + chairs)

let canvas, ctx, labelLayer, world, viewport, card, recenterBtn;
let agents = [];
let bufW = 0, bufH = 0;
let frame = 0;
let reservedRight = 0; // px reserved on the right for the hovering panel

// The floor plan, rebuilt each layout(): absolute pod positions (the public
// podOrigin/podAt/totalSlots contract reads from these) + the decor blocks that
// dress the room (lounges, greenery, feature wall) so the scene reflows by count.
let podSlots = []; // [{x, y}] — one per agent, in buffer coords
let decorZones = []; // [{type, x, y, w, h, seed}] — lounges / greenery to paint
let clusters = []; // [{x, y, w, h, count, seed}] — desk neighbourhoods (for rugs)

// ---- camera --------------------------------------------------------------
// Pan = world translate(cam.x, cam.y); zoom = cam.s (applied to the canvas CSS
// size + label-layer transform). All in viewport-local px.
let cam = { s: 1, x: 0, y: 0 };
let fitScale = 1;
let userMoved = false; // true once the user pans/zooms — suppresses auto-fit

// ---- interaction state ---------------------------------------------------
// Selection is tracked by a stable per-agent key so it follows the agent across
// polls (the agent array can reorder); selIdx is re-resolved from it each poll.
let hoverIdx = -1, selIdx = -1, cardIdx = -1, selKey = null;
const pointers = new Map();
let down = null, lastX = 0, lastY = 0, panning = false, dragged = false;
let pinchPrevDist = null;

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

// A tiny stable hash → small int, for deterministic-but-varied floor-plan choices.
function hashInt(s) {
  let h = 2166136261 >>> 0;
  s = String(s);
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
  return h >>> 0;
}

function fmtUptime(ms) {
  if (ms == null) return '—';
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s % 60}s`;
  return `${s}s`;
}

function shortModel(m) {
  if (!m) return '?';
  return m.replace(/^.+\//, '').replace('claude-', '').replace(/-\d{8}$/, '').replace(/\[1m\]/, ' 1M');
}

export function initOffice(canvasEl, labelLayerEl) {
  canvas = canvasEl;
  ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = false;
  labelLayer = labelLayerEl;
  world = canvas.parentElement; // .world
  viewport = world.parentElement; // .floor-frame
  world.style.transformOrigin = '0 0';

  card = document.createElement('div');
  card.className = 'info-card';
  card.style.display = 'none';
  viewport.appendChild(card);

  recenterBtn = document.getElementById('recenter');
  if (recenterBtn) recenterBtn.addEventListener('click', () => fitView());

  setupInteractions();
  if (HYBRID) loadCharacters(); // async; loop falls back to procedural until ready
  window.addEventListener('resize', onResize);
  requestAnimationFrame(loop);
  setInterval(tickUptimes, 1000);
}

export function setAgents(next) {
  agents = next || [];
  // Re-resolve the selected agent by its stable key so the ring/card stay on
  // the same person even if the roster reorders between polls.
  selIdx = selKey ? agents.findIndex((a) => keyOf(a) === selKey) : -1;
  if (selIdx < 0) selKey = null;
  if (hoverIdx >= agents.length) hoverIdx = -1;
  layout();
  buildLabels();
  showCardFor(hoverIdx >= 0 ? hoverIdx : selIdx);
}

function keyOf(a) {
  if (!a) return null;
  return a.sessionId || (a.pid != null ? `pid:${a.pid}` : null);
}

// A stable per-agent sprite seed. Real sessions key off pid; in-process
// teammates have no pid, so we hash their stable key (agentId/sessionId) — that
// way their look (hair, build, desk clutter) doesn't reshuffle every poll.
function seedOf(a, i) {
  if (a && a.pid) return a.pid | 0;
  const k = keyOf(a);
  if (!k) return i + 1;
  let h = 2166136261 >>> 0;
  for (let j = 0; j < k.length; j++) { h ^= k.charCodeAt(j); h = Math.imul(h, 16777619) >>> 0; }
  return (h % 100000) + 1;
}

// ---- hybrid character mapping --------------------------------------------
// Animated-atlas assignment policy: map each agent to one of the loaded animated
// characters deterministically by its stable seed, so its look doesn't reshuffle
// between polls. Falls through to a static sheet worker only when no animated
// atlas has loaded yet. (To restrict animation to a subset — e.g. only the lead
// or only Claude agents — gate here on a/role/source/model instead.)
function animatedCharFor(a, i) {
  return animatedChars.length ? animatedChars[seedOf(a, i) % animatedChars.length] : null;
}

// Resolve the character an agent renders as in hybrid: an assigned animated
// atlas if any, otherwise a deterministic static sheet worker (stable across
// polls via the agent's seed — same stability contract as the procedural seed).
// Returns null (→ procedural body) when no character can be drawn yet: no worker
// sprites at all, OR a static worker was chosen but the office sheet hasn't
// loaded (its SPR rects exist before the image does, so drawStatic would no-op
// and leave an empty chair for the first few frames). Animated chars already
// guard on img.complete, so they're fine to return pre-sheet.
function characterFor(a, i) {
  const animated = animatedCharFor(a, i);
  if (animated) return animated;
  if (!staticChars.length || !sheetReady()) return null;
  return staticChars[seedOf(a, i) % staticChars.length];
}

// Map agent activity → character animation state: model generating or a shell
// command running both read as "at the keyboard" (type); everything else idles.
// (Static sheet workers ignore this — they have a single standing pose.)
function charStateFor(a) {
  const act = a && a.activity;
  if (act === 'working' || act === 'shell') return 'type';
  return 'idle';
}

// ---- layout + camera -----------------------------------------------------
// Modern "neighborhood" floor plan instead of a uniform grid. We partition the
// agents into small desk CLUSTERS (2–4 pods on a shared rug), then flow those
// clusters together with LOUNGE and GREENERY zones into wrapping rows — leaving
// asymmetric breathing room so the floor reads designed, not spreadsheet-y.
//
// The public contract is preserved: every agent i still gets an absolute origin
// via podOrigin(i) (read from podSlots), is hit-tested by podAt, and counted by
// totalSlots() — so selection, the DOM nameplates, the chat panel and the
// awaitingReply indicator all keep working unchanged.

// The "name band" beneath each desk row: a thin strip holding the DOM nameplate.
// Replaces the old full ROW_GAP(34) of dead floor between rows.
const NAME_BAND = 18; // room for the nameplate chip under each desk row
// Vertical stride between desk rows inside a cluster: real content + name band.
// Far tighter than the old POD_H+ROW_GAP-8 (=118) stride, which reserved a whole
// extra POD_H of empty floor and stranded the desks at the rug's top.
const POD_ROW_STRIDE = POD_CONTENT_H + NAME_BAND; // 74 + 18 = 92

// A cluster's footprint for `count` desks, laid out in up to 2 columns. Height
// hugs the actual desk content (POD_CONTENT_H per row + a name band) instead of
// the full hit-test POD_H, so the rug fits the desks rather than dwarfing them.
function clusterDims(count) {
  const ccols = count <= 1 ? 1 : 2;
  const crows = Math.ceil(count / ccols);
  return {
    ccols, crows,
    w: ccols * POD_W + (ccols - 1) * COL_GAP + CLUSTER_PAD * 2,
    // CLUSTER_PAD top + each row (content + its name band) + CLUSTER_PAD bottom.
    h: CLUSTER_PAD * 2 + crows * POD_ROW_STRIDE,
  };
}

// Partition n desks into cluster sizes (each 2–4). We favour pods of 3–4 with
// the odd pair so neighbourhoods feel varied, never a lonely single desk and
// never a cluster so big it grows three rows tall.
function clusterSizes(n) {
  if (n <= 0) return [];
  if (n <= 4) return [n];
  const sizes = [];
  let left = n;
  const pattern = [4, 3, 4, 2, 3, 4]; // deterministic rotation, max 4
  let p = 0;
  while (left > 0) {
    let s = pattern[p % pattern.length];
    p++;
    if (left <= 4) { sizes.push(left); break; } // place the tail as one pod (2–4)
    if (left - s === 1) s = 3; // don't strand a single; leave a pair-or-more tail
    sizes.push(s);
    left -= s;
  }
  return sizes;
}

// Build the whole floor plan: cluster + decor blocks flowed into rows, then
// absolute pod positions. Width target adapts to the desk count so few agents
// stay compact and many spread into a believable open-plan floor.
function planFloor(n) {
  podSlots = [];
  decorZones = [];
  clusters = [];

  const sizes = clusterSizes(Math.max(n, 0));
  // Empty floor (no live agents): still a furnished, lived-in lounge rather than
  // a bare strip — a couch zone flanked by greenery reads as "quiet office".
  if (sizes.length === 0) {
    const blocks = [
      { kind: 'green', w: GREEN_W, h: POD_H - 8, seed: 31 },
      { kind: 'lounge', w: LOUNGE_W, h: POD_H + 6, seed: 47 },
      { kind: 'green', w: GREEN_W, h: POD_H - 8, seed: 59 },
    ];
    let ex = MARGIN; const ey = WALL_H + MARGIN; let eh = 0;
    blocks.forEach((b) => { decorZones.push({ type: b.kind, x: ex, y: ey, w: b.w, h: b.h, seed: b.seed }); ex += b.w + ZONE_GAP_X; eh = Math.max(eh, b.h); });
    bufW = Math.round(ex - ZONE_GAP_X) + MARGIN;
    bufH = ey + eh + MARGIN;
    return;
  }
  // Assemble the running order of blocks for this floor: desk clusters, with a
  // lounge or greenery zone sprinkled between every couple of clusters so the
  // open plan has soft "social" interruptions like the reference.
  const blocks = [];
  // social-zone rotation woven between clusters: greenery (slim) most often, a
  // lounge or a sheet-desk collab table at wider intervals so the floor has a
  // mix of "social interruptions" without any two big zones crowding together.
  const socialOrder = ['green', 'lounge', 'green', 'collab', 'green', 'lounge'];
  let social = 0;
  sizes.forEach((sz, ci) => {
    const d = clusterDims(sz);
    blocks.push({ kind: 'cluster', count: sz, w: d.w, h: d.h, dims: d, seed: 101 + ci * 7 });
    if (ci < sizes.length - 1) { // never trail a social zone past the last cluster
      const kind = socialOrder[social % socialOrder.length];
      social++;
      if (kind === 'lounge') blocks.push({ kind: 'lounge', w: LOUNGE_W, h: POD_H + 6, seed: 211 + ci * 13 });
      else if (kind === 'collab') blocks.push({ kind: 'collab', w: COLLAB_W, h: POD_H, seed: 401 + ci * 13 });
      else blocks.push({ kind: 'green', w: GREEN_W, h: POD_H - 8, seed: 307 + ci * 11 });
    }
  });

  // Target a width that spreads clusters across the (wide) frame rather than
  // stacking them into a tall column — an open-plan floor reads landscape. Aim
  // for a roughly 7:4 aspect by widening as the desk count grows. The per-gap
  // allowance is sized to the WIDEST social zone (a lounge) so an inter-cluster
  // zone landing on a row never tips the next cluster over the edge.
  const clusterBlocks = blocks.filter((b) => b.kind === 'cluster');
  const nClusters = clusterBlocks.length;
  const widest = clusterBlocks.reduce((m, b) => Math.max(m, b.w), POD_W + CLUSTER_PAD * 2);
  const perRow = nClusters <= 1 ? 1
    : nClusters <= 2 ? 2
    : nClusters <= 6 ? 3
    : 4;
  const gapAllow = ZONE_GAP_X * 2 + LOUNGE_W; // room for a social zone between clusters
  const targetW = MARGIN * 2 + widest * perRow + gapAllow * Math.max(0, perRow - 1);

  // Greedy row-wrap: place blocks left→right until the next one would overflow
  // targetW, then start a new row below the tallest block of the previous row.
  // Alternating blocks in a row get a small vertical STAGGER so the floor breaks
  // its horizon line and reads organic rather than as aligned spreadsheet rows.
  const STAGGER = 16;
  let cx = MARGIN, cy = WALL_H + MARGIN, rowH = 0, rowStart = 0, rowCol = 0;
  const placed = [];
  const finishRow = (endX) => {
    // centre each finished row horizontally so the floor reads balanced, and
    // stretch its decor zones to the row height so their furniture bottom-aligns
    // with the desk clusters instead of floating up at the row's top.
    const slack = (targetW - MARGIN - endX);
    const rowBottom = cy + rowH;
    for (let k = rowStart; k < placed.length; k++) {
      if (slack > 1) placed[k].x += slack / 2;
      // decor zones grow down to the row's floor so their furniture baseline
      // (z.y + z.h - 4) sits level with the desk clusters of the same row.
      if (placed[k].kind !== 'cluster') placed[k].h = rowBottom - placed[k].y;
    }
  };
  blocks.forEach((b) => {
    if (cx > MARGIN && cx + b.w > targetW - MARGIN) {
      finishRow(cx - ZONE_GAP_X);
      cx = MARGIN; cy += rowH + ZONE_GAP_Y; rowH = 0; rowStart = placed.length; rowCol = 0;
    }
    const stag = rowCol % 2 ? STAGGER : 0; // every other block nudged down
    placed.push({ ...b, x: cx, y: cy + stag });
    cx += b.w + ZONE_GAP_X; rowCol++;
    rowH = Math.max(rowH, b.h + stag); // keep row tall enough for the nudged block
  });
  finishRow(cx - ZONE_GAP_X);

  // Realise pod positions + decor records from the placed blocks.
  placed.forEach((b) => {
    if (b.kind === 'cluster') {
      clusters.push({ x: b.x, y: b.y, w: b.w, h: b.h, count: b.count, seed: b.seed });
      const { ccols } = b.dims;
      for (let k = 0; k < b.count; k++) {
        const c = k % ccols, r = Math.floor(k / ccols);
        podSlots.push({
          x: b.x + CLUSTER_PAD + c * (POD_W + COL_GAP),
          y: b.y + CLUSTER_PAD + r * POD_ROW_STRIDE,
        });
      }
    } else {
      decorZones.push({ type: b.kind, x: b.x, y: b.y, w: b.w, h: b.h, seed: b.seed });
    }
  });

  // Buffer bounds: encompass every pod + decor block, plus a margin.
  let maxX = MARGIN, maxY = WALL_H + MARGIN;
  placed.forEach((b) => { maxX = Math.max(maxX, b.x + b.w); maxY = Math.max(maxY, b.y + b.h); });
  bufW = Math.max(targetW, Math.round(maxX) + MARGIN);
  bufH = Math.round(maxY) + MARGIN;
}

function layout() {
  planFloor(agents.length);

  canvas.width = bufW; // backing store stays at buffer resolution
  canvas.height = bufH;
  ctx.imageSmoothingEnabled = false;
  // The label layer lives in buffer coordinates; applyCam() scales it to match.
  labelLayer.style.width = bufW + 'px';
  labelLayer.style.height = bufH + 'px';

  if (!userMoved) fitView();
  else { computeFit(); commit(); } // keep the user's view, just re-clamp
}

function podOrigin(i) {
  return podSlots[i] || { x: MARGIN, y: WALL_H + MARGIN };
}

function totalSlots() { return podSlots.length; }

// Compute the scale + offset that frames the whole office in the free area
// (left of the panel). Updates fitScale (used for zoom clamps) and returns it.
function computeFit() {
  if (!viewport || !bufW || !bufH) return cam;
  const availW = Math.max(40, viewport.clientWidth - reservedRight);
  const availH = Math.max(40, viewport.clientHeight);
  const s = Math.min((availW - FIT_PAD * 2) / bufW, (availH - FIT_PAD * 2) / bufH);
  fitScale = clamp(s, 0.05, 6);
  return {
    s: fitScale,
    x: (availW - bufW * fitScale) / 2,
    y: (availH - bufH * fitScale) / 2,
  };
}

function fitView() {
  const f = computeFit();
  cam = { ...f };
  userMoved = false;
  clampPan();
  applyCam();
  updateRecenter();
  positionCard(cardIdx);
}

function minScale() { return Math.max(0.08, fitScale * 0.4); }
function maxScale() { return Math.max(8, fitScale * 6); }

function applyCam() {
  // Pan via the world's translate. Zoom is applied by resizing the canvas in
  // CSS px (keeps `image-rendering: pixelated` crisp — a transform scale would
  // blur it) and scaling the in-world label layer by a matching factor so the
  // tags track their desks exactly.
  world.style.transform = `translate(${cam.x}px, ${cam.y}px)`;
  canvas.style.width = bufW * cam.s + 'px';
  canvas.style.height = bufH * cam.s + 'px';
  labelLayer.style.transform = `scale(${cam.s})`;
}

function clampPan() {
  const w = bufW * cam.s, h = bufH * cam.s;
  const vw = viewport.clientWidth, vh = viewport.clientHeight;
  const KEEP = 90; // always keep this much of the office on-screen
  cam.x = clamp(cam.x, KEEP - w, vw - KEEP);
  cam.y = clamp(cam.y, KEEP - h, vh - KEEP);
}

// Apply pan/zoom changes: clamp, paint, update affordances, re-anchor the card.
function commit() {
  clampPan();
  applyCam();
  updateRecenter();
  positionCard(cardIdx);
}

function updateRecenter() {
  if (recenterBtn) recenterBtn.classList.toggle('show', userMoved);
}

// Zoom toward a client-space anchor point (cursor / pinch midpoint).
function zoomAt(clientX, clientY, factor) {
  const rect = viewport.getBoundingClientRect();
  const lx = clientX - rect.left, ly = clientY - rect.top; // viewport-local
  const bx = (lx - cam.x) / cam.s, by = (ly - cam.y) / cam.s; // buffer coords
  const ns = clamp(cam.s * factor, minScale(), maxScale());
  cam.x = lx - bx * ns;
  cam.y = ly - by * ns;
  cam.s = ns;
  userMoved = true;
  commit();
}

export function setReservedRight(px) {
  reservedRight = Math.max(0, px || 0);
  if (!userMoved) fitView();
  else commit();
}

export function zoomBy(factor) {
  const r = viewport.getBoundingClientRect();
  zoomAt(r.left + viewport.clientWidth / 2, r.top + viewport.clientHeight / 2, factor);
}

export function zoomFit() { fitView(); }

function onResize() {
  if (!userMoved) fitView();
  else commit();
}

// ---- pointer / wheel interaction -----------------------------------------

function setupInteractions() {
  viewport.addEventListener('pointerdown', onPointerDown);
  viewport.addEventListener('pointermove', onPointerMove);
  viewport.addEventListener('pointerup', onPointerUp);
  viewport.addEventListener('pointercancel', onPointerUp);
  viewport.addEventListener('pointerleave', () => {
    if (pointers.size === 0) { hoverIdx = -1; showCardFor(selIdx); }
  });
  viewport.addEventListener('wheel', onWheel, { passive: false });
  viewport.addEventListener('dblclick', (e) => {
    e.preventDefault();
    zoomAt(e.clientX, e.clientY, e.altKey ? 0.6 : 1.7);
    // Double-click zooms into a desk AND selects it (the two preceding taps
    // would otherwise toggle the selection back off).
    selectAt(e.clientX, e.clientY, true);
  });
}

function onPointerDown(e) {
  if (e.pointerType === 'mouse' && e.button !== 0) return; // left button only
  // Let interactive overlays (the recenter button) handle their own clicks
  // rather than starting a floor pan / capturing the pointer.
  if (e.target.closest && e.target.closest('.recenter')) return;
  viewport.setPointerCapture?.(e.pointerId);
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (pointers.size === 1) {
    down = { x: e.clientX, y: e.clientY };
    lastX = e.clientX; lastY = e.clientY;
    dragged = false; panning = true;
  } else if (pointers.size === 2) {
    pinchPrevDist = null; // seeded on first 2-pointer move
  }
}

function onPointerMove(e) {
  if (pointers.has(e.pointerId)) pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

  if (pointers.size >= 2) {
    // two-finger pinch → zoom about the midpoint
    const pts = [...pointers.values()];
    const dist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
    const mid = { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 };
    if (pinchPrevDist) zoomAt(mid.x, mid.y, dist / pinchPrevDist);
    pinchPrevDist = dist;
    dragged = true;
    return;
  }

  if (panning) {
    const dx = e.clientX - lastX, dy = e.clientY - lastY;
    lastX = e.clientX; lastY = e.clientY;
    if (!dragged && Math.hypot(e.clientX - down.x, e.clientY - down.y) > 4) {
      dragged = true; userMoved = true; viewport.style.cursor = 'grabbing';
    }
    if (dragged) { cam.x += dx; cam.y += dy; commit(); }
  } else {
    updateHover(e.clientX, e.clientY);
  }
}

function onPointerUp(e) {
  viewport.releasePointerCapture?.(e.pointerId);
  pointers.delete(e.pointerId);
  if (pointers.size < 2) pinchPrevDist = null;
  if (pointers.size === 0) {
    if (!dragged) selectAt(e.clientX, e.clientY); // a clean tap selects a desk
    panning = false; dragged = false;
    viewport.style.cursor = 'grab';
    updateHover(e.clientX, e.clientY);
  } else {
    // A pinch dropped to one finger: re-anchor and restart the tap/drag
    // decision so the survivor doesn't resume mid-"drag".
    const p = [...pointers.values()][0];
    lastX = p.x; lastY = p.y;
    down = { x: p.x, y: p.y };
    dragged = false;
  }
}

function onWheel(e) {
  e.preventDefault();
  // Zoom on: trackpad pinch (ctrl-wheel), ⌘-wheel, or a physical mouse wheel
  // (line-mode, vertical-only). A trackpad two-finger scroll (pixel-mode) pans.
  const mouseWheel = e.deltaMode !== 0 && e.deltaX === 0;
  if (e.ctrlKey || e.metaKey || mouseWheel) {
    const step = e.deltaMode !== 0 ? e.deltaY * 16 : e.deltaY; // normalize lines→px
    zoomAt(e.clientX, e.clientY, Math.exp(-step * 0.01));
  } else {
    // Two-finger scroll pans the floor.
    cam.x -= e.deltaX; cam.y -= e.deltaY;
    userMoved = true; commit();
    updateHover(e.clientX, e.clientY);
  }
}

// ---- hover / selection ----------------------------------------------------

// Which agent's desk is under a client-space point (-1 if none / vacant).
function podAt(clientX, clientY) {
  const rect = viewport.getBoundingClientRect();
  const bx = (clientX - rect.left - cam.x) / cam.s;
  const by = (clientY - rect.top - cam.y) / cam.s;
  const slots = totalSlots();
  for (let i = 0; i < slots; i++) {
    if (!agents[i]) continue;
    const o = podOrigin(i);
    if (bx >= o.x && bx < o.x + POD_W && by >= o.y && by < o.y + POD_H) return i;
  }
  return -1;
}

function updateHover(clientX, clientY) {
  const i = podAt(clientX, clientY);
  hoverIdx = i;
  showCardFor(i >= 0 ? i : selIdx);
  if (!panning) viewport.style.cursor = i >= 0 ? 'pointer' : 'grab';
}

// Select the desk under a point. A plain tap toggles (click the selected desk
// to deselect); `force` always selects (used by double-click-to-zoom).
function selectAt(clientX, clientY, force) {
  const i = podAt(clientX, clientY);
  if (i >= 0 && (force || i !== selIdx)) {
    selIdx = i; selKey = keyOf(agents[i]);
  } else {
    selIdx = -1; selKey = null;
  }
  showCardFor(hoverIdx >= 0 ? hoverIdx : selIdx);
  // Notify the chat panel (decoupled via event so render.js owns no panel state).
  window.dispatchEvent(new CustomEvent('agency:select', { detail: { agent: selIdx >= 0 ? agents[selIdx] : null } }));
}

// ---- in-world name tags --------------------------------------------------

function dotClassFor(a) {
  return a.activity === 'working' ? 'busy'
    : a.activity === 'shell' ? 'shell'
    : a.state === 'done' ? 'done' : 'idle';
}

function buildLabels() {
  labelLayer.innerHTML = '';
  agents.forEach((a, i) => {
    const o = podOrigin(i);
    const c = colorFor(a.model);
    const first = String(a.name || '').split(/\s+/)[0] || a.name || '—';
    const el = document.createElement('div');
    el.className = 'tag';
    el.dataset.i = String(i);
    el.style.left = `${o.x + POD_W / 2}px`;
    // Pin the nameplate just under the desk content (head→minions ≈ POD_CONTENT_H)
    // instead of POD_H+4 (which floated it in the dead floor below the old rug).
    el.style.top = `${o.y + POD_CONTENT_H + NAME_GAP}px`;
    // the lead's nameplate gets a small gold "PM" tag; teammate chips wear the
    // team color so the roster groups read at a glance.
    const leadTag = a.role === 'lead' ? `<span class="tag-lead">PM</span>` : '';
    const chip = (a.role === 'teammate' && teamColorHex(a.teamColor)) || c.screen;
    el.innerHTML =
      `<span class="dot ${dotClassFor(a)}"></span>` +
      `<span class="tag-name">${escapeHtml(first)}</span>` +
      leadTag +
      `<span class="tag-chip" style="background:${chip}"></span>`;
    labelLayer.appendChild(el);
  });
}

// ---- hover / selection info card -----------------------------------------

function showCardFor(idx) {
  cardIdx = idx;
  const a = idx >= 0 ? agents[idx] : null;
  if (!a) { card.style.display = 'none'; return; }
  const c = colorFor(a.model);

  let statusClass, statusText, statusIcon;
  if (a.activity === 'working') { statusClass = 'working'; statusIcon = '🟢'; statusText = 'shipping'; }
  else if (a.activity === 'shell') { statusClass = 'shell'; statusIcon = '⚙'; statusText = 'running a command'; }
  else if (a.state === 'done') { statusClass = 'done'; statusIcon = '✓'; statusText = 'done'; }
  else { statusClass = 'idle'; statusIcon = '💤'; statusText = 'idle'; }

  const task = a.task || a.chatName || a.lastPrompt;
  const taskHtml = task ? `: <span class="ic-task">"${escapeHtml(task)}"</span>` : '';
  const subN = (a.subagents || []).length;
  const subBadge = subN ? `<span class="ic-sub-badge">🤖 ${subN} subagent${subN > 1 ? 's' : ''}</span>` : '';
  const srcBadge = a.source === 'opencode'
    ? `<span class="ic-oc">opencode</span>`
    : a.source === 'codex'
      ? `<span class="ic-codex">codex</span>`
      : '';
  const slugBadge = a.modelSlug ? `<span class="ic-slug">slug: ${escapeHtml(a.modelSlug)}</span>` : '';
  const roleTag = a.role === 'lead'
    ? `<span class="ic-lead">PM</span>`
    : a.role === 'teammate'
      ? `<span class="ic-teammate">teammate</span>`
      : '';

  card.innerHTML =
    `<div class="ic-head"><span class="dot ${dotClassFor(a)}"></span>` +
      `<span class="ic-name">${escapeHtml(a.name)}</span>` + roleTag +
      `<span class="ic-tier" style="color:${c.screen}">${escapeHtml(shortModel(a.model))}</span></div>` +
    `<div class="ic-sub">${escapeHtml(a.title)} · <span class="ic-dept">${escapeHtml(a.project)}</span></div>` +
    `<div class="ic-status ${statusClass}">${statusIcon} ${statusText}${taskHtml}</div>` +
    `<div class="ic-foot"><span class="ic-up">⏱ ${fmtUptime(uptimeOf(a))}</span>${subBadge}${srcBadge}${slugBadge}</div>`;

  card.style.display = 'block';
  positionCard(idx);
}

// Live uptime — count up from startedAt between polls; fall back to the
// server's snapshot if startedAt is missing.
function uptimeOf(a) {
  if (!a) return null;
  return a.startedAt ? Date.now() - a.startedAt : a.uptimeMs;
}

// Anchor the card above (or below, if cramped) the agent's head, in
// viewport-local coords, clamped to stay on screen.
function positionCard(idx) {
  if (idx < 0 || !agents[idx] || card.style.display === 'none') return;
  const o = podOrigin(idx);
  const cx = cam.x + (o.x + POD_W / 2) * cam.s;
  const topY = cam.y + (o.y + 2) * cam.s;
  const botY = cam.y + (o.y + POD_H - 8) * cam.s;
  const vw = viewport.clientWidth;
  const cw = card.offsetWidth || 180;
  const ch = card.offsetHeight || 96;

  const below = topY - ch - 8 < 4;
  card.classList.toggle('below', below);
  const left = clamp(cx, cw / 2 + 6, vw - cw / 2 - 6);
  card.style.left = `${left}px`;
  card.style.top = `${below ? botY : topY}px`;
}

function tickUptimes() {
  // Advance only the uptime text so the dot/status animations aren't reset.
  if (cardIdx < 0 || !agents[cardIdx] || card.style.display === 'none') return;
  const up = card.querySelector('.ic-up');
  if (up) up.textContent = `⏱ ${fmtUptime(uptimeOf(agents[cardIdx]))}`;
}

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

// ---- scene ---------------------------------------------------------------

function drawWall() {
  // wall
  ctx.fillStyle = '#1a1f2b';
  ctx.fillRect(0, 0, bufW, WALL_H);
  ctx.fillStyle = '#222838';
  ctx.fillRect(0, WALL_H - 4, bufW, 4); // baseboard shadow

  // window with night sky
  const wx = 8, wy = 6, ww = Math.min(bufW - 16, 120), wh = 24;
  ctx.fillStyle = '#0a0e1a';
  ctx.fillRect(wx, wy, ww, wh);
  // stars (static positions derived from index)
  ctx.fillStyle = '#9fb4ff';
  for (let k = 0; k < 18; k++) {
    const sx = wx + 3 + ((k * 37) % (ww - 6));
    const sy = wy + 3 + ((k * 19) % (wh - 6));
    const tw = (frame + k) % 7 === 0 ? 0 : 1; // gentle twinkle
    if (tw) ctx.fillRect(sx, sy, 1, 1);
  }
  // moon
  ctx.fillStyle = '#e8ecff';
  ctx.fillRect(wx + ww - 16, wy + 4, 6, 6);
  ctx.fillStyle = '#0a0e1a';
  ctx.fillRect(wx + ww - 14, wy + 3, 4, 4);
  // window frame
  ctx.strokeStyle = '#39425c';
  ctx.lineWidth = 1;
  ctx.strokeRect(wx + 0.5, wy + 0.5, ww - 1, wh - 1);
  ctx.beginPath();
  ctx.moveTo(wx + ww / 2, wy);
  ctx.lineTo(wx + ww / 2, wy + wh);
  ctx.stroke();

  // neon sign blocks on the right
  const sgx = bufW - 60;
  if (sgx > wx + ww + 6) {
    const lit = frame % 16 < 14; // occasional flicker
    ctx.fillStyle = lit ? '#39d98a' : '#1f6e4a';
    for (let b = 0; b < 5; b++) ctx.fillRect(sgx + b * 10, 12, 7, 3);
    ctx.fillStyle = lit ? '#5cd0ff' : '#2a5f73';
    for (let b = 0; b < 5; b++) ctx.fillRect(sgx + b * 10, 18, 7, 3);
  }

  // --- string lights hung across the top of the wall ---
  const bulbCols = ['#ffd166', '#ff5cba', '#5cd0ff', '#39d98a'];
  for (let x = 6; x < bufW - 4; x += 14) {
    const k = (x / 14) | 0;
    ctx.fillStyle = '#2a3142';
    ctx.fillRect(x, 2, 1, 1); // wire tack
    const lit = (frame + k) % 9 !== 0; // gentle twinkle
    ctx.fillStyle = lit ? bulbCols[k % bulbCols.length] : '#3a4150';
    ctx.fillRect(x, 3, 2, 2); // bulb
  }

  // --- wall clock + framed mini-chart in the gap between window and sign ---
  const gapL = wx + ww + 8;
  const gapR = (sgx > wx + ww + 6 ? sgx : bufW) - 6;
  if (gapR - gapL > 14) {
    const ccx = gapL + 5, ccy = 17;
    ctx.fillStyle = '#cdd6e6';
    ctx.fillRect(ccx - 4, ccy - 4, 8, 8); // clock body
    ctx.fillStyle = '#0e1320';
    ctx.fillRect(ccx - 3, ccy - 3, 6, 6); // face
    ctx.fillStyle = '#5cd0ff';
    ctx.fillRect(ccx, ccy - 2, 1, 3); // hour hand
    ctx.fillRect(ccx, ccy, 2, 1); // minute hand
    const fx = gapL + 14;
    if (gapR - fx >= 18) {
      const fy = 9;
      ctx.fillStyle = '#3a4150';
      ctx.fillRect(fx, fy, 18, 15); // frame
      ctx.fillStyle = '#0e1320';
      ctx.fillRect(fx + 1, fy + 1, 16, 13); // mat
      const bars = [4, 8, 5, 10, 7];
      ctx.fillStyle = '#39d98a';
      for (let b = 0; b < bars.length; b++) ctx.fillRect(fx + 2 + b * 3, fy + 13 - bars[b], 2, bars[b]);
    }
  }
}

function drawFloor() {
  // carpet base
  ctx.fillStyle = '#20242f';
  ctx.fillRect(0, WALL_H, bufW, bufH - WALL_H);
  // tile checker
  const ts = 16;
  for (let y = WALL_H; y < bufH; y += ts) {
    for (let x = 0; x < bufW; x += ts) {
      if (((x / ts) + (y / ts)) % 2 === 0) {
        ctx.fillStyle = '#242935';
        ctx.fillRect(x, y, ts, ts);
      }
    }
  }
}

// The modern open-plan room, drawn from the warm palette + the CC0 PixelOffice
// sheet: a wood-plank floor, a concrete feature wall with framed art, floor-to-
// ceiling windows, exposed-ceiling pipes + cylinder pendant lights pooling warm
// light over each cluster, dusty-teal area rugs under the desk neighbourhoods,
// and lounge / greenery zones that breathe between them. Falls back to the
// procedural night office until the sheet finishes loading.
function drawRoom() {
  if (!sheetReady()) { drawFloor(); drawWall(); return; }

  drawWoodFloor();
  drawClusterRugs();
  drawDaylight();
  drawBackWall();
  drawCeiling();
  drawDecorZones();
}

// --- floor: warm wood planks (modern / WeWork vibe) ---
function drawWoodFloor() {
  const plank = 13;
  for (let y = WALL_H, row = 0; y < bufH; y += plank, row++) {
    ctx.fillStyle = row % 2 ? '#bd9159' : '#b1854c'; // alternating board shade
    ctx.fillRect(0, y, bufW, plank);
    ctx.fillStyle = 'rgba(60,34,10,0.30)'; // seam between board rows
    ctx.fillRect(0, y + plank - 1, bufW, 1);
    ctx.fillStyle = 'rgba(60,34,10,0.18)'; // staggered board-end joints
    for (let x = (row % 2 ? 0 : 40); x < bufW; x += 80) ctx.fillRect(x, y, 1, plank - 1);
  }
}

// Muted area rug under each desk cluster — defines the neighbourhood and lets
// the warm wood read as the "circulation" path around it. The rug tone rotates
// across a small palette of muted dusty hues so adjacent neighbourhoods read as
// distinct zones rather than one repeated tile.
const RUG_TONES = [
  { fill: '#46615f', edge: '#3a4f4e' }, // dusty teal
  { fill: '#5a5168', edge: '#473f53' }, // muted plum
  { fill: '#6b5642', edge: '#564536' }, // warm taupe
  { fill: '#4a5a6e', edge: '#3c4a5b' }, // slate blue
];
function drawClusterRugs() {
  clusters.forEach((c) => {
    const rx = c.x + 4, ry = c.y + 4, rw = c.w - 8, rh = c.h - 8;
    const tone = RUG_TONES[hashInt(c.seed) % RUG_TONES.length];
    ctx.fillStyle = tone.fill;
    ctx.fillRect(rx, ry, rw, rh);
    ctx.fillStyle = tone.edge; // bound edge
    ctx.fillRect(rx, ry, rw, 2); ctx.fillRect(rx, ry + rh - 2, rw, 2);
    ctx.fillRect(rx, ry, 2, rh); ctx.fillRect(rx + rw - 2, ry, 2, rh);
    ctx.fillStyle = 'rgba(255,255,255,0.05)'; // faint top sheen
    ctx.fillRect(rx + 3, ry + 3, rw - 6, 1);
    // a thin contrasting inner stripe so rugs read as "designed", not flat felt
    ctx.fillStyle = 'rgba(255,240,208,0.06)';
    ctx.fillRect(rx + 5, ry + 5, rw - 10, rh - 10);
  });
}

// Soft daylight from the windows: warm wash up top fading to a far-corner shadow.
function drawDaylight() {
  const light = ctx.createLinearGradient(0, WALL_H, 0, bufH);
  light.addColorStop(0, 'rgba(255,240,208,0.18)');
  light.addColorStop(0.45, 'rgba(255,240,208,0.04)');
  light.addColorStop(1, 'rgba(35,18,4,0.12)');
  ctx.fillStyle = light;
  ctx.fillRect(0, WALL_H, bufW, bufH - WALL_H);
}

// --- back wall: warm off-white, a concrete feature panel with framed art, a
// run of floor-to-ceiling windows, plus the kitchenette + printer amenities. ---
function drawBackWall() {
  ctx.fillStyle = '#ece3d2';
  ctx.fillRect(0, 0, bufW, WALL_H);
  ctx.fillStyle = 'rgba(120,90,50,0.05)'; // faint paneling lines
  for (let y = 10; y < WALL_H - 8; y += 10) ctx.fillRect(0, y, bufW, 1);

  // a poured-concrete FEATURE panel, centre-ish, hung with framed art (the
  // WeWork art wall). Sized to the room; skipped on very narrow floors.
  let featL = -1, featR = -1;
  if (bufW > 240) {
    const fw = clamp(Math.round(bufW * 0.26), 70, 150);
    featL = Math.round(bufW / 2 - fw / 2);
    featR = featL + fw;
    ctx.fillStyle = '#b9b2a6'; // concrete
    ctx.fillRect(featL, 0, fw, WALL_H - 7);
    ctx.fillStyle = 'rgba(255,255,255,0.05)';
    ctx.fillRect(featL, 0, fw, 2);
    ctx.fillStyle = 'rgba(60,50,40,0.10)'; // subtle form-tie speckle
    for (let k = 0; k < fw; k += 18) { ctx.fillRect(featL + 6 + k, 14, 1, 1); ctx.fillRect(featL + 12 + k, 40, 1, 1); }
    // two framed art panels from the sheet, centred on the concrete
    const aw = sprW('artPanelA');
    blit(ctx, 'artPanelA', Math.round(featL + fw / 2 - aw - 4), 22);
    blit(ctx, 'artPanelB', Math.round(featL + fw / 2 + 4), 22);
  }

  // wood accent rail + baseboard run the full width, in front of everything
  ctx.fillStyle = '#a9763f';
  ctx.fillRect(0, WALL_H - 7, bufW, 4); // wood rail
  ctx.fillStyle = '#7d5630';
  ctx.fillRect(0, WALL_H - 3, bufW, 3); // baseboard

  // floor-to-ceiling windows tiled across the open wall, skipping the feature
  // panel and the amenity bays so glass never overlaps a fixture.
  const winStep = 30;
  const styles = ['windowWide', 'windowWideB'];
  const leftBay = 86; // reserve the left kitchenette bay
  const rightBay = bufW - 50; // reserve the right printer bay
  for (let x = leftBay, k = 0; x + sprW(styles[k % 2]) < rightBay; x += winStep, k++) {
    const w = sprW(styles[k % 2]);
    if (featL >= 0 && x + w > featL - 4 && x < featR + 4) { x = featR + 4 - winStep; continue; }
    blit(ctx, styles[k % 2], x, 6);
  }

  // wall hangings: clock high on the left, a glass board + flags near the bays
  blit(ctx, 'clock', 12, 10);
  if (bufW > 150) {
    blit(ctx, 'glassBoard', 50, 8);
    blit(ctx, 'flagUS', bufW - 30, 8);
    blit(ctx, 'flagUK', bufW - 44, 8);
  }

  // --- amenities standing on the wall/floor line (feet at WALL_H) ---
  // Left bay: the kitchenette stack (vending + water cooler) capped by a plant.
  // Right bay: the printer + a plant. These sit in the bays the windows skip.
  const base = WALL_H - 2;
  let x = 6;
  x += blitStanding(ctx, 'vendDrink', x, base) + 2;
  x += blitStanding(ctx, 'vendSnack', x, base) + 4;
  if (bufW > 200) { x += blitStanding(ctx, 'waterCooler', x, base) + 4; blitStanding(ctx, 'plant', x, base); }
  blitStanding(ctx, 'printer', bufW - 22, base);
  blitStanding(ctx, 'plant', bufW - 42, base);
}

// Exposed industrial ceiling: a red service pipe runs across the top of the
// floor area and cylinder PENDANT LIGHTS hang from it on short cords over each
// cluster + lounge, each dropping a soft warm pool of light onto the zone below
// (the signature WeWork ceiling).
function drawCeiling() {
  // red service pipe just below the wall, with a parallel thinner conduit
  const py = WALL_H + 4;
  ctx.fillStyle = '#c0473a';
  ctx.fillRect(0, py, bufW, 3);
  ctx.fillStyle = 'rgba(255,255,255,0.10)';
  ctx.fillRect(0, py, bufW, 1); // pipe sheen
  ctx.fillStyle = 'rgba(0,0,0,0.22)';
  ctx.fillRect(0, py + 3, bufW, 1);
  ctx.fillStyle = '#8f8a80'; // thin secondary conduit
  ctx.fillRect(0, py + 6, bufW, 1);

  // a pendant over each cluster centre + over each lounge zone; the bulb hangs
  // just below the pipe on a short cord, and casts a wide pool onto the zone.
  const anchors = [
    ...clusters.map((c) => ({ cx: c.x + c.w / 2, poolY: c.y + c.h / 2, pool: c.w * 0.65, ph: c.h })),
    ...decorZones.filter((z) => z.type === 'lounge').map((z) => ({ cx: z.x + z.w / 2, poolY: z.y + z.h * 0.6, pool: z.w * 0.6, ph: z.h })),
  ];
  for (const a of anchors) {
    const cx = Math.round(a.cx);
    // warm light pool centred on the zone beneath the lamp
    const grad = ctx.createRadialGradient(cx, a.poolY, 2, cx, a.poolY, Math.max(28, a.pool));
    grad.addColorStop(0, 'rgba(255,224,150,0.18)');
    grad.addColorStop(0.7, 'rgba(255,224,150,0.05)');
    grad.addColorStop(1, 'rgba(255,224,150,0)');
    ctx.fillStyle = grad;
    ctx.fillRect(cx - a.pool, a.poolY - a.ph / 2, a.pool * 2, a.ph);
    // short cord + cylinder shade hanging from the pipe + a glowing underside
    const sy = py + 7; // shade top, just under the conduit
    ctx.fillStyle = '#2b2b2b';
    ctx.fillRect(cx, py + 2, 1, 5); // short cord
    ctx.fillStyle = '#33373f';
    ctx.fillRect(cx - 3, sy, 6, 6); // cylinder body
    ctx.fillStyle = '#454b55';
    ctx.fillRect(cx - 3, sy, 1, 6); // left edge light
    ctx.fillStyle = '#1d2026';
    ctx.fillRect(cx + 2, sy, 1, 6); // right edge shade
    ctx.fillStyle = frame % 12 === 0 ? '#fff0c0' : '#ffe39a'; // bulb, faint flicker
    ctx.fillRect(cx - 2, sy + 6, 4, 1);
    ctx.fillStyle = 'rgba(255,227,154,0.5)';
    ctx.fillRect(cx - 1, sy + 7, 2, 1);
  }
}

// Draw the social zones the planner sprinkled between clusters: a lounge (couch
// + coffee table + accent chairs on a round rug) or a greenery cluster (planters).
function drawDecorZones() {
  for (const z of decorZones) {
    if (z.type === 'lounge') drawLounge(z);
    else if (z.type === 'collab') drawCollab(z);
    else drawGreenery(z);
  }
}

// A collab / hot-desk zone built around the sheet's blue bench-desk: a shared
// table on a small rug with accent chairs pulled up on either side and a laptop
// or two on top — the "grab a seat and pair" spot of an open-plan office. Uses
// the sprite-sheet desk so the floor's desking isn't purely procedural.
function drawCollab(z) {
  const floorY = z.y + z.h - 6;
  // a small cool-grey task rug to ground the table
  const rx = z.x + 6, rw = z.w - 12, rh = 26, ry = floorY - rh + 4;
  ctx.fillStyle = '#54707b'; // slate blue-grey, distinct from the teal desk rugs
  ctx.fillRect(rx, ry, rw, rh);
  ctx.fillStyle = '#46606a'; ctx.fillRect(rx, ry, rw, 2); ctx.fillRect(rx, ry + rh - 2, rw, 2);
  ctx.fillStyle = 'rgba(255,255,255,0.05)'; ctx.fillRect(rx + 4, ry + 4, rw - 8, 1);
  // the sheet bench-desk, scaled to roughly fill the rug width
  const dw = sprW('deskBench'), dh = sprH('deskBench');
  const dx = Math.round(z.x + z.w / 2 - dw / 2);
  const dy = Math.round(floorY - dh + 2);
  blit(ctx, 'deskBench', dx, dy);
  // a couple of laptops / monitors sitting on the bench (procedural, tiny)
  ctx.fillStyle = '#1c2230'; ctx.fillRect(dx + 12, dy + 4, 8, 5);
  ctx.fillStyle = '#5cd0ff'; ctx.fillRect(dx + 13, dy + 5, 6, 3);
  ctx.fillStyle = '#1c2230'; ctx.fillRect(dx + dw - 22, dy + dh - 12, 8, 5);
  ctx.fillStyle = '#ffd166'; ctx.fillRect(dx + dw - 21, dy + dh - 11, 6, 3);
  // accent chairs pulled up to the long sides (seed picks the colours)
  const chairs = ['chairBlue', 'chairGreen', 'chairOrange', 'chairYellow', 'chairWhite', 'chairGray'];
  blitStanding(ctx, chairs[hashInt(z.seed) % chairs.length], dx - 9, floorY + 1);
  blitStanding(ctx, chairs[hashInt(z.seed + 5) % chairs.length], dx + dw + 1, floorY + 1);
}

// A lounge cluster: a soft sand area rug with a two-seat couch on the left, a
// low coffee table in front of it, an accent chair pulled up facing the table,
// and a potted plant at the back — the WeWork central-lounge motif. Couch +
// chair colour rotate by seed so adjacent lounges don't match.
function drawLounge(z) {
  const floorY = z.y + z.h - 4; // feet line for furniture
  // soft sand area rug under the whole grouping (a quieter, warmer counterpoint
  // to the desk clusters' teal). Rounded by trimming the corners.
  const rx = z.x + 4, rw = z.w - 8, rh = 36, ry = floorY - rh + 4;
  ctx.fillStyle = '#cda871';
  ctx.fillRect(rx + 4, ry, rw - 8, rh);
  ctx.fillRect(rx, ry + 4, rw, rh - 8);
  ctx.fillStyle = '#bd965f'; // bound edge
  ctx.fillRect(rx + 4, ry, rw - 8, 1); ctx.fillRect(rx + 4, ry + rh - 1, rw - 8, 1);
  ctx.fillStyle = 'rgba(255,255,255,0.07)'; // faint inner ring
  ctx.fillRect(rx + 10, ry + 6, rw - 20, 1);

  const couches = ['couchBlue', 'couchGrayWide', 'couchGreen', 'couchOrange'];
  const couch = couches[hashInt(z.seed) % couches.length];
  const cw = sprW(couch);
  // couch anchored toward the left of the rug
  const couchX = Math.round(rx + 6);
  blitStanding(ctx, couch, couchX, floorY);
  // coffee table in front-right of the couch — a small wood slab w/ legs
  const tx = Math.round(couchX + cw - 6), ty = floorY - 8;
  ctx.fillStyle = '#8a5e34'; ctx.fillRect(tx, ty, 18, 5); // top slab
  ctx.fillStyle = '#a5743f'; ctx.fillRect(tx, ty, 18, 1); // top highlight
  ctx.fillStyle = '#5a3d22'; ctx.fillRect(tx + 1, ty + 5, 2, 3); ctx.fillRect(tx + 15, ty + 5, 2, 3); // legs
  // a tiny accent on the table (a mug / small book) keyed off the seed
  ctx.fillStyle = (hashInt(z.seed + 9) % 2) ? '#d8d2c8' : '#c0473a';
  ctx.fillRect(tx + 6, ty - 2, 4, 2);
  // accent chair on the far right, just past the table
  const chairs = ['chairOrange', 'chairYellow', 'chairGreen', 'chairWhite', 'chairBlue'];
  const chair = chairs[hashInt(z.seed + 3) % chairs.length];
  blitStanding(ctx, chair, Math.round(tx + 20), floorY + 1);
  // a plant standing at the back-left corner, behind the couch arm
  blitStanding(ctx, 'plant', Math.round(rx + 1), floorY - 3);
}

// A greenery cluster: a low wood planter box with a couple of plants at
// staggered depths — the open-plan "biophilic" filler the reference leans on.
function drawGreenery(z) {
  const floorY = z.y + z.h - 2;
  const pw = sprW('plant');
  // a long low wood planter box the plants rise out of
  const bx = z.x + 2, bw = z.w - 4, by = floorY - 5;
  ctx.fillStyle = '#6f4d2b'; ctx.fillRect(bx, by, bw, 6);
  ctx.fillStyle = '#8a6238'; ctx.fillRect(bx, by, bw, 2); // lip
  ctx.fillStyle = '#5a3d22'; ctx.fillRect(bx, by + 5, bw, 1); // base shadow
  // two plants, the back one a touch higher so they layer
  blitStanding(ctx, 'plant', Math.round(z.x + 1), floorY - 4);
  blitStanding(ctx, 'plant', Math.round(z.x + z.w - pw - 1), floorY - 1);
}

// Light sheet props on an occupied desk, varied by pod index so the floor isn't
// uniform. A tray sits on the far-left corner (clear of the worker's left hand,
// which is at px0+11) and a folder on the right-front corner (below the monitor
// stand). Both rest their feet on the desk's front edge (deskTop+9) so they read
// as sitting on the near lip of the desk. No-op until the sheet has loaded.
// ponytail: which desks get which prop is keyed off the index (a fixed pattern)
// rather than the agent's seed — keeps it deterministic and easy for the PM to
// eyeball; tune the cadence/placement if it reads too busy or too sparse.
function drawDeskProps(px0, py0, i) {
  if (!sheetReady()) return;
  const deskTop = py0 + 50;
  const lip = deskTop + 9; // feet rest on the desk's front edge band
  const trays = ['trayA', 'trayB'];
  const folders = ['folderRed', 'folderBlue', 'folderGreen'];
  // ~2/3 of desks carry a left tray; folders cycle so colors vary down the rows.
  if (i % 3 !== 2) blitStanding(ctx, trays[i % trays.length], px0 + 2, lip);
  if (i % 2 === 0) blitStanding(ctx, folders[i % folders.length], px0 + POD_W - 15, lip);
}

// Stage a character at a pod's desk. The procedural desk slab top is at py0+50;
// we anchor the character so its anchor (feet for the standing sheet sprites,
// the atlas seat/feet marker for generated ones) lands on a baseline at the
// desk's near edge. The character is drawn AFTER the bodyless workstation, so it
// paints over the desk's front lip — which for a standing worker reads as "at
// the desk", legs in front of the near edge. Centred on the worker centre-x
// (px0+22), left of the monitor (px0+47) so the character never covers its screen.
//
// The static sheet workers are SHORTER standing poses (~21-24px) than the
// generated 34px atlas; a touch-lower baseline keeps their feet near the chair
// so they don't appear to float above the desk.
const SEAT_DX = 22; // = worker centre-x (cx)
const SEAT_BASELINE_ANIM = 58; // generated atlas: seat line just below the desk front edge
const SEAT_BASELINE_STATIC = 62; // standing sheet worker: a hair lower so feet sit at the desk
function drawSeatedCharacter(px0, py0, char, a, i, clockMs) {
  const state = charStateFor(a);
  // per-agent phase so a row of typists doesn't keystroke in lockstep
  const phase = seedOf(a, i) % 17;
  const baseline = char.kind === 'static' ? SEAT_BASELINE_STATIC : SEAT_BASELINE_ANIM;
  drawCharacterState(ctx, px0 + SEAT_DX, py0 + baseline, char, { state, clockMs, phase });
}

// Head-anchored badges (PM crown, selection plumbob, "needs you" bubble) are
// positioned relative to the head top. The procedural worker's head sits at
// py0+6; a seated character's head sits lower, so in hybrid we drop the badge
// anchor by HYBRID_HEAD_DROP to keep the badge hugging the head rather than
// floating in the gap above it.
const HYBRID_HEAD_DROP = 18;
function badgeAnchorY(py0, hasChar) {
  return hasChar ? py0 + HYBRID_HEAD_DROP : py0;
}

function loop(t) {
  frame = Math.floor(t / 130); // ~7.7fps "typing" cadence
  if (ctx && bufW) {
    drawRoom();

    const slots = totalSlots();
    for (let i = 0; i < slots; i++) {
      const o = podOrigin(i);
      const a = agents[i];
      if (a) {
        // background teammates wear their team color; everyone else keeps their
        // roster shirt.
        const shirt = (a.role === 'teammate' && teamColorHex(a.teamColor)) || a.shirt;
        // In hybrid mode, draw a sprite character in the seat; the workstation
        // (chair/desk/monitor/LED/minions) is still drawn by sprites.js but
        // BODYLESS. Falls back to the full procedural worker if no character is
        // available. Animated characters are SEATED sprites that bring their own
        // chair, so suppress the procedural chair for them (noChair) to avoid a
        // double chair; static standing sheet workers keep the procedural chair.
        const char = HYBRID ? characterFor(a, i) : null;
        drawWorker(ctx, o.x, o.y, {
          skin: a.skin,
          hair: a.hair,
          shirt,
          model: a.model,
          activity: a.activity || 'idle',
          state: a.state,
          subagents: a.subagents || [],
          frame,
          seed: seedOf(a, i),
          bodyless: !!char,
          noChair: !!char && char.kind === 'animated',
        });
        if (char) drawSeatedCharacter(o.x, o.y, char, a, i, t);
        drawDeskProps(o.x, o.y, i); // sheet props on the front lip of busy desks
        const badgeY = badgeAnchorY(o.y, !!char); // hug the seated character's head in hybrid
        if (a.role === 'lead') drawLeadBadge(ctx, o.x + 22, badgeY, frame); // PM crown
        // "needs you" bubble for any agent blocked on the user's reply (Control
        // Phase-1 sets awaitingReply). Floats at the head's upper-right, clear of
        // the crown / selection plumbob which sit centred above the head.
        if (a.awaitingReply) drawNeedsYou(ctx, o.x + 22, badgeY, frame);
      } else {
        // vacant desk (only appears if a slot ever outlives its agent)
        drawWorker(ctx, o.x, o.y, { model: '', vacant: true, frame, seed: i + 99 });
      }
    }

    // hover / selection highlights, painted over the workers
    if (hoverIdx >= 0 && hoverIdx !== selIdx && agents[hoverIdx]) {
      const o = podOrigin(hoverIdx);
      drawSelectRing(ctx, o.x, o.y, '#5cd0ff', frame, false);
    }
    if (selIdx >= 0 && agents[selIdx]) {
      const o = podOrigin(selIdx);
      const c = colorFor(agents[selIdx].model);
      drawSelectRing(ctx, o.x, o.y, c.screen, frame, true);
      // the lead already wears a crown at this spot — keep it visible instead of
      // painting the selection plumbob over it (the ring still marks selection).
      if (agents[selIdx].role !== 'lead') {
        const selChar = HYBRID ? characterFor(agents[selIdx], selIdx) : null;
        drawPlumbob(ctx, o.x + 22, badgeAnchorY(o.y, !!selChar), frame);
      }
    }
  }
  requestAnimationFrame(loop);
}
