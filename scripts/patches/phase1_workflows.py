# Phase 1: versioned video graphs without inert negatives; manifest settings per PROMPT_AUDIT P6/P7/P12.
import json, re

s = open('build_workflows.py', encoding='utf-8').read()
if 'def wan22_i2v(negative=' not in s:
    s = s.replace('def wan22_i2v():', 'def wan22_i2v(negative=WAN_NEGATIVE):')
    s = s.replace('neg = g.add("CLIPTextEncode", "DR_NEGATIVE", text=WAN_NEGATIVE, clip=o(te))',
                  'neg = g.add("CLIPTextEncode", "DR_NEGATIVE", text=negative, clip=o(te))')
    s = s.replace('def ltx25_i2v():', 'def ltx25_i2v(negative=LTX_NEGATIVE):')
    s = s.replace('neg = g.add("CLIPTextEncode", "DR_NEGATIVE", text=LTX_NEGATIVE, clip=o(te))',
                  'neg = g.add("CLIPTextEncode", "DR_NEGATIVE", text=negative, clip=o(te))')
    s = s.replace('    wan22_i2v().save("wan22_i2v.json")',
                  '    wan22_i2v().save("wan22_i2v.json")\n'
                  '    # v2: negatives removed - inert at CFG 1 (comfy/samplers.py skips the uncond pass). PROMPT_AUDIT P6/P7.\n'
                  '    wan22_i2v(negative="").save("wan22_i2v.v2.json")')
    s = s.replace('    ltx25_i2v().save("ltx25_i2v.json")',
                  '    ltx25_i2v().save("ltx25_i2v.json")\n    ltx25_i2v(negative="").save("ltx25_i2v.v2.json")')
    open('build_workflows.py', 'w', encoding='utf-8').write(s)

m = json.load(open('manifest.json', encoding='utf-8'))
W = m['workflows']
for name in ('wan22_i2v', 'ltx25_i2v'):
    W[name]['file'] = f'{name}.v2.json'
    W[name]['params'].pop('negative', None)

# Klein: distilled, CFG 1 only (PROMPT_AUDIT P12)
m['models']['klein']['ranges']['cfg'] = [1.0, 1.0]
m['models']['klein']['ranges']['steps'] = [4, 8]
for wf in ('klein_t2i', 'klein_ref'):
    W[wf]['params']['cfg'].update(min=1.0, max=1.0)

# Qwen-Image 2.1 quality presets (card: 40 steps, ~4 MP buckets; template: 25 steps default)
m['models']['qwen']['quality'] = {
    "standard": {"label": "Standard", "note": "25 steps, ~1.8 MP", "steps": 25,
                 "aspects": m['models']['qwen']['aspects']},
    "high": {"label": "High", "note": "40 steps, ~4 MP (model-card sizes)", "steps": 40,
             "aspects": {"1:1": [2048, 2048], "4:5": [1792, 2240], "3:2": [2528, 1696],
                         "16:9": [2752, 1536], "9:16": [1536, 2752]}},
}
m['models']['qwen']['ranges']['cfg'] = [1.0, 1.0]
for wf in ('qwen_t2i', 'qwen_ref'):
    W[wf]['params']['width']['max'] = 2816
    W[wf]['params']['height']['max'] = 2816
    W[wf]['params']['cfg'].update(min=1.0, max=1.0)
m['models']['klein']['licence'] = "FLUX.2 [klein] 9B: FLUX Non-Commercial License (personal/non-commercial use)."
m['models']['qwen']['licence'] = "Qwen-Image 2.1: Qwen Research License - non-commercial use only."
json.dump(m, open('manifest.json', 'w', encoding='utf-8'), indent=2, ensure_ascii=False)
print('phase1 workflows + manifest updated')
