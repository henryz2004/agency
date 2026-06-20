#!/usr/bin/env python3
"""gen_concept.py — generate full-res pixel-art OFFICE CONCEPT images (inspiration,
not game assets). No keying/snapping — we just want the raw gpt-image-2 PNG.

  python3 gen_concept.py "<prompt>" concepts/office-ref-1.png [refs...]

Reuses spritelib.generate() for the codex liveness handling + session-log extract.
"""
import sys
import spritelib as sl

def main():
    prompt = sys.argv[1]
    out = sys.argv[2]
    refs = sys.argv[3:]
    print(f"[concept] generating -> {out}  refs={refs}")
    img = sl.generate(prompt, refs=refs)
    img.save(out)
    print(f"[concept] saved {out} {img.size}")

if __name__ == "__main__":
    main()
