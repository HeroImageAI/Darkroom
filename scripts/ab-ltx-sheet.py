"""Contact sheets for the LTX A/B (scripts/ab-ltx.ts): per case, one row per variant with frames at 0 %, 50 % and
100 % and a 100 % crop from the middle frame; also reports a sharpness score (variance of the Laplacian) of the
middle frame. Usage: python scripts/ab-ltx-sheet.py"""
import json
import os
import av
import numpy as np
from PIL import Image, ImageDraw, ImageFilter

OUT = os.path.join(os.path.dirname(__file__), '..', 'docs', 'qa', 'ltx')
rows = json.load(open(os.path.join(OUT, 'runs.json')))
variants = json.load(open(os.path.join(OUT, 'variants.json')))


def frames(mp4):
    with av.open(mp4) as c:
        fs = [f.to_image() for f in c.decode(video=0)]
        has_audio = any(s.type == 'audio' for s in c.streams)
    return fs, has_audio


def sharpness(im):
    g = np.asarray(im.convert('L'), dtype=float)
    lap = g[1:-1, 1:-1] * 4 - g[:-2, 1:-1] - g[2:, 1:-1] - g[1:-1, :-2] - g[1:-1, 2:]
    return float(lap.var())


report = []
for key in sorted({r['key'] for r in rows}, key=lambda k: [r['key'] for r in rows].index(k)):
    tiles = []
    for v in variants:
        r = next((x for x in rows if x['key'] == key and x['variant'] == v['id'] and x['ok']), None)
        if not r:
            continue
        mp4 = next(f for f in r['files'] if f.endswith('.mp4'))
        fs, audio = frames(mp4)
        picks = [fs[0], fs[len(fs) // 2], fs[-1]]
        mid = picks[1]
        H = 220
        small = [p.resize((int(p.width * H / p.height), H)) for p in picks]
        cw = 300
        cx, cy = mid.width // 2, int(mid.height * 0.45)
        crop = mid.crop((cx - cw // 2, cy - cw // 2, cx + cw // 2, cy + cw // 2)).resize((H, H))
        sh = sharpness(mid)
        report.append((key, v['id'], r['seconds'], r['peak'], len(fs), mid.size, sh, audio))
        row = Image.new('RGB', (sum(s.width for s in small) + H + 40, H + 22), (18, 18, 18))
        d = ImageDraw.Draw(row)
        x = 0
        for im, lab in zip(small + [crop], ['start', 'middle', 'end', 'middle 100%']):
            row.paste(im, (x, 22))
            d.text((x + 4, 5), f"{v['id']} {lab}", fill=(230, 230, 230))
            x += im.width + 10
        d.text((x - H - 10 + 4, 5 + 0), '', fill=(230, 230, 230))
        tiles.append(row)
    if not tiles:
        continue
    W = max(t.width for t in tiles)
    sheet = Image.new('RGB', (W, sum(t.height + 8 for t in tiles)), (18, 18, 18))
    y = 0
    for t in tiles:
        sheet.paste(t, (0, y))
        y += t.height + 8
    sheet.save(os.path.join(OUT, f'{key}.jpg'), quality=86)

for k, vid, s, p, n, size, sh, audio in report:
    print(f'{k:9} {vid:6} {s:>6}s {p:>5}GB {n:3} frames {size[0]}x{size[1]} sharpness {sh:8.1f} audio {audio}')
