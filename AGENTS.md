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

## Frontend render modes

- Default (no flag) = the original **procedural** office. `?render=hybrid` = the
  **Neighborhoods** floor: workers, counters, monitors, and the blue floor come
  from the CC0 "PixelOffice" sheet (`public/office-atlas.js`, the curated `SPR`
  atlas) at uniform 1× scale; status indicators (LED, "needs you", lead crown,
  subagent minions) stay procedural.
- `public/characters.js` draws the hybrid worker layer (static sheet workers now;
  animated atlases when fed — `CHARACTER_MANIFEST` is `[]` today).
- `public/avatar.js` = a walkable user avatar (hybrid only): `g` toggles it,
  WASD/arrows move it; walking up to a desk re-fires `agency:select` to open that
  agent's chat.
- Hybrid groups co-located agents (same `project`/`cwd`) into pods on shared team
  rugs labeled with the repo name.
- When adding a `lib/` or `public/` file, also add it to the `npm run check` list
  in `package.json` (the syntax-only test suite isn't auto-discovered).
