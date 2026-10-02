"""
LTX 2.5 two-stage image-to-video (official ComfyUI template structure, decision 96 A/B), built from Darkroom's
single-stage ltx25_i2v.v2.json so every DR_* title (and so the manifest params) stays the same:
  stage 1 at half size (start / end guides), euler ancestral, 8 distilled sigmas
  -> crop guides -> x2 latent spatial upscaler
  -> stage 2 at full size: guides again, the stage-1 audio latent carried over, 3 refine sigmas from 0.85
  -> crop guides -> decode video (tiled) + audio.
Usage: python build_ltx_twostage.py <stage1-start-strength> <out.json>
"""
import json
import sys

S1 = float(sys.argv[1]) if len(sys.argv) > 1 else 1.0
OUT = sys.argv[2] if len(sys.argv) > 2 else 'experiments/ltx25_i2v.twostage.json'

g = json.load(open('ltx25_i2v.v2.json'))
keep = {str(i) for i in [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 21, 23, 24, 26, 31, 32, 33, 34, 35, 36, 37]}
n = {k: v for k, v in g.items() if k in keep}

def node(i, cls, title, **inputs):
    n[str(i)] = {'class_type': cls, 'inputs': inputs, '_meta': {'title': title}}

# stage 1, half size
node(40, 'ComfyMathExpression', 'Half width', expression='a/2', **{'values.a': ['5', 0]})
node(41, 'ComfyMathExpression', 'Half height', expression='a/2', **{'values.a': ['6', 0]})
node(18, 'EmptyLTXVLatentVideo', 'Video latent (half)', width=['40', 1], height=['41', 1], length=['7', 0], batch_size=1)
node(19, 'LTXVAddGuide', 'DR_START_GUIDE', positive=['11', 0], negative=['11', 1], vae=['3', 0], latent=['18', 0], image=['14', 0], frame_idx=0, strength=S1)
node(20, 'LTXVAddGuide', 'DR_END_GUIDE', positive=['19', 0], negative=['19', 1], vae=['3', 0], latent=['19', 2], image=['17', 0], frame_idx=-1, strength=0.9)
node(22, 'LTXVConcatAVLatent', 'AV latent', video_latent=['20', 2], audio_latent=['21', 0])
n['23']['inputs'].update(positive=['20', 0], negative=['20', 1])
node(25, 'KSamplerSelect', 'Sampler', sampler_name='euler_ancestral')
node(27, 'SamplerCustomAdvanced', 'Stage 1', noise=['24', 0], guider=['23', 0], sampler=['25', 0], sigmas=['26', 0], latent_image=['22', 0])
node(28, 'LTXVSeparateAVLatent', 'Split AV 1', av_latent=['27', 1])
node(29, 'LTXVCropGuides', 'Crop guides 1', positive=['20', 0], negative=['20', 1], latent=['28', 0])
# x2 latent upscale
node(43, 'LatentUpscaleModelLoader', 'Spatial upscaler', model_name='ltx-2.5-latent-spatial-upscaler-x2-bf16-1.0.safetensors')
node(44, 'LTXVLatentUpsampler', 'Upscale x2', samples=['29', 2], upscale_model=['43', 0], vae=['3', 0])
# stage 2, full size
node(45, 'LTXVAddGuide', 'DR_START_GUIDE_2', positive=['29', 0], negative=['29', 1], vae=['3', 0], latent=['44', 0], image=['14', 0], frame_idx=0, strength=1.0)
node(46, 'LTXVAddGuide', 'DR_END_GUIDE',  # same title: the manifest bypasses both when there is no end frame
     positive=['45', 0], negative=['45', 1], vae=['3', 0], latent=['45', 2], image=['17', 0], frame_idx=-1, strength=0.9)
node(47, 'LTXVConcatAVLatent', 'AV latent 2', video_latent=['46', 2], audio_latent=['28', 1])
node(48, 'LTXVDualCFGGuider', 'Guider 2', model=['1', 0], positive=['46', 0], negative=['46', 1], video_cfg=1.0, audio_cfg=1.0)
node(49, 'RandomNoise', 'Stage 2 noise', noise_seed=42)
node(50, 'ManualSigmas', 'Refine sigmas', sigmas='0.85, 0.7250, 0.4219, 0.0')
node(51, 'SamplerCustomAdvanced', 'Stage 2', noise=['49', 0], guider=['48', 0], sampler=['25', 0], sigmas=['50', 0], latent_image=['47', 0])
node(52, 'LTXVSeparateAVLatent', 'Split AV 2', av_latent=['51', 1])
node(53, 'LTXVCropGuides', 'Crop guides 2', positive=['46', 0], negative=['46', 1], latent=['52', 0])
node(30, 'VAEDecodeTiled', 'Decode', samples=['53', 2], vae=['3', 0], tile_size=512, overlap=64, temporal_size=64, temporal_overlap=16)
n['31']['inputs']['samples'] = ['52', 1]
json.dump(n, open(OUT, 'w'), indent=2)
print(OUT, len(n), 'nodes, stage-1 start strength', S1)
