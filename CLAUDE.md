# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Agency is a local pixel-art office dashboard that visualizes your running Claude Code, Codex, and opencode sessions and their historical token usage. See `README.md` for the user-facing feature tour. **Zero runtime dependencies** (Node stdlib + vanilla-JS canvas), ES modules, Node ≥18, no build step.

## Commands

```bash
npm start          # node server.js → http://127.0.0.1:4313 (override PORT / HOST)
npm run check      # node --check every .js file (syntax only — this is the entire test suite)
```

There is no test framework, linter, or bundler. `npm run check` only validates syntax; the file list in `package.json` must be updated by hand when you add a `lib/` or `public/` file.

## Architecture

The app is a **read-only viewer** over three on-disk data sources. It never writes to them; its only writes are caches/identities under `data/` (gitignored, regenerable).

**Backend** (`server.js` + `lib/`) exposes one endpoint, `/api/state`, that fuses three things per request:
- `lib/live.js` → `getLive()`: currently *running* sessions ("agents on the floor").
- `lib/usage.js` → `getUsage()`: historical token/tool/subagent aggregates by day/project/model.
- `lib/roster.js` → `identityFor()`: a stable name/title/palette/hire-date per `sessionId`, derived deterministically from the id hash and persisted to `data/roster.json`.

**Multi-source adapter contract** — the central invariant. Each agent source has a small adapter exposing `getXLive()` and `getXUsage()`:
- `lib/live.js` / `lib/usage.js` are the **Claude** adapter *and* the merge point.
- `lib/codex.js` reads `~/.codex/process_manager/chat_processes.json` + `~/.codex/state_5.sqlite` (via the `sqlite3` CLI).
- `lib/opencode.js` reads the opencode SQLite DB.

`live.js` concatenates `claudeAgents`, `getOpenCodeLive().agents`, and `getCodexLive().agents`; `usage.js` `mergeUsage()`s the opencode and codex usage objects into the Claude totals. **Every adapter must emit the identical agent shape** (see `buildAgent` in `live.js` — `source`, `activity`, `model`, `subagents`, `uptimeMs`, …) **and the identical usage shape** (`{ lifetime, today, daily, byModel, byProject, … }` with the day buckets from `emptyDay()`). The merge code assumes these shapes match exactly, so changing one field means changing it in all three adapters. (This is what AGENTS.md means by "keep live.js and usage.js in sync.")

**Agent activity is three-way** (`working` | `shell` | `idle`), not just busy/idle. `claude agents --json` (live IPC, the source of truth) collapses `busy`+`shell`, so `live.js` cross-references the per-pid heartbeat file `~/.claude/sessions/<pid>.json` to distinguish "model generating" from "a shell command is running" — see `activityFor()`. If the CLI call fails, it falls back to reading the session files directly and validating each PID with `process.kill(pid, 0)`.

**Caching** — both for speed and correctness with large transcript dirs:
- `usage.js` caches per-transcript aggregates in `data/usage-cache.json` keyed by `{mtime, size}`; a refresh re-parses only changed files. Bump `cache.version` when the per-file `agg` shape changes (invalidates stale caches).
- `live.js` caches session *meta* (model, chat title, running subagents) in-memory keyed by transcript mtime, and reads only the trailing 256 KB of each transcript to avoid loading huge files.

**Frontend** (`public/`, served statically, no framework): `app.js` polls `/api/state`, then does **all the "manpower" math client-side** (effective team size, eng-years, payroll) so the assumption sliders recompute instantly without a round-trip. `render.js` is the canvas office (layout, pan/zoom, animation); `sprites.js` draws procedural pixel art; `sound.js`/`ui.js` are peripheral.

**Two render modes, one `render.js`.** The default no-flag view is the original **procedural** office (procedural worker bodies + desks). `?render=hybrid` (`HYBRID` flag, read once from the URL) swaps in the **Neighborhoods** floor: the office is rebuilt from the CC0 "PixelOffice" sheet at a uniform 1× pixel scale —
- `public/office-atlas.js` is the curated sheet atlas: the shared `Image` + a hand-verified `SPR` map of named sub-rects (workers, chairs, couches, `monitorA`/`monitorB`, books, trashcans, water fountain, door, calendar, coffee machine, cubicle tables, clouds, pins, mouse, printer, the blue `floorBlue` tile, the grey `counterGray` desk, …), plus `blit*` helpers and `blitMonitor` (recolors `monitorA`'s screen region to a tier color).
- `public/characters.js` is the hybrid worker layer: `staticCharacter` wraps one of the five front-facing sheet workers (`worker1..5`); `loadCharacter` loads a generated animated atlas (idle/type/walk); `drawCharacterState` is the single per-agent draw entry. In hybrid, agents render as **static** sheet workers standing behind a `counterGray` counter with a tier-tinted `monitorA` on top. **Status indicators stay procedural** and overlay the sheet art — the status LED, "needs you" bubble, lead crown, and subagent minions still come from `sprites.js`/`render.js`.
- **Team-rug grouping** (the shipped BACKLOG "group co-located agents" item): `setAgents` stable-sorts by `projectKey` (project/cwd), `layout()` clusters co-located agents into pods (2–4 per pod) on shared translucent **rugs** drawn by `drawTeamRugs`, each labeled with the repo name via a `rug-tag`.
- `public/avatar.js` is a **walkable user avatar** (hybrid only): a player driven with WASD/arrows, toggled with the `g` key (or a `#walk-toggle` button); `render.js` owns the camera and follows it while enabled. Walking into a desk's radius re-dispatches the existing `agency:select` event so the chat panel surfaces that agent — the same path a click takes.

The animated-character path is intact but **unfed**: `CHARACTER_MANIFEST` is `[]`, so every agent renders as a static sheet worker. The `sprite-lab/` pipeline generated 3 animated characters, but they came out side-profile/oversized against the front-facing sheet office and are shelved pending a front-facing regen (see `BACKLOG.md`). The avatar borrows one generated walk atlas (`/characters/dev-auburn.json`) only for its own walk cycle.

## Conventions

- Adapters fail soft: every fs/sqlite/CLI read is wrapped to return empty/null rather than throw, so a missing tool or data dir just yields no agents. Preserve this — a broken adapter must not take down `/api/state`.
- Codex SQL is built by string interpolation; the one user-derived value (`thread_id`) is escaped with `replace(/'/g, "''")`. Keep that if you add queries.
- `BACKLOG.md` tracks deferred ideas. The "group co-located agents" item has **shipped** in hybrid mode (team rugs in `render.js`); deferred ideas now include promoting hybrid to the default, a "lived-in decor" pass placing the newly-mapped sheet props, and re-generating front-facing animated characters.
