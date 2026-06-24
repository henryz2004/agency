// metric.js — the STANDARDIZED leaderboard metric. Shared by the dashboard
// (display) and the Worker (authoritative ranking). Unlike the personal
// manpower card, these constants are LOCKED — the leaderboard must be
// comparable across people, so it can't use anyone's tunable sliders.
//
// They are the personal-view DEFAULTS (app.js `DEFAULTS`) frozen in place:
// one "engineer" ships 3000 output tokens/hr · 8 hr/day · 230 days/yr.
// Keep these in sync with that default if it ever changes — same formula,
// fixed inputs, so 1.0 eng-year here == 1.0 at the slider defaults there.
//
// ponytail: client-submitted output_tokens are forgeable in v1 (no proof).
// The ceiling is intentional — server-side verification of real token counts
// is the upgrade path when leaderboard gaming actually shows up.

export const STANDARD = { tokPerHr: 3000, hrsPerDay: 8, daysPerYear: 230 };
export const TOKENS_PER_ENG_YEAR =
  STANDARD.tokPerHr * STANDARD.hrsPerDay * STANDARD.daysPerYear; // 5_520_000

// Lifetime OUTPUT tokens → standardized engineer-years. Output (not input)
// because that's what the personal card ranks on — it's the "work shipped".
export function standardEngYears(lifetimeOutputTokens) {
  return (Number(lifetimeOutputTokens) || 0) / TOKENS_PER_ENG_YEAR;
}

// --- self-check: `node public/metric.js` -----------------------------------
if (typeof process !== 'undefined' && process.argv[1] && process.argv[1].endsWith('metric.js')) {
  const assert = (c, m) => { if (!c) { console.error('FAIL:', m); process.exit(1); } };
  assert(TOKENS_PER_ENG_YEAR === 5_520_000, 'constant drifted from 5.52M');
  assert(standardEngYears(TOKENS_PER_ENG_YEAR) === 1, 'one eng-year of tokens != 1.0');
  assert(standardEngYears(0) === 0, 'zero tokens != 0');
  assert(standardEngYears(null) === 0 && standardEngYears(undefined) === 0, 'nullish != 0');
  assert(standardEngYears('11040000') === 2, 'string coercion / 2 eng-years failed');
  console.log('metric.js self-check OK');
}
