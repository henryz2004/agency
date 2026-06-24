// sound.js — two INDEPENDENT audio channels for the office:
//   1. SFX  — synthesized "busy office" keyboard clatter via the Web Audio API.
//             Zero asset files: each keystroke is a short filtered noise burst. The
//             clatter rate/intensity scales with how many agents are generating;
//             fully silent when nobody is working.
//   2. MUSIC — a shuffled, endless lo-fi playlist (real mp3s under public/music/),
//             played with a plain HTMLAudioElement (no AudioContext).
//
// The two channels enable/disable, persist, and start/stop ENTIRELY separately:
// music-on/SFX-off and SFX-on/music-off are both valid. Each has its own toggle
// function and its own localStorage key.
//
// BROWSER RULES: the AudioContext is created/resumed ONLY after a user gesture
// (a toggle). Music play() is likewise only kicked off from a gesture. Nothing
// autoplays; everything fails soft; prefs persist in localStorage and default OFF.

// New per-channel pref keys. We migrate the OLD combined key (`agency.sound`)
// forward: if a returning user had the single combined toggle ON, both channels
// default ON so they aren't surprised by the split.
const SFX_KEY = 'agency.sfx';
const MUSIC_KEY = 'agency.music';
const LEGACY_KEY = 'agency.sound';

// --- SFX (Web Audio keyboard clatter) ---------------------------------------

let ctx = null; // AudioContext, created lazily on first SFX enable
let master = null; // master gain -> destination
let noiseBuffer = null; // shared white-noise buffer for key clicks

let sfxEnabled = false; // whether the clatter engine is actively running
let workingCount = 0; // agents currently generating
let scheduler = null; // setInterval handle for the clatter loop
let nextKeyAt = 0; // ctx.currentTime of the next scheduled keystroke

// Keep the master volume LOW and tasteful.
const MASTER_VOL = 0.18;

// --- ambient music (real lo-fi tracks) --------------------------------------
// Four mastered lo-fi tracks under public/music/, played as a shuffled, endless
// playlist whenever MUSIC is on. Uses a plain HTMLAudioElement (NOT Web Audio) so
// it needs no AudioContext and fails soft on its own; the volume is ramped by hand
// for a gentle fade in/out. Started/stopped from the music toggle — a user gesture,
// so the browser autoplay policy is satisfied.
const MUSIC_VOL = 0.5;        // comfortable background level for the recordings
const MUSIC_FADE_MS = 1800;   // fade-in (a quicker fade-out on stop) so it never jars
const TRACKS = [
  '/music/Midnight_Desk.mp3',
  '/music/The_Plant_Beside_the_Door.mp3',
  '/music/Three_AM_Window.mp3',
  '/music/Console_Morning.mp3',
];
let musicEnabled = false;     // whether the playlist channel is on
let musicEl = null;           // current HTMLAudioElement, or null when off
let musicQueue = [];          // shuffled play order (indices into TRACKS)
let musicPos = 0;             // position within musicQueue
let musicMisses = 0;          // consecutive load failures → give up if all unreachable
let currentTrack = '';        // pretty name of the track currently sounding (or '')

// Track-change subscribers. We BOTH dispatch a window CustomEvent and call any
// registered callbacks, so consumers can pick whichever is simpler.
const trackListeners = new Set();
const TRACK_EVENT = 'agency:track';

// --- pref read/write (per channel, fail-soft) -------------------------------

