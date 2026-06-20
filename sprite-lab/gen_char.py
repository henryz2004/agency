#!/usr/bin/env python3
"""gen_char.py — generate a MULTI-STATE animated office character (idle/type/walk)
and pack all states into ONE uniform-grid atlas matching the renderer contract.

A char spec (specs/char-*.json):
  {
    "id": "dev-auburn",
    "identity": "...shared identity sentence, repeated in every state prompt...",
    "reference": "ref_char.png",          # optional -i for identity lock
    "target_h": 32, "colors": 20,
    "states": {
      "idle": {"frames": 2, "action": "..."},
      "type": {"frames": 4, "action": "..."},
      "walk": {"frames": 4, "action": "..."}
    }
  }

Pipeline per state: codex $imagegen -> key plate -> segment frames -> normalize to
target_h -> BOTTOM-anchor (feet for walk, seat for seated) to a common baseline.
Then all states are composed into one grid: cellW = max frame width across ALL
states (+pad), cellH = target_h (+pad), one shared anchor (bottom-center). Frames
are laid out row-major; `anims` maps each state to its global frame indices.

  python3 gen_char.py specs/char-auburn.json
  python3 gen_char.py specs/char-auburn.json --from-raw walk=raw/dev-auburn_walk_raw.png,idle=...
  python3 gen_char.py specs/char-auburn.json --only walk     # regen one state only
"""
import sys, os, json, argparse
import numpy as np
from PIL import Image, ImageDraw
import spritelib as sl

OUT_DIR = "../public/characters"
SIDE_PAD = 2
FLOOR_PAD = 1

# Order states deterministically so frame indices are stable.
STATE_ORDER = ["idle", "type", "walk"]


def prompt_state(spec, state, st, out):
    """Build the codex prompt for one animation state."""
    ident = spec.get("identity", "")
    ref = ("The attached image is a reference for the SAME character — keep the "
           "identity, palette and chibi proportions consistent. " if spec.get("reference") else "")
    seated_note = ""
    if state in ("idle", "type"):
        seated_note = ("The character is SEATED on a simple office swivel chair, shown "
                       "from the side, full body from head to the chair base. Draw ONLY "
                       "the character and the chair — NO desk, NO keyboard tray, NO "
                       "monitor, nothing in front of them. Every frame MUST be the EXACT "
                       "same size, zoom and seat height — frame the character identically "
                       "in all frames so only the upper body and hands move, never the "
                       "scale or position. ")
    return (
        f"{ref}Use $imagegen to generate a 2D pixel-art character sprite sheet: a "
        f"single horizontal row, exactly {st['frames']} evenly-spaced frames of "
        f"{st['action']}. Character: {ident} {seated_note}"
        f"Requirements: IDENTICAL identity, proportions, scale and framing across all "
        f"frames (same zoom, same size, same baseline — do not zoom in or out between "
        f"frames), bottom of the body on a common baseline, generous equal empty margin "
        f"around each frame, chunky low-resolution pixel art, flat solid color blocks "
        f"only, NO gradients, NO smooth shading, NO anti-aliasing, a clean 1-pixel dark "
        f"outline, a limited flat palette. Flat solid magenta (#FF00FF) background. "
        f"Save to {out} and report the path."
    )


def pack_state_frames(raw, frames, target_h, colors):
    """Key + segment + normalize one strip into a list of bottom-aligned frames.

    Returns list of RGBA frames each exactly target_h tall, cropped to content
    width, hard-alpha + quantized. (Composition/anchoring happens in build_atlas.)
    """
    keyed = sl.key_plate(raw, erode=2)
    runs = sl.segment_cols(keyed)
    if frames and len(runs) != frames:
        # even split fallback when gap-segmentation miscounts
        w = keyed.width // frames
        runs = [(i * w, (i + 1) * w) for i in range(frames)]
    out = []
    for x0, x1 in runs:
        sub = keyed.crop((x0, 0, x1, keyed.height))
        bb = sub.getbbox()
        if not bb:
            continue
        c = sub.crop(bb)
        c = c.resize((max(1, round(c.width * target_h / c.height)), target_h), Image.LANCZOS)
        out.append(sl.hard_alpha(sl.quant(c, colors)))
    if not out:
        raise RuntimeError(f"no frames segmented (got {len(runs)} runs)")
    return out


