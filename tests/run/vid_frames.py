"""Frames of each Phase C video (through the Library player) -> one contact sheet per video in tests/results/sheets/<TEST>.jpg.
python tests/run/vid_frames.py   (reads ids from tests/results/.planC.out)"""
import json
import os
import re
import subprocess

from PIL import Image, ImageDraw

os.chdir('E:/Darkroom')
B = {'FTW': 'TS 2026-10-03 · 02 Footwear', 'GAM': 'TS 2026-10-03 · 03 Gaming', 'MOV': 'TS 2026-10-03 · 04 Movie', 'AUT': 'TS 2026-10-03 · 05 Automotive'}
T = [0.1, 1.2, 2.4, 3.6, 4.9]
for line in open('tests/results/.planC.out', encoding='utf-8'):
    m = re.match(r'(\w+-VID-\d+) · LTX.*?(\{.*\})', line)
    if not m:
        continue
    test, res = m.group(1), json.loads(m.group(2))
    if 'id' not in res:
        print(test, res)
        continue
    spec = dict(id=res['id'], board=B[test[:3]], testId=test, name=f'{test}_frame', times=T)
    json.dump(spec, open('tests/results/.spec.json', 'w', encoding='utf-8'), ensure_ascii=False)
    out = subprocess.run('npx tsx tests/run/ui.ts frames tests/results/.spec.json', shell=True, capture_output=True, text=True, encoding='utf-8').stdout
    r = [l for l in out.splitlines() if l.startswith('RESULT')]
    paths = json.loads(r[0][7:]).get('paths', []) if r else []
    if not paths:
        print(test, 'no frames', out[-300:])
        continue
    ims = [Image.open(p).convert('RGB') for p in paths]
    for im in ims:
        im.thumbnail((420, 420))
    w = sum(i.width for i in ims) + 6 * len(ims)
    h = max(i.height for i in ims) + 20
    g = Image.new('RGB', (w, h), (25, 25, 25))
    d = ImageDraw.Draw(g)
    x = 0
    for t, im in zip(T, ims):
        g.paste(im, (x, 20))
        d.text((x + 4, 4), f'{test} t={t}s', fill=(235, 235, 235))
        x += im.width + 6
    g.save(f'tests/results/sheets/{test}.jpg', quality=85)
    print(test, len(ims))
