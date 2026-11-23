# Makes the product pictures in public/product-codes from the client's bag artwork (Grain bazar V4.pdf):
# the front of the bag with the product code in the plaque where the artwork has 111, 333 and so on.
#
#   python -I scripts/make-code-bag-images.py "<path to Grain bazar V4.pdf>" public/product-codes
#
# Needs PyMuPDF and Pillow. The PDF is not in the repo (16 MB). Only the plaque text changes: the logo and
# every other part of the artwork are rendered as they are. The artwork's own plaque font (Barmeno) is
# embedded with just the characters it uses, so the code is drawn in Trebuchet MS Bold, the closest font here.
import os
import sys

import pymupdf
from PIL import Image, ImageDraw, ImageFilter, ImageFont

FONT = "C:/Windows/Fonts/trebucbd.ttf"
INK = (254, 251, 220)  # The artwork's plaque text colour, 0xfefbdc.
SIZE = 1000
SUPERSAMPLE_DPI = 96

# One colour per variety, in the workbook's order, using the six designs the client named. Pages are 0-based.
# AAA (page 5, orange) and EEE (page 8, maroon) are left for new varieties.
DESIGN_OF_VARIETY = {"S": (0, "111"), "K": (1, "333"), "N": (2, "555"), "H": (3, "777"), "J": (6, "RRR"), "M": (5, "SSS")}
METHODS = "RSPBN"
SERIAL = "01"

# Where things are on every page, in PDF points (the layout is the same on all 8).
FRONT = pymupdf.Rect(426, 300, 1556, 1960)  # The bag's front, trimmed of empty top and bottom.
PLAQUE_CENTRE = (992, 965)
TEXT_WIDTH = 405
TEXT_CAP_HEIGHT = 170


def blank_front(path, page_index, placeholder):
    """The front of the bag, as a picture, with the plaque emptied. Returns the picture and its scale."""
    doc = pymupdf.open(path)
    page = doc[page_index]
    found = 0
    for block in page.get_text("dict")["blocks"]:
        for line in block.get("lines", []):
            for span in line["spans"]:
                if span["text"].strip() == placeholder and line["dir"] == (1.0, 0.0) and span["size"] > 200:
                    page.add_redact_annot(pymupdf.Rect(span["bbox"]))
                    found += 1
    if found != 1:
        raise SystemExit(f"expected one front plaque for {placeholder} on page {page_index + 1}, found {found}")
    page.apply_redactions(images=pymupdf.PDF_REDACT_IMAGE_NONE, graphics=pymupdf.PDF_REDACT_LINE_ART_NONE)
    pix = page.get_pixmap(dpi=SUPERSAMPLE_DPI, clip=FRONT, alpha=False)
    return Image.frombytes("RGB", (pix.width, pix.height), pix.samples), SUPERSAMPLE_DPI / 72


def draw_code(front, scale, code):
    picture = front.copy()
    draw = ImageDraw.Draw(picture)
    size = 300
    while size > 40:
        font = ImageFont.truetype(FONT, size)
        box = draw.textbbox((0, 0), code, font=font)
        if box[2] - box[0] <= TEXT_WIDTH * scale and box[3] - box[1] <= TEXT_CAP_HEIGHT * scale:
            break
        size -= 2
    x = (PLAQUE_CENTRE[0] - FRONT.x0) * scale - (box[2] - box[0]) / 2 - box[0]
    y = (PLAQUE_CENTRE[1] - FRONT.y0) * scale - (box[3] - box[1]) / 2 - box[1]
    draw.text((x, y), code, font=font, fill=INK)
    return picture


def on_square(picture):
    """On white with a soft edge, square, so no page crops the code off (some thumbnails fill their box)."""
    height = int(SIZE * 0.96)
    width = round(picture.width * height / picture.height)
    bag = picture.resize((width, height), Image.LANCZOS)
    canvas = Image.new("RGB", (SIZE, SIZE), "white")
    left, top = (SIZE - width) // 2, (SIZE - height) // 2
    shadow = Image.new("L", (SIZE, SIZE), 0)
    ImageDraw.Draw(shadow).rectangle((left, top, left + width, top + height), fill=70)
    canvas.paste((0, 0, 0), (0, 0), shadow.filter(ImageFilter.GaussianBlur(7)))
    canvas.paste(bag, (left, top))
    return canvas


def main():
    pdf, out = sys.argv[1], sys.argv[2]
    os.makedirs(out, exist_ok=True)
    for variety, (page_index, placeholder) in DESIGN_OF_VARIETY.items():
        front, scale = blank_front(pdf, page_index, placeholder)
        for method in METHODS:
            code = f"{method}{variety}{SERIAL}"
            on_square(draw_code(front, scale, code)).save(os.path.join(out, f"{code}.webp"), quality=84, method=6)
            print(code)


main()
