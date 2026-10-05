# Decisions

Each choice made while building Darkroom, and why. Newest decisions are appended at the bottom.

## Environment

1. **Target the new Comfy Desktop (v1.1.3), not the layout in the brief.** The machine runs the "installations"-based
   Comfy Desktop. ComfyUI lives at `E:\ComfyUI\Desktop ComfyUI\ComfyUI\ComfyUI`, settings in `%APPDATA%\Comfy Desktop\`,
   and the default models folder is `E:\Comfy-Desktop\ComfyUI-Shared\models`. All paths are in `config.json`/`.env`.
2. **Port is discovered, never hard-coded.** Desktop defaults to 8188 and moves to the next free port on conflict. Darkroom
   probes the ports listed in `config.json` and only accepts the server whose `/system_stats` argv contains
   `instance-model-paths` (Desktop-launched). That avoids talking to other ComfyUI servers on this machine (e.g. Forma's).
3. **No custom nodes installed.** ComfyUI 0.37.4 has native nodes for everything: Klein (`ReferenceLatent`,
   `Flux2Scheduler`), Qwen-Image 2.1, Qwen-Image-Edit-Plus, Wan 2.2, LTX-2.5, SeedVR2, BiRefNet (`RemoveBackground`),
   RIFE/FILM (`FrameInterpolate`) and MP4 (`SaveVideo`). Fewer packs means nothing to break on a Desktop update, and no
   Python packages were added to the `.venv`.
4. **New models go to `E:\Comfy-Desktop\ComfyUI-Shared\models`.** It is Desktop's registered default folder, so no model
   YAML needed editing, and E: has 1.2 TB free.
5. **Desktop auto-launch is left to the user.** Changing `autoLaunchOnStartup` in Desktop's settings was blocked by
   this session's sandbox as a persistence change. `start-darkroom.bat` opens Desktop and waits; if Desktop shows its
   dashboard, one click on the "ComfyUI" install starts the server. README explains the one-time setting that removes
   that click.

## Models and precision (RTX 3090, 24 GB)

6. **Klein 9B: `flux-2-klein-9b-fp8mixed` (9 GB) + `qwen_3_8b_fp8mixed` text encoder.** It was already installed, so
   it is ~2× smaller than bf16 and fits with room for batch ×4. It's the distilled model (4 steps, CFG 1, euler), per the
   official template. The bf16 KV variant (17 GB) was not used: the speed-up only matters for multi-reference edits, and
   bf16 + 8 GB encoder crowds 24 GB.
7. **Qwen-Image 2.1: `int8_convrot` weights and text encoder (already present).** 25 steps, CFG 1, euler/simple (template
   default; the official 40–50 steps is available under Advanced). Native sizes around 1.76 MP (e.g. 1328², 1664×928).
8. **Qwen-Image-Edit-2511 FP8 + Lightning 4-step LoRA** for Instruct mode, as the brief asks. It runs at ~45 s because
   19.5 GB of weights plus the 7B encoder exceed 24 GB and are partly offloaded. Note: Qwen-Image 2.1 can also edit
   natively and would be faster; it is a candidate if speed matters more than 2511's edit consistency.
9. **Inpaint and outpaint use Klein 9B, not Qwen-Edit.** Klein is ~3× faster (15 s vs 45 s) and is usually already loaded
   from Generate, so no model swap is needed. It fills masked latents while seeing the whole picture as a `ReferenceLatent`,
   which gives coherent fills (see the bench/inpaint and proof screenshots). The result is composited back at the
   source's full resolution, so pixels outside the mask are bit-exact.
10. **Masks are uploaded as a plain black/white PNG (`/upload/image`) and read with `LoadImageMask` (red channel).**
    `/upload/mask` merges the mask into the original's alpha and needs `original_ref`. A standalone mask is simpler, works
    for any source (library item, upload), and is easy to inspect.
11. **Upscale = SeedVR2 7B "sharp" int8 (already installed) with its EMA VAE, 1 step, LAB colour match.** Real 2× detail
    in ~18 s at 1 MP → 2 MP.
12. **Background removal = core `RemoveBackground` + BiRefNet**, which was already installed. The output is an RGBA PNG.
13. **Wan 2.2 I2V A14B fp8_scaled (high + low noise experts) + lightx2v 4-step LoRAs, shift 5, 2+2 steps.** This is the
    official template's fast path. It fits a 3090 with ComfyUI's dynamic VRAM, so no GGUF or block-swap node is needed.
    It uses `WanFirstLastFrameToVideo`, so one graph covers start-only and start+end. 16 fps, frame counts 4n+1.
14. **LTX-2.5: 22B distilled `comfy-int8-convrot` + Gemma-4 12B int8 encoder**, from the gated Lightricks repo (the
    cached HF token already had access). NVFP4 needs Blackwell; bf16 is 42 GB. 24 fps, frame counts 8n+1.
15. **Frame interpolation = RIFE 4.26** (23 MB, core node). It's fast and good for 2×; FILM was also downloaded.
16. **Tiled VAE decode (1024 px tiles, 128 overlap) for all image workflows.** A plain decode of a ×2 batch stalled for
    12 minutes when other apps held VRAM: the NVIDIA driver's "sysmem fallback" silently spilled to system RAM instead of
    raising OOM. Tiled decode bounds memory; no seams were visible in tests.
17. **Live previews use `latent2rgb`**, sent per prompt via `extra_data.preview_method`. It's cheap and needs no extra
    model, and it doesn't change ComfyUI's global setting.

## App

18. **Stack as proposed:** Vite + React + TypeScript (strict) UI and a Fastify server. **SQLite via Node 24's built-in
    `node:sqlite`**, which avoids native builds (better-sqlite3) on Windows. `sharp` makes thumbnails (prebuilt binaries).
19. **Jobs are owned by the server, not the page.** The server holds the ComfyUI WebSocket (its own client id), tracks
    every job in SQLite and ingests outputs into the library on success. Reloading the page, or closing it during a
    30-minute render, loses nothing; on reconnect the server reconciles with `/queue` and `/history`.
20. **Every output is a real ComfyUI output.** Imports, crops and saved video frames go through tiny workflows
    (`import.json`, `crop.json`, `video_frame.json`), so the Library only ever points at files ComfyUI wrote. Darkroom
    reads them via `/view`, never by guessing paths.
21. **Extend +5 s is chained on the server:** it renders the continuation from the last frame, then automatically
    queues `video_join.json`, which drops the duplicated first frame of clip B.
22. **Workflows are generated by `workflows/build_workflows.py`** (API format) rather than hand-exported, so model file
    names live in one place. The app only addresses nodes by `DR_*` title through `workflows/manifest.json`. Re-exported
    or hand-edited graphs work as long as the titles stay. Unit tests check every manifest title exists in every
    workflow.
23. **Optional inputs are handled by graph surgery, not placeholder images.** A missing optional image removes its
    loader, bypasses its `ReferenceLatent`/mask nodes (rewiring consumers), and prunes whatever no output needs.
24. **PNG metadata:** each job passes `extra_data.extra_pnginfo.darkroom` (workflow, mode, model, prompt, params,
    parent). ComfyUI writes it into the PNG next to the API `prompt`, so images are self-describing and can be dropped
    back into ComfyUI.
25. **"Open graph in ComfyUI"** downloads the exact API graph and opens ComfyUI in a new tab; you drop the file on the
    canvas. The ComfyUI frontend has no URL parameter for loading a graph, so a one-drop step is the most reliable
    method.
26. **Prompt "Enhance" is a stub** (`POST /api/enhance`) that returns the prompt unchanged and says so. It's one function
    to replace later.
27. **Fonts are bundled (@fontsource)**, so the UI looks right offline. Icons: lucide-react.
28. **Playwright drives the installed Microsoft Edge (`channel: 'msedge'`).** The Playwright Chromium download timed out
    while 78 GB of models were downloading, and Edge is the browser actually used on this machine.
29. **VRAM guard for video:** before queueing a video, Darkroom calls `/free` and checks free VRAM. Below the model's
    need, it shows a plain-language warning with "Queue anyway" instead of letting ComfyUI hit OOM. `/free` is applied
    by ComfyUI between prompts, so it never interrupts a running job.
30. **No design files were supplied** (confirmed with the user). The UI follows the written spec: tokens, fonts, and the
    380/112, 68/392, 380/300 and 5-col/420 layouts.
31. **LTX-2.5 graph = single stage at full resolution, derived from the official first/last-frame template** (8
    manual sigmas, euler-ancestral, guides at frame 0 and −1). It supports an optional end frame with the same graph.
    The official I2V template's two-stage path (half-res plus the ×2 latent upscaler) wasn't needed: single-stage 720p
    5 s already renders in ~105 s on the 3090. The upscaler file is downloaded in case you want to try it.
32. **Time estimates use `k·seconds^p`** fitted per model and quality (see BENCHMARKS.md). A linear fit under-estimated
    long clips, because attention cost grows faster than frame count.
33. **Video items get a "Reuse settings" action too** (found during the e2e run): it loads frames, motion prompt, model,
    length and quality back into the Video screen.
34. **Instruct edits now use Qwen-Image 2.1's native edit, not Qwen-Image-Edit-2511** (the user's choice, 2026-09-29).
    Graph from the official 2.1 edit template (`TextEncodeQwenImage21` + `QwenImage21Cache`, 25 steps, CFG 1). It is
    also faster: ~25 s vs ~45 s. The 2511 graph is kept as `qwen_edit_2511.json` and is not used by the UI.
35. **Masked Instruct edits leave every pixel outside the mask untouched.** The old graph composited at the model's
    resized working resolution, so the whole picture was resampled (the "slight changes" the user saw). Now the result is
    scaled back to the source size and composited onto the original pixels, and the sampler starts from the encoded
    picture rather than an empty canvas, so the masked area blends with its real surroundings. Verified: 0 of 690k pixels
    changed outside the (grown + feathered) mask.
36. **Darkroom uses exactly two image models: FLUX.2 Klein 9B and Qwen-Image 2.1** (user's choice, 2026-09-29). Edit has a
    model picker for Instruct, Inpaint and Outpaint (`manifest.edit` maps mode → model → workflow). Generate with references
    now uses the chosen model (`qwen_ref.json` uses Qwen 2.1's native multi-image input) instead of always Klein.
    Remove BG (BiRefNet) and Upscale (SeedVR2) are dedicated tools, not image models, so they have no picker.
    Qwen-Image-Edit-2511 is no longer used anywhere (`qwen_edit_2511.json` is kept, unreferenced).
37. **Qwen outpaint shows the model the original picture, not the grey-padded canvas.** An edit model copies what it is
    shown, so with the padded canvas it kept the grey borders.
38. **Mask edges are softened with a real blur (MaskToImage → ImageBlur → ImageToMask), not FeatherMask.** FeatherMask
    fades the mask toward the canvas border, which left a thin grey frame around outpainted pictures. Pixels further than
    grow + blur from the mask are bit-exact (verified); outpaint blends up to ~90 px into the original edge by design.

## v2 expansion (2026-09-29, approved plan in docs/PLAN.md)

39. **Git from here on.** `v1.0-baseline` tag, one branch per phase (`phase-1-prompts` … `phase-6-qa`), stacked.
40. **All prompt text is composed in one pure module** (`src/shared/prompts.ts`) from `presets/prompts.json`,
    `styles.json` and `camera.json`, keyed by model. Unit tests forbid Qwen-only wording (`<imageN>`, `Style:`,
    "Ultra HD", the official fill templates) in Klein prompts and vice versa. Rules and sources: docs/PROMPT_AUDIT.md.
41. **Styles are per-model sentences, not keyword suffixes.** Klein gets prose appended after the subject (FLUX.2:
    subject → action → style → context; no negations). Qwen gets a `Style:` description plus the official quality tail
    for photographic and cinematic looks.
42. **Qwen inpaint and outpaint use Qwen's official fixed templates** ("Perform inpainting on this image…", "Extend
    the image beyond its boundaries using outpainting…") with a caption of the original. The caption is never taken from
    an edit instruction (`captionFromLineage`). Without one, the local VLM describes the picture once and it is stored on
    the item. Fixes the v1 bug where Qwen outpaint sent raw text.
43. **Klein's instruct preservation clause doesn't mention lighting.** Caught in the dry run: "keep … lighting"
    contradicts relighting instructions ("make it night").
44. **Negative prompts removed from Wan and LTX** (`*.v2.json`). At CFG 1 ComfyUI skips the unconditional pass
    (`comfy/samplers.py:610`), and the LTX-2.5 card says the distilled model runs at CFG=1. v1 graphs are kept.
45. **Klein guidance is fixed at 1** (distilled); the UI shows it as fixed instead of a slider. Qwen gets a visible
    Quality choice: Standard (25 steps, ~1.8 MP) or High (40 steps, model-card ~4 MP sizes).
46. **Qwen "Transparent background"** uses the model card's RGBA wording. Verified: the saved PNG has a real alpha
    channel (44 % fully transparent pixels on the test sticker).
47. **VLM = the installed Qwen3-VL 8B int8** (user's choice), which is Qwen-Image 2.1's own text encoder. It has the
    LM head and vision tower (checked from the file header). It's loaded through core `TextGenerate` with the generic
    CLIP type, which makes ComfyUI build the plain Qwen3-VL chat model. No custom nodes and no download. Sampling follows
    the Qwen card's instruct defaults (T 0.7, top-p 0.8, top-k 20); thinking is off.
48. **VLM system prompts live in one file** (`presets/vlm_prompts.json`), adapted from the official Qwen-Image
    rewriters, Wan 2.2's I2V system prompts, the BFL FLUX.2 guide and the LTX guide. TextGenerate has no system slot, so
    instructions are prefixed to the user turn.
49. **VLM auto-unload:** after a text job, if nothing else is queued, Darkroom calls `/free` so the next image or video
    job gets the whole GPU. `vlm`, `sam` and `layered` are their own families, so the existing free-on-family-change
    applies to them too.
50. **Enhance = low-denoise re-render, never a new composition.** Klein: source as ReferenceLatent + source latent,
    `SplitSigmasDenoise` on a ~4/denoise-step schedule, so ~4 real steps run at any strength. Qwen: 2.1 edit conditioning,
    KSampler denoise < 1. The working size is the source clamped to 1–2 MP, so low-res inputs are upscaled into the model's
    range first. Upscale + enhance = subtle enhance, then SeedVR2 2× (a server chain).
51. **Background removal v2:** SAM 3.1 decides *which* object (text, optional); BiRefNet (or Lucida) supplies the soft
    alpha. Final alpha = matting alpha × feathered, dilated SAM mask. Output is always a real RGBA PNG from
    `JoinImageWithAlpha`; Qwen is only used for the optional *background plate* (official inpaint template on the dilated
    subject mask), never for the cutout itself.
52. **Layers:** Mode A = SAM `individual_masks` → one RGBA layer per object via a single `JoinImageWithAlpha` (it
    repeats the image to the mask batch), plus an optional Qwen background plate. Mode B = Qwen-Image-Layered fp8mixed
    (20.5 GB, official template settings: 640 px, 20 steps, CFG 2.5). Layers are library items sharing a `group_id`.
    Export offers **both** a layered PSD (`ag-psd`, MIT) and a ZIP of PNGs (`fflate`, MIT); the PSD writer is
    round-trip tested.
53. **Compare** follows the cursor using direct DOM writes in `requestAnimationFrame` (no React state per mouse move).
    Both images sit in the same transformed box, so they stay aligned at any zoom. A before image with a different aspect
    is letterboxed, not stretched. Hold Space to see the original.
54. **Video frame fitting:** "Crop to fill" is the graph's existing centred crop. "Fit with bars" letterboxes the frame
    on a canvas and uploads it at submit time, so no graph change was needed. Both Wan (`WanFirstLastFrameToVideo`) and
    LTX (`LTXVAddGuide` frame −1) support end frames, so the slot stays enabled.

### Phase 6 (QA on the golden set)

55. **Enhance pre-upscales small pictures.** QA showed Klein and Qwen img2img at enhance strengths keep the blur and JPEG
    blocking of a lanczos-enlarged source; even Strong (0.6 / 0.65) returned a soft enlargement of a 320 px JPEG. A source
    under half the working size is now upscaled with SeedVR2 first (2–4×, rounded up to a half step; `planEnhance`),
    and the enhance pass runs on that as a server chain. Edit follows the chain (`followOf`) to the final picture. The
    enhance denoise defaults stay (Klein 0.3 / 0.6, Qwen 0.35 / 0.65): on a clean input Subtle stays faithful and Strong
    is where invented detail starts (Klein Strong added a person at the frame edge of the low-res harbour).
56. **SAM 3 text finds every match.** The SAM 3 tokenizer keeps only the best detection per comma-separated category
    unless the text says `name:N`. Manifest string params can declare `samMaxPerCategory`: smart select 20, Remove BG
    subject 10, SAM layers 3 (each match becomes a layer). A count the user types (`car:2`) is kept.
57. **A single SAM click is sent twice.** With exactly one point SAM switches to multi-mask ambiguity mode and returns its
    most confident candidate, which QA showed can be empty or a sliver. Two identical points switch that off. One click
    can still legitimately select a part (the laces of a boot); the UI hint says to click two or three spots.
58. **VLM output hygiene.** Qwen3-VL overshoots word limits by about 30 %, so token caps were raised, an unfinished last
    sentence is dropped, and a stray closing quote is removed. The Klein-style caption/reverse prompts now forbid naming
    real places, brands or people not written in the image, and allow one lens/look mention (QA saw "Taipei's Raohe
    Street" and "50mm … 85mm f/1.4" in one caption).
59. **Qwen-Image-Layered always gets a caption.** With an empty prompt its layers came out as noise (a smeared fake
    background, a pink wash). With a one-sentence caption the same seed gives a clean inpainted background plate plus
    one layer per element. Edit now auto-captions (Qwen3-VL, saved to the item) when the picture has no lineage caption.
    The ComfyUI template settings (20 steps, CFG 2.5, about 115 s) match the reference pipeline's 50 steps / CFG 4
    (about 215 s) in quality, so they stay. Asking for more layers than the picture has elements yields a near-empty
    layer, which the Layers panel shows and the user can hide or delete.
60. **ComfyUI stall handling.** A Wan render once froze ComfyUI's HTTP server for over 8 minutes with VRAM full (the
    NVIDIA system-memory-fallback pattern). Discovery now allows 4 missed polls before calling ComfyUI offline (probe
    timeout 4 s), so heavy model loads no longer flip the app to "offline"; a job with no progress for 3 minutes shows
    a stall message suggesting a restart from Comfy Desktop. Harness scripts have per-run timeouts.
61. **Mask outline.** The amber mask tint disappeared on yellow/orange subjects (QA issue 6). The overlay canvas now gets
    a CSS SVG filter (`components/MaskOutline.tsx`): a white ring hugging the mask plus a dark ring outside it, so the edge
    reads on light and dark backgrounds alike. The filter works in the canvas's on-screen pixels, so the outline is the
    same thickness at every zoom; display only, the stored/exported mask is unchanged. Repaint cost measured in Edge
    while painting: 16.7 ms per frame with or without the outline, at fit, 288 % and 800 % zoom.

### Addenda 1+2 (One Node patterns, Qwen-Image 2.1 parity) — plan and decisions in docs/ADDENDA_PLAN.md

62. **Klein sampling = One Node's distilled defaults.** `ModelSamplingAuraFlow` shift 3 + `simple` schedule + `er_sde`,
    4 steps, CFG 1 (github.com/yanokusnir-ai/one-node-flux-2-klein). A/B against Darkroom's Flux2Scheduler + euler on
    8 text-to-image and 4 edit cases, fixed seeds (docs/qa/addenda/p1): equal or better on 10 of 12 — finer skin and
    stone/rigging detail; the cat's fur was marginally crisper with euler; edits equal. Same speed (7.5–8 s at 1 MP).
    Shipped as `klein_t2i/klein_ref/inpaint/outpaint/klein_edit.v2.json` with identical DR_* titles; v1 files kept.
    Enhance keeps its own graph until its Phase 2 redesign.
63. **No KV toggle for Klein on this machine.** `flux-2-klein-9b-kv` is bf16 (18.2 GB) vs the 9.4 GB fp8mixed model;
    with 2–3 references it filled the 24 GiB card and ran 168 s / 59 s against 21 s / 29 s, with no quality gain (one
    3-reference result had a worse pose). `FluxKVCache` and the KV graphs remain in `workflows/experiments/` for a card
    with more memory or an fp8 KV release.
64. **Klein base-model rules not wired.** No Klein *base* model is installed and Darkroom's model file is fixed, so the
    base defaults (20 steps, CFG 5, real negatives) would be unreachable code; recorded here instead.
65. **Qwen-Image 2.1 tiers: Draft and Native 2K.** Official pipeline: ~40–50 Euler steps (template note); ComfyUI
    template: 25. A/B (docs/qa/addenda/p1): at 25 steps a busy crowd shows smeared, half-formed pedestrians that 40 steps
    resolves; text and single subjects are the same. Cost +45 % (Draft 16 → 23 s, 2K 105 → 160 s). So **Draft** =
    ~1 MP (1024², 928×1152, 1248×832, 1376×768 — all multiples of 32; the old "Standard" used Qwen-Image v1 sizes such as
    1328², which are not) at 25 steps for iterating, and **Native 2K** = the official size table at 40 steps for finals.
    Peak VRAM: 18.5 GB (decimal) at 2K text-to-image; with references 20–24.8 GB (2 refs at 2K is the maximum seen,
    still no stall); identity held with 1–3 references at both tiers.
66. **Enhance = Restore (edit-style) on both models; img2img kept only as "Subtle".** A/B on five inputs (320 px JPEG,
    the same after SeedVR2 4x, lens blur, motion blur, a clean portrait; docs/qa/addenda/p2): Darkroom v2's img2img
    Enhance at denoise 0.3/0.35 did **not fix blur at all** (the lens-blurred car came out as blurry as it went in;
    Phase 6 had only tested low resolution). Edit-style Enhance restored every case on both models.
    - Klein: source as `ReferenceLatent` (lanczos ~1 MP), empty latent at the source aspect, denoise 1, One Node
      sampler. One Node's prompt ("…increase clarity and micro-contrast…") over-processed clean pictures (HDR crunch,
      neon greens); a toned-down prompt that lists what to keep (colours, contrast, skin and fabric texture) restored
      just as well without it. A "Scene: <caption>" line is appended (Addendum 1 B).
    - Qwen: its own path — source as `image_1` of `TextEncodeQwenImage21`, the encoder's empty latent, denoise 1,
      25 steps. Natural colours, faithful faces, even from the raw 320 px JPEG. The caption line changed nothing
      visible, so Qwen Restore skips the VLM call.
    - Restore needs no SeedVR2 pre-upscale (DECISIONS 55 now applies to Subtle only). Modes: Restore (default),
      Restore + upscale (SeedVR2 2x after), Subtle (old img2img; the only mode with the Advanced denoise slider).
      "Strong" is gone: Restore does its job better.
67. **Inpaint = crop and stitch on both models (core nodes only).** The app plans the crop from the painted mask
    (`src/shared/cropstitch.ts`, One Node's rules: mask box × 1.5 context, long side × 1.5 rounded up to 64, clamped
    512–1536), samples only that region, scales back and composites into the untouched original through a grown and
    blurred mask. A/B on 7 cases (docs/qa/addenda/p3):
    - Klein: the v2 whole-picture inpaint **left small masks unchanged** (teapot, one car in a crowd — too few pixels
      at 1 MP) and garbled chalk text ("Open Open till 7"); crop and stitch got every case right, text included, and
      is faster on small masks (6–9 s vs 14–17 s).
    - Qwen, four options: whole picture (fails on small masks), native crop (adds the new object *next to* the old one),
      **crop with the mask shown as `<image2>`** (6/6, clean replacements), and the Qwen-Image 2.1 Fun ControlNet Union
      in inpaint mode (keeps the structure and recolours instead — worst for inpainting). Shipped: the mask-shown graph,
      prompt "In <image1>, replace the area marked white in <image2> with …"; a reference picture moves to `<image3>`
      and the composer remaps the user's `<image2>`. Native and ControlNet graphs are kept in `workflows/experiments/`.
    - Change strength (denoise) works on both but a colour swap does not take below ~80 %, so the slider runs 50–100 %,
      default 100 %. Seam feather: Auto = the tested grow 8 / blur 6; a manual value splits into grow and blur.
    - Reference-guided fills can copy a chunk of the reference (Klein pasted the reference's house with the car); the
      prompt should say what to take from it.
    - Optional pictures that vanished from ComfyUI's input folder are dropped with a notice instead of failing the job.
68. **Outpaint: One Node's canvas prep for Klein; Qwen keeps its own route.** A/B on 5 cases incl. a 2528×1696 picture
    (docs/qa/addenda/p4):
    - Klein: server-side prep (`src/server/outpaint.ts`: black pad, mask with a gradient INTO the original — Auto =
      min(48, short side / 6), override ≤ 256 — multiples of 8) + the crop-and-stitch graph over the **whole canvas**
      at denoise 1.0 (locked; the inpaint Change strength never reaches outpaint). Seamless on every case. Darkroom v2's
      in-graph padding duplicated content (a second band of hills in the harbour sky, a second chalkboard on the big
      picture). Sampling only the new strip + context ("extend_for_outpainting") was barely faster on the large
      picture (17.3 vs 19.4 s) and duplicated content (a second red car) because the model lacks the whole picture.
    - Qwen: the same prep with the mask shown as `<image2>` made Qwen paint the "marked" area literally white or leave
      the black bars; the native aspect change (image_1 + a larger empty latent) extends well but redraws the whole
      picture (not pixel-faithful) and took 224 s on the large one. Darkroom v2's Qwen outpaint (model sees the
      original, samples the padded canvas) was clean and exact on every case in ~27 s, so it stays; padding now
      rounds to multiples of 32.
    - Leftover black from earlier rounds: only near-black regions **connected to an extended edge** are re-masked (One
      Node re-masks every dark pixel, which would regenerate night skies and black clothing; unit-tested).
      Three rounds of +256 px in a row stayed seamless on both models (docs/qa/addenda/p4r).
69. **Upscale v2 (SeedVR2, One Node's graph).** `upscale.v2.json`: alpha kept (`JoinImageWithAlpha` with LoadImage's own
    mask; SeedVR2 post-processing re-applies it — a cutout's mean alpha 83.4 came out 83.3 at 4×), 2/4/6/8×, tile size
    as the VRAM setting (256 / 512 / 1024, overlap = tile/4), optional "scale by longer side" pre-shrink. Measured on a
    320 px source: even 8× peaks at ~10.5 GB (7.9–11.2 s depending on tile), so all factors are safe on 24 GB.
    LAB vs wavelet colour matching: near-identical (wavelet slightly more saturated) — LAB stays (SeedVR2's "most
    faithful"). **Pixelated sources:** SeedVR2 keeps nearest-neighbour blocks as detail at any factor, and a pre-shrink
    only helps when it reaches the picture's real resolution (a 96 px cat blown up to 384 px came back as a realistic cat
    only when shrunk to 96 px first). So ticking "Scale by longer side" detects the block size
    (`src/shared/pixelblock.ts`) and pre-fills the real size. One-click Upscale 2× is on every Generate result and in the
    Library; Edit > Upscale has the full options.
70. **Transparency and background removal.** Every library picture shows transparency on a checkerboard (one CSS rule on
    `/api/items/…` images; layer stacks opt out so lower layers show through). Background removal benchmarked three ways on
    hair, fur, glass and a product (docs/qa/addenda/p5): BiRefNet one-click (1 s) matched SAM + BiRefNet, so it stays the
    fast default; Lucida left an orange glow under the product; **Qwen-Image 2.1 native extraction** (official template
    wording, ~25 s) gave real alpha, the most convincing see-through glass and pixel-faithful stray hairs → added as
    "Best quality (Qwen)". Layer decomposition: Qwen 2.1 per-object extraction (+ a background plate with the objects
    removed) gave transparent layers at full resolution (1344×768, ~24 s per layer); Qwen-Image-Layered returned 640×360
    in 86 s. Added as Layers > "Objects (Qwen 2.1)"; **Qwen-Image-Layered is kept only as the no-names "Automatic"
    option**. Addendum 2's premise "Qwen can't produce real alpha" never applied to Darkroom (DECISIONS 46).
71. **Edit presets.** One Node's Discover presets (Angles 4, Relight 26, Styles 22, Enhance, Text edit, Try-on,
    Texture transfer; Head swap left out) imported as `presets/edit_presets.json`, generated by `scripts/build_presets.ts`
    from a compact table so every preset follows the rules — imperative verb first, a preservation clause, relights name
    the direction and "source out of frame", two-picture presets name each picture's role, `[BRACKET]` slots, no filler
    ("8k professional photography" and "Octane Render" were dropped from One Node's Portrait and 3D Render). The script
    refuses to write a preset that breaks a rule. Each preset has separate Klein wording (prose, "image 1 / image 2")
    and Qwen wording (instruction on `<image1>` / `<image2>`, explicit "unchanged" list). Built-ins are read-only; the
    user's presets live in `data/user_presets.json`, merged by label (override single fields, hide, or add), so updates
    never wipe them. In Edit > Instruct, a preset fills the instruction for the selected model, selects the first
    `[SLOT]`, follows a model switch while the text is untouched, and reminds you to add the second picture when needed.
72. **Reproducibility.** Every saved PNG's `darkroom` chunk now also carries the screen settings (`ui`), so
    Generate > Restore rebuilds the exact settings from a file outside the library (or from its settings JSON, which the
    Library offers per item — the sidecar, also for videos). Library right-click "Use as…": Edit, Inpaint, Outpaint,
    Enhance, Upscale, Generate reference, Edit reference (for the picture open in Edit), Video start / end frame.
    Ctrl+V fills the first empty slot everywhere: Generate references, Video start then end, and — new — the Edit
    Reference slot when a picture is open.
    **A/B (docs/qa/addenda/p6, all 56 presets on both models, fixed seeds, 112/112 rendered):** Angles work on both
    (Qwen does wide-angle better); Relight is more dramatic on Klein, more faithful to the face on Qwen; Text edit is
    exact on both; Try-on is better on Qwen (buttons, fit); Enhance is equal. **Styles: Klein restyles decisively;
    Qwen's wording is too timid** — 3D render, embroidery, low-poly, claymation and 16-bit pixel barely change — and
    Qwen's texture transfer copies the reference's cat onto the car. A follow-up A/B on stronger Qwen wording is queued
    (`p6b`). Recommended default for Styles: Klein.
73. **Circle quick edit (Addendum 2 C).** Edit > Instruct > "Point at it with a red circle": paint over (or smart-select)
    the object, and Qwen gets the picture with a red ellipse drawn round the mask's box (`src/shared/annotate.ts`) plus
    `instruct_circled` ("change only the object circled in red: … Remove the red circle completely"). **A/B
    (docs/qa/addenda/p3c, 5 golden masks × 4 routes):** Qwen on the circled picture 5/5 — right object replaced, no
    circle left, right scale (the small taxi too). Qwen with the clean picture + a circled copy as `<image2>` added the
    scooter next to the car instead of replacing it and drew the van too large. Klein failed both ways (kept the
    teapot, ghosted the scooter over the car, missed the chalkboard text), so the option is Qwen-only and disabled
    for Klein. Mask-based inpaint (crop and stitch) stays the precise tool; the circle is the quick one — no feathering,
    no strength, whole-picture edit.
74. **General VLM: Qwen3-VL 8B stays (Addendum 2 Qwen3.5 routing, JP's "A/B first").** docs/qa/addenda/p7: the
    production requests (captions short / detailed / Klein, reverse prompts, Klein Enhance, Klein edit rewrite) on
    three models, 18 cases each, all ran. **Qwen3-VL 8B** 2.7 s average, accurate, keeps to the length asked for.
    **PE-I2I as a general model** 5.6 s, the richest detail (reads number plates, lettering) but ignores length ("short"
    comes back as a paragraph), leaks `</think>`, and once degenerated into `{"a": 1, "b": 2, …}` on a reverse prompt.
    **Qwen3.5 4B** 3.6 s but invents things ("Hong Kong", a "TOKYO" sign, a "double-decker tram"). So no 19 GB download;
    the Qwen-Image 2.1 PE models stay on the two jobs they were trained for — PE-T2I for Qwen Enhance (live: "portrait
    poster" → wh_ratio 2:3 → the 4:5 aspect, 22 s) and PE-I2I for the Qwen "Enhance instruction".
    Two fixes from the A/B: the Klein edit-rewrite system prompt put its relight rule first, so "make it night" came
    back as warm light; it now puts the user's intent first and names the preserved things actually in the picture
    (p7b: night, sign, winter, remove, add, side light all correct at ~2 s). PE-I2I sometimes reasons in the open even
    with thinking off (50 s, 6.9 k characters ending in "Final version: …"); `stripLeakedReasoning` keeps the text after
    the last "Final version:"-style marker, else the last paragraph when the answer opens with reasoning.
75. **Preset model hints.** Stronger Qwen style wording ("Transform <image1> completely into …, re-rendering every
    surface") changed nothing on 3D render, embroidery, claymation, low-poly and 16-bit pixel, and the explicit "do
    not add any object or animal from <image2>" still left the cat on the car (docs/qa/addenda/p6b). Qwen-Image 2.1's
    edit stays conservative there, so instead of rewording, presets carry `best` (from `scripts/build_presets.ts`): the
    picker labels those "· best on Klein" when Qwen is selected and says so in a toast; Try-on is marked best on Qwen.
76. **Motion prompts see the end frame.** Video > Suggest / Improve motion only sent the start frame, so with an end
    frame the prompt could describe motion that never reaches it (LTX, asked "he turns to the camera", had him "turn
    away again"). With an end frame, the server builds one sheet — start and end side by side at the same height,
    labelled START and END (`src/server/framepair.ts`; the vision graph takes a single picture) — and uses the
    `motion.wan_pair` / `ltx_pair` prompts, which ask for the motion that carries the scene from the start to the end
    and forbid mentioning frames or panels. Live check on the test library: the prompts now describe what actually
    changes (night sky → golden light; a side profile turning to face the lens; the coat going from yellow to red).
    Without an end frame nothing changed.
77. **Generate "From references".** With references loaded, "From picture" only reverse-engineered reference 1 as a
    stand-alone picture: the other references were ignored, the result had no reference tokens, and it overwrote your
    idea. The button now reads **From references**: every reference goes to Qwen3-VL on one labelled sheet (IMAGE 1–3,
    `labelledSheet` in `src/server/framepair.ts`, shared with the Video start/end sheet) with the `compose` prompts,
    and your text is kept as the idea. The prompt names what to take from each reference, in the model's words ("the
    woman from image 1 wearing the coat from image 2" for Klein, `<image1>` tokens for Qwen). Two fixes from the live
    test: the server states the exact reference count and tokens (with one reference Klein had invented "image 2" and
    "image 3"), and quoted text is only allowed when asked for or clearly readable (Qwen had invented a number plate).
    Rendered check with portrait + coat + living room: both models put the woman in the coat inside the room. Without
    references the button is unchanged (pick a picture, get a prompt that recreates it). ~5 s.
78. **Home screen and your own pictures.** Darkroom now opens on **Home** (JP's request) instead of jumping to the last
    screen (DECISIONS UX review #2): four cards (Generate, Edit, Video, Library), an "Edit your own picture" upload
    area (drop, paste or browse, several at once), a **Continue where you left off** card for the last screen (with
    the picture's thumbnail when there is one) and one row of recent work. The logo goes Home from anywhere.
    Bringing pictures in was only possible from Edit's empty state, which you rarely saw; there is now **Upload** on
    Home, in Edit (also with a picture open, or drop a file on the canvas) and in the Library (button or drop on the
    grid). One shared importer (`src/web/lib/importer.ts`) uploads each file and saves it through the existing
    `import` workflow, so it becomes an ordinary library item (v1) that every Edit tool works on; it listens for the
    job and also polls, so a fast import is never missed. Checked: a 12 MP phone JPEG stored sideways with an EXIF
    rotation comes in upright at full size in ~1 s. iPhone HEIC can't be decoded here (codec licence), so it gets a
    clear "save as JPEG" message instead of a failure. Everything stays on this PC (ComfyUI's input/output folders).
79. **Large photos keep their resolution.** Klein and Qwen draw at about 1 MP. Measured on a 12 MP photo: Inpaint,
    masked Instruct and fast Remove BG kept 100% of the untouched pixels; whole-picture edits kept the size but every
    pixel was a lanczos blow-up of ~1 MP (detail score 30 vs 319 for the original); **Restore handed back 1184×880**.
    Two fixes (`src/shared/fullsize.ts`, from 2 MP up):
    - **Enhance** (Restore and Subtle) on a large photo chains SeedVR2 to the photo's **exact** size (Restore +
      upscale: twice that, capped at 8192 px). `upscale.v3.json` = v2 + an optional exact final size (DR_EXACT,
      bypassed when unset): the models' working size never has quite the photo's aspect. The server works out the
      factor from the size Restore actually produced. 4032×2304 photo: full size back in 57 s.
    - A **whole-picture** Instruct result (or Qwen best-quality background removal) on a large photo shows a banner
      with **Sharpen to full resolution**: the soft result is shrunk back to the size it was drawn at, then SeedVR2
      rebuilds it at full size. Detail score 30 → 426 (original 319) in 18 s; crops show crisp vents, wiper and trim
      without halos. Transparency survives (alpha kept, exact size hit). The banner goes once a sharpened version
      exists. Masked edits never need it.
80. **ComfyUI 0.38.1 (2026-10-01).** Changes: a fix for the int8 / int4 Qwen-Image 2.1 prefix cache (#16667), three
    paid cloud partner nodes (Ideogram 4.5, HeyGen Video 1.0, Claude Sonnet 5.5) and templates 0.11.70 → 0.11.73.
    - **Compatibility:** `scripts/check-nodes.ts` (new; run it after every ComfyUI update) checks every workflow the
      manifest uses against the live `/object_info` — node classes, input names, autogrow children, fixed dropdown
      values and installed model files: 38 workflows, 27 model files, all compatible. Full e2e on 0.38.1: green.
    - **Prefix cache int8 / int4: not adopted** (docs/qa/addenda/c381). Same seeds: int8 looks identical to default
      (mean difference 0.5–3 / 255), int4 visibly changes the picture (14–19 / 255: pose and furniture move). Speed is
      the same. Peak memory, measured twice from an empty card (Native 2K, 3 references), was *higher* with int8
      (22.8 / 23.6 GB vs 20.5 / 20.4 GB): the cache is dequantised to full precision while sampling, so no saving
      reaches the peak. The graphs keep `dtype: default`; the int8 / int4 copies stay in `workflows/experiments/`.
      Side result: Darkroom's heaviest Qwen job peaks at ~20.5 GB from a clean start (the 24.8 GB seen in the
      addenda included other models still loaded).
    - **Official prompt-enhancer settings: not adopted** (docs/qa/addenda/c381pe). The 0.11.73 Qwen-Image 2.1
      templates now embed PE-T2I / PE-I2I with thinking on, 4096 tokens, repetition 1.0, presence penalty 1.5 (T2I),
      and the `qwen_image` loader for PE-I2I; the system prompts are byte-identical to Darkroom's. Same 8 requests:
      Darkroom's settings 6–16 s, 8/8 clean, aspect ratio every time; the official settings 15–40 s, with one T2I
      answer as unparseable JSON (no ratio), one empty edit instruction, one cut off mid-sentence and one wrapped in
      JSON. The graphs gained `repetition_penalty` / `presence_penalty` settings (default: today's behaviour) so a
      future template change can be tried from `presets/vlm_prompts.json` without a graph change.
    - Found on the way: an answer wrapped in quotes that also quoted text inside ("…plate "E65 8Q4S"…") kept its
      wrapper; the cleaner now strips a balanced outer pair (unit-tested both ways).
81. **History and Takes are views of the Library.** Generate's History was a list of up to 200 picture ids in the
    browser (deleted pictures stayed in it, purged ones left gaps) and Video's Takes listed the last 40 render jobs
    (deleted videos stayed; failed renders piled up). Now:
    - **History** = the newest 30 Generate pictures in the Library (`filter=generated`), refreshed on every library
      change; **Takes** = running and failed renders plus finished ones whose video is still in the Library
      (`Store.liveTakes`). Delete or restore anywhere and both panels follow.
    - **Delete in place**: a ✕ on hover (always visible on touch screens) or the Delete key on a focused History
      picture, through the same Recently deleted + Undo as the Library (`src/web/lib/remove.ts`). Deleting the picture
      or take on show moves the view to the next one.
    - **Failed takes** (error, cancelled, lost — no file) get **Dismiss**, and **Clear failed (N)** hides them all
      (`jobs.dismissed`, additive migration). Only failures can be dismissed.
    - **See all in Library** links (videos filter for Takes). No separate "hide from panel": one kind of removal.
82. **Clean workspace.** Generate and Video kept everything in localStorage, so a new launch reopened the last picture
    and prompt, even after that picture had been deleted (JP's screenshots: a deleted red car on Generate, an old start
    frame on Video), while Edit and Library opened clean. Now:
    - **Deleted work leaves the screen**: the picture or take on show is dropped as soon as it is deleted anywhere,
      and so is a start / end frame picked from a Library picture that gets deleted (frames are copies, so the source
      item is checked).
    - **Work in progress is per launch, preferences stay** (`useWorkspace` / `useSessionState` in
      `src/web/lib/hooks.ts`): the prompt, references, seed, frames, motion text, camera moves and what is on screen
      live in sessionStorage (kept across reloads and screen changes, cleared when Darkroom is launched again — the
      launcher opens a new tab); model, aspect, style, quality, batch, length and notifications stay in localStorage.
      Older stored work-in-progress values are ignored. Earlier results stay in History / Takes, and Home's
      "Continue where you left off" still returns to the last screen.
    - **New** on Generate (next to "Prompt") and Video (next to "Frames") clears the workspace at any time, with Undo.
83. **Restore LoRA for large photos only.** JP asked about three Klein LoRAs (2026-10-01):
    - fal *flux-2-klein-4B-outpaint-lora*: Klein **4B** — cannot load on 9B, and Klein outpaint is already seamless
      (DECISIONS 68). Not used.
    - nomadoor *flux-2-klein-9B-schematic-lora*: trained on Klein 9B **base** (the author warns it may misbehave on the
      distilled model Darkroom runs), outputs depth / normal / pose / segmentation maps the author calls not
      production-ready; SAM 3.1 already segments and nothing in Darkroom uses depth or pose. Not used.
    - **Ultimate Upscaler Klein-9b** (civitai.com/models/2474084, `Flux2-Klein-Image-RestoreV1.safetensors`, 237 MB,
      non-commercial; downloaded by JP, logged in; SHA-256 verified): made for the distilled 4-step Klein 9B.
      A/B (docs/qa/addenda/lora, same seeds, LoRA strength 1): at Darkroom's usual 1 MP the LoRA did **not** help —
      softer on lens and motion blur (edge detail 4263 → ~3000, 853 → 686–787), a tie on the low-res JPEG and the
      clean portrait. At **4 MP** it did: Klein alone at 4 MP is waxy, with the LoRA stone and wood stay crisp and
      natural (no halos, text intact), and against today's large-photo path (Restore at 2 MP + SeedVR2 to full size)
      it is clearly sharper with truer colours (edge detail 2536 vs 1336 and 4159 vs 1878), 76 s vs 44 s, < 20 GB.
    Shipped: **Klein Restore of a photo of 2 MP and up** uses `klein_enhance_large.json` (the Restore graph + DR_LORA +
    an optional exact final size, DR_EXACT): up to ~4 MP it is drawn at the photo's own size and returned exactly at
    it; larger photos are drawn at 4 MP and SeedVR2 takes them to full size (Restore + upscale: twice, capped at
    8192 px) — `planLargeRestore` in `src/shared/fullsize.ts`. Small pictures, Subtle and Qwen are unchanged. Live:
    2528×1696 → exactly 2528×1696 in 90 s; 4000×2286 → 4000×2286 in 104 s; 1344×768 → normal Restore in 24 s.
84. **Boards (collections), after Invoke's gallery boards.** JP's Library was one flat list. A board groups pictures and
    videos by project or client (`boards` table, `items.board_id`; additive). A **working board** chosen in the top bar
    is where everything *new* goes — generations, uploads, videos — sent with every job by `api.submit`; a **new
    version** of a picture (edit, upscale, restore, frame) stays in that picture's board, so a picture's versions never
    split up. The Library gets a board row (All boards, No board, each board with its cover and count; New board,
    Rename, Download ZIP of the original files, Delete board), "Move to board…" for a selection and a Board field per
    item. **Deleting a board never deletes pictures** — they go back to "No board". Found while testing: creating a
    board and selecting it raced the board list's refresh (the "board no longer exists" check undid the choice); the
    list is now refreshed before the new board is selected. The Library header also lost a line at 1280 px: Upload and
    the item count moved to the board row.
85. **Prompt variations, after Invoke's dynamic prompts.** `{a|b|c}` groups in the Generate prompt expand to every
    combination (`src/shared/variations.ts`; braces without a `|` are left alone, options kept as typed, joins tidied).
    Each variation is its own job on the **same seed**, so only the wording changes (live: red and blue vintage car,
    identical car, pose and scene), and the result strip shows the whole run together, each tile titled with its
    prompt. A line under the prompt counts the pictures and previews the list. Limits: 16 prompts and 16 pictures per
    click (variations × batch) — over that, nothing is queued and the note says why. The saved settings keep the prompt
    as typed, so Reuse / Restore bring the template back.
86. **Your own LoRAs, only where they fit.** ComfyUI lists every LoRA it can see (three folders on this PC, read from
    its `/internal/folder_paths`), but a LoRA works only on the model it was trained for. Darkroom reads each file's
    header — layer names and sizes, never the weights — and matches its layers against the model Darkroom actually
    loads (`loraFit` in `src/shared/loras.ts`, native and Kohya names; a LoRA counts when ≥ 90 % of its layers exist
    with the same width). On JP's 21 files the split is unambiguous: the 5 Klein 9B LoRAs score 1.00 on Klein, every
    other file ~0 (Klein 4B, Flux.1, Z-Image, Wan, and the older 3072-wide Qwen-Image / Edit-2511 LoRAs, which do not
    fit the 4096-wide Qwen-Image 2.1 — so there are no Qwen 2.1 LoRAs yet), and one damaged file is reported. Generate
    and Edit (Instruct, Inpaint, Outpaint, Enhance) get a LoRA picker for the selected model: up to 3, strength 0–1.5,
    remembered per model. The job carries them (`loras`, saved with the picture, so Reuse / Restore bring them back);
    the server re-checks the fit and refuses anything else, then chains LoraLoaderModelOnly nodes after the graph's
    DR_MODEL (the restore LoRA of large-photo Restore stays after them). Live: the chosen LoRA lands on the graph at
    its strength and changes the picture on the same seed (mean difference 13 / 255).
87. **Compose, after Invoke's unified canvas.** Arrange pictures, cut-outs and rough paint on a canvas, then let the
    models turn the collage into one picture. A feasibility A/B came first (docs/qa/COMPOSE_AB.md): Qwen keeps pasted
    photos and faces but leaves paint as paint; Klein turns paint into a photo but redraws pieces; redrawing only the
    seams keeps pieces exact but can't fix placement. Hence three render modes on the existing edit graphs (no new
    ComfyUI workflow): **Blend edges** (`qwen_edit` with a seam mask built in the browser — a band round every piece
    above the background plus a contact-shadow strip, feather 12), **Harmonise** (`qwen_edit`, whole picture) and
    **Reimagine** (`klein_edit`). The suggestion follows the canvas (paint ≥ 20 % → Reimagine, else Harmonise).
    Reimagine with no scene text first asks Qwen3-VL to describe the real scene (`scene` task) — bare rough paint
    otherwise became a toy house. Pieces come from the Library, an upload or a drop; **Cut out** runs background
    removal (~2 s, the cut-out also lands in the Library) and trims the layer to the subject in place. Move, scale with
    the shape kept, a ground line while dragging, flip, order, hide, fill the canvas, paint and erase, undo/redo.
    The first picture on a blank canvas becomes the background and gives the canvas its shape (~1 MP, sides ÷16).
    Compositions save themselves (`compositions` table: the layout as JSON, a thumbnail; paint layers as PNG data
    URLs; pictures by their ComfyUI input name, checked server-side) and deleting one only hides it (Undo).
    Renders are ordinary Library items (`mode: compose`, `ui.compositionId`) in the working board; **Continue from
    this** makes a render the new background and hides — never removes — the layers under it.
88. **v3 review: what stays and why** (docs/REVIEW_V3.md, grids in `docs/qa/addenda/rv/`). Klein full bf16 instead of
    fp8mixed: visually identical, +35 % time, 24.7 GB peak — fp8mixed stays. Klein 6 steps: mixed, +35 % — 4 stays.
    Whole-picture VAE decode: seams were already invisible, 6 % faster at Native 2K but +3–4 GB — tiled stays. Edits at a
    bigger working size (Klein 2 MP, Qwen 1.76 MP): marginal gain, less consistent, 1.6–2.2× time — 1 MP plus
    "Sharpen to full resolution" stays. Qwen-Image 2.1 already matches the official template. Klein at ~2 MP is the one
    clear gain (text, fur, skin, crowds; 13–14 s) and is proposed as a Klein Quality choice. UI: the top bar no longer
    pushes the app past 1280 px, the LoRA list fits its panel, an empty LoRA section is one line, Generate's Quality
    sits under Model, Compose's Render area is compact on short screens.
89. **Klein Quality: Standard (~1 MP) / High (~2 MP).** From the v3 review (decision 88, `docs/qa/addenda/rv/klein-2mp.jpg`):
    at ~2 MP Klein spells signs right, and fur, skin and crowds are finer; 13–14 s instead of 7.5 s at the same memory
    peak. High sizes: 1408², 1264×1584, 1728×1152, 1920×1088, 1088×1920 (÷16). Steps stay with Klein's own Advanced
    control (4). Each model keeps its own quality (`kleinQuality` beside Qwen's `quality`), so Native 2K for Qwen never
    makes Klein High. Checked on the card: High ×4 batch 55 s / 20.2 GB peak; High with 3 references 39 s / 22.3 GB.
90. **Library version stacks.** The grid was mostly v2…v5 of the same pictures. A picture and all its versions (edits,
    upscales, crops: every item sharing `COALESCE(root_id, id)`) now show as one tile — the newest version that matches
    the filter — with a count badge (`listItems({ stack })`, a window-function query; `stack_count` on each item).
    Selecting it lists every version in Details (oldest first; an older version opens there even though it is not on
    the grid) with "Delete all N versions" (to Recently deleted, Undo). Delete on a stacked tile deletes the version it
    shows; the next newest takes its place. "Stacks" in the filter row turns it off (a preference); Recently deleted
    is never stacked. Also: the Details panel only takes room when something is selected, and a "Composed" filter
    (Compose renders). Test library: 674 tiles → 283.
91. **Your own Klein 9B fine-tunes ("Klein version").** Any diffusion model ComfyUI lists whose layers match the official
    Klein 9B (≥ 98 % of its 2-D layers with the same width, ≤ 5 % extra; headers only, cached by size and date —
    `src/shared/finetunes.ts`, `LoraLibrary.finetunes`) is offered under the Klein card on Generate and Edit (Instruct,
    Inpaint, Outpaint, Enhance). BFL's own copies and KV builds are left out. The job carries `klein_weights`; the
    server re-checks the file and swaps the graph's DR_MODEL, so LoRAs, Quality and every Klein graph work unchanged.
    The picture's model line names the fine-tune ("Klein 9B · nsfwKlein") and Reuse brings it back. On this PC it
    finds one: DarkBeast-Klein9b-V2 (`nsfwKlein.safetensors`). A/B (`docs/qa/addenda/rv/klein-finetune.jpg`): it is
    distilled like Klein — complete, clean pictures at Klein's 4 steps (8 adds nothing); softer, more flattering faces,
    cleaner lettering; ~9 s vs 7.3 s; peak 24.8 GB vs 20.4 (plain fp8 without scales needs more working memory).
92. **Klein KV fp8: tested, not adopted.** `black-forest-labs/FLUX.2-klein-9b-kv-fp8` (9.82 GB, downloaded with JP's OK)
    with FluxKVCache, the model decision 63 waited for. From a cleared card it is faster with references (3 refs
    18.6 s vs 27 s; edit + ref 15.6 s vs 20 s), but quality is uneven (`docs/qa/addenda/rv/klein-kvfp8*.jpg`): better
    on a fur texture transfer, worse on an outfit swap (kept the scarf), and at High (2 MP) with 3 references the face
    collapsed into the scarf. Using it only for reference jobs would also keep two Klein models fighting for memory
    (102–140 s runs at a 25.1 GB peak). Quality first: Klein stays on fp8mixed. The file stays on disk (JP's to keep or
    delete); the graphs stay in `workflows/experiments/*.kvfp8.json`.
93. **Enhance writes for the chosen style** (JP's request). Generate's Enhance now sends the style picked on Generate;
    the prompt writer is told the style (its own sentence, which Generate still adds after the prompt when it renders)
    and asked to describe subject, composition, materials and light in that medium's language and to leave out other
    media's words — not to copy the style sentence, so nothing is doubled (`withEnhanceStyle`, `src/shared/vlm.ts`).
    The general engine (Klein) gets it in its instructions; the official Qwen prompt enhancer, whose system prompt is
    fixed, gets it after the idea. A first wording ("without repeating the style") made Klein avoid style words
    altogether; naming each medium's vocabulary fixed it. Same seeds, same style at render
    (`docs/qa/enhance-style.jpg`): Ink sketch turns from coloured, sunlit pictures into real ink drawings, Screen print
    into a flat-colour print, Concept art more painterly; the old photographic wording ("35 mm lens") no longer fights
    the style. One miss in six: a screen print still slipped in "lens" and looks photographic.
94. **Suggest / Improve motion leave the camera to the camera chips** (JP's question). The motion writer never saw the
    chips, and its instructions ask it to describe camera moves, so with Static chosen it could write "the camera drifts
    forward" — and Video then added Static's sentence too, two contradicting instructions. Now Video sends the chips;
    the writer is told the camera move is decided and added automatically, and to describe only what moves in the
    scene, fitted to it (`withCameraMoves`). It still copied the chip's sentence as its first line, so with chips any
    sentence starting "The camera" is dropped from the written motion (`dropCameraSentences`; never empties it). No
    chips: unchanged. Same seed, LTX Draft, Static (`docs/qa/motion-camera.jpg`): with the old suggestion the camera
    pushed in anyway (hillside change 40.5 / 255 first→last frame); with the new one the shot stays put (7.6).
95. **LTX 2.5 is Darkroom's only video model** (JP's call after using both). Wan 2.2 leaves the Video screen: the model
    cards go (one model), the section reads "LTX 2.5 · length and quality", an older "wan" preference falls back to
    LTX, and Home says "with sound". Wan's graphs stay in `workflows/` and the manifest's workflow list, so old Wan
    takes keep their settings and "Open graph"; Extend is off on them (16 fps Wan + 24 fps LTX would play the new part
    slowly — start an LTX take from their last frame instead). Wan's model files (two 14.3 GB experts, the lightx2v
    LoRAs, umt5 and the Wan VAE, ~37 GB) go to the Windows Recycle Bin at JP's request. Found on the way: Extend's join
    drops the sound (fixed with the sound work, decision 97).
96. **LTX 2.5: single pass stays for Draft and Final; a new 1080p tier renders in two stages.** A/B on four start frames
    (portrait, harbour, busy street, bakery), Final 720p, 5 s, same seeds (`docs/qa/ltx/*.jpg`, `scripts/ab-ltx.ts`):
    the official two-stage structure (half size → x2 latent spatial upscaler → 3-step refine, euler ancestral) is ~20 %
    faster at 720p (78–96 s vs 99–120 s) but softer (middle-frame sharpness 1034–1132 vs 1938 on the street) and on the
    portrait it wandered off the likeness. Its value is resolution: a single pass already peaks at 24.8 GB at 720p, but
    two stages reach true 1080p (1920×1088 / 1088×1920) at 25.6 GB — 5 s in ~198 s, 8 s in 312 s — with far finer
    crowds, cars and skin than 720p enlarged (`street-1080.jpg`, `portrait-1080*.jpg`). So Quality gets "1080p": its
    own graph (`workflows/ltx25_i2v_hd.json`, built by `workflows/experiments/build_ltx_twostage.py`, end frame
    supported — both stages' end guides share the DR_END_GUIDE title so the manifest bypasses both), linear time
    estimate (39 s per second), and the "Happy with the motion?" bar offers 720p or 1080p. One 1080p run started on a
    card still holding the previous clip took 32 minutes; Darkroom frees the card before every video job, so in the app
    it starts clean (re-run: 198 s).
97. **Sound on Video.** LTX 2.5 always made sound and Darkroom muxed it into the MP4, but you could not steer it, mute
    it or keep it through Extend. Now: a Sound control — From the scene (LTX's own, as before), Describe (your words —
    sounds, music, a line of speech in quotes — added after motion and camera as their own sentence), or Silent (the
    clip is saved without an audio track: the server drops CreateVideo's audio input). Suggest / Improve motion are
    told the choice (`withSound`): Silent writes no sounds; with your description it writes none of its own, and any
    sentence that copies your description is dropped (`dropCopiedSound` — it did copy it, like the camera sentence).
    Extend joins the sound too when both clips have it (`video_join_audio.json`: AudioConcat of both tracks; the old
    `video_join.json` stays for silent and Wan takes). Checked: Silent → no audio stream; Describe → audio; Extend of
    two 3 s LTX takes → 6.04 s video with 6.06 s audio. The player gets Mute / Sound on (remembered); Silent takes say
    so in Takes. Smooth 2× already kept the sound.
98. **Lightricks' LTX 2.5 LoRAs.** JP downloaded five (gated): Slow-Motion Control, Cinemagraph and the IC-LoRAs Refine
    Details, Restore and Pixel Spatial Upscaler — all complete, all 100 % LTX 2.5 layers. The LoRA catalogue now
    knows LTX 2.5 (`ltx`) and keeps IC-LoRAs apart (`ltxTools`: their files carry `reference_downscale_factor`);
    LTX jobs accept LoRAs like Klein and Qwen (header-checked, injected after DR_MODEL). Tested on Darkroom's distilled
    graph (`docs/qa/ltx-loras/`): **Slow motion** — the model card's "speed" is the motion frame rate LTX is told
    (fps ÷ speed) while the clip plays at 24 fps; the server inserts that (`motion_speed`). Motion per frame 2.67 →
    1.80 (½) → 1.27 (⅕); the frame-rate trick alone slows it as much, the LoRA keeps moving things a little cleaner
    (less smear), so both are used, as Lightricks advise. **Cinemagraph** — its trigger `CINEMAGRAPH_MOTION`, a locked
    camera and "seamless natural loop" (card), strength 1.1: the still parts stay still and the loop closes better
    (last-vs-first 12.2 vs 16.5). **Refine details** — a take goes in as an in-context reference (resized to the 720p
    canvas, GetICLoRAParameters → LTXVAddGuide, 8 distilled sigmas) and comes back redrawn: the 480p street draft's
    smeared crowd becomes individual people (sharpness 567 → 1028), same motion (5.8 / 255 difference at thumbnail
    size) and the same sound; 205 s for 5 s, 24.3 GB (`workflows/ltx25_v2v_refine.json`). On Video: an Effect control
    (None / Slow motion ½·¼·⅒ / Cinemagraph, shown when the LoRA is present), your own LTX LoRAs (the two effect LoRAs
    left out of that list), and "Refine details" on takes up to 720p. Restore needs footage you bring in (a video
    import, next); the pixel upscaler adds little now that 1080p renders natively (decision 96).
99. **Cut out for video (Lightricks' Alpha-Gen IC-LoRA, JP's find).** `ltx-2.5-22b-ic-lora-alpha-gen-0.9` (1.31 GB,
    downloaded by JP, complete) makes a black-and-white matte of a take: no prompt (the card says leave it empty), the
    take as an in-context reference at its own size (`ltx25_v2v_alpha.json`, the Refine graph with this LoRA). Tested
    (`docs/qa/ltx-alpha/`): boats with masts and rigging ropes cut cleanly, a portrait keeps the window out and soft
    hair edges, mattes are steady (0.2–0.3 % change per frame); a wide street crowd gets no matte at all (the model
    picks the subject itself — the card's limitation). 95–220 s for 5 s at up to 720p, 24.4 GB; the card's 1080p needs
    data-centre cards, and ≤ 145 frames. One seed in five came out grey with the shading bleeding in (seed 4: level
    0.29 on every frame; seeds 1, 2, 3, 5: 1.0), so the server checks the matte's first and last frames
    (`checkMatte`): grey → it retires that matte to Recently deleted and makes it again with a new seed (twice at
    most); empty → it stops and says no clear subject was found. Tested: seed 4 → retried → clean. Then
    `video_composite.json` puts the take over the chosen background (a Library picture fitted by crop, or a plain
    colour), keeping the take's sound. On Video: "Cut out" on takes up to 720p and 145 frames → choose the
    background; the matte also stays in the Library for video editors. Videos made from a take (refine, matte, cut
    out) now take its size, frame rate and length. The player's tool row wraps, so nothing runs off at 1280–1440 px
    (Refine details was half hidden in v3.12).
100. **Step 5 of the LTX plan: your own videos, Restore, Auto length.** *Import:* Library Upload and Home take MP4 / MOV /
    M4V / WebM as they are (no re-encode: long phone clips would not fit through ComfyUI frame by frame); the browser
    grabs the first and last frames (poster, Extend) and the server reads the file's own facts from its MP4 header
    (`mp4info.ts`: size, frame rate, frame count, sound track) — now also for every video Darkroom makes, so lengths are
    the real ones. *Restore* (Lightricks' Restore IC-LoRA, downloaded by JP): the clip is resized (lanczos) to a canvas
    of up to 1280 px on the long side and goes in as the in-context reference (`ltx25_v2v_restore.json`, 8 distilled
    sigmas). Long clips go in windows of 97 frames (4 s at 24 fps) with 17 frames of overlap, at most 8 windows (about
    27 s); each window after the first is guided by the previous window's last 17 restored frames (`DR_PREV_GUIDE`),
    so colours and details carry on. Tested on a synthetic damaged 10 s clip (sepia, grain, flicker, scratches, a scene
    cut; `docs/qa/ltx-restore/`): scratches, flicker and grain gone, natural colour, the cut kept; 162–189 s per window
    at 1280×704, 24 GB. A hard cut between windows still showed a step (7.6 / 255 mean change vs 2.0 for a normal
    frame: the guided frames come back slightly different through the VAE), so the server-built join
    (`restoreJoinPrompt`) crossfades the 17 overlap frames with a mask ramp — steps across the join 1.5–2.6, like any
    other frame — encodes once and puts the source's sound back (trimmed to the restored length). The parts stay out
    of the Library while the clip is made and go to Recently deleted afterwards. Restore reimagines as much as it
    repairs: colours and fine detail are its best guess (it added modern taxis to an old street), so the dialog says so.
    *Auto length:* Length → Auto adds LTX's duration head (`ModelPatchLoader` + `LTXVDurationPredictor`, prompt only,
    snapped to the 8n+1 grid, 2–8 s) in place of the fixed frame count. Tested: "She blinks once and smiles" → 3.9 s
    (89 frames), a walk across the room to read a letter → 7.4 s (177 frames); a second or two of extra work. The full
    chain on the test library: 10 s of old footage → 3 parts (177 / 165 s) + join (25 s) → 241 frames at 1280×704, the
    joins invisible (largest step 2.9 and 3.4 vs a median of 2.65). *Found on the way:* Darkroom picked a new ComfyUI
    client id at every start, and ComfyUI tells only the client that queued a prompt when it finishes — so a render
    running across a Darkroom restart stayed "running" forever (part 2 sat 20 minutes unnoticed). The id is now fixed
    per library, active jobs are checked against ComfyUI's queue and history every 30 s, and a job is never ingested twice.
101. **Library selection you can find (JP: "no quick way to select a couple of images or videos to delete").** Multi-select
    existed but only through Ctrl- and Shift-click. Now: a tick box on every tile (on hover, always while selecting),
    a **Select** button (plain clicks then tick instead of opening; on by itself as soon as anything is ticked; Done,
    Clear or Esc ends it), and a box dragged over the grid ticks every tile it touches (from empty space any time; from
    a tile too while selecting — tiles are only draggable onto boards outside Select mode). The selection bar adds
    Favourite / Unfavourite next to Move to board and Delete. The details panel stays closed while selecting, so the
    grid does not jump under the pointer. The drag uses window listeners, not pointer capture: with capture, the first
    click after a drag was lost.
102. **Comfy Desktop 1.1.6 and ComfyUI 0.38.2 (JP's request), and videos saved at CRF 18.** Updated through Desktop's own
    updater (ComfyUI first, with Desktop's snapshot to roll back to, then Desktop's restart-and-update). 0.38.2 only adds
    paid partner nodes (FLUX 3 Image via BFL's API, a Grok video model) and newer templates: one new node type, none
    removed, no custom nodes to break. Desktop 1.1.5/1.1.6 are fixes (one stops a ComfyUI left running by an earlier
    Desktop before launching). `check-nodes.ts`: all 45 workflows and 26 model files compatible, once it understood
    numbered autogrow inputs (`masks.mask0`) and skipped the retired Wan entry; e2e 58/58 and a real Restore join on
    0.38.2. Taken from ComfyUI's next release (#16663): Save Video encodes H.264 at x264's default CRF 23 unless told
    otherwise, and upstream is moving to 18. Measured on the Restore join (`scripts/try-video-crf.ts`): CRF 18 gives
    +1.7 dB PSNR and keeps all the fine detail (Laplacian energy 100 % vs 98 %), files about 45 % larger. Darkroom
    encodes clips again in several places (Restore parts and join, Extend, Refine, Cut out), where the loss compounds,
    so the server now sets re-encode at CRF 18 on every H.264 SaveVideo (checked in a take's x264 header: crf=18.0).
    Also in the next release, not yet in stable: higher-quality EXR, MiniMax-H3 VAE support, an `--offline` flag.
103. **Timeline: put your own films together (JP: "a real winner to compile your own videos"), after LTX Director.**
    WhatDreamsCost's LTX Director (GPL, a timeline inside one ComfyUI node, built for LTX 2.3, needing two more node
    packs) is not installed; its ideas are taken into Darkroom's own screen instead. Stage 1 is the editor: one video
    track (clips placed in seconds; an overlap is a crossfade from the earlier clip into the later one; a gap plays
    black) and one sound track; move with snapping (edges, playhead, 0), trim either edge (the left edge keeps the rest
    in place), split at the playhead (S), Fade ½ s / 1 s (pulls the clip and everything after it under the previous
    one), close gaps (keeps crossfades), ripple delete, mute a clip's sound, sound volume, undo / redo, autosave
    (`timelines` table, like compositions). Preview: the top clip and, inside a crossfade, the one under it, with the
    sound track playing along. Export runs `scripts/timeline_export.py` with Comfy Desktop's own Python (PyAV, numpy,
    Pillow are there; no ffmpeg on this PC, nothing installed): frame by frame from the clips' files (a long film never
    sits in memory), crop-to-fill, crossfades blended, the clips' sound and your sound mixed at 48 kHz with matching
    fades (normalised only if it would clip), H.264 CRF 18 + AAC, poster and last frame; the film lands in the Library
    (mode `timeline`). 15 s of 720p exported in 20 s. ComfyUI is not used for this: its batches hold whole clips in
    memory. The top bar's compact layout now starts below 1520 px (seven tabs), so nothing runs off at 1280–1440.
104. **Timeline AI tools: fill, extend, retake, key moments, animate to your sound** (stage 2 of decision 103). One
    endpoint plans where the clip goes (`planGeneration`): **Fill** an empty stretch (guided by the frame before and the
    frame after; a clip is needed before the gap — an opening shot is made on Video), **Extend** a clip (from its last
    frame; later clips move to make room), **Retake** a moment from the playhead (the clip is cut there and the new take
    is guided by the frames either side; stopping it puts the clip back whole). Guide frames are read straight from the
    clips' files (`scripts/video_frame.py`, Desktop's Python). The clip lasts exactly the stretch: the nearest 8n+1 frame
    count, with LTX's frame rate nudged to fit (a 2.3 s gap = 57 frames at 24.3 fps). A placeholder holds the place; the
    job's chain swaps the clip in on the server and the screen follows. **Key moments**: more LTXVAddGuide pictures
    chained after stage 1's last guide (both LTX graphs), strength 0.7, and "One continuous shot without any cuts" in
    front of the prompt whenever a clip has two or more pictures. **Animate to my sound**: the sound track under the
    stretch is encoded by LTX's audio VAE and frozen (LTXVFreezeLatent, in both stages of 1080p) in place of the empty
    audio latent, plus Lightricks' LTXVModalityGuidance (scale 3) for lip-sync; the clip is muted on the timeline since
    its sound is your track. **Handles**: an AI clip is made 4 frames longer at each end, guided by frames that far
    inside its neighbours, and overlaps them, so the film crossfades over near-identical frames. Tested on JP's
    industries (`docs/qa/timeline-ai/`, synthetic Klein inputs): **footwear** fill side → three-quarter, first and last
    frames on their guides (7.3 / 7.5 mean difference vs 22.7 for the wrong picture), turning smoothly; **automotive**
    key moment hits its frame exactly (frame 60 is the closest of 121 to the side-profile picture), but three views of a
    rigid car far apart in angle come out as a cut (5 s) or a dissolve (8 s), and front ¾ → side as a hold-then-switch:
    LTX bridges pose, action, expression and light from one viewpoint, not big camera moves around a rigid object —
    those work from one picture with the move in the prompt (a smooth 30° orbit), continued with Extend; the dialog says
    so. **Sci-fi captain** (gaming / movie): her mouth follows a recorded line (the clip's sound is the line, loudness
    correlation 0.79 after the audio VAE); **apparel** runway extend and **movie** creature retake join up. Joins before
    handles popped (step 4–8 vs 1–2 typical); with handles 1.8–4.0 (fill → sneaker 6.3 → 1.8, retake → creature 7.7 →
    3.8). A full industry film (captain + lip-sync, sneaker fill, runway extend, creature retake; 35 s) rendered and
    exported through Darkroom in 211 s of AI work plus the base takes.
105. **For the test-suite run (Koos approved P1–P3 after Phase 0, `tests/ui-map.md`).** **P1 Seed in Edit:** a Seed
    field under the Edit model, like Generate's — typing a seed locks it; unlocked, every run takes a new random seed
    and shows it so a good result can be repeated (Instruct, Inpaint, Outpaint, Enhance, Layers). **P2 Title and notes
    on Library items:** two columns (`title`, `notes`), edited in Details (saved on leaving the field), shown on the
    tile, searched with the prompt. **P3 Compare two pictures:** tick exactly two in the Library → Compare: side by
    side or on a slider, and **Save as picture** makes one labelled sheet (each side's title, or model and seed) in the
    Library on the working board (mode `compare`). Run settings chosen by Koos: seed 42 only, videos at Final 720p.
106. **A locked Edit seed stays locked after a run** (Apparel pilot finding 1, Koos: "fix the seed lock"). Edit moves to
    the new version after every run, which rebuilt the screen and drew a fresh random seed; the seed now lives in the
    session (`useSessionState('edit.seed')`), so 42 stays 42 and locked until you unlock it. e2e covers a finished run.
107. **Qwen Instruct says when it returned the picture unchanged** (test-suite finding 12, Koos: "look into it", then
    "do both"). Qwen-Image 2.1 at CFG 1 follows an instruction for most seeds but, for some seed and picture
    combinations, returns the input with a fine grain added. Seed 42, used for every run of the 2026-10-03 suite, did
    this for FTW-IMG-02/06 and AUT-IMG-02/03/06; seeds 1–9 all made the four-view board and the clay render
    (`scripts/try-qwen-copy.ts`, `tests/results/qwen-copy/`). Darkroom's graph matches the official template (its
    empty starting latent, 50 steps and an `<image1>` tag change nothing); CFG 4 with a negative fixed the car but not
    the shoe and doubles the time, so CFG stays 1. After a Qwen Instruct without a mask the server compares the result
    with its input (`src/server/copycheck.ts`, small greyscale copies): **grain** = fine detail of the result ÷ that of
    the input, **low** = mean difference of blurred copies. Copy when grain ≥ 1.6 and low ≤ 25: every known copy had
    grain ≥ 1.9, no Qwen result that followed its instruction had more than 1.5 (`scripts/try-copycheck.ts` on all 100
    suite edits). Only Qwen Instruct is checked — some Klein styles (a marker sketch) add real fine detail. The result
    is still saved; Edit says "Qwen returned almost the same picture" with **Try another seed**, which goes back to the
    original with a new seed and the instruction kept. A plain pixel difference cannot tell them apart (a clay render
    of a white shoe differs from it as little as the copy does). Re-run on seed 7, Qwen moved from 1 to 4–5 on those
    tests; AUT-IMG-07's chained steps and MOV-IMG-06 stay weak on both seeds (a real limit, and still flagged when it
    copies). e2e covers the warning with the shoe at seed 42.
108. **The darkroom look** (Koos: "adjust the branding to represent the idea of a photographic film darkroom";
    proposal on branch `darkroom-brand`, `docs/audit-2026-10/`). The room is in the look, not in the words: tabs and
    buttons keep their plain names. Warm blacks and fibre-paper whites; the **amber safelight** (the OC filter used for
    black-and-white paper) stays the accent; a **red safelight** appears only while something is developing — a lamp
    beside the queue count and a red glow from below on the stage; a faint film grain over everything; **versions as a
    strip of negatives** (sprocket holes, black frames, amber edge numbers, a version's title in its tooltip); a finished
    print **develops into view** (from pale and low-contrast to the picture, 1.1 s; off with reduced motion); square
    corners like prints; the logo is an **enlarger lens iris**. Home asks "What are we developing today?".
109. **v3.22 quick wins** (audit 2026-10 §7.1, Koos: "start on v3.22"). **Edit:** Seed, LoRAs and the Klein version
    move under *Advanced* (closed by default, remembered for the session; its summary says "seed 42 locked" or "1 LoRA"
    when set, so nothing hides silently); in Instruct the mask settings appear with the first stroke — before that one
    line says how to change only part of the picture — so "Only change the masked area" is never shown ticked over an
    empty mask. **Model cards say what each is best at** from the test suite: Klein "Styles, materials", Qwen "Exact
    shapes" (Edit) / "Exact shapes, text, layouts" (Generate). **Titles where pictures are picked:** Video takes lead
    with the item's title or the start of the motion prompt; the Timeline bin shows titles; History tooltips show
    title or prompt. **Library:** boards are a column on the left (cover, two-line name, count, board actions under
    them); filters, search, count, Select and Upload share one row; compare sheets and pictures wider or taller than
    1.6:1 are shown whole on their tiles; tile titles take two lines. **Video:** "Add a start frame first (step 1)" under
    the Animate button while it waits. **Home:** the six cards in one row. Accessible names are unchanged (the e2e
    suite and the test runner open Advanced where they type a seed).
110. **Presets for JP's five industries** (Koos: "make sure we have presets for the industries we want to design in").
    **Edit presets** (first in the Presets menu): Apparel 6, Footwear 7, Gaming 5, Movie 4, Automotive 6 — the
    instructions that scored best in the 2026-10-03 suite, generalised with [SLOTS] (garment, material, colours, genre,
    lighting, paint…), each with Klein and Qwen wording and `best` set to the model that won that test (after the
    seed-7 re-runs): Qwen for sketch → render on footwear and cars, turnarounds, multi-view, environments, lighting,
    re-render as a medium and chrome; Klein for the rest. Sheets with many colourways/finishes in one picture are left
    out on purpose — both models miscount grids and garble labels — so Colourway and Paint finish do one per run. The
    helpers the video tests needed (On a model, On foot, Three-quarter view) are presets too. **Generate styles**: Apparel
    flat, Footwear studio, Game concept, Film still, Car studio (one style sentence each, per model).
111. **Walk-through fixes** (Koos: "start with your own generation, then edit, then compose, then video, then
    timeline. Testing each feature along the way" — on a clean Library, 2026-10-04, `tests/run/walk-*.ts`, log
    `tests/results/run-2026-10-04-walk.jsonl`). Titles now name things everywhere a picture is picked or shown: Compose
    layers and the Library picker (title, else prompt), Timeline clips, the Inspector and the bin's add buttons; the
    clips Timeline AI makes are titled after the film ("Darkroom reel · fill / extension / retake"). The version strip
    shows one frame for the pictures of one Layers run (they share a version number; it showed "v6" twice). Outpaint
    says it leaves the picture itself as it is and points to Instruct for a new background (a studio car "extended"
    into a night street kept its white studio in the middle); Enhance › Restore says it treats haze, fog and soft focus
    as damage (a foggy dawn came back clear) and points to Upscale for a clean picture with that mood.
112. **Vehicle and lettering hints; Transparent background lasts one session** (Koos: Klein drew a vehicle's wheels in
    the wrong places; "when choosing car studio preset the results are much better"). With the Car studio style both
    models drew a coherent vehicle — wheels in the arches, one body — so the fix is the style, not a model switch: when
    the Generate prompt describes a vehicle and another style is chosen, a line under Style offers **Use Car studio**.
    Words in quotes on Klein offer **Switch to Qwen** (Qwen spelled "OVERLANDER"; Klein garbled side lettering).
    Detection is a word list (`src/shared/hints.ts`, unit-tested: "scarf" is not a car). **Transparent background** is no
    longer remembered between sessions — it was left ticked by accident twice in one day and turned a studio shot into
    a cut-out with holes; it now lasts the tab's session like the prompt.
113. **Qwen-Image 2.1 viewpoint-orbit LoRA: installed, A/B'd** (Koos: "review and see if we can benefit from it").
    `ML-Intern-lab/Qwen-Image-2.1-viewpoint-orbit-LoRA` (steps2000res768, 168 MB, Qwen research licence — non-commercial;
    fine for JP's private use). Its keys say `diffusion_model.*`; ComfyUI only maps Qwen 2.1's split MLP halves
    (`img_mlp.gate_layer` / `proj`) onto the fused `gate_up` under the `transformer.*` or bare names, so 128 of 448
    weights were silently dropped ("lora key not loaded"). Fix: a renamed copy `qwen-image-2.1-viewpoint-orbit-comfy
    .safetensors` (keys `transformer.*`), the download kept as `.safetensors.orig`; with it no key is dropped. Darkroom's
    LoRA catalogue now counts those halves as fitting the fused layer (it filed the LoRA under "another model"). A/B on
    three Library cut-outs, seed 7, Darkroom's Qwen Instruct graph at 25 steps (`scripts/try-orbit.ts`,
    `tests/results/orbit-ab/`): on the **shoe** and the **jacket** plain Qwen hardly turns them, the LoRA gives real
    three-quarter, side, back and elevated views; on the **car** both turn it about equally. Misses: the shoe's orbit
    views came back on white (transparency lost), and 180° on the jacket showed the front again.
114. **Turn it and Turnaround** (Koos: "yes build Turn it and Turnaround"). A new Edit mode, **Turn it**, between
    Outpaint and Enhance: angle 45° / 90° / 135° / 180° or *Height only*, *To the left / To the right* (hidden at 180°
    and height-only), *Low / Eye level / From above*; the note reads the move back ("Turned 90° right"). It runs
    Qwen-Image 2.1's instruction graph with the viewpoint-orbit LoRA (DECISIONS 113) in the LoRA card's own words
    (`src/shared/orbit.ts`, unit-tested). The LoRA works on cut-outs: a picture without transparency is cut out first
    (Remove BG, a few seconds; chain `turn_pre`, Edit waits for the turn), and a turned view that comes back on white
    is cut out again (follow-up job). **Make a turnaround (4 sides)** sends three turns — 90° right, 180°, 90° left — and
    when the third lands the server lays the picture and its three views in one labelled row on white, a Library item
    "{title} · turnaround" (mode `sheet`) on the picture's board; views and sheet share `ui.turnaround`. Titles follow
    the picture: "Trail shoe · cut-out", "Trail shoe · turned 90° right". Without the LoRA the mode says so and does not
    run. e2e: a shoe with its background → cut-out → turned 90° right (title, prompt, LoRA checked) → turnaround sheet of
    four (2.4 min). Known: a turnaround view can keep a pale background (it is not cut out again before the sheet).
115. **Clean turnaround views; turntable from a turnaround** (Koos: "do both follow-ups"). A turnaround view that comes
    back without transparency is marked `needsCut` and cut out again (chain `turn_cut`); the sheet is made when every
    view has its final picture (the clean cut-out, else the turned view) — no more pale box behind a view. **Animate as
    a turntable** (Library details of a turnaround sheet): the four views, flattened on white (LTX reads no alpha), as
    LTX key moments at ¼, ½ and ¾ of 5 s with the picture as start and end frame (strength 0.7, Final 720p, "one
    continuous shot"), titled "{name} · turntable". On the e2e shoe it makes a full 360° — side, toe, other side, heel,
    back to the side — where a plain "turntable" prompt managed about a quarter turn (walk-through, test suite).
116. **Try both models** (audit #1). Edit › Instruct has **Try both models** next to Enhance instruction: the instruction
    goes to Klein 9B and Qwen-Image 2.1 at once on one seed, each in its own wording (`composeImagePrompt` per model)
    with its own LoRAs and the Klein version; a strip on the stage shows both progressing; when both are in, a
    side-by-side asks **Keep Klein 9B / Keep Qwen-Image 2.1 / Keep both** — keeping one moves the other to Recently
    deleted (Undo) and opens the kept version. Not with the red circle (Qwen only). e2e: one seed, two workflows, keep
    Qwen.
117. **Shape in Instruct** (audit #4; MOV-IMG-01 turned every Movie keyframe and video portrait). Instruct has **Shape**:
    Keep / 16:9 / 3:2 / 1:1 / 4:5 / 9:16. With a shape the server starts the sampler from an empty latent of that shape
    (~1 MP, multiples of 32) instead of the encoded picture, and resizes the result to the picture's own pixel count in
    the new shape (multiples of 16); the picture stays the model's reference, so it is redrawn to fill the frame
    (`src/shared/shape.ts`, both graphs unit-tested). Not with "Only change the masked area" or the red circle. e2e: a
    portrait picture to 16:9 on Klein and on Qwen (1376×768 each).
118. **Sheet maker** (audit #5: both models miscount grids and garble labels — FTW-IMG-04, AUT-IMG-08, APP-IMG-04).
    When the instruction holds a `[SLOT]` (the industry presets Colourway, Paint finish, Fabric swap… or your own text),
    Instruct shows **Sheet**: one value per line (2–9). **Make a sheet of N** sends one Instruct per value on one seed
    (the slot filled in, each model's own wording, the chosen shape, LoRAs and Klein version); each lands as its own
    version titled "{name} · {value}", and when the last is in the server lays them out — 2 or 3 to a row on white —
    with the values typed underneath and "{name} · {slot} sheet" on top: a Library item (mode `sheet`) on the
    picture's board, the pictures and labels in its params. e2e: three recolours, one labelled sheet.
119. **Qwen helper LoRAs: Fast and Keep edits on the frame** (audit #6, #7; Koos: "do the remaining from the audit,
    download what you need"). Downloaded (non-gated): `turbo8_lora_step2500.safetensors` (1.36 GB, chriswritescode,
    Qwen research licence), `qwen-image-2.1-consistency.safetensors` (159 MB, ausboss, step 1500 — the card's
    recommended one), and `Flux2-Klein-9B-Enhanced-Details.safetensors` (331 MB, dx8152 `realistic.safetensors`; a normal
    Klein LoRA in the picker). All load with no dropped keys. A/B on three Library edits, seed 7
    (`scripts/try-qwen-loras.ts`, `tests/results/qwen-loras/`): Consistency took a watercolour restyle's drift from 11 px
    to 0 and changed nothing on edits that were already on the frame; Turbo8 at 8 steps ran ~10 s against ~26 s, as good
    on product edits, a little looser on a painterly restyle (16 steps at 0.65 was no better). So: the server adds the
    **Consistency LoRA** to every whole-picture Qwen Instruct (not with a mask, Turn it or a new Shape — those are meant
    to move the frame), with *Keep edits on the frame* in Edit › Advanced to switch it off; **Fast** adds Turbo8 and runs
    8 steps — a Quality option on Generate (Fast / Draft / Native 2K) and a switch in Edit › Advanced (the Qwen card then
    says ~10 s). `GET /api/jobs/:id/graph` returns the graph a job was sent with. LTX Ingredients is gated: Koos
    downloads it; it is not wired in yet.
120. **Camera wording retuned, Turntable chip, text → video by a first frame** (audit #8, P4). A/B on the scavenger,
    Draft, seed 11 (`scripts/try-camera.ts`, `tests/results/camera-ab/`): the old Static sentence kept the framing on
    that seed but the background drifted into a dust storm; "Static tripod shot: the camera does not move, zoom or push
    in, and the framing stays exactly the same…" kept framing and background. The new Orbit sentence (arcs sideways at
    the same distance and height, same size in frame) turned him further, to a profile. New **Turntable** chip (the
    object turns, the camera stays still), its tooltip pointing to Turn it › Make a turnaround › Animate as a turntable
    for a real 360°. **Text → video**: with no start frame, Video offers *Describe the opening shot* (16:9 / 9:16 / 1:1)
    → **Make the first frame** (Klein, ~10 s, titled "Opening shot · …"), set as the start frame; then motion and
    Animate as usual — LTX's image-to-video quality with a frame you can see first.
121. **Video from a reference: LTX 2.5 Ingredients** (audit #5 of the model list; Koos downloaded the gated
    `ltx-2.5-22b-ic-lora-ingredients-0.9.safetensors`). A new graph `ltx25_ingredients` derived from Refine: the
    reference sheet is a picture repeated as the IC-LoRA guide video (RepeatImageBatch), sampling starts from an empty
    video latent — no first frame, as the LoRA was trained (first_frame_conditioning 0) — at 768×448, 121 frames, 24 fps,
    one stage, the card's negative prompt, silent. **Video from this reference…** in the Library details of any picture
    asks what happens; the server builds the sheet as the card wants it — the views on black, no text: a turnaround's
    four views in a row, or the one picture — and writes "Reference sheet: … / Generated video: …". Test: the e2e shoe's
    turnaround in a forest stream, the camera circling — the exact shoe (sculpted midsole, grey and white panels) in a
    scene it was never in. With the product small in a busy action shot (a runner's legs at dawn) it is not recognisable:
    keep the product the subject.
122. **Edit suite v3.25: the canvas and layers** (Krita AI review, `docs/edit-suite-plan.md`; Koos approved the plan,
    paints with a Wacom). Edit's picture can become a stack of layers — the picture, paint layers, AI results and Library
    pictures — each with visibility, lock, alpha lock, opacity, one of the 16 browser blend modes and a layer mask
    (white = shown; painted with the brush hiding and the eraser showing). Held in the browser as canvases at the
    picture's size (`src/web/lib/doc.ts`); a stack change is one undo step with shared canvases, a stroke keeps only the
    pixels it touched, slider drags merge into one step; one Ctrl+Z order runs across the AI mask and the layers, and with
    layers on it never jumps to another version. **Paint** (P): round dabs with pen pressure on size (and optionally
    opacity), hardness, a stabiliser, coalesced pointer events for smooth Wacom lines, the pen's eraser end erases, X
    toggles erase, Alt-click picks a colour, recent colours. A stroke paints into a scratch canvas shown at the brush
    opacity and is laid down on pen-up, so overlapping dabs never build past it; while painting only the touched area
    is recomposited (a 9 MP photo: ~25 ms a frame headless). Saved with the picture under `data/projects/<item>/`
    (project.json + layer and mask PNGs, uploaded only when changed; an untouched picture or AI-result layer is loaded
    from its Library item, not copied); the Library marks pictures that have layers. **Flatten to new version** merges
    them into the next version (`edit:canvas`, which links back to the layers). With layers on, the AI works on the
    merged layers, and an Instruct / Fill / Enhance / Cut-out result that fits the canvas comes back as a layer on top,
    masked to the selection it used (which then clears) — it is still saved as a version; anything else (a new shape,
    upscale, outpaint) opens as a version as before. Separated layers (Layers mode) can be opened as canvas layers.
    No tiling yet: very large photos use more memory per layer (a 24 MP picture is ~96 MB a layer).
123. **Edit suite v3.26: sketch and paint.** Twelve brushes in three engines (`src/shared/brushes.ts`): paint (Pencil,
    Ink pen, Marker, Airbrush, Chalk, Round), Smudge (each dab lays down the paint picked up so far and picks up a
    little of what is under it, on the layer itself; Undo restores from a copy taken at pen-down) and filter brushes
    (Blur, Dodge, Burn, Sponge, Saturate: a filtered copy of the layer shows through the stroke, laid with source-atop
    so it never paints outside the layer). Each brush keeps its own size, opacity, hardness, spacing and pen settings as
    you leave them; the colour is shared. Paper grain (Pencil, Chalk) is a fixed noise tile the stroke is seen through,
    so it reads as tooth, not per-dab noise. Pen feel (soft / even / firm) bends the pressure curve for every brush.
    A colour picker (saturation/brightness square, hue strip, hex, saved swatches, recent colours) replaces the system
    one. **Fill bucket** (G): scanline flood fill with tolerance, connected-only or everywhere, on the layer or using
    all layers' edges (fill line art drawn on another layer), grown by a pixel to tuck under anti-aliased outlines.
    **Shapes** (U): line, rectangle, ellipse, outline or filled, Shift for square / circle / 45°. **Symmetry** mirrors
    strokes left-right and/or top-bottom about the middle. **View**: turn 15° steps (4 / 6, 5 straightens) and mirror
    (H) the canvas to draw at a comfortable angle — only the view; pointer maths goes through the inverse transform.
    Ctrl-click with a canvas tool picks the layer under the pen. The tool options moved out of the canvas into their
    own row above the versions, so they never cover the picture.
124. **Edit suite v3.27: photo — adjustment layers, selections, transform, clone.** **Adjustment layers** (Adjust tab):
    exposure, brightness, contrast, levels (with histogram and Auto), curves (RGB and per channel, monotone so they never
    overshoot), temperature, tint, hue, saturation, vibrance, lightness, black & white, split tone and grain, plus six
    looks (Punch, Faded film, Golden hour, Blue hour, Silver gelatin, Teal & orange). They change everything below them
    and keep no pixels: the tone settings fold into four 256-entry tables and one WebGL pass applies tables and colour to
    only the region that changed (so painting under one stays quick); grain is keyed to picture pixels so it never
    crawls. A mask limits where it applies; opacity and blend work as on any layer; it merges down onto a picture or paint
    layer. **Selections**: the AI mask is the selection. Marquee (M, rectangle or ellipse), Lasso, Magic wand (W:
    tolerance, connected only, all layers or the selected one) and Smart select; Shift adds, Alt subtracts, Shift+Alt
    keeps the overlap, else the bar's mode (default Add, so the mask brush and lasso behave as before). All / None /
    Invert (Ctrl+A, Ctrl+D, Ctrl+Shift+I), Grow and Shrink by a chamfer distance transform (40 px costs what 1 px does),
    Feather, Border, From layer. Painting, fills and shapes stay inside the selection (the paint bar says so, with
    Deselect). **Transform** (T): the selected layer, or its part inside the selection, is lifted; Free moves, scales
    from the opposite corner or side (Shift keeps the shape) and turns (Shift snaps 15°) with one exact transformed draw;
    Perspective drags four corners (kept convex); Warp drags a 4 × 4 grid, refined bilinearly to 24 × 24. Perspective and
    warp are drawn as textured triangles on the GPU — the 2D canvas clipped each triangle with anti-aliasing and left
    hairline seams. Enter applies (one undo step, a new canvas swapped in), Esc or Ctrl+Z cancels, leaving the tool
    applies. **Clone** brush: Alt-click the source, then paint; the first stroke fixes the offset (aligned), copying
    what you see or only the selected layer. e2e: each run imports a fresh copy of a picture (the suite no longer runs
    out of unlayered ones); a 60 s action timeout so a missing control fails instead of hanging.
