# Darkroom — install audit (2026-09-29)

## The real layout (differs from the brief)

The brief assumed the legacy ComfyUI Desktop layout (`E:\ComfyUI\Desktop ComfyUI\{models,custom_nodes,.venv}` on port 8000,
config in `%APPDATA%\ComfyUI\`). This machine runs the **new "Comfy Desktop" launcher (v1.1.3)**, which manages
*installations*. What is actually there:

| Item | Path / value |
|---|---|
| Desktop app executable | `E:\ComfyUI\Desktop ComfyUI\Comfy Desktop\Comfy Desktop.exe` (v1.1.3) |
| Legacy Desktop app (unused, not touched) | `%LOCALAPPDATA%\Programs\@comfyorgcomfyui-electron\ComfyUI.exe` |
| Desktop settings | `%APPDATA%\Comfy Desktop\settings.json`, `installations.json` |
| Models config (= extra_models_config) | `%APPDATA%\Comfy Desktop\instance-model-paths\inst-1790618188034.yaml` (generated, "do not edit") and `shared_model_paths.yaml` |
| Desktop logs | `%APPDATA%\Comfy Desktop\logs\app.log` (includes the ComfyUI server output) |
| Installation id | `inst-1790618188034` ("ComfyUI", Standalone, win-nvidia) |
| ComfyUI repo root | `E:\ComfyUI\Desktop ComfyUI\ComfyUI\ComfyUI` |
| Python | `E:\ComfyUI\Desktop ComfyUI\ComfyUI\ComfyUI\.venv\Scripts\python.exe` (3.13.12, torch 2.12.1+cu130) |
| custom_nodes | `E:\ComfyUI\Desktop ComfyUI\ComfyUI\ComfyUI\custom_nodes` (only `websocket_image_save.py`; ComfyUI-Manager is built in via `--enable-manager`) |
| Default models dir (is_default) | `E:\Comfy-Desktop\ComfyUI-Shared\models` |
| Also searched | `E:\ComfyUI\Desktop ComfyUI\ComfyUI\ComfyUI\models` (the install's own folder, holds most existing models) |
| Input dir | `E:\Comfy-Desktop\ComfyUI-Shared\input` |
| Output dir | `E:\Comfy-Desktop\ComfyUI-Shared\output` |
| Port | **8188** (Desktop default, `portConflict: auto` → shifts to the next free port if taken). Darkroom discovers it; never hard-coded. |
| ComfyUI version | **0.37.4** (frontend 1.52.7, templates 0.11.69) |
| GPU | RTX 3090, 24.0 GB (cudaMallocAsync, DynamicVRAM enabled) |
| Disk | E: 1.2 TB free of 1.9 TB — all downloads stay on E: |

Launch args Desktop uses: `--enable-manager --extra-model-paths-config <instance yaml> --input-directory ... --output-directory ...`.

**Second server found:** at audit time a separate ComfyUI process from the "Forma" project was serving port 8188
from the same install (own user/input/output dirs, custom nodes disabled) and holding ~18 GB VRAM. The user closed it.
Darkroom identifies the *Desktop* server by checking `/system_stats → argv` for `instance-model-paths`, so it will
not silently talk to a different server on the same port.

## Models present (relevant)

| Capability | File | Where | Status |
|---|---|---|---|
| FLUX.2 Klein 9B (distilled) | `flux-2-klein-9b-fp8mixed.safetensors` 9.0 GB | install models/diffusion_models | present ✔ (used) |
| | `flux-2-klein-9b.safetensors` 17.3 GB bf16, `flux-2-klein-9b-kv.safetensors` 17.3 GB | same | present |
| Klein text encoder | `qwen_3_8b_fp8mixed.safetensors` 8.3 GB | text_encoders | present ✔ |
| Klein VAE | `flux2-vae.safetensors` | vae | present ✔ |
| Qwen-Image 2.1 | `qwen_image_2.1_int8_convrot.safetensors` 7.3 GB | shared diffusion_models | present ✔ |
| Qwen-Image 2.1 TE / VAE | `qwen3vl_8b_int8_convrot.safetensors`, `qwen_image_2.1_vae_bf16.safetensors` | shared | present ✔ |
| Qwen-Image-Edit-2511 | `Qwen-Image-Edit-2511-FP8_e4m3fn.safetensors` 19.5 GB | diffusion_models | present ✔ |
| 2511 Lightning LoRA | `Qwen-Image-Edit-2511-Lightning-4steps-V1.0-bf16.safetensors` | loras | present ✔ |
| Qwen edit TE / VAE | `qwen_2.5_vl_7b_fp8_scaled.safetensors`, `qwen_image_vae.safetensors` | | present ✔ |
| Background removal | `background_removal/birefnet.safetensors` (core `RemoveBackground` node) | | present ✔ |
| SeedVR2 7B | `seedvr2_7b_int8_convrot.safetensors` + `vae/ema_vae_fp16.safetensors` (identical size to Comfy-Org `seedvr2_ema_vae_fp16`) | | present ✔ |
| Wan 2.2 I2V A14B | — | | **missing → download** |
| LTX-2.5 | — (`ltx-2-19b-dev-fp8.safetensors` in checkpoints is a truncated 331 MB file — broken, left untouched) | | **missing → download** |
| Frame interpolation | — (`frame_interpolation/` empty) | | **missing → download** |

## Nodes (GET /object_info on 0.37.4, 964 nodes)

Everything Darkroom needs is **core ComfyUI** — no custom node packs are required:

- Klein: `UNETLoader`, `CLIPLoader(type=flux2)`, `EmptyFlux2LatentImage`, `Flux2Scheduler`, `CFGGuider`, `ReferenceLatent`, `FluxKVCache`
- Qwen-Image 2.1: `TextEncodeQwenImage21`, `QwenImage21Cache`
- Qwen-Image-Edit-2511: `TextEncodeQwenImageEditPlus`, `FluxKontextMultiReferenceLatentMethod`, `CFGNorm`, `ModelSamplingAuraFlow`
- Masking/inpaint: `SetLatentNoiseMask`, `InpaintModelConditioning`, `ImageCompositeMasked`, `GrowMask`, `FeatherMask`, `LoadImageMask`, `ImagePadForOutpaint`
- Background removal: `LoadBackgroundRemovalModel` + `RemoveBackground` (BiRefNet) + `JoinImageWithAlpha`
- Upscale: `SeedVR2Conditioning/Preprocess/PostProcessing` (core), `ImageUpscaleWithModel`
- Wan 2.2: `WanImageToVideo`, `WanFirstLastFrameToVideo`, `KSamplerAdvanced`, `ModelSamplingSD3`
- LTX-2.5: `LTXVImgToVideoInplace`, `LTXVAddGuide`, `LTXVConditioning`, `LTXVDualCFGGuider`, `LTXVLatentUpsampler`, `LTXVConcatAVLatent`, ...
- Interpolation: `FrameInterpolationModelLoader` + `FrameInterpolate` (RIFE / FILM)
- Video out: `CreateVideo` + `SaveVideo` (MP4/H.264, core — VideoHelperSuite not needed)

## Downloads chosen (all into `E:\Comfy-Desktop\ComfyUI-Shared\models\…`)

| File | Repo | Folder | Size | Licence |
|---|---|---|---|---|
| wan2.2_i2v_high_noise_14B_fp8_scaled | Comfy-Org/Wan_2.2_ComfyUI_Repackaged | diffusion_models | 14.3 GB | Apache-2.0 |
| wan2.2_i2v_low_noise_14B_fp8_scaled | same | diffusion_models | 14.3 GB | Apache-2.0 |
| wan2.2_i2v_lightx2v_4steps_lora_v1_{high,low}_noise | same | loras | 2 × 1.23 GB | Apache-2.0 |
| umt5_xxl_fp8_e4m3fn_scaled | same | text_encoders | 6.7 GB | Apache-2.0 |
| wan_2.1_vae | same | vae | 0.25 GB | Apache-2.0 |
| ltx-2.5-22b-distilled-transformer-comfy-int8-convrot | Lightricks/LTX-2.5 (gated — cached HF token already had access) | diffusion_models | 21.5 GB | LTX-2 Community Licence (free under $10 M ARR) |
| gemma4-12b-with-proj-ltx-2.5-comfy-int8-convrot | same | text_encoders | 15.4 GB | same + Gemma terms |
| ltx-2.5-video-vae-bf16 / audio-vae-bf16 | same | vae | 1.47 + 0.36 GB | same |
| ltx-2.5-latent-spatial-upscaler-x2-bf16-1.0 | same | latent_upscale_models | 1.0 GB | same |
| rife_v4.26, film_net_fp16 | Comfy-Org/frame_interpolation | frame_interpolation | 23 MB, 69 MB | MIT / Apache-2.0 |

Precision choice: fp8_scaled (Wan) and int8_convrot (LTX, Qwen 2.1) — bf16 versions are 28–42 GB and cannot fit a
24 GB card. NVFP4 LTX weights need Blackwell (RTX 50xx) and don't run fast on Ampere.

## Licences

- **FLUX.2 [klein] 9B — FLUX Non-Commercial License** (HF licence "other", gated "auto"). Confirmed: the 9B is
  non-commercial; only Klein **4B** is Apache-2.0. Outputs may not be used commercially under the non-commercial
  licence without a BFL commercial licence. Darkroom shows this in the model card tooltip.
- Qwen-Image 2.1: Qwen licence ("other"); Qwen-Image-Edit-2511: Apache-2.0.
- Wan 2.2: Apache-2.0. LTX-2.5: LTX-2 Community Licence. SeedVR2: Apache-2.0. BiRefNet: MIT.

## Recommended settings (from the official ComfyUI 0.11.69 templates shipped with this install)

| Model | Steps | CFG | Sampler / scheduler | Native res | Refs / editing |
|---|---|---|---|---|---|
| Klein 9B distilled | 4 | 1.0 (negative = `ConditioningZeroOut`) | euler + `Flux2Scheduler` | ~1 MP, multiples of 16 | Up to 4 images total via `ReferenceLatent` chained on pos+neg (VAE-encoded, scaled to 1 MP) |
| Qwen-Image 2.1 | 25 (official 40–50) | 1.0 | euler / simple | 1 MP default, native up to 2048² | Native edit via `TextEncodeQwenImage21.images`, `<image1>`… |
| Qwen-Image-Edit-2511 + Lightning | 4 | 1.0 | euler / simple, AuraFlow shift 3.1, `CFGNorm` | follows image 1 (`FluxKontextImageScale`) | image1 = target, image2/3 refs, `index_timestep_zero` |
| Wan 2.2 I2V A14B + lightx2v | 4 total (2 high + 2 low) | 1.0 | euler / simple, shift 5 | 640², 832×480, 1280×720; 16 fps; length = 16·s+1 | `WanFirstLastFrameToVideo` for end frame |
| LTX-2.5 distilled | 8 + 3 (manual sigmas, 2 stages, x2 latent upsample) | 1.0 | euler_ancestral | half-res stage then ×2; 24 fps; length = fps·s+1 | first frame via `LTXVImgToVideoInplace`; last frame via guide (FLF2V template) |
| SeedVR2 7B | 1 | 1.0 | euler / simple | any | tiled VAE |
