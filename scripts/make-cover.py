"""BreakTension DEV cover image, 1000x420.

A dark browser window whose tabs have gone dark, with the lock screen's own
palette, and the verdict that is the heart of the post. No dependencies
beyond Pillow.
"""
import sys
from PIL import Image, ImageDraw, ImageFont

W, H = 1000, 420

BG = (8, 12, 9)
PANEL = (16, 23, 16)
LINE = (39, 56, 46)
GRASS = (111, 227, 154)
INK = (233, 241, 234)
MUTED = (155, 176, 163)
DIM = (109, 132, 120)
RED = (240, 122, 106)

img = Image.new("RGB", (W, H), BG)
d = ImageDraw.Draw(img)


def font(size, bold=False):
    names = (
        ["seguisb.ttf", "segoeuib.ttf", "arialbd.ttf", "DejaVuSans-Bold.ttf"]
        if bold
        else ["segoeui.ttf", "arial.ttf", "DejaVuSans.ttf"]
    )
    for n in names:
        try:
            return ImageFont.truetype(n, size)
        except Exception:
            continue
    return ImageFont.load_default()


def mono(size):
    for n in ["consola.ttf", "cour.ttf", "DejaVuSansMono.ttf"]:
        try:
            return ImageFont.truetype(n, size)
        except Exception:
            continue
    return ImageFont.load_default()


# Soft green glow from the top, like the lock screen's radial gradient.
for y in range(H):
    t = max(0.0, 1.0 - (y / (H * 0.75)))
    k = t * t
    d.line(
        [(0, y), (W, y)],
        fill=(int(BG[0] + 14 * k), int(BG[1] + 34 * k), int(BG[2] + 22 * k)),
    )

# ── left: the message ──────────────────────────────────────────────────────
x = 58

d.text((x, 62), "B R E A K T E N S I O N", font=font(14, True), fill=DIM)

d.text((x, 96), "Your browser won't work", font=font(45, True), fill=INK)
d.text((x, 148), "until you go outside.", font=font(45, True), fill=GRASS)

d.text(
    (x, 218),
    "A model on your own laptop checks that you really did.",
    font=font(19),
    fill=MUTED,
)

# The gesture task, as the lock screen shows it.
d.rounded_rectangle([x, 258, x + 430, 310], radius=11, fill=PANEL, outline=LINE)
d.text((x + 17, 266), "YOUR TASK", font=font(10, True), fill=DIM)
d.text((x + 17, 282), "Touch a leaf and show 2 fingers", font=font(16, True), fill=GRASS)

d.text(
    (x, 334),
    "Gemma  ·  Ollama  ·  runs offline  ·  nothing uploaded",
    font=font(14),
    fill=DIM,
)

# ── right: the verdict that catches the cheat ──────────────────────────────
px, py, pw = 580, 92, 362
d.rounded_rectangle([px, py, px + pw, py + 250], radius=14, fill=PANEL, outline=LINE)

# Window-frame motif: the thing the model is looking for.
fx, fy, fw, fh = px + 26, py + 26, 118, 86
d.rounded_rectangle([fx, fy, fx + fw, fy + fh], radius=4, fill=(23, 34, 26), outline=LINE)
d.line([fx + fw // 2, fy, fx + fw // 2, fy + fh], fill=LINE, width=3)
d.line([fx, fy + fh // 2, fx + fw, fy + fh // 2], fill=LINE, width=3)
d.text((fx + 14, fy + fh + 8), "through glass", font=font(12), fill=DIM)

d.text((px + 172, fy + 6), "REJECTED", font=font(21, True), fill=RED)
d.text((px + 172, fy + 36), "at the glass check", font=font(13), fill=MUTED)
d.text((px + 172, fy + 62), "3.4s  ·  one model call", font=font(12), fill=DIM)

# The quote: the model separating "the view" from "the camera".
qy = py + 168
d.line([px + 26, qy - 14, px + pw - 26, qy - 14], fill=LINE, width=1)
m = mono(12)
d.text((px + 26, qy), '"The image clearly shows a', font=m, fill=MUTED)
d.text((px + 26, qy + 19), ' window frame and glass panes.', font=m, fill=MUTED)
d.text((px + 26, qy + 38), ' Go all the way outside."', font=m, fill=GRASS)

out = sys.argv[1]
img.save(out, quality=95)
print(f"wrote {out}  {W}x{H}")
