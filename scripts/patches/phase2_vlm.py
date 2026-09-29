# Phase 2: Qwen3-VL-8B (already installed as Qwen-Image 2.1's text encoder) as a local VLM via core TextGenerate.
import json

s = open('build_workflows.py', encoding='utf-8').read()
if 'def vlm_text' not in s:
    s = s.replace('INTERP_MODEL = "rife_v4.26.safetensors"', '''INTERP_MODEL = "rife_v4.26.safetensors"
VLM_TE = "qwen3vl_8b_int8_convrot.safetensors"  # same file as QWEN21_TE; has lm_head + vision tower''')
    s = s.replace('\n\n# -------------------------------------------------------------- utility --', '''


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


# -------------------------------------------------------------- utility --''', 1)
    s = s.replace('    video_frame().save("video_frame.json")',
                  '    video_frame().save("video_frame.json")\n    vlm_text(True).save("vlm_image.json")\n    vlm_text(False).save("vlm_text.json")')
    open('build_workflows.py', 'w', encoding='utf-8').write(s)

m = json.load(open('manifest.json', encoding='utf-8'))
common = {
    "prompt": {"type": "string", "targets": [{"title": "DR_PROMPT", "input": "prompt"}], "default": ""},
    "max_tokens": {"type": "int", "targets": [{"title": "DR_PROMPT", "input": "max_length"}], "default": 512, "min": 32, "max": 2048},
    "temperature": {"type": "float", "targets": [{"title": "DR_PROMPT", "input": "sampling_mode.temperature"}], "default": 0.7, "min": 0.05, "max": 1.5},
    "seed": {"type": "int", "targets": [{"title": "DR_PROMPT", "input": "sampling_mode.seed"}], "default": 0, "min": 0, "max": 4294967295},
}
m['workflows']['vlm_image'] = {"file": "vlm_image.json", "family": "vlm", "kind": "text", "label": "Qwen3-VL 8B (image + text)",
                               "params": {**common, "image_1": {"type": "image", "label": "Image", "targets": [{"title": "DR_IMAGE_1", "input": "image"}]}},
                               "outputs": {"text": "DR_OUTPUT"}}
m['workflows']['vlm_text'] = {"file": "vlm_text.json", "family": "vlm", "kind": "text", "label": "Qwen3-VL 8B (text only)",
                              "params": dict(common), "outputs": {"text": "DR_OUTPUT"}}
json.dump(m, open('manifest.json', 'w', encoding='utf-8'), indent=2, ensure_ascii=False)
print('vlm workflows added')
