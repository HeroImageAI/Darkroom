"""Phase A scores and picks (Footwear, Gaming, Movie, Automotive) -> tests/results/scores-A.json and picks.json."""
import json

F = 'TS 2026-10-03 · 02 Footwear'
G = 'TS 2026-10-03 · 03 Gaming'
M = 'TS 2026-10-03 · 04 Movie'
A = 'TS 2026-10-03 · 05 Automotive'


def t(test, n, v=None):
    return ' · '.join(x for x in [test, n, 's42', v] if x)


def E(test, board, model, titles, score, why, best=None, status='OK'):
    return dict(test=test, board=board, model=model, titles=titles, score=score, why=why, best=best, status=status)


G04 = ['post-apocalyptic overgrown ruin', 'high-fantasy mountain citadel', 'cyberpunk megacity at']
M06 = ['1970s sci-fi', 'gothic horror', 'post-flood dystopia']
A04 = ['a thin horizontal', 'four stacked rectangular', 'a hidden light']
ent = [
    E('FTW-IMG-01', F, 'Klein', [t('FTW-IMG-01', 'Klein')], 4, "clean render, right materials; fewer of the sketch's overlay and sole lines kept"),
    E('FTW-IMG-01', F, 'Qwen', [t('FTW-IMG-01', 'Qwen')], 5, "keeps the sketch: the wave-sculpted midsole, the overlay lines, stack and toe spring; right materials", t('FTW-IMG-01', 'Qwen')),
    E('FTW-IMG-03', F, 'Klein', [t('FTW-IMG-03', 'Klein')], 3, 'SAM masked the outsole from the word; the new tread is blotchy and partly lost'),
    E('FTW-IMG-03', F, 'Qwen', [t('FTW-IMG-03', 'Qwen')], 4, "a real lugged trail tread following the sole's curve; small white specks at the mask edge", t('FTW-IMG-03', 'Qwen')),
    E('FTW-IMG-07', F, 'Klein', [t('FTW-IMG-07', 'Klein')], 4, 'a new shoe with a clear link to the reference (sole wave, panelling), believable', t('FTW-IMG-07', 'Klein')),
    E('FTW-IMG-07', F, 'Qwen', [t('FTW-IMG-07', 'Qwen')], 2, 'nearly copies the reference shoe (against "do not copy it literally")'),
    E('FTW-IMG-08', F, 'Klein', [t('FTW-IMG-08', 'Klein', 'Enhance Restore'), t('FTW-IMG-08', 'Klein', 'Instruct')], 4, 'faithful, the orc3 logo intact, nothing invented; input already clean', t('FTW-IMG-08', 'Klein', 'Enhance Restore'), 'ADAPTED'),
    E('FTW-IMG-08', F, 'Qwen', [t('FTW-IMG-08', 'Qwen', 'Enhance Restore'), t('FTW-IMG-08', 'Qwen', 'Instruct')], 4, 'faithful, logo intact, nothing invented; input already clean', None, 'ADAPTED'),
    E('GAM-IMG-01', G, 'Klein', [t('GAM-IMG-01', 'Klein')], 4, 'the mech sketch becomes a scavenger keeping its pose and big shield arm; readable silhouette', t('GAM-IMG-01', 'Klein')),
    E('GAM-IMG-01', G, 'Qwen', [t('GAM-IMG-01', 'Qwen')], 3, "a convincing scavenger but the sketch's shield arm is lost"),
    E('GAM-IMG-03', G, 'Klein', [t('GAM-IMG-03', 'Klein')], 4, 'keeps the composition closely (arches, gears) but adds little of the outpost'),
    E('GAM-IMG-03', G, 'Qwen', [t('GAM-IMG-03', 'Qwen')], 4, 'builds the canyon outpost with rope bridges and turbines; composition only partly kept', t('GAM-IMG-03', 'Qwen')),
    E('GAM-IMG-04', G, 'Klein', [t('GAM-IMG-04', 'Klein', v) for v in G04], 5, 'terrain, horizon and camera kept; all three transformations convincing', t('GAM-IMG-04', 'Klein', 'cyberpunk megacity at')),
    E('GAM-IMG-04', G, 'Qwen', [t('GAM-IMG-04', 'Qwen', v) for v in G04], 4, 'terrain kept; the citadel and ruin convincing, the cyberpunk murky'),
    E('MOV-IMG-01', M, 'Klein', [t('MOV-IMG-01', 'Klein')], 3, "one strong keyframe of the figure in the flooded doorway, but odd dark shapes around the figure; portrait, not widescreen (Edit keeps the sketch's shape)", t('MOV-IMG-01', 'Klein')),
    E('MOV-IMG-01', M, 'Qwen', [t('MOV-IMG-01', 'Qwen')], 3, 'rendered the storyboard page literally: three stacked keyframes'),
    E('MOV-IMG-06', M, 'Klein', [t('MOV-IMG-06', 'Klein', v) for v in M06], 4, 'every genre unmistakable with the layout kept (neon retro, gothic spires, floodwater)', t('MOV-IMG-06', 'Klein', 'gothic horror')),
    E('MOV-IMG-06', M, 'Qwen', [t('MOV-IMG-06', 'Qwen', v) for v in M06], 2, 'barely changes the photo; the genres are not recognisable'),
    E('AUT-IMG-01', A, 'Klein', [t('AUT-IMG-01', 'Klein')], 3, 'lowered into a sports coupe: proportions drift from the sketch'),
    E('AUT-IMG-01', A, 'Qwen', [t('AUT-IMG-01', 'Qwen')], 4, "keeps the sketch's raised crossover body, greenhouse and feature lines", t('AUT-IMG-01', 'Qwen')),
    E('AUT-IMG-04', A, 'Klein', [t('AUT-IMG-04', 'Klein', v) for v in A04], 3, 'SAM found both headlights; the new designs are very subtle and barely differ', t('AUT-IMG-04', 'Klein', 'a thin horizontal')),
    E('AUT-IMG-04', A, 'Qwen', [t('AUT-IMG-04', 'Qwen', v) for v in A04], 3, 'same: subtle changes, little difference between the three designs'),
    E('AUT-IMG-07', A, 'Klein', [f'AUT-IMG-07 · Klein · s42 · step {i}' for i in (1, 2, 3)], 5, 'the same car with stable proportions through marker, digital and green photoreal', 'AUT-IMG-07 · Klein · s42 · step 3'),
    E('AUT-IMG-07', A, 'Qwen', [f'AUT-IMG-07 · Qwen · s42 · step {i}' for i in (1, 2, 3)], 2, 'step 1 good; steps 2 and 3 break into noisy, crunchy textures'),
]
pairs = [
    ('FTW-IMG-01', F, t('FTW-IMG-01', 'Klein'), t('FTW-IMG-01', 'Qwen')),
    ('FTW-IMG-03', F, t('FTW-IMG-03', 'Klein'), t('FTW-IMG-03', 'Qwen')),
    ('FTW-IMG-07', F, t('FTW-IMG-07', 'Klein'), t('FTW-IMG-07', 'Qwen')),
    ('FTW-IMG-08', F, t('FTW-IMG-08', 'Klein', 'Enhance Restore'), t('FTW-IMG-08', 'Qwen', 'Enhance Restore')),
    ('GAM-IMG-01', G, t('GAM-IMG-01', 'Klein'), t('GAM-IMG-01', 'Qwen')),
    ('GAM-IMG-03', G, t('GAM-IMG-03', 'Klein'), t('GAM-IMG-03', 'Qwen')),
    ('GAM-IMG-04', G, t('GAM-IMG-04', 'Klein', 'high-fantasy mountain citadel'), t('GAM-IMG-04', 'Qwen', 'high-fantasy mountain citadel')),
    ('MOV-IMG-01', M, t('MOV-IMG-01', 'Klein'), t('MOV-IMG-01', 'Qwen')),
    ('MOV-IMG-06', M, t('MOV-IMG-06', 'Klein', 'gothic horror'), t('MOV-IMG-06', 'Qwen', 'gothic horror')),
    ('AUT-IMG-01', A, t('AUT-IMG-01', 'Klein'), t('AUT-IMG-01', 'Qwen')),
    ('AUT-IMG-04', A, t('AUT-IMG-04', 'Klein', 'a thin horizontal'), t('AUT-IMG-04', 'Qwen', 'a thin horizontal')),
    ('AUT-IMG-07', A, 'AUT-IMG-07 · Klein · s42 · step 3', 'AUT-IMG-07 · Qwen · s42 · step 3'),
]
cmp = [dict(test=x, board=b, a=p, b=q) for x, b, p, q in pairs]
json.dump({'entries': ent, 'compares': cmp}, open('E:/Darkroom/tests/results/scores-A.json', 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
picks = {
    'FTW-IMG-01': t('FTW-IMG-01', 'Qwen'),
    'GAM-IMG-01': t('GAM-IMG-01', 'Klein'),
    'GAM-IMG-03': t('GAM-IMG-03', 'Qwen'),
    'GAM-IMG-04:citadel': t('GAM-IMG-04', 'Qwen', 'high-fantasy mountain citadel'),
    'MOV-IMG-01': t('MOV-IMG-01', 'Klein'),
    'AUT-IMG-01': t('AUT-IMG-01', 'Qwen'),
    'AUT-IMG-04': t('AUT-IMG-04', 'Klein', 'a thin horizontal'),
}
json.dump(picks, open('E:/Darkroom/tests/results/picks.json', 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
print(len(ent), 'entries', len(cmp), 'compares')
