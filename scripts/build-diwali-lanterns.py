"""Draws the Deepavali sky lanterns: a ribbed paper balloon lit from inside by a clay diya sitting in its bamboo ring.
Each lantern is shaded as a real 3D surface of revolution: light from the diya's flame falls off with distance,
passes through the translucent paper (thicker at the rims, so the edges glow deeper), the paper gores and their seams
foreshorten towards the edges, gold bands with jali pinholes catch the light, and the flame shows through the paper.
Run from the repo root:  python scripts/build-diwali-lanterns.py public/festive/diwali
Writes lantern-<colour>.webp (transparent, 3x the largest size they are shown at). Needs numpy and Pillow."""
import os
import sys

import numpy as np
from PIL import Image, ImageFilter

OUT = sys.argv[1] if len(sys.argv) > 1 else "public/festive/diwali"
S = 4                      # drawn 4x larger than the saved file, then reduced, for smooth edges
W, H = 168 * S, 252 * S    # saved at 168 x 252
cx = W / 2
rng = np.random.default_rng(7)

# ---- the balloon's outline (radius at each height), like a hot-air balloon: round dome, tapering to a throat
y_top, y_wide, y_neck = 0.02 * H, 0.40 * H, 0.76 * H
R, r_neck = 0.455 * W, 0.17 * W
ys = np.arange(H, dtype=np.float64)
radius = np.zeros(H)
dome = (ys >= y_top) & (ys <= y_wide)
t = (y_wide - ys[dome]) / (y_wide - y_top)
radius[dome] = R * np.clip(1 - t ** 2.0, 0, 1) ** 0.5
taper = (ys > y_wide) & (ys <= y_neck)
s = (ys[taper] - y_wide) / (y_neck - y_wide)
radius[taper] = r_neck + (R - r_neck) * np.cos(np.pi / 2 * s) ** 1.25

Y, X = np.mgrid[0:H, 0:W].astype(np.float64)
r_at = radius[Y.astype(int)]
inside = (np.abs(X - cx) < r_at) & (r_at > 0)
u = np.where(inside, (X - cx) / np.maximum(r_at, 1e-6), 0)
cos_t = np.sqrt(np.clip(1 - u ** 2, 0, 1))          # how squarely the paper faces us
theta = np.arcsin(np.clip(u, -1, 1))

# ---- light from the diya's flame, inside the throat
y_flame = y_neck - 0.07 * H
dist2 = r_at ** 2 + (Y - y_flame) ** 2
light = 1 / (1 + dist2 / (0.24 * W) ** 2)
light = light / light[inside].max()
# through the paper: thin where it faces us, thick (deeper colour, a little darker) at the rims
through = 0.28 + 0.72 * cos_t ** 1.15
glow = light * through + 0.10 * cos_t ** 1.5                # plus the lit back wall seen through the front
# the flame itself shows through the paper as a soft hot spot
glow += 0.75 * np.exp(-(((X - cx) / (0.085 * W)) ** 2 + ((Y - (y_neck - 0.05 * H)) / (0.075 * H)) ** 2))