def build_atlas(spec, state_frames, cell_w=None):
    """Compose per-state frame lists into ONE uniform grid + atlas dict.

    state_frames: {state: [PIL frames...]} (already target_h tall).
    Layout: one row per state, row-major frame indices. cellW = max width over all
    frames (+2*SIDE_PAD), or `cell_w` if given (lets several characters share an
    identical grid so they're drop-in interchangeable — frames stay center-anchored,
    a wider cell just adds symmetric margin). cellH = target_h (+2*FLOOR_PAD).
    Shared bottom-center anchor. anims map each state -> its global frame index list.
    """
    target_h = spec.get("target_h", 32)
    all_frames = [f for s in STATE_ORDER if s in state_frames for f in state_frames[s]]
    natural = max(f.width for f in all_frames) + 2 * SIDE_PAD
    cw = max(cell_w, natural) if cell_w else natural
    ch = target_h + 2 * FLOOR_PAD
    cols = max(len(state_frames[s]) for s in state_frames)  # widest row
    rows = sum(1 for s in STATE_ORDER if s in state_frames)

    sheet = Image.new("RGBA", (cw * cols, ch * rows), (0, 0, 0, 0))
    anims, fps = {}, {}
    cells = []                    # (row, col) of every pasted frame, for the self-check
    for r, s in enumerate([x for x in STATE_ORDER if x in state_frames]):
        frames = state_frames[s]
        indices = []
        for col, f in enumerate(frames):
            # global frame index uses a FULL row stride of `cols` so
            # index N -> (col = N % cols, row = N // cols) stays exact.
            gidx = r * cols + col
            ax = col * cw + (cw - f.width) // 2
            ay = r * ch + (ch - f.height - FLOOR_PAD)
            sheet.paste(f, (ax, ay))
            cells.append((r, col))
            indices.append(gidx)
        anims[s] = indices
        fps[s] = {"idle": 2, "type": 6, "walk": 8}.get(s, 6)

    atlas = {
        "name": spec["id"], "image": f"{spec['id']}.png",
        "cellW": cw, "cellH": ch, "cols": cols,
        "anchorX": cw // 2, "anchorY": ch - FLOOR_PAD,
        "anims": anims, "fps": fps,
    }
    # self-check: measure each pasted frame's ACTUAL bottom-most opaque pixel on the
    # composited sheet and confirm every frame in a row shares it (true content
    # alignment, not the derived paste position — which would cancel and be vacuous).
    alpha = np.asarray(sheet.getchannel("A"))
    per_row = {}
    for r, col in cells:
        sub = alpha[r * ch:(r + 1) * ch, col * cw:(col + 1) * cw]
        ys = np.where(sub.any(axis=1))[0]
        bottom = int(ys[-1]) if len(ys) else -1   # -1 = empty cell (shouldn't happen)
        per_row.setdefault(r, set()).add(bottom)
    aligned = all(len(v) == 1 for v in per_row.values())
    return sheet, atlas, aligned


