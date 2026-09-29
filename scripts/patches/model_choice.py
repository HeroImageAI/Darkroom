# one-off: every image edit mode gets a Klein 9B and a Qwen-Image 2.1 workflow; Qwen gets its own reference workflow.
import json

s = open('build_workflows.py', encoding='utf-8').read()

# --- Klein masked graph: stable titles for the optional-mask plan, configurable output prefix
s = s.replace('def klein_masked(outpaint=False):', 'def klein_masked(outpaint=False, prefix=None):')
s = s.replace('nm = g.add("SetLatentNoiseMask", "Noise mask", samples=o(lat), mask=o(wmask))',
              'nm = g.add("SetLatentNoiseMask", "DR_MASK_LATENT", samples=o(lat), mask=o(wmask))')
s = s.replace('comp = g.add("ImageCompositeMasked", "Composite", destination=base_img, source=o(up), x=0, y=0,',
              'comp = g.add("ImageCompositeMasked", "DR_MASK_COMPOSITE", destination=base_img, source=o(up), x=0, y=0,')
s = s.replace('''          filename_prefix="darkroom/outpaint" if outpaint else "darkroom/inpaint")''',
              '''          filename_prefix=prefix or ("darkroom/outpaint" if outpaint else "darkroom/inpaint"))''')

# --- Qwen edit graph: add an outpaint variant
s = s.replace('def qwen21_edit():', 'def qwen21_edit(outpaint=False, prefix="darkroom/edit"):')
s = s.replace('''    src = g.add("LoadImage", "DR_IMAGE_1", image=PLACEHOLDER_IMAGE)
    ref = g.add("LoadImage", "DR_IMAGE_2", image=PLACEHOLDER_IMAGE)
    # Work at ~1 MP (multiple of 32).''', '''    src0 = g.add("LoadImage", "DR_IMAGE_1", image=PLACEHOLDER_IMAGE)
    if outpaint:
        pad = g.add("ImagePadForOutpaint", "DR_PAD", image=o(src0), left=0, top=0, right=0, bottom=0, feathering=24)
        src, pad_mask = pad, o(pad, 1)
    else:
        src, pad_mask = src0, None
    ref = g.add("LoadImage", "DR_IMAGE_2", image=PLACEHOLDER_IMAGE)
    # Work at ~1 MP (multiple of 32).''')
s = s.replace('''    m = g.add("LoadImageMask", "DR_MASK", image=PLACEHOLDER_IMAGE, channel="red")
    grown = g.add("GrowMask", "DR_MASK_GROW", mask=o(m), expand=8, tapered_corners=True)
    nm = g.add("SetLatentNoiseMask", "DR_MASK_LATENT", samples=o(lat), mask=o(grown))
    ks = g.add("KSampler", "DR_SAMPLER", model=o(cache),''', '''    if outpaint:
        mask_in = pad_mask
    else:
        mask_in = o(g.add("LoadImageMask", "DR_MASK", image=PLACEHOLDER_IMAGE, channel="red"))
    grown = g.add("GrowMask", "DR_MASK_GROW", mask=mask_in, expand=8, tapered_corners=True)
    nm = g.add("SetLatentNoiseMask", "DR_MASK_LATENT", samples=o(lat), mask=o(grown))
    ks = g.add("KSampler", "DR_SAMPLER", model=o(cache),''')
s = s.replace('''    g.add("SaveImage", "DR_OUTPUT", images=o(comp), filename_prefix="darkroom/edit")
    return g''', '''    g.add("SaveImage", "DR_OUTPUT", images=o(comp), filename_prefix=prefix)
    return g''')

# --- Qwen-Image 2.1 generation with 1-3 reference images
if 'def qwen_ref' not in s:
    s = s.replace('\n\n# -------------------------------------------------------------- utility --', '''


def qwen_ref():
    """Qwen-Image 2.1 text-to-image guided by up to 3 reference images (<image1>..<image3> in the prompt)."""
    g = G()
    unet = g.add("UNETLoader", "DR_MODEL", unet_name=QWEN21_UNET, weight_dtype="default")
    cache = g.add("QwenImage21Cache", "Prefix cache", model=o(unet), device="auto", dtype="default")
    clip = g.add("CLIPLoader", "DR_TEXT_ENCODER", clip_name=QWEN21_TE, type="qwen_image", device="default")
    vae = g.add("VAELoader", "DR_VAE", vae_name=QWEN21_VAE)
    imgs = {f"images.image_{i}": o(g.add("LoadImage", f"DR_IMAGE_{i}", image=PLACEHOLDER_IMAGE)) for i in (1, 2, 3)}
    enc = g.add("TextEncodeQwenImage21", "DR_PROMPT", clip=o(clip), vae=o(vae), prompt="", negative_prompt="",
                resolution=1024, **imgs)
    w = g.add("PrimitiveInt", "DR_WIDTH", value=1328)
    h = g.add("PrimitiveInt", "DR_HEIGHT", value=1328)
    lat = g.add("EmptyLatentImage", "DR_BATCH", width=o(w), height=o(h), batch_size=1)
    ks = g.add("KSampler", "DR_SAMPLER", model=o(cache), positive=o(enc, 0), negative=o(enc, 1),
               latent_image=o(lat), seed=0, steps=25, cfg=1.0, sampler_name="euler",
               scheduler="simple", denoise=1.0)
    img = g.add("VAEDecodeTiled", "Decode", samples=o(ks), vae=o(vae), tile_size=1024, overlap=128,
                temporal_size=64, temporal_overlap=8)
    g.add("SaveImage", "DR_OUTPUT", images=o(img), filename_prefix="darkroom/qwen_ref")
    return g


# -------------------------------------------------------------- utility --''', 1)

