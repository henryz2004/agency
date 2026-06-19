// sprites.js — procedural pixel-art drawing primitives, rendered into a
// low-resolution buffer and scaled up crisply by CSS (image-rendering:pixelated).
// All coordinates are integers in buffer-pixel space.

export const POD_W = 64;
export const POD_H = 92;

// Glow / accent color per model tier.
export const TIER = {
  opus: { screen: '#ffd166', glow: 'rgba(255,209,102,0.25)', code: '#fff0c0', label: 'OPUS' },
  sonnet: { screen: '#5cd0ff', glow: 'rgba(92,208,255,0.25)', code: '#d0f4ff', label: 'SONNET' },
  haiku: { screen: '#6cff9a', glow: 'rgba(108,255,154,0.22)', code: '#d6ffe2', label: 'HAIKU' },
  unknown: { screen: '#b98cff', glow: 'rgba(185,140,255,0.22)', code: '#ecdcff', label: '—' },
};

// Tiny seeded PRNG so per-frame "code rain" is animated but stable within a frame.
function rng(seed) {
  let s = seed >>> 0 || 1;
  return () => {
    s = (Math.imul(s, 1103515245) + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };
}

function px(ctx, x, y, w, h, c) {
  ctx.fillStyle = c;
  ctx.fillRect(x | 0, y | 0, w | 0, h | 0);
}

function shade(hex, amt) {
  const h = hex.replace('#', '');
  const n = parseInt(h.length === 3 ? h.replace(/(.)/g, '$1$1') : h, 16);
  let r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  r = Math.max(0, Math.min(255, r + amt));
  g = Math.max(0, Math.min(255, g + amt));
  b = Math.max(0, Math.min(255, b + amt));
  return `#${((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1)}`;
}

// Draw one workstation: chair, seated worker (animated when busy), desk, and a
// glowing monitor whose color encodes the model tier.
// (px0, py0) = top-left of the pod cell in buffer coords.
export function drawWorker(ctx, px0, py0, opts) {
  const { skin = '#f0c8a0', hair = '#2b2233', shirt = '#5d9ce0', tier = 'unknown', activity = 'idle', frame = 0, vacant = false, seed = 1, state = null } = opts;
  const t = TIER[tier] || TIER.unknown;
  // working = model generating (types, tier-colored output on screen);
  // shell = a command is running (relaxed, terminal scrolling on screen); idle = still.
  const typing = activity === 'working';
  const shellRunning = activity === 'shell';

  const cx = px0 + 22; // worker center x
  const deskTop = py0 + 50;

  // chair back
  px(ctx, cx - 11, py0 + 16, 22, 34, '#2b313e');
  px(ctx, cx - 11, py0 + 16, 22, 3, '#3a4150');
  px(ctx, cx - 13, py0 + 22, 3, 22, '#252b36');
  px(ctx, cx + 10, py0 + 22, 3, 22, '#252b36');

  if (!vacant) {
    // hair (top + sides)
    px(ctx, cx - 7, py0 + 6, 14, 6, hair);
    px(ctx, cx - 8, py0 + 10, 3, 8, hair);
    px(ctx, cx + 5, py0 + 10, 3, 8, hair);
    // face
    px(ctx, cx - 6, py0 + 10, 12, 11, skin);
    px(ctx, cx - 6, py0 + 10, 12, 2, shade(skin, 18)); // forehead highlight
    // eyes
    px(ctx, cx - 4, py0 + 15, 2, 2, '#1a1a22');
    px(ctx, cx + 2, py0 + 15, 2, 2, '#1a1a22');
    // mouth (focused when generating)
    px(ctx, cx - 2, py0 + 19, 4, 1, typing ? shade(skin, -40) : shade(skin, -25));
    // neck
    px(ctx, cx - 2, py0 + 21, 4, 3, shade(skin, -15));

    // torso (shirt), widening trapezoid
    px(ctx, cx - 6, py0 + 24, 12, 3, shirt);
    px(ctx, cx - 7, py0 + 27, 14, 4, shirt);
    px(ctx, cx - 8, py0 + 31, 16, 8, shirt);
    px(ctx, cx + 3, py0 + 24, 5, 15, shade(shirt, -28)); // right-side shade
    px(ctx, cx - 1, py0 + 24, 2, 15, shade(shirt, 16)); // collar/placket

    // arms reaching to keyboard — hands only bob while actively generating
    const lh = typing ? (frame % 2 ? 0 : 1) : 0; // left hand bob
    const rh = typing ? (frame % 2 ? 1 : 0) : 0; // right hand bob
    px(ctx, cx - 10, py0 + 30, 3, 12, shade(shirt, -10)); // left arm
    px(ctx, cx + 7, py0 + 30, 3, 12, shade(shirt, -10)); // right arm
    px(ctx, cx - 11, deskTop - 4 + lh, 4, 3, skin); // left hand
    px(ctx, cx + 7, deskTop - 4 + rh, 4, 3, skin); // right hand
  }

  // desk slab
  px(ctx, px0 + 2, deskTop, POD_W - 4, 7, '#6b4f3a');
  px(ctx, px0 + 2, deskTop, POD_W - 4, 2, '#7d5f48');
  px(ctx, px0 + 2, deskTop + 7, POD_W - 4, 3, '#4a3526'); // front edge

  // keyboard
  px(ctx, cx - 9, deskTop - 1, 18, 3, '#1c2029');
  px(ctx, cx - 8, deskTop - 1, 16, 1, '#2a3340');

  // monitor on the right side of the desk
  const mx = px0 + 47;
  const mTop = py0 + 22;
  // glow halo
  ctx.fillStyle = t.glow;
  ctx.fillRect(mx - 12, mTop - 3, 24, 22);
  // bezel
  px(ctx, mx - 10, mTop, 20, 16, '#0d0f14');
  px(ctx, mx - 10, mTop, 20, 16, '#0d0f14');
  // screen background depends on what's happening on it
  const TERM = '#8bd450'; // terminal green for a running shell
  if (vacant) {
    px(ctx, mx - 8, mTop + 2, 16, 12, '#11141b');
  } else if (typing) {
    px(ctx, mx - 8, mTop + 2, 16, 12, shade(t.screen, -10)); // model output, tier-tinted
  } else if (shellRunning) {
    px(ctx, mx - 8, mTop + 2, 16, 12, '#0b130d'); // dark terminal
  } else {
    px(ctx, mx - 8, mTop + 2, 16, 12, shade(t.screen, -70)); // dim
  }
  // on-screen content
  if (!vacant) {
    if (typing) {
      // model output: tier-colored code rain
      const rand = rng(seed * 31 + frame);
      for (let i = 0; i < 5; i++) {
        const ly = mTop + 3 + Math.floor(rand() * 10);
        const lx = mx - 7 + Math.floor(rand() * 4);
        const lw = 2 + Math.floor(rand() * 8);
        px(ctx, lx, ly, Math.min(lw, mx + 7 - lx), 1, t.code);
      }
    } else if (shellRunning) {
      // terminal log scrolling upward + a blinking cursor
      for (let i = 0; i < 4; i++) {
        const ly = mTop + 3 + ((i * 3 + frame) % 11);
        const r = rng(seed * 17 + i);
        const lw = 3 + Math.floor(r() * 8);
        px(ctx, mx - 7, ly, Math.min(lw, 14), 1, TERM);
      }
      if (frame % 2) px(ctx, mx - 7, mTop + 12, 2, 1, TERM);
    } else {
      // idle: a couple of dim static lines
      px(ctx, mx - 7, mTop + 5, 6, 1, shade(t.code, -60));
      px(ctx, mx - 7, mTop + 9, 4, 1, shade(t.code, -60));
    }
  }
  // stand
  px(ctx, mx - 2, mTop + 16, 4, 3, '#3a4150');
  px(ctx, mx - 5, mTop + 19, 10, 2, '#2b313e');

  // status LED: green pulse = generating, amber pulse = shell running,
  // steady cyan = finished, gray = idle
  if (!vacant) {
    let on;
    if (typing) on = frame % 2 ? '#39d98a' : '#1f7d52';
    else if (shellRunning) on = frame % 2 ? '#ffb454' : '#9c6a1f';
    else if (state === 'done') on = '#5cd0ff';
    else on = '#4a5568';
    px(ctx, px0 + 6, deskTop + 2, 3, 3, on);
  }

  // currently-running subagents huddle on the floor in front of the desk
  const subs = vacant ? [] : opts.subagents || [];
  if (subs.length) {
    const n = Math.min(subs.length, 4);
    const spacing = 9;
    const startX = px0 + Math.round((POD_W - n * spacing) / 2) + 1;
    for (let i = 0; i < n; i++) {
      drawMinion(ctx, startX + i * spacing, deskTop + 21, (frame + i) % 2);
    }
  }
}

// A tiny teal "helper" figure representing a running subagent.
function drawMinion(ctx, x, feetY, bob) {
  const y = feetY - bob;
  px(ctx, x + 1, y - 9, 4, 2, '#1f2a33'); // hair
  px(ctx, x + 1, y - 8, 4, 3, '#f0c8a0'); // head
  px(ctx, x + 2, y - 7, 1, 1, '#10141a'); // eye
  px(ctx, x, y - 5, 6, 4, '#2bb0aa'); // teal body
  px(ctx, x + 4, y - 5, 2, 4, '#1f8a85'); // body shade
  px(ctx, x + 1, y - 1, 1, 1, '#171b22'); // legs
  px(ctx, x + 4, y - 1, 1, 1, '#171b22');
}

// A single pixel "head" used for the headcount comparison row.
export function drawHead(ctx, x, y, { skin = '#f0c8a0', hair = '#2b2233', shirt = '#5d9ce0' } = {}) {
  px(ctx, x + 1, y, 6, 2, hair);
  px(ctx, x, y + 2, 8, 2, hair);
  px(ctx, x + 1, y + 2, 6, 4, skin);
  px(ctx, x + 2, y + 4, 1, 1, '#1a1a22');
  px(ctx, x + 5, y + 4, 1, 1, '#1a1a22');
  px(ctx, x, y + 6, 8, 3, shirt);
}
