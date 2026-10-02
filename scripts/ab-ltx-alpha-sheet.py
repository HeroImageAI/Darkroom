"""Alpha-Gen check (decision 99): source frame, matte, subject over a flat colour; matte flicker over time."""
import glob, os, sys
import av
import numpy as np
from PIL import Image, ImageDraw

OUT = os.path.join(os.path.dirname(__file__), '..', 'docs', 'qa', 'ltx-alpha')
SRC = dict(zip(['portrait', 'street', 'harbour'], [l.strip() for l in open(sys.argv[1])]))


def frames(p):
    with av.open(p) as c:
        return [f.to_image().convert('RGB') for f in c.decode(video=0)]


rows = []
for key, src in SRC.items():
    m = glob.glob(os.path.join(OUT, key, '*.mp4'))
    if not m:
        continue
    rgb, matte = frames(src), frames(m[0])
    n = min(len(rgb), len(matte))
    mats = [np.asarray(x.convert('L'), dtype=float) / 255 for x in matte[:n]]
    flick = float(np.mean([np.abs(mats[i + 1] - mats[i]).mean() for i in range(n - 1)]))
    fg = float(np.mean([(x > 0.5).mean() for x in mats]))
    soft = float(np.mean([((x > 0.1) & (x < 0.9)).mean() for x in mats]))
    print(f'{key:9} frames {n}  foreground {fg:.2f}  soft-edge share {soft:.3f}  matte change/frame {flick:.4f}')
    i = n // 2
    a = np.asarray(rgb[i].resize(matte[i].size), dtype=float)
    al = mats[i][..., None]
    bg = np.zeros_like(a)
    bg[...] = (40, 160, 90)
    comp = Image.fromarray((a * al + bg * (1 - al)).astype('uint8'))
    H = 300
    ims = [rgb[i].resize(matte[i].size), matte[i], comp]
    ims = [x.resize((int(x.width * H / x.height), H)) for x in ims]
    row = Image.new('RGB', (sum(x.width for x in ims) + 20, H + 22), (18, 18, 18))
    d = ImageDraw.Draw(row)
    x = 0
    for im, lab in zip(ims, ['take', 'Alpha-Gen matte', 'subject over a flat colour']):
        row.paste(im, (x, 22))
        d.text((x + 4, 5), f'{key}: {lab}', fill=(230, 230, 230))
        x += im.width + 10
    rows.append(row)
W = max(r.width for r in rows)
g = Image.new('RGB', (W, sum(r.height + 8 for r in rows)), (18, 18, 18))
y = 0
for r in rows:
    g.paste(r, (0, y))
    y += r.height + 8
g.save(os.path.join(OUT, 'sheet.jpg'), quality=88)
