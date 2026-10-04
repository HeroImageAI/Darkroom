"""Klein-vs-Qwen contact sheets from the runner's result screenshots (what the UI showed).
python tests/run/sheets.py TEST_ID [TEST_ID …]   ->  tests/results/sheets/<TEST_ID>.jpg"""
import glob
import os
import sys

from PIL import Image, ImageDraw

os.chdir('E:/Darkroom/tests/results/screenshots')
for t in sys.argv[1:]:
    fs = sorted(glob.glob(f'{t}/*_result.png'))
    masks = sorted(glob.glob(f'{t}/*_mask.png'))
    rows = [[f for f in fs if '_Klein_' in f], [f for f in fs if '_Qwen_' in f]]
    if masks:
        rows[0] = [m for m in masks if '_Klein_' in m][:1] + rows[0]
        rows[1] = [m for m in masks if '_Qwen_' in m][:1] + rows[1]
    W, H = 440, 330
    cols = max(len(r) for r in rows) or 1
    g = Image.new('RGB', (cols * (W + 6), 2 * (H + 22)), (25, 25, 25))
    d = ImageDraw.Draw(g)
    for r, lst in enumerate(rows):
        for c, f in enumerate(lst):
            box = (380, 56, 1328, 900) if 'Generate' in f else (80, 120, 1040, 840)
            im = Image.open(f).convert('RGB').crop(box)
            im.thumbnail((W, H))
            g.paste(im, (c * (W + 6), r * (H + 22) + 20))
            d.text((c * (W + 6) + 4, r * (H + 22) + 4), os.path.basename(f).replace('.png', '')[:62], fill=(235, 235, 235))
    g.save(f'../sheets/{t}.jpg', quality=85)
    print(t, [len(r) for r in rows])
