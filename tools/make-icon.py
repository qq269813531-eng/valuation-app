"""
生成 APP 图标（1024 / 512 / 192 / 180）

运行： python tools/make-icon.py
输出： assets/icon-1024.png、icon-512.png、icon-192.png、apple-touch-icon.png
"""

import os
from PIL import Image, ImageDraw, ImageFilter

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "..", "assets")

S = 1024
SS = 3  # 超采样倍数，画完再缩小，边缘更顺

BG_DARK = (11, 44, 28)
BG_LIGHT = (26, 96, 62)
SEGMENTS = [
    (18, 161, 90),
    (108, 184, 58),
    (229, 168, 0),
    (239, 125, 33),
    (229, 72, 77),
]
NEEDLE_P = 0.62  # 指针位置（0~1）


def lerp(a, b, t):
    return tuple(int(round(a[i] + (b[i] - a[i]) * t)) for i in range(3))


def rounded_gradient(w, h, radius):
    """斜向渐变 + 圆角遮罩"""
    grad = Image.new("RGB", (w, h))
    d = ImageDraw.Draw(grad)
    for y in range(h):
        t = y / h
        d.line([(0, y), (w, y)], fill=lerp(BG_LIGHT, BG_DARK, t))

    mask = Image.new("L", (w, h), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, w - 1, h - 1], radius=radius, fill=255)
    out = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    out.paste(grad, (0, 0), mask)
    return out


def arc_band(img, cx, cy, r, width, start, end, color, steps=240):
    """画一段圆环（用多边形近似，避免 PIL arc 的锯齿）"""
    d = ImageDraw.Draw(img)
    import math

    outer, inner = r, r - width
    pts = []
    for i in range(steps + 1):
        a = math.radians(start + (end - start) * i / steps)
        pts.append((cx + outer * math.cos(a), cy + outer * math.sin(a)))
    for i in range(steps, -1, -1):
        a = math.radians(start + (end - start) * i / steps)
        pts.append((cx + inner * math.cos(a), cy + inner * math.sin(a)))
    d.polygon(pts, fill=color)


def main():
    size = S * SS
    img = rounded_gradient(size, size, radius=int(0.22 * size))
    cx, cy = size * 0.5, size * 0.56
    r = size * 0.30
    band = size * 0.062
    start, sweep = 140.0, 260.0

    # 轨道底环
    arc_band(img, cx, cy, r, band, start, start + sweep, (255, 255, 255, 34))
    # 五段彩色
    n = len(SEGMENTS)
    gap = 2.2
    for i, col in enumerate(SEGMENTS):
        a0 = start + sweep * i / n + gap / 2
        a1 = start + sweep * (i + 1) / n - gap / 2
        arc_band(img, cx, cy, r, band, a0, a1, col + (255,))

    # 指针
    import math

    ang = math.radians(start + sweep * NEEDLE_P)
    tip = (cx + (r - band * 1.55) * math.cos(ang), cy + (r - band * 1.55) * math.sin(ang))
    perp = ang + math.pi / 2
    half = size * 0.022
    base = (cx + size * 0.012 * math.cos(ang - math.pi), cy + size * 0.012 * math.sin(ang - math.pi))
    p1 = (base[0] + half * math.cos(perp), base[1] + half * math.sin(perp))
    p2 = (base[0] - half * math.cos(perp), base[1] - half * math.sin(perp))
    d = ImageDraw.Draw(img)
    d.polygon([tip, p1, p2], fill=(255, 255, 255, 255))

    # 中心轴
    hub = size * 0.052
    d.ellipse([cx - hub, cy - hub, cx + hub, cy + hub], fill=(255, 255, 255, 255))
    d.ellipse([cx - hub * 0.46, cy - hub * 0.46, cx + hub * 0.46, cy + hub * 0.46], fill=BG_DARK + (255,))

    # 下方三个小刻度点
    for i, xoff in enumerate([-0.055, 0, 0.055]):
        rr = size * 0.011
        px, py = cx + size * xoff, cy + size * 0.185
        d.ellipse([px - rr, py - rr, px + rr, py + rr], fill=(255, 255, 255, 110 if i != 1 else 200))

    img = img.filter(ImageFilter.GaussianBlur(0.6 * SS)).resize((S, S), Image.LANCZOS)

    os.makedirs(OUT, exist_ok=True)
    for name, px in [("icon-1024.png", 1024), ("icon-512.png", 512), ("icon-192.png", 192), ("apple-touch-icon.png", 180)]:
        img.resize((px, px), Image.LANCZOS).save(os.path.join(OUT, name), optimize=True)
        print("写入", os.path.join(OUT, name))


if __name__ == "__main__":
    main()
