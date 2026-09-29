"""Generate Darkroom's ComfyUI API-format workflows.

Every node the app changes carries a `_meta.title` starting with DR_. The app
only ever addresses nodes by title (see manifest.json), never by id, so these
files can be re-exported from ComfyUI (Workflow > Export (API)) as long as the
titles survive.

Run:  python build_workflows.py      (writes *.json next to this file)
"""
import json
import os

HERE = os.path.dirname(os.path.abspath(__file__))

# ---- model files (single place to change) --------------------------------
KLEIN_UNET = "flux-2-klein-9b-fp8mixed.safetensors"
KLEIN_TE = "qwen_3_8b_fp8mixed.safetensors"
KLEIN_VAE = "flux2-vae.safetensors"
QWEN21_UNET = "qwen_image_2.1_int8_convrot.safetensors"
QWEN21_TE = "qwen3vl_8b_int8_convrot.safetensors"
QWEN21_VAE = "qwen_image_2.1_vae_bf16.safetensors"
QEDIT_UNET = "Qwen-Image-Edit-2511-FP8_e4m3fn.safetensors"
QEDIT_LORA = "Qwen-Image-Edit-2511-Lightning-4steps-V1.0-bf16.safetensors"
QEDIT_TE = "qwen_2.5_vl_7b_fp8_scaled.safetensors"
QEDIT_VAE = "qwen_image_vae.safetensors"
BIREFNET = "birefnet.safetensors"
SEEDVR2_UNET = "seedvr2_7b_sharp_int8_convrot.safetensors"
SEEDVR2_VAE = "ema_vae_fp16.safetensors"
WAN_HIGH = "wan2.2_i2v_high_noise_14B_fp8_scaled.safetensors"
WAN_LOW = "wan2.2_i2v_low_noise_14B_fp8_scaled.safetensors"
WAN_LORA_HIGH = "wan2.2_i2v_lightx2v_4steps_lora_v1_high_noise.safetensors"
WAN_LORA_LOW = "wan2.2_i2v_lightx2v_4steps_lora_v1_low_noise.safetensors"
WAN_TE = "umt5_xxl_fp8_e4m3fn_scaled.safetensors"
WAN_VAE = "wan_2.1_vae.safetensors"
INTERP_MODEL = "rife_v4.26.safetensors"
VLM_TE = "qwen3vl_8b_int8_convrot.safetensors"  # same file as QWEN21_TE; has lm_head + vision tower
LTX_UNET = "ltx-2.5-22b-distilled-transformer-comfy-int8-convrot.safetensors"
LTX_TE = "gemma4-12b-with-proj-ltx-2.5-comfy-int8-convrot.safetensors"
LTX_VAE = "ltx-2.5-video-vae-bf16.safetensors"
LTX_AUDIO_VAE = "ltx-2.5-audio-vae-bf16.safetensors"
LTX_NEGATIVE = ("blurry, out of focus, overexposed, underexposed, low contrast, washed out colors, excessive noise, "
                "flickering, distorted proportions, deformed face, extra limbs, disfigured hands, jittery movement, "
                "unnatural transitions, cartoonish rendering, 3D CGI look, AI artifacts, subtitles, text overlay")
PLACEHOLDER_IMAGE = "darkroom_placeholder.png"
PLACEHOLDER_VIDEO = "darkroom_placeholder.mp4"

WAN_NEGATIVE = (
    "色调艳丽，过曝，静态，细节模糊不清，字幕，风格，作品，画作，画面，静止，整体发灰，最差质量，低质量，"
    "JPEG压缩残留，丑陋的，残缺的，多余的手指，画得不好的手部，画得不好的脸部，畸形的，毁容的，形态畸形的肢体，"
    "手指融合，静止不动的画面，杂乱的背景，三条腿，背景人很多，倒着走"
)


class G:
    """Tiny API-prompt builder."""

    def __init__(self):
        self.p = {}
        self.n = 0

    def add(self, cls, title=None, **inputs):
        self.n += 1
        nid = str(self.n)
        self.p[nid] = {
            "class_type": cls,
            "inputs": inputs,
            "_meta": {"title": title or cls},
        }
        return nid

    def save(self, name):
        with open(os.path.join(HERE, name), "w", encoding="utf-8") as f:
            json.dump(self.p, f, indent=2, ensure_ascii=False)
        print("wrote", name, len(self.p), "nodes")


