"""BreakTension logo.

The mark: a sprout growing up through a cracked browser window. The crack is
the "break" and the sprout is what is on the other side of it, which is the
whole product in one shape.

Renders a 1000x420 cover, plus a square mark and the extension icon sizes.
"""
import math
import sys
from PIL import Image, ImageDraw, ImageFont, ImageFilter

BG = (8, 12, 9)
PANEL = (17, 24, 18)
LINE = (41, 58, 48)
GRASS = (111, 227, 154)
GRASS_DIM = (62, 140, 95)
INK = (233, 241, 234)
MUTED = (150, 172, 158)
SOIL = (54, 42, 32)


def font(size, bold=True):
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


def draw_mark(d, cx, cy, s):
    """The mark, centred on (cx, cy), sized to roughly s pixels square."""
    half = s / 2

    # Browser frame.
    x0, y0, x1, y1 = cx - half, cy - half, cx + half, cy + half
    r = s * 0.14
    d.rounded_rectangle([x0, y0, x1, y1], radius=r, fill=PANEL, outline=LINE, width=max(2, int(s * 0.022)))

    # Title bar and its three dots.
    bar = y0 + s * 0.20
    d.line([x0 + r * 0.4, bar, x1 - r * 0.4, bar], fill=LINE, width=max(2, int(s * 0.016)))
    dot = s * 0.026
    for i in range(3):
        dx = x0 + s * 0.11 + i * s * 0.085
        dy = y0 + s * 0.105
        d.ellipse([dx - dot, dy - dot, dx + dot, dy + dot], fill=LINE)

    # The crack: a jagged seam splitting the glass below the title bar.
    seam = [
        (cx + s * 0.02, bar),
        (cx - s * 0.07, cy - s * 0.10),
        (cx + s * 0.06, cy - s * 0.01),
        (cx - s * 0.05, cy + s * 0.13),
        (cx + s * 0.03, cy + s * 0.26),
    ]
    d.line(seam, fill=(74, 96, 82), width=max(2, int(s * 0.024)), joint="curve")
    # Two hairline branches off the seam.
    d.line([seam[1], (cx - s * 0.26, cy - s * 0.20)], fill=(66, 86, 74), width=max(1, int(s * 0.013)))
    d.line([seam[3], (cx + s * 0.27, cy + s * 0.17)], fill=(66, 86, 74), width=max(1, int(s * 0.013)))

    # Soil line at the base.
    soil_y = y1 - s * 0.13
    d.line([x0 + s * 0.14, soil_y, x1 - s * 0.14, soil_y], fill=SOIL, width=max(2, int(s * 0.030)))

    # Stem, rising from the soil through the crack.
    stem_w = max(2, int(s * 0.034))
    stem = [
        (cx, soil_y),
        (cx - s * 0.012, cy + s * 0.06),
        (cx + s * 0.010, cy - s * 0.06),
        (cx, cy - s * 0.20),
    ]
    d.line(stem, fill=GRASS, width=stem_w, joint="curve")

    # Two leaves.
    def leaf(tipx, tipy, basex, basey, bulge, colour):
        """A leaf as a filled polygon between a base and a tip."""
        pts = []
        steps = 18
        for i in range(steps + 1):
            t = i / steps
            x = basex + (tipx - basex) * t
            y = basey + (tipy - basey) * t
            w = math.sin(t * math.pi) * bulge
            pts.append((x + w * 0.42, y - w))
        for i in range(steps, -1, -1):
            t = i / steps
            x = basex + (tipx - basex) * t
            y = basey + (tipy - basey) * t
            w = math.sin(t * math.pi) * bulge
            pts.append((x - w * 0.42, y + w))
        d.polygon(pts, fill=colour)

    leaf(cx - s * 0.30, cy - s * 0.17, cx - s * 0.01, cy + s * 0.02, s * 0.075, GRASS_DIM)
    leaf(cx + s * 0.28, cy - s * 0.30, cx + s * 0.01, cy - s * 0.06, s * 0.070, GRASS)


def cover(path, W=1000, H=420):
    img = Image.new("RGB", (W, H), BG)
    d = ImageDraw.Draw(img)

    # Soft glow behind the mark.
    glow = Image.new("RGB", (W, H), BG)
    gd = ImageDraw.Draw(glow)
    gd.ellipse([W * 0.14, -H * 0.30, W * 0.46, H * 0.95], fill=(18, 44, 29))
    glow = glow.filter(ImageFilter.GaussianBlur(70))
    img = Image.blend(img, glow, 0.85)
    d = ImageDraw.Draw(img)

    draw_mark(d, W * 0.255, H * 0.50, H * 0.50)

    tx = W * 0.40
    d.text((tx, H * 0.335), "BreakTension", font=font(62), fill=INK)
    d.text(
        (tx + 4, H * 0.545),
        "Go outside. A model on your laptop checks.",
        font=font(20, bold=False),
        fill=MUTED,
    )
    d.text((tx + 4, H * 0.675), "GEMMA  ·  OLLAMA  ·  RUNS OFFLINE", font=font(14), fill=GRASS_DIM)

    img.save(path, quality=96)
    print(f"wrote {path}  {W}x{H}")


def square(path, S=512):
    img = Image.new("RGB", (S, S), BG)
    d = ImageDraw.Draw(img)
    draw_mark(d, S / 2, S / 2, S * 0.62)
    img.save(path, quality=96)
    print(f"wrote {path}  {S}x{S}")


def icon(path, S):
    img = Image.new("RGBA", (S * 4, S * 4), BG + (255,))
    d = ImageDraw.Draw(img)
    draw_mark(d, S * 2, S * 2, S * 4 * 0.74)
    img = img.resize((S, S), Image.LANCZOS)
    img.save(path)
    print(f"wrote {path}  {S}x{S}")


if __name__ == "__main__":
    base = sys.argv[1]
    cover(f"{base}/logo-cover.png")
    square(f"{base}/logo.png")
    for s in (16, 48, 128):
        icon(f"{base}/icon{s}.png", s)
