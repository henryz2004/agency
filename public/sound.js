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

// --- ambient music (procedural lo-fi pad) -----------------------------------
// A slow, very quiet chord pad that drifts through a I–vi–ii–V progression via
// smooth pitch glides (the oscillators never restart → seamless, no loop seam).
// Its own warm lowpass + a slow "breathing" cutoff LFO give it lo-fi texture. It
// shares the AudioContext with the SFX but has a SEPARATE path to destination, so
// it never clashes with the keyboard clatter. Starts/stops with the sound toggle.
const MUSIC_VOL = 0.16;      // pad bus gain — deliberately low (texture, not a song)
const CHORD_MS = 11000;      // advance the chord every ~11s (slow drift)
const CHORD_GLIDE = 4;       // seconds to glide between chords (no clicks)
const CHORDS = [             // 4 voices each, mid register, warm close voicings
  [261.63, 329.63, 392.00, 493.88], // Cmaj7  (C E G B)
  [220.00, 261.63, 329.63, 392.00], // Am7    (A C E G)
  [293.66, 349.23, 440.00, 523.25], // Dm7    (D F A C)
  [196.00, 246.94, 293.66, 349.23], // G7     (G B D F)
];
let music = null;            // live pad graph, or null when off

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

// Build + fade in the ambient pad. Needs a live AudioContext (so it's only ever
// called from toggleSound, i.e. after a user gesture). Fail-soft: any Web Audio
// hiccup just leaves the pad off without touching the SFX.
function startMusic() {
  if (music || !ctx) return;
  try {
    // a warm lowpass for the pad, its cutoff slowly "breathing" via an LFO
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 900;
    lp.Q.value = 0.6;
    const gain = ctx.createGain();
    gain.gain.value = 0.0001;        // start silent, fade in
    lp.connect(gain);
    gain.connect(ctx.destination);   // SEPARATE path from the SFX master
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 0.06;      // ~16s breath
    const lfoGain = ctx.createGain();
    lfoGain.gain.value = 260;        // cutoff sweeps ~640–1160 Hz
    lfo.connect(lfoGain);
    lfoGain.connect(lp.frequency);
    lfo.start();
    // four sustained pad voices (the opening chord), gently detuned for warmth
    const voices = CHORDS[0].map((f, i) => {
      const osc = ctx.createOscillator();
      osc.type = 'triangle';
      osc.frequency.value = f;
      osc.detune.value = (i - 1.5) * 5; // -7.5..+7.5 cents → soft chorus
      const vg = ctx.createGain();
      vg.gain.value = 0.22;
      osc.connect(vg);
      vg.connect(lp);
      osc.start();
      return { osc };
    });
    music = { lp, gain, lfo, voices, chordIdx: 0, chordTimer: null };
    const t = ctx.currentTime;
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.linearRampToValueAtTime(MUSIC_VOL, t + 2.5); // gentle fade-in
    music.chordTimer = setInterval(driftChord, CHORD_MS);  // seamless drift
  } catch {
    music = null; // fail-soft
  }
}

// Glide every voice to the next chord's notes — smooth, no restart, no click.
function driftChord() {
  const m = music;
  if (!m || !ctx) return;
  m.chordIdx = (m.chordIdx + 1) % CHORDS.length;
  const chord = CHORDS[m.chordIdx];
  const t = ctx.currentTime;
  m.voices.forEach((v, i) => {
    v.osc.frequency.cancelScheduledValues(t);
    v.osc.frequency.setValueAtTime(v.osc.frequency.value, t);
    v.osc.frequency.linearRampToValueAtTime(chord[i], t + CHORD_GLIDE);
  });
}

// Fade out + tear down the pad. Detaches `music` immediately so a quick re-enable
// builds a fresh graph without colliding with this teardown.
function stopMusic() {
  const m = music;
  if (!m) return;
  music = null;
  if (m.chordTimer) clearInterval(m.chordTimer);
  if (!ctx) return;
  try {
    const t = ctx.currentTime;
    m.gain.gain.cancelScheduledValues(t);
    m.gain.gain.setValueAtTime(m.gain.gain.value, t);
    m.gain.gain.linearRampToValueAtTime(0.0001, t + 0.3);
    m.voices.forEach((v) => v.osc.stop(t + 0.4));
    m.lfo.stop(t + 0.4);
  } catch {
    /* already gone — fail-soft */
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
    startMusic(); // ambient pad rides alongside the clatter
  } else {
    stopScheduler();
    stopMusic();
    // Defer the CPU-saving suspend so the music fade + clatter tail finish first
    // (skipped if a quick re-enable raced us — guarded by the live `enabled`).
    setTimeout(() => { if (!enabled && ctx && ctx.state === 'running') ctx.suspend(); }, 450);
  }
  return enabled;
}

// Called each poll/frame with the current count of working agents.
export function updateSound(count) {
  workingCount = Math.max(0, count | 0);
}
