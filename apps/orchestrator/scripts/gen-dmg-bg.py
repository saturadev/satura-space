"""
Generate a polished DMG background for Satura Space.
Light gradient background, no wordmark, hint text visible at bottom.
Window: 620x430 logical px  (@2x: 1240x860)
"""
import os
from PIL import Image, ImageDraw, ImageFont

W, H = 620, 430

APP_X, APP_Y = 175, 195
APPS_X, APPS_Y = 445, 195

TOP_COLOR    = (250, 250, 252)
BOTTOM_COLOR = (225, 226, 230)

DOTS  = (210, 211, 215)
ARROW = (160, 161, 165)
HINT  = (110, 111, 115)

def lerp(a, b, t):
    return tuple(int(a[i] + (b[i] - a[i]) * t) for i in range(3))

def make_bg(scale=1):
    sw, sh = W * scale, H * scale
    img = Image.new("RGB", (sw, sh))
    draw = ImageDraw.Draw(img)

    for y in range(sh):
        t = y / (sh - 1)
        draw.line([(0, y), (sw, y)], fill=lerp(TOP_COLOR, BOTTOM_COLOR, t))

    step = 22 * scale
    r = max(1, scale - 1)
    for gx in range(step // 2, sw, step):
        for gy in range(step // 2, sh, step):
            draw.ellipse([gx - r, gy - r, gx + r, gy + r], fill=DOTS)

    try:
        hint_font = ImageFont.truetype("/System/Library/Fonts/Helvetica.ttc", 12 * scale)
    except Exception:
        hint_font = ImageFont.load_default()

    icon_r = 60 * scale
    gap    = 16 * scale
    ax1 = APP_X  * scale + icon_r + gap
    ax2 = APPS_X * scale - icon_r - gap
    mid_y = APP_Y * scale
    ah   = 2 * scale
    head = 9 * scale

    draw.rectangle([ax1, mid_y - ah // 2, ax2 - head, mid_y + ah // 2], fill=ARROW)
    draw.polygon([
        (ax2,        mid_y),
        (ax2 - head, mid_y - head),
        (ax2 - head, mid_y + head),
    ], fill=ARROW)

    hint = "Drag Satura Space to Applications to install"
    bbox = draw.textbbox((0, 0), hint, font=hint_font)
    hw = bbox[2] - bbox[0]
    draw.text(((sw - hw) // 2, 24 * scale), hint, fill=HINT, font=hint_font)

    return img

img1x = make_bg(1)
img2x = make_bg(2)

out1 = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "build", "dmg-background.png")
out2 = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "build", "dmg-background@2x.png")

img1x.save(out1, "PNG")
img2x.save(out2, "PNG")
print(f"Written {out1}")
print(f"Written {out2}")
