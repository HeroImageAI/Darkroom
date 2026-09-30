# Addenda 1 + 2 — audit and plan (read-only; awaiting approval)

Written 2026-09-30 against Darkroom `main` @ `v2.0` + mask outline, ComfyUI **0.38.0** (Comfy Desktop auto-updated it),
and the One Node source `one-node-flux-2-klein-master (1).zip` (identical to the copy extracted on 14 Sep; SHA-256
`2CE1FCA4…`). Nothing has been changed yet.

Legend: **Exists** = Darkroom already does it · **Partial** = exists, addendum changes it · **New** · **Conflict** =
the addendum disagrees with the source code or with measured results · **Unverified** = claim not yet confirmed.

## 1. What is installed (verified)

| Item | Status |
|---|---|
| `FluxKVCache`, `SeedVR2Preprocess/Conditioning/PostProcessing`, `TextEncodeQwenImage21`, `QwenImage21Cache`, `QwenImageDiffsynthControlnet`, `ModelPatchLoader`, `InpaintModelConditioning` | core nodes in 0.38.0 |
| `InpaintCropImproved` / `InpaintStitchImproved` | **missing** — custom node pack `ComfyUI-Inpaint-CropAndStitch` (Darkroom has used no custom nodes so far) |
| `flux-2-klein-9b-kv.safetensors` (KV variant) | installed |
| Klein **base** model | **not installed** — base-model rules (20 steps, CFG 5, real negatives) can be coded but not tested |
| Qwen-Image-2.1 PE-T2I / PE-I2I rewriters, a general Qwen3.5-VL | **not installed** |
| Any Qwen-Image-2.1 ControlNet / model patch | **not installed** (only a Z-Image Fun ControlNet) |
| Faceswap LoRA (needed by One Node's "Head swap") | **not installed** |
| Free disk on E: | 1.1 TB |

## 2. Findings that change the brief

1. **One Node's near-black re-detection is unsafe as written.** It masks *every* pixel with R, G and B < 18 anywhere in
   the original (`web/one_node_flux_2_klein.js` ~line 5991), so a night scene, black clothing or deep shadow would be
   regenerated on the next outpaint round. Darkroom knows from lineage exactly which areas earlier rounds padded, so it
   will use that; the colour heuristic becomes a fallback limited to dark regions **connected to the image border**.
2. **Two feather rules exist in the source.** The pad-prep path uses `min(48, short/6)` (matches the addendum); the
   mask-editor path uses `min(128, short/4)` and routes outpaint through the *inpaint* crop-and-stitch graph. I'll
   implement the addendum's rule and A/B the other.
3. **Several One Node presets break the addendum's own preset rules**: "8k" (Portrait style, Sketch to photo),
   "hyper-realistic", "Octane Render", lower-case non-imperative relights ("relight with…"), styles without a
   preservation clause. They will be imported **cleaned** (rules applied), source credited, originals kept in a comment.
4. **Qwen 2.1 in ComfyUI has no mask input.** `TextEncodeQwenImage21` takes up to 16 reference images (`image_1…16`)
   and keeps alpha (VAE sees RGBA; the vision tower sees it over white). The official repo says masked edits use a
   *separate mask*; in ComfyUI that means passing the mask as an extra reference image and naming it in the prompt.
   Darkroom's current Qwen edit already guarantees 0 px changed outside the mask by compositing.
5. **"Qwen-Image 2.1 Fun ControlNet Union" is Unverified.** The official repo does not mention one. The only core node
   that could run a masked Qwen ControlNet is `QwenImageDiffsynthControlnet`, which needs a 2.1-compatible patch file.
   If none exists I'll report that and skip option C-2.
6. **Darkroom's Qwen sizes are Qwen-Image v1 sizes** (1328², 1664×928, 1584×1056). Qwen 2.1 is native 2K at multiples
   of 32 (2048², 2400×1792, 2528×1696, 2752×1536 + portraits — verified in the official repo). Draft/Native-2K tiers fix this.
7. **Official Qwen 2.1 default is 40 steps** (verified); Darkroom uses 25. A/B planned.
8. **Qwen reference naming is Unverified.** Darkroom writes `<image1>`; the addendum says "image 1". The PE's
   `ratio_follow` output uses `<image1>`. Both will be A/B'd.
9. **Qwen native alpha is already in Darkroom** (DECISIONS 46, verified real alpha). What's missing is Qwen as a
   *cutout* engine (DECISIONS 51 limited Qwen to the background plate, per the original brief) and an end-to-end alpha
   audit: thumbnails, compare, SeedVR2 (its preprocess **drops** alpha — needs `JoinImageWithAlpha` like One Node), export.
10. **SeedVR2 upscale already matches One Node's graph** except LAB vs wavelet colour correction, alpha, 6×/8×, tile size
    setting and the pre-shrink option.
11. **BiRefNet one-click already exists** (Remove BG v1) and was benchmarked against SAM + matting in Phase 6.
12. **The Qwen3.5 routing conflicts with your earlier decision** to use the installed Qwen3-VL 8B instead of a Qwen3.5
    download. Addendum 2 needs three ~9B models (PE-T2I, PE-I2I, a general Qwen3.5-VL) plus, per the addendum, a custom
    node (`ComfyUI-Qwen-Image-2.1-Prompt-Enhancer`, Unverified).

## 3. Item-by-item status

### Addendum 1 (Klein)
| | Item | Status | Plan |
|---|---|---|---|
| A | er_sde / simple / AuraFlow shift 3 | Partial (Darkroom: Flux2Scheduler + euler) | A/B on golden set; adopt only if ≥ |
| A | Base-model detection (20 steps, CFG 5, negatives) | New | code + unit test; untestable live (no base model) |
| A | CFG 1 → ConditioningZeroOut | Exists | — |
| A | KV variant toggle | New | toggle for reference-heavy modes; A/B speed + quality |
| B | Enhance as edit (ReferenceLatent + empty latent, denoise 1, One Node prompt + "Scene:" line) | Partial (Darkroom: img2img + SeedVR2 pre-upscale) | A/B edit-style vs current, ± scene line, incl. the 320 px case |
| B | lanczos reference downscale | Exists | — |
| C | Crop-and-stitch inpaint + KV + reference slot + stale-ref fallback | New (needs custom node) | build `klein_inpaint.v2`; keep v1 as fallback |
| C | Seam feather / Change strength sliders | New | Edit UI |
| C | SAM mask → inpaint | Exists | — |
| D | Canvas prep (black pad, gradient into original, re-detection, letterbox, denoise locked 1.0) | Partial | server-side prep; lineage-based re-detection (finding 1) |
| D | Crop-and-stitch vs full-canvas outpaint report | New | QA |
| E | SeedVR2 wavelet, alpha, 6×/8×, pre-shrink, tile setting, one-click everywhere | Partial | extend `upscale` v2; VRAM check at 6×/8× |
| F | Presets import + rules + read-only built-ins + user file deep-merge | New | `presets/edit_presets.json` + `data/user_presets.json`; `[BRACKET]` slot selection in UI |
| G | BiRefNet one-click | Exists | — |
| H | PNG tEXt metadata | Exists | add JSON sidecar fallback |
| H | Restore settings / right-click "Use as…" / Ctrl+V first empty slot | Partial | verify existing Reuse, add context menu |

### Addendum 2 (Qwen parity)
| | Item | Status | Plan |
|---|---|---|---|
| — | Qwen native extraction vs SAM + matting vs BiRefNet (hair, fur, glass) | New | benchmark, pick default |
| — | Qwen transparent-layer editing vs Qwen-Image-Layered | New | benchmark; report whether Layered is still needed |
| — | Alpha through library, thumbnails, compare, SeedVR2, export | Partial | audit + fix each (finding 9) |
| A | 25 vs 40 steps; Draft (~1–1.3 MP) and Native 2K tiers; peak VRAM incl. multi-reference | Partial | A/B + measure |
| B | Qwen Enhance via `image_1` + preservation clause (adapted, A/B'd) | Partial | `qwen_enhance.v2` |
| B | PE-I2I/T2I rewriters with `wh_ratio` / `ratio_follow`, editable result | New (downloads) | needs your decision |
| C | Native masked edit + crop-and-stitch; ControlNet option; circle-annotation quick edit; ref as image_2; denoise < 1 | Partial | finding 4 and 5 |
| D | Qwen outpaint with shared prep (×32) vs native aspect change | Partial | A/B, pick default |
| E–H | Model stored in presets + metadata; Restore loads the right pipeline | Partial | — |
| F | Qwen version of every preset; RGBA wrapper; "image N" refs (up to 10); quoted text | Partial | with F above |
| — | Qwen3.5 routing, one ~9 GB rewriter loaded at a time, unloaded before diffusion | Conflict (finding 12) | needs your decision |
| QA | Every test on both models, Klein-vs-Qwen report with a recommended default per feature | New | extends `qa-phase6.ts` |

## 4. Decisions (JP, 2026-09-30)

- **Crop-and-stitch: core nodes only.** Darkroom computes the crop box itself (mask bbox × 1.5, rounded up to 64,
  clamped 512–1536, context-aware) and stitches back with core nodes; no custom node pack is installed. A/B against
  One Node's output where possible.
- **Full Qwen3.5 routing.** Download Qwen-Image-2.1 PE-T2I, PE-I2I and a general Qwen3.5-VL (~9B each). The general
  model replaces Qwen3-VL 8B for captions, reverse prompts and Klein prompts. Prefer running them through core
  `TextGenerate` if it supports them (consistent with "no custom nodes"); only one is loaded at a time and it is freed
  before diffusion.
- **Head swap preset: skipped** (needs a third-party Faceswap LoRA).
- **General Qwen3.5 model: A/B first.** Comfy-Org only ships Qwen3.5 9B as bf16 (19.3 GB, not ~9 GB). Captions and
  Klein prompts will be compared on PE-I2I (a Qwen3.5-VL 9B fine-tune), the current Qwen3-VL 8B and Qwen3.5 4B
  (9.3 GB) before any general model is downloaded.

## 4b. Phase 0 verification results (2026-09-30)

| Claim | Result | Source |
|---|---|---|
| Qwen 2.1 Fun ControlNet Union exists | **Yes**: `model_patches/qwen_image_2.1_fun_controlnet_union_{bf16,int8_convrot}` (7.55 / 3.78 GB); runs on core `ModelPatchLoader` + `QwenImageDiffsynthControlnet` (has a mask input) | HF Comfy-Org/Qwen-Image-2.1 |
| PE rewriters | `qwen3.5_9b_qwen_image_2.1_pe_{t2i,i2i}.int8_convrot` (9.47 GB each), "to be used with the TextGenerate node": **no custom node needed**. The official system prompts ship inside the ComfyUI templates. | HF page + templates |
| Reference naming | **`<image1>` … `<image10>`** (image_1 = edit target). Darkroom's `<image{n}>` is correct; the addendum's "image 1" is not the Qwen convention. | `image_qwen_image_2_1_image_edit.json` usage note |
| Steps | Official pipeline "about 40–50 with euler"; the template starts at 25 | same |
| CFG / negative | "cfg: keep 1 … negative_prompt: unused while cfg is 1" | same |
| Native background removal | an edit with the prompt "Remove the background, and output a PNG image" | `image_qwen_image_2_1_background_removal.json` |
| Size | resolution is a pixel budget, multiples of 32, output follows image_1, up to 2048 | template notes |
| General Qwen3.5 | Comfy-Org/Qwen3.5 ships 2B / 4B / 9B **bf16 only** (4.5 / 9.3 / 19.3 GB) | HF API |

## 5. Phases (one branch and commit each, report after each, no regressions)

0. **Verify** the Unverified items once web access works (mask format, "image N" wording, ControlNet, PE node, template
   step counts); install what you approve; back up the Desktop `custom_nodes` state first.
1. **Sampling defaults**: Klein er_sde/shift A/B, KV toggle, base detection; Qwen 25 vs 40, Draft / Native 2K tiers, VRAM.
2. **Enhance v2** on both models (edit-style vs current).
3. **Inpaint v2** (crop-and-stitch) on both models + sliders + reference slot + circle quick edit.
4. **Outpaint v2** on both models (lineage-aware prep).
5. **Upscale v2** + end-to-end alpha + Qwen extraction / layer benchmarks.
6. **Presets** (import, clean, Qwen versions, user file) + metadata / Use-as / Restore.
7. **Prompt routing** (PE rewriters / Qwen3.5) if approved.
8. **QA**: golden set, both models, fixed seeds, Klein-vs-Qwen report with per-feature defaults.
