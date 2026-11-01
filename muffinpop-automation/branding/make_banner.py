"""Generates the MuffinPop YouTube banner (2560x1440).

YouTube crops the banner differently per device. Everything important sits
inside the 1546x423 center "safe area", which shows on every screen.
Run: python make_banner.py  ->  writes muffinpop_banner.png next to this file.
"""

import math
import random
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont

W, H = 2560, 1440
SAFE_W, SAFE_H = 1546, 423
HERE = Path(__file__).resolve().parent
FONT_DIRS = [Path("/usr/share/fonts/opentype/inter"), Path("C:/Windows/Fonts")]

PINK = (255, 61, 154)
HOT = (255, 120, 190)
CYAN = (60, 230, 255)
CREAM = (255, 236, 205)
DARK1 = (18, 8, 34)
DARK2 = (58, 12, 70)


def font(names, size):
    for d in FONT_DIRS:
        for n in names:
            p = d / n
            if p.exists():
                return ImageFont.truetype(str(p), size)
    return ImageFont.load_default(size)


def lerp(a, b, t):
    return tuple(int(a[i] + (b[i] - a[i]) * t) for i in range(3))


def background():
    img = Image.new("RGB", (W, H))
    px = img.load()
    for y in range(H):
        for x in range(0, W):
            # diagonal gradient + glow toward center
            t = (x / W) * 0.6 + (y / H) * 0.4
            c = lerp(DARK1, DARK2, t)
            d = math.hypot((x - W / 2) / W, (y - H / 2) / H)
            g = max(0.0, 0.35 - d) * 1.4
            px[x, y] = lerp(c, PINK, g)
    return img


def streaks(img):
    layer = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    rnd = random.Random(7)
    for _ in range(70):
        y = rnd.randint(0, H)
        x = rnd.randint(-400, W)
        length = rnd.randint(200, 900)
        col = rnd.choice([PINK, CYAN, HOT])
        alpha = rnd.randint(25, 90)
        width = rnd.randint(3, 12)
        d.line([(x, y), (x + length, y - length * 0.18)], fill=col + (alpha,), width=width)
    layer = layer.filter(ImageFilter.GaussianBlur(2))
    img.paste(layer, (0, 0), layer)
    # sprinkles / pixel confetti
    d = ImageDraw.Draw(img)
    for _ in range(260):
        x, y = rnd.randint(0, W), rnd.randint(0, H)
        s = rnd.randint(4, 12)
        d.rectangle([x, y, x + s, y + s], fill=rnd.choice([PINK, CYAN, CREAM, HOT]))


def muffin(cx, cy, s):
    """A chunky cartoon muffin with an explosion 'pop' behind it."""
    layer = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    # pop burst
    pts = []
    for i in range(32):
        r = s * (1.25 if i % 2 == 0 else 0.85)
        a = i * math.pi / 16
        pts.append((cx + r * math.cos(a), cy - s * 0.1 + r * math.sin(a)))
    d.polygon(pts, fill=CYAN + (255,))
    # cup (trapezoid with ridges)
    top, bot = cy + s * 0.05, cy + s * 0.75
    d.polygon([(cx - s * 0.55, top), (cx + s * 0.55, top), (cx + s * 0.42, bot), (cx - s * 0.42, bot)],
              fill=(255, 255, 255, 255), outline=(20, 10, 30, 255), width=int(s * 0.06))
    for i in range(-3, 4):
        x0 = cx + i * s * 0.14
        d.line([(x0, top + s * 0.06), (x0 * 0.98 + cx * 0.02, bot - s * 0.05)],
               fill=PINK + (255,), width=int(s * 0.05))
    # muffin top
    d.ellipse([cx - s * 0.68, cy - s * 0.62, cx + s * 0.68, cy + s * 0.22],
              fill=PINK + (255,), outline=(20, 10, 30, 255), width=int(s * 0.06))
    d.ellipse([cx - s * 0.45, cy - s * 0.52, cx - s * 0.05, cy - s * 0.32], fill=HOT + (255,))
    # sprinkles on top
    rnd = random.Random(3)
    for _ in range(12):
        x = cx + rnd.uniform(-0.45, 0.45) * s
        y = cy + rnd.uniform(-0.4, 0.05) * s
        a = rnd.uniform(0, math.pi)
        l = s * 0.08
        d.line([(x - l * math.cos(a), y - l * math.sin(a)), (x + l * math.cos(a), y + l * math.sin(a))],
               fill=rnd.choice([CYAN, CREAM, (255, 230, 60)]) + (255,), width=int(s * 0.05))
    shadow = layer.split()[3].point(lambda v: 160 if v else 0).filter(ImageFilter.GaussianBlur(14))
    return layer, shadow


def outlined_text(img, xy, text, f, fill, outline, stroke, shadow_off=14):
    sh = Image.new("RGBA", img.size, (0, 0, 0, 0))
    ImageDraw.Draw(sh).text((xy[0] + shadow_off, xy[1] + shadow_off), text, font=f, fill=(0, 0, 0, 200),
                            stroke_width=stroke, stroke_fill=(0, 0, 0, 200))
    img.paste(sh.filter(ImageFilter.GaussianBlur(6)), (0, 0), sh.filter(ImageFilter.GaussianBlur(6)))
    ImageDraw.Draw(img).text(xy, text, font=f, fill=fill, stroke_width=stroke, stroke_fill=outline)


def main():
    img = background()
    streaks(img)
    img = img.convert("RGBA")

    sx0, sy0 = (W - SAFE_W) // 2, (H - SAFE_H) // 2
    title_f = font(["InterDisplay-BlackItalic.otf", "Inter-BlackItalic.otf", "impact.ttf", "arialbi.ttf"], 180)
    tag_f = font(["Inter-ExtraBold.otf", "InterDisplay-Bold.otf", "arialbd.ttf"], 44)
    d = ImageDraw.Draw(img)
    w_muffin = d.textlength("MUFFIN", font=title_f)
    w_title = w_muffin + 8 + d.textlength("POP", font=title_f)
    tag = "DAILY HIGHLIGHTS  •  CLUTCH PLAYS  •  EPIC FAILS"
    tw = d.textlength(tag, font=tag_f)
    icon = 140                      # muffin "radius"
    gap = 50
    group_w = icon * 2.4 + gap + max(w_title, tw + 40)
    gx = (W - group_w) / 2
    cy = H / 2

    m, shadow = muffin(int(gx + icon * 1.2), int(cy + 10), icon)
    black = Image.new("RGBA", (W, H), (0, 0, 0, 255))
    img.paste(black, (16, 22), shadow)
    img.alpha_composite(m)

    tx = gx + icon * 2.4 + gap
    ty = cy - 170
    outlined_text(img, (tx, ty), "MUFFIN", title_f, CREAM, (20, 10, 30), 9)
    outlined_text(img, (tx + w_muffin + 8, ty), "POP", title_f, PINK, (20, 10, 30), 9)

    d = ImageDraw.Draw(img)
    by = cy + 65
    d.rounded_rectangle([tx, by - 12, tx + tw + 40, by + 64], radius=16, fill=(20, 10, 30, 230),
                        outline=CYAN, width=4)
    d.text((tx + 20, by), tag, font=tag_f, fill=CYAN)
    print(f"group width {group_w:.0f} (safe area {SAFE_W})")

    out = HERE / "muffinpop_banner.png"
    img.convert("RGB").save(out, optimize=True)
    print(f"Saved {out}")


if __name__ == "__main__":
    main()
