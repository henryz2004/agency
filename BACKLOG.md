# Agency — backlog

Ideas noted but not yet built. (Mirrors the maintainer's working notes.)

## Deferred

- **Group co-located agents** — if two+ live agents are working in the same
  repo/folder (same `cwd` / `project`), visually group their desks together
  (a shared cluster/pod, a team label, or adjacency in the grid) instead of
  scattering them. _Requested 2026-06-18._
  - _How:_ agents already carry `cwd`/`project` (from `claude agents --json`
    via `lib/live.js`). Implement in `public/render.js` — cluster pods by
    project in `layout()` / `podOrigin()`, optionally with a group header/rug.

## Built but dormant — revisit

- **Control Phase-1 — answer a paused agent** _(built + on `main`, NOT enabled; deferred 2026-06-19)._
  Reply to a paused Claude Code agent from the dashboard instead of just watching it.
  - _Mechanism:_ a single global `type:"http"` **Stop hook** blocks the agent at turn-end and
    POSTs to `/api/hook/stop` (held open); you reply in the chat panel → `/api/reply` → the
    hook's `{"decision":"block", ...}` response resumes the agent with your text. Fails open
    after ~110s (agent just stops). UI: the "🔔 waiting on you" topbar pill + a per-agent bubble.
  - _Code:_ `server.js` (`/api/hook/stop`, `/api/reply`), `lib/control.js` (pending registry),
    `scripts/install-hook.mjs`; `public/chat-panel.js` (reply box) + `public/app.js` (pill).
  - _Enable when ready:_ `npm run install-hook` (merges the Stop hook into
    `~/.claude/settings.json`; `--uninstall` to remove). **Caveat:** affects ALL Claude sessions —
    each pauses on stop, holding up to ~110s for a reply (fails open if Agency is closed).
  - _Open questions to revisit:_ is the Stop-hook the right control channel; the global
    "every session pauses on stop" behavior; whether the hold/timeout UX feels right. _(maintainer to fill in)_
  - _Deferred sub-parts:_ `PermissionRequest` approve/deny; a "what the agent asked" header for
    real paused agents (only the mock sets `pendingQuestion` today); proactive mid-flight steering.

## Possible extras

- Menu-bar (macOS) wrapper so it lives in the menu bar.
- Per-agent sparkline of recent token output.
- Sound: distinct cue when an agent finishes / a subagent spawns.

## Shipped

Live floor from `claude agents --json`; working / shell / idle states; manpower
HUD (effective team size, eng-years, payroll); live payroll meter; typing
sounds; chat-name hover tooltip; subagent minions; sprite variations; usage
stats (model mix, departments, daily, ledger); zoom-to-fit; hovering/collapsible
panel; wall decorations.
