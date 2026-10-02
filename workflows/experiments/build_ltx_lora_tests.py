"""
LTX 2.5 LoRA test graphs (decision 98), from Darkroom's single-pass ltx25_i2v.v2.json:
  ltx25_i2v.lora_<name>.json      LoraLoaderModelOnly(<file>, strength) after DR_MODEL
  ltx25_i2v.slowmo_<speed>.json   the slow-motion LoRA, and LTXVConditioning told the motion frame rate
                                   (fps / speed, the model card's motion_fps) while the clip still plays at fps
  ltx25_i2v.motionfps_<speed>.json the same frame-rate trick without the LoRA (does the conditioning alone do it?)
"""
import json

base = json.load(open('ltx25_i2v.v2.json'))


def with_lora(g, name, strength):
    g = json.loads(json.dumps(g))
    g['60'] = {'class_type': 'LoraLoaderModelOnly', 'inputs': {'model': ['1', 0], 'lora_name': name, 'strength_model': strength}, '_meta': {'title': 'DR_USER_LORA_1'}}
    for n in g.values():
        for k, v in n['inputs'].items():
            if v == ['1', 0] and n is not g['60']:
                n['inputs'][k] = ['60', 0]
    return g


def motion_fps(g, speed):
    g = json.loads(json.dumps(g))
    g['61'] = {'class_type': 'ComfyMathExpression', 'inputs': {'expression': f'a / {speed}', 'values.a': ['8', 0]}, '_meta': {'title': 'Motion fps'}}
    g['11']['inputs']['frame_rate'] = ['61', 0]
    return g


json.dump(with_lora(base, 'ltx-2.5-22b-lora-cinemagraph-0.9.safetensors', 1.1), open('experiments/ltx25_i2v.lora_cinemagraph.json', 'w'), indent=2)
slow = with_lora(base, 'ltx-2.5-22b-lora-slow-motion-control-1.0.safetensors', 1.0)
for sp in ['0.5', '0.2']:
    json.dump(motion_fps(slow, sp), open(f'experiments/ltx25_i2v.slowmo_{sp}.json', 'w'), indent=2)
json.dump(motion_fps(base, '0.2'), open('experiments/ltx25_i2v.motionfps_0.2.json', 'w'), indent=2)
print('ok')