function readKey(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function writeKey(key, on) {
  try {
    localStorage.setItem(key, on ? 'on' : 'off');
  } catch {
    /* ignore */
  }
}

// Resolve the persisted pref for a channel, applying the one-time legacy
// migration: if the new key was never written but the old combined key was ON,
// treat this channel as ON.
function loadChannelPref(key) {
  const v = readKey(key);
  if (v === 'on') return true;
  if (v === 'off') return false;
  // No new-key value yet → fall back to the legacy combined pref.
  return readKey(LEGACY_KEY) === 'on';
}

// --- SFX engine -------------------------------------------------------------

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
  if (!ctx || !sfxEnabled || workingCount <= 0) return;
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

// ---- shuffled-playlist player ----------------------------------------------

// Fisher–Yates shuffle of a copy (Math.random is fine in the browser).
function shuffled(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// Turn '/music/The_Plant_Beside_the_Door.mp3' → 'The Plant Beside the Door'.
function prettyTrack(path) {
  try {
    const file = path.split('/').pop() || path;
    return file.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').trim();
  } catch {
    return '';
  }
}

// Record the now-playing track name and notify subscribers (event + callbacks).
function setCurrentTrack(name) {
  currentTrack = name || '';
  try {
    window.dispatchEvent(new CustomEvent(TRACK_EVENT, { detail: { track: currentTrack } }));
  } catch {
    /* ignore — no window or CustomEvent */
  }
  trackListeners.forEach((fn) => {
    try { fn(currentTrack); } catch { /* a bad listener must not break playback */ }
  });
}

// Linearly ramp el.volume to `target` over `ms`, then run `done`. Tracks its own
// interval on el._fadeId so a teardown can cancel an in-flight fade.
function ramp(el, target, ms, done) {
  const start = el.volume;
  const t0 = Date.now();
  const id = setInterval(() => {
    const k = ms <= 0 ? 1 : Math.min(1, (Date.now() - t0) / ms);
    el.volume = Math.max(0, Math.min(1, start + (target - start) * k));
    if (k >= 1) {
      clearInterval(id);
      if (el._fadeId === id) el._fadeId = 0;
      if (done) done();
    }
  }, 40);
  el._fadeId = id;
}

// Pause + release an element, cancelling any fade still running on it.
function killEl(el) {
  if (!el) return;
  if (el._fadeId) { clearInterval(el._fadeId); el._fadeId = 0; }
  try { el.pause(); el.removeAttribute('src'); el.load(); } catch { /* fail-soft */ }
}

// Start the playlist: shuffle, then play the first track. Needs no AudioContext;
// called from toggleMusic (a user gesture) so play() is allowed. Fail-soft.
function startMusic() {
  if (musicEl) return;
  try {
    musicQueue = shuffled(TRACKS.map((_, i) => i));
    musicPos = 0;
    musicMisses = 0;
    playCurrent();
  } catch {
    musicEl = null; // fail-soft
    setCurrentTrack('');
  }
}

// Load + fade in the current queue track; auto-advance on end, skip on error.
function playCurrent() {
  const path = TRACKS[musicQueue[musicPos]];
  const el = new Audio(path);
  el.preload = 'auto';
  el.volume = 0.0001;
  el._fadeId = 0;
  musicEl = el;
  // Announce the name as soon as it actually starts sounding (and reset misses).
  el.addEventListener('playing', () => {
    if (musicEl !== el) return;
    musicMisses = 0;
    setCurrentTrack(prettyTrack(path));
  });
  el.addEventListener('ended', () => { if (musicEnabled && musicEl === el) advanceTrack(); });
  el.addEventListener('error', () => {
    if (!musicEnabled || musicEl !== el) return;
    musicMisses++;
    if (musicMisses >= TRACKS.length) { stopMusic(); return; } // all unreachable → give up
    advanceTrack();
  });
  const p = el.play();
  if (p && p.catch) p.catch(() => { /* autoplay blocked / decode fail — fail-soft */ });
  ramp(el, MUSIC_VOL, MUSIC_FADE_MS); // gentle fade-in
}

// Move to the next track, reshuffling each time the set completes so the order
// varies. Tears down the finished element first.
function advanceTrack() {
  const old = musicEl;
  musicEl = null;
  killEl(old);
  musicPos++;
  if (musicPos >= musicQueue.length) {
    musicQueue = shuffled(TRACKS.map((_, i) => i));
    musicPos = 0;
  }
  playCurrent();
}

// Fade out + release the current track. Detaches musicEl immediately so a quick
// re-enable builds a fresh element without the old one's fade fighting it (the
// fade-out runs on the detached element's own _fadeId and pauses it when done).
function stopMusic() {
  const el = musicEl;
  setCurrentTrack(''); // clear the now-playing label immediately
  if (!el) return;
  musicEl = null;
  if (el._fadeId) { clearInterval(el._fadeId); el._fadeId = 0; }
  ramp(el, 0.0001, 400, () => killEl(el));
}

// Suspend the AudioContext to save CPU when SFX is off — deferred so the clatter
// tail finishes, and guarded so a quick re-enable doesn't get muted.
function maybeSuspendContext() {
  setTimeout(() => {
    if (!sfxEnabled && ctx && ctx.state === 'running') ctx.suspend();
  }, 450);
}

// --- public API ------------------------------------------------------------

export function isSfxEnabled() {
  return sfxEnabled;
}
export function isMusicEnabled() {
  return musicEnabled;
}

// Pretty name of the track currently sounding, or '' when music is off.
export function currentTrackName() {
  return currentTrack;
}

// Subscribe to track changes. Returns an unsubscribe function. The callback is
// invoked with the pretty track name (or '' when music stops). Consumers may
// instead listen for the `agency:track` CustomEvent on window — both fire.
export function onTrackChange(fn) {
  if (typeof fn !== 'function') return () => {};
  trackListeners.add(fn);
  return () => trackListeners.delete(fn);
}

// Read the persisted prefs WITHOUT creating any audio or starting anything
// (safe pre-gesture). Returns the desired pre-gesture button state for both
// channels; the engines stay off until the first user gesture toggles them.
// The actual start happens in toggleSfx/toggleMusic.
export function initSoundPref() {
  return {
    sfx: loadChannelPref(SFX_KEY),
    music: loadChannelPref(MUSIC_KEY),
  };
}

// Toggle the SFX (keyboard clatter) channel. MUST be called from a user gesture
// handler. Creates/resumes the AudioContext on first enable. Returns new state.
export function toggleSfx() {
  sfxEnabled = !sfxEnabled;
  writeKey(SFX_KEY, sfxEnabled);
  if (sfxEnabled) {
    ensureContext();
    if (ctx && ctx.state === 'suspended') ctx.resume();
    startScheduler();
  } else {
    stopScheduler();
    maybeSuspendContext();
  }
  return sfxEnabled;
}

// Toggle the MUSIC (lo-fi playlist) channel. MUST be called from a user gesture
// handler so play() is allowed. Returns the new enabled state.
export function toggleMusic() {
  musicEnabled = !musicEnabled;
  writeKey(MUSIC_KEY, musicEnabled);
  if (musicEnabled) {
    startMusic();
  } else {
    stopMusic();
  }
  return musicEnabled;
}

// Called each poll/frame with the current count of working agents.
export function updateSound(count) {
  workingCount = Math.max(0, count | 0);
}