def o(nid, slot=0):
    return [nid, slot]



def soft_mask(g, mask, radius=6):
    """Blur the mask's own edge. (The FeatherMask node would instead fade it toward the canvas border.)"""
    as_img = g.add("MaskToImage", "Mask to image (feather)", mask=mask)
    blur = g.add("ImageBlur", "DR_FEATHER", image=o(as_img), blur_radius=radius, sigma=4.0)
    return g.add("ImageToMask", "Feathered mask", image=o(blur), channel="red")


# ---------------------------------------------------------------- Klein --
def klein_base(g):
    unet = g.add("UNETLoader", "DR_MODEL", unet_name=KLEIN_UNET, weight_dtype="default")
    clip = g.add("CLIPLoader", "DR_TEXT_ENCODER", clip_name=KLEIN_TE, type="flux2", device="default")
    vae = g.add("VAELoader", "DR_VAE", vae_name=KLEIN_VAE)
    pos = g.add("CLIPTextEncode", "DR_PROMPT", text="", clip=o(clip))
    neg = g.add("ConditioningZeroOut", "Negative (zero)", conditioning=o(pos))
    return unet, clip, vae, pos, neg


def klein_sample(g, unet, vae, pos, neg, latent, wlink, hlink):
    sched = g.add("Flux2Scheduler", "DR_STEPS", steps=4, width=wlink, height=hlink)
    sampler = g.add("KSamplerSelect", "Sampler", sampler_name="euler")
    noise = g.add("RandomNoise", "DR_SEED", noise_seed=0)
    guider = g.add("CFGGuider", "DR_CFG", model=o(unet), positive=o(pos), negative=o(neg), cfg=1.0)
    samp = g.add("SamplerCustomAdvanced", "Sample", noise=o(noise), guider=o(guider),
                 sampler=o(sampler), sigmas=o(sched), latent_image=o(latent))
    return g.add("VAEDecodeTiled", "Decode", samples=o(samp), vae=o(vae), tile_size=1024, overlap=128,
                 temporal_size=64, temporal_overlap=8)


def klein_refs(g, vae, pos, neg, n):
    """Chain up to n reference images into positive and negative conditioning."""
    for i in range(1, n + 1):
        img = g.add("LoadImage", f"DR_IMAGE_{i}", image=PLACEHOLDER_IMAGE)
        sc = g.add("ImageScaleToTotalPixels", f"Ref {i} scale", image=o(img),
                   upscale_method="lanczos", megapixels=1.0, resolution_steps=16)
        enc = g.add("VAEEncode", f"Ref {i} encode", pixels=o(sc), vae=o(vae))
        pos = g.add("ReferenceLatent", f"DR_REF_{i}_POS", conditioning=o(pos), latent=o(enc))
        neg = g.add("ReferenceLatent", f"DR_REF_{i}_NEG", conditioning=o(neg), latent=o(enc))
    return pos, neg


def klein_t2i(refs=0):
    g = G()
    unet, clip, vae, pos, neg = klein_base(g)
    w = g.add("PrimitiveInt", "DR_WIDTH", value=1024)
    h = g.add("PrimitiveInt", "DR_HEIGHT", value=1024)
    if refs:
        pos, neg = klein_refs(g, vae, pos, neg, refs)
    lat = g.add("EmptyFlux2LatentImage", "DR_BATCH", width=o(w), height=o(h), batch_size=1)
    img = klein_sample(g, unet, vae, pos, neg, lat, o(w), o(h))
    g.add("SaveImage", "DR_OUTPUT", images=o(img), filename_prefix="darkroom/klein")
    return g


