#!/usr/bin/env python3
"""spritelib — core ops for turning gpt-image-2 output into game-ready sprites.

The validated pipeline, consolidated from the exploration scripts:
  generate (codex $imagegen) -> extract (session log) -> key plate -> snap to the
  AI's native pixel grid -> align/scale -> pack sheet + atlas.

Two object axes (see PIPELINE.md):
  - character: multi-frame, feet-anchored, uniform grid.
  - object:    single sprite, native-grid snap, optional anchor-based sizing.
"""
import os, io, glob, json, base64, subprocess, time, signal, threading
import numpy as np
from PIL import Image, ImageFilter, ImageDraw

CODEX_SESSIONS = os.path.expanduser("~/.codex/sessions")

# ───────────────────────── generation (codex $imagegen) ──────────────────────
def _newest_session(after_ts):
    # strictly newer than launch — the session is created after codex starts, so
    # this won't latch onto a still-open session from a previous run.
    files = [f for f in glob.glob(os.path.join(CODEX_SESSIONS, "**", "*.jsonl"), recursive=True)
             if os.path.getmtime(f) > after_ts]
    return max(files, key=os.path.getmtime) if files else None

def _extract_images(session):
    imgs = []
    for line in open(session):
        if '"image_generation_call"' not in line:
            continue
        try:
            p = json.loads(line).get("payload", {})
        except Exception:
            continue
        if p.get("type") != "image_generation_call":
            continue
        res = p.get("result") or p.get("b64_json")
        if res:
            imgs.append(Image.open(io.BytesIO(base64.b64decode(res))).convert("RGB"))
    return imgs

def _kill_tree(p):
    try:
        os.killpg(os.getpgid(p.pid), signal.SIGKILL)
    except ProcessLookupError:
        pass
    p.wait()

def generate(prompt, refs=(), first_event=20, stall=120, hard_cap=420, retries=2, log=print):
    """Run codex $imagegen and return the LAST full-res image it produced.

    Liveness is read from codex's own `--json` event stream, not a timeout guess:
      - NO event within `first_event` (20s)   → startup hang  → kill + retry
        (the codex-side stall: blocked on a startup network call, emits nothing)
      - events flowing                         → alive & progressing, let it run
      - stream SILENT for `stall` (120s)       → genuinely stalled → kill + retry
        (>120s so a single ~90s image-API call, which emits nothing while waiting,
         isn't mistaken for a stall — codex often does several = 3-4 min total)
      - `hard_cap` is a backstop.

    (-c mcp_servers={} reduces startup network calls + silences rmcp noise, but is not
    a reliable fix.) The path codex reports saving is unreliable, so we read the real
    output (base64) from the session log.
    """
    cmd = ["codex", "exec", "--json", "--skip-git-repo-check",
           "--enable", "image_generation", "-c", "image_generation=true",
           "-c", "mcp_servers={}", prompt]
    if refs:                                   # -i AFTER the prompt (flag is greedy)
        cmd += ["-i", *refs]
    for attempt in range(retries + 1):
        start = time.time()
        # own process group so a hang kills the whole codex tree (node + rust child)
        # — and ONLY this run's tree, not other concurrent codex processes.
        p = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                             start_new_session=True, text=True)
        last = [start]                         # wall-time of the most recent event line
        def pump():
            try:
                for _ in p.stdout:            # each JSONL event = a sign of life
                    last[0] = time.time()
            except Exception:
                pass
        threading.Thread(target=pump, daemon=True).start()
        reason = None
        while p.poll() is None:
            now = time.time()
            if last[0] == start and now - start > first_event:
                reason = f"no codex events in {first_event}s (startup hang)"; break
            if last[0] > start and now - last[0] > stall:
                reason = f"stream silent {stall}s (stalled)"; break
            if now - start > hard_cap:
                reason = f"exceeded {hard_cap}s hard cap"; break
            time.sleep(1)
        if reason:
            _kill_tree(p)
        sess = _newest_session(start)
        imgs = _extract_images(sess) if sess else []
        if imgs:
            log(f"  gen ok in {time.time()-start:.0f}s: {len(imgs)} image(s), using last {imgs[-1].size}")
            return imgs[-1]
        _kill_tree(p)
        log(f"  gen attempt {attempt+1} failed ({reason or 'no image'}); retrying")
    raise RuntimeError("generation failed/hung after retries")

# ───────────────────────────── keying + palette ──────────────────────────────
def key_plate(img, erode=2):
    """Make the magenta plate (and its purple anti-alias fringe) transparent."""
    a = np.asarray(img.convert("RGBA")).copy()
    r, g, b = a[..., 0].astype(int), a[..., 1].astype(int), a[..., 2].astype(int)
    pure   = (abs(r-255) < 70) & (abs(g) < 70) & (abs(b-255) < 70)
    fringe = (r > 110) & (b > 110) & (g < r-25) & (g < b-25)
    a[pure | fringe] = (0, 0, 0, 0)
    out = Image.fromarray(a)
    if erode:
        alpha = out.getchannel("A").filter(ImageFilter.MinFilter(2*erode+1))
        out.putalpha(alpha)
    return out

