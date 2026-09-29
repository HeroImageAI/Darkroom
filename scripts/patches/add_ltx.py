# one-off: add the LTX-2.5 workflow to the generator and manifest
import json

s = open('build_workflows.py', encoding='utf-8').read()
if 'def ltx25_i2v' not in s:
    s = s.replace('INTERP_MODEL = "rife_v4.26.safetensors"', '''INTERP_MODEL = "rife_v4.26.safetensors"
LTX_UNET = "ltx-2.5-22b-distilled-transformer-comfy-int8-convrot.safetensors"
LTX_TE = "gemma4-12b-with-proj-ltx-2.5-comfy-int8-convrot.safetensors"
LTX_VAE = "ltx-2.5-video-vae-bf16.safetensors"
LTX_AUDIO_VAE = "ltx-2.5-audio-vae-bf16.safetensors"
LTX_NEGATIVE = ("blurry, out of focus, overexposed, underexposed, low contrast, washed out colors, excessive noise, "
                "flickering, distorted proportions, deformed face, extra limbs, disfigured hands, jittery movement, "
                "unnatural transitions, cartoonish rendering, 3D CGI look, AI artifacts, subtitles, text overlay")''')
    s = s.replace('\n\ndef video_interp():', '''

def ltx25_i2v():
    """LTX-2.5 distilled, single stage at full resolution (from the official FLF2V template).
    Start frame guide at frame 0, optional end frame guide at frame -1. Generates synced audio."""
    g = G()
    unet = g.add("UNETLoader", "DR_MODEL", unet_name=LTX_UNET, weight_dtype="default")
    te = g.add("CLIPLoader", "DR_TEXT_ENCODER", clip_name=LTX_TE, type="ltxv", device="default")
    vae = g.add("VAELoader", "DR_VAE", vae_name=LTX_VAE)
    avae = g.add("VAELoader", "Audio VAE", vae_name=LTX_AUDIO_VAE)
    w = g.add("PrimitiveInt", "DR_WIDTH", value=864)
    h = g.add("PrimitiveInt", "DR_HEIGHT", value=480)
    fr = g.add("PrimitiveInt", "DR_FRAMES", value=121)
    fps = g.add("PrimitiveFloat", "DR_FPS", value=24.0)
    pos = g.add("CLIPTextEncode", "DR_MOTION_PROMPT", text="", clip=o(te))
    neg = g.add("CLIPTextEncode", "DR_NEGATIVE", text=LTX_NEGATIVE, clip=o(te))
    cond = g.add("LTXVConditioning", "Frame rate", positive=o(pos), negative=o(neg), frame_rate=o(fps))
    start = g.add("LoadImage", "DR_START_IMAGE", image=PLACEHOLDER_IMAGE)
    s_fit = g.add("ImageScale", "Start fit", image=o(start), upscale_method="lanczos", width=o(w), height=o(h), crop="center")
    s_pre = g.add("LTXVPreprocess", "Start prep", image=o(s_fit), img_compression=18)
    end = g.add("LoadImage", "DR_END_IMAGE", image=PLACEHOLDER_IMAGE)
    e_fit = g.add("ImageScale", "End fit", image=o(end), upscale_method="lanczos", width=o(w), height=o(h), crop="center")
    e_pre = g.add("LTXVPreprocess", "End prep", image=o(e_fit), img_compression=18)
    lat = g.add("EmptyLTXVLatentVideo", "Video latent", width=o(w), height=o(h), length=o(fr), batch_size=1)
    g1 = g.add("LTXVAddGuide", "DR_START_GUIDE", positive=o(cond, 0), negative=o(cond, 1), vae=o(vae), latent=o(lat),
               image=o(s_pre), frame_idx=0, strength=1.0)
    g2 = g.add("LTXVAddGuide", "DR_END_GUIDE", positive=o(g1, 0), negative=o(g1, 1), vae=o(vae), latent=o(g1, 2),
               image=o(e_pre), frame_idx=-1, strength=0.9)
    alat = g.add("LTXVEmptyLatentAudio", "Audio latent", frames_number=o(fr), frame_rate=o(fps), batch_size=1, audio_vae=o(avae))
    av = g.add("LTXVConcatAVLatent", "AV latent", video_latent=o(g2, 2), audio_latent=o(alat))
    guider = g.add("LTXVDualCFGGuider", "Guider", model=o(unet), positive=o(g2, 0), negative=o(g2, 1), video_cfg=1.0, audio_cfg=1.0)
    noise = g.add("RandomNoise", "DR_SEED", noise_seed=0)
    sampler = g.add("SamplerEulerAncestral", "Sampler", eta=0.0, s_noise=1.0)
    sigmas = g.add("ManualSigmas", "DR_SIGMAS", sigmas="1.0, 0.99375, 0.9875, 0.98125, 0.975, 0.909375, 0.725, 0.421875, 0.0")
    samp = g.add("SamplerCustomAdvanced", "Sample", noise=o(noise), guider=o(guider), sampler=o(sampler), sigmas=o(sigmas), latent_image=o(av))
    sep = g.add("LTXVSeparateAVLatent", "Split AV", av_latent=o(samp, 1))
    crop = g.add("LTXVCropGuides", "Crop guides", positive=o(g2, 0), negative=o(g2, 1), latent=o(sep, 0))
    dec = g.add("VAEDecodeTiled", "Decode", samples=o(crop, 2), vae=o(vae), tile_size=512, overlap=64, temporal_size=64, temporal_overlap=16)
    audio = g.add("LTXVAudioVAEDecode", "Decode audio", samples=o(sep, 1), audio_vae=o(avae))
    vid = g.add("CreateVideo", "Create video", images=o(dec), fps=o(fps), audio=o(audio))
    g.add("SaveVideo", "DR_OUTPUT", video=o(vid), filename_prefix="darkroom/video/ltx", format="mp4", **{"format.codec": "h264"})
    first = g.add("ImageFromBatch", "Poster frame", image=o(dec), batch_index=0, length=1)
    g.add("SaveImage", "DR_POSTER", images=o(first), filename_prefix="darkroom/video/ltx_poster")
    last = g.add("ImageFromBatch", "Last frame", image=o(dec), batch_index=4095, length=1)
    g.add("SaveImage", "DR_LAST_FRAME", images=o(last), filename_prefix="darkroom/video/ltx_last")
    return g


def video_interp():''')
    s = s.replace('    wan22_i2v().save("wan22_i2v.json")', '    wan22_i2v().save("wan22_i2v.json")\n    ltx25_i2v().save("ltx25_i2v.json")')
    open('build_workflows.py', 'w', encoding='utf-8').write(s)

