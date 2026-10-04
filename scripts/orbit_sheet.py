"""Contact sheets for scripts/try-orbit.ts: per object, the input then each camera move, plain Qwen above the orbit LoRA,
on a checkerboard so transparency shows. Also reports how much of each result is transparent.
python scripts/orbit_sheet.py <dir> <name>=<input png> …"""
import glob
import os
import sys

from PIL import Image, ImageDraw

d = sys.argv[1]
MOVES = ['45-right', '90-left', '180', '45-right-high']
T = 300


def checker(w, h, s=12):
    c = Image.new('RGB', (w, h), (205, 205, 205))
    dr = ImageDraw.Draw(c)
    for y in range(0, h, s):
        for x in range((y // s) % 2 * s, w, 2 * s):
            dr.rectangle([x, y, x + s - 1, y + s - 1], fill=(235, 235, 235))
    return c


def tile(path):
    im = Image.open(path)
    alpha = None
    if im.mode in ('RGBA', 'LA'):
        a = im.getchannel('A')
        alpha = sum(1 for v in a.getdata() if v < 16) / (a.width * a.height)
    im = im.convert('RGBA')
    im.thumbnail((T, T))
    bg = checker(T, T)
    bg.paste(im, ((T - im.width) // 2, (T - im.height) // 2), im)
    return bg, alpha


for arg in sys.argv[2:]:
    name, src = arg.split('=')
    g = Image.new('RGB', ((len(MOVES) + 1) * (T + 6), 2 * (T + 24) + 24), (22, 20, 18))
    dr = ImageDraw.Draw(g)
    inp, a0 = tile(src)
    g.paste(inp, (0, 24 + (T + 24) // 2))
    dr.text((4, 6), f'{name}: input (alpha {a0:.0%} clear)' if a0 is not None else f'{name}: input', fill=(235, 235, 235))
    for c, mv in enumerate(MOVES):
        for r, kind in enumerate(['plain', 'orbit']):
            p = os.path.join(d, f'{name}_{mv}_{kind}.png')
            if not os.path.exists(p):
                continue
            t, a = tile(p)
            x, y = (c + 1) * (T + 6), 24 + r * (T + 24)
            g.paste(t, (x, y + 16))
            dr.text((x + 4, y + 2), f'{mv} · {kind}' + (f' · {a:.0%} clear' if a is not None else ' · no alpha'), fill=(235, 235, 235))
    g.save(os.path.join(d, f'sheet_{name}.jpg'), quality=88)
    print(name, 'ok')
