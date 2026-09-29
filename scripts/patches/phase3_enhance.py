# Phase 3: Enhance Image graphs (Klein low-denoise img2img, Qwen 2.1 edit with denoise < 1) + manifest.
import json

s = open('build_workflows.py', encoding='utf-8').read()
if 'def klein_enhance' not in s:
    s = s.replace('\n\n# ----------------------------------------------------------------- Qwen --', '''


def klein_enhance():
    """Klein 9B enhance: the source is both the reference (ReferenceLatent) and the starting latent;
    only the last part of the schedule is sampled (SplitSigmasDenoise). DR_SCHEDULE.steps is set to
    ~4/denoise by the app so about 4 real steps run at any strength."""
    g = G()
    unet, clip, vae, pos, neg = klein_base(g)
    src = g.add("LoadImage", "DR_IMAGE_1", image=PLACEHOLDER_IMAGE)
    work = g.add("ImageScaleToTotalPixels", "DR_WORK", image=o(src), upscale_method="lanczos",
                 megapixels=1.0, resolution_steps=16)
    size = g.add("GetImageSize", "Work dims", image=o(work))
    lat = g.add("VAEEncode", "Encode picture", pixels=o(work), vae=o(vae))
    pos = g.add("ReferenceLatent", "Ref pos", conditioning=o(pos), latent=o(lat))
    neg = g.add("ReferenceLatent", "Ref neg", conditioning=o(neg), latent=o(lat))
    sched = g.add("Flux2Scheduler", "DR_SCHEDULE", steps=12, width=o(size, 0), height=o(size, 1))
    split = g.add("SplitSigmasDenoise", "DR_DENOISE", sigmas=o(sched), denoise=0.33)
    sampler = g.add("KSamplerSelect", "Sampler", sampler_name="euler")
    noise = g.add("RandomNoise", "DR_SEED", noise_seed=0)
    guider = g.add("CFGGuider", "Guider", model=o(unet), positive=o(pos), negative=o(neg), cfg=1.0)
    samp = g.add("SamplerCustomAdvanced", "Sample", noise=o(noise), guider=o(guider), sampler=o(sampler),
                 sigmas=o(split, 1), latent_image=o(lat))
    img = g.add("VAEDecodeTiled", "Decode", samples=o(samp), vae=o(vae), tile_size=1024, overlap=128,
                temporal_size=64, temporal_overlap=8)
    g.add("SaveImage", "DR_OUTPUT", images=o(img), filename_prefix="darkroom/enhance")
    return g


# ----------------------------------------------------------------- Qwen --''', 1)
    s = s.replace('\n\n# -------------------------------------------------------------- utility --', '''


def qwen_enhance():
    """Qwen-Image 2.1 enhance: 2.1 edit conditioning on the source, sampling from the encoded source
    with denoise < 1 (KSampler), so composition is kept and detail is re-rendered."""
    g = G()
    unet = g.add("UNETLoader", "DR_MODEL", unet_name=QWEN21_UNET, weight_dtype="default")
    cache = g.add("QwenImage21Cache", "Prefix cache", model=o(unet), device="auto", dtype="default")
    clip = g.add("CLIPLoader", "DR_TEXT_ENCODER", clip_name=QWEN21_TE, type="qwen_image", device="default")
    vae = g.add("VAELoader", "DR_VAE", vae_name=QWEN21_VAE)
    src = g.add("LoadImage", "DR_IMAGE_1", image=PLACEHOLDER_IMAGE)
    work = g.add("ImageScaleToTotalPixels", "DR_WORK", image=o(src), upscale_method="lanczos",
                 megapixels=1.0, resolution_steps=32)
    enc = g.add("TextEncodeQwenImage21", "DR_PROMPT", clip=o(clip), vae=o(vae), prompt="", negative_prompt="",
                resolution=0, **{"images.image_1": o(work)})
    lat = g.add("VAEEncode", "Encode picture", pixels=o(work), vae=o(vae))
    ks = g.add("KSampler", "DR_SAMPLER", model=o(cache), positive=o(enc, 0), negative=o(enc, 1),
               latent_image=o(lat), seed=0, steps=25, cfg=1.0, sampler_name="euler",
               scheduler="simple", denoise=0.35)
    img = g.add("VAEDecodeTiled", "Decode", samples=o(ks), vae=o(vae), tile_size=1024, overlap=128,
                temporal_size=64, temporal_overlap=8)
    g.add("SaveImage", "DR_OUTPUT", images=o(img), filename_prefix="darkroom/enhance")
    return g


# -------------------------------------------------------------- utility --''', 1)
    s = s.replace('    klein_masked(False, prefix="darkroom/edit").save("klein_edit.json")',
                  '    klein_masked(False, prefix="darkroom/edit").save("klein_edit.json")\n    klein_enhance().save("klein_enhance.json")\n    qwen_enhance().save("qwen_enhance.json")')
    open('build_workflows.py', 'w', encoding='utf-8').write(s)

