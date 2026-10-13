#!/usr/bin/env python3
"""LifeBoard · 生成应用图标（需要 Pillow）

用法：python tools/make-icons.py
输出：icons/icon-192.png、icons/icon-512.png、icons/icon-maskable-512.png、icons/apple-touch-icon.png
"""
from __future__ import annotations

import os
from PIL import Image, ImageDraw

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(os.path.dirname(HERE), "icons")

BG = (14, 17, 22, 255)
PANEL = (26, 32, 41)
TIER_COLORS = [
    (255, 122, 89),
    (255, 212, 59),
    (165, 216, 255),
    (139, 152, 165),
]


def draw_mark(img: Image.Image, inset: float) -> None:
    """在已有底图上画 tier 条形标记；inset 为内容相对边长的内缩比例。"""
    size = img.width
    d = ImageDraw.Draw(img, "RGBA")

    pad = size * inset
    content = size - pad * 2
    rows = len(TIER_COLORS)
    gap = content * 0.045
    row_h = (content - gap * (rows - 1)) / rows
    badge_w = row_h * 0.86
    bar_gap = row_h * 0.34
    radius = row_h * 0.28

    for i, color in enumerate(TIER_COLORS):
        y = pad + i * (row_h + gap)
        # 左侧色块
        d.rounded_rectangle(
            [pad, y, pad + badge_w, y + row_h],
            radius=radius,
            fill=color + (255,),
        )
        # 右侧条目条
        bar_w = content * (0.86 - i * 0.14)
        bx = pad + badge_w + bar_gap
        d.rounded_rectangle(
            [bx, y + row_h * 0.12, bx + bar_w, y + row_h * 0.88],
            radius=row_h * 0.2,
            fill=PANEL + (255,),
        )
        d.rounded_rectangle(
            [bx, y + row_h * 0.12, bx + bar_w, y + row_h * 0.88],
            radius=row_h * 0.2,
            outline=color + (110,),
            width=max(1, int(size * 0.006)),
        )


def rounded_base(size: int, radius_ratio: float, opaque: bool) -> Image.Image:
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    radius = int(size * radius_ratio)
    d.rounded_rectangle([0, 0, size - 1, size - 1], radius=radius, fill=BG)
    if opaque:
        # iOS 主屏图标不支持透明，四角用底色填平
        flat = Image.new("RGBA", (size, size), BG)
        flat.alpha_composite(img)
        return flat
    return img


def main() -> None:
    os.makedirs(OUT, exist_ok=True)

    for size, name, inset, radius_ratio, opaque in [
        (192, "icon-192.png", 0.20, 0.22, False),
        (512, "icon-512.png", 0.20, 0.22, False),
        (512, "icon-maskable-512.png", 0.28, 0.0, True),
        (180, "apple-touch-icon.png", 0.20, 0.0, True),
    ]:
        img = rounded_base(size, radius_ratio, opaque)
        draw_mark(img, inset)
        path = os.path.join(OUT, name)
        img.save(path, "PNG", optimize=True)
        print("wrote", path, img.size)


if __name__ == "__main__":
    main()
