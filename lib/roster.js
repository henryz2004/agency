// roster.js — assign each session a stable identity: a name, a job title keyed
// to its model tier, an avatar palette, and a hire date. Identities are derived
// deterministically from the sessionId (so they're stable even before the file
// is written) and persisted to data/roster.json to record tenure.

import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './paths.js';

const ROSTER_PATH = path.join(DATA_DIR, 'roster.json');

const FIRST = [
  'Ada', 'Ravi', 'Mona', 'Kenji', 'Lena', 'Otis', 'Priya', 'Theo', 'Yara', 'Cole',
  'Nina', 'Dax', 'Ines', 'Bram', 'Suki', 'Ezra', 'Vera', 'Knox', 'Tara', 'Joon',
  'Remy', 'Fynn', 'Wren', 'Iris', 'Beau', 'Sol', 'Hana', 'Milo', 'Faye', 'Ace',
];
const LAST = [
  'Vance', 'Okoro', 'Sato', 'Reyes', 'Novak', 'Kapoor', 'Mertz', 'Holt', 'Ferro',
  'Lund', 'Cruz', 'Bose', 'Pike', 'Calder', 'Ono', 'Frost', 'Wells', 'Drake',
  'Marsh', 'Vega', 'Sloan', 'Quill', 'Rhodes', 'Tran', 'Voss', 'Hale', 'Ng', 'Booth',
];

// Job titles by model tier — the office hierarchy.
const TITLES = {
  opus: ['Principal Engineer', 'Staff Architect', 'Lead Engineer', 'Distinguished Eng'],
  sonnet: ['Senior Engineer', 'Software Engineer II', 'Product Engineer', 'Full-Stack Dev'],
  haiku: ['Junior Engineer', 'Associate Dev', 'Intern', 'Apprentice'],
  unknown: ['Contractor', 'Specialist', 'Generalist'],
};

// Avatar shirt/hair palettes — picked deterministically per agent.
const SHIRTS = [
  '#e05d5d', '#5d9ce0', '#5dc98a', '#e0b05d', '#a87de0', '#e07db0',
  '#5dc9c9', '#9bd45d', '#e0855d', '#7d8fe0',
];
const HAIRS = ['#2b2233', '#5a3a26', '#3a2e22', '#1f2a33', '#4a2233', '#332b1f', '#26333a'];
const SKINS = ['#f0c8a0', '#e8b890', '#d8a070', '#c08858', '#a87048', '#8a5a3a'];

function hash(str) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

function tierFor(model) {
  if (!model) return 'unknown';
  const m = model.toLowerCase();
  if (m.includes('opus')) return 'opus';
  if (m.includes('sonnet')) return 'sonnet';
  if (m.includes('haiku')) return 'haiku';
  if (m.includes('fable')) return 'opus';
  return 'unknown';
}

let roster = null;

// Deterministically pick a "First Last" name from the hash, probing the name
// space until we find one no other chat already owns — so each chat is a
// distinct, persistent person even when two sessionIds hash near each other.
function uniqueName(h, id) {
  const taken = new Set(
    Object.entries(roster || {})
      .filter(([k]) => k !== id)
      .map(([, v]) => v.name)
  );
  const total = FIRST.length * LAST.length;
  let fi = h % FIRST.length;
  let li = (h >>> 8) % LAST.length;
  for (let n = 0; n < total; n++) {
    const name = `${FIRST[fi]} ${LAST[li]}`;
    if (!taken.has(name)) return name;
    li = (li + 1) % LAST.length;
    if (li === (h >>> 8) % LAST.length) fi = (fi + 1) % FIRST.length;
  }
  // name space exhausted (>784 chats) — disambiguate with a short suffix
  return `${FIRST[h % FIRST.length]} ${LAST[(h >>> 8) % LAST.length]} ${id.slice(0, 4)}`;
}

function load() {
  if (roster) return;
  try {
    roster = JSON.parse(fs.readFileSync(ROSTER_PATH, 'utf8'));
  } catch {
    roster = {};
  }
}