# ---- paper gores and seams (12 around; the ones turning away get narrower, as on a real ball)
gores = 12
phase = 0.21
seam = np.abs(np.sin(gores / 2 * (theta + phase)))
seam_line = np.exp(-(seam / 0.05) ** 2)                # thin dark ribs
panel = 0.88 + 0.12 * np.cos(gores * (theta + phase))  # each gore bellies out a little
glow = glow * panel * (1 - 0.5 * seam_line)
# the dome's crown, where the gores meet under a paper cap, is a little darker
glow = glow * (1 - 0.35 * np.exp(-((Y - y_top) / (0.07 * H)) ** 2))
# paper fibres: fine vertical streaks
fibres = rng.normal(0, 1, (H // 6 + 1, W // 2 + 1))
fibres = np.asarray(Image.fromarray(((fibres - fibres.min()) / (np.ptp(fibres)) * 255).astype(np.uint8)).resize((W, H), Image.BICUBIC).filter(ImageFilter.GaussianBlur(1.2)), dtype=np.float64) / 255 - 0.5
glow = glow * (1 + 0.07 * fibres)

# ---- traditional gold bands with jali pinholes (opaque foil: dark gold with light along its edges)
def band(y_c, half):
    return inside & (np.abs(Y - y_c) < half)
bands = [(y_wide - 0.005 * H, 0.016 * H), (y_neck - 0.10 * H, 0.010 * H), (y_top + 0.10 * H, 0.008 * H)]
gold_mask = np.zeros_like(glow, dtype=bool)
for y_c, half in bands:
    gold_mask |= band(y_c, half)
# pinholes along the widest band: small round holes letting the light through, spaced around the ball
y_c, half = bands[0]
hole_theta = np.linspace(-np.pi, np.pi, 33)
holes = np.zeros_like(glow)
for th in hole_theta:
    if abs(th) >= np.pi / 2 - 0.05:
        continue
    hx = cx + R * np.sin(th) * 0.995
    holes += np.exp(-(((X - hx) / (0.010 * W * np.cos(th) + 0.002 * W)) ** 2 + ((Y - y_c) / (0.0075 * H)) ** 2))
# a row of small jali diamonds just above the band
y_j = y_wide - 0.06 * H
for th in np.linspace(-np.pi, np.pi, 25):
    if abs(th) >= np.pi / 2 - 0.1:
        continue
    jx = cx + radius[int(y_j)] * np.sin(th)
    holes += 0.6 * np.exp(-((np.abs(X - jx) / (0.008 * W * np.cos(th) + 0.002 * W)) + (np.abs(Y - y_j) / (0.012 * H))) ** 2 * 3)

def colour_ramp(value, stops):
    value = np.clip(value, 0, 1)
    out = np.zeros(value.shape + (3,))
    for (a, ca), (b, cb) in zip(stops[:-1], stops[1:]):
        m = (value >= a) & (value <= b)
        f = ((value - a) / (b - a))[m][:, None]
        out[m] = np.array(ca) * (1 - f) + np.array(cb) * f
    return out

COLOURS = {
    # deep (thick paper, far from the flame) -> body -> bright -> white-hot (next to the flame)
    "saffron": [(0, (120, 30, 6)), (0.35, (205, 78, 12)), (0.62, (252, 146, 40)), (0.85, (255, 206, 120)), (1, (255, 246, 214))],
    "marigold": [(0, (128, 62, 4)), (0.35, (214, 128, 10)), (0.62, (252, 186, 44)), (0.85, (255, 226, 130)), (1, (255, 250, 222))],
    "kumkum": [(0, (92, 8, 12)), (0.35, (178, 24, 28)), (0.62, (236, 72, 46)), (0.85, (255, 160, 96)), (1, (255, 236, 200))],
    "rose": [(0, (104, 14, 50)), (0.35, (190, 44, 96)), (0.62, (240, 104, 140)), (0.85, (255, 180, 186)), (1, (255, 240, 228))],
}

# ---- the bamboo ring at the throat, seen a little from below, and the glowing opening inside it
ring_rx, ring_ry = r_neck * 1.02, r_neck * 0.30
ring_d = ((X - cx) / ring_rx) ** 2 + ((Y - y_neck) / ring_ry) ** 2
ring_outer = ring_d <= 1.0
ring_inner = ((X - cx) / (ring_rx * 0.86)) ** 2 + ((Y - y_neck) / (ring_ry * 0.78)) ** 2 <= 1.0
ring = ring_outer & ~ring_inner
opening = ring_inner

# ---- the clay diya sitting in the ring, its flame rising into the lantern
bowl_w, bowl_h = 0.25 * W, 0.055 * H
bowl_top = y_neck + 0.035 * H
bx = (X - cx) / (bowl_w / 2)
by = (Y - bowl_top) / bowl_h
bowl = (by >= 0) & (by <= 1) & (np.abs(bx) <= np.sqrt(np.clip(1 - by ** 2, 0, 1)))
lip = ((X - cx) / (bowl_w / 2)) ** 2 + ((Y - bowl_top) / (0.012 * H)) ** 2 <= 1
# two thin wires from the ring down to the diya's rim
wire = np.zeros_like(lip)
for side in (-1, 1):
    x0, x1 = cx + side * r_neck * 0.95, cx + side * bowl_w * 0.46
    yy0, yy1 = y_neck, bowl_top
    seg = (Y >= yy0) & (Y <= yy1)
    xl = x0 + (x1 - x0) * (Y - yy0) / (yy1 - yy0)
    wire |= seg & (np.abs(X - xl) <= 0.004 * W)
spout_x = cx + 0.05 * W
spout = ((X - spout_x) / (0.032 * W)) ** 2 + ((Y - (bowl_top - 0.004 * H)) / (0.012 * H)) ** 2 <= 1
flame_base = bowl_top - 0.012 * H
fy = (flame_base - Y) / (0.16 * H)                     # 0 at the wick, 1 at the tip
fw = 0.034 * W * np.sqrt(np.clip(fy, 0, 1)) * np.clip(1 - fy, 0, 1) ** 0.75 * 2.2
flame_shape = (fy >= 0) & (fy <= 1) & (np.abs(X - spout_x + 0.01 * W * fy) <= fw)


def render(name, stops):
    img = np.zeros((H, W, 4))
    lum = np.clip(glow, 0, None)
    lum = 1 - np.exp(-1.9 * lum / np.percentile(lum[inside], 90))   # filmic: bright core, rich falloff
    lum = 0.05 + 0.95 * np.clip(lum, 0, 1)
    rgb = colour_ramp(lum, stops)
    # the paper is a touch see-through at its rims against the sky
    alpha = np.where(inside, 0.93 + 0.07 * cos_t, 0)
    # gold foil bands: dark antique gold, lit on the edge nearest the flame, pinholes glowing through
    gold = np.array([150, 104, 34]) * (0.55 + 0.6 * light[..., None]) + np.array([60, 40, 10]) * cos_t[..., None] ** 8
    rgb = np.where(gold_mask[..., None], gold, rgb)
    rgb = rgb + np.clip(holes, 0, 1)[..., None] * (np.array([255, 236, 180]) - rgb) * inside[..., None]
    # seen through the throat: the inside, brightly lit
    hot = colour_ramp(np.full(Y.shape, 0.93), stops)
    rgb = np.where(opening[..., None] & ~inside[..., None], hot, rgb)
    rgb = np.where(opening[..., None] & inside[..., None], rgb * 0.4 + hot * 0.6, rgb)
    alpha = np.where(opening, 1.0, alpha)
    # bamboo ring: brown, lit from inside along its inner edge
    ring_light = np.clip(1 - (ring_d - 0.62) / 0.38, 0, 1)
    ring_col = np.array([86, 48, 22]) + np.array([150, 90, 40]) * ring_light[..., None] * (Y > y_neck)[..., None]
    rgb = np.where(ring[..., None], ring_col, rgb)
    alpha = np.where(ring, 1.0, alpha)
    # the diya: terracotta, its rim lit by its own flame, darker underneath
    shade = np.clip(1 - by, 0, 1) ** 1.4
    clay = np.array([96, 40, 18]) + np.array([150, 74, 34]) * shade[..., None] + np.array([40, 20, 8]) * (np.abs(bx) < 0.5)[..., None]
    rgb = np.where(wire[..., None], np.array([70, 44, 26]), rgb)
    alpha = np.where(wire, 1.0, alpha)
    rgb = np.where(bowl[..., None], clay, rgb)
    alpha = np.where(bowl, 1.0, alpha)
    rgb = np.where(lip[..., None], np.array([214, 132, 62]) * 1.0, rgb)          # oil-wet rim catching the flame
    alpha = np.where(lip, 1.0, alpha)
    rgb = np.where(spout[..., None], np.array([186, 98, 44]), rgb)
    alpha = np.where(spout, 1.0, alpha)
    # flame: white-hot core, gold, orange edge; above the ring it is behind the paper, so only its glow shows
    core = np.clip(1 - np.abs(X - spout_x + 0.01 * W * fy) / np.maximum(fw, 1e-6), 0, 1)
    flame_col = colour_ramp(0.55 + 0.45 * core, [(0, (255, 120, 20)), (0.6, (255, 200, 70)), (1, (255, 252, 230))])
    visible_flame = flame_shape & (opening | ~inside)
    rgb = np.where(visible_flame[..., None], flame_col, rgb)
    alpha = np.where(visible_flame, np.maximum(alpha, 0.98), alpha)

    out = np.dstack([np.clip(rgb, 0, 255), np.clip(alpha, 0, 1) * 255]).astype(np.uint8)
    im = Image.fromarray(out, "RGBA")
    # a soft rim of light just outside the paper (bloom), kept inside the picture
    bloom = im.split()[3].filter(ImageFilter.GaussianBlur(6 * S))
    halo = Image.new("RGBA", im.size, tuple(stops[3][1]) + (0,))
    halo.putalpha(bloom.point(lambda v: int(v * 0.35)))
    halo.alpha_composite(im)
    small = halo.resize((W // S, H // S), Image.LANCZOS)
    path = os.path.join(OUT, f"lantern-{name}.webp")
    small.save(path, "WEBP", quality=90, alpha_quality=90, method=6)
    print(path, small.size, os.path.getsize(path), "bytes")


os.makedirs(OUT, exist_ok=True)
for name, stops in COLOURS.items():
    render(name, stops)