def klein_masked(outpaint=False, prefix=None):
    """Klein inpaint / outpaint: masked latent re-noise with the source image as
    reference, then composite so pixels outside the mask are untouched."""
    g = G()
    unet, clip, vae, pos, neg = klein_base(g)
    src = g.add("LoadImage", "DR_IMAGE_1", image=PLACEHOLDER_IMAGE)
    if outpaint:
        pad = g.add("ImagePadForOutpaint", "DR_PAD", image=o(src), left=0, top=0, right=0, bottom=0,
                    feathering=24)
        base_img, mask = o(pad, 0), o(pad, 1)
        # reference = the original (unpadded) picture, scaled like the canvas
        ref_src = o(src)
    else:
        m = g.add("LoadImageMask", "DR_MASK", image=PLACEHOLDER_IMAGE, channel="red")
        base_img, mask, ref_src = o(src), o(m), o(src)
    grown = g.add("GrowMask", "DR_MASK_GROW", mask=mask, expand=8, tapered_corners=True)
    # Work at ~1 MP, multiple of 16 (Klein native); both image and mask follow.
    work = g.add("ImageScaleToTotalPixels", "Work size", image=base_img, upscale_method="lanczos",
                 megapixels=1.0, resolution_steps=16)
    size = g.add("GetImageSize", "Work dims", image=o(work))
    mimg = g.add("MaskToImage", "Mask as image", mask=o(grown))
    mimg_s = g.add("ImageScale", "Mask scale", image=o(mimg), upscale_method="bilinear",
                   width=o(size, 0), height=o(size, 1), crop="disabled")
    wmask = g.add("ImageToMask", "Work mask", image=o(mimg_s), channel="red")
    ref_s = g.add("ImageScaleToTotalPixels", "Ref 1 scale", image=ref_src, upscale_method="lanczos",
                  megapixels=1.0, resolution_steps=16)
    ref_l = g.add("VAEEncode", "Ref 1 encode", pixels=o(ref_s), vae=o(vae))
    pos = g.add("ReferenceLatent", "Ref 1 pos", conditioning=o(pos), latent=o(ref_l))
    neg = g.add("ReferenceLatent", "Ref 1 neg", conditioning=o(neg), latent=o(ref_l))
    # optional extra reference (e.g. "put this logo here")
    img2 = g.add("LoadImage", "DR_IMAGE_2", image=PLACEHOLDER_IMAGE)
    sc2 = g.add("ImageScaleToTotalPixels", "Ref 2 scale", image=o(img2), upscale_method="lanczos",
                megapixels=1.0, resolution_steps=16)
    enc2 = g.add("VAEEncode", "Ref 2 encode", pixels=o(sc2), vae=o(vae))
    pos = g.add("ReferenceLatent", "DR_REF_2_POS", conditioning=o(pos), latent=o(enc2))
    neg = g.add("ReferenceLatent", "DR_REF_2_NEG", conditioning=o(neg), latent=o(enc2))
    lat = g.add("VAEEncode", "Encode canvas", pixels=o(work), vae=o(vae))
    nm = g.add("SetLatentNoiseMask", "DR_MASK_LATENT", samples=o(lat), mask=o(wmask))
    img = klein_sample(g, unet, vae, pos, neg, nm, o(size, 0), o(size, 1))
    # Composite back at the source's full resolution so unmasked pixels are exact.
    full = g.add("GetImageSize", "Full dims", image=base_img)
    up = g.add("ImageScale", "Fill to full size", image=o(img), upscale_method="lanczos",
               width=o(full, 0), height=o(full, 1), crop="disabled")
    feat = soft_mask(g, o(grown))
    comp = g.add("ImageCompositeMasked", "DR_MASK_COMPOSITE", destination=base_img, source=o(up), x=0, y=0,
                 resize_source=False, mask=o(feat))
    g.add("SaveImage", "DR_OUTPUT", images=o(comp),
          filename_prefix=prefix or ("darkroom/outpaint" if outpaint else "darkroom/inpaint"))
    return g



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


# ----------------------------------------------------------------- Qwen --
def qwen_t2i():
    g = G()
    unet = g.add("UNETLoader", "DR_MODEL", unet_name=QWEN21_UNET, weight_dtype="default")
    clip = g.add("CLIPLoader", "DR_TEXT_ENCODER", clip_name=QWEN21_TE, type="qwen_image", device="default")
    vae = g.add("VAELoader", "DR_VAE", vae_name=QWEN21_VAE)
    enc = g.add("TextEncodeQwenImage21", "DR_PROMPT", clip=o(clip), prompt="", negative_prompt="",
                resolution=1024)
    w = g.add("PrimitiveInt", "DR_WIDTH", value=1328)
    h = g.add("PrimitiveInt", "DR_HEIGHT", value=1328)
    lat = g.add("EmptyLatentImage", "DR_BATCH", width=o(w), height=o(h), batch_size=1)
    ks = g.add("KSampler", "DR_SAMPLER", model=o(unet), positive=o(enc, 0), negative=o(enc, 1),
               latent_image=o(lat), seed=0, steps=25, cfg=1.0, sampler_name="euler",
               scheduler="simple", denoise=1.0)
    img = g.add("VAEDecodeTiled", "Decode", samples=o(ks), vae=o(vae), tile_size=1024, overlap=128,
                temporal_size=64, temporal_overlap=8)
    g.add("SaveImage", "DR_OUTPUT", images=o(img), filename_prefix="darkroom/qwen")
    return g


