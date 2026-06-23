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

**Frontend** (`public/`, served statically, no framework): `app.js` polls `/api/state`, then does **all the "manpower" math client-side** (effective team size, eng-years, payroll) so the assumption sliders recompute instantly without a round-trip. `office.js` is the canvas office (layout, pan/zoom, animation, click-to-select); `sprites.js` draws every glyph procedurally with `px()` rects (nothing blits a sprite sheet); `chat-panel.js` is the per-agent transcript peek; `sound.js`/`ui.js` are peripheral.

**One procedural renderer — no render-mode flag.** `public/office.js` is the single canvas office, fully procedural: `sprites.js` draws every body, desk, and prop with `px()` rects — nothing blits a sprite sheet. `office.js` lays agents out into **project desk clusters** interleaved with cozy decor zones (lounge, plants, …), owns the camera (pan/zoom/recenter, click-to-select), and overlays DOM name/repo labels + status glyphs on the canvas. (An earlier `?render=hybrid` sheet-based "Neighborhoods" mode and its `office-atlas.js`/`characters.js` files were removed once the procedural floor absorbed the good parts — team clusters and the walkable avatar.)
- **Team clusters** (the shipped BACKLOG "group co-located agents" item): `setAgents` arrives **project-sorted**, `clusterRuns()` groups each contiguous same-`project` run, and `clusterDims()` + the packer lay each project out as **one** cluster on a shared translucent **rug** labeled with the repo name. One project = one team = one rug; a big team wraps across rows *within* its one cluster rather than splitting into separate pods. Status indicators (LED, "needs you" bubble, lead crown, subagent minions) and the name/repo labels overlay the procedural art.
- **Walkable avatar + wandering cat** (`public/avatar.js`): toggle the player with the `g` key (or the on-screen walk button) and drive it with WASD/arrows; `office.js` owns the camera and follows it while enabled. Walking into a desk's radius re-dispatches the existing `agency:select` CustomEvent so the chat panel surfaces that agent — the same path a click takes. `avatar.js` is the **one** place that loads a generated sprite atlas (`/characters/dev-auburn.json`), and only for its own walk cycle — nothing else consumes the `sprite-lab/` output. A cat ambles around the lounge as ambient life.

## Conventions

- Adapters fail soft: every fs/sqlite/CLI read is wrapped to return empty/null rather than throw, so a missing tool or data dir just yields no agents. Preserve this — a broken adapter must not take down `/api/state`.
- Codex SQL is built by string interpolation; the one user-derived value (`thread_id`) is escaped with `replace(/'/g, "''")`. Keep that if you add queries.
- `BACKLOG.md` tracks deferred ideas. The "group co-located agents" item has **shipped** (team clusters/rugs in `office.js`); deferred ideas now include a "lived-in decor" pass and re-generating front-facing animated characters to drive an idle-wander effect. Note `BACKLOG.md` itself still carries stale hybrid-era references (a "make hybrid the default" item, `office-atlas.js`, `CHARACTER_MANIFEST`) — the hybrid renderer is gone.
