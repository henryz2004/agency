// render.js — draws the pixel office into a low-res buffer (scaled crisply by
// CSS) and overlays crisp HTML name plates positioned over each desk. Owns its
// own animation loop and a 1s tick that updates live uptimes.

import { POD_W, POD_H, drawWorker, TIER } from './sprites.js';

const WALL_H = 40;
const MARGIN = 8;

let canvas, ctx, labelLayer;
let agents = [];
let cols = 1, rows = 1, bufW = 0, bufH = 0;
let frame = 0;
let zoom = 1; // user zoom multiplier on top of the fit-to-frame scale
let reservedRight = 0; // px reserved on the right for the hovering panel

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

export function initOffice(canvasEl, labelLayerEl) {
  canvas = canvasEl;
  ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = false;
  labelLayer = labelLayerEl;
  window.addEventListener('resize', () => fitCanvas());
  initHoverTooltip();
  requestAnimationFrame(loop);
  setInterval(tickUptimes, 1000);
}

export function setAgents(next) {
  agents = next || [];
  layout();
  buildLabels();
}

// Compute grid + buffer size, then size the canvas backing store.
function layout() {
  // Render every live agent, padding only the last row so the grid is
  // rectangular, with a small minimum so a quiet office still looks like one.
  const n = agents.length;
  const gridSlots = Math.max(n, 4); // never show fewer than a 2x2-ish office
  cols = colsFor(gridSlots);
  rows = Math.ceil(gridSlots / cols); // last row gets padded with vacant desks

  bufW = MARGIN * 2 + cols * POD_W;
  bufH = WALL_H + MARGIN + rows * POD_H + MARGIN;
  canvas.width = bufW;
  canvas.height = bufH;
  ctx.imageSmoothingEnabled = false;
  fitCanvas();
}

// ---- fit + zoom ----------------------------------------------------------

// Size the on-screen canvas to fit the available floor area (minus the space
// reserved for the hovering panel), times the user zoom factor. Small offices
// scale up; large ones scale down so everything fits without scrolling.
function fitCanvas() {
  if (!canvas || !bufW || !bufH) return;
  const frame = canvas.parentElement;
  if (!frame) return;
  const pad = 10; // .floor-frame padding
  const availW = Math.max(40, frame.clientWidth - pad * 2 - reservedRight);
  const availH = Math.max(40, frame.clientHeight - pad * 2);
  const fit = Math.min(availW / bufW, availH / bufH);
  const eff = Math.max(0.05, Math.min(fit, 5) * zoom);
  canvas.style.width = Math.round(bufW * eff) + 'px';
  canvas.style.height = Math.round(bufH * eff) + 'px';
  positionLabels();
}

// Reserve horizontal space on the right (for the hovering stats panel) + refit.
export function setReservedRight(px) {
  reservedRight = Math.max(0, px || 0);
  fitCanvas();
}

export function zoomBy(factor) {
  zoom = Math.min(3, Math.max(0.3, zoom * factor));
  fitCanvas();
}

export function zoomFit() {
  zoom = 1;
  fitCanvas();
}

function podOrigin(i) {
  const c = i % cols;
  const r = Math.floor(i / cols);
  return {
    x: MARGIN + c * POD_W,
    y: WALL_H + MARGIN + r * POD_H,
  };
}

function totalSlots() {
  return rows * cols;
}

// ---- name plates (HTML overlay) ------------------------------------------

function buildLabels() {
  labelLayer.innerHTML = '';
  agents.forEach((a, i) => {
    const el = document.createElement('div');
    el.className = 'plate';
    el.dataset.i = String(i);
    const t = TIER[a.tier] || TIER.unknown;
    const dotClass =
      a.activity === 'working' ? 'busy' : a.activity === 'shell' ? 'shell' : a.state === 'done' ? 'done' : 'idle';
    // Chat name moved to the hover tooltip (see ensureTooltip / canvas mousemove).
    const doneBadge = a.state === 'done' ? ' <span class="plate-badge done">✓ done</span>' : '';
    const runBadge = a.activity === 'shell' ? ' <span class="plate-badge run">⚙ shell</span>' : '';
    const subN = (a.subagents || []).length;
    const subBadge = subN ? ` <span class="plate-badge sub">🤖 ${subN} subagent${subN > 1 ? 's' : ''}</span>` : '';
    const srcBadge = a.source === 'opencode' ? ' <span class="plate-badge oc">opencode</span>' : '';
    el.innerHTML = `
      <div class="plate-row">
        <span class="dot ${dotClass}"></span>
        <span class="plate-name">${escapeHtml(a.name)}</span>
        <span class="plate-tier" style="color:${t.screen}">${t.label}</span>${srcBadge}
      </div>
      <div class="plate-sub">${escapeHtml(a.title)} · <span class="dept">${escapeHtml(a.project)}</span></div>
      <div class="plate-up">⏱ <span class="up" data-started="${a.startedAt || ''}">${fmtUptime(a.uptimeMs)}</span>${doneBadge}${runBadge}${subBadge}</div>
    `;
    labelLayer.appendChild(el);
  });
  positionLabels();
}

