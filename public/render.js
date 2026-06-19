// render.js — draws the pixel office into a low-res buffer, then lets the user
// pan/zoom it like a Sims camera. The canvas + scaled name tags live inside a
// transformed `.world` element, so tags scale WITH the floor and can never
// overlap. Full per-agent detail surfaces in a readable, screen-space info card
// on hover / click.

import { POD_W, POD_H, drawWorker, drawSelectRing, drawPlumbob, colorFor } from './sprites.js';
import { sheetReady, blit, blitStanding, sprW } from './office-atlas.js';

const WALL_H = 72; // back-wall band: tall enough for standing furniture + windows
const MARGIN = 14;
const COL_GAP = 14; // horizontal breathing room between desks
const ROW_GAP = 34; // vertical band beneath each desk that holds its name tag
const FIT_PAD = 28; // slack left around the office when fitting to the frame

let canvas, ctx, labelLayer, world, viewport, card, recenterBtn;
let agents = [];
let cols = 1, rows = 1, bufW = 0, bufH = 0;
let frame = 0;
let reservedRight = 0; // px reserved on the right for the hovering panel

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

// choose a pleasing column count for N desks
function colsFor(n) {
  if (n <= 1) return 1;
  if (n <= 2) return 2;
  if (n <= 6) return 3;
  if (n <= 12) return 4;
  return 5;
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

// ---- layout + camera -----------------------------------------------------

function layout() {
  const n = agents.length;
  const gridSlots = Math.max(n, 4); // never show fewer than a small office
  cols = colsFor(gridSlots);
  rows = Math.ceil(gridSlots / cols);

  bufW = MARGIN * 2 + cols * POD_W + (cols - 1) * COL_GAP;
  bufH = WALL_H + MARGIN + rows * (POD_H + ROW_GAP) + MARGIN;

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
  const c = i % cols;
  const r = Math.floor(i / cols);
  return {
    x: MARGIN + c * (POD_W + COL_GAP),
    y: WALL_H + MARGIN + r * (POD_H + ROW_GAP),
  };
}

function totalSlots() { return rows * cols; }

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
    el.style.top = `${o.y + POD_H + 4}px`;
    el.innerHTML =
      `<span class="dot ${dotClassFor(a)}"></span>` +
      `<span class="tag-name">${escapeHtml(first)}</span>` +
      `<span class="tag-chip" style="background:${c.screen}"></span>`;
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

  card.innerHTML =
    `<div class="ic-head"><span class="dot ${dotClassFor(a)}"></span>` +
      `<span class="ic-name">${escapeHtml(a.name)}</span>` +
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

// Furnished room from the CC0 PixelOffice sheet: blue-tile floor, light back
// wall with tiled windows + wall decor, and a row of amenities (vending, water
// cooler, plants, couch, printer) standing against the wall. Falls back to the
// procedural night office until the sheet finishes loading.
function drawRoom() {
  if (!sheetReady()) { drawFloor(); drawWall(); return; }

  // --- floor: bright blue tile w/ offset brick mortar (matches the pack) ---
  ctx.fillStyle = '#3a9fe0';
  ctx.fillRect(0, WALL_H, bufW, bufH - WALL_H);
  ctx.fillStyle = 'rgba(255,255,255,0.10)';
  for (let y = WALL_H; y < bufH; y += 12) ctx.fillRect(0, y, bufW, 1);
  ctx.fillStyle = 'rgba(0,0,0,0.12)';
  for (let y = WALL_H; y < bufH; y += 12) {
    const off = ((y / 12) | 0) % 2 ? 0 : 18;
    for (let x = off; x < bufW; x += 36) ctx.fillRect(x, y, 1, 11);
  }

  // --- back wall: light interior panel w/ baseboard ---
  ctx.fillStyle = '#cdd3da';
  ctx.fillRect(0, 0, bufW, WALL_H);
  ctx.fillStyle = 'rgba(0,0,0,0.05)';
  for (let y = 9; y < WALL_H - 6; y += 9) ctx.fillRect(0, y, bufW, 1);
  ctx.fillStyle = '#aeb5bf';
  ctx.fillRect(0, WALL_H - 3, bufW, 3); // baseboard

  // windows tiled along the upper wall to fill any width
  const winStep = 46;
  for (let x = 10; x + sprW('windowWide') < bufW - 6; x += winStep) {
    blit(ctx, 'windowWide', x, 6);
  }
  // a few wall hangings between the windows
  blit(ctx, 'clock', Math.round(bufW / 2 - 9), 9);
  if (bufW > 120) {
    blit(ctx, 'flagUS', 30, 30);
    blit(ctx, 'flagUK', 46, 30);
    blit(ctx, 'picture', bufW - 26, 28);
    blit(ctx, 'whiteboard', bufW - 64, 8);
  }

  // --- amenities standing on the wall/floor line (feet at WALL_H) ---
  const base = WALL_H + 1;
  let x = 6;
  x += blitStanding(ctx, 'vendDrink', x, base) + 2;
  x += blitStanding(ctx, 'vendSnack', x, base) + 4;
  x += blitStanding(ctx, 'waterCooler', x, base) + 6;
  blitStanding(ctx, 'plant', x, base);
  // right side: a couch + printer + a plant
  blitStanding(ctx, 'printer', bufW - 22, base);
  blitStanding(ctx, 'plant', bufW - 42, base);
  if (bufW > 200) blitStanding(ctx, 'couchBlue', Math.round(bufW * 0.46), base);
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
        drawWorker(ctx, o.x, o.y, {
          skin: a.skin,
          hair: a.hair,
          shirt: a.shirt,
          model: a.model,
          activity: a.activity || 'idle',
          state: a.state,
          subagents: a.subagents || [],
          frame,
          seed: (a.pid || i + 1) | 0,
        });
      } else {
        // vacant desk
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
      drawPlumbob(ctx, o.x + 22, o.y, frame);
    }
  }
  requestAnimationFrame(loop);
}