def qwen_edit_2511():
    """Qwen-Image-Edit-2511 + Lightning 4-step. image1 = target, image2 = optional
    reference, optional mask limits the change (latent noise mask + composite)."""
    g = G()
    unet = g.add("UNETLoader", "DR_MODEL", unet_name=QEDIT_UNET, weight_dtype="default")
    shift = g.add("ModelSamplingAuraFlow", "Shift", model=o(unet), shift=3.1)
    norm = g.add("CFGNorm", "CFG norm", model=o(shift), strength=1.0)
    lora = g.add("LoraLoaderModelOnly", "DR_LORA", model=o(norm), lora_name=QEDIT_LORA, strength_model=1.0)
    clip = g.add("CLIPLoader", "DR_TEXT_ENCODER", clip_name=QEDIT_TE, type="qwen_image", device="default")
    vae = g.add("VAELoader", "DR_VAE", vae_name=QEDIT_VAE)
    src = g.add("LoadImage", "DR_IMAGE_1", image=PLACEHOLDER_IMAGE)
    scaled = g.add("FluxKontextImageScale", "Scale target", image=o(src))
    ref = g.add("LoadImage", "DR_IMAGE_2", image=PLACEHOLDER_IMAGE)
    pos = g.add("TextEncodeQwenImageEditPlus", "DR_PROMPT", clip=o(clip), vae=o(vae), prompt="",
                image1=o(scaled), image2=o(ref))
    neg = g.add("TextEncodeQwenImageEditPlus", "DR_NEGATIVE", clip=o(clip), vae=o(vae), prompt="",
                image1=o(scaled), image2=o(ref))
    posm = g.add("FluxKontextMultiReferenceLatentMethod", "Ref method +", conditioning=o(pos),
                 reference_latents_method="index_timestep_zero")
    negm = g.add("FluxKontextMultiReferenceLatentMethod", "Ref method -", conditioning=o(neg),
                 reference_latents_method="index_timestep_zero")
    lat = g.add("VAEEncode", "Encode target", pixels=o(scaled), vae=o(vae))
    # optional mask ("only change masked area")
    size = g.add("GetImageSize", "Target dims", image=o(scaled))
    m = g.add("LoadImageMask", "DR_MASK", image=PLACEHOLDER_IMAGE, channel="red")
    grown = g.add("GrowMask", "DR_MASK_GROW", mask=o(m), expand=8, tapered_corners=True)
    mimg = g.add("MaskToImage", "Mask as image", mask=o(grown))
    mimg_s = g.add("ImageScale", "Mask scale", image=o(mimg), upscale_method="bilinear",
                   width=o(size, 0), height=o(size, 1), crop="disabled")
    wmask = g.add("ImageToMask", "Work mask", image=o(mimg_s), channel="red")
    nm = g.add("SetLatentNoiseMask", "DR_MASK_LATENT", samples=o(lat), mask=o(wmask))
    ks = g.add("KSampler", "DR_SAMPLER", model=o(lora), positive=o(posm), negative=o(negm),
               latent_image=o(nm), seed=0, steps=4, cfg=1.0, sampler_name="euler",
               scheduler="simple", denoise=1.0)
    dec = g.add("VAEDecodeTiled", "Decode", samples=o(ks), vae=o(vae), tile_size=1024, overlap=128,
                temporal_size=64, temporal_overlap=8)
    feat = soft_mask(g, o(wmask))
    comp = g.add("ImageCompositeMasked", "DR_MASK_COMPOSITE", destination=o(scaled), source=o(dec),
                 x=0, y=0, resize_source=False, mask=o(feat))
    g.add("SaveImage", "DR_OUTPUT", images=o(comp), filename_prefix="darkroom/edit")
    return g



