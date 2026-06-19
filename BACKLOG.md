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
