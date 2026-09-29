# Phase 4: SAM 3.1 segmentation, background removal v2, layer decomposition (SAM / Qwen-Image-Layered).
import json

s = open('build_workflows.py', encoding='utf-8').read()
if 'def sam_segment' not in s:
    s = s.replace('INTERP_MODEL = "rife_v4.26.safetensors"', '''INTERP_MODEL = "rife_v4.26.safetensors"
SAM_CKPT = "sam3.1_multiplex_fp16.safetensors"
LAYERED_UNET = "qwen_image_layered_fp8mixed.safetensors"
LAYERED_VAE = "qwen_image_layered_vae.safetensors"
LAYERED_TE = "qwen_2.5_vl_7b_fp8_scaled.safetensors"''')
    s = s.replace('\n\n# -------------------------------------------------------------- utility --', '''


def sam_detect(g, image, individual=False, title="DR_SAM"):
    """SAM 3.1 (core SAM3_Detect): text via the checkpoint's own text encoder, plus optional points/boxes."""
    ck = g.add("CheckpointLoaderSimple", "SAM 3.1", ckpt_name=SAM_CKPT)
    te = g.add("CLIPTextEncode", "DR_TEXT", text="", clip=o(ck, 1))
    det = g.add("SAM3_Detect", title, model=o(ck, 0), image=image, conditioning=o(te), threshold=0.5,
                refine_iterations=2, individual_masks=individual)
    return det


def sam_segment():
    """Mask from text / clicks / box. White = selected. individual=True gives one mask per object."""
    g = G()
    src = g.add("LoadImage", "DR_IMAGE_1", image=PLACEHOLDER_IMAGE)
    det = sam_detect(g, o(src))
    img = g.add("MaskToImage", "Mask to image", mask=o(det, 0))
    g.add("SaveImage", "DR_OUTPUT", images=o(img), filename_prefix="darkroom/masks/sam")
    return g


def remove_bg_v2():
    """Cut-out: BiRefNet/Lucida soft alpha (hair, fur, glass edges) restricted to the SAM subject (optional).
    Always a real RGBA PNG (JoinImageWithAlpha). Also saves a dilated subject mask for a background plate."""
    g = G()
    src = g.add("LoadImage", "DR_IMAGE_1", image=PLACEHOLDER_IMAGE)
    model = g.add("LoadBackgroundRemovalModel", "DR_MATTE", bg_removal_name=BIREFNET)
    fg = g.add("RemoveBackground", "Soft alpha", bg_removal_model=o(model), image=o(src))
    det = sam_detect(g, o(src))
    sam_grown = g.add("GrowMask", "DR_SAM_GROW", mask=o(det, 0), expand=24, tapered_corners=True)
    sam_soft = soft_mask(g, o(sam_grown), radius=15)
    both = g.add("MaskComposite", "DR_SAM_COMBINE", destination=o(fg), source=o(sam_soft), x=0, y=0, operation="multiply")
    edge = g.add("GrowMask", "DR_EDGE", mask=o(both), expand=0, tapered_corners=True)
    inv = g.add("InvertMask", "Invert", mask=o(edge))
    rgba = g.add("JoinImageWithAlpha", "Join alpha", image=o(src), alpha=o(inv))
    g.add("SaveImage", "DR_OUTPUT", images=o(rgba), filename_prefix="darkroom/cutout")
    plate_mask = g.add("GrowMask", "Plate mask grow", mask=o(both), expand=16, tapered_corners=True)
    pm_img = g.add("MaskToImage", "Plate mask image", mask=o(plate_mask))
    g.add("SaveImage", "DR_MASK_OUT", images=o(pm_img), filename_prefix="darkroom/masks/subject")
    return g


def sam_layers():
    """Layers mode A: one RGBA layer per detected object (text prompt, e.g. 'person, car:2'),
    plus the union mask (dilated) for a Qwen background plate."""
    g = G()
    src = g.add("LoadImage", "DR_IMAGE_1", image=PLACEHOLDER_IMAGE)
    det = sam_detect(g, o(src), individual=True)
    inv = g.add("InvertMask", "Invert", mask=o(det, 0))
    layers = g.add("JoinImageWithAlpha", "Object layers", image=o(src), alpha=o(inv))
    g.add("SaveImage", "DR_OUTPUT", images=o(layers), filename_prefix="darkroom/layers/object")
    union = g.add("SAM3_Detect", "SAM union", model=o("2", 0), image=o(src), conditioning=o("3"), threshold=0.5,
                  refine_iterations=2, individual_masks=False)
    grown = g.add("GrowMask", "Union grow", mask=o(union, 0), expand=16, tapered_corners=True)
    um = g.add("MaskToImage", "Union image", mask=o(grown))
    g.add("SaveImage", "DR_MASK_OUT", images=o(um), filename_prefix="darkroom/masks/union")
    return g


def qwen_layered():
    """Layers mode B: Qwen-Image-Layered native RGBA decomposition (official template: 640 px, 20 steps, CFG 2.5)."""
    g = G()
    unet = g.add("UNETLoader", "DR_MODEL", unet_name=LAYERED_UNET, weight_dtype="default")
    shift = g.add("ModelSamplingAuraFlow", "Shift", model=o(unet), shift=1.0)
    clip = g.add("CLIPLoader", "DR_TEXT_ENCODER", clip_name=LAYERED_TE, type="qwen_image", device="default")
    vae = g.add("VAELoader", "DR_VAE", vae_name=LAYERED_VAE)
    src = g.add("LoadImage", "DR_IMAGE_1", image=PLACEHOLDER_IMAGE)
    sized = g.add("ImageScaleToMaxDimension", "DR_SIZE", image=o(src), upscale_method="lanczos", largest_size=640)
    dims = g.add("GetImageSize", "Dims", image=o(sized))
    enc = g.add("VAEEncode", "Encode", pixels=o(sized), vae=o(vae))
    pos = g.add("CLIPTextEncode", "DR_PROMPT", text="", clip=o(clip))
    neg = g.add("CLIPTextEncode", "Negative", text="", clip=o(clip))
    posr = g.add("ReferenceLatent", "Ref +", conditioning=o(pos), latent=o(enc))
    negr = g.add("ReferenceLatent", "Ref -", conditioning=o(neg), latent=o(enc))
    lat = g.add("EmptyQwenImageLayeredLatentImage", "DR_LAYERS", width=o(dims, 0), height=o(dims, 1), layers=4, batch_size=1)
    ks = g.add("KSampler", "DR_SAMPLER", model=o(shift), positive=o(posr), negative=o(negr), latent_image=o(lat),
               seed=0, steps=20, cfg=2.5, sampler_name="euler", scheduler="simple", denoise=1.0)
    cut = g.add("LatentCut", "Drop composite", samples=o(ks), dim="t", index=1, amount=16384)
    batch = g.add("LatentCutToBatch", "Layers to batch", samples=o(cut), dim="t", slice_size=1)
    dec = g.add("VAEDecode", "Decode", samples=o(batch), vae=o(vae))
    g.add("SaveImage", "DR_OUTPUT", images=o(dec), filename_prefix="darkroom/layers/qwen")
    return g


# -------------------------------------------------------------- utility --''', 1)
    s = s.replace('    remove_bg().save("remove_bg.json")', '''    remove_bg().save("remove_bg.json")
    remove_bg_v2().save("remove_bg.v2.json")
    sam_segment().save("sam_segment.json")
    sam_layers().save("sam_layers.json")
    qwen_layered().save("qwen_layered.json")''')
    open('build_workflows.py', 'w', encoding='utf-8').write(s)

