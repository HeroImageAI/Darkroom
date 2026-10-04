"""Phase B scores, picks and the Phase C helpers -> tests/results/scores-B.json and picks.json."""
import json

F = 'TS 2026-10-03 · 02 Footwear'
G = 'TS 2026-10-03 · 03 Gaming'
M = 'TS 2026-10-03 · 04 Movie'
A = 'TS 2026-10-03 · 05 Automotive'


def t(test, n, v=None):
    return ' · '.join(x for x in [test, n, 's42', v] if x)


def E(test, board, model, titles, score, why, best=None, status='OK'):
    return dict(test=test, board=board, model=model, titles=titles, score=score, why=why, best=best, status=status)


F06 = ['grey clay render', 'designer marker sketch', 'exploded view showing']
M02 = ['blue pre-dawn twilight', 'harsh noon sun', 'deep orange sunset', 'moonlight with a', 'a violent thunderstorm']
M07 = ['loose digital speed-paint', 'photoreal VFX previs', 'charcoal storyboard panel']
ent = [
    E('FTW-IMG-02', F, 'Klein', [t('FTW-IMG-02', 'Klein')], 4, 'every zone clearly a different material (knit, leather, blue foam, gum rubber), crisp boundaries, silhouette kept; recoloured the upper orange unasked', t('FTW-IMG-02', 'Klein')),
    E('FTW-IMG-02', F, 'Qwen', [t('FTW-IMG-02', 'Qwen')], 3, 'silhouette exact but the material change is timid (no gum outsole, leather overlays read as suede); grainy background'),
    E('FTW-IMG-04', F, 'Klein', [t('FTW-IMG-04', 'Klein')], 2, 'nine shoes in a 3×3 grid (asked six in 3×2); several colourways wrong; garbled labels'),
    E('FTW-IMG-04', F, 'Qwen', [t('FTW-IMG-04', 'Qwen')], 3, 'eight shoes in 4×2 (asked six); most colourways recognisable and the shape identical; placeholder labels', t('FTW-IMG-04', 'Qwen')),
    E('FTW-IMG-05', F, 'Klein', [t('FTW-IMG-05', 'Klein')], 3, 'lateral, top-down and rear are right and consistent; a front view instead of the medial', t('FTW-IMG-05', 'Klein')),
    E('FTW-IMG-05', F, 'Qwen', [t('FTW-IMG-05', 'Qwen')], 3, 'lateral twice (no true medial), top-down and rear; consistent materials'),
    E('FTW-IMG-06', F, 'Klein', [t('FTW-IMG-06', 'Klein', v) for v in F06], 5, 'all three presentations convincing with the exact shape: clean clay, a real marker sketch with one orange accent, a believable exploded view', t('FTW-IMG-06', 'Klein', 'grey clay render')),
    E('FTW-IMG-06', F, 'Qwen', [t('FTW-IMG-06', 'Qwen', v) for v in F06], 1, 'returned the input picture unchanged for all three'),
    E('GAM-IMG-02', G, 'Klein', [t('GAM-IMG-02', 'Klein')], 4, 'consistent character in six views in two rows (asked four in a row)'),
    E('GAM-IMG-02', G, 'Qwen', [t('GAM-IMG-02', 'Qwen')], 5, 'exactly front, three-quarter, side and back in a row, same scale, details consistent', t('GAM-IMG-02', 'Qwen')),
    E('GAM-IMG-07', G, 'Klein', [t('GAM-IMG-07', 'Klein')], 4, 'SAM masked the chest armour; a leather harness with glowing blue vials, blended in style (five vials, not three)', t('GAM-IMG-07', 'Klein')),
    E('GAM-IMG-07', G, 'Qwen', [t('GAM-IMG-07', 'Qwen')], 3, 'a boxy harness with four vials pasted on the chest; reads less painted'),
    E('GAM-IMG-08', G, 'Klein', [t('GAM-IMG-08', 'Klein', 'Enhance Restore'), t('GAM-IMG-08', 'Klein', 'Instruct')], 4, 'faithful refinement; Restore warms the haze, Instruct keeps the colours exactly', t('GAM-IMG-08', 'Klein', 'Instruct'), 'ADAPTED'),
    E('GAM-IMG-08', G, 'Qwen', [t('GAM-IMG-08', 'Qwen', 'Enhance Restore'), t('GAM-IMG-08', 'Qwen', 'Instruct')], 2, 'over-sharpened HDR crunch with shifted colours (blue sky, cyan debris), against "do not change the colours"', None, 'ADAPTED'),
    E('MOV-IMG-02', M, 'Klein', [t('MOV-IMG-02', 'Klein', v) for v in M02], 4, "every mood clearly lit and the composition held; carries over the source's dark smudge shapes"),
    E('MOV-IMG-02', M, 'Qwen', [t('MOV-IMG-02', 'Qwen', v) for v in M02], 5, 'every mood convincing and motivated (lightning, lantern, moon); composition held and the smudges cleaned up', t('MOV-IMG-02', 'Qwen', 'deep orange sunset')),
    E('MOV-IMG-03', M, 'Klein', [t('MOV-IMG-03', 'Klein')], 4, 'seamless 2× extension: farmhouse exterior on the left, Karoo plain and mountains on the right, light and grade matched', t('MOV-IMG-03', 'Klein')),
    E('MOV-IMG-03', M, 'Qwen', [t('MOV-IMG-03', 'Qwen')], 3, 'extends the interior with window openings onto the plain; no farmhouse exterior'),
    E('MOV-IMG-07', M, 'Klein', [t('MOV-IMG-07', 'Klein', v) for v in M07], 3, 'charcoal and previs fine; the speed-paint barely looser than the source; smudges kept'),
    E('MOV-IMG-07', M, 'Qwen', [t('MOV-IMG-07', 'Qwen', v) for v in M07], 4, 'three distinct media with the lighting design kept; best charcoal panel', t('MOV-IMG-07', 'Qwen', 'charcoal storyboard panel')),
    E('AUT-IMG-02', A, 'Klein', [t('AUT-IMG-02', 'Klein')], 4, 'a convincing studio clay model, wheels in clay, feature lines readable; side view, not three-quarter', t('AUT-IMG-02', 'Klein')),
    E('AUT-IMG-02', A, 'Qwen', [t('AUT-IMG-02', 'Qwen')], 1, 'not clay: the silver source with a crunchy texture'),
    E('AUT-IMG-03', A, 'Klein', [t('AUT-IMG-03', 'Klein')], 3, 'mirror chrome with the strip-light studio, but the reflections are wavy, not clean continuous lines', t('AUT-IMG-03', 'Klein')),
    E('AUT-IMG-03', A, 'Qwen', [t('AUT-IMG-03', 'Qwen')], 1, 'nearly unchanged from the source, crunchier'),
    E('AUT-IMG-05', A, 'Klein', [t('AUT-IMG-05', 'Klein')], 4, 'SAM found both wheels; gloss-black aero wheels with a thin silver edge, low-profile tyres, seated in the arches', t('AUT-IMG-05', 'Klein')),
    E('AUT-IMG-05', A, 'Qwen', [t('AUT-IMG-05', 'Qwen')], 3, 'clean black multi-spoke wheels, but not aero covers and no silver edge'),
    E('AUT-IMG-06', A, 'Klein', [t('AUT-IMG-06', 'Klein')], 4, 'front, rear, two side profiles and top-down plan, consistent car (one view extra)', t('AUT-IMG-06', 'Klein')),
    E('AUT-IMG-06', A, 'Qwen', [t('AUT-IMG-06', 'Qwen')], 1, 'returned the source unchanged'),
    E('AUT-IMG-08', A, 'Klein', [t('AUT-IMG-08', 'Klein')], 4, 'six finishes in 3×2, identical angle; finishes right (two-tone copper, liquid silver); labels garbled', t('AUT-IMG-08', 'Klein')),
    E('AUT-IMG-08', A, 'Qwen', [t('AUT-IMG-08', 'Qwen')], 2, 'eight cars; only the red, blue, grey and copper match; nonsense labels'),
]
pairs = [
    ('FTW-IMG-02', F, None), ('FTW-IMG-04', F, None), ('FTW-IMG-05', F, None), ('FTW-IMG-06', F, 'grey clay render'),
    ('GAM-IMG-02', G, None), ('GAM-IMG-07', G, None), ('GAM-IMG-08', G, 'Instruct'),
    ('MOV-IMG-02', M, 'deep orange sunset'), ('MOV-IMG-03', M, None), ('MOV-IMG-07', M, 'charcoal storyboard panel'),
    ('AUT-IMG-02', A, None), ('AUT-IMG-03', A, None), ('AUT-IMG-05', A, None), ('AUT-IMG-06', A, None), ('AUT-IMG-08', A, None),
]
cmp = [dict(test=x, board=b, a=t(x, 'Klein', v), b=t(x, 'Qwen', v)) for x, b, v in pairs]
json.dump({'entries': ent, 'compares': cmp}, open('E:/Darkroom/tests/results/scores-B.json', 'w', encoding='utf-8'), ensure_ascii=False, indent=1)

