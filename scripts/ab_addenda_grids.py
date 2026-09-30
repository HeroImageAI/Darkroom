"""Grids for the Addenda A/B runs: one sheet per group, rows = cases, one column per variant.
Run with ComfyUI's Python (Pillow + PyAV):  python scripts/ab_addenda_grids.py p1
Writes docs/qa/addenda/<phase>/<group>.jpg. RGBA results are shown on a checkerboard."""
import json, os, sys
from PIL import Image, ImageDraw, ImageFont

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CELL = 360
try:
    FONT = ImageFont.truetype('arial.ttf', 14)
except OSError:
    FONT = ImageFont.load_default()


def checker(w, h, s=12):
    im = Image.new('RGB', (w, h), (205, 205, 205))
    d = ImageDraw.Draw(im)
    for y in range(0, h, s):
        for x in range((y // s) % 2 * s, w, 2 * s):
            d.rectangle([x, y, x + s - 1, y + s - 1], fill=(150, 150, 150))
    return im


def cell(path):
    if path.lower().endswith('.mp4'):
        import av
        frames = [f.to_image() for f in av.open(path).decode(video=0)]
        out = Image.new('RGB', (CELL, CELL), (20, 20, 18))
        w = CELL // 3
        for i, f in enumerate([frames[0], frames[len(frames) // 2], frames[-1]]):
            f = f.copy(); f.thumbnail((w, CELL)); out.paste(f, (i * w, (CELL - f.height) // 2))
        return out
    im = Image.open(path)
    im.thumbnail((CELL, CELL))
    out = Image.new('RGB', (CELL, CELL), (20, 20, 18))
    x, y = (CELL - im.width) // 2, (CELL - im.height) // 2
    if im.mode in ('RGBA', 'LA'):
        out.paste(checker(im.width, im.height), (x, y))
        out.paste(im.convert('RGBA'), (x, y), im.convert('RGBA'))
    else:
        out.paste(im.convert('RGB'), (x, y))
    return out


def wrap(d, text, width):
    words, line, lines = text.split(), '', []
    for w in words:
        if line and d.textlength(line + ' ' + w, font=FONT) > width:
            lines.append(line); line = w
        else:
            line = (line + ' ' + w).strip()
    return lines + ([line] if line else [])


def main(phase):
    qa = os.path.join(ROOT, 'docs', 'qa', 'addenda', phase)
    runs = json.load(open(os.path.join(qa, 'runs.json'), encoding='utf-8'))
    variants = json.load(open(os.path.join(qa, 'variants.json'), encoding='utf-8'))
    for gid, vs in variants.items():
        rows = {}
        for r in runs:
            if r['group'] == gid:
                rows.setdefault(r['key'], {})[r['variant']] = r
        if not rows:
            continue
        label_w, head = 170, 54
        W = label_w + len(vs) * (CELL + 8)
        H = head + len(rows) * (CELL + 30)
        sheet = Image.new('RGB', (W, H), (18, 18, 16))
        d = ImageDraw.Draw(sheet)
        for j, v in enumerate(vs):
            for k, line in enumerate(wrap(d, v['label'], CELL - 6)[:2]):
                d.text((label_w + j * (CELL + 8), 8 + k * 18), line, fill=(240, 180, 76) if j else (160, 156, 146), font=FONT)
        for i, (key, byv) in enumerate(rows.items()):
            y = head + i * (CELL + 30)
            d.text((8, y + 8), key, fill=(237, 235, 229), font=FONT)
            for j, v in enumerate(vs):
                r = byv.get(v['id'])
                x = label_w + j * (CELL + 8)
                if r and r.get('ok') and r.get('file_out') and os.path.exists(os.path.join(ROOT, r['file_out'])):
                    sheet.paste(cell(os.path.join(ROOT, r['file_out'])), (x, y))
                    cold = ' (cold)' if r.get('cold') else ''
                    d.text((x, y + CELL + 6), f"{r.get('seconds', '?')}s{cold}  {r.get('peak', '?')} GB", fill=(160, 156, 146), font=FONT)
                else:
                    d.text((x + 10, y + CELL // 2), 'missing / failed' if r else 'not run', fill=(220, 90, 80), font=FONT)
        out = os.path.join(qa, f'{gid}.jpg')
        sheet.save(out, quality=88)
        print('wrote', out)


if __name__ == '__main__':
    main(sys.argv[1] if len(sys.argv) > 1 else 'p1')
