"""Builds every Grain Bazar logo file from the one 1920 px original.
Original colours for light backgrounds, and a reversed copy for dark bars (the navy turns white, gold stays gold),
the way Flipkart and Amazon show their logos on their own dark headers.
Run from the repo root: python scripts/build-logo-assets.py src/assets/grainbazar-logo.png .
Writes src/assets/brand/gb-*.webp and the browser and phone icons in public/. Needs Pillow and numpy."""
import sys, os, io, numpy as np
from PIL import Image, ImageDraw, ImageFilter
src, repo = sys.argv[1], sys.argv[2]
assets = os.path.join(repo, "src", "assets", "brand"); public = os.path.join(repo, "public")
os.makedirs(assets, exist_ok=True)
rgb = np.asarray(Image.open(src).convert("RGB")).astype(np.float64)
white = np.array([255.0, 255.0, 255.0])
NAVY, GOLD = np.array([4.0, 33.0, 76.0]), np.array([187.0, 143.0, 49.0])
d = white - rgb
fits = []
for ink in (NAVY, GOLD):
    v = white - ink
    a = np.clip((d @ v) / (v @ v), 0, 1)
    fits.append((a, np.linalg.norm(d - a[..., None] * v, axis=2)))
is_gold = fits[1][1] < fits[0][1]
alpha = np.where(is_gold, fits[1][0], fits[0][0])
alpha[alpha < 0.02] = 0
safe = np.maximum(alpha, 1e-6)[..., None]
colour = np.clip((rgb - (1 - alpha[..., None]) * white) / safe, 0, 255)
def rgba(c):
    return Image.fromarray(np.dstack([c, alpha * 255]).round().astype(np.uint8))
original = rgba(colour)
rev = colour.copy(); rev[~is_gold] = 255.0          # navy ink -> white, gold untouched
reverse = rgba(rev)

BOX = {"mark": (552, 303, 1367, 1116), "full": (235, 303, 1710, 1545), "word": (235, 1190, 1710, 1417), "tag": (359, 1471, 1636, 1545)}
def pad(img, p):
    out = Image.new("RGBA", (img.width + 2 * p, img.height + 2 * p), (0, 0, 0, 0)); out.alpha_composite(img, (p, p)); return out
def wide(master):
    mark = master.crop(BOX["mark"]); word = master.crop(BOX["word"]); tag = master.crop(BOX["tag"])
    s = 0.86 * mark.height / (word.height + 54 + tag.height)       # name + tagline block = 86% of the ring's height
    tw, th, gw, gh, inner = round(word.width * s), round(word.height * s), round(tag.width * s), round(tag.height * s), round(54 * s)
    gap = round(mark.height * 0.16); block = th + inner + gh
    out = Image.new("RGBA", (mark.width + gap + tw, mark.height), (0, 0, 0, 0))
    out.alpha_composite(mark, (0, 0))
    top = (mark.height - block) // 2; x = mark.width + gap
    out.alpha_composite(word.resize((tw, th), Image.LANCZOS), (x, top))
    out.alpha_composite(tag.resize((gw, gh), Image.LANCZOS), (x + (tw - gw) // 2, top + th + inner))
    return out
shapes = {}
for tone, master in (("", original), ("-rev", reverse)):
    shapes["mark" + tone] = pad(master.crop(BOX["mark"]), 8)
    shapes["full" + tone] = pad(master.crop(BOX["full"]), 8)
    shapes["wide" + tone] = pad(wide(master), 8)
widths = {"mark": (64, 128), "wide": (240, 360, 540), "full": (240, 540)}
for name, img in shapes.items():
    for w in widths[name.split("-")[0]]:
        h = round(img.height * w / img.width)
        small = img.resize((w, h), Image.LANCZOS)
        path = os.path.join(assets, f"gb-{name}-{w}.webp")
        small.save(path, "WEBP", quality=88, alpha_quality=85, method=6)
        print(f"gb-{name}-{w}.webp", small.size, os.path.getsize(path), "bytes")
print("wide aspect", shapes["wide"].width / shapes["wide"].height, "full aspect", shapes["full"].width / shapes["full"].height)

# ---- browser and phone icons: the original ring on a white coin (shows on light and dark tabs alike)
mark = original.crop(BOX["mark"])
def coin(size, ring=0.90):
    big = size * 8
    canvas = Image.new("RGBA", (big, big), (0, 0, 0, 0))
    ImageDraw.Draw(canvas).ellipse((0, 0, big - 1, big - 1), fill=(255, 255, 255, 255))
    m = round(big * ring); canvas.alpha_composite(mark.resize((m, m), Image.LANCZOS), ((big - m) // 2, (big - m) // 2))
    out = canvas.resize((size, size), Image.LANCZOS)
    if size <= 48: out = out.filter(ImageFilter.UnsharpMask(radius=0.6, percent=60, threshold=0))
    return out
def tile(size, ring=0.74):
    canvas = Image.new("RGB", (size, size), (255, 255, 255))
    m = round(size * ring); piece = mark.resize((m, m), Image.LANCZOS)
    canvas.paste(piece, ((size - m) // 2, (size - m) // 2), piece)
    return canvas
coin(48).save(os.path.join(public, "favicon.ico"), format="ICO", sizes=[(16, 16), (32, 32), (48, 48)], append_images=[coin(16), coin(32)])
coin(32).save(os.path.join(public, "favicon-32x32.png"), optimize=True)
coin(48).save(os.path.join(public, "favicon-48x48.png"), optimize=True)
coin(96).save(os.path.join(public, "favicon-96x96.png"), optimize=True)
coin(96).save(os.path.join(public, "favicon.png"), optimize=True)
tile(180).save(os.path.join(public, "apple-touch-icon.png"), optimize=True)
tile(192).save(os.path.join(public, "icon-192x192.png"), optimize=True)
tile(512).save(os.path.join(public, "icon-512x512.png"), optimize=True)
for f in ("favicon.ico", "favicon-32x32.png", "favicon-48x48.png", "favicon-96x96.png", "favicon.png", "apple-touch-icon.png", "icon-192x192.png", "icon-512x512.png"):
    print(f, os.path.getsize(os.path.join(public, f)), "bytes")