m = json.load(open('manifest.json', encoding='utf-8'))
m['workflows']['ltx25_i2v'] = {
    "file": "ltx25_i2v.json", "family": "ltx", "kind": "video", "label": "LTX 2.5 image to video",
    "params": {
        "start_image": {"type": "image", "label": "Start frame", "targets": [{"title": "DR_START_IMAGE", "input": "image"}]},
        "end_image": {"type": "image", "label": "End frame", "targets": [{"title": "DR_END_IMAGE", "input": "image"}],
                      "whenMissing": {"bypass": [{"title": "DR_END_GUIDE", "input": "positive", "outputSlot": 0},
                                                 {"title": "DR_END_GUIDE", "input": "negative", "outputSlot": 1},
                                                 {"title": "DR_END_GUIDE", "input": "latent", "outputSlot": 2}],
                                      "remove": ["DR_END_IMAGE"]}},
        "motion_prompt": {"type": "string", "targets": [{"title": "DR_MOTION_PROMPT", "input": "text"}], "default": ""},
        "negative": {"type": "string", "targets": [{"title": "DR_NEGATIVE", "input": "text"}]},
        "seed": {"type": "int", "targets": [{"title": "DR_SEED", "input": "noise_seed"}], "default": 0, "min": 0, "max": 1125899906842624},
        "frames": {"type": "int", "targets": [{"title": "DR_FRAMES", "input": "value"}], "default": 121, "min": 25, "max": 241, "step": 8},
        "fps": {"type": "float", "targets": [{"title": "DR_FPS", "input": "value"}], "default": 24, "min": 8, "max": 50},
        "width": {"type": "int", "targets": [{"title": "DR_WIDTH", "input": "value"}], "default": 864, "min": 256, "max": 1920, "step": 32},
        "height": {"type": "int", "targets": [{"title": "DR_HEIGHT", "input": "value"}], "default": 480, "min": 256, "max": 1920, "step": 32},
        "output": {"type": "string", "targets": [{"title": "DR_OUTPUT", "input": "filename_prefix"}], "default": "darkroom/video/ltx"},
    },
    "outputs": {"video": "DR_OUTPUT", "poster": "DR_POSTER", "last": "DR_LAST_FRAME"},
}
json.dump(m, open('manifest.json', 'w', encoding='utf-8'), indent=2, ensure_ascii=False)
print('ltx added')
