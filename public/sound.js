// sound.js — synthesized "busy office" keyboard clatter via the Web Audio API.
// Zero asset files: each keystroke is a short filtered noise burst. The clatter
// rate/intensity scales with how many agents are actively generating. Fully
// silent when nobody is working.
//
// BROWSER RULES: the AudioContext is created/resumed ONLY after a user gesture
// (the toggle button). It never autoplays. Pref is persisted in localStorage and
// defaults to OFF.

const PREF_KEY = 'agency.sound';

let ctx = null; // AudioContext, created lazily on first enable
let master = null; // master gain -> destination
let noiseBuffer = null; // shared white-noise buffer for key clicks

let enabled = false; // whether the audio engine is actively running
let pendingPref = false; // persisted pref read at load, before any gesture
let workingCount = 0; // agents currently generating
let scheduler = null; // setInterval handle for the clatter loop
let nextKeyAt = 0; // ctx.currentTime of the next scheduled keystroke

// Keep the master volume LOW and tasteful.
const MASTER_VOL = 0.18;

function loadPref() {
  try {
    return localStorage.getItem(PREF_KEY) === 'on';
  } catch {
    return false;
  }
}
function savePref(on) {
  try {
    localStorage.setItem(PREF_KEY, on ? 'on' : 'off');
  } catch {
    /* ignore */
  }
}

// Build a small white-noise buffer once; reused for every keystroke.
function makeNoiseBuffer(ac) {
  const len = Math.floor(ac.sampleRate * 0.12); // ~120ms is plenty per click
  const buf = ac.createBuffer(1, len, ac.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
  return buf;
}

// Create the audio graph. Must run inside a user gesture.
function ensureContext() {
  if (ctx) return;
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return;
  ctx = new AC();
  noiseBuffer = makeNoiseBuffer(ctx);
  master = ctx.createGain();
  master.gain.value = MASTER_VOL;
  // A gentle low-pass over the whole bus keeps it soft, not hissy.
  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.value = 5200;
  lp.Q.value = 0.3;
  master.connect(lp);
  lp.connect(ctx.destination);
}

// One synthesized key click: a short filtered noise burst with a fast decay.
function playKey(time, gain) {
  if (!ctx || !noiseBuffer) return;
  const src = ctx.createBufferSource();
  src.buffer = noiseBuffer;

  // Band-pass-ish shaping so each click sounds like a key, not static.
  const bp = ctx.createBiquadFilter();
  bp.type = 'bandpass';
  bp.frequency.value = 1400 + Math.random() * 2200; // vary pitch per key
  bp.Q.value = 0.7 + Math.random() * 0.8;

  const env = ctx.createGain();
  const peak = gain * (0.6 + Math.random() * 0.5);
  const dur = 0.018 + Math.random() * 0.03; // 18–48ms clicks
  env.gain.setValueAtTime(0.0001, time);
  env.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), time + 0.002);
  env.gain.exponentialRampToValueAtTime(0.0001, time + dur);

  src.connect(bp);
  bp.connect(env);
  env.connect(master);
  src.start(time);
  src.stop(time + dur + 0.01);
}

// Schedule keystrokes a little ahead of the clock for smooth timing. Called on
// an interval; it fills the lookahead window with clicks whose density tracks
// the working-agent count.
const LOOKAHEAD = 0.18; // seconds to schedule ahead
function tickScheduler() {
  if (!ctx || !enabled || workingCount <= 0) return;
  const now = ctx.currentTime;
  if (nextKeyAt < now) nextKeyAt = now;

  // Keys/sec scales with working agents: a brisk-but-not-frantic typist each.
  // ~7 keys/sec per working agent, with a soft cap so a big team isn't a roar.
  const kps = Math.min(38, 6.5 * workingCount + 1.5);
  // Slightly lower per-key gain as the floor gets busier (overlap sums up).
  const perKeyGain = Math.max(0.35, 1 / (1 + workingCount * 0.45));

  while (nextKeyAt < now + LOOKAHEAD) {
    // Humanize: exponential-ish gaps around the mean interval.
    const meanGap = 1 / kps;
    const gap = meanGap * (0.45 + Math.random() * 1.3);
    playKey(nextKeyAt, perKeyGain);
    nextKeyAt += gap;
  }
}

function startScheduler() {
  if (scheduler != null) return;
  scheduler = setInterval(tickScheduler, 60);
}
function stopScheduler() {
  if (scheduler != null) {
    clearInterval(scheduler);
    scheduler = null;
  }
}

// --- public API ------------------------------------------------------------

export function isSoundEnabled() {
  return enabled;
}

// Read the persisted pref WITHOUT creating any audio or marking the engine
// enabled (safe pre-gesture). The returned value is for painting the button;
// the engine stays off until the first user gesture calls toggleSound().
export function initSoundPref() {
  pendingPref = loadPref();
  return pendingPref;
}

// Toggle on/off. MUST be called from a user gesture handler. Creates/resumes
// the AudioContext on first enable. Returns the new enabled state.
export function toggleSound() {
  // If the saved pref was ON but the engine never started (returning user's
  // first click), honor the pref and turn ON rather than flipping to OFF.
  if (pendingPref && !enabled && !ctx) {
    enabled = true;
  } else {
    enabled = !enabled;
  }
  pendingPref = false; // pref now reflected by the live engine state
  savePref(enabled);
  if (enabled) {
    ensureContext();
    if (ctx && ctx.state === 'suspended') ctx.resume();
    startScheduler();
  } else {
    stopScheduler();
    // Drop scheduled tail by letting it fade naturally; suspend to save CPU.
    if (ctx && ctx.state === 'running') ctx.suspend();
  }
  return enabled;
}

// Called each poll/frame with the current count of working agents.
export function updateSound(count) {
  workingCount = Math.max(0, count | 0);
}
