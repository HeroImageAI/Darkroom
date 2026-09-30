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
| **v2:** sam3.1_multiplex_fp16.safetensors | checkpoints | 1.7 GB (SAM 3.1: smart select, Remove BG v2, SAM layers) |
| **v2:** qwen_image_layered_fp8mixed.safetensors | diffusion_models | 19.1 GB (Qwen-Image-Layered: Layers mode B) |
| **v2:** qwen_image_layered_vae.safetensors | vae | 0.24 GB |
| **addenda:** qwen3.5_9b_qwen_image_2.1_pe_t2i.int8_convrot.safetensors | text_encoders | 9.5 GB (official Qwen-Image 2.1 prompt enhancer: Qwen Enhance + aspect ratio) |
| **addenda:** qwen3.5_9b_qwen_image_2.1_pe_i2i.int8_convrot.safetensors | text_encoders | 9.5 GB (official edit-instruction enhancer: Qwen "Enhance instruction") |
| **addenda:** qwen_image_2.1_fun_controlnet_union_int8_convrot.safetensors | model_patches | 3.8 GB (tested for inpaint and rejected; used only by `workflows/experiments/` — safe to delete) |
| **addenda:** qwen3.5_4b_bf16.safetensors | text_encoders | 9.3 GB (A/B candidate for the general VLM, not chosen — safe to delete) |

The v2 VLM (Qwen3-VL 8B, `qwen3vl_8b_int8_convrot`) and Lucida matting were **already installed**. All three v2 downloads
were fetched by `scripts/download-models-v2.sh`, the four addenda files by `scripts/download-models-v3.sh`; both only
add files (sizes checked, resumable).

Klein 9B, Qwen-Image 2.1, Qwen-Image-Edit-2511, SeedVR2, BiRefNet and their encoders were **already installed** and are used
as they are.

### Custom nodes / Python packages

**None.** Everything runs on core ComfyUI nodes (0.37.4 for v2; the addenda use 0.38.0 core nodes such as
`TextEncodeQwenImage21`, `TextGenerate`, `SeedVR2*` and `ImageCompositeMasked` — crop and stitch is built from core
nodes, as decided), so the Desktop `.venv` was not modified and nothing needs
reinstalling after a Desktop update. (`backup/pip-freeze.txt` records the environment as found.)
Comfy Desktop has since updated ComfyUI to **0.38.0** on its own (noticed 2026-09-30); all 13 end-to-end tests pass on
it unchanged.

Darkroom's own npm packages added in v2: `ag-psd` (layered PSD export) and `fflate` (ZIP export). Both live in
`E:\Darkroom\node_modules` only.

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
- **Addenda** (One Node patterns + Qwen-Image 2.1 parity): Klein One Node sampler, Qwen Draft / Native 2K, Enhance
  = Restore, crop-and-stitch inpaint, red-circle quick edit (Qwen), canvas-prep outpaint, Upscale v2 with alpha,
  Qwen background removal and layers, 56 edit presets with your own presets file, PNG settings + Restore + Use as…,
  official Qwen prompt enhancers. Per-feature model advice: `docs/qa/ADDENDA_REPORT.md`; A/B grids per phase in
  `docs/qa/addenda/` (re-run with `npx tsx scripts/ab-addenda.ts <phase>`).
- `npm test`: 269 unit tests. `npm run e2e`: 25 end-to-end tests in Edge against ComfyUI (v1, v2 and the addenda). If Darkroom is already open from the desktop shortcut, run the test stack beside it on
  another port with its own library: `DR_SERVER_PORT=5179 DR_DATA_DIR=data/e2e npm run dev`, then `npx playwright test`.
- `docs/QA_REPORT.md`: every feature run on the golden test pictures (`tests/golden/`), with grids, timings, peak memory,
  a model-switching stress test and the remaining known issues. Re-run with `npx tsx scripts/qa-phase6.ts features`.

## Known limitations

- **Licences:** Klein 9B and Qwen-Image 2.1 are non-commercial licences, which fits Darkroom's private, personal use.
  Wan 2.2, Qwen3-VL and Qwen-Image-Layered are Apache 2.0; SAM 3.1 is under the SAM License; LTX under its community licence.
- **Prompt templates, style text, camera chips and VLM system prompts** are plain JSON in `presets\` and can be edited
  freely; the app validates `prompts.json` on load and reports a broken edit instead of sending a bad prompt.
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
