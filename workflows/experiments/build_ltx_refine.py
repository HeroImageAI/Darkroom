"""
LTX 2.5 IC-LoRA video-to-video (decision 98): a take goes in, is resized (lanczos) to the output canvas, and is given
to LTXVAddGuide as an in-context reference with the IC-LoRA's own parameters (GetICLoRAParameters reads the file's
reference_downscale_factor). 8 distilled sigmas, euler ancestral (eta 0, as Darkroom's i2v), CFG 1. The take's sound
is kept. Titles follow Darkroom's conventions (DR_VIDEO, DR_WIDTH, DR_HEIGHT, DR_MOTION_PROMPT, DR_SEED, DR_OUTPUT).
Usage: python build_ltx_refine.py <lora file> <out.json>
"""
import json
import sys

LORA = sys.argv[1] if len(sys.argv) > 1 else 'ltx-2.5-22b-ic-lora-refine-details-1.0.safetensors'
OUT = sys.argv[2] if len(sys.argv) > 2 else 'experiments/ltx25_v2v_refine.json'
PREFIX = sys.argv[3] if len(sys.argv) > 3 else 'darkroom/video/refined'

b = json.load(open('ltx25_i2v.v2.json'))
n = {k: b[k] for k in ['1', '2', '3', '4', '5', '6', '8', '9', '10', '24', '25', '26']}
n['5']['_meta']['title'] = 'DR_WIDTH'
n['6']['_meta']['title'] = 'DR_HEIGHT'


def node(i, cls, title, **inputs):
    n[str(i)] = {'class_type': cls, 'inputs': inputs, '_meta': {'title': title}}


node(70, 'LoadVideo', 'DR_VIDEO', file='darkroom_placeholder.mp4')
node(71, 'GetVideoComponents', 'Components', video=['70', 0])
node(72, 'ImageScale', 'To canvas', image=['71', 0], upscale_method='lanczos', width=['5', 0], height=['6', 0], crop='center')
node(73, 'GetImageSize', 'Frames', image=['72', 0])
node(60, 'LoraLoaderModelOnly', 'IC-LoRA', model=['1', 0], lora_name=LORA, strength_model=1.0)
node(61, 'GetICLoRAParameters', 'IC-LoRA parameters', iclora_model=['60', 0])
node(11, 'LTXVConditioning', 'Frame rate', positive=['9', 0], negative=['10', 0], frame_rate=['71', 2])
node(18, 'EmptyLTXVLatentVideo', 'Video latent', width=['5', 0], height=['6', 0], length=['73', 2], batch_size=1)
node(19, 'LTXVAddGuide', 'Reference', positive=['11', 0], negative=['11', 1], vae=['3', 0], latent=['18', 0], image=['72', 0], frame_idx=0, strength=1.0, iclora_parameters=['61', 0])
node(21, 'LTXVEmptyLatentAudio', 'Audio latent', frames_number=['73', 2], frame_rate=['71', 2], batch_size=1, audio_vae=['4', 0])
node(22, 'LTXVConcatAVLatent', 'AV latent', video_latent=['19', 2], audio_latent=['21', 0])
node(23, 'LTXVDualCFGGuider', 'Guider', model=['60', 0], positive=['19', 0], negative=['19', 1], video_cfg=1.0, audio_cfg=1.0)
node(27, 'SamplerCustomAdvanced', 'Sample', noise=['24', 0], guider=['23', 0], sampler=['25', 0], sigmas=['26', 0], latent_image=['22', 0])
node(28, 'LTXVSeparateAVLatent', 'Split AV', av_latent=['27', 1])
node(29, 'LTXVCropGuides', 'Crop guides', positive=['19', 0], negative=['19', 1], latent=['28', 0])
node(30, 'VAEDecodeTiled', 'Decode', samples=['29', 2], vae=['3', 0], tile_size=512, overlap=64, temporal_size=64, temporal_overlap=16)
node(32, 'CreateVideo', 'Create video', images=['30', 0], fps=['71', 2], audio=['71', 1])
n['33'] = json.loads(json.dumps(b['33'])); n['33']['inputs']['filename_prefix'] = PREFIX
node(34, 'ImageFromBatch', 'Poster frame', image=['30', 0], batch_index=0, length=1)
node(35, 'SaveImage', 'DR_POSTER', images=['34', 0], filename_prefix=PREFIX + '_poster')
node(36, 'ImageFromBatch', 'Last frame', image=['30', 0], batch_index=4095, length=1)
node(37, 'SaveImage', 'DR_LAST_FRAME', images=['36', 0], filename_prefix=PREFIX + '_last')
json.dump(n, open(OUT, 'w'), indent=2)
print(OUT, len(n), 'nodes')
