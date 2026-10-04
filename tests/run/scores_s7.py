"""Qwen re-runs on seed 7 (seed 42 made Qwen return its input, DECISIONS 107) -> tests/results/scores-s7.json"""
import json

F = 'TS 2026-10-03 · 02 Footwear'
M = 'TS 2026-10-03 · 04 Movie'
A = 'TS 2026-10-03 · 05 Automotive'


def t(test, v=None):
    return ' · '.join(x for x in [test, 'Qwen', 's7', v] if x)


def E(test, board, titles, score, why, best=None):
    return dict(test=test, board=board, model='Qwen', seed=7, titles=titles, score=score, why=why, best=best, status='OK')


ent = [
    E('FTW-IMG-02', F, [t('FTW-IMG-02')], 4, 'seed 7: blue-tint foam midsole and gum outsole clear, silhouette exact; the knit and leather zones still timid'),
    E('FTW-IMG-06', F, [t('FTW-IMG-06', v) for v in ['grey clay render', 'designer marker sketch', 'exploded view showing']], 4,
      'seed 7: a real grey clay render, a light marker sketch with one red accent, an exploded view of the sole layers (upper stays whole)'),
    E('AUT-IMG-02', A, [t('AUT-IMG-02')], 4, 'seed 7: a convincing warm-grey clay model, wheels in clay; side view, not three-quarter'),
    E('AUT-IMG-03', A, [t('AUT-IMG-03')], 5, 'seed 7: mirror chrome, three-quarter front view as asked, clean continuous strip-light reflections', t('AUT-IMG-03')),
    E('AUT-IMG-06', A, [t('AUT-IMG-06')], 4, 'seed 7: front, rear, three-quarter side and top-down plan of the same car; one view is ¾ instead of a true profile'),
    E('AUT-IMG-07', A, [f'AUT-IMG-07 · Qwen · s7 · step {i}' for i in (1, 2, 3)], 2, 'seed 7: the same as seed 42 — step 1 good, steps 2 and 3 return the drawing with heavy grain (a real Qwen limit on its own output)'),
    E('MOV-IMG-06', M, [t('MOV-IMG-06', v) for v in ['1970s sci-fi', 'gothic horror', 'post-flood dystopia']], 2, 'seed 7: only the flood version changes the scene; 1970s sci-fi and gothic stay a lightly regraded photo'),
]
json.dump({'entries': ent}, open('E:/Darkroom/tests/results/scores-s7.json', 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
print(len(ent))
