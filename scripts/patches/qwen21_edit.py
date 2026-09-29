# one-off: Instruct edit -> Qwen-Image 2.1 native edit, full-resolution masked composite.
# The old Qwen-Image-Edit-2511 graph is kept as qwen_edit_2511.json.
import json

s = open('build_workflows.py', encoding='utf-8').read()
if 'def qwen21_edit' not in s:
    s = s.replace('def qwen_edit():', 'def qwen_edit_2511():', 1)
    s = s.replace('\n\n# -------------------------------------------------------------- utility --', '''


def qwen21_edit():
    """Qwen-Image 2.1 native edit (official template: TextEncodeQwenImage21 + QwenImage21Cache, 25 steps, CFG 1).
    image_1 = picture to edit, image_2 = optional reference, optional mask.
    The result is scaled back to the source size and, with a mask, composited onto the
    ORIGINAL pixels at full resolution, so nothing outside the mask changes."""
    g = G()
    unet = g.add("UNETLoader", "DR_MODEL", unet_name=QWEN21_UNET, weight_dtype="default")
    cache = g.add("QwenImage21Cache", "Prefix cache", model=o(unet), device="auto", dtype="default")
    clip = g.add("CLIPLoader", "DR_TEXT_ENCODER", clip_name=QWEN21_TE, type="qwen_image", device="default")
    vae = g.add("VAELoader", "DR_VAE", vae_name=QWEN21_VAE)
    src = g.add("LoadImage", "DR_IMAGE_1", image=PLACEHOLDER_IMAGE)
    ref = g.add("LoadImage", "DR_IMAGE_2", image=PLACEHOLDER_IMAGE)
    enc = g.add("TextEncodeQwenImage21", "DR_PROMPT", clip=o(clip), vae=o(vae), prompt="", negative_prompt="",
                resolution=1024, **{"images.image_1": o(src), "images.image_2": o(ref)})
    # optional mask: full-resolution, white = change (the sampler resizes the noise mask to the latent)
    m = g.add("LoadImageMask", "DR_MASK", image=PLACEHOLDER_IMAGE, channel="red")
    grown = g.add("GrowMask", "DR_MASK_GROW", mask=o(m), expand=8, tapered_corners=True)
    nm = g.add("SetLatentNoiseMask", "DR_MASK_LATENT", samples=o(enc, 2), mask=o(grown))
    ks = g.add("KSampler", "DR_SAMPLER", model=o(cache), positive=o(enc, 0), negative=o(enc, 1),
               latent_image=o(nm), seed=0, steps=25, cfg=1.0, sampler_name="euler",
               scheduler="simple", denoise=1.0)
    dec = g.add("VAEDecodeTiled", "Decode", samples=o(ks), vae=o(vae), tile_size=1024, overlap=128,
                temporal_size=64, temporal_overlap=8)
    full = g.add("GetImageSize", "Source dims", image=o(src))
    up = g.add("ImageScale", "Back to source size", image=o(dec), upscale_method="lanczos",
               width=o(full, 0), height=o(full, 1), crop="disabled")
    feat = g.add("FeatherMask", "DR_FEATHER", mask=o(grown), left=6, top=6, right=6, bottom=6)
    comp = g.add("ImageCompositeMasked", "DR_MASK_COMPOSITE", destination=o(src), source=o(up), x=0, y=0,
                 resize_source=False, mask=o(feat))
    g.add("SaveImage", "DR_OUTPUT", images=o(comp), filename_prefix="darkroom/edit")
    return g


# -------------------------------------------------------------- utility --''', 1)
    s = s.replace('    qwen_edit().save("qwen_edit.json")',
                  '    qwen21_edit().save("qwen_edit.json")\n    qwen_edit_2511().save("qwen_edit_2511.json")')
    open('build_workflows.py', 'w', encoding='utf-8').write(s)

m = json.load(open('manifest.json', encoding='utf-8'))
old = m['workflows']['qwen_edit']
m['workflows']['qwen_edit_2511'] = {**old, 'file': 'qwen_edit_2511.json',
                                    'label': 'Qwen-Image-Edit-2511 instruction edit (alternate, not used by the UI)'}
new = json.loads(json.dumps(old))
new['family'] = 'qwen'
new['label'] = 'Qwen-Image 2.1 instruction edit'
new['params']['steps'] = {"type": "int", "targets": [{"title": "DR_SAMPLER", "input": "steps"}], "default": 25, "min": 8, "max": 50}
new['params']['cfg'] = {"type": "float", "targets": [{"title": "DR_SAMPLER", "input": "cfg"}], "default": 1.0, "min": 1.0, "max": 6.0}
new['params']['image_2']['whenMissing'] = {"remove": ["DR_IMAGE_2"]}
new['params']['mask']['whenMissing'] = {
    "bypass": [{"title": "DR_MASK_LATENT", "input": "samples"}, {"title": "DR_MASK_COMPOSITE", "input": "source"}],
    "remove": ["DR_MASK"]}
new['params']['feather'] = {"type": "int", "targets": [{"title": "DR_FEATHER", "input": k} for k in ("left", "top", "right", "bottom")],
                            "default": 6, "min": 0, "max": 64}
m['workflows']['qwen_edit'] = new
json.dump(m, open('manifest.json', 'w', encoding='utf-8'), indent=2, ensure_ascii=False)
print('qwen 2.1 edit wired')