s = s.replace('''    qwen21_edit().save("qwen_edit.json")''', '''    qwen21_edit().save("qwen_edit.json")
    qwen21_edit(prefix="darkroom/inpaint").save("qwen_inpaint.json")
    qwen21_edit(outpaint=True, prefix="darkroom/outpaint").save("qwen_outpaint.json")
    qwen_ref().save("qwen_ref.json")''')
s = s.replace('''    klein_masked(False).save("inpaint.json")''', '''    klein_masked(False).save("inpaint.json")
    klein_masked(False, prefix="darkroom/edit").save("klein_edit.json")''')
open('build_workflows.py', 'w', encoding='utf-8').write(s)

# ---------------------------------------------------------------- manifest
m = json.load(open('manifest.json', encoding='utf-8'))
W = m['workflows']
clone = lambda x: json.loads(json.dumps(x))
mask_optional = {"bypass": [{"title": "DR_MASK_LATENT", "input": "samples"}, {"title": "DR_MASK_COMPOSITE", "input": "source"}],
                 "remove": ["DR_MASK"]}

# Klein instruct = Klein masked graph with an optional mask
ke = clone(W['inpaint'])
ke.update(file='klein_edit.json', label='Klein 9B instruction edit')
ke['params']['mask']['whenMissing'] = mask_optional
ke['params']['output']['default'] = 'darkroom/edit'
W['klein_edit'] = ke

# Qwen inpaint = Qwen edit graph with a required mask
qi = clone(W['qwen_edit'])
qi.update(file='qwen_inpaint.json', label='Qwen-Image 2.1 masked fill')
qi['params']['mask'].pop('whenMissing', None)
qi['params']['output']['default'] = 'darkroom/inpaint'
W['qwen_inpaint'] = qi

# Qwen outpaint
qo = clone(W['qwen_edit'])
qo.update(file='qwen_outpaint.json', label='Qwen-Image 2.1 outpaint')
del qo['params']['mask']
for side in ('left', 'top', 'right', 'bottom'):
    qo['params'][f'pad_{side}'] = {"type": "int", "targets": [{"title": "DR_PAD", "input": side}], "default": 0, "min": 0, "max": 2048, "step": 8}
qo['params']['grow']['default'] = 32
qo['params']['feather']['default'] = 24
qo['params']['output']['default'] = 'darkroom/outpaint'
W['qwen_outpaint'] = qo

# Qwen generation with references
qr = clone(W['qwen_t2i'])
qr.update(file='qwen_ref.json', label='Qwen-Image 2.1 with reference images')
qr['params'].pop('negative', None)
qr['params']['image_1'] = {"type": "image", "label": "Reference 1", "targets": [{"title": "DR_IMAGE_1", "input": "image"}]}
for i in (2, 3):
    qr['params'][f'image_{i}'] = {"type": "image", "label": f"Reference {i}", "targets": [{"title": f"DR_IMAGE_{i}", "input": "image"}],
                                  "whenMissing": {"remove": [f"DR_IMAGE_{i}"]}}
qr['params']['output']['default'] = 'darkroom/qwen_ref'
W['qwen_ref'] = qr

# Klein inpaint/outpaint masked plans still valid (mask required there)
m['models']['qwen']['ref'] = 'qwen_ref'
m['models']['qwen'].pop('refNote', None)
# Which workflow each Edit mode uses per model
m['edit'] = {
    "instruct": {"klein": "klein_edit", "qwen": "qwen_edit"},
    "inpaint": {"klein": "inpaint", "qwen": "qwen_inpaint"},
    "outpaint": {"klein": "outpaint", "qwen": "qwen_outpaint"},
}
json.dump(m, open('manifest.json', 'w', encoding='utf-8'), indent=2, ensure_ascii=False)
print('model choice wired')
