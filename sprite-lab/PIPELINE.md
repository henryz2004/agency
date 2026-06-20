# Sprite generation pipeline

Generate game-ready pixel-art sprites (animated characters, static objects) for
the Agency office from a text spec, using gpt-image-2 via the local `codex` CLI.

```
spec.json ─▶ gen.py ─▶  generate ─▶ extract ─▶ key ─▶ snap ─▶ align/scale ─▶ pack ─▶ sheet.png + atlas.json + preview
                        (codex)     (session)  plate   native                          (one command)
```

One command:

```bash
python gen.py specs/auburn-walk.json          # animated character (from a reference)
python gen.py specs/coffee.json               # static object, sized off an anchor
python gen.py specs/coffee.json --from-raw raw/coffee_raw.png   # reprocess, skip regeneration
```

`gen.py` is the driver; `spritelib.py` is the shared core. `downscale_compare.py`
is a standalone diagnostic (see Stage 4).

---

## The two object kinds

| | `character` | `object` |
|---|---|---|
| frames | many (a strip) | one |
| alignment | feet → common baseline | n/a |
| sizing | `target_h` | `anchor` (relative) or `target_h` |
| atlas | uniform grid + anchor | single sprite + anchor point |
| output | `<name>.png` + `<name>.json` + `<name>_preview.gif` | `<name>.png` + `<name>.json` + `<name>_preview.png` |

---

## Stages (what `gen.py` runs)

### 1. Generate — `spritelib.generate()`
Runs `codex exec '<prompt>' -i <refs…>` with the built-in `image_gen` tool
(gpt-image-2, ChatGPT auth — no API key). `gen.py` owns the prompt: it injects the
style/perspective rules and, for objects, either a target pixel height or the
two-object anchor framing.

Hard-won details:
- **The intermittent hang** is a codex-side *startup network stall*: 0% CPU, no
  session file ever written, before any image call. `-c mcp_servers={}` reduces the
  startup network calls that can block (and silences the `ERROR rmcp … AuthRequired`
  noise) but is **not** a guaranteed fix — runs have hung with MCP already off.
- **Liveness comes from codex's own event stream, not a timeout guess.** We run
  `codex exec --json` and watch the JSONL events on stdout: the first event lands in
  ~1-2s on a healthy run. No event within `first_event` (20s) → startup hang → kill
  the process group + retry. Events flowing → alive; we kill on *silence* (`stall`
  120s, long enough to span a single ~90s image-API call that emits nothing), never
  on wall-clock — so a slow-but-healthy run (codex often does 3-4 image calls,
  several minutes) runs to completion. `hard_cap` is just a backstop.
- **`-i` goes AFTER the prompt** — the flag is variadic/greedy and will eat the
  prompt string if it comes first.

### 2. Extract — `spritelib._extract_images()`
The path codex *says* it saved is unreliable (it writes a naive low-res copy). The
real full-res PNG is base64 in the newest `~/.codex/sessions/**/*.jsonl` under
`payload.type == "image_generation_call"` → `result`. We always read from there.

### 3. Key the plate — `spritelib.key_plate()`
Generation is on a flat **magenta (#FF00FF)** plate. We make magenta *and its
purple anti-alias fringe* transparent, then erode ~2px to remove the leftover ring
(the purple halo that wrecked early attempts).

### 4. Snap to the native grid — `spritelib.native_period()` / `grid_snap()`
**The key insight.** gpt-image-2 "pixel art" isn't on a regular grid — each
fake-pixel is a non-integer number of real pixels. Resizing to an arbitrary size
slices across them and smears (this is why naive downscaling looked muddy —
demonstrate it with `python downscale_compare.py raw/…png`).

Fix: detect the native pixel **period** (FFT of edge-strength — robust to the
half-period harmonics that fool autocorrelation; one *square* period for both axes
so aspect stays correct), then area-average one cell → one pixel. **Never resample
below native.**

Corollary: detail that doesn't fit the native grid is lost. Flat iconic objects
(filing cabinet, pod machine) snap clean; reflective/transparent detail (a glass
carafe) turns to mud. Prompt for flat blocks, no glass/liquid.

### 5a. Character: align + pack — `spritelib.pack_character()`
Segment the strip into frames (transparent-column gaps), normalize each to
`target_h`, and **re-anchor the feet to a common baseline** on a uniform cell.
The re-anchoring is what stops the played-back sprite "swimming" — gpt-image-2
draws each frame at a slightly different position/scale; we pin a stationary body
part (feet) to a fixed point. Emits a uniform grid + atlas (`cellW/cellH/anchorX/
anchorY/anims`). Self-checks that every frame's feet land on the same row.

### 5b. Object: size it — `spritelib.clean_object()` / `anchor_size()`
Sizing was the subtle bug: generating each object alone throws away scale (a
coffee machine alone fills the canvas just like a vending machine does), so
relative sizes came out accidental — the coffee machine towered.

**Anchor sizing** fixes it: the model draws the new object *beside a known sheet
sprite* at correct relative scale (it has good spatial coherence). We measure the
anchor's height in the generation, and since we know its true sheet height, derive
one world-scale and size the new object to match. Model decides, we measure. One
world-scale for the whole atlas.

Without an anchor, fall back to a prompt-stated `target_h` (less reliable, but
gpt-image-2's prompt coherence gets close).

### 6. Preview
- character → `walk_gif()` strolls it across an office floor (loops).
- object → `fit_strip()` lines it up next to real sheet sprites to judge scale/fit.

---

## Spec schema

Common: `name` (output basename), `kind` (`character` | `object`).

**character**
```jsonc
{
  "name": "auburn-walk", "kind": "character",
  "reference": "ref_char.png",        // optional -i: an existing character to animate
  "frames": 4,
  "action": "a side-view WALK CYCLE (contact, passing, contact, passing)",
  "identity": "long auburn hair, blue overalls, chibi proportions.",
  "target_h": 32, "colors": 24,
  "anims": { "walk": [0,1,2,3] }       // optional: named frame ranges in the atlas
}
```

**object — anchor-sized (recommended)**
```jsonc
{
  "name": "coffee", "kind": "object",
  "subject": "a small compact countertop single-serve coffee machine (pod style, NO glass carafe)",
  "style_ref": "style_ref.png",        // -i: the office sheet, for style
  "anchor": { "ref": "vend_ref.png", "name": "tall drink vending machine",
              "sheet_h": 34, "pct": "35-45" },   // sheet_h = anchor's TRUE height in office-assets.png
  "colors": 12
}
```

**object — prompt-sized (no anchor)**
```jsonc
{ "name": "lamp", "kind": "object",
  "subject": "a small desk lamp", "style_ref": "style_ref.png",
  "target_h": 16, "colors": 10 }
```

Reference assets used above are built from the real sheet:
`ref_char.png` (an existing character, upscaled), `style_ref.png` (whole sheet ×4),
`vend_ref.png` (the vendDrink sprite, upscaled).

---

## Integrating into the app (next step, not yet wired)

The character atlas is a uniform grid + anchor — index `frame N → cell N`, draw
with feet on the floor baseline. A `drawCharacter(ctx, x, baselineY, anim, frame)`
+ grid-atlas loader in `render.js` is the integration; object sprites append as
new `SPR` rects in `office-atlas.js`.