def qwen21_edit(outpaint=False, prefix="darkroom/edit"):
    """Qwen-Image 2.1 native edit (official template: TextEncodeQwenImage21 + QwenImage21Cache, 25 steps, CFG 1).
    image_1 = picture to edit, image_2 = optional reference, optional mask.
    The result is scaled back to the source size and, with a mask, composited onto the
    ORIGINAL pixels at full resolution, so nothing outside the mask changes."""
    g = G()
    unet = g.add("UNETLoader", "DR_MODEL", unet_name=QWEN21_UNET, weight_dtype="default")
    cache = g.add("QwenImage21Cache", "Prefix cache", model=o(unet), device="auto", dtype="default")
    clip = g.add("CLIPLoader", "DR_TEXT_ENCODER", clip_name=QWEN21_TE, type="qwen_image", device="default")
    vae = g.add("VAELoader", "DR_VAE", vae_name=QWEN21_VAE)
    src0 = g.add("LoadImage", "DR_IMAGE_1", image=PLACEHOLDER_IMAGE)
    if outpaint:
        pad = g.add("ImagePadForOutpaint", "DR_PAD", image=o(src0), left=0, top=0, right=0, bottom=0, feathering=24)
        src, pad_mask = pad, o(pad, 1)
    else:
        src, pad_mask = src0, None
    ref = g.add("LoadImage", "DR_IMAGE_2", image=PLACEHOLDER_IMAGE)
    # Work at ~1 MP (multiple of 32). The encoded picture itself is the starting latent, so a masked
    # edit keeps the real surroundings as context instead of painting against an empty canvas.
    work = g.add("ImageScaleToTotalPixels", "Work size", image=o(src), upscale_method="lanczos",
                 megapixels=1.0, resolution_steps=32)
    # Outpaint: the model sees the ORIGINAL picture (not the grey-padded canvas, which it would copy)
    # and samples into the padded canvas latent.
    seen = o(g.add("ImageScaleToTotalPixels", "Original for model", image=o(src0), upscale_method="lanczos",
                   megapixels=1.0, resolution_steps=32)) if outpaint else o(work)
    enc = g.add("TextEncodeQwenImage21", "DR_PROMPT", clip=o(clip), vae=o(vae), prompt="", negative_prompt="",
                resolution=0, **{"images.image_1": seen, "images.image_2": o(ref)})
    lat = g.add("VAEEncode", "Encode picture", pixels=o(work), vae=o(vae))
    # optional mask: full-resolution, white = change (the sampler resizes the noise mask to the latent)
    if outpaint:
        mask_in = pad_mask
    else:
        mask_in = o(g.add("LoadImageMask", "DR_MASK", image=PLACEHOLDER_IMAGE, channel="red"))
    grown = g.add("GrowMask", "DR_MASK_GROW", mask=mask_in, expand=8, tapered_corners=True)
    nm = g.add("SetLatentNoiseMask", "DR_MASK_LATENT", samples=o(lat), mask=o(grown))
    ks = g.add("KSampler", "DR_SAMPLER", model=o(cache), positive=o(enc, 0), negative=o(enc, 1),
               latent_image=o(nm), seed=0, steps=25, cfg=1.0, sampler_name="euler",
               scheduler="simple", denoise=1.0)
    dec = g.add("VAEDecodeTiled", "Decode", samples=o(ks), vae=o(vae), tile_size=1024, overlap=128,
                temporal_size=64, temporal_overlap=8)
    full = g.add("GetImageSize", "Source dims", image=o(src))
    up = g.add("ImageScale", "Back to source size", image=o(dec), upscale_method="lanczos",
               width=o(full, 0), height=o(full, 1), crop="disabled")
    feat = soft_mask(g, o(grown))
    comp = g.add("ImageCompositeMasked", "DR_MASK_COMPOSITE", destination=o(src), source=o(up), x=0, y=0,
                 resize_source=False, mask=o(feat))
    g.add("SaveImage", "DR_OUTPUT", images=o(comp), filename_prefix=prefix)
    return g



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