picks = json.load(open('E:/Darkroom/tests/results/picks.json', encoding='utf-8'))
picks.update({
    'FTW-IMG-02': t('FTW-IMG-02', 'Klein'),
    'FTW-IMG-06:clay': t('FTW-IMG-06', 'Klein', 'grey clay render'),
    'GAM-IMG-02': t('GAM-IMG-02', 'Qwen'),
    'MOV-IMG-03': t('MOV-IMG-03', 'Klein'),
    'AUT-IMG-02': t('AUT-IMG-02', 'Klein'),
    'AUT-IMG-08': t('AUT-IMG-08', 'Klein'),
})
# Phase C helpers: video sources the suite asks for that no image test makes (Klein, seed 42)
helpers = [
    dict(action='instruct', testId='FTW-VID-02', sourceTitle=picks['FTW-IMG-01'], model='klein', seed=42, title='FTW-VID-02 · helper · on-foot render',
         prompt="The same shoe worn on a runner's foot mid-stride on a wet asphalt road, low side angle at ground level, early-morning golden light. Keep the shoe's exact shape, materials and colours.", note='helper: the suite needs an on-foot start frame'),
    dict(action='crop', testId='GAM-VID-04', source=None, sourceTitle=picks['GAM-IMG-02'], title='GAM-VID-04 · helper · crop front view', rect=[0.0, 0.12, 0.29, 0.8]),
    dict(action='instruct', testId='AUT-VID-01', sourceTitle=picks['AUT-IMG-01'], model='klein', seed=42, title='AUT-VID-01 · helper · three-quarter render',
         prompt='The same car in silver paint, three-quarter front view on a studio turntable, long softbox reflections, seamless light-grey studio. Keep its exact proportions, wheels and details.', note='helper: the suite needs a three-quarter start frame'),
    dict(action='crop', testId='AUT-VID-02', source=None, sourceTitle=picks['AUT-IMG-08'], title='AUT-VID-02 · helper · crop midnight blue', rect=[0.34, 0.02, 0.66, 0.48]),
    dict(action='crop', testId='AUT-VID-03', source=None, sourceTitle=picks['AUT-IMG-04'], title='AUT-VID-03 · helper · crop headlight', rect=[0.05, 0.36, 0.5, 0.62]),
]
for h in helpers:
    if h['source'] is None if 'source' in h else False:
        h.pop('source')
picks['C:helpers'] = json.dumps(helpers, ensure_ascii=False)
json.dump(picks, open('E:/Darkroom/tests/results/picks.json', 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
print(len(ent), 'entries', len(cmp), 'compares', len(helpers), 'helpers')
