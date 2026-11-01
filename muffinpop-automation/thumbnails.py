"""Bold MuffinPop thumbnails: punchy frame, huge outlined text, red arrow + circle.

    python thumbnails.py <video> [--text "NO WAY"] [--game Valorant] [--vertical]

is handy for testing a look on any clip; muffinpop.py calls make_thumbnail().
"""

from __future__ import annotations

import argparse
import math
import random
import subprocess
import tempfile
from pathlib import Path

from PIL import Image, ImageDraw, ImageEnhance, ImageFilter, ImageFont, ImageStat

YELLOW = (255, 230, 0)
WHITE = (255, 255, 255)
RED = (255, 40, 40)
PINK = (255, 61, 154)
BLACK = (0, 0, 0)

# "Top line|PUNCHLINE": top line is white, punchline is red, like big reaction channels do it.
SHORT_TEXT = ["WHO DID|THIS?!", "WHAT DID|I DO?!", "NO|WAY?!", "HOW DID|THAT WORK?!", "WAIT FOR|IT...",
              "TOO|EASY", "IS THIS|BROKEN?!", "1 HP|CLUTCH!", "DID THAT|HAPPEN?!", "THEY DIDN'T|SEE IT",
              "TOTAL|DISASTER!", "I CAN'T|BELIEVE IT"]
COMP_TEXT = ["BEST OF|WEEK {n}", "TOP {n}|PLAYS!", "INSANE|WEEK!", "WHAT A|WEEK?!", "{n} CLUTCH|MOMENTS"]

FONT_CANDIDATES = [
    "C:/Windows/Fonts/impact.ttf",                # Windows: the classic thumbnail font
    "/usr/share/fonts/opentype/inter/InterDisplay-Black.otf",
    "/usr/share/fonts/opentype/inter/Inter-Black.otf",
    "C:/Windows/Fonts/ariblk.ttf",
    "/Library/Fonts/Impact.ttf",
]


def _font(size: int) -> ImageFont.FreeTypeFont:
    for p in FONT_CANDIDATES:
        if Path(p).exists():
            return ImageFont.truetype(p, size)
    return ImageFont.load_default(size)


def _duration(video: Path) -> float:
    out = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration",
                          "-of", "default=nw=1:nk=1", str(video)], capture_output=True, text=True)
    try:
        return float(out.stdout.strip())
    except ValueError:
        return 0.0


def best_frame(video: Path, focus_end: bool = True) -> Image.Image:
    """Grab several frames (weighted toward the end, where the play is) and keep the most detailed one."""
    dur = _duration(video) or 1.0
    fractions = [0.55, 0.65, 0.75, 0.82, 0.9, 0.95] if focus_end else [0.2, 0.35, 0.5, 0.65, 0.8]
    best, best_score = None, -1.0
    with tempfile.TemporaryDirectory() as tmp:
        for i, f in enumerate(fractions):
            out = Path(tmp) / f"f{i}.jpg"
            subprocess.run(["ffmpeg", "-v", "error", "-y", "-ss", f"{dur * f:.2f}", "-i", str(video),
                            "-frames:v", "1", "-q:v", "2", str(out)], capture_output=True)
            if not out.exists():
                continue
            img = Image.open(out).convert("RGB")
            gray = img.convert("L")
            edges = gray.filter(ImageFilter.FIND_EDGES)
            score = ImageStat.Stat(edges).mean[0] + ImageStat.Stat(gray).stddev[0] * 0.5
            if score > best_score:
                best, best_score = img.copy(), score
    if best is None:
        raise RuntimeError(f"Couldn't read frames from {video}")
    return best


def _cover(img: Image.Image, size: tuple[int, int]) -> Image.Image:
    w, h = size
    scale = max(w / img.width, h / img.height)
    img = img.resize((math.ceil(img.width * scale), math.ceil(img.height * scale)), Image.LANCZOS)
    left, top = (img.width - w) // 2, (img.height - h) // 2
    return img.crop((left, top, left + w, top + h))


def _punch(img: Image.Image) -> Image.Image:
    img = ImageEnhance.Color(img).enhance(1.45)
    img = ImageEnhance.Contrast(img).enhance(1.25)
    img = ImageEnhance.Brightness(img).enhance(1.05)
    img = img.filter(ImageFilter.UnsharpMask(radius=2, percent=120, threshold=3))
    # dark vignette so the text and arrow pop
    w, h = img.size
    mask = Image.new("L", (w, h), 0)
    ImageDraw.Draw(mask).ellipse([-w * 0.15, -h * 0.2, w * 1.15, h * 1.2], fill=255)
    mask = mask.filter(ImageFilter.GaussianBlur(min(w, h) * 0.12))
    dark = ImageEnhance.Brightness(img).enhance(0.35)
    return Image.composite(img, dark, mask)


