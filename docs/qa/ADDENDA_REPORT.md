# Addenda QA report — Klein 9B vs Qwen-Image 2.1, per feature

Addendum 1 (One Node patterns) and Addendum 2 (Qwen-Image 2.1 parity), 2026-09-30. Every comparison ran on the
golden set (`tests/golden/`) with fixed seeds through the real workflows (`scripts/ab-addenda.ts`); grids and
`runs.json` (timings, peak VRAM, settings, text outputs) are in `docs/qa/addenda/<phase>/`. 24 GiB card,
ComfyUI 0.38.0. The reasoning behind each choice is in DECISIONS 62–75.

## Recommended model per feature

| Feature | Klein 9B | Qwen-Image 2.1 | Recommended | Evidence |
|---|---|---|---|---|
| Text to image | 7.5–8 s at 1 MP (One Node sampler) | Draft 16 s (25 steps) · Native 2K 160 s (40 steps) | **Klein** to iterate, **Qwen Native 2K** for finals, crowds and long text | p1, D62, D65 |
| Generate with references | 21 s (2–3 refs) | Draft / 2K, identity held with 1–3 refs, up to 24.8 GB | **Qwen** for identity; Klein for speed | p1, D63, D65 |
| Instruction edit | fast, strong changes | faithful, precise text | **Qwen** (default), Klein for bold changes | p6, D72 |
| Enhance (Restore) | restores blur and low-res | restores, most natural colours and faces | **Qwen** | p2, D66 |
| Inpaint (crop and stitch) | every case incl. small masks and text, 6–9 s | mask shown as `<image2>`: 6/6 | **Either**: Klein for speed, Qwen for replacements | p3, D67 |
| Circle quick edit | failed (kept or ghosted the object) | 5/5, no circle left | **Qwen only** | p3c, D73 |
| Outpaint | canvas prep + crop and stitch, seamless | own route, exact, ~27 s | **Either**; three rounds seamless on both | p4, p4r, D68 |
| Upscale | — (SeedVR2, model-independent) | — | SeedVR2, 2–8×, alpha kept | p5, D69 |
| Remove background | — | native extraction, real alpha, best glass and hair (~25 s) | **BiRefNet** (1 s) by default, **Qwen** for "Best quality" | p5, D70 |
| Layers | — | per-object extraction, full resolution | **Qwen 2.1 objects**; Layered only as "Automatic" | p5, D70 |
| Presets: Angles | good | better wide-angle | **Qwen** | p6, D72 |
| Presets: Relight | more dramatic | more faithful to the face | **Klein** for mood, **Qwen** for portraits | p6, D72 |
| Presets: Styles | restyles decisively | too timid on 3D, embroidery, claymation, low-poly, pixel | **Klein** (the picker says so) | p6, p6b, D75 |
| Presets: Text edit | exact | exact | **Either** | p6 |
| Presets: Try-on | good | better fit and details | **Qwen** | p6, D75 |
| Presets: Texture transfer | applies the texture | copies the reference's subject | **Klein** | p6, p6b, D75 |
| Prompt Enhance (Generate) | Qwen3-VL 8B rewrite, ~2 s | official PE-T2I + aspect ratio, ~22 s | each model's own rewriter | p7, D74 |
| Enhance instruction (Edit) | Qwen3-VL 8B, revised prompt, ~2 s | official PE-I2I, ~5 s (reasoning stripped) | each model's own rewriter | p7, p7b, D74 |
| Captions / reverse prompts | — | — | **Qwen3-VL 8B** (vs PE-I2I, Qwen3.5 4B) | p7, D74 |

## Decisions that removed options

- **Klein KV model**: bf16 18 GB overflowed the card (168 s vs 21 s) with no quality gain — not offered (D63).
- **Qwen Fun ControlNet inpaint**: recolours instead of replacing — kept in `workflows/experiments/` (D67).
- **Qwen via the shared outpaint canvas**: paints the marked area white — Qwen keeps its own route (D68).
- **Qwen3.5 as the general VLM**: invents places and signs; PE-I2I ignores length and can degenerate — no download (D74).
- **Head swap preset**: left out (JP's decision).

## Test status

- Unit tests: 269 passing (`npx vitest run`).
- e2e (Edge against the real ComfyUI 0.38.0): 25/25 passing in 7.3 min — 7 v1 flows plus 18 for v2 and the addenda (crop-and-stitch inpaint and outpaint on both models, circle quick edit, Qwen BG removal with real alpha, Qwen 2.1 layers, upscale panel, Enhance modes, presets, Use as…, Restore).
