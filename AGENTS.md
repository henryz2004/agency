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
