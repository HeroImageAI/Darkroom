"""Phase 6 grids: one sheet per feature, rows = cases, columns = input | output(s).
RGBA outputs are shown on a checkerboard. Run with ComfyUI's Python (Pillow + PyAV)."""
import json, os
from PIL import Image, ImageDraw, ImageFont

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
QA = os.path.join(ROOT, 'docs', 'qa', 'phase6')
CELL = 300
try:
    FONT = ImageFont.truetype('arial.ttf', 14)
except OSError:
    FONT = ImageFont.load_default()


def checker(w, h, s=12):
    im = Image.new('RGB', (w, h), (34, 34, 34))
    d = ImageDraw.Draw(im)
    for y in range(0, h, s):
        for x in range((y // s) % 2 * s, w, 2 * s):
            d.rectangle([x, y, x + s - 1, y + s - 1], fill=(48, 48, 48))
    return im


def cell(path):
    if path.lower().endswith('.mp4'):
        import av
        c = av.open(path)
        fr = [f.to_image() for f in c.decode(video=0)]
        pick = [fr[0], fr[len(fr) // 2], fr[-1]]
        out = Image.new('RGB', (CELL, CELL), (20, 20, 18))
        w = CELL // 3
        for i, f in enumerate(pick):
            f = f.copy(); f.thumbnail((w, CELL)); out.paste(f, (i * w, (CELL - f.height) // 2))
        return out
    im = Image.open(path)
    im.thumbnail((CELL, CELL))
    bg = checker(CELL, CELL)
    x, y = (CELL - im.width) // 2, (CELL - im.height) // 2
    if im.mode in ('RGBA', 'LA'):
        bg.paste(im.convert('RGBA'), (x, y), im.convert('RGBA'))
    else:
        bg.paste(im.convert('RGB'), (x, y))
    return bg


def main():
    runs = json.load(open(os.path.join(QA, 'runs.json'), encoding='utf-8'))
    feats = {}
    for r in runs:
        if r.get('ok') and r.get('files'):
            feats.setdefault(r['feature'], []).append(r)
    for f, rows in feats.items():
        ncols = 1 + min(4, max(len(r['files']) for r in rows))
        W, H = 200 + ncols * (CELL + 8), 34 + len(rows) * (CELL + 8)
        sheet = Image.new('RGB', (W, H), (18, 18, 16))
        d = ImageDraw.Draw(sheet)
        d.text((210, 10), 'input', fill=(160, 156, 146), font=FONT)
        d.text((210 + CELL + 8, 10), 'output', fill=(240, 180, 76), font=FONT)
        for i, r in enumerate(rows):
            y = 34 + i * (CELL + 8)
            d.text((8, y + 8), r['id'], fill=(237, 235, 229), font=FONT)
            d.text((8, y + 28), f"{r.get('seconds', '?')}s  {r.get('peak', '?')} GB", fill=(240, 180, 76), font=FONT)
            if r.get('note'):
                # wrap the note into the 190 px label column
                words, line, ly = r['note'].split(), '', y + 50
                for w in words:
                    if d.textlength(line + ' ' + w, font=FONT) > 185 and line:
                        d.text((8, ly), line, fill=(160, 156, 146), font=FONT); ly += 18; line = w
                    else:
                        line = (line + ' ' + w).strip()
                if line:
                    d.text((8, ly), line, fill=(160, 156, 146), font=FONT)
            src = next(iter((r.get('images') or {}).values()), None)
            if src:
                sheet.paste(cell(os.path.join(ROOT, src)), (200, y))
            for j, fp in enumerate(r['files'][:4]):
                sheet.paste(cell(os.path.join(ROOT, fp)), (200 + (j + 1) * (CELL + 8), y))
        out = os.path.join(QA, f'{f}.jpg')
        sheet.save(out, quality=88)
        print('wrote', out)


if __name__ == '__main__':
    main()
