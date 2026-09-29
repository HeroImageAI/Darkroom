# Darkroom expansion — phased plan

Status: **awaiting approval.** Nothing has been implemented. Based on [AUDIT.md](AUDIT.md) and
[PROMPT_AUDIT.md](PROMPT_AUDIT.md). Every model/node below was checked against the installed ComfyUI 0.37.4
(`/object_info`, source under `comfy/`, shipped templates) and the model's Hugging Face repo on 2026-09-29.

## Decisions I need from you (everything else I'll decide and log in DECISIONS.md)

1. **VLM choice for Phase 2.** (a) **Qwen3.5-9B bf16** (19.3 GB download, Apache-2.0) as you asked, or (b) the
   **Qwen3-VL-8B int8 that is already installed** (it is Qwen-Image 2.1's text encoder; I verified the file contains the
   language-model head and vision tower, so `TextGenerate` should be able to use it — zero download, and it is already in
   VRAM whenever you use Qwen-Image). My proposal: download Qwen3.5-9B, benchmark both in a Phase 2 spike, make the better
   one the default and keep the other selectable.
2. **Downloads** (all to `E:\Comfy-Desktop\ComfyUI-Shared\models`, 1.1 TB free): Qwen3.5-9B bf16 19.3 GB, SAM 3.1
   1.75 GB, Qwen-Image-Layered fp8mixed 20.5 GB + VAE 0.25 GB. Total ≈ 42 GB.
3. **npm packages**: `ag-psd` (MIT, PSD writer) and `fflate` (MIT, ZIP) in Darkroom only.
4. **Licences**: both image models are non-commercial (AUDIT §7). No action needed from me — just making sure you know.

## Working rules

- **Phase 0:** `git init` in `E:\Darkroom`, `.gitignore` (node_modules, dist, data, logs, bench, proof artifacts), baseline
  commit tagged `v1.0-baseline`. Each phase is a branch `phase-N-name`, merged only when its checks pass.
- **No regressions:** the existing 77 unit tests + 7 e2e tests must stay green at the end of every phase; new features add
  their own tests.
- **Versioned workflows:** new or changed graphs are written as `workflows/<name>.v2.json` etc.; `manifest.json` points at
  the version in use; old versions stay on disk.
- **VRAM:** one large family resident at a time. New family keys: `vlm`, `sam`, `layered`. `JobManager` frees on every
  family change (already), and — new — verifies free VRAM before any job whose family needs > 12 GB, polling `/system_stats`
  for up to 10 s after `/free`. `util` stays exempt.
- **Report after each phase** in PROGRESS.md: what changed, how tested (commands + proof images), known limits.

---

## Phase 1 — Prompt system rewrite (from PROMPT_AUDIT)

Scope: implement PROMPT_AUDIT rows P1–P13.
- New `src/shared/prompts.ts` (`composePrompt`, `composeMotion`, caption resolver) + `presets/prompts.json` (per-model
  templates, editable) + `presets/styles.json` v2 (per-model style text) + `presets/camera.json` v2 (wan/ltx phrases).
- Remove inert negatives from Wan/LTX graphs → `wan22_i2v.v2.json`, `ltx25_i2v.v2.json`.
- UI: Klein guidance slider removed; Qwen "Quality" (Standard 25 steps ~1.8 MP / High 40 steps card resolutions);
  model-aware reference chips; motion hint text; Qwen outpaint/inpaint use the fixed templates (fixes AUDIT §8.1).
- Optional Qwen "transparent background" toggle (P13) — only if a test shows the alpha survives to the PNG.
**Tests:** unit tests for routing (no cross-model tokens, every (model,mode) covered, captions never from instructions);
fixed-seed A/B grids old vs new (PROMPT_AUDIT §D). **Risk:** rewrites that don't win the A/B are reverted and recorded.

## Phase 2 — Qwen3.5 vision-language model

