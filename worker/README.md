# Agency leaderboard — Cloudflare Worker

The opt-in social backend: stores each consenting install's **standardized
eng-years** and serves a ranked leaderboard. No repo names, transcripts, or PII
ever reach it — see `index.js` for the exact payload.

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

Then point the dashboard at it: set `LEADERBOARD_API` at the top of
`public/leaderboard.js` to the deployed URL (e.g.
`https://agency-leaderboard.<you>.workers.dev`). Until that's set, the dashboard
hides the leaderboard UI and runs exactly as before (fail-soft).

## Endpoints

| Method | Path               | Body / query                                   | Returns                          |
|--------|--------------------|------------------------------------------------|----------------------------------|
| POST   | `/api/submit`      | `{ installId, handle, outputTokens, sources? }`| `{ ok, rank, total, engYears }`  |
| GET    | `/api/leaderboard` | `?limit=100` (max 500)                         | `{ total, top: [...] }`          |
| GET    | `/api/rank`        | `?installId=...`                               | `{ rank, total, engYears }`      |

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