m = json.load(open('manifest.json', encoding='utf-8'))
W = m['workflows']
out = lambda d: {"type": "string", "targets": [{"title": "DR_OUTPUT", "input": "filename_prefix"}], "default": d}
img1 = {"type": "image", "label": "Image", "targets": [{"title": "DR_IMAGE_1", "input": "image"}]}
text_opt = {"type": "string", "label": "Subject", "targets": [{"title": "DR_TEXT", "input": "text"}],
            "whenMissing": {"remove": ["DR_TEXT"]}}
sam_extra = {
    "points": {"type": "string", "targets": [{"title": "DR_SAM", "input": "positive_coords"}]},
    "neg_points": {"type": "string", "targets": [{"title": "DR_SAM", "input": "negative_coords"}]},
    "boxes": {"type": "json", "targets": [{"title": "DR_SAM", "input": "bboxes"}]},
    "threshold": {"type": "float", "targets": [{"title": "DR_SAM", "input": "threshold"}], "default": 0.5, "min": 0.05, "max": 0.95},
}
W['sam_segment'] = {"file": "sam_segment.json", "family": "sam", "kind": "mask", "label": "Segment (SAM 3.1)",
                    "params": {"image_1": img1, "text": text_opt, **sam_extra,
                               "individual": {"type": "bool", "targets": [{"title": "DR_SAM", "input": "individual_masks"}], "default": False},
                               "output": out("darkroom/masks/sam")},
                    "outputs": {"mask": "DR_OUTPUT"}}
