// sprites.js — procedural pixel-art drawing primitives, rendered into a
// low-resolution buffer and scaled up crisply by CSS (image-rendering:pixelated).
// All coordinates are integers in buffer-pixel space.

export const POD_W = 64;
export const POD_H = 92;

// Color palette per model — keyed by short slug. Falls back to a hash-derived
// color for any model not listed here via `colorFor(model)`.
export const MODEL_COLORS = {
  'opus':   { screen: '#ffd166', glow: 'rgba(255,209,102,0.25)', code: '#fff0c0' },
  'sonnet': { screen: '#5cd0ff', glow: 'rgba(92,208,255,0.25)', code: '#d0f4ff' },
  'haiku':  { screen: '#6cff9a', glow: 'rgba(108,255,154,0.22)', code: '#d6ffe2' },
};

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

// Team-config member colors are CSS-ish words ("blue", "green", …). Map them to
// the office palette so a background teammate's shirt reads as its team color.
const TEAM_COLORS = {
  blue: '#5d9ce0', green: '#5dc98a', yellow: '#e0b05d', purple: '#a87de0',
  red: '#e05d5d', orange: '#e0855d', cyan: '#5dc9c9', pink: '#e07db0', gray: '#8a93a6',
};
export function teamColorHex(word) {
  if (!word) return null;
  return TEAM_COLORS[String(word).toLowerCase()] || null;
}

