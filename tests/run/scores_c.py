"""Phase C video scores -> tests/results/plan-C-score.json (annotate steps for plan.ts)."""
import json
import re

B = {'FTW': 'TS 2026-10-03 · 02 Footwear', 'GAM': 'TS 2026-10-03 · 03 Gaming', 'MOV': 'TS 2026-10-03 · 04 Movie', 'AUT': 'TS 2026-10-03 · 05 Automotive'}
ADAPTED = {'FTW-VID-02', 'GAM-VID-04', 'MOV-VID-04', 'AUT-VID-01', 'AUT-VID-02', 'AUT-VID-03'}
S = {
    'FTW-VID-01': (4, 'the shoe turns on the spot from lateral through front to medial without morphing; no visible plinth and closer to 270° than 360°'),
    'FTW-VID-02': (4, 'wet road, golden light and a convincing water spray on each strike; the shoe stays the same shoe; the stride is slow and the midsole compression barely visible'),
    'FTW-VID-03': (2, 'no dark studio or light sweep: the shoe itself darkens to black over the clip, so the design changes'),
    'FTW-VID-04': (4, 'clay to finished shoe smoothly with the shape locked; colour arrives everywhere at once rather than heel to toe'),
    'GAM-VID-01': (2, 'dust and breathing, but the camera pushes in (asked static) and the big shield arm melts away by 2 s'),
    'GAM-VID-02': (4, 'a steady forward glide into the canyon with turbines and bridges holding their shape; few moving figures'),
    'GAM-VID-03': (3, 'banners and birds appear and the citadel is stable, but it is a slow push and drift, not a crane up; walkers vanish'),
    'GAM-VID-04': (2, 'no orbit: the camera pulls back to full body; the character stays consistent (the crop is a narrow portrait)'),
    'MOV-VID-01': (3, 'the dolly push-in is right, but the figure turns fully to camera and his face and shirt are invented; the source smudges stay'),
    'MOV-VID-04': (4, 'a real crane up and back over the farmhouse roof to the plain, mountains and sunlit clouds; the roof geometry shifts a little'),
    'AUT-VID-01': (3, 'the car turns about 30° on the turntable with reflections sliding nicely; far from 360°'),
    'AUT-VID-02': (2, 'no road or tracking: the car turns from side to front on the white sheet and the nose is reinvented; the garbled label stays (small 383×214 crop)'),
    'AUT-VID-03': (4, 'the light blade ignites with a glint and the camera drifts along the lamp; no segment-by-segment sequence (small 450×260 crop)'),
    'AUT-VID-04': (3, 'static camera and the bar travels roof to sill, but as a glowing band in front of the car, not a highlight on the clay'),
    'AUT-VID-05': (4, 'sketch fills to the photoreal car smoothly and the proportions hold; it fills everywhere at once rather than front to back'),
}
steps = []
for line in open('E:/Darkroom/tests/results/.planC.out', encoding='utf-8'):
    m = re.match(r'(\w+-VID-\d+) · LTX.*?(\{.*\})', line)
    if not m or 'id' not in json.loads(m.group(2)):
        continue
    t, vid = m.group(1), json.loads(m.group(2))['id']
    score, why = S[t]
    steps.append(dict(action='annotate', id=vid, board=B[t[:3]], appendNotes=f'score: {score}/5 — {why}',
                      log=dict(test_id=t, model='LTX', library_item_id=vid, library_item_name=f'{t} · LTX · Final 720p', duration=5, fps=24,
                               resolution='Final 720p', status='ADAPTED' if t in ADAPTED else 'OK', score=score, notes=why)))
json.dump(steps, open('E:/Darkroom/tests/results/plan-C-score.json', 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
print(len(steps))
