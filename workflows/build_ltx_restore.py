"""
LTX 2.5 Restore (decision 100): one window of a clip, repaired by the Restore IC-LoRA.
  DR_VIDEO frames [DR_START, DR_START + DR_LENGTH) -> lanczos to the canvas -> in-context reference (IC-LoRA params)
  optional DR_PREV: the previous restored window; its last 17 frames guide this window's first 17 (continuity,
  as Lightricks chain long clips), so windows join without a jump.
  8 distilled sigmas, CFG 1; no sound here (the source's sound is put back when the windows are joined).
Writes workflows/ltx25_v2v_restore.json.
"""
import json

b = json.load(open('ltx25_i2v.v2.json'))
n = {k: b[k] for k in ['1', '2', '3', '4', '5', '6', '9', '10', '24', '25', '26']}
n['5']['_meta']['title'] = 'DR_WIDTH'
n['6']['_meta']['title'] = 'DR_HEIGHT'


def node(i, cls, title, **inputs):
    n[str(i)] = {'class_type': cls, 'inputs': inputs, '_meta': {'title': title}}


node(70, 'LoadVideo', 'DR_VIDEO', file='darkroom_placeholder.mp4')
node(71, 'GetVideoComponents', 'Components', video=['70', 0])
node(80, 'PrimitiveInt', 'DR_START', value=0)
node(81, 'PrimitiveInt', 'DR_LENGTH', value=97)
node(82, 'ImageFromBatch', 'Window', image=['71', 0], batch_index=['80', 0], length=['81', 0])
node(72, 'ImageScale', 'To canvas', image=['82', 0], upscale_method='lanczos', width=['5', 0], height=['6', 0], crop='center')
node(73, 'GetImageSize', 'Frames', image=['72', 0])
node(60, 'LoraLoaderModelOnly', 'IC-LoRA', model=['1', 0], lora_name='ltx-2.5-22b-ic-lora-restore-1.0.safetensors', strength_model=1.0)
node(61, 'GetICLoRAParameters', 'IC-LoRA parameters', iclora_model=['60', 0])
node(11, 'LTXVConditioning', 'Frame rate', positive=['9', 0], negative=['10', 0], frame_rate=['71', 2])
node(18, 'EmptyLTXVLatentVideo', 'Video latent', width=['5', 0], height=['6', 0], length=['73', 2], batch_size=1)
# continuity with the previous window (bypassed by the manifest when there is none)
node(90, 'LoadVideo', 'DR_PREV', file='darkroom_placeholder.mp4')
node(91, 'GetVideoComponents', 'Previous window', video=['90', 0])
node(92, 'GetImageSize', 'Previous size', image=['91', 0])
node(93, 'ComfyMathExpression', 'Tail start', expression='a - 17', **{'values.a': ['92', 2]})
node(94, 'ImageFromBatch', 'Previous tail', image=['91', 0], batch_index=['93', 1], length=17)
node(95, 'LTXVAddGuide', 'DR_PREV_GUIDE', positive=['11', 0], negative=['11', 1], vae=['3', 0], latent=['18', 0], image=['94', 0], frame_idx=0, strength=1.0)
node(19, 'LTXVAddGuide', 'Reference', positive=['95', 0], negative=['95', 1], vae=['3', 0], latent=['95', 2], image=['72', 0], frame_idx=0, strength=1.0, iclora_parameters=['61', 0])
node(21, 'LTXVEmptyLatentAudio', 'Audio latent', frames_number=['73', 2], frame_rate=['71', 2], batch_size=1, audio_vae=['4', 0])
node(22, 'LTXVConcatAVLatent', 'AV latent', video_latent=['19', 2], audio_latent=['21', 0])
node(23, 'LTXVDualCFGGuider', 'Guider', model=['60', 0], positive=['19', 0], negative=['19', 1], video_cfg=1.0, audio_cfg=1.0)
node(27, 'SamplerCustomAdvanced', 'Sample', noise=['24', 0], guider=['23', 0], sampler=['25', 0], sigmas=['26', 0], latent_image=['22', 0])
node(28, 'LTXVSeparateAVLatent', 'Split AV', av_latent=['27', 1])
node(29, 'LTXVCropGuides', 'Crop guides', positive=['19', 0], negative=['19', 1], latent=['28', 0])
node(30, 'VAEDecodeTiled', 'Decode', samples=['29', 2], vae=['3', 0], tile_size=512, overlap=64, temporal_size=64, temporal_overlap=16)
node(32, 'CreateVideo', 'Create video', images=['30', 0], fps=['71', 2])
n['33'] = json.loads(json.dumps(b['33']))
n['33']['inputs']['filename_prefix'] = 'darkroom/video/restore_part'
node(34, 'ImageFromBatch', 'Poster frame', image=['30', 0], batch_index=0, length=1)
node(35, 'SaveImage', 'DR_POSTER', images=['34', 0], filename_prefix='darkroom/video/restore_part_poster')
node(36, 'ImageFromBatch', 'Last frame', image=['30', 0], batch_index=4095, length=1)
node(37, 'SaveImage', 'DR_LAST_FRAME', images=['36', 0], filename_prefix='darkroom/video/restore_part_last')
json.dump(n, open('ltx25_v2v_restore.json', 'w'), indent=2)
print('ltx25_v2v_restore.json', len(n), 'nodes')