m = json.load(open('manifest.json', encoding='utf-8'))
seed = {"type": "int", "targets": [], "default": 0, "min": 0, "max": 1125899906842624}
m['workflows']['klein_enhance'] = {
    "file": "klein_enhance.json", "family": "klein", "kind": "image", "label": "Enhance (Klein 9B)",
    "params": {
        "prompt": {"type": "string", "targets": [{"title": "DR_PROMPT", "input": "text"}], "default": ""},
        "image_1": {"type": "image", "label": "Image", "targets": [{"title": "DR_IMAGE_1", "input": "image"}]},
        "seed": {**seed, "targets": [{"title": "DR_SEED", "input": "noise_seed"}]},
        "denoise": {"type": "float", "targets": [{"title": "DR_DENOISE", "input": "denoise"}], "default": 0.3, "min": 0.1, "max": 0.9},
        "schedule_steps": {"type": "int", "targets": [{"title": "DR_SCHEDULE", "input": "steps"}], "default": 12, "min": 4, "max": 40},
        "megapixels": {"type": "float", "targets": [{"title": "DR_WORK", "input": "megapixels"}], "default": 1.0, "min": 0.5, "max": 2.0},
        "output": {"type": "string", "targets": [{"title": "DR_OUTPUT", "input": "filename_prefix"}], "default": "darkroom/enhance"},
    },
    "outputs": {"image": "DR_OUTPUT"},
}
m['workflows']['qwen_enhance'] = {
    "file": "qwen_enhance.json", "family": "qwen", "kind": "image", "label": "Enhance (Qwen-Image 2.1)",
    "params": {
        "prompt": {"type": "string", "targets": [{"title": "DR_PROMPT", "input": "prompt"}], "default": ""},
        "image_1": {"type": "image", "label": "Image", "targets": [{"title": "DR_IMAGE_1", "input": "image"}]},
        "seed": {**seed, "targets": [{"title": "DR_SAMPLER", "input": "seed"}]},
        "denoise": {"type": "float", "targets": [{"title": "DR_SAMPLER", "input": "denoise"}], "default": 0.35, "min": 0.1, "max": 0.9},
        "steps": {"type": "int", "targets": [{"title": "DR_SAMPLER", "input": "steps"}], "default": 25, "min": 8, "max": 50},
        "megapixels": {"type": "float", "targets": [{"title": "DR_WORK", "input": "megapixels"}], "default": 1.0, "min": 0.5, "max": 2.0},
        "output": {"type": "string", "targets": [{"title": "DR_OUTPUT", "input": "filename_prefix"}], "default": "darkroom/enhance"},
    },
    "outputs": {"image": "DR_OUTPUT"},
}
m['edit']['enhance'] = {"klein": "klein_enhance", "qwen": "qwen_enhance"}
# starting defaults; tuned in the denoise sweep and recorded in DECISIONS.md
m['enhance'] = {"klein": {"subtle": 0.3, "strong": 0.6}, "qwen": {"subtle": 0.35, "strong": 0.65}}
json.dump(m, open('manifest.json', 'w', encoding='utf-8'), indent=2, ensure_ascii=False)
print('enhance workflows added')