function hslToHex(h, s, l) {
  s /= 100; l /= 100;
  const k = n => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = n => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  const toHex = v => Math.round(v * 255).toString(16).padStart(2, '0');
  return `#${toHex(f(0))}${toHex(f(8))}${toHex(f(4))}`;
}

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
  const { skin = '#f0c8a0', hair = '#2b2233', shirt = '#5d9ce0', model = '', activity = 'idle', frame = 0, vacant = false, seed = 1, state = null } = opts;
  const t = colorFor(model);
  // working = model generating (types, tier-colored output on screen);
  // shell = a command is running (relaxed, terminal scrolling on screen); idle = still.
  const typing = activity === 'working';
  const shellRunning = activity === 'shell';
  // Brief "thinking" pause in the typing rhythm: a few frames every ~14 where
  // the hands rest (per-agent phase so pods don't pause in unison).
  const typePause = typing && (frame + (seed % 7)) % 14 < 3;

  const cx = px0 + 22; // worker center x
  const deskTop = py0 + 50;

  // ---- per-agent appearance, picked deterministically from seed -------------
  // Draw from a *separate* rng stream than the per-frame animation rng so the
  // look is identical every frame (variety from seed; motion from frame).
  const vr = rng(seed * 2654435761 + 7); // "variant" rng — stable per agent
  const v = {
    hairStyle: Math.floor(vr() * 4), // 0 short, 1 tall/quiff, 2 side-part, 3 bald-ish
    build: vr() < 0.5 ? 0 : vr() < 0.7 ? 1 : 2, // 0 normal, 1 broad, 2 slim
    chair: ['#2b313e', '#3a2e3e', '#2e3a32', '#3a352b', '#2e2e44'][Math.floor(vr() * 5)],
    glasses: vr() < 0.32,
    headphones: vr() < 0.28,
    beard: vr() < 0.24,
    cap: 0, // resolved below so it can't collide with headphones
    deskItemL: Math.floor(vr() * 5), // 0 none,1 mug,2 plant,3 sticky,4 papers
    deskItemR: Math.floor(vr() * 5),
    blinkPhase: Math.floor(vr() * 11), // staggers blinks across agents
    breathPhase: Math.floor(vr() * 6),
    sips: vr() < 0.5, // takes occasional coffee sips when not typing
  };
  // A cap/beanie occasionally replaces visible hair-top (skip if headphones).
  if (!v.headphones && vr() < 0.22) v.cap = vr() < 0.5 ? 1 : 2; // 1 cap, 2 beanie

  // Gentle idle micro-motions — only when NOT actively typing, so working stays
  // crisp. Cadence is slow (frame increments ~every 130ms).
  const fp = frame + v.breathPhase;
  const breath = !typing && fp % 8 < 4 ? 1 : 0; // 1px torso/head rise
  const headDy = vacant ? 0 : breath; // head bobs with breathing
  // Occasional slow head turn while idle (a few frames every ~40 frames).
  const idleState = !typing && !shellRunning && !vacant;
  const turnCycle = (frame + seed) % 40;
  const headTurn = idleState && turnCycle < 4 ? 1 : idleState && turnCycle >= 20 && turnCycle < 24 ? -1 : 0;
  // Eye blink: a 1-frame closure on a per-agent staggered schedule.
  const blink = !vacant && (frame + v.blinkPhase) % 11 === 0;
  // Coffee sip: lift mug to face for a couple frames now and then (idle/shell).
  const sipCycle = (frame + seed * 3) % 36;
  const sipping = !vacant && v.sips && !typing && sipCycle < 3;

  // chair back (per-agent upholstery color)
  const chair = v.chair;
  px(ctx, cx - 11, py0 + 16, 22, 34, chair);
  px(ctx, cx - 11, py0 + 16, 22, 3, shade(chair, 18));
  px(ctx, cx - 13, py0 + 22, 3, 22, shade(chair, -16));
  px(ctx, cx + 10, py0 + 22, 3, 22, shade(chair, -16));

  if (!vacant) {
    const hdx = headTurn; // shorthand: horizontal head/face offset
    const hy = py0 + 6 - headDy; // head top y, lifts slightly on breath-in
    // hair / headwear (top + sides), shifted with the head turn
    if (v.cap === 2) {
      // beanie: rounded knit hugging the skull
      px(ctx, cx - 7 + hdx, hy, 14, 5, hair);
      px(ctx, cx - 7 + hdx, hy + 4, 14, 1, shade(hair, 24)); // knit band
      px(ctx, cx - 8 + hdx, hy + 5, 3, 4, hair);
      px(ctx, cx + 5 + hdx, hy + 5, 3, 4, hair);
    } else if (v.cap === 1) {
      // ball cap: crown + forward brim
      px(ctx, cx - 7 + hdx, hy, 14, 4, hair);
      px(ctx, cx - 7 + hdx, hy + 3, 16, 1, shade(hair, -18)); // brim
      px(ctx, cx - 8 + hdx, hy + 5, 3, 4, hair);
      px(ctx, cx + 5 + hdx, hy + 5, 3, 4, hair);
    } else if (v.hairStyle === 3) {
      // close-cropped / receding: thin top, longer sides
      px(ctx, cx - 6 + hdx, hy + 2, 12, 3, hair);
      px(ctx, cx - 8 + hdx, hy + 4, 3, 8, hair);
      px(ctx, cx + 5 + hdx, hy + 4, 3, 8, hair);
    } else if (v.hairStyle === 1) {
      // tall quiff
      px(ctx, cx - 6 + hdx, hy - 2, 12, 8, hair);
      px(ctx, cx - 3 + hdx, hy - 4, 6, 3, hair);
      px(ctx, cx - 8 + hdx, hy + 4, 3, 8, hair);
      px(ctx, cx + 5 + hdx, hy + 4, 3, 8, hair);
    } else if (v.hairStyle === 2) {
      // side part: asymmetric top + a longer side sweep
      px(ctx, cx - 7 + hdx, hy, 14, 6, hair);
      px(ctx, cx - 2 + hdx, hy, 2, 3, shade(hair, 20)); // part line
      px(ctx, cx - 8 + hdx, hy + 4, 3, 9, hair);
      px(ctx, cx + 5 + hdx, hy + 4, 3, 7, hair);
    } else {
      // 0: classic short
      px(ctx, cx - 7 + hdx, hy, 14, 6, hair);
      px(ctx, cx - 8 + hdx, hy + 4, 3, 8, hair);
      px(ctx, cx + 5 + hdx, hy + 4, 3, 8, hair);
    }
    // face (follows the head turn + breath)
    const fy = py0 + 10 - headDy;
    px(ctx, cx - 6 + hdx, fy, 12, 11, skin);
    px(ctx, cx - 6 + hdx, fy, 12, 2, shade(skin, 18)); // forehead highlight
    // eyes — drawn open, then closed to a thin lid line on a blink frame
    if (blink) {
      px(ctx, cx - 4 + hdx, fy + 6, 2, 1, shade(skin, -35));
      px(ctx, cx + 2 + hdx, fy + 6, 2, 1, shade(skin, -35));
    } else {
      px(ctx, cx - 4 + hdx, fy + 5, 2, 2, '#1a1a22');
      px(ctx, cx + 2 + hdx, fy + 5, 2, 2, '#1a1a22');
    }
    // glasses: rims around the eyes + a bridge
    if (v.glasses) {
      const gc = '#20242d';
      px(ctx, cx - 5 + hdx, fy + 4, 4, 4, gc);
      px(ctx, cx - 4 + hdx, fy + 5, 2, 2, skin); // lens hollow (redrawn below if blink)
      px(ctx, cx + 1 + hdx, fy + 4, 4, 4, gc);
      px(ctx, cx + 2 + hdx, fy + 5, 2, 2, skin);
      px(ctx, cx - 1 + hdx, fy + 5, 2, 1, gc); // bridge
      // re-stamp pupils on top of the cleared lens (open eyes only)
      if (!blink) {
        px(ctx, cx - 4 + hdx, fy + 5, 2, 2, '#1a1a22');
        px(ctx, cx + 2 + hdx, fy + 5, 2, 2, '#1a1a22');
      }
    }
    // beard: shadow along the jaw + chin
    if (v.beard) {
      px(ctx, cx - 6 + hdx, fy + 8, 12, 3, shade(skin, -45));
      px(ctx, cx - 4 + hdx, fy + 9, 8, 2, shade(skin, -55));
    }
    // mouth (focused when generating; hidden behind a mug mid-sip)
    if (!sipping) {
      px(ctx, cx - 2 + hdx, fy + 9, 4, 1, typing ? shade(skin, -40) : shade(skin, -25));
    }
    // headphones: ear cups + an over-the-head band
    if (v.headphones) {
      px(ctx, cx - 8 + hdx, fy + 3, 2, 5, '#23262e'); // left cup
      px(ctx, cx + 6 + hdx, fy + 3, 2, 5, '#23262e'); // right cup
      px(ctx, cx - 8 + hdx, py0 + 5 - headDy, 16, 2, '#33373f'); // band
    }
    // neck
    px(ctx, cx - 2 + hdx, py0 + 21 - headDy, 4, 3, shade(skin, -15));

    // torso (shirt), widening trapezoid — width varies with body build
    const bw = v.build === 1 ? 1 : v.build === 2 ? -1 : 0; // broad/slim delta
    const ty = py0 + 24 - breath; // whole torso rises a touch on a breath
    px(ctx, cx - 6 - bw, ty, 12 + bw * 2, 3, shirt);
    px(ctx, cx - 7 - bw, ty + 3, 14 + bw * 2, 4, shirt);
    px(ctx, cx - 8 - bw, ty + 7, 16 + bw * 2, 8, shirt);
    px(ctx, cx + 3 + bw, ty, 5, 15, shade(shirt, -28)); // right-side shade
    px(ctx, cx - 1, ty, 2, 15, shade(shirt, 16)); // collar/placket

    // arms reaching to keyboard — hands only bob while actively generating
    // (and not during a brief thinking pause)
    const lh = typing && !typePause ? (frame % 2 ? 0 : 1) : 0; // left hand bob
    const rh = typing && !typePause ? (frame % 2 ? 1 : 0) : 0; // right hand bob
    px(ctx, cx - 10 - bw, py0 + 30, 3, 12, shade(shirt, -10)); // left arm
    px(ctx, cx + 7 + bw, py0 + 30, 3, 12, shade(shirt, -10)); // right arm
    if (sipping) {
      // right hand raises a coffee mug toward the mouth instead of typing
      px(ctx, cx + 7 + bw, py0 + 28, 3, 6, shade(shirt, -10)); // bent forearm
      px(ctx, cx + 3, fy + 7, 4, 4, '#d8d2c8'); // mug at the lips
      px(ctx, cx + 3, fy + 8, 1, 2, '#6f5240'); // coffee
      px(ctx, cx - 11, deskTop - 4, 4, 3, skin); // left hand rests on desk
    } else {
      px(ctx, cx - 11, deskTop - 4 + lh, 4, 3, skin); // left hand
      px(ctx, cx + 7 + bw, deskTop - 4 + rh, 4, 3, skin); // right hand
    }
  }

  // desk slab
  px(ctx, px0 + 2, deskTop, POD_W - 4, 7, '#6b4f3a');
  px(ctx, px0 + 2, deskTop, POD_W - 4, 2, '#7d5f48');
  px(ctx, px0 + 2, deskTop + 7, POD_W - 4, 3, '#4a3526'); // front edge

  // keyboard
  px(ctx, cx - 9, deskTop - 1, 18, 3, '#1c2029');
  px(ctx, cx - 8, deskTop - 1, 16, 1, '#2a3340');

  // per-agent desk clutter: a small item to the left of the keyboard and one in
  // the gap before the monitor. Both sit on the desk surface (base at deskTop),
  // well above the name-plate / minion strip. Suppress the left mug while the
  // worker is sipping (the mug is in hand then).
  if (!vacant) {
    if (!sipping) drawDeskItem(ctx, px0 + 5, deskTop, v.deskItemL, t, frame);
    // right slot tucks into the keyboard→monitor gap; the monitor (drawn next)
    // overlaps any 1px spill so a wider prop reads as sitting beside the screen.
    drawDeskItem(ctx, px0 + 32, deskTop, v.deskItemR, t, frame);
  }

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
      // during a thinking pause the output settles to a blinking caret
      if (typePause && frame % 2) px(ctx, mx - 7, mTop + 11, 2, 1, t.code);
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

