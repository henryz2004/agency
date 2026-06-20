# Agency — backlog

Ideas noted but not yet built. (Mirrors the maintainer's working notes.)

## Deferred

- **Make hybrid the default** — once the `?render=hybrid` Neighborhoods view is
  polished (decor, motion, parity with the procedural floor), promote it to the
  no-flag default and keep the procedural renderer behind a flag for comparison.
  _Surfaced 2026-06-19._
- **"Lived-in decor" pass** — actually place the newly-mapped sheet props the
  atlas now exposes (trashcans green/red/blue, water fountain, plants, coffee
  machine, calendar, books, mouse/printer/paper, pins, …) around the floor so
  the office reads as inhabited rather than just desks + rugs. _Surfaced
  2026-06-19._
  - _How:_ extend the decor-zone painters in `public/render.js`; the names are
    already in `public/office-atlas.js` (the curated CC0 `SPR` catalog).
- **Re-generate front-facing animated characters** — the `sprite-lab/` pipeline
  produced 3 animated dev characters (idle / type / walk), but they came out
  side-profile and ~1.5x oversized, clashing with the front-facing, pack-scale
  sheet office, so they're shelved (`CHARACTER_MANIFEST = []`). Re-generate them
  front-facing at pack scale, then feed the atlas paths back into the manifest —
  the animated draw path in `render.js` / `characters.js` is intact and unfed,
  ready to revive. _Surfaced 2026-06-19._
- **Idle-wander** — let standing workers (and/or the avatar) drift around with a
  walk cycle when idle instead of standing stock-still, for a livelier floor.
  Needs the front-facing walk atlas above. _Surfaced 2026-06-19._

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

- **Group co-located agents** _(shipped 2026-06-19, hybrid mode)._ Agents working
  in the same repo/folder (same `project` / `cwd`) are grouped into neighborhood
  **pods** that share one counter on a translucent team **rug** labeled with the
  repo name, instead of being scattered across a uniform grid. Lives in the
  `?render=hybrid` Neighborhoods layout — `setAgents` stable-sorts by project,
  `layout()` / the pod-geometry helpers cluster co-located agents (2–4 per pod),
  and `drawTeamRugs` / the per-rug `rug-tag` paint the rug + repo label. _(Was the
  top Deferred item, requested 2026-06-18.)_

Live floor from `claude agents --json`; working / shell / idle states; manpower
HUD (effective team size, eng-years, payroll); live payroll meter; typing
sounds; chat-name hover tooltip; subagent minions; sprite variations; usage
stats (model mix, departments, daily, ledger); zoom-to-fit; hovering/collapsible
panel; wall decorations.
</content>
</invoke>