def hard_alpha(img, t=128):
    r, g, b, a = img.split()
    return Image.merge("RGBA", (r, g, b, a.point(lambda v: 255 if v >= t else 0)))

def quant(img, colors):
    if not colors:
        return img
    a = img.getchannel("A")
    q = img.convert("RGB").quantize(colors=colors, method=Image.MAXCOVERAGE).convert("RGBA")
    q.putalpha(a)
    return q

# ─────────────────────── native pixel-grid detection ─────────────────────────
def native_period(img, lo=8, hi=22):
    """One SQUARE native pixel period via FFT of edge strength.

    Autocorrelation argmax latches onto half-period harmonics; FFT picks the
    fundamental. One period for both axes because AI pixels are square — that
    also keeps the aspect ratio correct.
    """
    mid = (lo + hi) / 2
    g = np.asarray(img.convert("L"), float)
    def per(sig):
        sig = sig - sig.mean()
        F = np.abs(np.fft.rfft(sig)); freqs = np.fft.rfftfreq(len(sig))
        band = (freqs > 1.0/hi) & (freqs < 1.0/lo)
        k = int(np.argmax(np.where(band, F, -np.inf)))   # mask: never pick freq 0
        if not band.any() or F[k] <= 0:
            return mid, 0.0
        return 1.0/freqs[k], F[k]
    px, sx = per(np.abs(np.diff(g, axis=1)).sum(0))
    py, sy = per(np.abs(np.diff(g, axis=0)).sum(1))
    p = (px*sx + py*sy) / (sx + sy + 1e-9)
    return float(np.clip(p, lo, hi)) if np.isfinite(p) and p > 0 else mid

def grid_snap(crop):
    """Area-average to the AI's native grid (don't resample below it)."""
    p = native_period(crop)
    nw, nh = max(1, round(crop.width/p)), max(1, round(crop.height/p))
    return crop.resize((nw, nh), Image.BOX), p

# ────────────────────────────── segmentation ─────────────────────────────────
def segment_cols(img, gap=12, min_w=6):
    """Split into x-ranges by runs of fully-transparent columns."""
    cols = (np.asarray(img.getchannel("A")) > 0).sum(0)
    runs, s, empty = [], None, 0
    for x, c in enumerate(cols):
        if c > 0:
            if s is None: s = x
            empty = 0
        elif s is not None:
            empty += 1
            if empty >= gap:
                if x-empty-s >= min_w: runs.append((s, x-empty))
                s = None
    if s is not None and len(cols)-s >= min_w:
        runs.append((s, len(cols)))
    return runs

# ──────────────────────────── character packing ──────────────────────────────
def pack_character(strip, frames=0, target_h=32, colors=16, floor_pad=1, side_pad=2):
    """Aligned uniform-grid sheet + atlas from a horizontal frame strip.

    Each frame: crop to alpha bbox, normalize height, RE-ANCHOR feet to a common
    baseline. That re-anchoring is what stops the played-back sprite swimming.
    """
    raw = key_plate(strip)
    runs = segment_cols(raw)
    if frames and len(runs) != frames:
        w = raw.width // frames
        runs = [(i*w, (i+1)*w) for i in range(frames)]
    chars = []
    for x0, x1 in runs:
        sub = raw.crop((x0, 0, x1, raw.height)); bb = sub.getbbox()
        if not bb: continue
        c = sub.crop(bb)
        c = c.resize((max(1, round(c.width*target_h/c.height)), target_h), Image.LANCZOS)
        chars.append(hard_alpha(quant(c, colors)))
    if not chars:
        raise RuntimeError(f"no frames segmented (got {len(runs)} runs); "
                           f"set 'frames' in the spec or check the strip")
    cw = max(c.width for c in chars) + 2*side_pad
    ch = target_h + 2*floor_pad
    sheet = Image.new("RGBA", (cw*len(chars), ch), (0, 0, 0, 0))
    feet = []
    for i, c in enumerate(chars):
        ax = i*cw + (cw - c.width)//2
        ay = ch - c.height - floor_pad
        sheet.paste(c, (ax, ay)); feet.append(ay + c.height - 1)
    atlas = {"cols": len(chars), "rows": 1, "cellW": cw, "cellH": ch,
             "anchorX": cw//2, "anchorY": ch - floor_pad,
             "frameCount": len(chars), "anims": {"default": list(range(len(chars)))}}
    return sheet, atlas, (len(set(feet)) == 1)