function positionLabels() {
  if (!canvas || !labelLayer) return;
  // keep the (absolute) label layer exactly over the canvas, which may be
  // centered and zoomed within the floor frame.
  labelLayer.style.left = canvas.offsetLeft + 'px';
  labelLayer.style.top = canvas.offsetTop + 'px';
  labelLayer.style.width = canvas.clientWidth + 'px';
  labelLayer.style.height = canvas.clientHeight + 'px';
  const scale = canvas.clientWidth / (bufW || 1);
  const plates = labelLayer.querySelectorAll('.plate');
  plates.forEach((el) => {
    const i = Number(el.dataset.i);
    const o = podOrigin(i);
    const cxBuf = o.x + POD_W / 2;
    const cyBuf = o.y + 74; // just under the desk + subagent huddle
    el.style.left = `${cxBuf * scale}px`;
    el.style.top = `${cyBuf * scale}px`;
  });
}

function tickUptimes() {
  if (!labelLayer) return;
  const now = Date.now();
  labelLayer.querySelectorAll('.up').forEach((el) => {
    const started = Number(el.dataset.started);
    if (started) el.textContent = fmtUptime(now - started);
  });
}

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

// ---- chat-name hover tooltip (canvas overlay) ----------------------------

let tooltipEl = null;
let hoverInit = false;

function ensureTooltip() {
  if (tooltipEl) return tooltipEl;
  // one-time stylesheet for the tooltip + its lines
  if (!document.getElementById('agency-tooltip-style')) {
    const style = document.createElement('style');
    style.id = 'agency-tooltip-style';
    style.textContent = `
      .agency-tooltip {
        position: absolute;
        z-index: 9999;
        pointer-events: none;
        max-width: 320px;
        padding: 4px 8px;
        background: rgba(8, 11, 18, 0.96);
        border: 1px solid #222c40;
        border-radius: 4px;
        box-shadow: 0 4px 14px rgba(0, 0, 0, 0.5);
        font-family: 'VT323', ui-monospace, monospace;
        font-size: 16px;
        line-height: 1.15;
        white-space: nowrap;
        display: none;
      }
      .agency-tooltip .tt-name { color: #ffd166; }
      .agency-tooltip .tt-sub { color: #8aa0c0; font-size: 14px; margin-top: 2px; }
    `;
    document.head.appendChild(style);
  }
  tooltipEl = document.createElement('div');
  tooltipEl.className = 'agency-tooltip';
  document.body.appendChild(tooltipEl);
  return tooltipEl;
}

function hideTooltip() {
  if (tooltipEl) tooltipEl.style.display = 'none';
}

// Map client coords → buffer coords, find which pod the cursor is over.
function podAtClient(clientX, clientY) {
  const rect = canvas.getBoundingClientRect();
  const scale = (canvas.clientWidth || rect.width) / (bufW || 1);
  if (!scale) return -1;
  const bx = (clientX - rect.left) / scale;
  const by = (clientY - rect.top) / scale;
  const slots = totalSlots();
  for (let i = 0; i < slots; i++) {
    const o = podOrigin(i);
    if (bx >= o.x && bx < o.x + POD_W && by >= o.y && by < o.y + POD_H) return i;
  }
  return -1;
}

function initHoverTooltip() {
  if (hoverInit || !canvas) return;
  hoverInit = true;
  canvas.addEventListener('mousemove', (e) => {
    const i = podAtClient(e.clientX, e.clientY);
    const a = i >= 0 ? agents[i] : null;
    const chat = a && (a.task || a.chatName || a.lastPrompt);
    if (!chat) {
      hideTooltip();
      return;
    }
    const tip = ensureTooltip();
    const t = TIER[a.tier] || TIER.unknown;
    // Secondary line: model-tier label, plus lastPrompt when it differs.
    let sub = t && t.label ? escapeHtml(t.label) : '';
    if (a.lastPrompt && a.lastPrompt !== chat) {
      sub += `${sub ? ' · ' : ''}${escapeHtml(a.lastPrompt)}`;
    }
    tip.innerHTML =
      `<div class="tt-name">${escapeHtml(chat)}</div>` + (sub ? `<div class="tt-sub">${sub}</div>` : '');
    tip.style.display = 'block';
    // Position just above/right of the cursor; lift it so it clears the monitor.
    tip.style.left = `${e.clientX + 12}px`;
    tip.style.top = `${e.clientY - tip.offsetHeight - 8}px`;
  });
  canvas.addEventListener('mouseleave', hideTooltip);
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

function loop(t) {
  frame = Math.floor(t / 130); // ~7.7fps "typing" cadence
  if (ctx && bufW) {
    drawFloor();
    drawWall();

    const slots = totalSlots();
    for (let i = 0; i < slots; i++) {
      const o = podOrigin(i);
      const a = agents[i];
      if (a) {
        drawWorker(ctx, o.x, o.y, {
          skin: a.skin,
          hair: a.hair,
          shirt: a.shirt,
          tier: a.tier,
          activity: a.activity || 'idle',
          state: a.state,
          subagents: a.subagents || [],
          frame,
          seed: (a.pid || i + 1) | 0,
        });
      } else {
        // vacant desk
        drawWorker(ctx, o.x, o.y, { tier: 'unknown', vacant: true, frame, seed: i + 99 });
      }
    }
  }
  requestAnimationFrame(loop);
}