def preview_gif(sheet, atlas, state, out_path, scale=6, hold=10, duration=140):
    """Animate ONE state across an office floor (walk) or in place (seated)."""
    cw, ch = atlas["cellW"], atlas["cellH"]
    cols = atlas["cols"]
    idxs = atlas["anims"][state]
    cells = []
    for n in idxs:
        col, row = n % cols, n // cols
        cell = sheet.crop((col * cw, row * ch, (col + 1) * cw, (row + 1) * ch))
        cells.append(cell.resize((cw * scale, ch * scale), Image.NEAREST))
    fw, fh = cells[0].size
    W, H = 320, fh + 56
    moving = (state == "walk")

    def to_p(rgba):
        return rgba.convert("RGB").convert("P", palette=Image.ADAPTIVE, colors=128)

    def backdrop():
        bg = Image.new("RGBA", (W, H), (255, 255, 255, 255))
        d = ImageDraw.Draw(bg); fy = H - 40
        d.rectangle([0, 0, W, fy], fill=(214, 222, 235, 255))
        d.rectangle([0, fy, W, H], fill=(150, 120, 92, 255))
        d.rectangle([0, fy - 3, W, fy], fill=(120, 95, 72, 255))
        for x in range(0, W, 48):
            d.line([(x, fy), (x, H)], fill=(132, 104, 80, 255), width=2)
        return bg, fy

    out = []
    span = W + fw
    total = 32 if moving else len(cells) * hold
    for t in range(total):
        bg, fy = backdrop()
        if moving:
            x = int(-fw + span * t / total)
            cell = cells[t % len(cells)]
        else:
            x = (W - fw) // 2
            cell = cells[(t // hold) % len(cells)]
        y = fy - fh + 1
        cx = x + fw // 2
        sh = Image.new("RGBA", (W, H), (0, 0, 0, 0))
        ImageDraw.Draw(sh).ellipse([cx - fw // 3, fy - 6, cx + fw // 3, fy + 6], fill=(0, 0, 0, 70))
        bg.alpha_composite(sh)
        bg.alpha_composite(cell, (x, y))
        out.append(to_p(bg))
    out[0].save(out_path, save_all=True, append_images=out[1:], duration=duration, loop=0)


def run(spec, from_raw=None, only=None, cell_w=None):
    cid = spec["id"]
    os.makedirs("raw", exist_ok=True)
    os.makedirs(OUT_DIR, exist_ok=True)
    states = spec["states"]
    raw_map = dict(p.split("=", 1) for p in from_raw.split(",")) if from_raw else {}

    state_frames = {}
    for s in STATE_ORDER:
        if s not in states:
            continue
        if only and s != only:
            # reuse previously-saved raw for states we're not regenerating
            rp = raw_map.get(s, f"raw/{cid}_{s}_raw.png")
            if not os.path.exists(rp):
                print(f"[{cid}] --only {only}: skipping {s} (no raw at {rp})")
                continue
        st = states[s]
        raw_path = raw_map.get(s, f"raw/{cid}_{s}_raw.png")
        if (only and s != only) or (s in raw_map):
            if not os.path.exists(raw_path):
                print(f"[{cid}] {s}: raw not found at {raw_path}, skipping")
                continue
            raw = Image.open(raw_path).convert("RGB")
            print(f"[{cid}] {s}: using existing raw {raw_path} {raw.size}")
        else:
            refs = [spec["reference"]] if spec.get("reference") else []
            prompt = prompt_state(spec, s, st, raw_path)
            print(f"[{cid}] {s}: generating ({st['frames']} frames)…")
            raw = sl.generate(prompt, refs=refs)
            raw.save(raw_path)
        frames = pack_state_frames(raw, st.get("frames", 0),
                                   spec.get("target_h", 32), spec.get("colors", 18))
        print(f"[{cid}] {s}: packed {len(frames)} frames "
              f"(w={[f.width for f in frames]})")
        state_frames[s] = frames

    if not state_frames:
        sys.exit(f"[{cid}] no states produced")

    sheet, atlas, aligned = build_atlas(spec, state_frames, cell_w=cell_w)
    out_png = os.path.join(OUT_DIR, f"{cid}.png")
    out_json = os.path.join(OUT_DIR, f"{cid}.json")
    sheet.save(out_png)
    json.dump(atlas, open(out_json, "w"), indent=2)
    print(f"[{cid}] sheet {sheet.size}  bottom-aligned={aligned}  -> {out_png}, {out_json}")
    print(f"[{cid}] atlas: cellW={atlas['cellW']} cellH={atlas['cellH']} cols={atlas['cols']} "
          f"anims={ {k: v for k, v in atlas['anims'].items()} }")

    # previews per state (local to sprite-lab, for self-verification)
    for s in state_frames:
        gif = f"{cid}_{s}_preview.gif"
        preview_gif(sheet, atlas, s, gif)
        print(f"[{cid}] preview -> {gif}")
    return atlas, aligned


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("spec")
    ap.add_argument("--from-raw", help="comma list state=rawpath to reuse")
    ap.add_argument("--only", help="regenerate only this state, reuse raws for others")
    ap.add_argument("--cellw", type=int, default=None,
                    help="force a shared cell width (so several chars share one grid)")
    a = ap.parse_args()
    run(json.load(open(a.spec)), from_raw=a.from_raw, only=a.only, cell_w=a.cellw)