# ───────────────────────── object cleaning + sizing ──────────────────────────
def clean_object(img, target_h=0, colors=12):
    """Single static sprite: key -> snap to native grid -> optional resize."""
    raw = key_plate(img); c = raw.crop(raw.getbbox())
    native, p = grid_snap(c)
    out = hard_alpha(quant(native, colors))
    if target_h and out.height >= target_h*1.4:
        out = hard_alpha(quant(out.resize(
            (max(1, round(out.width*target_h/out.height)), target_h), Image.BOX), colors))
    return out, native.size, p

def anchor_size(img, anchor_true_h, colors=12):
    """Two objects in one image: measure the anchor (LEFT), derive world-scale,
    size the new object (RIGHT) to match. Returns (sprite, info)."""
    raw = key_plate(img)
    runs = segment_cols(raw, gap=14)
    if len(runs) < 2:
        raise ValueError(f"anchor mode needs 2 objects, found {len(runs)}")
    # anchor = leftmost run; new object = EVERYTHING right of it, merged (so a new
    # object split into fragments by a transparent gap is measured whole, not just
    # its last piece).
    anchor = raw.crop((runs[0][0], 0, runs[0][1], raw.height))
    anchor = anchor.crop(anchor.getbbox())
    right = raw.crop((runs[1][0], 0, raw.width, raw.height))
    new = right.crop(right.getbbox())
    if anchor.height == 0 or new.height == 0:
        raise ValueError("anchor or object keyed away to zero height")
    scale = anchor_true_h / anchor.height
    target_h = max(1, round(new.height * scale))
    native, p = grid_snap(new)
    if native.height != target_h:
        native = native.resize(
            (max(1, round(native.width*target_h/native.height)), target_h), Image.BOX)
    sprite = hard_alpha(quant(native, colors))
    info = {"anchor_gen_h": anchor.height, "anchor_true_h": anchor_true_h,
            "scale": round(scale, 4), "pct_of_anchor": round(100*new.height/anchor.height),
            "target_h": target_h, "sprite": sprite.size}
    return sprite, info

# ───────────────────────────────── previews ──────────────────────────────────
def fit_strip(sprite, names_rects, sheet_path, out_path, zoom=8):
    """Bottom-aligned lineup of a new sprite next to real sheet sprites."""
    sheet = Image.open(sheet_path).convert("RGBA")
    items = [("new*", sprite)] + [(n, sheet.crop((x, y, x+w, y+h)))
                                  for n, (x, y, w, h) in names_rects.items()]
    base = max(im.height for _, im in items); pad = 12
    W = sum(im.width for _, im in items)*zoom + pad*(len(items)+1)
    cv = Image.new("RGBA", (W, base*zoom+26), (168, 180, 196, 255))
    d = ImageDraw.Draw(cv); x = pad
    for n, im in items:
        big = im.resize((im.width*zoom, im.height*zoom), Image.NEAREST)
        cv.alpha_composite(big, (x, base*zoom - big.height + 10))
        d.text((x, base*zoom+12), n, fill=(15, 15, 25, 255)); x += im.width*zoom + pad
    cv.convert("RGB").save(out_path)

def walk_gif(sheet, atlas, out_path, scale=6, frames_out=32, duration=110):
    """Stroll the character across an office floor; loops."""
    cw, n = atlas["cellW"], atlas["frameCount"]
    cells = [sheet.crop((i*cw, 0, (i+1)*cw, atlas["cellH"]))
             .resize((cw*scale, atlas["cellH"]*scale), Image.NEAREST) for i in range(n)]
    fw, fh = cells[0].size
    W, H = 360, fh + 56
    def to_p(rgba): return rgba.convert("RGB").convert("P", palette=Image.ADAPTIVE, colors=128)
    def backdrop():
        bg = Image.new("RGBA", (W, H), (255, 255, 255, 255)); d = ImageDraw.Draw(bg); fy = H-40
        d.rectangle([0, 0, W, fy], fill=(214, 222, 235, 255))
        d.rectangle([0, fy, W, H], fill=(150, 120, 92, 255))
        d.rectangle([0, fy-3, W, fy], fill=(120, 95, 72, 255))
        for x in range(0, W, 48): d.line([(x, fy), (x, H)], fill=(132, 104, 80, 255), width=2)
        return bg, fy
    out, span = [], W + fw
    for t in range(frames_out):
        bg, fy = backdrop(); x = int(-fw + span*t/frames_out); y = fy - fh + 1
        sh = Image.new("RGBA", (W, H), (0, 0, 0, 0)); cx = x + fw//2
        ImageDraw.Draw(sh).ellipse([cx-fw//3, fy-6, cx+fw//3, fy+6], fill=(0, 0, 0, 70))
        bg.alpha_composite(sh); bg.alpha_composite(cells[t % n], (x, y)); out.append(to_p(bg))
    out[0].save(out_path, save_all=True, append_images=out[1:], duration=duration, loop=0)