| Item | Verified |
|---|---|
| Node | Core `TextGenerate` (inputs: clip, prompt, image, video, thinking, max_length, sampling on/off with temperature/top_k/top_p/min_p/repetition_penalty/seed). **No custom node pack needed.** |
| Model support | `comfy/text_encoders/qwen35.py` defines qwen35 0.8B/2B/4B/9B/27B incl. vision tower; loader `CLIPLoader` (template uses type `stable_diffusion`; auto-detected). Official template `llm_qwen3_5_text_gen.json` (PR #12771). |
| Files | `Comfy-Org/Qwen3.5/text_encoders/qwen3.5_9b_bf16.safetensors` 19.31 GB (also 4b 9.32 GB, 2b 4.55 GB) → `models/text_encoders/`. No fp8/GGUF variant is published for ComfyUI core. |
| VRAM | 9B bf16 ≈ 19.3 GB weights → fits alone on 24 GB; dynamic VRAM streams if needed. 4B ≈ 9.3 GB. **Throughput on the 3090 not yet measured.** |
| Licence | Apache-2.0 |
| Sampling | Qwen3.5 card, non-thinking general: temperature 0.7, top_p 0.8, top_k 20, presence_penalty 1.5; `thinking=false` (the model thinks by default). |

Build:
- `workflows/vlm_caption.json`, `vlm_text.json` (TextGenerate with/without image); family `vlm`; `/free` after use when the
  next job is a diffusion family (auto-unload).
- `presets/vlm_prompts.json` — one editable file with the system prompts: caption (short / detailed / Klein-style),
  reverse prompt (Klein / Qwen variants built from PROMPT_AUDIT §A rules), enhance (Klein / Qwen), and video motion
  (Wan empty-prompt rule from the official Wan system prompt; LTX paragraph rule).
- Server: `POST /api/vlm/{caption,reverse,enhance}` → queues the graph, returns text (ComfyUI returns STRING via
  `PreviewAny`/history).
- UI: Generate prompt box gets Enhance (real now) with result shown inline for editing + Undo; image context menu
  (Library/Edit) → Caption / Reverse prompt (pick Klein or Qwen); Video "Suggest motion".
**Spike first (½ day):** load Qwen3.5-9B and the installed Qwen3-VL-8B through TextGenerate, measure tokens/s, VRAM and
caption quality on the golden set → pick default. **Unverified until the spike:** 9B speed on the 3090; TextGenerate
compatibility with the int8-convrot Qwen3-VL file.

## Phase 3 — Enhance Image

- Entry points: any image (upload/paste, Library, screen capture) → "Enhance" (Edit mode + Library action).
- Pipeline: VLM caption → `composePrompt(model, 'enhance', caption)` → low-denoise pass → new version (full-res composite not
  needed; whole image changes).
  - Klein: `klein_enhance.json` — source as `ReferenceLatent` + encoded source latent, `Flux2Scheduler` →
    `SplitSigmasDenoise` (verified in 0.37.4) for partial denoise.
  - Qwen: `qwen_enhance.json` — 2.1 edit graph with KSampler `denoise` < 1 and the source as `<image1>`.
  - Upscale + enhance: enhance at ~1 MP, then existing SeedVR2 2× (order to be A/B-tested against SeedVR2-first).
- Modes: Subtle / Strong / Upscale + enhance. Starting defaults (to be tuned on the golden set, values + reasoning recorded
  in DECISIONS): Klein subtle 0.30, strong 0.60; Qwen subtle 0.35, strong 0.65. Preservation of composition/identity/text
  is part of the enhance template ("keep all text, faces and layout identical"). Denoise/strength only under Advanced.
**Tests:** golden set × 2 models × 3 modes, identity/text checks by eye, SSIM vs source reported.

## Phase 4 — Segmentation, background removal, layers

| Item | Verified |
|---|---|
| SAM 3.1 | Core nodes `SAM3_Detect` (text via `CLIPTextEncode` from the SAM checkpoint's CLIP, `positive_coords`/`negative_coords` JSON points, `bboxes`, threshold, `individual_masks`), `SAM3_TrackToMask`. Template `utility_image_segment_sam3.json`: text prompt max 32 tokens, `label:N` for counts. File `Comfy-Org/sam3.1/checkpoints/sam3.1_multiplex_fp16.safetensors` 1.75 GB → `models/checkpoints/`, loaded with `CheckpointLoaderSimple`. Licence: SAM License (Meta) — royalty-free incl. commercial, with trade-control/ITAR clauses; original `facebook/sam3.1` is gated, the Comfy-Org repack is not. VRAM small (~2–4 GB, to be measured). |
| Qwen-Image-Layered | Core `EmptyQwenImageLayeredLatentImage` + `LatentCutToBatch`/`LatentCut`; template `image_qwen_image_layered.json` (640 px recommended, 20 steps, CFG 2.5; original pipeline 50 steps CFG 4, "slow"). Files `Comfy-Org/Qwen-Image-Layered_ComfyUI`: `qwen_image_layered_fp8mixed` 20.53 GB (bf16 40.86 GB won't fit) + `qwen_image_layered_vae` 0.25 GB; TE `qwen_2.5_vl_7b_fp8_scaled` **already installed**. Licence Apache-2.0. VRAM ≈ 20.5 GB + streamed TE → must run alone; **runtime not yet measured** (expect minutes at 640 px). Based on the original Qwen-Image, not 2.1. |
| Matting | No matting node in core. Plan: SAM gives *which* subject, BiRefNet (installed, core `RemoveBackground`) gives the soft alpha; alpha = BiRefNet alpha × dilated SAM mask. Compare BiRefNet alone, `lucida.safetensors` (installed, also offered by the core loader; **provenance unverified**), and the combination on the hair/fur and transparent-object images. |
| PSD / ZIP | Core has a `LAYERS` type (`AddLayer`, `LayersFromBoundingBoxes`, `ImageCompositor`) but no PSD writer. Export is done in Darkroom: `ag-psd` (MIT) for a layered PSD, `fflate` (MIT) for ZIP of PNGs. Plan to ship **both**. |

Build:
- **Segment tool** in Edit (Smart select becomes real): click = positive point, Alt-click = negative, drag = box, text field
  ("the car", "person:2"); results arrive as a mask on the existing mask layer (add / subtract / replace), so every
  existing mode (Instruct, Inpaint…) can use it. Workflow `sam_segment.json` (family `sam`).
- **Remove BG v2** (`remove_bg.v2.json`): SAM subject + BiRefNet alpha (+ optional edge erode/feather); optional
  "Clean edges" (Qwen 2.1 edit on the RGB to fix halos, alpha re-applied) and "Background plate" (Qwen inpaint of the dilated
  subject mask using the fixed inpaint template). Output always a real RGBA PNG from `JoinImageWithAlpha`, never from Qwen.
- **Layers**: Mode A (SAM): per-object RGBA layers from `individual_masks` + background plate via Qwen inpaint of the union
  mask. Mode B (Qwen-Image-Layered): N RGBA layers (default 4) at 640 px, optional 1024. Layers panel (visibility,
  reorder, rename), export PSD + ZIP; layers stored as library items grouped by a new `group_id` column (schema migration,
  additive).
**Tests:** golden set: segmentation by text and clicks, alpha checks on hair/fur/glass, layer export opens in
Photoshop/Affinity (you have Affinity installed; I'll verify with its reader where possible, else `ag-psd` round-trip).

## Phase 5 — UI

- **Compare:** replace the slider with hover-follow split (clip-path on a single composited layer, `requestAnimationFrame`,
  no React re-render per mouse move) + hold **Space** to show the original. Both images drawn in the same transformed
  container so it stays aligned at any zoom/pan; different resolutions are scaled to the after-image box
  (`object-fit: fill` on a shared box sized to the after image, before image letterboxed if aspect differs, with a note).
- **Video frames** (much of this exists): Start/End slots with drop highlight and library drag already work. Add a
  "Choose from library" picker dialog, swap start/end, per-slot clear (exists), aspect check vs the planned video size with
  **Crop to fill** (current behaviour, `ImageScale crop=center`) or **Fit with bars** (new `ImageScale` + pad) — new
  `wan22_i2v.v2`/`ltx25_i2v.v2` param. End-frame support: **both models verified** (Wan via
  `WanFirstLastFrameToVideo`, LTX via `LTXVAddGuide frame_idx=-1`, tested in BENCHMARKS), so the slot stays enabled;
  the tooltip mechanism remains for future models.
**Tests:** Playwright: hover positions, Space toggle, zoomed compare screenshot diff; drag/drop, picker, swap, mismatch
dialog.

## Phase 6 — QA and quality review

- `tests/golden/` (8–10 images): portrait, product shot, scene with text, busy street aerial ("Google Earth-style"),
  fine hair, fur, transparent object (glass), low-res image, plus 1–2 spares. **Source:** I'll generate synthetic ones with
  the two models (licence-safe for testing, no real people); if you want real photos — especially your own Google Earth
  capture — drop them in `tests/golden/incoming/` and I'll use those instead.
- Run every feature on both models where applicable with fixed seeds via the CLI runner; before/after grids old vs new
  prompts; timings and peak VRAM per workflow → `docs/QA_REPORT.md`.
- **Swap-stress test:** scripted rapid sequence (Klein → Qwen → VLM → SAM → Layered → Wan → LTX → Klein …, 3 rounds) with
  VRAM sampling; pass = zero OOM and no job slower than 2× its benchmark.
- Ranked list of remaining quality issues and next steps.

## Effort and order

| Phase | Rough effort | Downloads |
|---|---|---|
| 0 Git baseline | minutes | — |
| 1 Prompts | ~½–1 day incl. A/B renders | — |
| 2 VLM | ~1 day incl. spike | 19.3 GB |
| 3 Enhance | ~½–1 day | — |
| 4 Segment / BG / Layers | ~2 days | 22.5 GB |
| 5 UI | ~½–1 day | — |
| 6 QA | ~1 day (mostly rendering) | — |

## Things I could not verify yet (will be settled in the named phase, not assumed)

1. Qwen3.5-9B generation speed/quality on the 3090 through `TextGenerate` (Phase 2 spike).
2. That `TextGenerate` runs the installed int8-convrot Qwen3-VL-8B (file has lm_head + vision; runtime untested) (Phase 2).
3. Whether Qwen-Image-Edit's official edit/inpaint/outpaint templates improve Qwen-Image **2.1** results (Phase 1 A/B).
4. Qwen 2.1 RGBA output surviving to a PNG with alpha (Phase 1 test before exposing the toggle).
5. SAM 3.1 checkpoint loading and VRAM in 0.37.4 (template says it works; not yet run here) (Phase 4).
6. Qwen-Image-Layered fp8mixed runtime/VRAM on 24 GB (Phase 4).
7. Provenance and quality of `lucida.safetensors` (Phase 4 comparison).
8. PSD compatibility of `ag-psd` output with your editor (Phase 4).
