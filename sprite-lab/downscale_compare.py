#!/usr/bin/env python3
"""Compare downscaling approaches for AI 'pixel art' -> real small sprite.

The problem: gpt-image-2 art isn't on a regular pixel grid, so resizing to an
arbitrary target slices across its fake-pixels and smears. The fix is to detect
the native pixel PERIOD and snap to that grid first.
"""
import sys, numpy as np
from PIL import Image, ImageDraw, ImageFilter

def key_out(img, bg=(255,0,255), tol=70):
    img=img.convert("RGBA"); a=np.asarray(img).copy()
    r,g,b=a[...,0].astype(int),a[...,1].astype(int),a[...,2].astype(int)
    mask=(abs(r-bg[0])<tol)&(abs(g-bg[1])<tol)&(abs(b-bg[2])<tol)
    a[mask]=(0,0,0,0)
    return Image.fromarray(a,"RGBA")

def quant(img, colors):
    a=img.getchannel("A")
    q=img.convert("RGB").quantize(colors=colors,method=Image.MAXCOVERAGE).convert("RGBA")
    q.putalpha(a); return q

def hard_alpha(img,t=128):
    r,g,b,a=img.split(); a=a.point(lambda v:255 if v>=t else 0)
    return Image.merge("RGBA",(r,g,b,a))

def detect_period(img):
    """Estimate native pixel size via autocorrelation of edge strength."""
    g=np.asarray(img.convert("L"),float)
    def per(sig):
        sig=sig-sig.mean()
        ac=np.correlate(sig,sig,"full")[len(sig)-1:]
        ac/=ac[0]+1e-9
        lo,hi=6,len(sig)//3
        return lo+int(np.argmax(ac[lo:hi]))
    ex=np.abs(np.diff(g,axis=1)).sum(0)   # vertical edges -> col signal
    ey=np.abs(np.diff(g,axis=0)).sum(1)
    return per(ex), per(ey)

def gridsnap(img, period):
    """Resize to native grid (area-average one cell -> one pixel)."""
    px,py=period
    nw=max(1,round(img.width/px)); nh=max(1,round(img.height/py))
    return img.resize((nw,nh), Image.BOX), (nw,nh)

def fit_h(img, h):
    s=h/img.height
    return img.resize((max(1,round(img.width*s)),h), Image.NEAREST)

# ---- build the variants ----
raw=key_out(Image.open(sys.argv[1] if len(sys.argv)>1 else "raw_coffee/gen_2.png"))
c=raw.crop(raw.getbbox())
H=28
px,py=detect_period(c)
print(f"source {c.size}, detected native period ~({px},{py}) -> native grid ~"
      f"({round(c.width/px)}x{round(c.height/py)})")

variants=[]
# 1 naive nearest
variants.append(("nearest", hard_alpha(fit_h(c,H))))
# 2 lanczos+quant (current pack.py default)
v=c.resize((round(c.width*H/c.height),H),Image.LANCZOS); variants.append(("lanczos+quant", hard_alpha(quant(v,20))))
# 3 box/area + quant
v=c.resize((round(c.width*H/c.height),H),Image.BOX); variants.append(("box+quant", hard_alpha(quant(v,20))))
# 4 gridsnap -> native (shown at native res)
g,nsz=gridsnap(c,(px,py)); variants.append((f"gridsnap native {nsz[0]}x{nsz[1]}", hard_alpha(quant(g,24))))
# 5 gridsnap native -> then nearest to H
g2=fit_h(g,H); variants.append(("gridsnap->H", hard_alpha(quant(g2,20))))
# 6 supersample: lanczos to 2H then nearest to H (anti-jaggies but crisp)
v=c.resize((round(c.width*2*H/c.height),2*H),Image.LANCZOS)
v=quant(v,20).resize((round(v.width/2),H),Image.NEAREST); variants.append(("supersample", hard_alpha(v)))

# ---- compose comparison at fixed zoom ----
Z=9; pad=14; lblh=22; baseY=max(im.height for _,im in variants)
W=sum(im.width for _,im in variants)*Z+pad*(len(variants)+1)
CH=baseY*Z+lblh+10
canvas=Image.new("RGBA",(W,CH),(170,182,198,255))
d=ImageDraw.Draw(canvas); x=pad
for name,im in variants:
    big=im.resize((im.width*Z,im.height*Z),Image.NEAREST)
    y=baseY*Z-big.height+5
    canvas.alpha_composite(big,(x,y))
    d.text((x,baseY*Z+8),name,fill=(15,15,25,255))
    x+=im.width*Z+pad
canvas.convert("RGB").save("downscale_compare.png")
# also save each native sprite 1x for real use
for name,im in variants:
    im.save(f"ds_{name.split()[0].replace('+','_').replace('->','_to_')}.png")
print("wrote downscale_compare.png +", len(variants), "variants")
