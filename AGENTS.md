# AGENTS.md

This repo is a local pixel office dashboard for Claude Code, Codex, and opencode.

## Commands

```bash
npm start
npm run check
```

## Notes

- Keep live-state adapters small and source-specific.
- `lib/live.js` and `lib/usage.js` should stay in sync across Claude, Codex, and opencode.
- Codex state lives under `~/.codex/process_manager/chat_processes.json` and `~/.codex/state_5.sqlite`.

## Frontend renderer

- There is ONE renderer (no flag, no render-mode switch): the fully-procedural
  office. `public/office.js` lays out project desk clusters + cozy decor and owns
  the camera (pan / zoom / recenter, click-to-select); `public/sprites.js` draws
  every glyph procedurally with `px()` rects — nothing blits a sprite sheet.
- Co-located agents (same `project`) are grouped into one cluster on a shared team
  rug labeled with the repo name. Status indicators (LED, "needs you", lead crown,
  subagent minions) and the name/repo DOM labels overlay the procedural art.
- `public/avatar.js` is a DORMANT walkable user-avatar module (a WASD-driven
  player with an inlined walk-cycle pipeline). It is preserved for a future
  idle-wander feature but is NOT wired into `office.js` today.
- When adding a `lib/` or `public/` file, also add it to the `npm run check` list
  in `package.json` (the syntax-only test suite isn't auto-discovered).
