#!/usr/bin/env python3
"""gen.py — one-command sprite generator. Spec in, sprite sheet + atlas out.

  python gen.py specs/auburn-walk.json
  python gen.py specs/coffee.json
  python gen.py specs/coffee.json --from-raw raw_anchor/gen_2.png   # reprocess, no regen

A spec is JSON describing WHAT to make; gen.py owns the prompt engineering (the
style/perspective/scale rules we tuned) and routes to the right packer. See
PIPELINE.md for the spec schema and the full stage-by-stage walkthrough.
"""
import sys, os, json, argparse
import spritelib as sl
from PIL import Image

# Real sheet sprites used for the fit-preview lineup.
SHEET = "../public/office-assets.png"
FIT_RECTS = {"waterCooler": [159, 91, 7, 11], "printer": [233, 106, 15, 19],
             "vendDrink": [159, 123, 24, 34], "vendSnack": [184, 126, 24, 31]}

# ───────────────────────────── prompt templates ──────────────────────────────
STYLE = ("matching that style: chunky low-resolution pixel art, flat solid color "
         "blocks only, NO gradients or smooth shading, NO anti-aliasing, a clean "
         "1-pixel dark outline, a limited cool gray/blue palette, shown front-on "
         "with only a thin sliver of the top (same camera angle as the vending "
         "machines in the reference).")

def prompt_character(s, out):
    ref = ("The attached image is the EXACT character to animate — keep her/his "
           "identity, palette and proportions identical. " if s.get("reference") else "")
    return (f"{ref}Use $imagegen to generate a 2D pixel-art character sprite sheet: "
            f"a single horizontal row, exactly {s['frames']} frames of {s['action']}. "
            f"{s.get('identity','')} Requirements: identical identity/proportions/scale "
            f"across all frames, feet on a common baseline, evenly spaced, generous "
            f"empty margin per frame, hard-edged pixel art, limited flat palette, NO "
            f"anti-aliasing, on a flat solid magenta (#FF00FF) background. "
            f"Save to {out} and report the path.")

def prompt_object(s, out):
    if s.get("anchor"):                       # two-object, model sets relative scale
        a = s["anchor"]
        return (f"The first attached image is a pixel-art office {a['name']}. The "
                f"second is the office style sheet. Use $imagegen to generate ONE "
                f"image with TWO objects side by side on the same ground line, at "
                f"correct REAL-WORLD relative scale, {STYLE} LEFT = a copy of that "
                f"{a['name']}. RIGHT = {s['subject']}. CRITICAL: draw the RIGHT object "
                f"about {a.get('pct','35-45')}% of the {a['name']}'s height. Flat solid "
                f"magenta (#FF00FF) background with margin. Save to {out}.")
    return (f"The attached image is the office style sheet. Use $imagegen to generate "
            f"{s['subject']}, {STYLE} Draw the ENTIRE object as extremely simplified "
            f"pixel art only about {s.get('target_h',18)} pixels tall, using LARGE "
            f"chunky pixels. Flat solid magenta (#FF00FF) background with generous "
            f"margin. Save to {out}.")

# ───────────────────────────────── driver ────────────────────────────────────
def run(spec, from_raw=None):
    name, kind = spec["name"], spec["kind"]
    out_png, out_json = f"{name}.png", f"{name}.json"
    raw_path = f"raw/{name}_raw.png"
    os.makedirs("raw", exist_ok=True)

    # 1) obtain the raw plate (generate, or reuse an existing one)
    if from_raw:
        raw = Image.open(from_raw).convert("RGB")
        print(f"[{name}] using existing raw {from_raw} {raw.size}")
    else:
        refs = []
        if kind == "object" and spec.get("anchor"): refs.append(spec["anchor"]["ref"])
        if spec.get("reference"): refs.append(spec["reference"])
        if spec.get("style_ref"): refs.append(spec["style_ref"])
        prompt = prompt_character(spec, raw_path) if kind == "character" else prompt_object(spec, raw_path)
        print(f"[{name}] generating ({kind})…")
        raw = sl.generate(prompt, refs=refs)
        raw.save(raw_path)

    # 2) process by kind
    if kind == "character":
        sheet, atlas, aligned = sl.pack_character(
            raw, frames=spec.get("frames", 0),
            target_h=spec.get("target_h", 32), colors=spec.get("colors", 16))
        atlas["image"] = out_png
        if "anims" in spec: atlas["anims"] = spec["anims"]
        sheet.save(out_png); json.dump(atlas, open(out_json, "w"), indent=2)
        sl.walk_gif(sheet, atlas, f"{name}_preview.gif")
        print(f"[{name}] sheet {sheet.size}  feet-aligned={aligned}  -> {out_png}, {out_json}, {name}_preview.gif")

    elif kind == "object":
        if spec.get("anchor"):
            sprite, info = sl.anchor_size(raw, spec["anchor"]["sheet_h"], colors=spec.get("colors", 12))
            print(f"[{name}] anchor-scaled: {info}")
        else:
            sprite, native, p = sl.clean_object(raw, target_h=spec.get("target_h", 0), colors=spec.get("colors", 12))
            print(f"[{name}] native {native} (period~{p:.1f}) -> sprite {sprite.size}")
        sprite.save(out_png)
        json.dump({"image": out_png, "w": sprite.width, "h": sprite.height,
                   "anchorX": sprite.width//2, "anchorY": sprite.height-1},
                  open(out_json, "w"), indent=2)
        sl.fit_strip(sprite, FIT_RECTS, SHEET, f"{name}_preview.png")
        print(f"[{name}] -> {out_png}, {out_json}, {name}_preview.png")
    else:
        sys.exit(f"unknown kind: {kind}")

if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("spec", help="path to a spec JSON")
    ap.add_argument("--from-raw", help="reuse this raw plate instead of generating")
    a = ap.parse_args()
    run(json.load(open(a.spec)), from_raw=a.from_raw)