function save() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(ROSTER_PATH, JSON.stringify(roster, null, 2));
  } catch {
    /* best effort */
  }
}

// Tier ranking so a momentarily-null model never demotes an agent's title.
const TIER_RANK = { unknown: 0, haiku: 1, sonnet: 2, opus: 3 };

// Get (or mint) the identity for a session. `model` refines the job title and
// is allowed to change the tier over the session's life.
export function identityFor(sessionId, model, firstSeenAt) {
  load();
  const id = sessionId || 'anon';
  const h = hash(id);
  const tier = tierFor(model);

  let rec = roster[id];
  let dirty = false;
  if (!rec) {
    rec = {
      name: uniqueName(h, id),
      skin: SKINS[(h >>> 3) % SKINS.length],
      hair: HAIRS[(h >>> 11) % HAIRS.length],
      shirt: SHIRTS[(h >>> 5) % SHIRTS.length],
      hiredAt: firstSeenAt || Date.now(),
      tier: 'unknown',
    };
    roster[id] = rec;
    dirty = true;
  }

  // Keep the best tier ever seen so a transient null model doesn't demote them.
  if ((TIER_RANK[tier] || 0) > (TIER_RANK[rec.tier] || 0)) {
    rec.tier = tier;
    dirty = true;
  }
  if (dirty) save();

  const effTier = rec.tier || 'unknown';
  const titles = TITLES[effTier] || TITLES.unknown;
  const title = titles[(h >>> 13) % titles.length];

  return {
    name: rec.customName || rec.name,
    title,
    tier: effTier,
    skin: rec.skin,
    hair: rec.hair,
    shirt: rec.shirt,
    hiredAt: rec.hiredAt,
  };
}

// Sanitize a user-supplied custom name: strip control chars, trim, cap length.
// Returns a non-empty string, or null when the input clears the override.
// CTRL_RE is built from a plain-ASCII pattern string (no raw control bytes in
// source) and matches C0 controls (U+0000..U+001F), DEL (U+007F), and C1
// controls (U+0080..U+009F) so a pasted name cannot smuggle in newlines.
const NAME_CAP = 60;
const CTRL_RE = new RegExp('[\\u0000-\\u001F\\u007F-\\u009F]', 'g');
function cleanName(name) {
  if (name == null) return null;
  const s = String(name).replace(CTRL_RE, '').trim().slice(0, NAME_CAP);
  return s ? s : null;
}

// Ensure a roster record exists for `sessionId`, minting one via identityFor if
// missing. Returns the live record (so callers can mutate + save).
function ensureRec(sessionId) {
  load();
  const id = sessionId || 'anon';
  if (!roster[id]) identityFor(id, null); // mints + persists the base record
  return roster[id];
}

// Apply a user override to a session. `patch` may carry `name` and/or `hidden`;
// only the keys present are touched (so a hide toggle won't wipe a rename and
// vice-versa). `name`: a non-empty trimmed string sets the custom name; '' or
// null clears it. `hidden`: a boolean. Returns the effective { name, hidden }.
// Fail-soft — never throws.
export function setOverride(sessionId, patch = {}) {
  try {
    const rec = ensureRec(sessionId);
    if (!rec) return { name: null, hidden: false };
    if (Object.prototype.hasOwnProperty.call(patch, 'name')) {
      const n = cleanName(patch.name);
      if (n) rec.customName = n;
      else delete rec.customName;
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'hidden')) {
      rec.hidden = !!patch.hidden;
    }
    save();
    return { name: rec.customName || null, hidden: !!rec.hidden };
  } catch {
    return { name: null, hidden: false };
  }
}

// Cheap read of a session's override, defaulting when unset. Fail-soft.
export function overrideFor(sessionId) {
  try {
    load();
    const rec = roster[sessionId || 'anon'];
    if (!rec) return { name: null, hidden: false };
    return { name: rec.customName || null, hidden: !!rec.hidden };
  } catch {
    return { name: null, hidden: false };
  }
}
