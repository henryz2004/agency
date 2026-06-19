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
  window.addEventListener('resize', positionLabels);
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
  // CSS height follows aspect ratio; width is 100% of container.
  canvas.style.aspectRatio = `${bufW} / ${bufH}`;
  ctx.imageSmoothingEnabled = false;
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
    const dotClass = a.status === 'busy' ? 'busy' : a.state === 'done' ? 'done' : 'idle';
    const label = a.task || a.chatName || a.lastPrompt;
    const taskLine = label ? `<div class="plate-task" title="${escapeHtml(label)}">“${escapeHtml(label)}”</div>` : '';
    const doneBadge = a.state === 'done' ? ' <span class="plate-badge done">✓ done</span>' : '';
    const subN = (a.subagents || []).length;
    const subBadge = subN ? ` <span class="plate-badge sub">🤖 ${subN} subagent${subN > 1 ? 's' : ''}</span>` : '';
    el.innerHTML = `
      <div class="plate-row">
        <span class="dot ${dotClass}"></span>
        <span class="plate-name">${escapeHtml(a.name)}</span>
        <span class="plate-tier" style="color:${t.screen}">${t.label}</span>
      </div>
      <div class="plate-sub">${escapeHtml(a.title)} · <span class="dept">${escapeHtml(a.project)}</span></div>
      ${taskLine}
      <div class="plate-up">⏱ <span class="up" data-started="${a.startedAt || ''}">${fmtUptime(a.uptimeMs)}</span>${doneBadge}${subBadge}</div>
    `;
    labelLayer.appendChild(el);
  });
  positionLabels();
}

function positionLabels() {
  if (!canvas || !labelLayer) return;
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
          busy: a.status === 'busy',
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
