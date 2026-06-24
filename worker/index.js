// Agency leaderboard Worker — Cloudflare Workers + D1.
// Public, opt-in: a row is your handle + standardized eng-years. NEVER repo
// names, transcripts, or anything identifying — the dashboard only ever sends
// { installId, handle, outputTokens, sources }, and we derive the rank here.
//
// Endpoints:
//   POST /api/submit      { installId, handle, outputTokens, sources? } -> { ok, rank, total, engYears }
//   GET  /api/leaderboard ?limit=100 [&installId=...]                   -> { total, top: [...] }
//   GET  /api/rank        ?installId=...                                -> { rank, total, engYears }
//
// The ranking metric is LOCKED here (server-authoritative) — must match
// public/metric.js. ponytail: client outputTokens are forgeable in v1; the
// upgrade path is server-side token verification when gaming shows up.

const TOKENS_PER_ENG_YEAR = 5_520_000; // 3000 tok/hr * 8 hr/day * 230 day/yr
const KNOWN_SOURCES = ['claude', 'codex', 'opencode'];
const MAX_TOKENS = 1e13; // 10T — reject absurd submissions outright

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...CORS },
  });

const ID_RE = /^[A-Za-z0-9_-]{8,64}$/;

function cleanHandle(h) {
  if (typeof h !== 'string') return null;
  // Strip control chars + angle brackets (defense-in-depth; client escapes too).
  // Keep letters/digits/spaces/punctuation/emoji — only C0/C1/DEL controls and
  // < > go (so a stored handle is safe even in a future innerHTML/attr sink).
  const s = h.replace(/[\x00-\x1f\x7f-\x9f<>]/g, '').trim().slice(0, 32);
  return s.length ? s : null;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const { pathname } = url;

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

    try {
      if (pathname === '/api/submit' && request.method === 'POST') {
        const body = await request.json().catch(() => null);
        if (!body) return json({ error: 'bad json' }, 400);

        const installId = body.installId;
        if (typeof installId !== 'string' || !ID_RE.test(installId)) {
          return json({ error: 'invalid installId' }, 400);
        }
        const handle = cleanHandle(body.handle);
        if (!handle) return json({ error: 'invalid handle' }, 400);

        if (typeof body.outputTokens !== 'number' || !Number.isFinite(body.outputTokens)) {
          return json({ error: 'invalid outputTokens' }, 400);
        }
        const outputTokens = Math.floor(body.outputTokens);
        if (outputTokens < 0 || outputTokens > MAX_TOKENS) {
          return json({ error: 'invalid outputTokens' }, 400);
        }
        const sources = Array.isArray(body.sources)
          ? body.sources.filter((s) => KNOWN_SOURCES.includes(s))
          : [];

        const engYears = outputTokens / TOKENS_PER_ENG_YEAR;
        const now = Date.now();

        await env.DB.prepare(
          `INSERT INTO scores (install_id, handle, output_tokens, eng_years, sources, created_at, updated_at)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)
           ON CONFLICT(install_id) DO UPDATE SET
             handle=excluded.handle, output_tokens=excluded.output_tokens,
             eng_years=excluded.eng_years, sources=excluded.sources, updated_at=excluded.updated_at`
        ).bind(installId, handle, outputTokens, engYears, JSON.stringify(sources), now).run();

        const { rank, total } = await rankFor(env, engYears);
        return json({ ok: true, rank, total, engYears });
      }

      if (pathname === '/api/leaderboard' && request.method === 'GET') {
        const limit = Math.min(500, Math.max(1, parseInt(url.searchParams.get('limit') || '100', 10) || 100));
        // Optional installId: lets us flag the caller's own row (mine:true) WITHOUT
        // ever returning anyone's install_id to the client. The client only sends
        // it once opted in. RANK() gives tie-aware ranks that match /api/rank.
        const meParam = url.searchParams.get('installId') || '';
        const me = ID_RE.test(meParam) ? meParam : null;
        const rows = await env.DB.prepare(
          `SELECT install_id, handle, output_tokens, eng_years, sources,
                  RANK() OVER (ORDER BY eng_years DESC) AS rank
           FROM scores ORDER BY eng_years DESC, updated_at ASC LIMIT ?1`
        ).bind(limit).all();
        const total = (await env.DB.prepare(`SELECT COUNT(*) AS n FROM scores`).first('n')) || 0;
        const top = (rows.results || []).map((r) => ({
          rank: r.rank,
          handle: r.handle,
          engYears: r.eng_years,
          outputTokens: r.output_tokens,
          sources: safeParse(r.sources),
          mine: me ? r.install_id === me : false, // install_id itself is NOT returned
        }));
        return json({ total, top });
      }

      if (pathname === '/api/rank' && request.method === 'GET') {
        const installId = url.searchParams.get('installId') || '';
        if (!ID_RE.test(installId)) return json({ error: 'invalid installId' }, 400);
        const row = await env.DB.prepare(`SELECT eng_years FROM scores WHERE install_id=?1`).bind(installId).first();
        if (!row) return json({ error: 'not found' }, 404);
        const { rank, total } = await rankFor(env, row.eng_years);
        return json({ rank, total, engYears: row.eng_years });
      }

      // Right to be forgotten — delete the caller's row. Idempotent (200 even if
      // already gone), so "stop sharing" always succeeds from the dashboard.
      if (pathname === '/api/forget' && request.method === 'POST') {
        const body = await request.json().catch(() => null);
        const installId = body && body.installId;
        if (typeof installId !== 'string' || !ID_RE.test(installId)) {
          return json({ error: 'invalid installId' }, 400);
        }
        await env.DB.prepare(`DELETE FROM scores WHERE install_id=?1`).bind(installId).run();
        return json({ ok: true });
      }

      return json({ error: 'not found' }, 404);
    } catch (err) {
      return json({ error: String(err && err.message ? err.message : err) }, 500);
    }
  },
};

// Rank = how many strictly-higher scores + 1. Ties share the lower rank number.
async function rankFor(env, engYears) {
  const higher = (await env.DB.prepare(`SELECT COUNT(*) AS n FROM scores WHERE eng_years > ?1`).bind(engYears).first('n')) || 0;
  const total = (await env.DB.prepare(`SELECT COUNT(*) AS n FROM scores`).first('n')) || 0;
  return { rank: higher + 1, total };
}

function safeParse(s) {
  try { return JSON.parse(s) || []; } catch { return []; }
}
