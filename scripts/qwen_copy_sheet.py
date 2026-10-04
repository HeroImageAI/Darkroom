"""Sheet + change score for try-qwen-copy.ts results: python scripts/qwen_copy_sheet.py <dir> <input png>
Change = mean absolute pixel difference to the input (0-255) after resizing to the input's size."""
import glob
import os
import sys

import numpy as np
from PIL import Image, ImageDraw

d, src = sys.argv[1], sys.argv[2]
a = Image.open(src).convert('RGB')
A = np.asarray(a, dtype=np.float32)
files = sorted(glob.glob(os.path.join(d, '*.png')), key=os.path.getmtime)
tiles = [('input', a, 0.0)]
for f in files:
    im = Image.open(f).convert('RGB')
    diff = float(np.abs(np.asarray(im.resize(a.size), dtype=np.float32) - A).mean())
    tiles.append((os.path.basename(f)[:-4], im, diff))
    print(f'{os.path.basename(f)[:-4]:10s} change {diff:5.1f}')
W = 420
H = int(W * a.height / a.width)
g = Image.new('RGB', (3 * (W + 6), ((len(tiles) + 2) // 3) * (H + 22)), (25, 25, 25))
dr = ImageDraw.Draw(g)
for i, (n, im, diff) in enumerate(tiles):
    x, y = (i % 3) * (W + 6), (i // 3) * (H + 22)
    g.paste(im.resize((W, H)), (x, y + 20))
    dr.text((x + 4, y + 4), f'{n}  change {diff:.1f}', fill=(235, 235, 235))
g.save(os.path.join(d, 'sheet.jpg'), quality=85)
