"""Build old-vs-new comparison grids from docs/qa/phase1/runs.json.
Run with ComfyUI's Python (has Pillow + PyAV):  python scripts/ab_grids.py
Writes docs/qa/phase1/<group>.png (rows = cases, columns = old | new)."""
import json, os, sys
from PIL import Image, ImageDraw, ImageFont

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
QA = os.path.join(ROOT, 'docs', 'qa', 'phase1')
CELL = 360
try:
    FONT = ImageFont.truetype('arial.ttf', 15)
except OSError:
    FONT = ImageFont.load_default()


def thumb(path):
    if path.lower().endswith('.mp4'):
        import av
        c = av.open(path)
        frames = [f.to_image() for f in c.decode(video=0)]
        pick = [frames[0], frames[len(frames) // 2], frames[-1]]
        w = CELL // 3
        strip = Image.new('RGB', (CELL, CELL), (20, 20, 18))
        for i, fr in enumerate(pick):
            fr = fr.copy()
            fr.thumbnail((w, CELL))
            strip.paste(fr, (i * w, (CELL - fr.height) // 2))
        return strip
    im = Image.open(path)
    if im.mode == 'RGBA':
        bg = Image.new('RGBA', im.size, (255, 0, 255, 255))
        bg.alpha_composite(im)
        im = bg
    im = im.convert('RGB')
    im.thumbnail((CELL, CELL))
    cell = Image.new('RGB', (CELL, CELL), (20, 20, 18))
    cell.paste(im, ((CELL - im.width) // 2, (CELL - im.height) // 2))
    return cell


def main():
    runs = json.load(open(os.path.join(QA, 'runs.json'), encoding='utf-8'))
    groups = {}
    for r in runs:
        if not r.get('ok') or not r.get('file_out'):
            continue
        groups.setdefault(r['group'], {}).setdefault(r['key'], {})[r['variant']] = r
    for g, cases in groups.items():
        keys = [k for k in cases if 'old' in cases[k] and 'new' in cases[k]]
        if not keys:
            continue
        label_w = 190
        W = label_w + 2 * CELL + 30
        H = 40 + len(keys) * (CELL + 10)
        sheet = Image.new('RGB', (W, H), (18, 18, 16))
        d = ImageDraw.Draw(sheet)
        d.text((label_w + 10, 10), 'OLD (v1.0 prompts)', fill=(160, 156, 146), font=FONT)
        d.text((label_w + CELL + 20, 10), 'NEW (model-specific)', fill=(240, 180, 76), font=FONT)
        for i, k in enumerate(keys):
            y = 40 + i * (CELL + 10)
            d.text((10, y + 10), k, fill=(237, 235, 229), font=FONT)
            for j, v in enumerate(('old', 'new')):
                r = cases[k][v]
                sheet.paste(thumb(os.path.join(ROOT, r['file_out'])), (label_w + 10 + j * (CELL + 10), y))
                if r.get('seconds'):
                    d.text((label_w + 16 + j * (CELL + 10), y + CELL - 20), f"{r['seconds']}s", fill=(240, 180, 76), font=FONT)
        out = os.path.join(QA, f'{g}.png')
        sheet.save(out)
        print('wrote', out, len(keys), 'rows')


if __name__ == '__main__':
    main()
