# Agency leaderboard — Cloudflare Worker

The opt-in social backend: stores each consenting install's **standardized
eng-years** and serves a ranked leaderboard. No repo names, transcripts, or PII
ever reach it — see `index.js` for the exact payload.

The same Worker also serves the **landing page + public leaderboard** from
`../site/` (static assets; `/api/*` falls through to the code above). So one
`wrangler deploy` ships both the API and the marketing site at the same origin.

## Deploy (one-time)

Needs a free [Cloudflare account](https://dash.cloudflare.com/sign-up). From this
`worker/` directory:

```bash
npx wrangler login                                  # opens browser, authorizes
npx wrangler d1 create agency-leaderboard           # → prints a database_id
# paste that id into wrangler.jsonc → d1_databases[0].database_id
npx wrangler d1 execute agency-leaderboard --remote --file=schema.sql
npx wrangler deploy                                 # → prints the https://...workers.dev URL
```

The landing page lives in `../site/` and is uploaded by `wrangler deploy` as part
of the same Worker. The hero reel (`agency-reel.mp4`, 14.7MB) is **not** in the
deploy — it's served straight from a public R2 bucket
(`https://pub-fd0496f0edca474db6cde012fae96a35.r2.dev/agency-reel.mp4`, referenced
by absolute URL in `site/index.html`). To replace it: `wrangler r2 object put
agency-assets/agency-reel.mp4 --file=… --remote`.

The dashboard talks to the **production** board by default. To point it at your
own Worker (a fork) or a local one, set the `LEADERBOARD_API` env var when
starting the dashboard — `server.js` injects it into the page via `/env.js`:

```bash
LEADERBOARD_API=https://agency-leaderboard.<you>.workers.dev npm start   # your deploy
LEADERBOARD_API=http://localhost:8787 npm start                          # local wrangler dev
```

## Endpoints

| Method | Path               | Body / query                                   | Returns                          |
|--------|--------------------|------------------------------------------------|----------------------------------|
| POST   | `/api/submit`      | `{ installId, handle, outputTokens, sources? }`| `{ ok, rank, total, engYears }` · `409 { error:"handle taken" }` if another install owns that name |
| GET    | `/api/leaderboard` | `?limit=100` (max 500)                         | `{ total, top: [...] }`          |
| GET    | `/api/rank`        | `?installId=...`                               | `{ rank, total, engYears }`      |
| GET    | `/api/stats`       | —                                              | `{ total, active7d, bySource, engYears:{sum,max,avg} }` — aggregate pulse, no rows/PII |

## Local dev

```bash
npx wrangler dev --local     # spins up a local D1; apply schema with --local instead of --remote
```

## Notes / ceilings

- **Gameability:** `outputTokens` is client-submitted and forgeable in v1. The
  server owns the eng-years formula, but not the input. Upgrade path when gaming
  shows up: signed/verified token counts. (Same `ponytail:` note in `index.js`.)
- **Identity:** anonymous per-install UUID — no accounts. Re-submitting with the
  same `installId` updates the row (upsert), so your rank moves as you ship more.
  The dashboard auto-resubmits on load + every 5 min, so no manual "update".
- **Name dedupe:** display names are unique across installs, case-insensitively.
  A SELECT gives the clean `409 handle taken`, and a `UNIQUE INDEX ... (handle
  COLLATE NOCASE)` is the atomic backstop (so the check-then-insert race can't
  slip a duplicate through — the constraint violation also maps to 409). Your own
  install keeps its name on re-submit. Note: adding the unique index to an OLD db
  that already has colliding names will fail — dedupe those rows first.