def _fit_font(draw: ImageDraw.ImageDraw, text: str, max_w: int, max_h: int) -> ImageFont.FreeTypeFont:
    size = max_h
    while size > 20:
        f = _font(size)
        l, t, r, b = draw.textbbox((0, 0), text, font=f, stroke_width=size // 9)
        if r - l <= max_w and b - t <= max_h:
            return f
        size -= 6
    return _font(size)


def _big_text(base: Image.Image, text: str, box: tuple[int, int, int, int], colors, angle: float) -> None:
    """Huge slanted text, thick black outline + drop shadow, one color per line, fit into box."""
    x0, y0, x1, y1 = box
    probe = ImageDraw.Draw(base)
    lines = text.split("\n")
    line_h = (y1 - y0) // len(lines)
    layer = Image.new("RGBA", base.size, (0, 0, 0, 0))
    shadow = Image.new("RGBA", base.size, (0, 0, 0, 0))
    y = y0
    for i, line in enumerate(lines):
        fill = colors[min(i, len(colors) - 1)]
        f = _fit_font(probe, line, x1 - x0, int(line_h * 0.95))
        stroke = max(4, f.size // 9)
        l, t, r, b = probe.textbbox((0, 0), line, font=f, stroke_width=stroke)
        tx = x0 + ((x1 - x0) - (r - l)) // 2 - l
        ty = y - t
        ImageDraw.Draw(shadow).text((tx + stroke, ty + stroke * 1.4), line, font=f, fill=(0, 0, 0, 220),
                                    stroke_width=stroke, stroke_fill=(0, 0, 0, 220))
        ImageDraw.Draw(layer).text((tx, ty), line, font=f, fill=fill, stroke_width=stroke, stroke_fill=BLACK)
        y += b - t
    cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
    # italic lean: shear around the box center
    k = 0.18
    shear = (1, k, -k * cy, 0, 1, 0)
    shadow = shadow.transform(base.size, Image.AFFINE, shear, resample=Image.BICUBIC)
    layer = layer.transform(base.size, Image.AFFINE, shear, resample=Image.BICUBIC)
    shadow = shadow.filter(ImageFilter.GaussianBlur(5)).rotate(angle, center=(cx, cy), resample=Image.BICUBIC)
    layer = layer.rotate(angle, center=(cx, cy), resample=Image.BICUBIC)
    base.alpha_composite(shadow)
    base.alpha_composite(layer)


def _arrow(base: Image.Image, start: tuple[float, float], end: tuple[float, float], width: float) -> None:
    """Fat red arrow from start to end (tip at end), with white and black outline."""
    sx, sy = start
    ex, ey = end
    ang = math.atan2(ey - sy, ex - sx)
    length = math.hypot(ex - sx, ey - sy)
    head_len, head_w, shaft_w = width * 2.0, width * 2.4, width
    # arrow pointing along +x from origin, then rotate/translate
    pts = [(0, -shaft_w / 2), (length - head_len, -shaft_w / 2), (length - head_len, -head_w / 2),
           (length, 0), (length - head_len, head_w / 2), (length - head_len, shaft_w / 2), (0, shaft_w / 2)]
    ca, sa = math.cos(ang), math.sin(ang)
    poly = [(sx + x * ca - y * sa, sy + x * sa + y * ca) for x, y in pts]
    sh = Image.new("RGBA", base.size, (0, 0, 0, 0))
    ImageDraw.Draw(sh).polygon([(x + width * 0.25, y + width * 0.3) for x, y in poly], fill=(0, 0, 0, 200))
    base.alpha_composite(sh.filter(ImageFilter.GaussianBlur(width * 0.2)))
    d = ImageDraw.Draw(base)
    d.line(poly + [poly[0]], fill=BLACK, width=int(width * 0.55), joint="curve")
    d.line(poly + [poly[0]], fill=WHITE, width=int(width * 0.3), joint="curve")
    d.polygon(poly, fill=RED)


def _ring(base: Image.Image, center: tuple[float, float], r: float, width: float) -> None:
    cx, cy = center
    d = ImageDraw.Draw(base)
    box = [cx - r, cy - r, cx + r, cy + r]
    d.ellipse(box, outline=BLACK, width=int(width * 1.6))
    d.ellipse([box[0] + width * 0.3, box[1] + width * 0.3, box[2] - width * 0.3, box[3] - width * 0.3],
              outline=RED, width=int(width))


def _edge_glow(base: Image.Image, color=RED) -> None:
    """Red glow around the border."""
    W, H = base.size
    t = int(min(W, H) * 0.035)
    glow = Image.new("RGBA", base.size, (0, 0, 0, 0))
    ImageDraw.Draw(glow).rectangle([0, 0, W - 1, H - 1], outline=color + (255,), width=t)
    glow = glow.filter(ImageFilter.GaussianBlur(t * 0.9))
    base.alpha_composite(glow)
    ImageDraw.Draw(base).rectangle([0, 0, W - 1, H - 1], outline=color, width=max(3, t // 3))


def _game_logo(base: Image.Image, text: str, size: int) -> None:
    """Game name in big outlined letters, bottom center, like a logo stamp."""
    if not text:
        return
    W, H = base.size
    text = text.upper()
    d = ImageDraw.Draw(base)
    f = _fit_font(d, text, int(W * (0.85 if H > W else 0.5)), size)
    stroke = max(3, f.size // 8)
    l, t, r, b = d.textbbox((0, 0), text, font=f, stroke_width=stroke)
    x = (W - (r - l)) // 2 - l
    y = H - (b - t) - int(H * 0.045) - t
    d.text((x, y), text, font=f, fill=WHITE, stroke_width=stroke, stroke_fill=BLACK)
    # red underline bar like a logo
    d.rectangle([x + l + stroke, y + b - stroke // 2, x + r - stroke, y + b + stroke], fill=RED)


def make_thumbnail(video: str | Path, out: str | Path, text: str, game: str = "",
                   vertical: bool = False, seed: int | None = None) -> Path:
    rnd = random.Random(seed)
    video, out = Path(video), Path(out)
    size = (1080, 1920) if vertical else (1280, 720)
    W, H = size
    frame = best_frame(video)
    base = _punch(_cover(frame, size)).convert("RGBA")

    if vertical:
        text_box = (int(W * 0.02), int(H * 0.05), int(W * 0.90), int(H * 0.30))
        focus = (W * 0.55, H * 0.58)
        arrow_from = (W * 0.12, H * 0.36)
        logo_size = 130
        aw = W * 0.075
    else:
        # text on one side, arrow sweeping across to the action on the other
        left = rnd.random() < 0.6
        if left:
            text_box = (int(W * 0.03), int(H * 0.06), int(W * 0.52), int(H * 0.62))
            focus = (W * 0.70, H * 0.55)
            arrow_from = (W * 0.36, H * 0.74)
        else:
            text_box = (int(W * 0.48), int(H * 0.06), int(W * 0.97), int(H * 0.62))
            focus = (W * 0.30, H * 0.55)
            arrow_from = (W * 0.64, H * 0.74)
        logo_size = 70
        aw = W * 0.032

    ring_r = min(W, H) * (0.2 if vertical else 0.14)
    _ring(base, focus, ring_r, aw * 0.45)
    # stop the arrow at the ring's edge
    dx, dy = focus[0] - arrow_from[0], focus[1] - arrow_from[1]
    dist = math.hypot(dx, dy)
    tip = (focus[0] - dx / dist * ring_r * 1.08, focus[1] - dy / dist * ring_r * 1.08)
    _arrow(base, arrow_from, tip, aw)

    if "|" in text:
        text = text.replace("|", "\n")
    else:
        words = text.split()
        if len(words) >= 2 and len(text) > 7:
            mid = len(words) // 2
            text = " ".join(words[:mid]) + "\n" + " ".join(words[mid:])
    _big_text(base, text.upper(), text_box, [WHITE, RED], rnd.uniform(-6, -3))
    _game_logo(base, game, logo_size)
    _edge_glow(base)

    out.parent.mkdir(parents=True, exist_ok=True)
    rgb = base.convert("RGB")
    for q in (92, 85, 75, 65):  # YouTube's thumbnail limit is 2 MB
        rgb.save(out, "JPEG", quality=q, optimize=True)
        if out.stat().st_size < 2_000_000:
            break
    return out


def pick_text(kind: str, n: int = 0, rnd: random.Random | None = None) -> str:
    rnd = rnd or random
    if kind == "compilation":
        return rnd.choice(COMP_TEXT).format(n=n)
    return rnd.choice(SHORT_TEXT)


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("video")
    ap.add_argument("--text", default=None)
    ap.add_argument("--game", default="")
    ap.add_argument("--vertical", action="store_true")
    ap.add_argument("--out", default="thumbnail_test.jpg")
    a = ap.parse_args()
    print(make_thumbnail(a.video, a.out, a.text or pick_text("short"), a.game, a.vertical))
