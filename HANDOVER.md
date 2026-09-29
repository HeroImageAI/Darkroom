# Handover

## What was installed, and where

**Nothing existing was deleted or overwritten.** All additions are listed below.

### Models (all in `E:\Comfy-Desktop\ComfyUI-Shared\models\`, Comfy Desktop's default models folder)

| File | Folder | Size |
|---|---|---|
| wan2.2_i2v_high_noise_14B_fp8_scaled.safetensors | diffusion_models | 14.3 GB |
| wan2.2_i2v_low_noise_14B_fp8_scaled.safetensors | diffusion_models | 14.3 GB |
| wan2.2_i2v_lightx2v_4steps_lora_v1_high_noise.safetensors | loras | 1.2 GB |
| wan2.2_i2v_lightx2v_4steps_lora_v1_low_noise.safetensors | loras | 1.2 GB |
| umt5_xxl_fp8_e4m3fn_scaled.safetensors | text_encoders | 6.7 GB |
| wan_2.1_vae.safetensors | vae | 0.25 GB |
| ltx-2.5-22b-distilled-transformer-comfy-int8-convrot.safetensors | diffusion_models | 21.5 GB |
| gemma4-12b-with-proj-ltx-2.5-comfy-int8-convrot.safetensors | text_encoders | 15.4 GB |
| ltx-2.5-video-vae-bf16 / ltx-2.5-audio-vae-bf16 | vae | 1.8 GB |
| ltx-2.5-latent-spatial-upscaler-x2-bf16-1.0 | latent_upscale_models | 1.0 GB (downloaded, not used by the shipped graph) |
| ltx-2.5-duration-head-bf16 | model_patches | tiny |
| rife_v4.26.safetensors, film_net_fp16.safetensors | frame_interpolation | 92 MB |

Klein 9B, Qwen-Image 2.1, Qwen-Image-Edit-2511, SeedVR2, BiRefNet and their encoders were **already installed** and are used
as they are.

### Custom nodes / Python packages

**None.** Everything runs on core ComfyUI 0.37.4 nodes, so the Desktop `.venv` was not modified and nothing needs
reinstalling after a Desktop update. (`backup/pip-freeze.txt` records the environment as found.)

### Configuration

- Comfy Desktop settings: **unchanged**. (An attempt to enable "Auto-launch on startup" was blocked by the build sandbox;
  you can turn it on yourself in Comfy Desktop → Settings to skip the one click on its dashboard.)
- Desktop shortcut: `Desktop\Darkroom.lnk` → `E:\Darkroom\start-darkroom.bat`.
- Darkroom's own files: `E:\Darkroom` (app, `data\` library database and thumbnails, `workflows\`, `presets\`).
- Uploaded inputs go to `E:\Comfy-Desktop\ComfyUI-Shared\input\darkroom\`; outputs to `…\output\darkroom\`.

## What works

Everything in the brief, tested against the real models. Screenshots of each flow are in `proof/`, and timings are in
BENCHMARKS.md.

- All four screens: Generate (Klein 9B / Qwen-Image 2.1, refs, screen capture, batch, variations, history), Edit (mask
  tools, instruct/inpaint/outpaint/remove BG/upscale/crop, versions, compare, undo/redo), Video (Wan 2.2 / LTX 2.5,
  start + end frames, camera chips, draft → final, takes, Extend, Smooth, Save frame, notifications, survives reloads),
  and Library (search, filters, hover-play, full metadata, reuse, open graph).
- Each output also embeds its settings in the PNG (`darkroom` text chunk plus the exact API `prompt`).
- `npm test`: 67 unit tests. `npm run e2e`: 7 end-to-end tests in Edge against ComfyUI (about 3–4 minutes).

## Known limitations

- **Smart select** is a disabled stub (tooltip explains). Use the brush or lasso.
- **Enhance** is a stub that returns your prompt unchanged.
- **Open graph in ComfyUI** downloads the API graph and opens ComfyUI; you drop the file onto the canvas (ComfyUI has no URL
  for loading a graph).
- If ComfyUI restarts mid-render, that take is marked *lost* (ComfyUI forgets its queue); settings are kept for a re-run.
- LTX-2.5 clips include generated audio (the model makes sound together with the picture).
- If Comfy Desktop opens on its dashboard, one click on the ComfyUI install is needed (see above).

## Rolling back ComfyUI

Darkroom changed nothing inside ComfyUI except adding model files. To undo everything:

1. Delete the model files listed above if you don't want them (they're only additions).
2. The `.venv` was never touched; `backup/pip-freeze.txt` is the state it was found in. To restore packages after some later
   change: `"E:\ComfyUI\Desktop ComfyUI\ComfyUI\ComfyUI\.venv\Scripts\python.exe" -m pip install -r backup\pip-freeze.txt`.
3. `backup/custom_nodes.txt` lists the custom nodes as found (only `websocket_image_save.py`).
4. `backup/settings.json`, `installations.json`, `shared_model_paths.yaml` and `extra_models_config.*.yaml` are copies of
   Comfy Desktop's configuration from `%APPDATA%\Comfy Desktop\`. Copy them back (with Comfy Desktop closed) to restore.
5. `backup/comfyui-commit.txt` holds the ComfyUI commit (v0.37.4) that was installed.
6. To remove Darkroom: delete `E:\Darkroom` and the desktop shortcut.
