# 🏢 Agency

A live pixel-art office sim of your Claude Code, Codex, and opencode workforce.

You're a one-person startup — but your AI coding agents do the work of *many*.
Agency reads your **real, local** Claude Code data (from `~/.claude/`),
Codex data (from `~/.codex/`), and opencode data (from `~/.local/share/opencode/`) and visualizes it as a tiny
retro office: every running session is a pixel worker at a desk (typing
when busy, monitor glowing by model tier), and your token throughput gets
translated into **manpower** — effective team size, engineer-years shipped, and
the payroll you'd be paying humans to match it.

Nothing leaves your machine. No dependencies.

![Agency](docs/screenshot.png)

## Run it

```bash
node server.js
# → http://localhost:4313
```

Set a different port with `PORT=8080 node server.js`.

Leave it open on a second monitor and start some `claude`, `codex`, or
`opencode` sessions — workers appear at desks within ~3 seconds, busy ones
start typing, and uptimes tick live.

## What it shows

**The floor** — one desk per *running* session (Claude Code, Codex, or opencode), discovered from
`~/.claude/sessions/<pid>.json` (validated against live PIDs), `~/.codex/process_manager/chat_processes.json` joined with `~/.codex/state_5.sqlite`, or the opencode SQLite database. Each agent gets:
- a stable name + job title (Intern → Principal, keyed to its model tier),
- a glowing monitor colored by model (Opus = gold, Sonnet = cyan, Haiku = green),
- a "typing" animation while `busy`, and a live uptime counter.

**Effective team size** — your recent daily output tokens divided by what one
human engineer would produce. Drag the **Assumptions** sliders (tokens per
engineer-hour, hours/day, days/year, salary) to re-rate everything instantly:
- *engineer-years shipped* (lifetime output),
- *payroll equivalent* (what the humans would cost),
- *engineer-days today*.

**Comparison** — a row of pixel people: you (gold) vs. the team you operate like.

**Panels** — model mix by output, top "departments" (projects) by output, a
30-day daily-output chart, and an all-time ledger (tokens, tool actions,
subagents hired, sessions, active days).

## Hybrid view (`?render=hybrid`)

The default, no-flag view is the original **procedural** office described above.
Open `http://localhost:4313/?render=hybrid` for an alternate **Neighborhoods**
office rebuilt from a real pixel-art sheet at a uniform 1× scale:

- **Sheet workers** — instead of procedural bodies, each agent is one of the five
  front-facing standing characters from the CC0 "PixelOffice" pack, standing
  behind a real grey **counter** with the side-view **monitor** sprite on top.
  The monitor's screen is tinted by model tier (Opus gold, Sonnet cyan, Haiku
  green, Codex orange) and brightened/dimmed by activity (working / shell / idle).
- **Team rugs** — co-located agents (same `project` / `cwd`) are grouped into
  **neighborhood pods** that share one counter on a translucent team **rug**,
  labeled with the repo name. Solo agents get their own small team area. So you
  read the floor as teams, not a scattered grid.
- **Real sheet furniture & floor** — a blue brick sheet floor tile, plus lounge
  couches, accent chairs, plants, and other props pulled from the sheet.
- Status indicators stay procedural and overlay the sheet art: the status **LED**,
  the "needs you" bubble, the **lead crown**, and the subagent **minions**.

**Walkable avatar** — press **`g`** (or click the walk-toggle button if present)
to drop in a controllable **player character**. Drive it with **WASD / arrows**;
the camera follows you. Walk up to a desk and that agent's chat surfaces in the
peek panel (it reuses the same selection event a click does), so you can wander
the floor and read what each agent is doing. Press `g` again to return to the
free pan/zoom camera. (Hybrid only.)

> The hybrid view is behind a flag while it's polished — see `BACKLOG.md` for the
> plan to make it the default and the pending "lived-in decor" / animated-character
> work.

## How it works

Zero dependencies — just Node's `http` + `fs` and a vanilla-JS canvas frontend.

| File | Role |
|------|------|
| `server.js` | HTTP server; single `/api/state` endpoint fusing live + usage |
| `lib/live.js` | running sessions, uptime, status, per-session model |
| `lib/usage.js` | parses `~/.claude/projects/**/*.jsonl` plus Codex/opencode usage, cached by mtime+size |
| `lib/opencode.js` | reads opencode SQLite DB for live sessions + usage stats |
| `lib/codex.js` | reads Codex local state for live sessions + usage stats |
| `lib/roster.js` | stable name/title/palette per session (persisted) |
| `public/render.js` | the pixel office: layout, animation, name plates, hybrid Neighborhoods floor |
| `public/sprites.js` | procedural pixel-art drawing |
| `public/office-atlas.js` | curated CC0 "PixelOffice" sheet + named sprite rects (hybrid) |
| `public/characters.js` | static + animated character drawing (hybrid worker layer) |
| `public/avatar.js` | the walkable user avatar (`g` to toggle, WASD/arrows to move) |
| `public/app.js` | data polling, manpower math, panels, ticker |

Usage stats are cached in `data/usage-cache.json` and `data/opencode-usage-cache.json`
(only changed transcripts/DB state are re-parsed on refresh; the main cache now includes Claude, Codex, and opencode usage); agent identities persist in `data/roster.json`.

Codex live sessions come from `~/.codex/process_manager/chat_processes.json`
and `~/.codex/state_5.sqlite`.

> The manpower numbers are a deliberately fun heuristic, not a benchmark — they
> exist to make a one-person shop *feel like more*. Tune the sliders to taste.
