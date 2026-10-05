"""Score sketch-to-render results (Edit suite v3.29): how much of the drawing survives in the render.

line recall = share of the sketch's ink pixels that have an edge in the render within a few pixels (the outline and
details were followed); edge precision = share of the render's edges that lie on the drawing (low = invented detail,
which is fine for texture, bad for shape). Writes <dir>/scores.txt and one contact sheet per case.
    python scripts/sketch_score.py tests/results/sketch-ab
"""
import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageFont

d = Path(sys.argv[1])
TOL = 5  # px


def ink(p: Path) -> np.ndarray:
    g = np.asarray(Image.open(p).convert('L'), dtype=np.float32)
    return g < 110


def edges(p: Path, size) -> np.ndarray:
    im = Image.open(p).convert('L').resize(size, Image.LANCZOS).filter(ImageFilter.GaussianBlur(1.2))
    a = np.asarray(im, dtype=np.float32)
    gx = np.abs(np.diff(a, axis=1, prepend=a[:, :1]))
    gy = np.abs(np.diff(a, axis=0, prepend=a[:1, :]))
    g = np.hypot(gx, gy)
    return g > max(12.0, np.percentile(g, 88))


def dilate(m: np.ndarray, r: int) -> np.ndarray:
    im = Image.fromarray((m * 255).astype(np.uint8)).filter(ImageFilter.MaxFilter(2 * r + 1))
    return np.asarray(im) > 0


lines = []
for sk in sorted(d.glob('*_sketch.png')):
    case = sk.name[: -len('_sketch.png')]
    L = ink(sk)
    size = (L.shape[1], L.shape[0])
    row = [(sk, 'sketch', None)]
    for r in sorted(d.glob(f'{case}_*.png')):
        tag = r.stem[len(case) + 1 :]
        if tag == 'sketch' or tag.endswith('sheet'):
            continue
        E = edges(r, size)
        recall = (L & dilate(E, TOL)).sum() / max(1, L.sum())
        precision = (E & dilate(L, TOL)).sum() / max(1, E.sum())
        row.append((r, tag, (recall, precision)))
        lines.append(f'{case:11s} {tag:12s} line recall {recall:5.2f}  edge precision {precision:5.2f}')
    # sheet
    th = 300
    tiles = []
    for p, tag, sc in row:
        im = Image.open(p).convert('RGB')
        im = im.resize((round(im.width * th / im.height), th), Image.LANCZOS)
        cap = Image.new('RGB', (im.width, th + 34), '#1a1917')
        cap.paste(im, (0, 0))
        dr = ImageDraw.Draw(cap)
        label = tag if sc is None else f'{tag}  recall {sc[0]:.2f} · prec {sc[1]:.2f}'
        dr.text((8, th + 9), label, fill='#f2f0ea', font=ImageFont.load_default(15) if hasattr(ImageFont, 'load_default') else None)
        tiles.append(cap)
    W = sum(t.width for t in tiles) + 8 * (len(tiles) + 1)
    sheet = Image.new('RGB', (W, th + 34 + 16), '#111')
    x = 8
    for t in tiles:
        sheet.paste(t, (x, 8))
        x += t.width + 8
    sheet.save(d / f'{case}_sheet.jpg', quality=88)
(d / 'scores.txt').write_text('\n'.join(lines) + '\n')
print('\n'.join(lines))
