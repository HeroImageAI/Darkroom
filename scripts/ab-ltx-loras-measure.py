"""Measures for the LTX LoRA tests (scripts/ab-ltx-loras.ts): motion per frame in regions, loop error, and sheets."""
import json, os
import av
import numpy as np
from PIL import Image, ImageDraw

OUT = os.path.join(os.path.dirname(__file__), '..', 'docs', 'qa', 'ltx-loras')
rows = [r for r in json.load(open(os.path.join(OUT, 'runs.json'))) if r['ok']]


def frames(mp4):
    with av.open(mp4) as c:
        return [np.asarray(f.to_image().convert('L'), dtype=float) for f in c.decode(video=0)], [f for f in []]


def motion(fs, rows_slice):
    return float(np.mean([np.abs(fs[i + 1][rows_slice] - fs[i][rows_slice]).mean() for i in range(len(fs) - 1)]))


sheets = []
for r in rows:
    mp4 = next(f for f in r['files'] if f.endswith('.mp4'))
    with av.open(mp4) as c:
        imgs = [f.to_image() for f in c.decode(video=0)]
    fs = [np.asarray(i.convert('L'), dtype=float) for i in imgs]
    h = fs[0].shape[0]
    top, bottom, whole = slice(0, int(h * 0.35)), slice(int(h * 0.6), h), slice(0, h)
    loop = float(np.abs(fs[-1] - fs[0]).mean())
    print(f"{r['key']:22} {r['seconds']:>6}s  motion/frame: whole {motion(fs, whole):5.2f}  top {motion(fs, top):5.2f}  bottom {motion(fs, bottom):5.2f}  | first-vs-last {loop:5.1f}")
    H = 160
    picks = [imgs[0], imgs[len(imgs) // 3], imgs[2 * len(imgs) // 3], imgs[-1]]
    row = Image.new('RGB', (4 * int(864 * H / 480) + 30 + 170, H), (18, 18, 18))
    d = ImageDraw.Draw(row)
    d.text((4, 4), r['key'], fill=(230, 230, 230))
    x = 170
    for p in picks:
        row.paste(p.resize((int(864 * H / 480), H)), (x, 0))
        x += int(864 * H / 480) + 10
    sheets.append(row)
W = max(s.width for s in sheets)
g = Image.new('RGB', (W, sum(s.height + 6 for s in sheets)), (18, 18, 18))
y = 0
for s in sheets:
    g.paste(s, (0, y))
    y += s.height + 6
g.save(os.path.join(OUT, 'sheet.jpg'), quality=86)
