#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""生成 claude-ui 的图标。

配色跟界面同一套：深底 #0e131a + 荧光绿 #7ee787。
图案是一行终端提示符 —— `>_`。

跑法:
    python make_icon.py
产出（都写在脚本所在目录）:
    claude-ui.ico      多尺寸 16/24/32/48/64/128/256
    _icon_preview.png  256px 预览图，看完可以删
"""
import os

from PIL import Image, ImageDraw

BG     = (14, 19, 26, 255)       # #0e131a
BORDER = (38, 50, 63, 255)       # #26323f
GREEN  = (126, 231, 135, 255)    # #7ee787

SIZES = [16, 24, 32, 48, 64, 128, 256]
HERE = os.path.dirname(os.path.abspath(__file__))


def draw(size):
    """按给定边长画一张。按尺寸重算线宽，小图标才不会糊成一团。"""
    S = size
    img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    # 圆角底
    pad = S * 0.035
    d.rounded_rectangle(
        [pad, pad, S - pad, S - pad],
        radius=S * 0.24,
        fill=BG,
        outline=BORDER,
        width=max(1, round(S * 0.022)),
    )

    w = max(1, round(S * 0.085))          # 笔画粗细

    # ">" 折线（joint="curve" 让拐角圆过去，不然两段线之间会豁口）
    x1, x2 = S * 0.25, S * 0.45
    y1, ym, y2 = S * 0.34, S * 0.51, S * 0.68
    d.line([x1, y1, x2, ym, x1, y2], fill=GREEN, width=w, joint="curve")

    # "_"
    d.line([S * 0.55, y2, S * 0.76, y2], fill=GREEN, width=w)

    return img


if __name__ == "__main__":
    # 小尺寸单独画（直接把 256 缩到 16 会糊）
    frames = [draw(s) for s in SIZES]
    big = frames[-1]                       # 256 当底图
    big.save(os.path.join(HERE, "claude-ui.ico"), format="ICO",
             sizes=[(s, s) for s in SIZES])
    big.save(os.path.join(HERE, "_icon_preview.png"))
    print("wrote claude-ui.ico + _icon_preview.png ->", HERE)