def vlm_text(with_image=True):
    """Qwen3-VL-8B text generation (caption / reverse prompt / enhance). Loaded with the generic CLIP
    type so ComfyUI builds the plain Qwen3-VL chat model (comfy/sd.py, QWEN3VL_8B fall-through).
    Qwen3-VL instruct sampling (model card): temperature 0.7, top_p 0.8, top_k 20."""
    g = G()
    clip = g.add("CLIPLoader", "DR_MODEL", clip_name=VLM_TE, type="stable_diffusion", device="default")
    inputs = dict(clip=o(clip), prompt="", max_length=512, sampling_mode="on",
                  **{"sampling_mode.temperature": 0.7, "sampling_mode.top_k": 20, "sampling_mode.top_p": 0.8,
                     "sampling_mode.min_p": 0.0, "sampling_mode.repetition_penalty": 1.05, "sampling_mode.seed": 0},
                  thinking=False, use_default_template=True)
    if with_image:
        img = g.add("LoadImage", "DR_IMAGE_1", image=PLACEHOLDER_IMAGE)
        scaled = g.add("ImageScaleToTotalPixels", "Vision size", image=o(img), upscale_method="lanczos",
                       megapixels=0.6, resolution_steps=32)
        inputs["image"] = o(scaled)
    gen = g.add("TextGenerate", "DR_PROMPT", **inputs)
    g.add("PreviewAny", "DR_OUTPUT", source=o(gen))
    return g



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


# -------------------------------------------------------------- utility --
def remove_bg():
    g = G()
    src = g.add("LoadImage", "DR_IMAGE_1", image=PLACEHOLDER_IMAGE)
    model = g.add("LoadBackgroundRemovalModel", "DR_MODEL", bg_removal_name=BIREFNET)
    rb = g.add("RemoveBackground", "Remove background", bg_removal_model=o(model), image=o(src))
    inv = g.add("InvertMask", "Invert", mask=o(rb))
    rgba = g.add("JoinImageWithAlpha", "Join alpha", image=o(src), alpha=o(inv))
    g.add("SaveImage", "DR_OUTPUT", images=o(rgba), filename_prefix="darkroom/cutout")
    return g


def upscale():
    g = G()
    src = g.add("LoadImage", "DR_IMAGE_1", image=PLACEHOLDER_IMAGE)
    unet = g.add("UNETLoader", "DR_MODEL", unet_name=SEEDVR2_UNET, weight_dtype="default")
    vae = g.add("VAELoader", "DR_VAE", vae_name=SEEDVR2_VAE)
    rs = g.add("ResizeImageMaskNode", "DR_SCALE", input=o(src), resize_type="scale by multiplier",
               **{"resize_type.multiplier": 2.0}, scale_method="lanczos")
    pre = g.add("SeedVR2Preprocess", "Preprocess", resized_images=o(rs))
    enc = g.add("VAEEncodeTiled", "Encode", pixels=o(pre), vae=o(vae), tile_size=512, overlap=128,
                temporal_size=4096, temporal_overlap=8)
    cond = g.add("SeedVR2Conditioning", "Condition", model=o(unet), vae_conditioning=o(enc))
    ks = g.add("KSampler", "DR_SAMPLER", model=o(unet), positive=o(cond, 0), negative=o(cond, 1),
               latent_image=o(enc), seed=0, steps=1, cfg=1.0, sampler_name="euler",
               scheduler="simple", denoise=1.0)
    dec = g.add("VAEDecodeTiled", "Decode", samples=o(ks), vae=o(vae), tile_size=512, overlap=128,
                temporal_size=4096, temporal_overlap=8)
    post = g.add("SeedVR2PostProcessing", "Colour match", images=o(dec), original_resized_images=o(rs),
                 color_correction_method="lab")
    g.add("SaveImage", "DR_OUTPUT", images=o(post), filename_prefix="darkroom/upscale")
    return g


# ---------------------------------------------------------------- video --
def video_tail(g, frames_img, fps_node, prefix):
    vid = g.add("CreateVideo", "Create video", images=frames_img, fps=o(fps_node))
    g.add("SaveVideo", "DR_OUTPUT", video=o(vid), filename_prefix=prefix, format="mp4",
          **{"format.codec": "h264"})
    first = g.add("ImageFromBatch", "Poster frame", image=frames_img, batch_index=0, length=1)
    g.add("SaveImage", "DR_POSTER", images=o(first), filename_prefix=prefix + "_poster")
    last = g.add("ImageFromBatch", "Last frame", image=frames_img, batch_index=4095, length=1)
    g.add("SaveImage", "DR_LAST_FRAME", images=o(last), filename_prefix=prefix + "_last")