rb = W['remove_bg']
W['remove_bg'] = {"file": "remove_bg.v2.json", "family": "sam", "kind": "image", "label": "Remove background (SAM 3.1 + BiRefNet)",
                  "params": {"image_1": img1,
                             "subject": {"type": "string", "label": "Subject", "targets": [{"title": "DR_TEXT", "input": "text"}],
                                         "whenMissing": {"bypass": [{"title": "DR_SAM_COMBINE", "input": "destination"}], "remove": ["DR_TEXT"]}},
                             "matte": {"type": "string", "targets": [{"title": "DR_MATTE", "input": "bg_removal_name"}], "default": "birefnet.safetensors"},
                             "edge": {"type": "int", "targets": [{"title": "DR_EDGE", "input": "expand"}], "default": 0, "min": -8, "max": 8},
                             "threshold": {"type": "float", "targets": [{"title": "DR_SAM", "input": "threshold"}], "default": 0.5, "min": 0.05, "max": 0.95},
                             "output": out("darkroom/cutout")},
                  "outputs": {"image": "DR_OUTPUT", "mask": "DR_MASK_OUT"}}
W['remove_bg_v1'] = {**rb, "label": "Remove background (BiRefNet only, v1)"}
W['sam_layers'] = {"file": "sam_layers.json", "family": "sam", "kind": "image", "label": "Layers from objects (SAM 3.1)",
                   "params": {"image_1": img1, "text": {"type": "string", "label": "Objects", "targets": [{"title": "DR_TEXT", "input": "text"}]},
                              "threshold": {"type": "float", "targets": [{"title": "DR_SAM", "input": "threshold"}, {"title": "SAM union", "input": "threshold"}], "default": 0.5, "min": 0.05, "max": 0.95},
                              "output": out("darkroom/layers/object")},
                   "outputs": {"image": "DR_OUTPUT", "mask": "DR_MASK_OUT"}}
W['qwen_layered'] = {"file": "qwen_layered.json", "family": "layered", "kind": "image", "label": "Layers (Qwen-Image-Layered)",
                     "params": {"image_1": img1,
                                "prompt": {"type": "string", "targets": [{"title": "DR_PROMPT", "input": "text"}], "default": ""},
                                "layers": {"type": "int", "targets": [{"title": "DR_LAYERS", "input": "layers"}], "default": 4, "min": 2, "max": 8},
                                "size": {"type": "int", "targets": [{"title": "DR_SIZE", "input": "largest_size"}], "default": 640, "min": 512, "max": 1024, "step": 32},
                                "seed": {"type": "int", "targets": [{"title": "DR_SAMPLER", "input": "seed"}], "default": 0, "min": 0, "max": 1125899906842624},
                                "steps": {"type": "int", "targets": [{"title": "DR_SAMPLER", "input": "steps"}], "default": 20, "min": 10, "max": 50},
                                "output": out("darkroom/layers/qwen")},
                     "outputs": {"image": "DR_OUTPUT"}}
m['vramNeedGB']['layered'] = 20
json.dump(m, open('manifest.json', 'w', encoding='utf-8'), indent=2, ensure_ascii=False)
print('phase4 workflows added')
