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

// Engineer-years expressed in eng-years per unit, from the SAME locked constants:
// 1 eng-yr = 230 eng-days, 1 eng-day = 8 eng-hrs; an eng-month is 1/12 eng-yr.
const EY_PER = {
  yr: 1,
  mo: 1 / 12,
  day: 1 / STANDARD.daysPerYear,
  hr: 1 / (STANDARD.daysPerYear * STANDARD.hrsPerDay),
};

// Format an engineer-years value in the largest unit where it reads naturally,
// so a tiny score shows as "6.3 eng-hrs" not "0.003 eng-yrs". Returns a display
// string: "8.7 eng-yrs" · "4.8 eng-mos" · "12 eng-days" · "6.3 eng-hrs" (singular
// at exactly 1: "1 eng-yr"). Ranking stays in eng-years; only display adapts.
export function fmtEngTime(engYears) {
  const ey = Number(engYears) || 0;
  let value, unit;
  if (ey >= EY_PER.yr) { value = ey; unit = 'yr'; }
  else if (ey >= EY_PER.mo) { value = ey / EY_PER.mo; unit = 'mo'; }
  else if (ey >= EY_PER.day) { value = ey / EY_PER.day; unit = 'day'; }
  else { value = ey / EY_PER.hr; unit = 'hr'; }
  const v = value >= 10 ? Math.round(value).toString() : (Math.round(value * 10) / 10).toString();
  return `${v} eng-${unit}${v === '1' ? '' : 's'}`;
}

// --- self-check: `node public/metric.js` -----------------------------------
if (typeof process !== 'undefined' && process.argv[1] && process.argv[1].endsWith('metric.js')) {
  const assert = (c, m) => { if (!c) { console.error('FAIL:', m); process.exit(1); } };
  assert(TOKENS_PER_ENG_YEAR === 5_520_000, 'constant drifted from 5.52M');
  assert(standardEngYears(TOKENS_PER_ENG_YEAR) === 1, 'one eng-year of tokens != 1.0');
  assert(standardEngYears(0) === 0, 'zero tokens != 0');
  assert(standardEngYears(null) === 0 && standardEngYears(undefined) === 0, 'nullish != 0');
  assert(standardEngYears('11040000') === 2, 'string coercion / 2 eng-years failed');
  // dynamic unit picker
  assert(fmtEngTime(8.7) === '8.7 eng-yrs', `years fmt: ${fmtEngTime(8.7)}`);
  assert(fmtEngTime(1) === '1 eng-yr', `singular year: ${fmtEngTime(1)}`);
  assert(fmtEngTime(12) === '12 eng-yrs', `int years: ${fmtEngTime(12)}`);
  assert(fmtEngTime(0.4).endsWith(' eng-mos'), `months unit: ${fmtEngTime(0.4)}`);
  assert(fmtEngTime(0.01).endsWith(' eng-days'), `days unit: ${fmtEngTime(0.01)}`);
  assert(fmtEngTime(1 / 230) === '1 eng-day', `singular day: ${fmtEngTime(1 / 230)}`);
  assert(fmtEngTime(0.001).endsWith(' eng-hrs'), `hours unit: ${fmtEngTime(0.001)}`);
  assert(fmtEngTime(0) === '0 eng-hrs', `zero: ${fmtEngTime(0)}`);
  console.log('metric.js self-check OK');
}