def wan22_i2v(negative=WAN_NEGATIVE):
    g = G()
    te = g.add("CLIPLoader", "DR_TEXT_ENCODER", clip_name=WAN_TE, type="wan", device="default")
    vae = g.add("VAELoader", "DR_VAE", vae_name=WAN_VAE)
    hi = g.add("UNETLoader", "DR_MODEL_HIGH", unet_name=WAN_HIGH, weight_dtype="default")
    lo = g.add("UNETLoader", "DR_MODEL_LOW", unet_name=WAN_LOW, weight_dtype="default")
    hil = g.add("LoraLoaderModelOnly", "DR_LORA_HIGH", model=o(hi), lora_name=WAN_LORA_HIGH, strength_model=1.0)
    lol = g.add("LoraLoaderModelOnly", "DR_LORA_LOW", model=o(lo), lora_name=WAN_LORA_LOW, strength_model=1.0)
    his = g.add("ModelSamplingSD3", "Shift high", model=o(hil), shift=5.0)
    los = g.add("ModelSamplingSD3", "Shift low", model=o(lol), shift=5.0)
    pos = g.add("CLIPTextEncode", "DR_MOTION_PROMPT", text="", clip=o(te))
    neg = g.add("CLIPTextEncode", "DR_NEGATIVE", text=negative, clip=o(te))
    start = g.add("LoadImage", "DR_START_IMAGE", image=PLACEHOLDER_IMAGE)
    end = g.add("LoadImage", "DR_END_IMAGE", image=PLACEHOLDER_IMAGE)
    w = g.add("PrimitiveInt", "DR_WIDTH", value=832)
    h = g.add("PrimitiveInt", "DR_HEIGHT", value=480)
    fr = g.add("PrimitiveInt", "DR_FRAMES", value=81)
    fps = g.add("PrimitiveFloat", "DR_FPS", value=16.0)
    s_img = g.add("ImageScale", "Start fit", image=o(start), upscale_method="lanczos", width=o(w),
                  height=o(h), crop="center")
    e_img = g.add("ImageScale", "DR_END_FIT", image=o(end), upscale_method="lanczos", width=o(w),
                  height=o(h), crop="center")
    flf = g.add("WanFirstLastFrameToVideo", "Frames to video", positive=o(pos), negative=o(neg),
                vae=o(vae), width=o(w), height=o(h), length=o(fr), batch_size=1,
                start_image=o(s_img), end_image=o(e_img))
    steps = g.add("PrimitiveInt", "DR_STEPS", value=4)
    split = g.add("PrimitiveInt", "DR_SPLIT", value=2)
    k1 = g.add("KSamplerAdvanced", "DR_SEED", model=o(his), add_noise="enable", noise_seed=0,
               steps=o(steps), cfg=1.0, sampler_name="euler", scheduler="simple", positive=o(flf, 0),
               negative=o(flf, 1), latent_image=o(flf, 2), start_at_step=0, end_at_step=o(split),
               return_with_leftover_noise="enable")
    k2 = g.add("KSamplerAdvanced", "Low noise", model=o(los), add_noise="disable", noise_seed=0,
               steps=o(steps), cfg=1.0, sampler_name="euler", scheduler="simple", positive=o(flf, 0),
               negative=o(flf, 1), latent_image=o(k1), start_at_step=o(split), end_at_step=10000,
               return_with_leftover_noise="disable")
    dec = g.add("VAEDecode", "Decode", samples=o(k2), vae=o(vae))
    video_tail(g, o(dec), fps, "darkroom/video/wan")
    return g


def ltx25_i2v(negative=LTX_NEGATIVE):
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
    neg = g.add("CLIPTextEncode", "DR_NEGATIVE", text=negative, clip=o(te))
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