// A small desk prop, drawn sitting on the desk surface with its base at baseY.
// kind: 0 none, 1 coffee mug, 2 tiny plant, 3 sticky note, 4 paper stack.
// Each rises only a few px above the desk — never near the plate/minion strip.
function drawDeskItem(ctx, x, baseY, kind, t, frame) {
  if (kind === 1) {
    // coffee mug with a handle and a wisp of steam
    px(ctx, x, baseY - 5, 5, 5, '#d8d2c8'); // cup
    px(ctx, x, baseY - 5, 5, 1, '#ece7df'); // rim highlight
    px(ctx, x + 1, baseY - 4, 3, 1, '#6f5240'); // coffee surface
    px(ctx, x + 5, baseY - 4, 1, 2, '#b7b1a7'); // handle
    if (frame % 4 < 2) px(ctx, x + 2, baseY - 7, 1, 1, '#9aa0ad'); // steam
  } else if (kind === 2) {
    // tiny potted plant
    px(ctx, x + 1, baseY - 3, 4, 3, '#9c5a2e'); // pot
    px(ctx, x + 1, baseY - 3, 4, 1, '#b06a36'); // pot rim
    px(ctx, x, baseY - 6, 2, 3, '#3f9a55'); // left frond
    px(ctx, x + 2, baseY - 7, 2, 4, '#4cb364'); // center frond
    px(ctx, x + 4, baseY - 5, 2, 2, '#3f9a55'); // right frond
  } else if (kind === 3) {
    // sticky note on a small stand, faintly catching the monitor glow
    px(ctx, x, baseY - 5, 5, 5, '#f4d35e');
    px(ctx, x, baseY - 5, 5, 1, '#ffe27a');
    px(ctx, x + 1, baseY - 3, 3, 1, shade('#f4d35e', -60)); // scribble
    px(ctx, x + 1, baseY - 1, 2, 1, t.glow ? shade(t.screen, -30) : '#888');
  } else if (kind === 4) {
    // stack of papers, slightly skewed
    px(ctx, x, baseY - 2, 6, 2, '#e8e4dc');
    px(ctx, x + 1, baseY - 4, 6, 2, '#f2efe9');
    px(ctx, x + 1, baseY - 4, 6, 1, '#ffffff');
    px(ctx, x + 2, baseY - 3, 3, 1, '#b9b4ab'); // text line
  }
  // kind 0: nothing
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

// Sims-style selection brackets drawn just inside a pod's bounds. `strong`
// (the selected agent) also gets a faint full outline that pulses.
export function drawSelectRing(ctx, px0, py0, color, frame, strong) {
  const x0 = px0 + 1, y0 = py0 + 1, x1 = px0 + POD_W - 2, y1 = py0 + POD_H - 2;
  const L = 7;
  ctx.globalAlpha = strong ? 1 : 0.55;
  ctx.fillStyle = color;
  // four L-shaped corner brackets
  ctx.fillRect(x0, y0, L, 1); ctx.fillRect(x0, y0, 1, L); // top-left
  ctx.fillRect(x1 - L + 1, y0, L, 1); ctx.fillRect(x1, y0, 1, L); // top-right
  ctx.fillRect(x0, y1, L, 1); ctx.fillRect(x0, y1 - L + 1, 1, L); // bottom-left
  ctx.fillRect(x1 - L + 1, y1, L, 1); ctx.fillRect(x1, y1 - L + 1, 1, L); // bottom-right
  if (strong) {
    ctx.globalAlpha = frame % 4 < 2 ? 0.18 : 0.1; // gentle pulse
    ctx.fillRect(x0, y0, x1 - x0, 1); ctx.fillRect(x0, y1, x1 - x0, 1);
    ctx.fillRect(x0, y0, 1, y1 - y0); ctx.fillRect(x1, y0, 1, y1 - y0);
  }
  ctx.globalAlpha = 1;
}

// The PM / team lead's distinct marker: a small gold crown bobbing above the
// head, so the orchestrator reads as "in charge" at a glance vs the workers.
//
// ponytail: this is the PM's look — a deliberately SIMPLE default. To restyle
// (gold ring, "LEAD" pennant, halo, larger desk, …) swap THIS one function;
// nothing else encodes the lead's appearance. cx = worker center x, podTopY =
// pod top in buffer coords.
export function drawLeadBadge(ctx, cx, podTopY, frame) {
  const bob = frame % 8 < 4 ? 0 : 1;
  const y = podTopY - 8 - bob;
  const g = '#ffd166', hl = '#fff0c0', dk = '#c79a2e';
  // crown band
  px(ctx, cx - 4, y + 4, 9, 2, g);
  px(ctx, cx - 4, y + 5, 9, 1, dk); // base shade
  // three points with little gem dots
  px(ctx, cx - 4, y + 1, 2, 3, g);
  px(ctx, cx, y, 2, 4, g);
  px(ctx, cx + 4, y + 1, 2, 3, g);
  px(ctx, cx - 4, y + 1, 1, 1, hl); // highlights
  px(ctx, cx, y, 1, 1, hl);
  px(ctx, cx, y + 2, 1, 1, '#ff5cba'); // center gem
}

// A little bobbing green plumbob hovering above the selected worker's head.
export function drawPlumbob(ctx, cx, podTopY, frame) {
  const bob = frame % 8 < 4 ? 0 : 1;
  const y = podTopY - 7 - bob;
  const g = '#39d98a', hl = '#9affc4', dk = '#1f8a5a';
  px(ctx, cx - 1, y, 2, 1, g);
  px(ctx, cx - 2, y + 1, 4, 1, g);
  px(ctx, cx - 3, y + 2, 6, 1, g);
  px(ctx, cx - 2, y + 3, 4, 1, g);
  px(ctx, cx - 1, y + 4, 2, 1, g);
  px(ctx, cx - 1, y + 1, 1, 2, hl); // highlight
  px(ctx, cx + 1, y + 2, 1, 1, dk); // shade
}
