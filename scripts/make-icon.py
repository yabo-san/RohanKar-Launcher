"""Draw the y4bo app icon (assets/icons/y4bo.png + y4bo.ico).

Wordmark "y4bo" with "bo" in the key red #fc3c44, on the app's dark tile.
Needs Pillow and Inter Display ExtraBold (SIL OFL). Run: python3 scripts/make-icon.py [font.otf]
"""
import os
import sys
from PIL import Image, ImageDraw, ImageFont

FONT = sys.argv[1] if len(sys.argv) > 1 else '/usr/share/fonts/opentype/inter/InterDisplay-ExtraBold.otf'
OUT = os.path.join(os.path.dirname(__file__), '..', 'assets', 'icons')
S = 1024
WHITE, RED, BG = (242, 242, 242, 255), (252, 60, 68, 255), (22, 22, 24, 255)

img = Image.new('RGBA', (S, S), (0, 0, 0, 0))
d = ImageDraw.Draw(img)
d.rounded_rectangle((40, 40, S - 40, S - 40), radius=210, fill=BG)

font = ImageFont.truetype(FONT, 330)
track = -18
parts = [('y4', WHITE), ('bo', RED)]
def width(t):
    return sum(font.getlength(c) for c in t) + track * (len(t) - 1)
total = width('y4bo')
l, t, r, b = font.getbbox('y4bo', anchor='ls')
x = (S - total) / 2
y = S / 2 - (t + b) / 2  # centre ink vertically on the baseline
for text, col in parts:
    for c in text:
        d.text((x, y), c, font=font, fill=col, anchor='ls')
        x += font.getlength(c) + track

img.save(os.path.join(OUT, 'y4bo.png'))
img.save(os.path.join(OUT, 'y4bo.ico'), sizes=[(s, s) for s in (16, 24, 32, 48, 64, 128, 256)])