def video_interp():
    g = G()
    v = g.add("LoadVideo", "DR_VIDEO", file=PLACEHOLDER_VIDEO)
    comp = g.add("GetVideoComponents", "Components", video=o(v))
    m = g.add("FrameInterpolationModelLoader", "DR_MODEL", model_name=INTERP_MODEL)
    fi = g.add("FrameInterpolate", "DR_MULTIPLIER", interp_model=o(m), images=o(comp, 0), multiplier=2)
    fps = g.add("PrimitiveFloat", "DR_FPS", value=32.0)
    vid = g.add("CreateVideo", "Create video", images=o(fi), fps=o(fps), audio=o(comp, 1))
    g.add("SaveVideo", "DR_OUTPUT", video=o(vid), filename_prefix="darkroom/video/smooth", format="mp4",
          **{"format.codec": "h264"})
    first = g.add("ImageFromBatch", "Poster frame", image=o(fi), batch_index=0, length=1)
    g.add("SaveImage", "DR_POSTER", images=o(first), filename_prefix="darkroom/video/smooth_poster")
    return g


def video_join():
    """Join clip A and clip B (B's first frame duplicates A's last frame, so it is dropped)."""
    g = G()
    a = g.add("LoadVideo", "DR_VIDEO", file=PLACEHOLDER_VIDEO)
    b = g.add("LoadVideo", "DR_VIDEO_2", file=PLACEHOLDER_VIDEO)
    ca = g.add("GetVideoComponents", "A", video=o(a))
    cb = g.add("GetVideoComponents", "B", video=o(b))
    btail = g.add("ImageFromBatch", "B without first frame", image=o(cb, 0), batch_index=1, length=4095)
    both = g.add("ImageBatch", "Join", image1=o(ca, 0), image2=o(btail))
    fps = g.add("PrimitiveFloat", "DR_FPS", value=16.0)
    video_tail(g, o(both), fps, "darkroom/video/extended")
    return g


def crop():
    g = G()
    src = g.add("LoadImage", "DR_IMAGE_1", image=PLACEHOLDER_IMAGE)
    c = g.add("ImageCrop", "DR_CROP", image=o(src), width=512, height=512, x=0, y=0)
    g.add("SaveImage", "DR_OUTPUT", images=o(c), filename_prefix="darkroom/crop")
    return g


def import_image():
    """Copy an uploaded picture into the output folder so it becomes a library item."""
    g = G()
    src = g.add("LoadImage", "DR_IMAGE_1", image=PLACEHOLDER_IMAGE)
    g.add("SaveImage", "DR_OUTPUT", images=o(src), filename_prefix="darkroom/import")
    return g


def video_frame():
    """Save one frame of a video as a still image."""
    g = G()
    v = g.add("LoadVideo", "DR_VIDEO", file=PLACEHOLDER_VIDEO)
    comp = g.add("GetVideoComponents", "Components", video=o(v))
    f = g.add("ImageFromBatch", "DR_FRAME", image=o(comp, 0), batch_index=0, length=1)
    g.add("SaveImage", "DR_OUTPUT", images=o(f), filename_prefix="darkroom/frame")
    return g


if __name__ == "__main__":
    klein_t2i(0).save("klein_t2i.json")
    klein_t2i(3).save("klein_ref.json")
    qwen_t2i().save("qwen_t2i.json")
    qwen21_edit().save("qwen_edit.json")
    qwen21_edit(prefix="darkroom/inpaint").save("qwen_inpaint.json")
    qwen21_edit(outpaint=True, prefix="darkroom/outpaint").save("qwen_outpaint.json")
    qwen_ref().save("qwen_ref.json")
    qwen_edit_2511().save("qwen_edit_2511.json")
    klein_masked(False).save("inpaint.json")
    klein_masked(False, prefix="darkroom/edit").save("klein_edit.json")
    klein_enhance().save("klein_enhance.json")
    qwen_enhance().save("qwen_enhance.json")
    klein_masked(True).save("outpaint.json")
    remove_bg().save("remove_bg.json")
    upscale().save("upscale.json")
    wan22_i2v().save("wan22_i2v.json")
    # v2: negatives removed - inert at CFG 1 (comfy/samplers.py skips the uncond pass). PROMPT_AUDIT P6/P7.
    wan22_i2v(negative="").save("wan22_i2v.v2.json")
    ltx25_i2v().save("ltx25_i2v.json")
    ltx25_i2v(negative="").save("ltx25_i2v.v2.json")
    video_interp().save("video_interp.json")
    video_join().save("video_join.json")
    crop().save("crop.json")
    import_image().save("import.json")
    video_frame().save("video_frame.json")
    vlm_text(True).save("vlm_image.json")
    vlm_text(False).save("vlm_text.json")
